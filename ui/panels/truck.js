// Truck panel (contract sections 6, 12 and 13b): the reviewed work that waits for the owner.
// Loaded crates with task, maker, reviewer verdict and notes, buddy verdict, acc, check result (or NOT CHECKED), file stat and flags.
// Expand one crate or the whole load to see files; click a file for a colored unified diff. The report, or "n requirements not verified".
// Pinned owner questions. Approve & ship all (the head the panel shows), Ship up to here (that crate's merge commit), Request changes,
// Open the cargo in Finder. A cancelled job with a loaded truck: Ship loaded crates, or Discard. Every ship asks first.
//
// Which truck: every job has its own. The panel shows the job that the link names (?panel=truck&job=J1), else a job whose
// truck waits for the owner (the job on the floor first), else the job on the floor. So the reviewed crates of a cancelled
// job stay in reach while a newer job runs. When more than one job is in play, the head holds a job switch.
// Crate order: the order in which the hub merged the crates (sel.loadedDeliveries), never the order of the hub's answer.
// Deep link: ?panel=truck&file=<path> opens the diff of one file of the whole load.

import { h, mount, keyed, clear, hasMarks } from '../lib/dom.js';
import * as ui from '../lib/widgets.js';
import { diffView, diffBody, diffSlot as loadDiff, marksChip } from '../lib/diff.js';
import { markdown } from '../lib/md.js';
import { syncQuestions } from '../lib/questions.js';

const fmt = ui.fmt;
const enc = encodeURIComponent;
const SHIP_STATES = new Set(['running', 'qa', 'delivering', 'paused', 'cancelled']); // a loaded crate can ship in these job states (section 12)

// What the owner opened stays while the drawer is closed (per job).
const keep = { jobId: null, loadFiles: false, loadDiff: false, loadOpen: new Set(), crates: new Map(), reportOpen: true };
const crateKeep = (id) => { let k = keep.crates.get(id); if (!k) keep.crates.set(id, (k = { files: false, diff: false, open: new Set() })); return k; };
let view = null;

/** Rebuild a part only when its signature changed. */
function part(node, sig, build) {
  if (node.__sig === sig) return;
  node.__sig = sig;
  mount(node, build());
}

// ------------------------------------------------------------------ data

/** Everything in the store that can change what the truck shows. When it changes, the truck is fetched again. */
function storeSig(ctx, job) {
  if (!job) return 'none';
  const { store, sel } = ctx;
  return [job.id, job.status, job.intSha, !!job.report, sel.loadedDeliveries(store, job.id).map((d) => d.id).join(),
    (job.requirements || []).map((r) => r.status[0]).join('')].join('|');
}

/** The job whose truck the panel shows when it opens: the one the link names, else a truck that waits for the owner, else the floor. */
function pickJob(ctx) {
  const named = ctx.params.job != null ? ctx.store.get('jobs', String(ctx.params.job)) : null;
  return named || ctx.sel.truckJob(ctx.store);
}
/** The job that shows now. It stays while the panel is open: a truck that was just shipped or discarded must not jump away. */
const shownJob = (ctx) => (view && view.jobId ? ctx.store.get('jobs', view.jobId) : null);

/**
 * The jobs the owner can look at here: the one that shows, the one on the floor, and every job whose truck holds crates.
 * -> [{ job, n, waits }] by job number. One entry means: no switch.
 */
function truckChoices(ctx, job) {
  const { store, sel } = ctx;
  const trucks = sel.trucks(store);
  const list = [];
  const add = (j) => { if (!j || list.some((x) => x.job.id === j.id)) return; const t = trucks.find((x) => x.job.id === j.id); list.push({ job: j, n: t ? t.n : 0, waits: !!t && t.waits }); };
  add(job); add(ctx.job);
  for (const t of trucks) add(t.job);
  return list.sort((a, b) => (Number(String(a.job.id).replace(/^\D+/, '')) || 0) - (Number(String(b.job.id).replace(/^\D+/, '')) || 0));
}

async function load(ctx) {
  const job = shownJob(ctx);
  if (!view || !job) return;
  const sig = storeSig(ctx, job);
  view.sig = sig;
  view.loading = true;
  // The hub reads git for this answer. A slow answer leaves "loading" up with Ship off; after 30 s it counts as failed (Try again).
  const res = await ctx.api.get(`/api/jobs/${enc(job.id)}/truck`, { quiet: true, throws: true, timeoutMs: 30000 }).catch((e) => ({ failed: (e && e.message) || 'The hub does not answer.' }));
  if (!view || view.sig !== sig) return; // the panel closed, or a newer load is on its way
  view.loading = false;
  if (res.failed) { view.error = res.failed; view.truck = null; } else { view.error = null; view.truck = res; view.stale = false; }
  refresh(ctx);
}

/**
 * Make sure the truck answer is the one of this moment, before a ship dialog names crates and a commit:
 * a crate may have landed since the panel loaded the truck. Resolves to false when the truck did not load.
 */
