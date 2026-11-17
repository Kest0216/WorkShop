// Crew panel (contract section 13b): the crew as a tree. Each boss, under the lead boss its floor managers, under each manager its makers.
// One card per agent: sprite avatar (a neutral tile when the scene module is the stand-in), persona name and handle, role, lab color tag, model,
// status chip, task, open board items, context bar, turns, tokens, cost. "Reply" opens the board composer addressed to that agent.
// Detail view: the agent's open board items, Stop and Retry with note for its task, and a live log (the tail on open, then agentlog events;
// it follows the newest line unless the owner scrolled up; 2000 lines at most). The detail view fills the sheet: the head and the facts keep
// their height and the log takes the rest, so the newest log line is always on screen without scrolling the sheet.
// Deep link: ?panel=crew&agent=<id>. Scene clicks on an agent, an office or a bench open this panel with { agent }.

import { h, mount, clear } from '../lib/dom.js';
import * as ui from '../lib/widgets.js';

const fmt = ui.fmt;
const enc = encodeURIComponent;
const LOG_CAP = 2000;
const STATUS_WORD = { thinking: 'Thinking', working: 'Working', waiting: 'Waiting', reviewing: 'Reviewing', blocked: 'Blocked', idle: 'Idle', off: 'Off' };
const ROLE_WORD = { boss: 'Orchestration Officer', manager: 'Team Lead', maker: 'Specialist' };
const BUSY = new Set(['thinking', 'working', 'reviewing']);

const keep = { offOpen: false };
let view = null;

function part(node, sig, build) {
  if (node.__sig === sig) return;
  node.__sig = sig;
  mount(node, build());
}

// ------------------------------------------------------------------ shared pieces

/** "On hold" beats the agent's own status: the lab is not usable, so nothing runs. */
function statusChip(ctx, a) {
  const hold = ctx.sel.onHold(ctx.store, a);
  if (hold) return ui.chip('On hold', 'brick', { title: `The lab ${hold.provider || a.provider} is not usable right now${hold.until ? `. Release about ${fmt.time(hold.until)}` : ''}.` });
  const tone = { idle: 'plain', working: 'green', thinking: 'blue', waiting: 'amber', reviewing: 'amber', blocked: 'red', off: 'steel' }[a.status] || 'plain';
  return ui.chip(STATUS_WORD[a.status] || String(a.status || '?'), tone);
}

const roleChip = (a) => h('span', { class: ['chip', 't-plain', 'swatch'], style: { '--sw': `var(--role-${/^(boss|manager|maker)$/.test(a.role) ? a.role : 'maker'})` } }, (ROLE_WORD[a.role] || String(a.role)) + (a.lead ? ' · lead' : ''));
const statsText = (s) => `${fmt.plural(Number(s.turns) || 0, 'turn')} · ${fmt.tokens(s.inTok)} in, ${fmt.tokens(s.outTok)} out · ${fmt.money(s.usd)}`; // turns, tokens, cost
const workText = (s) => `${fmt.plural(Number(s.turns) || 0, 'turn')} · ${fmt.money(s.usd)}`;
const tokenText = (s) => ` · ${fmt.tokens(s.inTok)} tokens in, ${fmt.tokens(s.outTok)} out`;

/** The task of an agent and what the agent does with it. */
function taskOf(ctx, a) {
  const t = a.taskId ? ctx.store.get('tasks', a.taskId) : null;
  if (!t) return null;
  return { t, verb: a.role === 'maker' ? (t.status === 'rework' ? 'reworks' : t.status === 'blocked' ? 'is blocked on' : ['working'].includes(t.status) ? 'builds' : 'handed in') : a.status === 'reviewing' ? 'reviews' : 'looks at' };
}

// ------------------------------------------------------------------ list: the crew tree

/** A card is rebuilt only when its frame changes (name, handle, avatar). Everything else moves in place, so its buttons never eat a click. */
function cardSig(ctx, a) {
  return [a.name, a.handle, !!ctx.avatar(a, 2)].join('|');
}

function card(ctx, a) {
  const open = () => ctx.setParams({ agent: a.id });
  const s = a.stats || {};
  const live = { status: h('span.cw-status'), tags: h('div.cw-tags'), task: h('div.cw-task'), bar: ui.ctxBar(s.ctxTok, s.ctxMax), stats: h('span.cw-stats'), prog: null, progLabel: null, pct: -1, node: null };
  view.live.set(a.id, live);
  live.node = h('div.cw-card', { dataset: { agent: a.id } },
    h('button.cw-face', { type: 'button', title: `Open ${a.name}: live log and open items`, 'aria-label': `Open ${a.name}`, onclick: open }, ui.avatarEl(a, ctx.avatar(a, 2), 44, { natural: true })),
    h('div.cw-main',
      h('div.cw-top',
        h('button.cw-name', { type: 'button', onclick: open }, String(a.name || a.id)), h('span.cw-handle', String(a.handle || '')),
        live.status,
        h('span.cw-btns',
          ui.btn('Reply', { small: true, title: `Write to ${a.name} on the board`, onClick: () => ctx.openPanel('board', { to: a.handle || a.id }) }),
          ui.btn('Log', { small: true, title: `Live log of ${a.name}`, onClick: open }))),
      live.tags, live.task,
      h('div.cw-meter', h('span.cw-lbl', { title: 'Share of the model\'s context window in use' }, 'ctx'), live.bar, live.stats)));
  tick(ctx, a);
  return live.node;
}

