// Team panel: combines Active Floor, Certified Employee Handbook, and the Gamified Drag-and-Drop Agent Forge
// (Open-Weight Brains & Benchmarks + Harness Rack + Agent Tool Belt & Project Tool Wall + Mandatory RL & Verification QA).
//
// Core rule: Tacking a harness and tools onto an untrained model creates brittle slop. Every specialist in the Employee
// Handbook must be forged from an Open-Weight Brain + Harness Rig + Tool Belt, trained through the Universal RL Port
// (Local GPU, Remote Cluster, or [SIM] Demo), and pass Verification & QA before enrollment.
// Closed-source models (Claude, Gemini, OpenAI) are strictly blocked from the RL Forge.
//
// Deep links:
//   ?panel=crew&agent=<id>                         live streaming log of one floor agent
//   ?panel=crew&tab=roster                         Employee Handbook (verified benchmarks + owner +1/-1/0 ship ratings)
//   ?panel=crew&tab=forge&tray=models|rack|tools   Gamified Drag-and-Drop Agent Forge & Armory

import { h, mount, clear } from '../lib/dom.js';
import * as ui from '../lib/widgets.js';
import { mountModelsSection } from './models.js';
import { iconEl, editHarnessModal, previewHarnessModal, mountProjectToolsSection } from './toolkit.js';

const fmt = ui.fmt;
const enc = encodeURIComponent;
const LOG_CAP = 2000;
const STATUS_WORD = { thinking: 'Thinking', working: 'Working', waiting: 'Waiting', reviewing: 'Reviewing', blocked: 'Blocked', idle: 'Idle', off: 'Off' };
const ROLE_WORD = { boss: 'Orchestration Officer', manager: 'Team Lead', maker: 'Specialist' };
const CERT_LABEL = {
  curated: 'RL Verified',
  sim_trained: '[SIM] RL Verified',
  training_queued: 'RL Queued (Uncertified)',
  base_untrained: 'Untrained (Blocked)',
};
const REQ_STATUS = {
  queued_phase1: 'Queued for RL',
  training: 'RL Training…',
  verifying_qa: 'Verification & QA…',
  enrolled: 'Certified & Enrolled',
  rejected_qa: 'Failed QA Gate',
  dismissed: 'Dismissed',
};
const BUSY = new Set(['thinking', 'working', 'reviewing']);

const BUILTIN_AGENT_TOOLS = [
  { id: 'read_file', label: 'read_file', icon: 'book', summary: 'Read workspace files with line ranges inside the bench.' },
  { id: 'write_file', label: 'write_file', icon: 'clipboard', summary: 'Create or overwrite files inside the bench worktree.' },
  { id: 'edit_file', label: 'edit_file', icon: 'wrench', summary: 'Exact surgical search-and-replace edits on code files.' },
  { id: 'list_dir', label: 'list_dir', icon: 'folder', summary: 'Inspect directory trees and file layouts.' },
  { id: 'search_text', label: 'search_text', icon: 'search', summary: 'Fast regex/ripgrep search across the project.' },
  { id: 'run_shell', label: 'run_shell', icon: 'bolt', summary: 'Sandboxed shell execution for builds, tests, and linters.' },
  { id: 'shop_mcp', label: 'shop_mcp', icon: 'chat', summary: 'ShopTalk board coordination (DONE, ASK, BLOCK, INFO).' },
];

const DOMAINS = ['backend', 'frontend', 'algo', 'data', 'fix', 'test', 'security', 'research', 'plan'];

const keep = {
  offOpen: false,
  tray: 'models',
  showBenchmarks: false,
  customOssModels: [],
  customTools: [],
  forge: {
    name: 'Vega',
    title: 'Systems & Backend Specialist',
    role: 'maker',
    specialties: ['backend'],
    brainId: 'qwen3-coder-32b',
    brainLabel: 'Qwen3 Coder 32B',
    harnessId: 'fullstack-node',
    tools: ['read_file', 'write_file', 'edit_file', 'list_dir', 'search_text', 'run_shell', 'shop_mcp'],
    seed: 2140,
  },
};
let view = null;

function part(node, sig, build) {
  if (node.__sig === sig) return;
  node.__sig = sig;
  mount(node, build());
}

// ------------------------------------------------------------------ shared pieces

function statusChip(ctx, a) {
  const hold = ctx.sel.onHold(ctx.store, a);
  if (hold) return ui.chip('On hold', 'brick', { title: `The lab ${hold.provider || a.provider} is not usable right now${hold.until ? `. Release about ${fmt.time(hold.until)}` : ''}.` });
  const tone = { idle: 'plain', working: 'green', thinking: 'blue', waiting: 'amber', reviewing: 'amber', blocked: 'red', off: 'steel' }[a.status] || 'plain';
  return ui.chip(STATUS_WORD[a.status] || String(a.status || '?'), tone);
}

const roleChip = (a) => h('span', { class: ['chip', 't-plain', 'swatch'], style: { '--sw': `var(--role-${/^(boss|manager|maker)$/.test(a.role) ? a.role : 'maker'})` } }, (ROLE_WORD[a.role] || String(a.role)) + (a.lead ? ' · lead' : ''));
const statsText = (s) => `${fmt.plural(Number(s.turns) || 0, 'turn')} · ${fmt.tokens(s.inTok)} in, ${fmt.tokens(s.outTok)} out · ${fmt.money(s.usd)}`;
const workText = (s) => `${fmt.plural(Number(s.turns) || 0, 'turn')} · ${fmt.money(s.usd)}`;
const tokenText = (s) => ` · ${fmt.tokens(s.inTok)} tokens in, ${fmt.tokens(s.outTok)} out`;

function taskOf(ctx, a) {
  const t = a.taskId ? ctx.store.get('tasks', a.taskId) : null;
  if (!t) return null;
  return { t, verb: a.role === 'maker' ? (t.status === 'rework' ? 'reworks' : t.status === 'blocked' ? 'is blocked on' : ['working'].includes(t.status) ? 'builds' : 'handed in') : a.status === 'reviewing' ? 'reviews' : 'looks at' };
}

// ------------------------------------------------------------------ Tab 1: Active Floor (tree + detail log)

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

