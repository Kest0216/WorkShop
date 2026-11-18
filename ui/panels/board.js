// Board panel: combines the Owner Action Deck (Inbox) and the ShopTalk message stream in one unified command center.
// Quick view modes:
//   all      Action Deck pinned on top (collapsible) + Live ShopTalk message stream + Reply composer
//   actions  Full-sheet Owner Action Deck (questions, plan approve, truck ready, verdicts, budget/paused, RL gaps)
//   feed     Live ShopTalk message stream + Reply composer only
// Deep links: ?panel=board&view=actions (or legacy ?panel=inbox), &to=@m3 (addressed to an agent), &re=<id> (reply to a post).

import { h, mount, clear, keyed } from '../lib/dom.js';
import * as ui from '../lib/widgets.js';
import { renderInboxItem, inboxItemSig } from './inbox.js';

// Kind groups of the filter bar. Every ShopTalk kind is in exactly one group.
const GROUPS = [
  { id: 'talk', label: 'Talk', kinds: ['ASK', 'ANS', 'REQ', 'OK', 'NO', 'CANCEL'], title: 'Questions, orders and their answers' },
  { id: 'work', label: 'Work', kinds: ['DONE', 'PASS', 'FIX', 'FAIL', 'BLOCK'], title: 'Hand-ins, verdicts and blocked work' },
  { id: 'facts', label: 'Facts', kinds: ['INFO', 'DECIDE'], title: 'Facts and decisions' },
  { id: 'hub', label: 'Hub', kinds: ['EVT'], title: 'Notices of the hub' },
];
const GROUP_OF = Object.fromEntries(GROUPS.flatMap((g) => g.kinds.map((k) => [k, g.id])));
const CHANNELS = ['#build', '#plan', '#merge', '#ops'];
const NEW_KINDS = ['INFO', 'ASK', 'REQ', 'DECIDE'];          // what the owner starts a thread with
const REPLY_KINDS = { ASK: ['ANS', 'CANCEL'], BLOCK: ['ANS', 'CANCEL'], REQ: ['CANCEL'], DONE: ['PASS', 'FIX'] }; // by the kind of the post that is answered
const KIND_HELP = {
  INFO: 'A fact others need. Nobody replies to it.', ASK: 'One question to one agent. It holds exactly one "?".', REQ: 'An order to one agent. The agent accepts or refuses it.',
  DECIDE: 'From now on this holds. It goes into every blueprint.', ANS: 'Your answer. It closes the item.', CANCEL: 'Forget the item. It closes.',
  PASS: 'You accept the work.', FIX: 'Not accepted. Number the changes: 1. ... 2. ...',
};
// The hub takes a body of up to 4000 characters, but ShopTalk then caps the whole post line of the owner (kind, @to, scope,
// re:, body) at 2000 (shoptalk.js humanPostChars). A header is at most about 60 characters, so 1900 is what always fits.
const BODY_MAX = 1900;
const PAGE = 300;      // messages rendered at first, and per "Show older"
const DOM_CAP = 900;   // rows kept in the DOM while the list follows the newest post
const LIST_MIN = 96;   // px the list keeps under the pinned questions while the composer shows in full; with less room the composer folds to one line
const LIST_SLIM = 60;  // px: two rows of posts. The list keeps them under a question that is too tall for the sheet (the cards then scroll)
const ROW = 26;        // px: one row of posts. With less room than this under a question the list is not drawn
const fmt = ui.fmt;

// The filter, the view mode, the draft and the reply target stay while the drawer is closed.
const keep = { mode: 'all', filter: 'all', groups: new Set(GROUPS.map((g) => g.id)), draft: '', to: '', scope: '#build', kind: 'INFO', re: null, pinsOpen: true };
let view = null;

function matches(m, ctx) {
  if (!keep.groups.has(GROUP_OF[m.kind] || 'facts')) return false;
  if (view.jobId && m.jobId && m.jobId !== view.jobId) return false;
  const f = keep.filter;
  if (f === 'all') return true;
  if (f === 'owner') return ctx.sel.isFromOwner(m) || ctx.sel.isToOwner(m);
  if (f === 'open') return m.state === 'open';
  if (f.startsWith('agent:')) { const id = f.slice(6); return m.fromId === id || m.toId === id; }
  if (f.startsWith('scope:')) return m.scope === f.slice(6);
  return true;
}