/** Write what changed into the card: chips and the task line by signature, the numbers every time. */
function tick(ctx, a) {
  const live = view.live.get(a.id);
  if (!live) return;
  const { store, sel } = ctx;
  const s = a.stats || {};
  const x = taskOf(ctx, a);
  const mail = sel.openFor(store, a).length;
  const asksYou = store.board.some((m) => m.fromId === a.id && m.to === sel.OWNER && m.state === 'open'); // it waits for an answer of the owner
  live.node.classList.toggle('is-off', a.status === 'off');
  part(live.status, [a.status, JSON.stringify(sel.onHold(store, a)), mail, asksYou].join('|'), () => [statusChip(ctx, a),
    mail ? ui.chip(`${mail} open`, 'amber', { title: `${fmt.plural(mail, 'open board item')} that this agent must answer` }) : null,
    asksYou ? h('button.cw-asks', { type: 'button', title: `${a.name} asked you a question. Answer it in the Inbox.`, onclick: () => ctx.openPanel('inbox') }, 'asks you') : null]);
  part(live.tags, [a.role, a.lead, a.provider, a.modelLabel || a.model, a.effort, a.harnessId, a.certification].join('|'), () => [roleChip(a), ui.labChip(a.provider, a.modelLabel || a.model || a.provider),
    a.harnessId ? ui.chip(`rack: ${a.harnessId}`, 'green') : null,
    a.certification && a.certification !== 'curated' ? ui.chip(a.certification, 'amber') : null,
    a.effort ? h('span.dim', { title: 'Reasoning effort of the model' }, a.effort) : null]);
  const bars = a.role === 'maker' && !!x && ['working', 'rework'].includes(x.t.status);
  part(live.task, x ? [x.t.id, x.t.title, x.verb, bars].join('|') : 'none:' + a.status, () => {
    live.prog = null; live.pct = -1;
    if (!x) return h('span.dim', a.status === 'off' ? 'off shift' : 'no task');
    if (bars) { live.prog = ui.bar(x.t.progress); live.progLabel = h('span.dim'); }
    return [h('span.dim', x.verb + ' '), h('span.strong', x.t.id), ' ', String(x.t.title || ''), bars ? h('span.cw-prog', live.prog, live.progLabel) : null];
  });
  live.bar.set(s.ctxTok, s.ctxMax);
  const text = statsText(s);
  if (live.stats.textContent !== text) live.stats.textContent = text;
  if (live.prog && x) {
    const pct = Math.round(Math.max(0, Math.min(1, Number(x.t.progress) || 0)) * 100);
    if (pct !== live.pct) { live.pct = pct; live.prog.firstChild.style.width = pct + '%'; live.prog.setAttribute('aria-valuenow', pct); live.prog.title = pct + '%'; live.progLabel.textContent = pct + '%'; }
  }
}

/** boss -> its managers -> their makers. Managers and loose makers hang under the lead boss; the other bosses stand beside it. */
function tree(ctx, job) {
  const { store, sel } = ctx;
  const agents = sel.agentsOf(store, job.id);
  const on = agents.filter((a) => a.status !== 'off');
  const off = agents.filter((a) => a.status === 'off');
  const tasks = sel.tasksOf(store, job.id);
  const lead = sel.leadBoss(store, job);
  const managerOf = (maker) => {
    const cur = maker.taskId ? store.get('tasks', maker.taskId) : null;
    if (cur && cur.managerId) return cur.managerId;
    let last = null; // between two tasks: the manager of the task it worked on last
    for (const t of tasks) if (t.assigneeId === maker.id && t.managerId && (!last || (t.updatedAt || 0) >= (last.updatedAt || 0))) last = t;
    return last ? last.managerId : null;
  };
  const bosses = on.filter((a) => a.role === 'boss').sort((a, b) => Number(b === lead) - Number(a === lead));
  const managers = on.filter((a) => a.role === 'manager');
  const makers = on.filter((a) => a.role === 'maker');
  const byMgr = new Map(managers.map((m) => [m.id, []]));
  const loose = [];
  for (const m of makers) { const id = managerOf(m); if (id && byMgr.has(id)) byMgr.get(id).push(m); else loose.push(m); }
  const root = bosses.find((b) => b === lead) || bosses[0] || null;
  return { agents, off, root, bosses, managers, byMgr, loose };
}

const kidsBox = (...kids) => h('div.cw-kids', kids);
const groupOf = (ctx, a, kids) => h('div.cw-node', { dataset: { node: a.id } }, h('div.cw-slot', { dataset: { slot: a.id } }), kids && kids.length ? kidsBox(kids) : null);