function tick(ctx, a) {
  const live = view.live.get(a.id);
  if (!live) return;
  const { store, sel } = ctx;
  const s = a.stats || {};
  const x = taskOf(ctx, a);
  const mail = sel.openFor(store, a).length;
  const asksYou = store.board.some((m) => m.fromId === a.id && m.to === sel.OWNER && m.state === 'open');
  live.node.classList.toggle('is-off', a.status === 'off');
  part(live.status, [a.status, JSON.stringify(sel.onHold(store, a)), mail, asksYou].join('|'), () => [statusChip(ctx, a),
    mail ? ui.chip(`${mail} open`, 'amber', { title: `${fmt.plural(mail, 'open board item')} that this agent must answer` }) : null,
    asksYou ? h('button.cw-asks', { type: 'button', title: `${a.name} asked you a question. Answer it in the Action Deck.`, onclick: () => ctx.openPanel('board', { view: 'actions' }) }, 'asks you') : null]);
  const certTone = a.certification === 'curated' ? 'green' : a.certification === 'sim_trained' ? 'blue' : 'amber';
  part(live.tags, [a.role, a.lead, a.provider, a.modelLabel || a.model, a.effort, a.harnessId, a.certification].join('|'), () => [roleChip(a), ui.labChip(a.provider, a.modelLabel || a.model || a.provider),
    a.harnessId ? ui.chip(`harness: ${a.harnessId}`, 'plain') : null,
    a.certification ? ui.chip(CERT_LABEL[a.certification] || a.certification, certTone) : null,
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
    let last = null;
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

  const shape = JSON.stringify([T.bosses.map((b) => b.id), T.managers.map((m) => [m.id, T.byMgr.get(m.id).map((x) => x.id)]), T.loose.map((x) => x.id), T.root && T.root.id, T.off.map((x) => x.id), keep.offOpen]);
  if (view.shape !== shape) {
    view.shape = shape;
    const old = new Map([...view.box.querySelectorAll('[data-slot]')].map((n) => [n.dataset.slot, n.firstChild]));
    const frag = [];
    const title = (text) => h('div.cw-title', text);
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
    for (const slot of view.box.querySelectorAll('[data-slot]')) { const node = old.get(slot.dataset.slot); if (node) slot.append(node); }
  }
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

function logLine(l) {
  const k = l && ['text', 'tool', 'err', 'sys'].includes(l.k) ? l.k : 'text';
  let s = String((l && l.s) ?? '');
  if (s.length > 4000) s = s.slice(0, 4000) + ' …';
  return h('div', { class: ['ll', 'll-' + k] }, h('span.ll-k', { 'aria-hidden': 'true' }, { text: ' ', tool: '>', err: '!', sys: '#' }[k]), h('span.ll-s', s));
}

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
    if (extra > 0) {
      const before = list.scrollHeight;
      for (; extra > 0 && list.firstChild; extra--) { list.firstChild.remove(); lines--; }
      if (!stick) list.scrollTop = Math.max(0, list.scrollTop - (before - list.scrollHeight));
    }
    if (stick) follow.pin();
    flag();
  }
  function push(batch) {
    if (dead || !Array.isArray(batch) || !batch.length) return;
    if (!ready) { held.push(...batch); return; }
    queue.push(...batch);
    if (!frame) frame = requestAnimationFrame(flush);
  }

  list.append(h('div.cw-logempty', 'Loading the log...'));
  flag();
  ctx.api.get(`/api/agents/${enc(agentId)}/log?tail=200`, { quiet: true }).then((tail) => {
    if (dead) return;
    const base = Array.isArray(tail) ? tail : [];
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
  const back = ui.btn('< Team', { small: true, title: 'Back to the whole team', onClick: () => ctx.setParams({ agent: null }) });
  const d = view.detail = { id: a.id, head: h('div'), facts: h('div'), acts: h('div'), items: h('div.cw-items'), log: createLog(ctx, a.id), bar: null, stats: null };
  ctx.setLayout('fill');
  container.append(h('div.cw-detail', h('div.cw-back', back), d.head, d.facts, d.acts, d.items, d.log.el));
  ctx.on('agentlog', (evt) => { if (evt && evt.agentId === a.id) d.log.push(evt.lines); });
  ctx.setTitle(`Team · ${a.name}`);
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
        a.harnessId ? ui.chip(`harness: ${a.harnessId}`, 'plain') : null,
        a.certification ? ui.chip(CERT_LABEL[a.certification] || a.certification, a.certification === 'curated' ? 'green' : a.certification === 'sim_trained' ? 'blue' : 'amber') : null,
        a.effort ? h('span.dim', `effort ${a.effort}`) : null),
      hold ? h('p.cw-hold', `On hold: the runtime ${hold.provider || a.provider} is not usable right now${hold.until ? `. The hub tries again about ${fmt.time(hold.until)}` : ''}.`) : null)));

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

  const mine = x && a.role === 'maker' && x.t.assigneeId === a.id ? x.t : null;
  part(d.acts, [a.id, a.handle, mine ? [mine.id, mine.status, mine.retries].join('~') : 'none'].join('|'), () => h('div.cw-acts',
    ui.btn('Message on the board', { tone: 'primary', small: true, title: `Open the board composer addressed to ${a.name}`, onClick: () => ctx.openPanel('board', { to: a.handle || a.id }) }),
    mine && ['planned', 'ready', 'working', 'rework'].includes(mine.status) ? ui.btn(`Stop ${mine.id}`, { tone: 'danger', small: true, title: 'Stop the task. A running turn ends. The task becomes blocked.', onClick: (e) => stopTask(ctx, a, mine, e.currentTarget) }) : null,
    mine && ['blocked', 'failed'].includes(mine.status) ? ui.btn('Retry with note', { tone: 'go', small: true, title: `Restart ${mine.id} with a fresh session`, onClick: (e) => retryTask(ctx, a, mine, e.currentTarget) }) : null));

  const owes = sel.openFor(store, a), waits = sel.openBy(store, a);
  const group = (title, list) => (list.length ? [h('div.caps.cw-itemhead', `${title} (${list.length})`), h('ul.list', (d.allItems ? list : list.slice(0, 3)).map((m) => itemRow(ctx, m)))] : null);
  part(d.items, [owes.map((m) => m.id).join(), waits.map((m) => m.id).join(), d.allItems].join('|'), () => (owes.length || waits.length ? ui.section('Open board items',
    group(`${a.name} owes an answer`, owes), group(`${a.name} waits for`, waits),
    owes.length > 3 || waits.length > 3 ? h('button.linkish', { type: 'button', onclick: () => { d.allItems = !d.allItems; refreshDetail(ctx); } }, d.allItems ? 'Show fewer' : `Show all ${owes.length + waits.length}`) : null) : null));
}

// ------------------------------------------------------------------ Tab 2: Certified Employee Handbook (Benchmarks + Ratings)

/** Edit persona details only (changing brain, harness, or tool belt requires RL re-training in the Forge!). */
function editPersonaModal(ctx, entry) {
  const fName = h('input', { type: 'text', value: String(entry.name || ''), placeholder: 'Euler' });
  const fTitle = h('input', { type: 'text', value: String(entry.title || ''), placeholder: 'Algorithm & Graph Specialist' });
  const fSpec = h('input', { type: 'text', value: (entry.specialties || []).join(', '), placeholder: 'algo, data' });
  const enabledBox = ui.checkbox('Active in Employee Handbook (eligible for staffing)', entry.enabled !== false);
  const buttons = [
    { label: 'Retire', tone: 'danger', run: async () => {
      if (!(await ctx.confirm({ title: `Retire ${entry.name}?`, text: 'Removes this specialist from the Employee Handbook.', okLabel: 'Retire', danger: true }))) return false;
      const res = await ctx.api.del(`/api/roster/${enc(entry.id)}`);
      if (!res) return false;
      const fresh = await ctx.api.get('/api/roster', { quiet: true });
      if (fresh) ctx.store.set('roster', fresh);
      ctx.toast(`${entry.name} retired from the Handbook.`);
      return true;
    } },
    { label: 'Cancel', value: false },
    { label: 'Save persona', primary: true, run: async () => {
      const payload = {
        ...entry,
        name: fName.value.trim() || entry.name,
        title: fTitle.value.trim() || entry.title,
        specialties: String(fSpec.value || '').split(',').map((x) => x.trim()).filter(Boolean),
        enabled: !!enabledBox.input.checked,
      };
      const res = await ctx.api.post('/api/roster', payload);
      if (!res) return false;
      const fresh = await ctx.api.get('/api/roster', { quiet: true });
      if (fresh) ctx.store.set('roster', fresh);
      ctx.toast(`${payload.name} updated.`);
      return true;
    } },
  ];
  ctx.modal({
    title: `Edit ${entry.name}`,
    wide: true,
    buttons,
    body: h('div.tw-form',
      h('p.dim', 'Brain, Harness Rig, and Tool Belt are locked to the certified RL checkpoint. To change them, use "Re-train in Forge".'),
      ui.field('Character name', fName),
      ui.field('Title', fTitle),
      ui.field('Specialties (domains)', fSpec),
      enabledBox),
  });
}