const STATE_CHIP = { open: ['open', 'amber'], expired: ['expired', 'steel'], refused: ['refused', 'red'], cancelled: ['cancelled', 'steel'] };
function stateChip(m) {
  if (m.defaulted) return ui.chip('default taken', 'steel');
  if (m.kind === 'DONE' && m.state === 'fix') return ui.chip('sent back', 'brick');
  if (m.kind === 'DONE' && m.state === 'passed') return ui.chip('passed', 'green');
  const c = m.state ? STATE_CHIP[m.state] : null;
  return c ? ui.chip(c[0], c[1]) : null;
}

function row(m, ctx) {
  const { sel, store } = ctx;
  const body = String(m.body ?? '');
  const slots = m.slots && typeof m.slots === 'object' ? Object.entries(m.slots).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${v}`).join(' ') : '';
  const from = sel.who(store, m.from, m.fromId);
  return h('div', { class: ['msg', sel.isToOwner(m) && 'to-owner', sel.isFromOwner(m) && 'from-owner', sel.isFromHub(m) && 'from-hub'], dataset: { id: m.id } },
    h('span.msg-id', { title: fmt.date(m.ts) }, (m.stale ? '~' : '#') + m.id),
    ui.kindTag(m.kind),
    h('div.msg-text',
      h('span.msg-who', { title: String(m.from ?? '') }, from),
      m.to ? h('span.msg-to', { title: String(m.toAlias || m.to) }, '>' + sel.who(store, m.to, m.toId)) : null,
      m.scope ? h('span.msg-scope', String(m.scope)) : null,
      m.re != null ? h('button.msg-re', { type: 'button', dataset: { jump: m.re }, title: `Go to #${m.re}` }, `re #${m.re}`) : null,
      slots ? h('span.msg-slots', slots) : null,
      stateChip(m), ' ',
      body.length > 1500 ? body.slice(0, 1500) + '…' : body),
    h('span.msg-side', h('span', { title: fmt.date(m.ts) }, fmt.stamp(m.ts)), h('button.msg-reply', { type: 'button', dataset: { reply: m.id }, 'aria-label': `Reply to #${m.id}`, title: 'Reply' }, 'Re')));
}

// The list follows the newest post until the owner reads further up (view.follow, see ui.follower).
// While a pinned question leaves no room for one row, the list is not drawn: it then follows nothing and reads nothing.
function sticks() { return !view.nolist && view.follow.on; }
function toBottom() { view.follow.pin(); }

/** Build the list from scratch: the newest view.limit messages that pass the filter. */
function rebuild(ctx, { stick = true } = {}) {
  const all = ctx.store.board.filter((m) => matches(m, ctx));
  const shown = all.slice(-view.limit);
  const frag = document.createDocumentFragment();
  frag.append(view.top);
  for (const m of shown) frag.append(row(m, ctx));
  if (!shown.length) frag.append(ui.emptyState('Nothing here', ctx.store.board.length ? 'No message passes this filter.' : 'Nobody posted yet.'));
  view.list.replaceChildren(frag);
  view.rows = shown.length;
  view.total = all.length;
  view.pending = 0;
  mark(ctx);
  topButton(ctx);
  count(ctx);
  if (stick) { toBottom(); if (!view.nolist) seen(ctx); }
}

/** Grow the list upward and keep the row the owner was looking at in place. load() may fetch more first. */
async function grow(ctx, load) {
  const first = view.list.querySelector('.msg');
  const before = first ? first.getBoundingClientRect().top : 0;
  if (load) await load();
  if (!view) return;
  view.limit = view.rows + PAGE;
  rebuild(ctx, { stick: false });
  const same = first && view.list.querySelector(`.msg[data-id="${first.dataset.id}"]`);
  if (same) view.list.scrollTop += same.getBoundingClientRect().top - before;
}