function refreshList(ctx) {
  const { store, sel } = ctx;
  const job = ctx.job;
  const T = tree(ctx, job);
  const busy = T.agents.filter((a) => BUSY.has(a.status)).length;
  const blocked = T.agents.filter((a) => a.status === 'blocked').length;
  const cost = sel.cost(job, fmt.money);
  part(view.sum, [T.agents.length, T.off.length, busy, blocked, cost.text].join('|'), () => h('div.cw-sum',
    h('span.strong', fmt.plural(T.agents.length - T.off.length, 'agent')), ' on the floor',
    h('span.dim', ` · ${busy} busy${blocked ? ` · ${blocked} blocked` : ''}${T.off.length ? ` · ${T.off.length} off shift` : ''}`),
    h('span.cw-cost', { title: cost.title }, cost.text)));

  // The tree is rebuilt only when who reports to whom changes. Cards live in slots and are kept by id.
  const shape = JSON.stringify([T.bosses.map((b) => b.id), T.managers.map((m) => [m.id, T.byMgr.get(m.id).map((x) => x.id)]), T.loose.map((x) => x.id), T.root && T.root.id, T.off.map((x) => x.id), keep.offOpen]);
  if (view.shape !== shape) {
    view.shape = shape;
    const old = new Map([...view.box.querySelectorAll('[data-slot]')].map((n) => [n.dataset.slot, n.firstChild]));
    const frag = [];
    const title = (text) => h('div.cw-title', text);
    // The bosses stand together on top (the lead first). The managers hang under them, and under each manager its makers.
    const under = [...T.managers.map((m) => groupOf(ctx, m, T.byMgr.get(m.id).map((x) => groupOf(ctx, x)))), ...T.loose.map((x) => groupOf(ctx, x))];
    if (T.bosses.length) {
      frag.push(title(T.bosses.length > 1 ? 'Orchestration Officers, Team Leads, Specialists' : 'Orchestration Officer, Team Leads, Specialists'));
      frag.push(h('div.cw-node', T.bosses.map((b) => h('div.cw-slot', { dataset: { slot: b.id } })), under.length ? kidsBox(under) : null));
    } else frag.push(...under);
    if (T.off.length) {
      frag.push(h('button.cw-offhead', { type: 'button', 'aria-expanded': String(keep.offOpen), onclick: () => { keep.offOpen = !keep.offOpen; refreshList(ctx); } }, h('span.caret', { 'aria-hidden': 'true' }), `Off shift (${T.off.length})`));
      if (keep.offOpen) frag.push(h('div.cw-off', T.off.map((a) => groupOf(ctx, a))));
    }
    mount(view.box, frag);
    for (const slot of view.box.querySelectorAll('[data-slot]')) { const node = old.get(slot.dataset.slot); if (node) slot.append(node); } // keep the cards that exist
  }
  // one card per slot, rebuilt only when what it shows changes
  const shown = new Set();
  for (const slot of view.box.querySelectorAll('[data-slot]')) {
    const a = store.get('agents', slot.dataset.slot);
    if (!a) { clear(slot); continue; }
    shown.add(a.id);
    const sig = cardSig(ctx, a);
    const cur = slot.firstChild;
    if (!cur || cur.__sig !== sig) { const node = card(ctx, a); node.__sig = sig; mount(slot, node); } else tick(ctx, a);
  }
  for (const id of [...view.live.keys()]) if (!shown.has(id)) view.live.delete(id);
}

// ------------------------------------------------------------------ detail: one agent and its live log

function logLine(l) {
  const k = l && ['text', 'tool', 'err', 'sys'].includes(l.k) ? l.k : 'text';
  let s = String((l && l.s) ?? '');
  if (s.length > 4000) s = s.slice(0, 4000) + ' …';
  return h('div', { class: ['ll', 'll-' + k] }, h('span.ll-k', { 'aria-hidden': 'true' }, { text: ' ', tool: '>', err: '!', sys: '#' }[k]), h('span.ll-s', s));
}

/** The live log of one agent. Returns { el, push(lines), stop() }. */
function createLog(ctx, agentId) {
  const list = h('div.cw-loglines', { role: 'log', 'aria-label': 'Agent log', tabIndex: 0 });
  const count = h('span.dim');
  const jump = ui.btn('Jump to latest', { small: true, tone: 'primary', cls: 'cw-jump', hidden: true, onClick: () => { follow.pin(); flag(); } });
  const state = h('span.cw-follow');
  const el = h('div.cw-log', h('div.cw-loghead', h('span.caps', 'Live log'), count, h('span.grow'), state, jump), h('div.cw-logwrap', list));
  let lines = 0, fresh = 0, queue = [], frame = 0, ready = false, held = [], dead = false;

  function flag() {
    const on = follow.on;
    if (on) fresh = 0;
    jump.hidden = on;
    jump.textContent = fresh ? `Jump to latest (${fresh} new)` : 'Jump to latest';
    state.textContent = on ? 'following' : 'paused: you scrolled up';
    state.classList.toggle('is-paused', !on);
    count.textContent = lines >= LOG_CAP ? `last ${LOG_CAP} lines` : fmt.plural(lines, 'line');
  }
  // The log takes the room the rest of the sheet leaves, so its height changes (a section appears, the window changes).
  // It stays on the newest line through such a change, and pauses only when the owner scrolls up.
  const follow = ui.follower(list, { onChange: flag });

  function flush() {
    frame = 0;
    if (dead || !queue.length) return;
    const batch = queue; queue = [];
    const frag = document.createDocumentFragment();
    for (const l of batch.slice(-LOG_CAP)) frag.append(logLine(l));
    const stick = follow.on;
    const empty = list.querySelector('.cw-logempty');
    if (empty) empty.remove();
    list.append(frag);
    lines += Math.min(batch.length, LOG_CAP);
    if (!stick) fresh += batch.length;
    let extra = lines - LOG_CAP;
    if (extra > 0) { // drop the oldest lines; keep what the owner reads in place
      const before = list.scrollHeight;
      for (; extra > 0 && list.firstChild; extra--) { list.firstChild.remove(); lines--; }
      if (!stick) list.scrollTop = Math.max(0, list.scrollTop - (before - list.scrollHeight));
    }
    if (stick) follow.pin();
    flag();
  }
  function push(batch) {
    if (dead || !Array.isArray(batch) || !batch.length) return;
    if (!ready) { held.push(...batch); return; } // the tail is not here yet
    queue.push(...batch);
    if (!frame) frame = requestAnimationFrame(flush);
  }

  list.append(h('div.cw-logempty', 'Loading the log...'));
  flag();
  ctx.api.get(`/api/agents/${enc(agentId)}/log?tail=200`, { quiet: true }).then((tail) => {
    if (dead) return;
    const base = Array.isArray(tail) ? tail : [];
    // Lines that arrived as events while the tail was on its way may be in the tail too: drop that overlap.
    let k = Math.min(held.length, base.length);
    for (; k > 0; k--) { let same = true; for (let i = 0; i < k && same; i++) { const a = base[base.length - k + i], b = held[i]; same = !!a && !!b && a.k === b.k && a.s === b.s; } if (same) break; }
    ready = true;
    const rest = held.slice(k); held = [];
    const empty = list.querySelector('.cw-logempty');
    if (empty) empty.textContent = tail === undefined ? 'The log did not load. New lines still show up here.' : 'No log lines yet. They show up here as the agent works.';
    push([...base, ...rest]);
  });
  return { el, push, stop() { dead = true; follow.stop(); if (frame) cancelAnimationFrame(frame); } };
}

