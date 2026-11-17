// Blueprint panel: the plan of the job on the floor (contract section 13b).
// Requirement ledger with source and status (Add requirement, Waive), assumptions (defaults taken are marked), dropped plan items,
// decisions in force, plan notes, setup and check commands, tasks grouped by status (Cancel on each row), Approve plan.
// Pause (running turns finish) and Pause now (running turns stop), Resume, Cancel job.
// Owner questions are answered in the Inbox (and on the Board and in the Truck panel); this panel points there.

import { h, mount, keyed } from '../lib/dom.js';
import * as ui from '../lib/widgets.js';
import { markdown } from '../lib/md.js';
import { confirmCancel, runCancel } from '../lib/jobs.js';

const GROUPS = [
  { id: 'attention', title: 'Needs attention', statuses: ['blocked', 'failed'] },
  { id: 'progress', title: 'In progress', statuses: ['working', 'rework', 'checking', 'buddy', 'review', 'integrating'] },
  { id: 'ready', title: 'Ready', statuses: ['ready'] },
  { id: 'planned', title: 'Planned', statuses: ['planned'] },
  { id: 'merged', title: 'Merged', statuses: ['merged'] },
  { id: 'cancelled', title: 'Cancelled', statuses: ['cancelled'] },
];
const GROUP_OF = Object.fromEntries(GROUPS.flatMap((g) => g.statuses.map((s) => [s, g.id])));
const fmt = ui.fmt;
const enc = encodeURIComponent;
const isOpenTask = (t) => !['merged', 'cancelled'].includes(t.status);

// What the owner opened or typed stays put while the drawer is closed.
const keep = { expanded: new Set(), closed: new Set(), briefOpen: false };
let view = null;

/** Rebuild a part only when its signature changed. */
function part(node, sig, build) {
  if (node.__sig === sig) return;
  node.__sig = sig;
  mount(node, build());
}

function render(container, ctx) {
  view = {
    jobId: null,
    banner: h('div'), head: h('div.bp-head'), headTitle: h('div'), headInfo: h('div'), headActions: h('div'), empty: h('div'),
    questions: h('div'), brief: h('div'), reqs: h('div'), assume: h('div'), cmds: h('div'), tasks: h('div'), report: h('div'),
    groups: new Map(), bars: new Map(),
  };
  view.head.append(view.headTitle, view.headInfo, view.headActions);
  container.append(view.empty, view.head, view.banner, view.questions, view.brief, view.reqs, view.assume, view.cmds, view.tasks, view.report);
  refresh(ctx);
}