function loadEntryIntoForge(ctx, e) {
  keep.forge = {
    name: e.name || 'Vega',
    title: e.title || 'Specialist',
    role: e.role || 'maker',
    specialties: Array.isArray(e.specialties) && e.specialties.length ? [...e.specialties] : ['backend'],
    brainId: e.baseModel || 'qwen3-coder-32b',
    brainLabel: e.baseModel || 'qwen3-coder-32b',
    harnessId: e.harnessId || 'fullstack-node',
    tools: Array.isArray(e.tools) && e.tools.length ? [...e.tools] : ['read_file', 'write_file', 'edit_file', 'list_dir', 'search_text', 'run_shell', 'shop_mcp'],
    seed: (e.style && e.style.seed) || 2140,
  };
  ctx.setParams({ tab: 'forge', agent: null });
  ctx.toast(`${e.name}'s rig loaded onto the Agent Forge anvil.`);
}

function drawRoster(ctx) {
  if (!view || !view.rosterBox) return;
  const entries = Array.isArray(ctx.store.roster) ? ctx.store.roster : [];
  const sig = JSON.stringify(entries);
  if (view.rosterSig === sig) return;
  view.rosterSig = sig;
  const certifiedCount = entries.filter((e) => e.certification === 'curated' || e.certification === 'sim_trained').length;

  mount(view.rosterBox,
    h('div.fg-banner',
      h('div',
        h('div.strong', `${fmt.plural(certifiedCount, 'certified specialist')} in the Employee Handbook`),
        h('p.dim', { style: { margin: '2px 0 0' } }, 'Only RL-trained & QA-verified open-weight agents enter active service. Because static benchmarks can be gamed, every shipped crate logs +1, every denied load logs -1 with your reason, and discarded work logs 0.')),
      ui.btn('+ Forge & Train Agent', { tone: 'go', onClick: () => ctx.setParams({ tab: 'forge', agent: null }) })),
    entries.length ? h('div.ro-list', entries.map((e) => {
      const spriteAgent = { name: e.name, role: e.role, provider: 'oss', style: e.style || { seed: 2100 } };
      const isCertified = e.certification === 'curated' || e.certification === 'sim_trained';
      const cls = e.certification === 'curated' ? 'is-curated' : e.certification === 'sim_trained' ? 'is-rft' : 'is-base';
      const certTone = e.certification === 'curated' ? 'green' : e.certification === 'sim_trained' ? 'blue' : 'amber';
      const rec = e.record || { tasksCompleted: 0, reworks: 0 };
      const total = (rec.tasksCompleted || 0) + (rec.reworks || 0);
      const firstPass = total > 0 ? Math.round(((rec.tasksCompleted || 0) / total) * 100) + '%' : '–';
      const bm = e.benchmark || null;
      const rt = e.ratings || { score: 0, shipped: 0, denied: 0, discarded: 0, history: [] };
      const score = Number(rt.score) || 0;
      const history = Array.isArray(rt.history) ? rt.history : [];
      const tools = Array.isArray(e.tools) ? e.tools : [];

      return h('article', { class: ['ro-card', cls], dataset: { roster: e.id } },
        ui.avatarEl(spriteAgent, ctx.avatar(spriteAgent, 2), 48, { natural: true }),
        h('div.ro-main',
          h('div.ro-head',
            h('span.strong', String(e.name)),
            h('span.dim', String(e.title || '')),
            ui.chip(e.role === 'manager' ? 'Team Lead' : 'Specialist', 'plain'),
            ui.chip(CERT_LABEL[e.certification] || String(e.certification), certTone),
            !e.enabled ? ui.chip('Off Roster', 'steel') : null),
          h('div.hr-meta',
            ui.labChip('oss', e.baseModel),
            ui.chip(`harness: ${e.harnessId}`, 'plain'),
            tools.length ? ui.chip(`${tools.length} tools`, 'blue', { title: tools.join(', ') }) : null,
            ...(e.specialties || []).map((d) => ui.domainChip(d))),
          h('div.fg-metrics',
            bm
              ? ui.chip(`QA Eval ${bm.evalScore}/100${bm.passAt1 != null ? ` · pass@1 ${Math.round(bm.passAt1 * 100)}%` : ''}`, bm.portMode === 'sim' ? 'blue' : 'green',
                  { title: `Verified via ${bm.portMode || 'RL'} pipeline` })
              : isCertified
                ? ui.chip('Baseline Curated Benchmark', 'green', { title: 'Pre-certified reference specialist' })
                : ui.chip('No Verified RL Benchmark', 'red'),
            ui.chip(`Owner Rating: ${score > 0 ? '+' + score : score}`, score > 0 ? 'green' : score < 0 ? 'red' : 'plain',
              { title: 'Net owner rating (+1 shipped, -1 denied, 0 discarded)' }),
            h('span.dim.fg-rate-counts', `+${rt.shipped || 0} shipped · -${rt.denied || 0} denied · ${rt.discarded || 0} discarded · 1st-pass ${firstPass}`)),
          e.checkpoint ? h('div.dim.code.fg-ckpt', `ckpt: ${e.checkpoint}`) : null,
          history.length ? ui.fold(`Why? · Owner Rating Log (${history.length})`, () => h('ul.list.fg-hist', history.map((ev) => {
            const dTone = ev.delta > 0 ? 'green' : ev.delta < 0 ? 'red' : 'steel';
            const dWord = ev.delta > 0 ? '+1 SHIP' : ev.delta < 0 ? '-1 DENY' : '0 DISCARD';
            const stamp = ev.ts || ev.at;
            return h('li.li',
              ui.chip(dWord, dTone),
              ev.taskId ? h('span.strong', String(ev.taskId)) : null,
              ev.jobId ? h('span.dim', `(${ev.jobId})`) : null,
              h('span.grow', String(ev.note || ev.reason || (ev.delta > 0 ? 'Approved & shipped' : ev.delta < 0 ? 'Denied' : 'Discarded without penalty'))),
              stamp ? h('span.dim', fmt.ago(stamp)) : null);
          }))) : null,
          h('div.ro-acts',
            ui.btn(isCertified ? 'Re-train in Forge' : 'Train in Forge ->', { small: true, tone: isCertified ? undefined : 'go', onClick: () => loadEntryIntoForge(ctx, e) }),
            ui.btn('Edit persona', { small: true, onClick: () => editPersonaModal(ctx, e) }))));
    })) : ui.emptyState('Employee Handbook is empty', 'Open the Agent Forge to assemble an open-weight model, harness, and tool belt and send it through RL + Verification QA.',
      ui.btn('Open Agent Forge', { tone: 'go', onClick: () => ctx.setParams({ tab: 'forge', agent: null }) })));
}