function itemRow(ctx, m) {
  const { store, sel } = ctx;
  return h('li.li.cw-item',
    ui.kindTag(m.kind),
    h('div', h('span.dim', `#${m.id} ${sel.who(store, m.from, m.fromId)}${m.to ? '>' + sel.who(store, m.to, m.toId) : ''} ${m.scope || ''} · ${fmt.ago(m.ts)} `), String(m.body ?? '')),
    h('button.linkish', { type: 'button', title: `Answer #${m.id} on the board`, onclick: () => ctx.openPanel('board', { re: m.id }) }, 'Open'));
}

async function stopTask(ctx, a, t, button) {
  const note = await ctx.prompt({ title: `Stop ${t.id}?`, label: `The turn of ${a.name} ends now. ${t.id} becomes blocked until you or a manager restart it. Note for the crew (optional):`, required: false, okLabel: 'Stop the task', cancelLabel: 'Let it run' });
  if (note === null) return;
  await ui.busy(button, async () => {
    const res = await ctx.api.post(`/api/tasks/${enc(t.id)}/stop`, note ? { note } : {});
    if (res) ctx.toast(`${t.id} is stopped. Restart it with "Retry with note".`);
  });
}

function retryTask(ctx, a, t, button) {
  const note = h('textarea', { rows: 3, placeholder: 'Example: Keep the old API shape. Only add the new field.' });
  const fNote = ui.field('Note for the maker (optional)', note, { hint: 'The maker gets a fresh session with this note, the last error and its own notes file.' });
  const model = ui.segmented([
    { value: 'same', label: 'Same model', title: 'Try again with the model it had' },
    { value: 'up', label: 'Stronger model', title: 'One step up in power' },
    { value: 'other_lab', label: 'Other lab', title: 'A maker of the other lab takes the bench' },
  ], 'same');
  ctx.modal({
    title: `Retry ${t.id}`,
    body: h('div', h('p', `${t.id} is ${t.status}${t.why ? ` (why: ${t.why})` : ''}. ${t.lastError ? 'Last error: ' + fmt.clip(t.lastError, 200) : ''}`), fNote, ui.group('Model', model)),
    buttons: [{ label: 'Cancel', value: false }, { label: 'Retry the task', primary: true, run: async () => {
      const body = { model: model.value || 'same' };
      if (note.value.trim()) body.note = note.value.trim();
      const res = await ctx.api.post(`/api/tasks/${enc(t.id)}/retry`, body);
      if (!res) return false;
      ctx.toast(`${t.id} starts again${a ? ` with ${a.name}` : ''}.`);
      return true;
    } }],
  });
  void button;
}

function renderDetail(container, ctx, a) {
  const back = ui.btn('< Crew', { small: true, title: 'Back to the whole crew', onClick: () => ctx.setParams({ agent: null }) });
  const d = view.detail = { id: a.id, head: h('div'), facts: h('div'), acts: h('div'), items: h('div.cw-items'), log: createLog(ctx, a.id), bar: null, stats: null };
  ctx.setLayout('fill'); // the detail view lays itself out: the log takes what the head and the facts leave
  container.append(h('div.cw-detail', h('div.cw-back', back), d.head, d.facts, d.acts, d.items, d.log.el));
  ctx.on('agentlog', (evt) => { if (evt && evt.agentId === a.id) d.log.push(evt.lines); });
  ctx.setTitle(`Crew · ${a.name}`);
  refreshDetail(ctx);
}