function refresh(ctx) {
  if (!view) return;
  const { store, sel } = ctx;
  const job = ctx.job;
  view.head.hidden = !job;
  if (!job) {
    for (const k of ['headTitle', 'headInfo', 'headActions', 'banner', 'questions', 'brief', 'reqs', 'assume', 'cmds', 'tasks', 'report']) part(view[k], 'none', () => null);
    part(view.empty, 'none', () => ui.emptyState('No blueprint yet', 'A blueprint appears when a work order is on the floor.',
      ui.btn('+ Work order', { tone: 'go', onClick: () => ctx.openPanel('workorder') })));
    view.groups.clear(); view.bars.clear();
    return;
  }
  part(view.empty, 'job', () => null);
  if (view.jobId !== job.id) { view.jobId = job.id; view.groups.clear(); view.bars.clear(); view.tasks.__sig = null; }
  const tasks = sel.tasksOf(store, job.id);
  const counts = sel.taskCounts(store, job.id);
  const project = sel.projectOf(store, job);
  const reqs = Array.isArray(job.requirements) ? job.requirements : [];
  const verified = reqs.filter((r) => r.status === 'verified').length;
  const jobUrl = `/api/jobs/${encodeURIComponent(job.id)}`;
  const post = (verb) => (e) => ui.busy(e.currentTarget, () => ctx.api.post(`${jobUrl}/${verb}`));
  const money = sel.cost(job, fmt.money);

  // ---- head. Three parts, so the buttons are not rebuilt when the cost ticks up.
  const crew = job.crew || {};
  const cost = job.cost || {};
  part(view.headTitle, [job.id, job.title, job.status].join('|'), () =>
    h('div.bp-title', ui.chip(job.id, 'dark'), h('span.grow', String(job.title || '')), ui.statusChip('job', job.status)));
  part(view.headInfo, [job.kind, project && project.name, project && project.targetBranch, project && project.path, crew.bosses, crew.managers, crew.makers,
    money.text, fmt.tokens(cost.inTok), fmt.tokens(cost.outTok), job.budgetUsd, counts.merged, counts.total, verified, reqs.length, job.createdAt].join('|'), () => h('dl.kv',
    h('dt', 'Kind'), h('dd', String(job.kind || '')),
    h('dt', 'Project'), h('dd', project ? [h('span.strong', String(project.name)), ` on ${project.targetBranch || 'main'}`, h('div.dim', String(project.path || ''))] : 'unknown'),
    h('dt', 'Crew'), h('dd', `${fmt.plural(crew.bosses || 0, 'boss', 'bosses')}, ${fmt.plural(crew.managers || 0, 'manager')}, ${fmt.plural(crew.makers || 0, 'maker')}`),
    h('dt', 'Progress'), h('dd', `${counts.merged} of ${counts.total} tasks merged, ${verified} of ${reqs.length} requirements verified`),
    h('dt', 'Cost'), h('dd', { title: money.title }, `${fmt.money(money.billed)} billed${job.budgetUsd != null ? ` of ${fmt.money(job.budgetUsd)} budget` : ''}${money.est > 0 ? ` · about ${fmt.money(money.est)} est. at API prices` : ''} · ${fmt.tokens(cost.inTok)} tokens in, ${fmt.tokens(cost.outTok)} out`),
    h('dt', 'Opened'), h('dd', fmt.date(job.createdAt))));
  // A paused job can still have turns that run to their end (a plain Pause lets them finish). The hub stops them on a second
  // pause with hard:true.
  const busyTurns = job.status === 'paused' && sel.agentsOf(store, job.id).some((a) => ['working', 'thinking', 'reviewing'].includes(a.status));
  part(view.headActions, [job.id, job.status, busyTurns].join('|'), () => h('div.bp-actions',
    sel.isLive(job) ? ui.btn('Pause', { small: true, title: 'No new turn starts. The turns that run now finish first.', onClick: post('pause') }) : null,
    sel.isLive(job) ? ui.btn('Pause now', { small: true, title: 'Pause, and also stop the turns that run now. Their sessions resume later.', onClick: (e) => ui.busy(e.currentTarget, async () => {
      const res = await ctx.api.post(`${jobUrl}/pause`, { hard: true });
      if (res) ctx.toast(`${job.id} is paused and the running turns were stopped. Their sessions go on when you resume.`);
    }) }) : null,
    busyTurns ? ui.btn('Stop running turns', { small: true, title: 'The job is paused, but some turns still run to their end. Stop them now. Their sessions resume later.', onClick: (e) => ui.busy(e.currentTarget, async () => {
      const res = await ctx.api.post(`${jobUrl}/pause`, { hard: true });
      if (res) ctx.toast('The running turns were stopped. Their sessions go on when you resume.');
    }) }) : null,
    job.status === 'paused' ? ui.btn('Resume', { small: true, tone: 'go', onClick: async (e) => {
      const button = e.currentTarget;
      const body = {};
      if (job.pauseReason === 'budget') { // the hub wants a budget above what is already billed
        const v = await ctx.prompt({ title: `Raise the budget of ${job.id}`, label: `New budget in USD (above ${fmt.money(money.billed)})`, value: String(Math.ceil(money.billed + 10)), okLabel: 'Resume' });
        if (v === null) return;
        body.budgetUsd = Number(String(v).replace(/^\$/, ''));
        if (!(body.budgetUsd > money.billed)) { ctx.toast(`The budget must be above ${fmt.money(money.billed)}.`, 'error'); return; }
      }
      ui.busy(button, () => ctx.api.post(`${jobUrl}/resume`, body));
    } }) : null,
    sel.isOpen(job) ? ui.btn('Cancel job', { small: true, onClick: async (e) => {
      const button = e.currentTarget;
      if (await confirmCancel(ctx, job)) runCancel(ctx, job, button);
    } }) : null));

  // ---- banner: what the job waits for
  part(view.banner, [job.status, job.pauseReason, job.error, job.waitReason, tasks.length, job.hold && job.hold.lab, job.hold && job.hold.until].join('|'), () => {
    if (job.status === 'plan_review') {
      return h('div.callout.you',
        h('div.callout-title', 'The plan waits for you'),
        h('p', 'Read the requirements and the tasks below. The makers start when you approve.'),
        ui.btn('Approve plan', { tone: 'go', cls: 'big', onClick: (e) => ui.busy(e.currentTarget, async () => {
          const res = await ctx.api.post(`${jobUrl}/plan/approve`);
          if (res) ctx.toast('Plan approved. The makers start.');
        }) }),
        h('p.dim', { style: { margin: '8px 0 0' } }, 'Want changes first? ', h('button.linkish', { type: 'button', onclick: () => ctx.openPanel('board') }, 'Tell the lead boss on the board'), '.'));
    }
    if (job.status === 'paused' && job.pauseReason && job.pauseReason !== 'owner') { // the hub never ends a job by itself: it pauses and says why
      return h('div.callout.bad', h('div.callout-title', `The hub paused the job: ${sel.pauseWords(job)}`),
        h('p.pre', String(job.error || 'The hub gave no more detail.')), h('p.dim', { style: { margin: '6px 0 0' } }, 'Resume it when the cause is gone, or cancel the job.'));
    }
    if (job.status === 'paused') return h('div.callout', h('div.callout-title', 'Paused by you'), h('p', { style: { margin: 0 } }, 'No new turn starts. Press Resume to go on.'));
    if (job.status === 'queued') { const w = sel.waitsFor(store, job); return h('div.callout', h('div.callout-title', 'Queued'), h('p', { style: { margin: 0 } }, w ? `One job runs at a time. This one starts when ${w.id} is done or cancelled.` : job.waitReason ? `It cannot start yet: ${String(job.waitReason)}` : 'This job starts when the floor is free.')); }
    if (job.hold && (job.hold.lab || job.hold.reason)) return h('div.callout.bad', h('div.callout-title', `On hold: ${job.hold.lab || 'no lab is usable'}`), h('p', { style: { margin: 0 } }, `${String(job.hold.reason || 'The lab is not usable right now.')}${job.hold.until ? ` Work goes on at ${fmt.time(job.hold.until)}.` : ''}`));
    if (job.status === 'planning' && !tasks.length) return h('div.callout', h('div.callout-title', 'Planning'), h('p', { style: { margin: 0 } }, 'The bosses draft the plan. Requirements and tasks show up here when they hand it in.'));
    if (job.status === 'delivering') {
      return h('div.callout.you', h('div.callout-title', 'The truck waits for you'), h('p', 'Every requirement is verified. Look at the load and ship it.'),
        ui.btn('Open truck', { tone: 'primary', onClick: () => ctx.openPanel('truck') }));
    }
    return null;
  });

  // ---- owner questions: answered in the Inbox (and on the Board and in the Truck panel)
  const questions = sel.isOpen(job) ? sel.ownerQuestions(store, job.id) : []; // a finished job asks nothing
  const waiting = questions.filter((q) => !q.defaulted).length;
  part(view.questions, `${waiting}|${questions.length}`, () => (questions.length ? h('div.callout.you',
    h('div.callout-title', waiting ? fmt.plural(waiting, 'question waits', 'questions wait') + ' for you' : 'The hub took a default for you'),
    h('p', waiting ? 'A boss needs a decision. The crew works on what does not depend on it.' : 'You can still overturn it.'),
    ui.btn(waiting ? 'Answer in the Inbox' : 'Look at it in the Inbox', { tone: 'primary', small: true, onClick: () => ctx.openPanel('inbox') })) : null));

  // ---- brief
  part(view.brief, [job.brief, keep.briefOpen].join('|'), () => {
    const text = String(job.brief || '');
    if (!text) return null;
    const long = text.length > 420 || text.split('\n').length > 5;
    return ui.section('Brief',
      h('p', { class: ['pre', 'bp-brief', (keep.briefOpen || !long) && 'open'] }, text),
      long ? h('button.linkish', { type: 'button', onclick: () => { keep.briefOpen = !keep.briefOpen; refresh(ctx); } }, keep.briefOpen ? 'Show less' : 'Show all') : null);
  });

  // ---- requirement ledger
  const reqTasks = new Map();
  for (const t of tasks) for (const r of t.reqs || []) { if (!reqTasks.has(r)) reqTasks.set(r, []); reqTasks.get(r).push(t.id); }
  // The hub takes a new requirement (and a waiver) from the plan review on, and only when the plan made a ledger.
  const canAdd = sel.isOpen(job) && !['planning', 'queued'].includes(job.status) && reqs.length > 0;
  part(view.reqs, `${reqs.length ? 'some' : 'none'}|${canAdd}`, () => (reqs.length || canAdd ? ui.section(['Requirements', h('span.count')], h('ul.list'),
    canAdd ? h('div.row', { style: { marginTop: '8px' } }, ui.btn('Add requirement', { small: true, onClick: async (e) => {
      const button = e.currentTarget;
      const text = await ctx.prompt({ title: 'Add a requirement', label: 'What must be true when the job is done?', multiline: true, okLabel: 'Add' });
      if (text) ui.busy(button, async () => { const r = await ctx.api.post(`${jobUrl}/reqs`, { text }); if (r) ctx.toast(`Requirement ${r.id || ''} added. The lead boss plans a task for it.`.replace('  ', ' ')); });
    } }), h('span.dim', 'Only you can waive a requirement.')) : null) : null));
  if (reqs.length || canAdd) {
    view.reqs.querySelector('.count').textContent = `${verified} of ${reqs.length} verified`;
    keyed(view.reqs.querySelector('.list'), reqs, {
      key: (r) => r.id,
      sig: (r) => [r.text, r.status, r.source, r.evidence, r.waivedReason, (reqTasks.get(r.id) || []).join(), canAdd].join('|'),
      render: (r) => h('li', { class: ['li', 'bp-req', r.status === 'failed' && 'is-failed'] },
        h('span.bp-req-id', r.id),
        h('span', String(r.text || ''), r.source && r.source !== 'plan' ? h('span.bp-req-tasks', `added by ${r.source === 'owner' ? 'you' : 'a boss'}`) : null,
          reqTasks.has(r.id) ? h('span.bp-req-tasks', reqTasks.get(r.id).join(' ')) : h('span.bp-req-tasks', 'no task')),
        h('span.bp-req-side', ui.statusChip('req', r.status),
          canAdd && r.status !== 'waived' && r.status !== 'verified' ? h('button.linkish.bp-waive', { type: 'button', title: `Waive ${r.id}: the job can end without it`, onclick: async (e) => {
            const button = e.currentTarget;
            const reason = await ctx.prompt({ title: `Waive ${r.id}?`, label: 'Why is this requirement not needed?', multiline: true, okLabel: 'Waive' });
            if (reason) ui.busy(button, async () => { const res = await ctx.api.post(`${jobUrl}/reqs/${enc(r.id)}/waive`, { reason }); if (res) { ctx.store.refreshInbox(); ctx.toast(`${r.id} is waived.`); } });
          } }, 'Waive') : null),
        r.evidence ? h('div.bp-req-ev', String(r.evidence)) : null,
        r.waivedReason ? h('div.bp-req-ev', 'Waived: ', String(r.waivedReason)) : null),
    });
  }

  // ---- assumptions (defaults taken are marked), dropped plan items, decisions in force, plan notes
  const assumptions = (Array.isArray(job.assumptions) ? job.assumptions : []).map((a) => (a && typeof a === 'object' ? a : { text: String(a), msgId: null }));
  const dropped = Array.isArray(job.dropped) ? job.dropped : [];
  const decisions = store.board.filter((m) => m.kind === 'DECIDE' && (!m.jobId || m.jobId === job.id));
  part(view.assume, [assumptions.map((a) => `${a.text}#${a.msgId}`).join('\u0001'), dropped.map((d) => `${d.draft}${d.n}${d.why}`).join('\u0001'), decisions.map((m) => m.id).join(), job.notes].join('|'), () => [
    assumptions.length ? ui.section('Assumptions', h('ul.list', assumptions.map((a) => h('li.li', String(a.text ?? ''),
      a.msgId != null ? [' ', ui.chip('default taken', 'steel', { title: `The hub took the default answer of question #${a.msgId}. You can overturn it on the board.` })] : null)))) : null,
    decisions.length ? ui.section('Decisions in force', h('ul.list', decisions.map((m) => h('li.li', h('span.dim', `#${m.id} ${sel.who(store, m.from, m.fromId)} ${m.scope || ''}: `), String(m.body ?? ''))))) : null,
    dropped.length ? ui.section('Dropped from the plan drafts', h('ul.list', dropped.map((d) => h('li.li', h('span.dim', `${d.draft || 'A draft'}, item ${d.n ?? '?'}: `), String(d.why ?? ''))))) : null,
    job.notes ? ui.section('Plan notes', h('p.pre', String(job.notes))) : null,
  ]);

  // ---- setup and check commands
  part(view.cmds, project ? [project.setupCmd, project.checkCmd, project.noCheckReason, project.baseline && project.baseline.ok, project.baseline && project.baseline.flaky].join('|') : 'none', () => {
    if (!project || (!project.setupCmd && !project.checkCmd && !project.noCheckReason)) return null;
    const base = project.baseline;
    return ui.section('Setup and check', h('dl.kv',
      h('dt', 'Setup'), h('dd', project.setupCmd ? h('span.code', String(project.setupCmd)) : 'none'),
      h('dt', 'Check'), h('dd', project.checkCmd ? h('span.code', String(project.checkCmd)) : [ui.chip('not checked', 'red'), ' ', String(project.noCheckReason || 'The plan has no check command. No crate is checked.')]),
      base ? [h('dt', 'Baseline'), h('dd', ui.chip(base.ok ? (base.flaky ? 'flaky' : 'green') : 'red', base.ok && !base.flaky ? 'green' : 'red'), ` the check on the project before any work${base.ms ? ` (${Math.round(base.ms / 100) / 10} s)` : ''}`)] : null));
  });

  // ---- tasks, grouped by status
  part(view.tasks, tasks.length ? 'some' : 'none', () => (tasks.length ? ui.section(['Tasks', h('span.count')], h('div.bp-groups')) : null));
  if (tasks.length) {
    view.tasks.querySelector('.count').textContent = `${counts.merged} of ${counts.total} merged`;
    const byGroup = new Map(GROUPS.map((g) => [g.id, []]));
    for (const t of tasks) (byGroup.get(GROUP_OF[t.status]) || byGroup.get('planned')).push(t);
    const shown = GROUPS.filter((g) => byGroup.get(g.id).length);
    keyed(view.tasks.querySelector('.bp-groups'), shown, { key: (g) => g.id, sig: (g) => g.id, render: (g) => groupNode(ctx, g) });
    for (const g of shown) {
      const node = view.groups.get(g.id);
      const list = byGroup.get(g.id);
      node.classList.toggle('open', !keep.closed.has(g.id));
      node.querySelector('.bp-group-head').setAttribute('aria-expanded', String(!keep.closed.has(g.id)));
      node.querySelector('.count').textContent = String(list.length);
      keyed(node.querySelector('.bp-tasks'), list, { key: (t) => t.id, sig: (t) => taskSig(store, t), render: (t) => taskNode(ctx, t) });
    }
    // Progress moves every second. Move the bar, do not rebuild the row (a rebuilt row would eat a click on "More").
    for (const t of tasks) {
      const b = view.bars.get(t.id);
      if (!b) continue;
      const pct = Math.round(Math.max(0, Math.min(1, Number(t.progress) || 0)) * 100);
      if (b.pct !== pct) { b.pct = pct; b.fill.style.width = pct + '%'; b.label.textContent = pct + '%'; b.bar.setAttribute('aria-valuenow', pct); }
    }
    if (view.bars.size > tasks.length + 20) for (const id of [...view.bars.keys()]) if (!store.get('tasks', id)) view.bars.delete(id);
  }

  // ---- report
  part(view.report, String(job.report || ''), () => (job.report ? ui.section('Report', h('div.bp-report', markdown(job.report))) : null));
}