// ------------------------------------------------------------------ Tab 3: Gamified Drag-and-Drop Agent Forge & Armory

function getAllModels(ctx) {
  const reg = ctx.store.models && ctx.store.models.registry;
  const base = reg && Array.isArray(reg.models) ? reg.models : [];
  const ossProv = (ctx.store.providers || []).find((p) => p.id === 'oss');
  const detected = ossProv && Array.isArray(ossProv.models) ? ossProv.models : [];
  const seen = new Set(base.map((m) => m.id));
  const extra = [];
  for (const id of [...detected, ...keep.customOssModels]) {
    const clean = String(id || '').trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      extra.push({ id: clean, label: clean, provider: 'oss', power: 3, price: { in: 0, out: 0 } });
    }
  }
  return [...base, ...extra];
}

function getAllAgentTools(ctx) {
  const seen = new Map(BUILTIN_AGENT_TOOLS.map((t) => [t.id, t]));
  for (const hItem of ctx.store.harnesses || []) {
    for (const tid of hItem.tools || []) {
      if (!seen.has(tid)) seen.set(tid, { id: tid, label: tid, icon: 'wrench', summary: `Tool defined by harness "${hItem.label}".` });
    }
  }
  for (const t of keep.customTools) seen.set(t.id, t);
  return [...seen.values()];
}

function makeDragPayload(el, payload) {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    el.classList.add('is-dragging');
    try {
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', JSON.stringify(payload));
    } catch { /* ignore */ }
  });
  el.addEventListener('dragend', () => el.classList.remove('is-dragging'));
  return el;
}

function wireDropZone(el, acceptKind, onDropPayload) {
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.classList.add('is-over');
  });
  el.addEventListener('dragleave', () => el.classList.remove('is-over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('is-over');
    let data = null;
    try { data = JSON.parse(e.dataTransfer.getData('text/plain') || ''); } catch { data = null; }
    if (!data) return;
    if (acceptKind && data.kind !== acceptKind && !(acceptKind === 'brain' && data.kind === 'closed-brain')) {
      onDropPayload({ mismatch: true, got: data.kind, expected: acceptKind });
      return;
    }
    onDropPayload(data);
  });
  return el;
}

function addCustomToolModal(ctx) {
  const fId = h('input', { type: 'text', placeholder: 'ast_grep', maxLength: 40 });
  const fSum = h('input', { type: 'text', placeholder: 'Structural AST search & rewrite across project files' });
  ctx.modal({
    title: 'Build / Register Agent Tool',
    buttons: [
      { label: 'Cancel', value: false },
      { label: 'Add to Armory & Equip', primary: true, run: () => {
        const id = fId.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
        if (!id) return false;
        const tool = { id, label: id, icon: 'hammer', summary: fSum.value.trim() || 'Custom intrinsic specialist tool.' };
        keep.customTools = [...keep.customTools.filter((x) => x.id !== id), tool];
        if (!keep.forge.tools.includes(id)) keep.forge.tools.push(id);
        drawForge(ctx);
        ctx.toast(`Tool "${id}" added and equipped on the Tool Belt.`);
        return true;
      } },
    ],
    body: h('div.tw-form',
      h('p.dim', 'Custom agent tools are compiled into the specialist harness (.shop/HARNESS.md) and verified during the RL pipeline.'),
      ui.field('Tool identifier', fId),
      ui.field('What it does', fSum)),
  });
}

async function copyPortPrompt(ctx) {
  let rl = ctx.store.rlPort;
  if (!rl || !rl.agentPrompt) {
    rl = await ctx.api.get('/api/rl-port', { quiet: true });
    if (rl) ctx.store.set('rlPort', rl);
  }
  const text = (rl && rl.agentPrompt) || 'Read ports/rl/PORT_CONTRACT.md and wire local/rl-port.mjs to my GPU or remote cluster.';
  let copied = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); copied = true; }
  } catch { copied = false; }
  if (copied) {
    ctx.toast('Copied RL Port wiring prompt! Paste it into your coding agent to connect your local GPU or remote cluster.');
  } else {
    ctx.modal({
      title: 'Agent Prompt · Wire Universal RL Port',
      wide: true,
      buttons: [{ label: 'Close', primary: true }],
      body: h('div.stack',
        h('p.dim', 'Copy this prompt into your coding agent to connect your local machine GPU or remote cluster (Droplet / Hostinger / RunPod):'),
        h('pre.term', text)),
    });
  }
}

async function submitForge(ctx, button) {
  const f = keep.forge;
  if (!f.name.trim()) { ctx.toast('Give your specialist a name first.', 'warn'); return; }
  if (!f.brainId) { ctx.toast('Drop an Open-Weight Brain into Slot 1 first.', 'warn'); return; }
  if (!f.harnessId) { ctx.toast('Drop a Harness Rig into Slot 2 first.', 'warn'); return; }
  if (!f.tools.length) { ctx.toast('Equip at least one tool on the Tool Belt.', 'warn'); return; }
  await ui.busy(button, async () => {
    const res = await ctx.api.post('/api/training/forge', {
      name: f.name.trim(),
      title: f.title.trim() || `${(f.specialties[0] || 'general').toUpperCase()} Specialist`,
      role: f.role,
      baseModel: f.brainId,
      harnessId: f.harnessId,
      tools: f.tools,
      specialties: f.specialties.length ? f.specialties : ['backend'],
      domain: f.specialties[0] || 'backend',
      autoStart: true,
    });
    if (!res) return;
    const [reqList, rosList] = await Promise.all([
      ctx.api.get('/api/requisitions', { quiet: true }),
      ctx.api.get('/api/roster', { quiet: true }),
    ]);
    if (reqList) ctx.store.set('requisitions', reqList);
    if (rosList) ctx.store.set('roster', rosList);
    ctx.toast(`${f.name.trim()} entered the RL training pipeline!`);
    drawForge(ctx);
    ensureRlPoller(ctx);
  });
}