/** The button above the first row: more rows from the store, or the earlier history from the hub. */
function topButton(ctx) {
  const b = ctx.store.board;
  const hidden = view.total - view.rows;
  const more = hidden <= 0 && b.length > 0 && b[0].id > 1 && view.fetchedFor !== view.jobId;
  const sig = hidden > 0 ? `older:${Math.min(PAGE, hidden)}` : more ? 'earlier' : '';
  if (view.topSig === sig) return;
  view.topSig = sig;
  if (hidden > 0) mount(view.top, ui.btn(`Show ${Math.min(PAGE, hidden)} older`, { small: true, onClick: () => grow(ctx) }));
  else if (more) {
    // The state carries only the newest posts. The rest of the history comes from GET /api/board.
    mount(view.top, ui.btn('Load earlier posts', { small: true, onClick: (e) => ui.busy(e.currentTarget, () => grow(ctx, async () => {
      const jobId = view.jobId;
      const list = await ctx.api.get(`/api/board?job=${encodeURIComponent(jobId || '')}&since=0&limit=2000`);
      if (!view || !Array.isArray(list)) return;
      view.fetchedFor = jobId;
      ctx.store.addBoard(list);
    })) }));
  } else clear(view.top);
}

/** Remember the newest post the list has looked at. */
function mark(ctx) {
  const b = ctx.store.board, last = b[b.length - 1];
  view.lastId = last ? last.id : 0;
  view.lastTs = last ? last.ts : 0;
}

/** Append the messages that arrived since the last pass. */
function append(ctx) {
  const b = ctx.store.board;
  if (!b.length || b[b.length - 1].id <= view.lastId) return;
  const stick = sticks();
  let i = b.length;
  while (i > 0 && b[i - 1].id > view.lastId) i--;
  let added = 0;
  const frag = document.createDocumentFragment();
  for (; i < b.length; i++) if (matches(b[i], ctx)) { frag.append(row(b[i], ctx)); added++; }
  mark(ctx);
  if (!added) return;
  const empty = view.list.querySelector('.empty');
  if (empty) empty.remove();
  view.list.append(frag);
  view.rows += added;
  view.total = b.reduce((n, m) => n + (matches(m, ctx) ? 1 : 0), 0); // the store drops its oldest posts at its cap
  if (stick) { // following the newest post: keep the DOM small
    for (let extra = view.rows - DOM_CAP; extra > 0; extra--) { const first = view.list.querySelector('.msg'); if (!first) break; first.remove(); view.rows--; }
    toBottom(); seen(ctx);
  } else view.pending += added;
  topButton(ctx);
  count(ctx);
}

/** A stored message changed (an item was answered, passed, sent back): draw its row again in place. */
function redraw(ctx, msgs) {
  if (!view) return;
  for (const m of msgs) {
    const node = view.list.querySelector(`.msg[data-id="${Number(m.id)}"]`);
    if (!node) continue;
    if (matches(m, ctx)) node.replaceWith(row(m, ctx)); else { node.remove(); view.rows--; view.total--; }
  }
  if (sticks()) toBottom(); // a row may have changed its height
  count(ctx);
}

function count(ctx) {
  view.count.textContent = view.total === ctx.store.board.length ? `${view.total} posts` : `${view.total} of ${ctx.store.board.length} posts`;
  view.fresh.hidden = !view.pending;
  view.fresh.lastChild.textContent = `${fmt.plural(view.pending, 'new post')} below`;
}
function seen(ctx) { view.pending = 0; view.fresh.hidden = true; ctx.store.markBoardSeen(); }

function jump(ctx, id) {
  let node = view.list.querySelector(`.msg[data-id="${Number(id)}"]`);
  if (!node && ctx.store.msg(id)) { // hidden by the filter or not rendered yet: show everything
    keep.filter = 'all'; keep.groups = new Set(GROUPS.map((g) => g.id)); view.limit = Math.max(view.limit, ctx.store.board.length);
    syncFilterUi();
    rebuild(ctx, { stick: false });
    node = view.list.querySelector(`.msg[data-id="${Number(id)}"]`);
  }
  if (!node) { ctx.toast(`#${id} is too old. It is not loaded here.`); return; }
  view.follow.move(() => node.scrollIntoView({ block: 'center' })); // the owner chose a post: the list stays there
  node.classList.remove('flash'); void node.offsetWidth; node.classList.add('flash');
}

function syncFilterUi() {
  if (view.filter.value !== keep.filter) view.filter.value = keep.filter;
  for (const b of view.groupBtns) b.setAttribute('aria-pressed', String(keep.groups.has(b.dataset.group)));
}

const openTask = (t) => !['merged', 'cancelled'].includes(t.status);