async function current(ctx) {
  for (let i = 0; i < 3 && view; i++) {
    const job = shownJob(ctx);
    if (!job) return false;
    if (!view.loading && view.truck && view.sig === storeSig(ctx, job)) return true;
    await load(ctx);
  }
  return !!(view && view.truck && !view.loading && !view.error);
}

/** A box that shows a diff as soon as it is there (GET /api/jobs/:id/diff?path=&delivery=). The text is cached: a diff of one crate never changes, the whole load is keyed by its head. */
const diffSlot = (ctx, url, build, key = url) => loadDiff(ctx.api, url, build, key);

// ------------------------------------------------------------------ pieces

/** Five squares: the share of added and deleted lines. */
function shareBar(add, del) {
  const total = add + del;
  const green = total ? Math.max(add ? 1 : 0, Math.min(del ? 4 : 5, Math.round((5 * add) / total))) : 0;
  return h('span.tk-share', { 'aria-hidden': 'true' }, [0, 1, 2, 3, 4].map((i) => h('span', { class: !total ? null : i < green ? 'a' : 'd' })));
}

/**
 * A list of changed files. A click on a row opens the colored diff of that file under it.
 *   urlFor(path) -> the diff URL. open: Set of paths that are open (kept across rebuilds). tag: makes the cache key (a load changes with its head).
 */
function fileList(ctx, files, { urlFor, open, focus, tag = '' }) {
  const list = h('ul.tk-files');
  for (const f of files) {
    const path = String(f.path);
    const slot = h('div.tk-fileslot', { hidden: true });
    let built = false;
    const head = h('button.tk-file', { type: 'button', 'aria-expanded': 'false', title: path },
      h('span.caret', { 'aria-hidden': 'true' }), h('span.tk-path', path), hasMarks(path) ? marksChip() : null, ui.stat(Number(f.add) || 0, Number(f.del) || 0), shareBar(Number(f.add) || 0, Number(f.del) || 0));
    const li = h('li', { dataset: { path } }, head, slot);
    const set = (v) => {
      if (v && !built) { built = true; slot.append(diffSlot(ctx, urlFor(path), (text) => diffBody(text), urlFor(path) + tag)); }
      slot.hidden = !v;
      li.classList.toggle('open', v);
      head.setAttribute('aria-expanded', String(v));
      if (v) open.add(path); else open.delete(path);
    };
    head.addEventListener('click', () => set(slot.hidden));
    if (open.has(path)) set(true);
    if (focus === path) requestAnimationFrame(() => { if (li.isConnected) li.scrollIntoView({ block: 'start' }); });
    list.append(li);
  }
  if (!files.length) list.append(h('li.dim', 'No file changed.'));
  return list;
}

const who = (ctx, id) => {
  const a = id ? ctx.store.get('agents', id) : null;
  if (a) return h('span.tk-who', ui.faceEl(a, ctx.avatar(a, 2)), h('span.strong', a.name), ui.labChip(a.provider, a.modelLabel || a.model || a.provider));
  return id === ctx.sel.OWNER ? h('span.strong', 'you') : h('span.dim', id ? String(id) : 'nobody'); // the owner gives the verdict when the reviewers are used up
};

function checkChip(ctx, check, project) {
  if (!check) return ui.chip('not checked', 'red', { title: project && project.noCheckReason ? `The project has no check: ${project.noCheckReason}` : 'The project has no check command, so nothing ran on this work.' });
  return ui.chip(check.ok ? 'check ok' : 'check failed', check.ok ? 'green' : 'red', { title: check.cmd ? `Check: ${check.cmd}` : 'The check command of the project' });
}

function flagChips(d, task) {
  const f = d.flags || {};
  const out = [];
  const list = (v) => (Array.isArray(v) ? v.map(String) : []);
  if (f.empty) out.push(ui.chip('empty hand-in', 'red', { title: 'The maker handed in twice with no change in the bench.' }));
  if (Number(f.testsDeleted) > 0) out.push(ui.chip(`${fmt.plural(Number(f.testsDeleted), 'test file')} deleted`, 'amber', { title: 'This work deletes tests. Look at the diff.' }));
  if (list(f.checkFiles).length) out.push(ui.chip(`check files changed: ${fmt.clip(list(f.checkFiles).join(', '), 60)}`, 'amber', { title: `This work changes what the check runs: ${list(f.checkFiles).join(', ')}` }));
  if (list(f.claimed).length) out.push(ui.chip(`claimed: ${fmt.clip(list(f.claimed).join(', '), 60)}`, 'plain', { title: `Paths outside the zone of the task, granted by claim: ${list(f.claimed).join(', ')}` }));
  const changes = (task && Array.isArray(task.cardChanges) ? task.cardChanges : []).map((c) => `${c.by || 'A boss'}: ${c.what || ''}`);
  if (list(f.cardChanged).length || changes.length) out.push(ui.chip(`card changed${list(f.cardChanged).length ? ': ' + list(f.cardChanged).join(', ') : ''}`, 'amber', { title: changes.join('\n') || 'A boss changed the task card after the work started.' }));
  if (d.squashed === true) out.push(ui.chip('history squashed', 'plain', { title: 'The hub refused an earlier hand-in of this work. So it joined all the commits of the bench into one commit. The work is the same; only the list of small steps is gone.' }));
  if (d.review && d.review.crossLab === false) out.push(ui.chip('same-lab review', 'amber', { title: 'The reviewer runs on the same lab as the maker. No other lab was free.' }));
  return out;
}