function ensureRlPoller(ctx) {
  if (!view) return;
  const active = (ctx.store.requisitions || []).filter((r) => r.status === 'training' || r.status === 'verifying_qa');
  if (!active.length) {
    if (view.rlTimer) { clearInterval(view.rlTimer); view.rlTimer = 0; }
    return;
  }
  if (view.rlTimer) return;
  view.rlTimer = setInterval(async () => {
    if (!view || document.hidden) return;
    const running = (ctx.store.requisitions || []).filter((r) => r.status === 'training' || r.status === 'verifying_qa');
    if (!running.length) { clearInterval(view.rlTimer); view.rlTimer = 0; return; }
    let enrolledAny = false;
    for (const r of running) {
      const res = await ctx.api.post(`/api/requisitions/${enc(r.id)}/poll`, {}, { quiet: true });
      if (res && (res.enrolled || res.status === 'enrolled' || (res.requisition && res.requisition.status === 'enrolled'))) enrolledAny = true;
    }
    const [reqList, rosList] = await Promise.all([
      ctx.api.get('/api/requisitions', { quiet: true }),
      enrolledAny ? ctx.api.get('/api/roster', { quiet: true }) : Promise.resolve(null),
    ]);
    if (reqList) ctx.store.set('requisitions', reqList);
    if (rosList) ctx.store.set('roster', rosList);
    if (enrolledAny) ctx.toast('RL Training & Verification QA passed! Specialist added to the Employee Handbook.', 'info');
    if (view && view.tab === 'forge') drawForge(ctx);
  }, 1100);
}