function refreshDetail(ctx) {
  const { store, sel } = ctx;
  const d = view.detail;
  const a = store.get('agents', d.id);
  if (!a) { part(d.head, 'gone', () => h('div.callout', h('div.callout-title', 'This agent left the crew'), h('p', { style: { margin: 0 } }, 'The job it belonged to was removed.'))); for (const k of ['facts', 'acts', 'items']) part(d[k], 'gone', () => null); return; }
  const s = a.stats || {};
  const x = taskOf(ctx, a);
  const hold = sel.onHold(store, a);

  part(d.head, [a.name, a.handle, a.role, a.lead, a.provider, a.modelLabel || a.model, a.effort, a.harnessId, a.certification, a.status, !!hold, !!ctx.avatar(a, 3)].join('|'), () => h('div.cw-hero',
    ui.avatarEl(a, ctx.avatar(a, 3), 72, { natural: true }),
    h('div.cw-main',
      h('div.cw-top', h('span.cw-bigname', String(a.name || a.id)), h('span.cw-handle', String(a.handle || '')), statusChip(ctx, a)),
      h('div.cw-tags', roleChip(a), ui.labChip(a.provider, a.provider), h('span', String(a.modelLabel || a.model || '')),
        a.harnessId ? ui.chip(`rack: ${a.harnessId}`, 'green') : null,
        a.certification ? ui.chip(a.certification, a.certification === 'curated' ? 'blue' : 'amber') : null,
        a.effort ? h('span.dim', `effort ${a.effort}`) : null),
      hold ? h('p.cw-hold', `On hold: the runtime ${hold.provider || a.provider} is not usable right now${hold.until ? `. The hub tries again about ${fmt.time(hold.until)}` : ''}.`) : null)));

  // facts: the frame is rebuilt rarely; the numbers move in place. (In a short window the labels and the last two rows fold away: style.css)
  part(d.facts, [x ? [x.t.id, x.t.title, x.t.status, x.t.why, x.verb].join('~') : 'none', a.sessionId, x && x.t.sessionId, a.role].join('|'), () => {
    d.bar = ui.ctxBar(s.ctxTok, s.ctxMax); d.ctxText = h('span'); d.stats = h('span'); d.tokens = h('span.cw-tok'); d.active = h('span');
    d.prog = x && a.role === 'maker' ? ui.bar(x.t.progress) : null; d.progLabel = h('span.dim');
    return h('dl.kv.cw-facts',
      h('dt.f-task', 'Task'), h('dd.f-task', x ? [h('span.dim', x.verb + ' '), h('button.linkish', { type: 'button', title: 'Show this task in the Blueprint', onclick: () => ctx.openPanel('blueprint') }, x.t.id), ' ', String(x.t.title || ''), ' ', ui.statusChip('task', x.t.status),
        x.t.status === 'blocked' && x.t.why ? [' ', ui.chip(`why: ${x.t.why}`, 'red')] : null, d.prog ? h('span.cw-prog', d.prog, d.progLabel) : null] : h('span.dim', 'no task')),
      h('dt.f-ctx', 'Context'), h('dd.f-ctx', d.bar, ' ', d.ctxText),
      h('dt.f-work', 'Work'), h('dd.f-work', d.stats, d.tokens),
      h('dt.f-active', 'Last active'), h('dd.f-active', d.active),
      h('dt.f-session', 'Session'), h('dd.f-session', h('span.dim', String((a.role === 'maker' ? x && x.t.sessionId : a.sessionId) || 'none yet'))));
  });
  d.bar.set(s.ctxTok, s.ctxMax);
  const share = Number(s.ctxMax) > 0 ? (Number(s.ctxTok) || 0) / Number(s.ctxMax) : 0;
  const ctxText = Number(s.ctxMax) > 0 ? `${fmt.tokens(s.ctxTok)} of ${fmt.tokens(s.ctxMax)} (${fmt.pct(share)})${share >= 0.8 ? ', nearly full' : ''}` : 'not known yet';
  if (d.ctxText.textContent !== ctxText) d.ctxText.textContent = ctxText;
  const st = workText(s);
  if (d.stats.textContent !== st) d.stats.textContent = st;
  const tk = tokenText(s);
  if (d.tokens.textContent !== tk) d.tokens.textContent = tk;
  const act = a.lastActiveAt ? fmt.ago(a.lastActiveAt) : 'never';
  if (d.active.textContent !== act) d.active.textContent = act;
  if (d.prog && x) { const pct = Math.round(Math.max(0, Math.min(1, Number(x.t.progress) || 0)) * 100); d.prog.firstChild.style.width = pct + '%'; d.prog.setAttribute('aria-valuenow', pct); if (d.progLabel.textContent !== pct + '%') d.progLabel.textContent = pct + '%'; }

  // actions
  const mine = x && a.role === 'maker' && x.t.assigneeId === a.id ? x.t : null;
  part(d.acts, [a.id, a.handle, mine ? [mine.id, mine.status, mine.retries].join('~') : 'none'].join('|'), () => h('div.cw-acts',
    ui.btn('Message on the board', { tone: 'primary', small: true, title: `Open the board composer addressed to ${a.name}`, onClick: () => ctx.openPanel('board', { to: a.handle || a.id }) }),
    // The hub stops a task that is planned, ready, working or in rework (not one in review: that needs a verdict or a cancel).
    mine && ['planned', 'ready', 'working', 'rework'].includes(mine.status) ? ui.btn(`Stop ${mine.id}`, { tone: 'danger', small: true, title: 'Stop the task. A running turn ends. The task becomes blocked.', onClick: (e) => stopTask(ctx, a, mine, e.currentTarget) }) : null,
    mine && ['blocked', 'failed'].includes(mine.status) ? ui.btn('Retry with note', { tone: 'go', small: true, title: `Restart ${mine.id} with a fresh session`, onClick: (e) => retryTask(ctx, a, mine, e.currentTarget) }) : null));

  // open board items (a few at first: a busy agent can have many, and the log must stay in reach)
  const owes = sel.openFor(store, a), waits = sel.openBy(store, a);
  const group = (title, list) => (list.length ? [h('div.caps.cw-itemhead', `${title} (${list.length})`), h('ul.list', (d.allItems ? list : list.slice(0, 3)).map((m) => itemRow(ctx, m)))] : null);
  part(d.items, [owes.map((m) => m.id).join(), waits.map((m) => m.id).join(), d.allItems].join('|'), () => (owes.length || waits.length ? ui.section('Open board items',
    group(`${a.name} owes an answer`, owes), group(`${a.name} waits for`, waits),
    owes.length > 3 || waits.length > 3 ? h('button.linkish', { type: 'button', onclick: () => { d.allItems = !d.allItems; refreshDetail(ctx); } }, d.allItems ? 'Show fewer' : `Show all ${owes.length + waits.length}`) : null) : null));
}