const verdictChip = (v) => ui.chip(v === 'pass' ? 'pass' : v === 'changes' ? 'changes' : String(v || '?'), v === 'pass' ? 'green' : 'brick');

function crateSig(ctx, d, i, total, canShip) {
  const { store } = ctx;
  const t = store.get('tasks', d.taskId), m = store.get('agents', d.makerId), r = store.get('agents', d.review ? d.review.by : d.reviewerId), b = d.buddy ? store.get('agents', d.buddy.by) : null;
  return JSON.stringify([d.id, d.status, d.mergeSha, d.attempt, d.summary, d.acc, d.tests, d.stat, d.check && [d.check.ok, d.check.cmd], d.flags, d.squashed === true, d.buddy, d.review, (d.files || []).length,
    i, total, canShip, t && [t.title, t.domain, t.size, (t.cardChanges || []).length], m && [m.name, m.modelLabel], r && r.name, b && b.name, !!(m && ctx.avatar(m, 2))]);
}

function crateNode(ctx, job, d, i, total, canShip) {
  const { store } = ctx;
  const k = crateKeep(d.id);
  const task = store.get('tasks', d.taskId);
  const project = ctx.sel.projectOf(store, job);
  const files = Array.isArray(d.files) ? d.files : [];
  const stat = d.stat || { files: files.length, add: 0, del: 0 };
  const review = d.review || null;
  const url = (path) => `/api/jobs/${enc(job.id)}/diff?delivery=${enc(d.id)}${path ? `&path=${enc(path)}` : ''}`;

  const filesBox = h('div.tk-box', { hidden: true });
  const diffBox = h('div.tk-box', { hidden: true });
  let filesBuilt = false, diffBuilt = false;
  const bFiles = ui.btn(`Files (${stat.files ?? files.length})`, { small: true, 'aria-expanded': 'false', title: 'The files this crate changes. Click a file for its diff.', onClick: () => { k.files = !k.files; show(); } });
  const bDiff = ui.btn('Diff', { small: true, 'aria-expanded': 'false', title: 'The whole diff of this crate', onClick: () => { k.diff = !k.diff; show(); } });
  function show() {
    if (k.files && !filesBuilt) { filesBuilt = true; filesBox.append(fileList(ctx, files, { urlFor: url, open: k.open })); }
    if (k.diff && !diffBuilt) { diffBuilt = true; diffBox.append(diffSlot(ctx, url(null), (text) => diffView(text))); }
    filesBox.hidden = !k.files; diffBox.hidden = !k.diff;
    bFiles.setAttribute('aria-expanded', String(k.files)); bDiff.setAttribute('aria-expanded', String(k.diff));
    bFiles.classList.toggle('is-on', k.files); bDiff.classList.toggle('is-on', k.diff);
  }
  show();

  const acc = d.acc && Number.isFinite(Number(d.acc.total)) ? d.acc : null;
  const check = d.check || null;
  return h('article.tk-crate', { dataset: { id: d.id }, 'aria-label': `Crate ${i + 1}: ${d.taskId}` },
    h('header.tk-crate-head',
      h('span.tk-no', { title: `Crate ${i + 1} of ${total}, in load order` }, String(i + 1)),
      h('span.tk-task', h('span.strong', String(d.taskId)), ' ', String((task && task.title) || 'task')),
      task && task.size ? ui.chip(String(task.size), 'plain', { title: 'Size' }) : null,
      task ? ui.domainChip(task.domain) : null),
    h('div.tk-line',
      h('span.tk-lbl', 'Made by'), who(ctx, d.makerId),
      Number(d.attempt) > 1 ? ui.chip(`try ${d.attempt}`, 'brick', { title: 'Earlier hand-ins of this task were sent back.' }) : null),
    h('div.tk-line',
      h('span.tk-lbl', 'Review'),
      review ? [verdictChip(review.verdict), who(ctx, review.by)] : h('span.dim', 'no verdict on record')),
    review && review.notes ? h('p.tk-notes', String(review.notes)) : null,
    review && Array.isArray(review.mustFix) && review.mustFix.length ? h('ol.tk-fix', review.mustFix.map((x) => h('li', String(x)))) : null,
    d.buddy ? [h('div.tk-line', h('span.tk-lbl', 'Buddy'), verdictChip(d.buddy.verdict), who(ctx, d.buddy.by)), d.buddy.notes ? h('p.tk-notes', String(d.buddy.notes)) : null] : null,
    h('div.tk-facts',
      acc ? ui.chip(`acc ${acc.met}/${acc.total}`, Number(acc.met) >= Number(acc.total) ? 'green' : 'amber', { title: 'Acceptance items the maker says are met' }) : null,
      h('span', { title: 'Tests the maker ran, as stated in the hand-in' }, `tests ${d.tests || 'none'}`),
      checkChip(ctx, check, project),
      h('span', fmt.plural(Number(stat.files) || 0, 'file'), ' ', ui.stat(Number(stat.add) || 0, Number(stat.del) || 0)),
      d.mergeSha ? h('span.dim', 'merge ', ui.sha(d.mergeSha)) : null),
    flagChips(d, task).length ? h('div.tk-flags', flagChips(d, task)) : null,
    d.summary ? h('p.tk-summary', String(d.summary)) : null,
    check && check.tail ? ui.fold('Output of the check', () => h('pre.term.tk-tail', check.cmd ? `$ ${check.cmd}\n` : '', String(check.tail))) : null,
    h('div.tk-acts',
      bFiles, bDiff,
      canShip && i < total - 1 ? ui.btn('Ship up to here', { small: true, tone: 'go', title: `Ship crates 1 to ${i + 1}: every crate the hub merged up to this one. The crates after it stay on the truck.`, onClick: (e) => shipUpTo(ctx, job, d, e.currentTarget) }) : null,
      ctx.sel.isOpen(job) ? ui.btn('Request changes', { small: true, onClick: (e) => requestChanges(ctx, job, d, e.currentTarget) }) : null),
    filesBox, diffBox);
}