function drawForge(ctx) {
  if (!view || !view.forgeBox) return;
  const harnesses = Array.isArray(ctx.store.harnesses) ? ctx.store.harnesses : [];
  const allModels = getAllModels(ctx);
  const ossModels = allModels.filter((m) => m.provider === 'oss');
  const closedModels = allModels.filter((m) => m.provider !== 'oss');
  const allTools = getAllAgentTools(ctx);
  const reqs = Array.isArray(ctx.store.requisitions) ? ctx.store.requisitions : [];
  const rl = ctx.store.rlPort || { mode: 'sim', hasCustomModule: false };
  const f = keep.forge;

  // Dispose subviews before re-mounting if tray changed
  if (view.modelsSub) { view.modelsSub.dispose(); view.modelsSub = null; }
  if (view.toolsSub) { view.toolsSub.dispose(); view.toolsSub = null; }

  const equippedHarness = harnesses.find((x) => x.id === f.harnessId) || harnesses[0] || null;
  if (equippedHarness && f.harnessId !== equippedHarness.id) f.harnessId = equippedHarness.id;
  const equippedBrain = ossModels.find((x) => x.id === f.brainId) || { id: f.brainId, label: f.brainLabel || f.brainId, provider: 'oss' };
  const spritePreview = { name: f.name || 'Forge', role: f.role, provider: 'oss', style: { seed: f.seed } };

  // --- Slot 1: Open-Weight Brain Drop Zone ---
  const brainSlot = wireDropZone(
    h('div.fg-slot', { dataset: { slotKind: 'brain' } },
      h('div.fg-slot-head', h('span.caps', '1 · Brain (Open-Weight Only)'), ui.labChip('oss', 'oss · $0')),
      h('div.fg-slot-body',
        h('div.strong', String(equippedBrain.label || equippedBrain.id)),
        h('div.dim.code', String(equippedBrain.id)),
        h('div.dim', 'Weights exportable to GPU cluster for intrinsic RL')),
      h('div.fg-slot-foot', 'Drop an Open-Weight model here')),
    'brain',
    (data) => {
      if (data.kind === 'closed-brain') {
        brainSlot.classList.remove('fg-shake'); void brainSlot.offsetWidth; brainSlot.classList.add('fg-shake');
        ctx.toast(`Blocked: ${data.label} (${data.provider}) is closed-source. Proprietary weights cannot be exported to a GPU cluster for RL post-training.`, 'error');
        return;
      }
      if (data.mismatch) { ctx.toast('Drop an Open-Weight Brain model into Slot 1.', 'warn'); return; }
      f.brainId = data.id;
      f.brainLabel = data.label || data.id;
      drawForge(ctx);
      ctx.toast(`Equipped brain: ${f.brainLabel}`);
    }
  );

  // --- Slot 2: Harness Rig Drop Zone ---
  const harnessSlot = wireDropZone(
    h('div.fg-slot', { dataset: { slotKind: 'harness' } },
      h('div.fg-slot-head', h('span.caps', '2 · Harness Rig'), equippedHarness ? ui.chip(equippedHarness.id, 'green') : null),
      equippedHarness ? h('div.fg-slot-body',
        h('div.strong', String(equippedHarness.label)),
        h('div.dim', fmt.clip(String(equippedHarness.summary || ''), 90)),
        h('div.hr-meta', ...((equippedHarness.rft && equippedHarness.rft.rewardSignals) || []).slice(0, 3).map((r) => ui.chip(String(r), 'amber'))))
        : h('div.fg-slot-body.dim', 'No harness selected'),
      h('div.fg-slot-foot',
        equippedHarness ? h('button.linkish', { type: 'button', onclick: () => previewHarnessModal(ctx, equippedHarness) }, 'Inspect .shop/HARNESS.md') : null,
        h('span.grow'),
        'Drop a Harness Rig here')),
    'harness',
    (data) => {
      if (data.mismatch) { ctx.toast('Drop a Harness Rig into Slot 2.', 'warn'); return; }
      f.harnessId = data.id;
      const hObj = harnesses.find((x) => x.id === data.id);
      if (hObj) {
        if (Array.isArray(hObj.tools) && hObj.tools.length) f.tools = [...new Set(hObj.tools)];
        if (Array.isArray(hObj.domains) && hObj.domains.length) f.specialties = [...hObj.domains];
        if (hObj.roleHint) f.role = hObj.roleHint;
      }
      drawForge(ctx);
      ctx.toast(`Equipped harness: ${data.label || data.id}`);
    }
  );

  // --- Slot 3: Tool Belt Drop Zone ---
  const toolSlot = wireDropZone(
    h('div.fg-slot', { dataset: { slotKind: 'tool' } },
      h('div.fg-slot-head', h('span.caps', `3 · Intrinsic Tool Belt (${f.tools.length})`),
        h('button.linkish', { type: 'button', onclick: () => addCustomToolModal(ctx) }, '+ Build Tool')),
      h('div.fg-belt',
        f.tools.length ? f.tools.map((tid) => h('span.fg-toolchip',
          h('span.code', tid),
          h('button.fg-toolx', { type: 'button', title: `Remove ${tid}`, 'aria-label': `Remove ${tid}`, onclick: () => {
            f.tools = f.tools.filter((x) => x !== tid);
            drawForge(ctx);
          } }, '×'))) : h('span.dim', 'Drop tools here so RL trains with them')),
      h('div.fg-slot-foot', 'Drag tools in · RL trains tool-call trajectories')),
    'tool',
    (data) => {
      if (data.mismatch) { ctx.toast('Drop an Agent Tool into Slot 3.', 'warn'); return; }
      if (!f.tools.includes(data.id)) f.tools.push(data.id);
      drawForge(ctx);
      ctx.toast(`Added "${data.id}" to Tool Belt.`);
    }
  );

  // --- Character Identity Controls ---
  const nameIn = h('input', { type: 'text', value: f.name, maxLength: 40, placeholder: 'Euler', oninput: () => { f.name = nameIn.value; } });
  const titleIn = h('input', { type: 'text', value: f.title, maxLength: 80, placeholder: 'Systems & Backend Specialist', oninput: () => { f.title = titleIn.value; } });
  const roleSel = ui.select([{ value: 'maker', label: 'Specialist (maker)' }, { value: 'manager', label: 'Team Lead (manager)' }], f.role, {
    onchange: () => { f.role = roleSel.select.value; drawForge(ctx); },
  });
  const domRow = h('div.fg-doms', DOMAINS.map((d) => {
    const active = f.specialties.includes(d);
    return h('button.fg-dombtn', { type: 'button', 'aria-pressed': String(active), onclick: () => {
      if (active && f.specialties.length > 1) f.specialties = f.specialties.filter((x) => x !== d);
      else if (!active) f.specialties = [...f.specialties, d];
      drawForge(ctx);
    } }, d);
  }));

  const rlCfg = rl.config || rl;
  const hasAdapter = !!(rl.hasAdapterScript || rl.hasCustomModule);
  const remoteUrl = rlCfg.remoteUrl || rl.remoteUrl || '';
  const remoteProv = rl.providerHint || rlCfg.providerHint || rl.remoteProvider || 'custom';
  const portModeWord = rl.mode === 'local'
    ? (hasAdapter ? 'Local Machine GPU (local/rl-port.mjs)' : rl.ok ? 'Local Machine GPU (connected)' : 'Local Machine GPU (awaiting port)')
    : rl.mode === 'remote'
      ? `Remote Compute Cluster (${remoteProv})`
      : '[SIM] Demo RL Sandbox (zero GPU)';
  const portTone = rl.mode === 'sim' ? 'blue' : rl.ok || (rl.mode === 'local' && hasAdapter) || (rl.mode === 'remote' && remoteUrl) ? 'green' : 'amber';

  const workbench = h('section.fg-bench',
    h('div.fg-bench-head',
      ui.avatarEl(spritePreview, ctx.avatar(spritePreview, 2), 52, { natural: true }),
      h('div.fg-identity',
        h('div.fg-id-row', ui.field('Agent Name', nameIn), ui.field('Title', titleIn), ui.field('Role', roleSel),
          ui.btn('Reroll Sprite', { small: true, title: 'Cycle character appearance', onClick: () => { f.seed = (f.seed + 37) % 9999; drawForge(ctx); } })),
        h('div.fg-dom-wrap', h('span.caps', 'Specialties:'), domRow))),
    h('p.fg-rule', 'No Untrained Slop: Models cannot enter the Employee Handbook until they are post-trained with their exact Harness Rig & Tool Belt and pass Verification QA (eval >= 75, pass@1 >= 75%, 0 sandbox violations).'),
    h('div.fg-slots', brainSlot, harnessSlot, toolSlot),
    h('div.fg-launch',
      h('div.fg-port-info',
        h('span.caps', 'RL Compute Port:'),
        ui.chip(portModeWord, portTone),
        h('button.linkish', { type: 'button', onclick: () => ctx.openPanel('settings', { tab: 'rlport' }) }, 'Configure Port'),
        h('button.linkish', { type: 'button', onclick: () => copyPortPrompt(ctx) }, 'Copy Agent Prompt to Wire Port')),
      ui.btn('Send to RL Pipeline ->', { tone: 'go', cls: 'big', onClick: (e) => submitForge(ctx, e.currentTarget) })));

  // --- RL Pipeline & Verification QA Queue ---
  const activeReqs = reqs.filter((r) => r.status !== 'dismissed');
  const pipelineSec = ui.section(
    ['RL Training & Verification QA Pipeline', h('span.count', activeReqs.length ? `${activeReqs.length} run${activeReqs.length === 1 ? '' : 's'}` : 'idle')],
    activeReqs.length ? h('div.ro-list', activeReqs.slice().reverse().map((r) => {
      const job = r.runState || r.rlJob || null;
      const pct = job && Number.isFinite(Number(job.progress)) && job.progress <= 1 && (!job.step || job.progress > 0)
        ? Math.round(job.progress * 100)
        : job && job.totalSteps > 0 ? Math.round((Math.min(job.step || 0, job.totalSteps) / job.totalSteps) * 100) : r.status === 'enrolled' ? 100 : 0;
      const portMode = (job && job.mode) || r.portMode || null;
      const errText = (job && job.error) || r.lastError || null;
      const meanRew = job && job.meanReward != null ? job.meanReward : job && job.metrics && job.metrics.reward != null ? job.metrics.reward : null;
      const qa = r.qaReport || null;
      const sTone = r.status === 'enrolled' ? 'green' : r.status === 'rejected_qa' ? 'red' : r.status === 'training' || r.status === 'verifying_qa' ? 'blue' : 'amber';
      return h('article', { class: ['rft-card', r.status === 'enrolled' && 'is-done'], dataset: { requisition: r.id } },
        h('div.ro-head',
          ui.chip(r.id, 'dark'),
          ui.chip(REQ_STATUS[r.status] || r.status, sTone),
          portMode ? ui.chip(`port: ${String(portMode).toUpperCase()}`, portMode === 'sim' ? 'blue' : 'plain') : null,
          ui.domainChip(r.domain),
          h('span.strong', String(r.suggestedName || r.domain))),
        h('div.hr-meta',
          ui.labChip('oss', r.candidateBaseModel || 'oss'),
          ui.chip(`harness: ${r.harnessId}`, 'plain'),
          Array.isArray(r.tools) && r.tools.length ? ui.chip(`${r.tools.length} tools`, 'blue') : null,
          r.enrolledRosterId ? ui.chip(`enrolled -> ${r.enrolledRosterId}`, 'green') : null),
        r.status === 'training' && job ? h('div.fg-prog',
          ui.bar(pct / 100),
          h('span.dim', `Step ${job.step || Math.round(pct)}/${job.totalSteps || 100} (${pct}%)${meanRew != null ? ` · reward ${(Number(meanRew) * 100).toFixed(1)}%` : ''}`)) : null,
        errText ? h('p.ib-warn', String(errText)) : null,
        qa && Array.isArray(qa.checks) ? h('div.fg-qa',
          h('div.caps', qa.passed ? `Verification QA Passed · Eval ${qa.evalScore}/100 · pass@1 ${Math.round((qa.passAt1 || 0) * 100)}%` : `Verification QA Rejected · ${qa.summary || ''}`),
          h('div.hr-meta', ...qa.checks.map((c) => ui.chip(`${c.ok ? 'PASS' : 'FAIL'} · ${String(c.name || c.id || 'check').replace(/_/g, ' ')}`, c.ok ? 'green' : 'red', { title: c.detail })))) : null,
        h('div.ro-acts',
          r.status === 'queued_phase1' || r.status === 'rejected_qa' ? ui.btn(r.status === 'rejected_qa' ? 'Retry RL Run' : 'Start RL Training', { small: true, tone: 'go', onClick: (e) => ui.busy(e.currentTarget, async () => {
            const res = await ctx.api.post(`/api/requisitions/${enc(r.id)}/start`, {});
            if (!res) return;
            const reqList = await ctx.api.get('/api/requisitions', { quiet: true });
            if (reqList) ctx.store.set('requisitions', reqList);
            drawForge(ctx);
            ensureRlPoller(ctx);
          }) }) : null,
          r.status === 'queued_phase1' ? ui.btn('Load onto Anvil', { small: true, onClick: () => {
            f.name = r.suggestedName || 'Specialist';
            f.brainId = r.candidateBaseModel || 'qwen3-coder-32b';
            f.brainLabel = f.brainId;
            f.harnessId = r.harnessId || 'fullstack-node';
            f.specialties = [r.domain || 'backend'];
            if (Array.isArray(r.tools) && r.tools.length) f.tools = [...r.tools];
            drawForge(ctx);
            ctx.toast(`Loaded ${r.id} onto the Forge anvil.`);
          } }) : null,
          r.status === 'training' ? ui.btn('Cancel Run', { small: true, tone: 'danger', onClick: (e) => ui.busy(e.currentTarget, async () => {
            await ctx.api.post(`/api/requisitions/${enc(r.id)}/cancel`, {});
            const reqList = await ctx.api.get('/api/requisitions', { quiet: true });
            if (reqList) ctx.store.set('requisitions', reqList);
            drawForge(ctx);
          }) }) : null,
          r.status !== 'enrolled' && r.status !== 'training' ? ui.btn('Dismiss', { small: true, onClick: async () => {
            const res = await ctx.api.post(`/api/requisitions/${enc(r.id)}/dismiss`);
            if (res) {
              const reqList = await ctx.api.get('/api/requisitions', { quiet: true });
              if (reqList) ctx.store.set('requisitions', reqList);
              drawForge(ctx);
            }
          } }) : null));
    })) : h('p.dim', 'No active RL jobs. Assemble an agent above and press "Send to RL Pipeline ->".')
  );

  // --- Armory Trays (Models & Benchmarks | Harness Rack | Tools & Project Wall) ---
  const trayTabs = h('div.panel-tabs.fg-trays',
    ui.segmented([
      { value: 'models', label: `Open-Weight Brains (${ossModels.length})`, title: 'Draggable open-weight brains, locked closed-source models, and BenchLM leaderboard' },
      { value: 'rack', label: `Harness Rack (${harnesses.length})`, title: 'Draggable specialist harnesses & .shop/HARNESS.md builder' },
      { value: 'tools', label: `Tools & Project Wall`, title: 'Intrinsic agent tools + per-project Tool Wall commands' },
    ], keep.tray, (v) => { keep.tray = v; drawForge(ctx); }),
    keep.tray === 'rack' ? ui.btn('+ Build Harness', { small: true, tone: 'go', onClick: () => editHarnessModal(ctx, harnesses, null) }) : null,
    keep.tray === 'tools' ? ui.btn('+ Build Agent Tool', { small: true, tone: 'go', onClick: () => addCustomToolModal(ctx) }) : null,
    keep.tray === 'models' ? ui.btn(keep.showBenchmarks ? 'Hide Full Benchmark Table' : 'Full Benchmark Table', { small: true, onClick: () => { keep.showBenchmarks = !keep.showBenchmarks; drawForge(ctx); } }) : null);

  const trayBody = h('div.fg-tray-body');
  if (keep.tray === 'models') {
    const customIn = h('input', { type: 'text', placeholder: 'Add custom HuggingFace / Ollama open-weight id (e.g. deepseek-r1-distill-qwen-32b)' });
    const addCustomBtn = ui.btn('Add Open-Weight Model', { small: true, onClick: () => {
      const id = customIn.value.trim();
      if (!id) return;
      if (/^(claude|gemini|gpt-|o1-|o3-|o4-|openai)/i.test(id)) {
        ctx.toast('Closed-source models cannot be added to the Open-Weight Brain tray.', 'error');
        return;
      }
      if (!keep.customOssModels.includes(id)) keep.customOssModels.push(id);
      f.brainId = id; f.brainLabel = id;
      drawForge(ctx);
      ctx.toast(`Added & equipped open-weight model "${id}".`);
    } });
    trayBody.append(
      h('p.dim', 'Drag any Open-Weight model into Slot 1 (or press Equip). Weights can run RL locally on your GPU or on a remote cluster.'),
      h('div.fg-custom-row', customIn, addCustomBtn),
      h('div.fg-grid', ossModels.map((m) => {
        const eq = f.brainId === m.id;
        const cardEl = makeDragPayload(
          h('article', { class: ['fg-item', eq && 'is-equipped'] },
            h('div.fg-item-top', h('span.strong', String(m.label || m.id)), ui.labChip('oss', '$0 · Open Weights')),
            h('div.dim.code', String(m.id)),
            h('div.fg-item-acts',
              eq ? ui.chip('Equipped in Slot 1', 'green') : ui.btn('Equip Brain', { small: true, tone: 'primary', onClick: () => { f.brainId = m.id; f.brainLabel = m.label || m.id; drawForge(ctx); } }))),
          { kind: 'brain', id: m.id, label: m.label || m.id }
        );
        return cardEl;
      })),
      h('div.caps', { style: { marginTop: '14px' } }, 'Closed-Source Frontier Models · Locked from RL Post-Training'),
      h('p.dim', 'Proprietary API weights cannot be exported to your machine or GPU cluster for RL fine-tuning. They serve strictly as Orchestration Officers & Final Review Gates.'),
      h('div.fg-grid', closedModels.map((m) => makeDragPayload(
        h('article.fg-item.is-locked', { title: 'Closed-source model: weights cannot be exported for GPU RL post-training.' },
          h('div.fg-item-top', h('span.strong', String(m.label || m.id)), ui.labChip(m.provider, m.provider)),
          h('div.hr-meta', ui.chip('LOCKED · Closed Weights', 'red'), ui.chip('Officer / Gate Only', 'steel'))),
        { kind: 'closed-brain', id: m.id, label: m.label || m.id, provider: m.provider }
      ))));
    if (keep.showBenchmarks) {
      const benchBox = h('div.fg-bench-table');
      trayBody.append(benchBox);
      view.modelsSub = mountModelsSection(benchBox, ctx);
    }
  } else if (keep.tray === 'rack') {
    const iconFor = { backend: 'wrench', fix: 'bug', frontend: 'star', test: 'gauge', data: 'search', algo: 'bolt', research: 'book', plan: 'clipboard' };
    trayBody.append(
      h('p.dim', 'Drag a Harness Rig into Slot 2 (or press Equip). Harnesses pair .shop/HARNESS.md protocols with verifiable RL reward signals.'),
      h('div.hr-grid', harnesses.map((item) => {
        const eq = f.harnessId === item.id;
        const firstDom = (item.domains || [])[0];
        return makeDragPayload(
          h('article', { class: ['hr-card', 'fg-draggable', eq && 'is-equipped'], dataset: { harness: item.id } },
            h('div.hr-cardhead', iconEl(iconFor[firstDom] || 'wrench', item.label),
              h('div.hr-cardhead-main',
                h('span.strong', String(item.label || item.id)),
                ui.chip(item.roleHint === 'manager' ? 'Team Lead' : 'Specialist', 'plain'))),
            h('p.hr-summary', String(item.summary || '')),
            (item.domains || []).length ? h('div.hr-meta', ...(item.domains || []).map((d) => ui.domainChip(d))) : null,
            h('div.hr-acts',
              eq ? ui.chip('Equipped in Slot 2', 'green') : ui.btn('Equip Rig', { small: true, tone: 'primary', onClick: () => {
                f.harnessId = item.id;
                if (Array.isArray(item.tools) && item.tools.length) f.tools = [...new Set(item.tools)];
                drawForge(ctx);
              } }),
              ui.btn('Inspect', { small: true, onClick: () => previewHarnessModal(ctx, item) }),
              ui.btn('Edit', { small: true, onClick: () => editHarnessModal(ctx, harnesses, item) }))),
          { kind: 'harness', id: item.id, label: item.label }
        );
      })));
  } else {
    const projToolsBox = h('div.fg-proj-tools');
    trayBody.append(
      h('div.caps', 'Intrinsic Agent Tools (Drag onto Slot 3 Tool Belt)'),
      h('p.dim', 'Tools equipped on the belt are baked into the specialist\'s RL trajectory training and verified at QA.'),
      h('div.fg-grid', allTools.map((t) => {
        const eq = f.tools.includes(t.id);
        return makeDragPayload(
          h('article', { class: ['fg-item', eq && 'is-equipped'] },
            h('div.fg-item-top', iconEl(t.icon || 'wrench', t.label), h('span.strong.code', t.label)),
            h('div.dim', t.summary),
            h('div.fg-item-acts',
              eq ? ui.btn('Equipped (Remove)', { small: true, onClick: () => { f.tools = f.tools.filter((x) => x !== t.id); drawForge(ctx); } })
                : ui.btn('+ Equip on Belt', { small: true, tone: 'primary', onClick: () => { f.tools.push(t.id); drawForge(ctx); } }))),
          { kind: 'tool', id: t.id, label: t.label }
        );
      })),
      ui.section(['Project Tool Wall', h('span.count', 'one-click commands, saved orders & asks for this repo')], projToolsBox)
    );
    view.toolsSub = mountProjectToolsSection(projToolsBox, ctx);
  }

  mount(view.forgeBox, workbench, pipelineSec, trayTabs, trayBody);
  ensureRlPoller(ctx);
}