// ------------------------------------------------------------------ employee book (roster) & Phase 1 RFT queue

function editRosterModal(ctx, entry) {
  const harnesses = Array.isArray(ctx.store.harnesses) ? ctx.store.harnesses : [];
  const existing = entry || { id: '', name: '', role: 'maker', title: 'Specialist', baseModel: 'qwen3-coder-32b', checkpoint: '', harnessId: (harnesses[0] && harnesses[0].id) || 'fullstack-node', specialties: ['backend'], certification: 'base_untrained', enabled: true };
  const fId = h('input', { type: 'text', value: String(existing.id || ''), placeholder: 'spec-euler', readOnly: !!entry });
  const fName = h('input', { type: 'text', value: String(existing.name || ''), placeholder: 'Euler' });
  const fTitle = h('input', { type: 'text', value: String(existing.title || ''), placeholder: 'Algorithm & Graph Specialist' });
  const fRole = ui.select([{ value: 'maker', label: 'Specialist (maker)' }, { value: 'manager', label: 'Team Lead (manager)' }], existing.role || 'maker');
  const fModel = h('input', { type: 'text', value: String(existing.baseModel || 'qwen3-coder-32b') });
  const fCkpt = h('input', { type: 'text', value: String(existing.checkpoint || ''), placeholder: 'oss://qwen3-coder-32b-algo-rft-v1 (optional)' });
  const fHarness = harnesses.length
    ? ui.select(harnesses.map((x) => ({ value: x.id, label: `${x.label} (${x.id})` })), existing.harnessId || harnesses[0].id)
    : h('input', { type: 'text', value: String(existing.harnessId || 'fullstack-node') });
  const fSpec = h('input', { type: 'text', value: (existing.specialties || []).join(', '), placeholder: 'algo, data' });
  const fCert = ui.select([
    { value: 'curated', label: 'Curated (certified)' },
    { value: 'base_untrained', label: 'Base untrained' },
    { value: 'training_queued', label: 'Training queued' },
  ], existing.certification || 'base_untrained');
  const enabledBox = ui.checkbox('Enabled in Employee Book', existing.enabled !== false);
  const buttons = [];
  if (entry) buttons.push({ label: 'Retire', tone: 'danger', run: async () => {
    if (!(await ctx.confirm({ title: `Retire ${entry.name}?`, text: 'Remove this character from the Employee Book.', okLabel: 'Retire', danger: true }))) return false;
    const res = await ctx.api.del(`/api/roster/${enc(entry.id)}`);
    if (!res) return false;
    const fresh = await ctx.api.get('/api/roster', { quiet: true });
    if (fresh) ctx.store.set('roster', fresh);
    ctx.toast(`${entry.name} retired.`);
    return true;
  } });
  buttons.push({ label: 'Cancel', value: false }, { label: entry ? 'Save character' : 'Add to Employee Book', primary: true, run: async () => {
    const payload = {
      ...existing,
      id: fId.value.trim(),
      name: fName.value.trim(),
      title: fTitle.value.trim(),
      role: fRole.select.value,
      baseModel: fModel.value.trim(),
      checkpoint: fCkpt.value.trim() || null,
      harnessId: fHarness.select ? fHarness.select.value : fHarness.value.trim(),
      specialties: String(fSpec.value || '').split(',').map((x) => x.trim()).filter(Boolean),
      certification: fCert.select.value,
      enabled: !!enabledBox.input.checked,
    };
    const res = await ctx.api.post('/api/roster', payload);
    if (!res) return false;
    const fresh = await ctx.api.get('/api/roster', { quiet: true });
    if (fresh) ctx.store.set('roster', fresh);
    ctx.toast(`${payload.name} saved in Employee Book.`);
    return true;
  } });
  ctx.modal({ title: entry ? `Edit ${entry.name}` : 'New Specialist Character', wide: true, buttons,
    body: h('div.tw-form', ui.field('Id', fId), ui.field('Name', fName), ui.field('Title', fTitle), ui.field('Role', fRole),
      ui.field('Base OSS model', fModel), ui.field('Fine-tuned checkpoint (Phase 1+)', fCkpt), ui.field('Default harness', fHarness),
      ui.field('Specialties (domains)', fSpec), ui.field('Certification', fCert), enabledBox) });
}