// ------------------------------------------------------------------ actions

function shipText(job, project, crates, sha, truck) {
  const branch = (project && project.targetBranch) || 'the target branch';
  const open = truck && truck.reqs ? (Number(truck.reqs.open) || 0) + (Number(truck.reqs.failed) || 0) : 0;
  return [
    `${branch} moves forward to commit ${fmt.sha(sha)}. Nothing is forced.`,
    `Crates: ${crates.map((d) => d.taskId).join(', ')}.`,
    open ? `${fmt.plural(open, 'requirement is', 'requirements are')} not verified yet.` : null,
    'A shipped crate cannot come back from here.',
  ].filter(Boolean).join('\n');
}

/**
 * Ask, then ship one exact commit. pick(list) -> { sha, crates, title } | null, where list is what a ship can take now:
 * the crates of a truck answer that was loaded for this dialog, in load order. So the dialog never names a crate that the
 * commit does not hold (a crate can land between the last load of the panel and the click).
 */
async function ship(ctx, job, button, pick) {
  if (!view || view.shipping) return;
  const mine = view;
  mine.shipping = true; // one ship at a time: from the click, through the dialog, to the answer of the hub
  try {
    const ok = await ui.busy(button, () => current(ctx));
    if (view !== mine || ok === undefined) return;
    if (!ok) { ctx.toast('The truck did not load, so nothing was shipped. Try again.', 'warn'); return; }
    const plan = pick(shipList(ctx, job));
    if (!plan || !plan.sha || !plan.crates.length) { ctx.toast('That crate is not on the truck any more. Look at the truck again.', 'warn'); return; }
    const { sha, crates } = plan;
    const project = ctx.sel.projectOf(ctx.store, job);
    // A ship cannot be undone: the focus starts on "Not yet", so Enter never ships by habit.
    const yes = await ctx.confirm({ title: plan.title, text: shipText(job, project, crates, sha, mine.truck), okLabel: 'Approve & ship', cancelLabel: 'Not yet', focusCancel: true });
    if (!yes || view !== mine) return;
    const res = await ui.busy(button, () => ctx.api.post(`/api/jobs/${enc(job.id)}/ship`, { sha }));
    if (!res || view !== mine) return;
    if (res.ok === false) { // the hub did not ship (200 { ok:false, reason, moved?, sha?, files? }): nothing moved on your branch
      // moved: the target branch moved, the hub merged it into the load and has a new head. The panel loads it before it offers Ship.
      // files: the merge of the moved branch gives conflicts in these files.
      const moved = res.moved === true || /branch moved/i.test(String(res.reason || ''));
      view.stale = moved;
      const files = Array.isArray(res.files) ? res.files.map(String).filter(Boolean) : [];
      const reason = String(res.reason || 'The hub did not ship. Look at the truck again.');
      if (!moved) ctx.toast(`${reason}${files.length ? ` Files: ${fmt.clip(files.join(', '), 160)}.` : ''}`, 'warn'); // "Your branch moved" comes as an owner notice, and the panel says it too
      refresh(ctx);
      load(ctx);
      return;
    }
    const left = Number(res.left) || 0;
    ctx.toast(`Shipped ${fmt.plural(crates.length, 'crate')}. ${left ? `${fmt.plural(left, 'crate stays', 'crates stay')} on the truck.` : 'The truck is empty.'}`);
    load(ctx);
  } finally { mine.shipping = false; }
}