// ------------------------------------------------------------------ panel lifecycle

function render(container, ctx) {
  const job = ctx.job;
  const roster = Array.isArray(ctx.store.roster) ? ctx.store.roster : [];
  const certified = roster.filter((e) => e.certification === 'curated' || e.certification === 'sim_trained').length;
  const activeRl = (ctx.store.requisitions || []).filter((r) => ['queued_phase1', 'training', 'verifying_qa'].includes(r.status)).length;
  const wanted = job && ctx.params.agent ? ctx.sel.agentByRef(ctx.store, ctx.params.agent, job.id) || ctx.store.get('agents', ctx.params.agent) : null;
  if (wanted) {
    view = { container, live: new Map(), shape: null, sum: h('div'), box: h('div.cw-tree'), detail: null, mode: 'detail', tab: 'team', jobId: job ? job.id : null, rlTimer: 0, modelsSub: null, toolsSub: null };
    renderDetail(container, ctx, wanted);
    return;
  }

  ctx.setLayout('flow');
  if (ctx.params.tray && ['models', 'rack', 'tools'].includes(String(ctx.params.tray))) keep.tray = String(ctx.params.tray);
  if (ctx.params.benchmarks === '1') keep.showBenchmarks = true;
  const rawTab = ctx.params.tab === 'rft' ? 'forge' : ctx.params.tab;
  const tab = ['team', 'roster', 'forge'].includes(rawTab) ? rawTab : (ctx.params.tray ? 'forge' : 'team');

  const tabs = h('div.panel-tabs',
    ui.segmented([
      { value: 'team', label: 'Active Floor', title: 'Live orchestration officers, team leads, and bench specialists' },
      { value: 'roster', label: `Employee Handbook (${certified})`, title: 'RL-certified specialists, verified benchmarks, and owner +1/-1/0 ship ratings' },
      { value: 'forge', label: activeRl ? `Agent Forge & Armory (${activeRl})` : 'Agent Forge & Armory', title: 'Drag-and-drop Open-Weight Brains, Harnesses, and Tools into the RL + QA pipeline' },
    ], tab, (v) => ctx.setParams({ tab: v, agent: null, tray: null, benchmarks: null })));

  view = {
    container, live: new Map(), shape: null, sum: h('div'), box: h('div.cw-tree'),
    rosterBox: h('div'), forgeBox: h('div'), rosterSig: null, detail: null,
    mode: tab, tab, jobId: job ? job.id : null, rlTimer: 0, modelsSub: null, toolsSub: null,
  };
  container.append(tabs);

  if (tab === 'roster') {
    container.append(view.rosterBox);
    drawRoster(ctx);
    return;
  }
  if (tab === 'forge') {
    container.append(view.forgeBox);
    drawForge(ctx);
    return;
  }

  if (!job) {
    container.append(ui.emptyState('No active floor crew yet', 'Start a work order to staff orchestration officers and certified Handbook specialists, or forge a new specialist in the Agent Forge.',
      ui.btn('+ Work order', { tone: 'go', onClick: () => ctx.openPanel('workorder') }),
      ui.btn('Open Agent Forge', { onClick: () => ctx.setParams({ tab: 'forge', agent: null }) }),
      ui.btn('Employee Handbook', { onClick: () => ctx.setParams({ tab: 'roster', agent: null }) })));
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
  title: 'Team, Agent Forge & Handbook',
  label: 'Team',
  short: 'Team',
  wide: true,
  badge: ({ store, sel, job }) => {
    const live = job ? sel.agentsOf(store, job.id).filter((a) => a.status === 'blocked' || sel.onHold(store, a)).length : 0;
    const activeRl = (store.requisitions || []).filter((r) => ['queued_phase1', 'training', 'verifying_qa'].includes(r.status)).length;
    return live + activeRl;
  },
  render,
  update(ctx) {
    if (!view) return;
    const c = ctx.changes;
    if (view.tab === 'roster') {
      if (c.has('roster') || c.has('harnesses') || c.has('state')) drawRoster(ctx);
      return;
    }
    if (view.tab === 'forge') {
      if (view.modelsSub && (c.has('models') || c.has('state'))) view.modelsSub.update();
      if (view.toolsSub && (c.has('projects') || c.has('jobs') || c.has('state'))) view.toolsSub.update();
      if (c.has('harnesses') || c.has('requisitions') || c.has('rlPort') || c.has('providers') || c.has('state')) drawForge(ctx);
      return;
    }
    if (!(c.has('agents') || c.has('tasks') || c.has('jobs') || c.has('board') || c.has('roster') || c.has('requisitions') || c.has('state'))) return;
    const job = ctx.job;
    if (view.mode === 'detail') { refreshDetail(ctx); return; }
    const jobId = job ? job.id : null;
    if (jobId !== view.jobId || (view.mode === 'empty' && job && ctx.sel.agentsOf(ctx.store, job.id).length)) {
      const box = view.container;
      if (view.rlTimer) clearInterval(view.rlTimer);
      view = null;
      clear(box);
      render(box, ctx);
      return;
    }
    if (view.mode === 'list') refreshList(ctx);
  },
  dispose() {
    if (view) {
      if (view.detail) view.detail.log.stop();
      if (view.rlTimer) clearInterval(view.rlTimer);
      if (view.modelsSub) view.modelsSub.dispose();
      if (view.toolsSub) view.toolsSub.dispose();
    }
    view = null;
  },
};