/** Options of the filter, of "To" and of "Scope" follow the crew and the tasks. */
function options(ctx) {
  const job = ctx.job;
  const agents = job ? ctx.sel.agentsOf(ctx.store, job.id) : [];
  const tasks = job ? ctx.sel.tasksOf(ctx.store, job.id) : [];
  const sig = `${job ? job.id : ''}|${job ? job.leadBossId : ''}|${agents.map((a) => a.id + a.name + a.handle + (a.status === 'off' ? 'x' : '')).join()}|${tasks.map((t) => t.id + (openTask(t) ? '' : 'x')).join()}`;
  if (view.optSig === sig) return;
  view.optSig = sig;
  const opt = (value, label) => h('option', { value }, label);

  const f = view.filter;
  mount(f, opt('all', 'All posts'), opt('owner', 'To or from me'), opt('open', 'Open items'),
    agents.length ? h('optgroup', { label: 'Agent' }, agents.map((a) => opt('agent:' + a.id, `${a.name} ${a.handle || ''}`))) : null,
    h('optgroup', { label: 'Channel' }, CHANNELS.map((c) => opt('scope:' + c, c))),
    tasks.length ? h('optgroup', { label: 'Task' }, tasks.map((t) => opt('scope:' + t.id, `${t.id} ${fmt.clip(t.title, 34)}`))) : null);
  if (![...f.options].some((o) => o.value === keep.filter)) keep.filter = 'all';
  f.value = keep.filter;

  const lead = job ? ctx.sel.leadBoss(ctx.store, job) : null;
  const rest = agents.filter((a) => a !== lead && a.status !== 'off');
  view.toOpts = [
    lead ? opt(lead.handle || '@boss', `${lead.name} ${lead.handle || ''} (lead boss)`) : null,
    rest.map((a) => opt(a.handle, `${a.name} ${a.handle || ''} (${a.role})`)),
  ];
  mount(view.scope, CHANNELS.map((c) => opt(c, c)),
    tasks.some(openTask) ? h('optgroup', { label: 'Task' }, tasks.filter(openTask).map((x) => opt(x.id, `${x.id} ${fmt.clip(x.title, 30)}`))) : null);
  if (![...view.scope.options].some((o) => o.value === keep.scope)) keep.scope = CHANNELS[0];
  view.scope.value = keep.scope;
  syncComposer(ctx);
}

/** Kind, To, Scope and the hints follow what is being written: a new post, or a reply to one. */
function syncComposer(ctx) {
  const job = ctx.job;
  const target = keep.re != null ? ctx.store.msg(keep.re) : null;
  if (keep.re != null && !target) keep.re = null;
  const kinds = target ? [...(target.state === 'open' || target.defaulted ? REPLY_KINDS[target.kind] || [] : []), 'INFO', 'ASK'] : NEW_KINDS;
  if (!kinds.includes(keep.kind)) keep.kind = kinds[0];
  mount(view.kind, kinds.map((k) => h('option', { value: k }, k)));
  view.kind.value = keep.kind;

  const needsTo = keep.kind === 'ASK' || keep.kind === 'REQ';
  const takesTo = needsTo || keep.kind === 'INFO';
  const opt = (value, label) => h('option', { value }, label);
  mount(view.to, needsTo ? null : opt('', takesTo ? 'Nobody in particular' : 'Not used for ' + keep.kind), takesTo ? view.toOpts : null, keep.kind === 'INFO' ? opt('@all', '@all (everyone)') : null);
  if (keep.to && ![...view.to.options].some((o) => o.value === keep.to)) keep.to = '';
  if (!keep.to && needsTo && view.to.options.length) keep.to = view.to.options[0].value;
  view.to.value = keep.to;
  view.to.disabled = !job || !takesTo;
  view.scope.disabled = !job || !!target || !NEW_KINDS.includes(keep.kind);
  for (const c of [view.kind, view.body, view.send]) c.disabled = !job;

  mount(view.re, target ? [h('span', 'Reply to ', h('button.msg-re', { type: 'button', title: `Go to #${target.id}`, onclick: () => jump(ctx, target.id) }, `#${target.id}`), ` ${target.kind} in ${target.scope || ''}`),
    h('button.bd-x', { type: 'button', 'aria-label': 'Stop replying to this post', title: 'Not a reply', onclick: () => { keep.re = null; syncComposer(ctx); } }, 'X')] : null);
  view.note.textContent = !job ? 'No job on the floor. Posts need a job.' : KIND_HELP[keep.kind] || '';
  layoutPins(ctx); // the composer may have changed its height (the reply line)
}