function groupNode(ctx, g) {
  const node = h('div.bp-group',
    h('button.bp-group-head', { type: 'button', onclick: () => { if (keep.closed.has(g.id)) keep.closed.delete(g.id); else keep.closed.add(g.id); refresh(ctx); } },
      h('span.bp-caret', { 'aria-hidden': 'true' }), g.title, h('span.count')),
    h('div.bp-tasks'));
  view.groups.set(g.id, node);
  return node;
}

function taskSig(store, t) {
  const a = t.assigneeId ? store.get('agents', t.assigneeId) : null;
  const deps = (t.deps || []).map((d) => { const x = store.get('tasks', d); return d + (x && x.status === 'merged' ? '+' : '-'); }).join();
  return [t.title, t.status, t.why, t.size, t.domain, t.attempts, t.retries, t.pair, !!t.hold, a ? a.name + a.status : '', (t.zones || []).join(), deps, (t.cardChanges || []).length,
    keep.expanded.has(t.id) ? [t.spec, (t.acceptance || []).join(), (t.reqs || []).join(), (t.claims || []).join(), (t.pendingClaims || []).join(), t.summary, t.note, t.lastError, t.cost && t.cost.usd, t.reviewerId, t.buddyId].join('\u0001') : ''].join('|');
}

/** Progress bar of a task in work. refresh() moves it in place through view.bars. */
function progress(t) {
  const bar = ui.bar(t.progress);
  const pct = Number(bar.getAttribute('aria-valuenow'));
  const label = h('span.dim', pct + '%');
  view.bars.set(t.id, { bar, fill: bar.firstChild, label, pct });
  return [bar, label];
}