function shipAll(ctx, job, button) {
  return ship(ctx, job, button, (list) => ({ sha: view.truck.headSha, crates: list, title: `Ship the whole load (${fmt.plural(list.length, 'crate')})?` }));
}
/** Ship every crate the hub merged up to this one: the crates before it in load order, and this one. */
function shipUpTo(ctx, job, d, button) {
  return ship(ctx, job, button, (list) => {
    const i = list.findIndex((x) => x.id === d.id);
    if (i < 0 || !list[i].mergeSha) return null;
    return { sha: list[i].mergeSha, crates: list.slice(0, i + 1), title: i ? `Ship crates 1 to ${i + 1}?` : 'Ship crate 1?' };
  });
}

async function requestChanges(ctx, job, d, button) {
  const text = await ctx.prompt({ title: d ? `Request changes to ${d.taskId}` : 'Request changes', label: 'What should change? The lead boss turns your words into a requirement and a task.', multiline: true, okLabel: 'Send request', placeholder: d ? 'Example: The list must also show the cooking time.' : 'Example: Add a dark mode.' });
  if (!text) return;
  await ui.busy(button, async () => {
    const body = { text };
    if (d) body.deliveryId = d.id;
    const res = await ctx.api.post(`/api/jobs/${enc(job.id)}/changes`, body);
    if (res) ctx.toast(`The lead boss has your request${res.req && res.req.id ? ` (requirement ${res.req.id})` : ''}. The job goes on.`);
  });
}

async function discard(ctx, job, button) {
  const n = crateList(ctx, job).length;
  const ok = await ctx.confirm({ title: `Discard ${fmt.plural(n, 'crate')}?`, text: `The reviewed work of ${job.id} is dropped with its integration branch. Your own branch does not change. This cannot be undone.`, okLabel: 'Discard', cancelLabel: 'Keep the crates', danger: true });
  if (!ok) return;
  await ui.busy(button, async () => { const res = await ctx.api.post(`/api/jobs/${enc(job.id)}/truck/discard`); if (res) { ctx.toast('The truck is empty. Nothing was shipped.'); load(ctx); } });
}

// ------------------------------------------------------------------ render

const JOB_WORDS = { delivering: 'ready to ship', cancelled: 'cancelled', done: 'done', paused: 'paused', queued: 'queued' };
/** One key per job that is in play. A press shows the truck of that job (the link then names it: ?panel=truck&job=J1). */
function jobSwitch(ctx, job, choices) {
  const floor = ctx.job;
  const seg = ui.segmented(choices.map((c) => {
    const j = c.job;
    const state = JOB_WORDS[j.status] || (floor && floor.id === j.id ? 'on the floor' : String(j.status).replace(/_/g, ' '));
    return { value: j.id, title: `${j.id}: ${j.title || ''}. ${fmt.plural(c.n, 'crate')} on its truck. The job is ${state}.`,
      label: [String(j.id), h('span', { class: ['badge', c.waits && 'hot'] }, String(c.n)), h('span.tk-jobstate', state)] };
  }), job.id, (id) => ctx.setParams({ job: id, file: null }));
  seg.setAttribute('aria-label', 'Show the truck of this job');
  return h('div.tk-switch', h('span.tk-lbl', 'Truck of'), seg, h('div.tk-jobname', { title: String(job.title || '') }, String(job.title || '')));
}

/**
 * The crates on the truck, in the order the hub merged them (the live store, sel.loadedDeliveries). The crate numbers,
 * "Ship up to here" and the ship dialog all follow this order. The order of the hub's truck answer is not used:
 * the hub sorts that list by delivery id, which is the order of the hand-ins.
 */
function crateList(ctx, job) {
  return ctx.sel.loadedDeliveries(ctx.store, job.id);
}

/**
 * What a ship of the loaded truck answer can take: the crates of that answer that are still on the truck, in load order.
 * A crate that landed after the answer is not in it: the head of the answer does not hold that crate.
 */
function shipList(ctx, job) {
  const t = view && view.truck;
  if (!t || !Array.isArray(t.deliveries)) return [];
  const listed = new Set(t.deliveries.map((d) => (d ? d.id : null)));
  return crateList(ctx, job).filter((d) => listed.has(d.id));
}

function render(container, ctx) {
  const job = pickJob(ctx);
  const floor = ctx.job;
  if (keep.jobId !== (job ? job.id : null)) { keep.jobId = job ? job.id : null; keep.loadFiles = false; keep.loadDiff = false; keep.loadOpen = new Set(); keep.crates = new Map(); keep.reportOpen = true; }
  if (ctx.params.file) { keep.loadFiles = true; keep.loadOpen.add(String(ctx.params.file)); }
  view = { jobId: job ? job.id : null, floorId: floor ? floor.id : null, named: !!job && ctx.params.job != null && String(ctx.params.job) === job.id,
    truck: null, error: null, loading: false, sig: null, stale: false, shipping: false, focus: ctx.params.file ? String(ctx.params.file) : null,
    empty: h('div'), head: h('div.tk-head'), banner: h('div'), questions: h('div.tk-qs'), acts: h('div'), load: h('div'), crates: h('div'), list: null, report: h('div'), shipped: h('div') };
  container.append(view.head, view.empty, view.banner, view.questions, view.acts, view.report, view.load, view.crates, view.shipped);
  refresh(ctx);
  if (job) load(ctx);
  // Nothing tells the UI when the owner's own branch moves ("behind"). Look again every half minute while the panel is open.
  view.timer = setInterval(() => { if (view && !document.hidden && shownJob(ctx) && !view.loading) load(ctx); }, 30000);
}