function render(container, ctx) {
  if (ctx.params.view && ['all', 'actions', 'feed'].includes(String(ctx.params.view))) keep.mode = String(ctx.params.view);
  else if (ctx.params.to || ctx.params.re != null) keep.mode = 'all';

  const modeSeg = ui.segmented([
    { value: 'all', label: 'All', title: 'Action Deck pinned above the live ShopTalk feed' },
    { value: 'actions', label: 'Action Needed', title: 'Everything waiting for your approval, answer, or verdict' },
    { value: 'feed', label: 'Live Feed', title: 'Full-height ShopTalk message stream' },
  ], keep.mode, (v) => {
    keep.mode = v;
    ctx.setParams({ view: v === 'all' ? null : v });
  });
  const modeNote = h('span.dim.bd-modenote');
  const modeBar = h('div.bd-modebar', modeSeg, h('span.grow'), modeNote);

  const filterBox = ui.select([], keep.filter, { 'aria-label': 'Filter by agent, channel or task', onchange: () => { keep.filter = filterBox.select.value; view.limit = PAGE; rebuild(ctx); } });
  const groupBtns = GROUPS.map((g) => h('button.bd-kind', { type: 'button', dataset: { group: g.id }, 'aria-pressed': String(keep.groups.has(g.id)), title: `${g.title}: ${g.kinds.join(', ')}. Press to show or hide.`,
    onclick: () => { if (keep.groups.has(g.id)) keep.groups.delete(g.id); else keep.groups.add(g.id); syncFilterUi(); rebuild(ctx); } }, h('span', { class: ['tag', 'k-' + g.kinds[0]] }, g.label)));
  const count_ = h('span.bd-count');
  // Action Deck (Inbox + Questions) stays pinned on top in 'all' mode, or fills the sheet in 'actions' mode.
  const pinCards = h('div.bd-pincards');
  const pinHead = h('button.bd-pinhead', { type: 'button', onclick: () => { if (view.foldOnce) { view.foldOnce = false; keep.pinsOpen = true; } else keep.pinsOpen = !keep.pinsOpen; pinDeck(ctx); } },
    h('span.caret', { 'aria-hidden': 'true' }), h('span.bd-pintext'), h('span.bd-pinhint', 'fold to see more posts'));
  const pins = h('div.bd-pins', { hidden: true }, pinHead, pinCards);
  const actionsFull = h('div.bd-actions-full', { hidden: true });
  const list = h('div.bd-list', { tabIndex: 0, role: 'log', 'aria-label': 'Board messages' });
  // A bar under the list (not over its last post) that says how many posts arrived while the owner read further up.
  const fresh = h('button.bd-new', { type: 'button', hidden: true, title: 'Go to the newest post', onclick: () => { toBottom(); seen(ctx); } }, h('span.caret', { 'aria-hidden': 'true' }), h('span'));

  const kindBox = ui.select([], keep.kind, { onchange: () => { keep.kind = kindBox.select.value; syncComposer(ctx); } });
  const toBox = ui.select([], keep.to, { onchange: () => { keep.to = toBox.select.value; } });
  const scopeBox = ui.select([], keep.scope, { onchange: () => { keep.scope = scopeBox.select.value; } });
  const body = h('textarea', { rows: 2, value: keep.draft, maxLength: BODY_MAX, placeholder: 'Short and plain.', oninput: () => { keep.draft = body.value; fBody.setError(''); } });
  const fBody = ui.field('Message', body);
  const send = ui.btn('Post', { type: 'submit', tone: 'go' });
  const re = h('div.bd-re');
  const note = h('span.dim.grow');

  async function submit() {
    const job = ctx.job;
    const text = body.value.trim();
    if (!job) return;
    const kind = kindBox.select.value;
    if (!text && !['PASS', 'CANCEL'].includes(kind)) { fBody.setError('Write the message first.'); body.focus(); return; }
    if (kind === 'ASK' && (text.match(/\?/g) || []).length !== 1) { fBody.setError('ASK holds exactly one question mark.'); body.focus(); return; }
    const msg = { jobId: job.id, kind, body: text };
    if (toBox.select.value && !toBox.select.disabled) msg.to = toBox.select.value;
    if (keep.re != null) msg.re = keep.re; else if (!scopeBox.select.disabled) msg.scope = scopeBox.select.value;
    if (text.length > BODY_MAX) { fBody.setError(`Keep it under ${BODY_MAX} characters.`); body.focus(); return; }
    await ui.busy(send, async () => {
      // The hub refuses a post that breaks a ShopTalk rule with 400 "E_CODE: hint". Show the hint at the message box.
      const res = await ctx.api.post('/api/board', msg, { quiet: true, throws: true }).catch((e) => {
        const words = String((e && e.message) || 'The hub did not take the post.').replace(/^E_[A-Z_]+:\s*/, '');
        if (e && e.status === 400) fBody.setError(words); else ctx.toast(words, 'error');
        return null;
      });
      if (!res) return;
      body.value = ''; keep.draft = ''; keep.re = null;
      syncComposer(ctx);
      if (res.msg) ctx.store.addBoard([res.msg]);
      toBottom();
    });
    body.focus();
  }
  ui.submitOnEnter(body, submit);

  list.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.jump) jump(ctx, b.dataset.jump);
    else if (b.dataset.reply) reply(ctx, Number(b.dataset.reply));
  });
  // Back at the newest post: the posts that arrived meanwhile are read.
  const follow = ui.follower(list, { slack: 48, onChange: (on) => { if (on && view && view.list === list && view.pending && !view.nolist) seen(ctx); } });

  const bar = h('div.bd-bar', filterBox, h('div.bd-kinds', { role: 'group', 'aria-label': 'Kinds shown' }, groupBtns), count_);
  const compose = h('form.bd-compose', { novalidate: true, onsubmit: (e) => { e.preventDefault(); submit(); } },
    re,
    h('div.bd-compose-top', ui.field('Kind', kindBox), ui.field('To', toBox), ui.field('Scope', scopeBox)),
    fBody,
    h('div.bd-compose-foot', note, send));
  // When a pinned item leaves too little room, the composer folds to this one line (see layoutPins). A press opens it again.
  const write = h('button.bd-write', { type: 'button', title: 'Open the composer', onclick: () => { view.writing = true; layoutPins(ctx); body.focus(); } },
    h('span.caret', { 'aria-hidden': 'true' }), 'Write a post');
  compose.addEventListener('pointerdown', () => { if (view) view.pressedAt = performance.now(); });
  compose.addEventListener('focusout', () => requestAnimationFrame(() => {
    if (!view || view.compose !== compose || compose.contains(document.activeElement) || performance.now() - view.pressedAt < 400) return;
    view.writing = false;
    layoutPins(ctx);
  }));
  const wrap = h('div.bd-wrap', list);
  const root = h('div.bd', modeBar, actionsFull, bar, pins, wrap, fresh, write, compose);
  container.append(root);

  const job = ctx.job;
  view = { jobId: job ? job.id : null, root, modeBar, modeSeg, modeNote, actionsFull, actionsHead: h('div.ib-head'), actionsEmpty: h('div'), actionsList: h('div.ib-list'), actionsHeadSig: null, actionsEmptySig: null,
    bar, compose, list, pins, pinCards, pinHead, count: count_, fresh, filter: filterBox.select, groupBtns, to: toBox.select, kind: kindBox.select, scope: scopeBox.select, body, send, re, note, toOpts: null,
    top: h('div.bd-older'), topSig: null, limit: PAGE, rows: 0, lastId: 0, lastTs: 0, pending: 0, total: 0, optSig: null, fetchedFor: undefined, slim: false, nolist: false, writing: false, pressedAt: 0, wrap, write, follow,
    foldOnce: !!(ctx.params.to || ctx.params.re != null),
    prefs: ctx.prefs, onResize: () => layoutPins(ctx) };
  actionsFull.append(view.actionsHead, view.actionsEmpty, view.actionsList);
  window.addEventListener('resize', view.onResize);

  // deep links: a message to one agent, or a reply to one post
  if (ctx.params.to) { keep.to = String(ctx.params.to); keep.re = null; if (keep.kind !== 'ASK') keep.kind = 'REQ'; }
  options(ctx);
  if (ctx.params.re != null) reply(ctx, Number(ctx.params.re), false);
  pinDeck(ctx);
  rebuild(ctx);
  ctx.on('boardchange', (msgs) => { redraw(ctx, msgs); pinDeck(ctx); });
  requestAnimationFrame(() => { if (view && view.list === list && keep.mode !== 'actions') { toBottom(); if (ctx.params.to || ctx.params.re != null) body.focus({ preventScroll: true }); } });
}