function drawRoster(ctx) {
  if (!view || !view.rosterBox) return;
  const entries = Array.isArray(ctx.store.roster) ? ctx.store.roster : [];
  const sig = JSON.stringify(entries);
  if (view.rosterSig === sig) return;
  view.rosterSig = sig;
  mount(view.rosterBox,
    h('div.tw-head',
      h('div.tw-title', h('h3.wo-title', 'Employee Book'), ui.btn('+ New Specialist', { small: true, tone: 'go', onClick: () => editRosterModal(ctx, null) })),
      h('p.dim', `Catalog of ${fmt.plural(entries.length, 'named specialist & team lead')}. Gemini orchestrators match tasks to certified entries here, or queue uncurated domains for Phase 1 RFT.`)),
    entries.length ? h('div.ro-list', entries.map((e) => {
      const spriteAgent = { name: e.name, role: e.role, provider: 'oss', style: e.style || { seed: 2100 } };
      const cls = e.certification === 'curated' ? 'is-curated' : e.certification === 'training_queued' ? 'is-rft' : 'is-base';
      const tone = e.certification === 'curated' ? 'green' : e.certification === 'training_queued' ? 'blue' : 'amber';
      const rec = e.record || { tasksCompleted: 0, reworks: 0 };
      const total = (rec.tasksCompleted || 0) + (rec.reworks || 0);
      const firstPass = total > 0 ? Math.round(((rec.tasksCompleted || 0) / total) * 100) + '%' : '–';
      return h('article', { class: ['ro-card', cls], dataset: { roster: e.id } },
        ui.avatarEl(spriteAgent, ctx.avatar(spriteAgent, 2), 44, { natural: true }),
        h('div.ro-main',
          h('div.ro-head',
            h('span.strong', String(e.name)),
            h('span.dim', String(e.title || '')),
            ui.chip(e.role === 'manager' ? 'Team Lead' : 'Specialist', 'plain'),
            ui.chip(e.certification, tone),
            !e.enabled ? ui.chip('disabled', 'steel') : null),
          h('div.hr-meta',
            ui.labChip('oss', e.baseModel),
            ui.chip(`rack: ${e.harnessId}`, 'green'),
            ...(e.specialties || []).map((d) => ui.domainChip(d))),
          h('div.ro-stats', `ID: ${e.id} · Completed: ${rec.tasksCompleted || 0} · Reworks: ${rec.reworks || 0} · First-pass: ${firstPass}${e.checkpoint ? ` · Checkpoint: ${e.checkpoint}` : ''}`),
          h('div.ro-acts', ui.btn('Edit', { small: true, onClick: () => editRosterModal(ctx, e) }))));
    })) : ui.emptyState('Employee Book is empty', 'Add specialist characters to assign open-weight models and harnesses.', ui.btn('+ New Specialist', { tone: 'go', onClick: () => editRosterModal(ctx, null) })));
}

function enrollModal(ctx, r) {
  const fName = h('input', { type: 'text', value: String(r.suggestedName || '') });
  const fTitle = h('input', { type: 'text', value: `${String(r.domain || '').toUpperCase()} Specialist (RFT)` });
  const fModel = h('input', { type: 'text', value: String(r.candidateBaseModel || 'qwen3-coder-32b') });
  const fHarness = h('input', { type: 'text', value: String(r.harnessId || 'fullstack-node') });
  const fCkpt = h('input', { type: 'text', value: `oss://${r.candidateBaseModel || 'oss'}-${r.domain}-rft-v1` });
  ctx.modal({ title: `Enroll Specialist from ${r.id}`, wide: true,
    body: h('div.tw-form', h('p.dim', `Simulates completed Phase 1 RFT certification for domain "${r.domain}" and adds this character to config/roster.json.`),
      ui.field('Character name', fName), ui.field('Title', fTitle), ui.field('Base OSS model', fModel), ui.field('Harness ID', fHarness), ui.field('RFT checkpoint', fCkpt)),
    buttons: [{ label: 'Cancel', value: false }, { label: 'Enroll in Employee Book', primary: true, run: async () => {
      const res = await ctx.api.post(`/api/requisitions/${enc(r.id)}/enroll`, {
        name: fName.value.trim(), title: fTitle.value.trim(), baseModel: fModel.value.trim(), harnessId: fHarness.value.trim(), checkpoint: fCkpt.value.trim(),
      });
      if (!res) return false;
      const [reqList, rosList] = await Promise.all([ctx.api.get('/api/requisitions', { quiet: true }), ctx.api.get('/api/roster', { quiet: true })]);
      if (reqList) ctx.store.set('requisitions', reqList);
      if (rosList) ctx.store.set('roster', rosList);
      ctx.toast(`${fName.value.trim() || r.suggestedName} enrolled as curated specialist!`);
      return true;
    } }] });
}

function drawRft(ctx) {
  if (!view || !view.rftBox) return;
  const list = Array.isArray(ctx.store.requisitions) ? ctx.store.requisitions : [];
  const sig = JSON.stringify(list);
  if (view.rftSig === sig) return;
  view.rftSig = sig;
  const queued = list.filter((r) => r.status === 'queued_phase1').length;
  mount(view.rftBox,
    h('div.tw-head',
      h('div.tw-title', h('h3.wo-title', 'Phase 1 RFT Training Queue'), ui.chip(`${queued} queued`, queued ? 'amber' : 'green')),
      h('p.dim', 'When an orchestration task needs a domain lacking a curated specialist in the Employee Book, Phase 0 runs a local OSS fallback and logs a Phase 1 RL/RFT training spec here.')),
    list.length ? h('div.ro-list', list.map((r) => {
      const spec = r.rftSpec || {};
      const rewards = Array.isArray(spec.rewardSignals) ? spec.rewardSignals : [];
      return h('article', { class: ['rft-card', r.status === 'enrolled' && 'is-done'], dataset: { requisition: r.id } },
        h('div.ro-head',
          ui.chip(r.id, 'dark'),
          ui.chip(r.status, r.status === 'queued_phase1' ? 'amber' : r.status === 'enrolled' ? 'green' : 'steel'),
          ui.domainChip(r.domain),
          h('span.strong', String(r.suggestedName || r.domain)),
          r.jobId ? ui.chip(String(r.jobId), 'plain') : null),
        h('p', String(r.notes || `Reason: ${r.reason}`)),
        h('div.hr-meta',
          ui.labChip('oss', r.candidateBaseModel || 'oss'),
          ui.chip(`rack: ${r.harnessId}`, 'green'),
          r.enrolledRosterId ? ui.chip(`enrolled: ${r.enrolledRosterId}`, 'blue') : null),
        spec.evalSuite || rewards.length ? ui.fold('Phase 1 RL/RFT spec', () => [
          spec.evalSuite ? h('p', 'Eval suite: ', h('span.code', String(spec.evalSuite))) : null,
          rewards.length ? h('div.hr-meta', ...rewards.map((s) => ui.chip(String(s), 'amber'))) : null,
        ]) : null,
        r.status === 'queued_phase1' ? h('div.ro-acts',
          ui.btn('Enroll Specialist', { small: true, tone: 'primary', onClick: () => enrollModal(ctx, r) }),
          ui.btn('Dismiss', { small: true, onClick: async () => {
            const res = await ctx.api.post(`/api/requisitions/${enc(r.id)}/dismiss`);
            if (res) {
              const reqList = await ctx.api.get('/api/requisitions', { quiet: true });
              if (reqList) ctx.store.set('requisitions', reqList);
              ctx.toast(`${r.id} dismissed.`);
            }
          } })) : null);
    })) : ui.emptyState('RFT Queue is clean', 'Every specialist domain requested so far has a curated entry or no gaps have been queued yet.'));
}