/**
 * Cancel one task (POST /api/tasks/:id/cancel { reason, replacedBy? }).
 * The hub refuses to cancel a task that open tasks wait for, unless the owner names the tasks that replace it.
 * So the dialog lists those tasks and asks for the replacements; the button stays off until one is picked.
 */
function cancelTask(ctx, t) {
  const { store, sel } = ctx;
  const tasks = sel.tasksOf(store, t.jobId);
  const dependents = tasks.filter((x) => isOpenTask(x) && (x.deps || []).includes(t.id));
  // every task that waits for this one, directly or through another task: none of them can stand in for it
  const down = new Set([t.id]);
  for (let grew = true; grew;) { grew = false; for (const x of tasks) if (!down.has(x.id) && (x.deps || []).some((d) => down.has(d))) { down.add(x.id); grew = true; } }
  const candidates = dependents.length ? tasks.filter((x) => isOpenTask(x) && !down.has(x.id)) : [];
  const names = dependents.map((x) => x.id).join(', ');
  const picked = new Set();
  let dlg = null;
  const sync = () => { if (dlg) dlg.buttons[1].disabled = dependents.length > 0 && picked.size === 0; };

  const reason = h('textarea', { rows: 3, placeholder: 'Example: The owner does not want photo upload.' });
  const fReason = ui.field('Why? The crew reads this.', reason);
  reason.addEventListener('input', () => fReason.setError(''));
  const replace = dependents.length ? h('div.callout.bp-replace',
    h('div.callout-title', `${names} ${dependents.length === 1 ? 'waits' : 'wait'} for ${t.id}`),
    h('p', `The hub cancels ${t.id} only when you name the tasks that replace it. ${names} then ${dependents.length === 1 ? 'waits' : 'wait'} for those tasks.`),
    candidates.length
      ? ui.group('Tasks that replace it (pick one or more)', h('div.bp-picks', candidates.map((x) => ui.checkbox(`${x.id} ${x.title} (${String(x.status).replace(/_/g, ' ')})`, false, (v) => { if (v) picked.add(x.id); else picked.delete(x.id); sync(); }))))
      : h('p.strong', `No other open task can replace it: every open task waits for ${t.id}. Ask the lead boss for a new task first (Truck: Request changes), or cancel ${names} first.`)) : null;

  dlg = ctx.modal({
    title: `Cancel ${t.id}?`,
    body: h('div', h('p', h('span.strong', t.id), ' ', String(t.title || ''), ' ', ui.statusChip('task', t.status)), fReason, replace),
    buttons: [{ label: 'Keep it', value: false }, { label: 'Cancel the task', primary: true, tone: 'danger', disabled: dependents.length > 0, run: async () => {
      const why = reason.value.trim();
      if (!why) { fReason.setError('Say why. The crew reads this.'); reason.focus(); return false; }
      const body = { reason: why };
      if (picked.size) body.replacedBy = [...picked];
      const res = await ctx.api.post(`/api/tasks/${enc(t.id)}/cancel`, body);
      if (!res) return false;
      ctx.toast(`${t.id} is cancelled.${picked.size ? ` ${names} now ${dependents.length === 1 ? 'waits' : 'wait'} for ${[...picked].join(', ')}.` : ''}`);
      return true;
    } }],
  });
}