/** Aim the composer at one post: the reply kind, the addressee and the scope follow that post. */
function reply(ctx, id, focus = true) {
  const m = ctx.store.msg(id);
  if (!m || !view) return;
  if (keep.mode === 'actions') keep.mode = 'all';
  keep.re = m.id;
  keep.kind = (m.state === 'open' || m.defaulted ? REPLY_KINDS[m.kind] || [] : [])[0] || 'INFO';
  keep.to = m.fromId && m.from ? m.from : '';
  syncComposer(ctx);
  pinDeck(ctx);
  if (focus) view.body.focus();
}

/** Render the Owner Action Deck (all Inbox items + pinned owner questions) in 'all' or 'actions' mode. */
function pinDeck(ctx) {
  if (!view) return;
  const { store, sel } = ctx;
  const att = sel.ownerAttention(store);
  const items = att.items.slice().sort((a, b) => Number(a.quiet) - Number(b.quiet) || b.since - a.since);
  const loud = att.loud.length, quiet = items.length - loud;
  const away = store.settings && store.settings.presence === 'away';

  // Update the Action Needed button badge count & top summary note
  const actBtn = view.modeSeg.querySelectorAll('button')[1];
  if (actBtn) {
    const label = items.length ? `Action Needed (${loud || items.length})` : 'Action Needed';
    if (actBtn.textContent !== label) actBtn.textContent = label;
  }
  view.modeNote.textContent = loud ? `${fmt.plural(loud, 'action waits', 'actions wait')}` : quiet ? `${quiet} note${quiet === 1 ? '' : 's'}` : 'All clear';

  const isActionsOnly = keep.mode === 'actions';
  const isFeedOnly = keep.mode === 'feed';
  ctx.setLayout(isActionsOnly ? 'flow' : 'fill');
  view.root.classList.toggle('is-actions-only', isActionsOnly);
  view.actionsFull.hidden = !isActionsOnly;
  view.bar.hidden = isActionsOnly;
  view.wrap.hidden = isActionsOnly;
  view.compose.hidden = isActionsOnly;
  view.write.hidden = isActionsOnly;
  if (isActionsOnly) view.fresh.hidden = true;

  if (isActionsOnly) {
    view.pins.hidden = true;
    const headSig = [loud, quiet, away].join('|');
    if (view.actionsHeadSig !== headSig) {
      view.actionsHeadSig = headSig;
      mount(view.actionsHead,
        h('div.ib-sum', h('span.strong', loud ? `${fmt.plural(loud, 'action waits', 'actions wait')} for you` : 'Nothing urgent waits for you'),
          quiet ? h('span.dim', ` · ${quiet} for later`) : null),
        away ? h('p.ib-away', 'You are away: the hub takes the default answer of every boss question at once. Overturn any default here.') : null);
    }
    const emptySig = items.length ? 'some' : 'none';
    if (view.actionsEmptySig !== emptySig) {
      view.actionsEmptySig = emptySig;
      mount(view.actionsEmpty, items.length ? null : ui.emptyState('Action Deck is clear', 'Questions, plan approvals, ready trucks, manual reviews, and RL specialty gaps show up here.',
        ui.btn('Show All (Deck + Feed)', { small: true, onClick: () => { keep.mode = 'all'; ctx.setParams({ view: null }); } })));
    }
    keyed(view.actionsList, items, { key: (it) => it.key, sig: (it) => inboxItemSig(ctx, it), render: (it) => renderInboxItem(ctx, it) });
    return;
  }

  if (isFeedOnly || !items.length) {
    view.pins.hidden = true;
    layoutPins(ctx);
    return;
  }

  const open = keep.pinsOpen && !view.foldOnce;
  view.pins.hidden = false;
  view.pins.classList.toggle('open', open);
  view.pinHead.setAttribute('aria-expanded', String(open));
  view.pinHead.children[1].textContent = loud
    ? `Action Deck · ${fmt.plural(loud, 'action waits', 'actions wait')} for you${quiet ? ` (+${quiet} note${quiet === 1 ? '' : 's'})` : ''}`
    : `Action Deck · ${fmt.plural(quiet, 'item')} for later`;
  view.pinCards.hidden = !open;
  keyed(view.pinCards, items, { key: (it) => it.key, sig: (it) => inboxItemSig(ctx, it), render: (it) => renderInboxItem(ctx, it) });
  layoutPins(ctx);
}