function refresh(ctx) {
  if (!view) return;
  const { store, sel } = ctx;
  const job = shownJob(ctx);
  const parts = ['head', 'banner', 'acts', 'load', 'crates', 'report', 'shipped'];
  if (!job) {
    for (const k of parts) part(view[k], 'none', () => null);
    view.list = null;
    syncQuestions(ctx, view.questions, []);
    part(view.empty, 'nojob', () => ui.emptyState('No truck yet', 'The truck fills up when a work order is on the floor and reviewed work is merged.', ui.btn('+ Work order', { tone: 'go', onClick: () => ctx.openPanel('workorder') })));
    return;
  }
  const t = view.truck;
  const project = sel.projectOf(store, job);
  const branch = (project && project.targetBranch) || 'main';
  const crates = crateList(ctx, job);
  const all = sel.deliveriesOf(store, job.id);
  const shipped = all.filter((d) => d.status === 'shipped');
  const canShip = crates.length > 0 && SHIP_STATES.has(job.status) && !!t && !!t.headSha && !view.stale;
  const reqs = t && t.reqs ? t.reqs : null;
  const notVerified = reqs ? (Number(reqs.open) || 0) + (Number(reqs.failed) || 0) : (job.requirements || []).filter((r) => r.status === 'open' || r.status === 'failed').length;
  const report = (t && t.report) || job.report || null;
  const stat = t && t.stat ? t.stat : crates.reduce((s, d) => ({ files: s.files + ((d.stat && d.stat.files) || 0), add: s.add + ((d.stat && d.stat.add) || 0), del: s.del + ((d.stat && d.stat.del) || 0) }), { files: 0, add: 0, del: 0 });

  // ---- head: which truck (when more than one job is in play), and what is on it
  const choices = truckChoices(ctx, job);
  part(view.head, [job.id, job.status, job.title, crates.length, t && t.headSha, JSON.stringify(stat), branch, view.loading && !t, view.error, choices.map((c) => `${c.job.id}:${c.n}:${c.job.status}`).join()].join('|'), () => [
    choices.length > 1 ? jobSwitch(ctx, job, choices) : null,
    h('div.tk-title', ui.chip(job.id, 'dark'), h('span.grow', crates.length ? `${fmt.plural(crates.length, 'crate')} on the truck` : 'The truck is empty'),
      crates.length ? ui.chip(job.status === 'delivering' ? 'ready to ship' : job.status === 'cancelled' ? 'left behind' : 'docked', job.status === 'delivering' ? 'amber' : job.status === 'cancelled' ? 'red' : 'plain',
        { title: job.status === 'delivering' ? 'The job is done except for your approval.' : job.status === 'cancelled' ? 'The job is cancelled. These crates were reviewed before that.' : 'The job still runs. More crates can arrive. You can ship what is here.' }) : null),
    crates.length ? h('dl.kv',
      h('dt', 'Ships to'), h('dd', h('span.strong', String(project ? project.name : 'the project')), ' on branch ', h('span.code', branch)),
      h('dt', 'Head'), h('dd', t && t.headSha ? [ui.sha(t.headSha), h('span.dim', ' the commit that "Approve & ship all" sends')] : view.error ? h('span.dim', 'not known') : h('span.dim', 'loading...')),
      h('dt', 'Load'), h('dd', fmt.plural(Number(stat.files) || 0, 'file'), ' ', ui.stat(Number(stat.add) || 0, Number(stat.del) || 0))) : null,
    view.error ? h('div.callout.bad', h('div.callout-title', 'The truck did not load'), h('p', String(view.error)), ui.btn('Try again', { small: true, onClick: () => load(ctx) })) : null,
  ]);

  // ---- empty state
  part(view.empty, crates.length ? 'some' : ['empty', job.status, shipped.length, all.map((d) => d.status[0]).join('')].join('|'), () => {
    if (crates.length) return null;
    const count = (s) => all.filter((d) => d.status === s).length;
    const way = [[count('checking'), 'in the check'], [count('buddy'), 'in a buddy check'], [count('review'), 'in review'], [count('approved'), 'approved, waiting to merge']].filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`);
    const text = job.status === 'done' ? `Everything shipped: ${fmt.plural(shipped.length, 'crate')} went to ${branch}.`
      : job.status === 'cancelled' ? 'The job is cancelled and nothing is loaded.'
        : way.length ? `On the way: ${way.join(', ')}.` : 'A crate arrives when a maker hands in, the check passes, a reviewer says PASS and the hub merges the work.';
    return ui.emptyState(job.status === 'done' ? 'The truck left' : 'Nothing is loaded', text, sel.isOpen(job) ? ui.btn('Open blueprint', { small: true, onClick: () => ctx.openPanel('blueprint') }) : null);
  });

  // ---- banner: what the truck waits for
  part(view.banner, [job.status, crates.length, t && t.behind, view.stale, branch, canShip].join('|'), () => {
    const out = [];
    if (view.stale) out.push(h('div.callout.you', h('div.callout-title', 'The truck changed'), h('p', { style: { margin: 0 } }, `${branch} moved, so the hub merged it into the load and ran the check again. The panel loads the new head. Look again, then ship.`)));
    else if (t && Number(t.behind) > 0) out.push(h('div.callout', h('div.callout-title', `${branch} moved: ${fmt.plural(Number(t.behind), 'new commit')}`),
      h('p', { style: { margin: 0 } }, 'When you press Ship, the hub first merges these commits into the load and runs the check. It then shows you the new load. That first press ships nothing.')));
    if (job.status === 'cancelled' && crates.length) out.push(h('div.callout.bad', h('div.callout-title', 'This job is cancelled'),
      h('p', `${fmt.plural(crates.length, 'reviewed crate is', 'reviewed crates are')} still on the truck. Ship ${crates.length === 1 ? 'it' : 'them'}, or discard ${crates.length === 1 ? 'it' : 'them'}.`),
      h('div.row', ui.btn('Ship loaded crates', { tone: 'go', disabled: !canShip, onClick: (e) => shipAll(ctx, job, e.currentTarget) }), ui.btn('Discard', { tone: 'danger', onClick: (e) => discard(ctx, job, e.currentTarget) }))));
    else if (job.status === 'delivering' && crates.length) out.push(h('div.callout.you', h('div.callout-title', 'The truck waits for you'), h('p', { style: { margin: 0 } }, 'Every requirement is verified or waived. Read the report, look at the load, then ship. The job ends when the truck is empty.')));
    return out;
  });

  // ---- pinned owner questions
  const qs = sel.isOpen(job) ? sel.ownerQuestions(store, job.id) : [];
  view.questions.hidden = !qs.length;
  syncQuestions(ctx, view.questions, qs);

  // ---- actions
  part(view.acts, [job.id, job.status, crates.length, canShip, notVerified, !!report, t && t.check && t.check.ok, !!t, t && t.notChecked, project && project.checkCmd, project && project.noCheckReason].join('|'), () => {
    if (!crates.length) return null;
    const check = t ? t.check : undefined;
    return h('div.tk-ship',
      job.status === 'cancelled' ? null : h('div.row',
        ui.btn('Approve & ship all', { tone: 'go', cls: 'big', disabled: !canShip, title: `Ship ${fmt.plural(crates.length, 'crate')} to ${branch}`, onClick: (e) => shipAll(ctx, job, e.currentTarget) }),
        sel.isOpen(job) ? ui.btn('Request changes', { onClick: (e) => requestChanges(ctx, job, null, e.currentTarget) }) : null,
        ui.btn('Open the cargo in Finder', { title: 'The hub makes a clone of the truck head, so you can run it before you approve', onClick: (e) => ui.busy(e.currentTarget, async () => {
          // Inside the Mac app the hub only makes the copy (open:false) and the app opens Finder. In a browser the hub opens it.
          const viaApp = ctx.native.available;
          const res = await ctx.api.post('/api/reveal', viaApp ? { jobId: job.id, what: 'truck', open: false } : { jobId: job.id, what: 'truck' });
          if (!res) return;
          if (viaApp && !(typeof res.path === 'string' && res.path && await ctx.native.reveal(res.path))) {
            ctx.toast(`Finder did not open. The copy of the load is in ${typeof res.path === 'string' && res.path ? res.path : 'the work folder of the hub'}.`, 'warn');
            return;
          }
          ctx.toast('Finder shows a copy of the load. Try it before you ship.');
        }) })),
      h('div.tk-gates',
        notVerified ? ui.chip(`${fmt.plural(notVerified, 'requirement')} not verified`, 'amber', { title: 'QA has not verified these yet. You can still ship what is loaded.' })
          : ui.chip('all requirements verified or waived', 'green'),
        t === null ? null : check ? ui.chip(check.ok ? 'check at the head: ok' : 'check at the head: failed', check.ok ? 'green' : 'red')
          : t.notChecked === true || (t.notChecked === undefined && project && !project.checkCmd) ? ui.chip('not checked', 'red', { title: String((project && project.noCheckReason) || 'The project has no check command.') })
            : ui.chip('head not checked yet', 'plain', { title: 'The hub checks the head before QA and before a ship.' }),
        !report && notVerified && job.status !== 'cancelled' ? h('span.dim', 'The report comes when QA is done.') : null),
      t && t.check && t.check.tail ? ui.fold('Output of the check at the head', () => h('pre.term.tk-tail', String(t.check.tail))) : null);
  });

  // ---- the whole load
  const loadFiles = t && Array.isArray(t.files) ? t.files : null;
  part(view.load, crates.length && loadFiles ? [t.headSha, loadFiles.map((f) => `${f.path}:${f.add}:${f.del}`).join()].join('|') : 'none', () => {
    if (!crates.length || !loadFiles) return null;
    const url = (path) => `/api/jobs/${enc(job.id)}/diff${path ? `?path=${enc(path)}` : ''}`;
    const tag = `#${t.headSha || ''}`; // the whole load changes with its head: the diff cache is keyed by it
    const filesBox = h('div.tk-box', { hidden: true }), diffBox = h('div.tk-box', { hidden: true });
    let filesBuilt = false, diffBuilt = false;
    const bFiles = ui.btn(`Files (${loadFiles.length})`, { small: true, 'aria-expanded': 'false', onClick: () => { keep.loadFiles = !keep.loadFiles; show(); } });
    const bDiff = ui.btn('Diff of the whole load', { small: true, 'aria-expanded': 'false', onClick: () => { keep.loadDiff = !keep.loadDiff; show(); } });
    function show() {
      if (keep.loadFiles && !filesBuilt) {
        filesBuilt = true;
        if (view.focus && !loadFiles.some((f) => f.path === view.focus)) filesBox.append(h('p.dim', h('span.code', view.focus), ' is not on the truck now.')); // a deep link to a file that is not loaded
        filesBox.append(fileList(ctx, loadFiles, { urlFor: url, open: keep.loadOpen, focus: view.focus, tag }));
        view.focus = null;
      }
      if (keep.loadDiff && !diffBuilt) { diffBuilt = true; diffBox.append(diffSlot(ctx, url(null), (text) => diffView(text), url(null) + tag)); }
      filesBox.hidden = !keep.loadFiles; diffBox.hidden = !keep.loadDiff;
      bFiles.setAttribute('aria-expanded', String(keep.loadFiles)); bDiff.setAttribute('aria-expanded', String(keep.loadDiff));
      bFiles.classList.toggle('is-on', keep.loadFiles); bDiff.classList.toggle('is-on', keep.loadDiff);
    }
    show();
    return ui.section(['Whole load', h('span.count', `what ${branch} gets: ${fmt.plural(loadFiles.length, 'file')}`)],
      h('div.tk-acts', bFiles, bDiff), filesBox, diffBox);
  });

  // ---- crates, in load order: crate 1 was merged first. "Ship up to here" on crate n ships crates 1 to n.
  part(view.crates, crates.length ? 'some' : 'none', () => { view.list = crates.length ? h('div.tk-list') : null; return crates.length ? ui.section(['Crates', h('span.count', { title: 'The order in which the hub merged them. Crate 1 was merged first.' }, 'in load order')], view.list) : null; });
  if (view.list) keyed(view.list, crates, { key: (d) => d.id, sig: (d) => crateSig(ctx, d, crates.indexOf(d), crates.length, canShip), render: (d) => crateNode(ctx, job, d, crates.indexOf(d), crates.length, canShip) });

  // ---- report
  part(view.report, String(report || ''), () => (report ? ui.section('Report', ui.fold('The report of the lead boss', () => h('div.tk-report', markdown(report)), { open: keep.reportOpen, onToggle: (v) => { keep.reportOpen = v; } })) : null));

  // ---- shipped earlier
  part(view.shipped, shipped.map((d) => d.id).join(), () => (shipped.length ? ui.section(['Shipped', h('span.count', fmt.plural(shipped.length, 'crate'))],
    h('p.tk-shipped', shipped.map((d) => { const task = store.get('tasks', d.taskId); return ui.chip(String(d.taskId), 'dark', { title: task ? String(task.title) : '' }); }))) : null));
}