// ------------------------------------------------------------------ panel

function render(container, ctx) {
  const job = ctx.job;
  const roster = Array.isArray(ctx.store.roster) ? ctx.store.roster : [];
  const queued = (ctx.store.requisitions || []).filter((r) => r.status === 'queued_phase1').length;
  const wanted = job && ctx.params.agent ? ctx.sel.agentByRef(ctx.store, ctx.params.agent, job.id) || ctx.store.get('agents', ctx.params.agent) : null;
  if (wanted) {
    view = { container, live: new Map(), shape: null, sum: h('div'), box: h('div.cw-tree'), detail: null, mode: 'detail', tab: 'team', jobId: job ? job.id : null };
    renderDetail(container, ctx, wanted);
    return;
  }
  const tab = ['team', 'roster', 'rft'].includes(ctx.params.tab) ? ctx.params.tab : 'team';
  const tabs = h('div.panel-tabs', ui.segmented([
    { value: 'team', label: 'Active Team', title: 'Live orchestration officers, team leads, and bench specialists' },
    { value: 'roster', label: `Employee Book (${roster.length})`, title: 'Persistent catalog of named specialist characters' },
    { value: 'rft', label: `RFT Queue (${queued})`, title: 'Phase 1 reinforcement fine-tuning requisitions' },
  ], tab, (v) => ctx.setParams({ tab: v, agent: null })));

  view = { container, live: new Map(), shape: null, sum: h('div'), box: h('div.cw-tree'), rosterBox: h('div'), rftBox: h('div'), rosterSig: null, rftSig: null, detail: null, mode: tab, tab, jobId: job ? job.id : null };
  container.append(tabs);

  if (tab === 'roster') {
    container.append(view.rosterBox);
    drawRoster(ctx);
    return;
  }
  if (tab === 'rft') {
    container.append(view.rftBox);
    drawRft(ctx);
    return;
  }

  if (!job) {
    container.append(ui.emptyState('No active team yet', 'Start a work order to staff orchestration officers and OSS specialists, or browse the Employee Book.',
      ui.btn('+ Work order', { tone: 'go', onClick: () => ctx.openPanel('workorder') }),
      ui.btn('Open Employee Book', { onClick: () => ctx.setParams({ tab: 'roster', agent: null }) })));
    view.mode = 'empty';
    return;
  }
  view.mode = 'list';
  if (ctx.params.agent) container.append(h('div.callout', h('div.callout-title', 'Agent not found'), h('p', { style: { margin: 0 } }, `"${String(ctx.params.agent)}" is not in the team of ${job.id}.`)));
  if (!ctx.sel.agentsOf(ctx.store, job.id).length) {
    const over = ['done', 'cancelled'].includes(job.status);
    container.append(over ? ui.emptyState('The team went home', `${job.id} is ${job.status}. Its agents left the floor.`)
      : ui.emptyState('Nobody is here yet', job.status === 'queued' ? 'The team is staffed when this job starts.' : 'The orchestration officers arrive in a moment.'));
    view.mode = 'empty';
    return;
  }
  container.append(view.sum, view.box);
  refreshList(ctx);
}

export default {
  id: 'crew',
  title: 'Roster & Teams',
  label: 'Roster',
  short: 'Team',
  badge: ({ store, sel, job }) => {
    const live = job ? sel.agentsOf(store, job.id).filter((a) => a.status === 'blocked' || sel.onHold(store, a)).length : 0;
    const queued = (store.requisitions || []).filter((r) => r.status === 'queued_phase1').length;
    return live + queued;
  },
  render,
  update(ctx) {
    if (!view) return;
    const c = ctx.changes;
    if (view.tab === 'roster') { if (c.has('roster') || c.has('harnesses') || c.has('state')) drawRoster(ctx); return; }
    if (view.tab === 'rft') { if (c.has('requisitions') || c.has('roster') || c.has('state')) drawRft(ctx); return; }
    if (!(c.has('agents') || c.has('tasks') || c.has('jobs') || c.has('board') || c.has('roster') || c.has('requisitions') || c.has('state'))) return;
    const job = ctx.job;
    if (view.mode === 'detail') { refreshDetail(ctx); return; }
    const jobId = job ? job.id : null;
    if (jobId !== view.jobId || (view.mode === 'empty' && job && ctx.sel.agentsOf(ctx.store, job.id).length)) {
      const box = view.container;
      view = null;
      clear(box);
      render(box, ctx);
      return;
    }
    if (view.mode === 'list') refreshList(ctx);
  },
  dispose() { if (view && view.detail) view.detail.log.stop(); view = null; },
};