/** True while the owner writes a post: the composer has the focus, or it holds a draft or a reply target. */
function composing() {
  return view.writing || view.compose.contains(document.activeElement) || keep.draft.trim() !== '' || keep.re != null;
}

/**
 * A question card is never cut in the middle of its options: the pinned cards take the height they need. When the cards,
 * a few lines of the list and the composer do not all fit (a short window, a long question), the composer folds to one
 * line ("Write a post") and the list keeps the rest of the sheet (style.css .bd.slim). So the owner still sees the newest
 * posts, and one press opens the composer. The cards scroll inside their box only when they are taller than the sheet
 * can give them (the list then keeps two rows), and while the owner writes a post (the composer then stays whole).
 */
function layoutPins(ctx) {
  if (!view) return;
  if (keep.mode === 'actions') { view.root.classList.remove('slim', 'nolist'); view.wrap.style.minHeight = ''; return; }
  const was = view.slim, hid = view.nolist;
  let slim = false, nolist = false, listMin = '';
  if (!view.pins.hidden && !view.pinCards.hidden && !composing()) {
    view.root.classList.remove('slim', 'nolist'); // measure with the composer in full
    const pins = view.pinHead.offsetHeight + view.pinCards.scrollHeight + 2;
    const sheet = view.root.clientHeight - view.bar.offsetHeight - view.modeBar.offsetHeight;
    slim = pins > sheet - view.compose.offsetHeight - LIST_MIN;
    if (slim) {
      view.root.classList.add('slim');
      const left = sheet - view.write.offsetHeight - pins;
      nolist = left >= 0 && left < ROW;
      listMin = left >= 0 ? '0px' : `${LIST_SLIM}px`;
    }
  }
  view.slim = slim; view.nolist = nolist;
  view.wrap.style.minHeight = listMin;
  view.root.classList.toggle('slim', slim);
  view.root.classList.toggle('nolist', nolist);
  if (hid && !nolist) { if (view.follow.on) { toBottom(); seen(ctx); } else count(ctx); }
  else if (was !== slim && sticks()) { toBottom(); seen(ctx); }
}