export default {
  id: 'truck',
  title: 'Merge truck',
  label: 'Truck',
  // The button stands for the truck this panel opens with (sel.truckJob): its crates are the count, and it pulses when that truck waits.
  badge: ({ store, sel }) => sel.ownerAttention(store).truckLoad,
  attention: ({ store, sel }) => sel.ownerAttention(store).truckWaiting,
  render,
  update(ctx) {
    if (!view) return;
    const c = ctx.changes;
    if (!(c.has('jobs') || c.has('deliveries') || c.has('tasks') || c.has('agents') || c.has('projects') || c.has('board') || c.has('inbox') || c.has('state'))) return;
    const job = shownJob(ctx);
    const floor = ctx.job;
    // Choose the truck again when the job that shows is gone, or when another job came on the floor and the owner named no job.
    // In every other case the truck stays in view: after a ship or a discard the owner must see what is left.
    const moved = (floor ? floor.id : null) !== view.floorId;
    if (!job || (moved && !view.named)) {
      const next = pickJob(ctx);
      if ((next ? next.id : null) !== view.jobId) { const box = view.head.parentNode; clearInterval(view.timer); view = null; clear(box); render(box, ctx); return; }
      view.floorId = floor ? floor.id : null;
    }
    refresh(ctx);
    if (job && storeSig(ctx, job) !== view.sig) load(ctx);
  },
  dispose() { if (view) clearInterval(view.timer); view = null; },
};