function taskNode(ctx, t) {
  const { store } = ctx;
  const maker = t.assigneeId ? store.get('agents', t.assigneeId) : null;
  const zones = t.zones || [];
  const deps = t.deps || [];
  const openNow = keep.expanded.has(t.id);
  const active = ['working', 'rework'].includes(t.status);
  if (!active) view.bars.delete(t.id);
  const who = (id, role) => { const a = id ? store.get('agents', id) : null; return a ? h('span.bp-maker', ui.faceEl(a, ctx.avatar(a, 1), 1), `${a.name} (${role})`) : null; };
  return h('div.bp-task',
    h('div.bp-task-top',
      h('span.bp-task-id', t.id),
      h('span.bp-task-title', String(t.title || '')),
      ui.statusChip('task', t.status)),
    h('div.bp-task-meta',
      ui.chip(String(t.size || '?'), 'plain', { class: ['chip', 't-plain', 'bp-size'], title: 'Size' }),
      ui.domainChip(t.domain),
      maker ? h('span.bp-maker', { title: `${maker.modelLabel || maker.model || ''}, ${maker.status}` }, ui.faceEl(maker, ctx.avatar(maker, 1), 1), maker.name) : h('span.dim', 'no maker yet'),
      t.status === 'blocked' && t.why ? ui.chip(`why: ${t.why}`, 'red', { title: 'Why the task is blocked' }) : null,
      t.hold ? ui.chip('on hold', 'brick', { title: `The lab ${t.hold.provider || ''} is not usable right now.` }) : null,
      t.attempts > 0 ? ui.chip(`rework ${t.attempts}`, 'brick', { title: 'Times the work came back from a check or a review' }) : null,
      t.pair ? ui.chip('buddy check', 'plain') : null,
      (t.cardChanges || []).length ? ui.chip('card changed', 'amber', { title: 'A boss changed the task card after the start' }) : null,
      active ? progress(t) : null,
      h('span.bp-links',
        h('button.linkish', { type: 'button', 'aria-expanded': String(openNow), onclick: () => { if (openNow) keep.expanded.delete(t.id); else keep.expanded.add(t.id); refresh(ctx); } }, openNow ? 'Less' : 'More'),
        isOpenTask(t) ? h('button.linkish', { type: 'button', title: `Cancel ${t.id}`, onclick: () => cancelTask(ctx, t) }, 'Cancel') : null)),
    h('div.bp-task-zones',
      'Zones: ', zones.length ? zones.slice(0, 4).map((z, i) => [i ? ', ' : '', h('span.code', String(z))]) : 'none', zones.length > 4 ? ` +${zones.length - 4} more` : '',
      deps.length ? [' · After: ', deps.map((d, i) => { const x = store.get('tasks', d); return [i ? ', ' : '', h('span', { class: x && x.status === 'merged' ? 'dim' : 'strong', title: x ? `${x.title} (${x.status})` : '' }, d)]; })] : ''),
    openNow ? h('div.bp-task-more',
      h('h4', 'Spec'), h('p.pre', String(t.spec || 'none')),
      h('h4', 'Acceptance'), (t.acceptance || []).length ? h('ul', t.acceptance.map((a) => h('li', String(a)))) : h('p', 'none'),
      zones.length > 4 ? [h('h4', 'All zones'), h('p', zones.map((z, i) => [i ? ', ' : '', h('span.code', String(z))]))] : null,
      (t.claims || []).length ? [h('h4', 'Claims outside the zone'), h('p', t.claims.map((z, i) => [i ? ', ' : '', h('span.code', String(z))]))] : null,
      (t.pendingClaims || []).length ? [h('h4', 'Claims that wait for another task'), h('p', t.pendingClaims.map((z, i) => [i ? ', ' : '', h('span.code', String(z))]))] : null,
      (t.cardChanges || []).length ? [h('h4', 'Card changes'), h('ul', t.cardChanges.map((c) => h('li', `${c.by || 'A boss'}: ${c.what || ''}${c.ts ? ` (${fmt.date(c.ts)})` : ''}`)))] : null,
      h('h4', 'Details'),
      h('p', `Requirements: ${(t.reqs || []).join(', ') || 'none'} · Stream ${t.stream ?? 'none'} · Cost ${fmt.money(t.cost && t.cost.usd)}${t.retries ? ` · Retries ${t.retries}` : ''}`),
      t.reviewerId || t.buddyId ? h('p.row', who(t.reviewerId, 'reviewer'), who(t.buddyId, 'buddy')) : null,
      t.summary ? [h('h4', 'Hand-in summary'), h('p.pre', String(t.summary))] : null,
      t.note ? [h('h4', 'Note'), h('p.pre', String(t.note))] : null,
      t.lastError ? [h('h4', 'Last error'), h('p.pre', String(t.lastError))] : null) : null);
}

export default {
  id: 'blueprint',
  title: 'Blueprint',
  badge: ({ store, sel }) => sel.ownerAttention(store).panels.blueprint,
  attention: ({ store, sel }) => sel.ownerAttention(store).panels.blueprint > 0,
  render,
  update(ctx) {
    const c = ctx.changes;
    if (c.has('jobs') || c.has('tasks') || c.has('agents') || c.has('board') || c.has('inbox') || c.has('projects') || c.has('state')) refresh(ctx);
  },
  dispose() { view = null; },
};