export default {
  id: 'board',
  title: 'Board & Action Deck',
  label: 'Board',
  layout: 'fill',
  badge: ({ store, sel }) => {
    const att = sel.ownerAttention(store);
    return att.loud.length || sel.unreadBoard(store) || att.count;
  },
  attention: ({ store, sel }) => sel.ownerAttention(store).any || sel.unreadForOwner(store) > 0,
  render,
  update(ctx) {
    if (!view) return;
    const c = ctx.changes;
    const job = ctx.job;
    const jobId = job ? job.id : null;
    if (c.has('jobs') || c.has('agents') || c.has('tasks') || c.has('state')) options(ctx);
    if (c.has('inbox') || c.has('board') || c.has('jobs') || c.has('deliveries') || c.has('tasks') || c.has('agents') || c.has('providers') || c.has('projects') || c.has('settings') || c.has('requisitions') || c.has('state')) pinDeck(ctx);
    // After a refetch the list is kept when the board still holds the last row it shows; otherwise it is built again.
    const b = ctx.store.board;
    const broken = c.has('state') && (view.lastId ? !b.some((m) => m.id === view.lastId && m.ts === view.lastTs) : b.length > 0);
    if (broken || jobId !== view.jobId) { view.jobId = jobId; rebuild(ctx); return; }
    if (c.has('board') || c.has('state')) append(ctx);
  },
  dispose() { if (view) { window.removeEventListener('resize', view.onResize); view.follow.stop(); view.prefs.flush('boardSeen'); } view = null; }, // the hub gets the unread mark now
};
