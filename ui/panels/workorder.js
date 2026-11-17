// Work Order panel: the form that starts a job, "Run demo (no tokens)", and the list of jobs (contract section 13b).
// POST /api/jobs { title, brief, kind, project:{mode, name?|path?, agentFilesAck?}, crew, options:{approvePlan}, budgetUsd? }

import { h, mount, keyed, clear } from '../lib/dom.js';
import * as ui from '../lib/widgets.js';
import { prefs } from '../lib/store.js';
import { markdown } from '../lib/md.js';
import { confirmCancel, runCancel } from '../lib/jobs.js';

const DRAFT_KEY = 'draftWorkorder';
const KINDS = [
  { value: 'build', label: 'Build', title: 'Make something new' },
  { value: 'fix', label: 'Fix', title: 'Repair a problem in a project' },
  { value: 'research', label: 'Research', title: 'Study a topic and report' },
];
const LIMITS = { bosses: [1, 3], managers: [0, 3], makers: [1, 8] };
const BRIEF_MAX = 20000; // the hub refuses a longer brief

let draft = null; // survives closing the drawer; also saved in prefs so a reload keeps a long brief
let dirty = false; // the draft changed since the hub last got it
let view = null;
let saveTimer = 0;

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function freshDraft(settings) {
  const s = settings || {};
  return { title: '', kind: 'build', brief: '', mode: 'new', name: '', nameEdited: false, path: '', branch: '', agentFiles: [], agentFilesAck: false, crew: s.defaultCrew || 'standard',
    bosses: 1, managers: 1, makers: 4, approvePlan: !!s.approvePlan, budget: s.budgetUsd == null ? '' : String(s.budgetUsd) };
}
// The draft is a preference (lib/store.js prefs). While the owner types it goes to localStorage only, so a reload of the
// window keeps a long brief. The hub gets one copy when the panel closes or the window is hidden, so a restart of the app
// keeps it too. (A write to the hub rewrites the settings file and goes to every window: not something to do per keystroke.)
function saveDraft(now = false) {
  clearTimeout(saveTimer);
  const write = () => prefs.set(DRAFT_KEY, draft, Infinity);
  if (now) { write(); prefs.flush(DRAFT_KEY); } else saveTimer = setTimeout(write, 400);
}
/**
 * The job that a new job waits behind, or null. The hub answers POST /api/jobs and /api/demo with status "queued" every time and
 * puts the job on a free floor a moment later, so "queued" alone does not mean that it waits.
 */
const behind = (ctx, job) => (job && job.status === 'queued' ? ctx.sel.waitsFor(ctx.store, job) : null);
const crewLine = (c) => (c ? `${ui.fmt.plural(c.bosses, 'boss', 'bosses')}, ${ui.fmt.plural(c.managers, 'manager')}, ${ui.fmt.plural(c.makers, 'maker')}` : '');

function notes(ctx) {
  const { store, sel, job } = ctx;
  const out = [];
  if (sel.isOpen(job)) {
    out.push(h('div.callout',
      h('div.callout-title', ui.chip(job.id, 'dark'), ui.statusChip('job', job.status), 'is on the floor'),
      h('p', { style: { margin: 0 } }, 'One job runs at a time. A new work order waits behind it.')));
  }
  const labs = sel.labs(store);
  if (labs.length && !labs.some(sel.labUsable)) {
    out.push(h('div.callout.you',
      h('div.callout-title', 'No runtime enabled yet'),
      h('p', 'Enable $0 Stand-in simulation, connect a local Ollama/vLLM server, or add one Frontier API key before starting a real job.'),
      h('div.row',
        ui.btn('Open Runtimes & Keys', { small: true, tone: 'primary', onClick: () => ctx.openPanel('keys') }),
        ui.btn('Try demo ($0)', { small: true, onClick: (e) => ui.busy(e.currentTarget, async () => {
          const demoJob = await ctx.api.post('/api/demo');
          if (demoJob) ctx.openPanel('blueprint');
        }) }))));
  }
  return out;
}
const notesSig = (ctx) => { const j = ctx.job; return `${j ? j.id + j.status : ''}|${ctx.sel.labs(ctx.store).map((p) => `${p.id}${p.usable}${p.reason}${p.mode}`).join()}`; };

function render(container, ctx) {
  const settings = ctx.store.settings || {};
  if (!draft) draft = { ...freshDraft(settings), ...(prefs.get(DRAFT_KEY, null) || {}) };
  const presets = settings.crewPresets || {};
  const set = (k, v) => { draft[k] = v; dirty = true; saveDraft(); };

  // 1 what
  const title = h('input', { type: 'text', value: draft.title, maxLength: 120, autocomplete: 'off', placeholder: 'Recipe box web app',
    oninput: () => { set('title', title.value); if (!draft.nameEdited) { name.value = slug(title.value); draft.name = name.value; } } });
  const fTitle = ui.field('Title', title);
  const kind = ui.segmented(KINDS, draft.kind, (v) => set('kind', v));
  const brief = h('textarea', { rows: 9, value: draft.brief, placeholder: 'Say what you want and how you will know it is done.\nThe bosses turn this into requirements and tasks.', oninput: () => set('brief', brief.value) });
  const fBrief = ui.field('Brief', brief, { hint: 'Plain words work best. Cmd+Enter starts the job.' });

  // 2 where
  const name = h('input', { type: 'text', value: draft.name, maxLength: 80, autocomplete: 'off', spellcheck: false, placeholder: 'recipe-box',
    oninput: () => { draft.nameEdited = name.value !== ''; set('name', name.value); } });
  const fName = ui.field('New project name', name, { hint: 'A new git repo in the projects folder of the hub.' });
  const path = h('input', { type: 'text', value: draft.path, autocomplete: 'off', spellcheck: false, placeholder: '/Users/you/Code/my-project',
    oninput: () => { draft.branch = ''; draft.agentFiles = []; draft.agentFilesAck = false; set('path', path.value); fPath.setError(''); showRepo(); } });
  const fPath = ui.field('Project folder', path, { hint: 'An existing git repo. The hub works on its own branch and never touches yours until you ship.' });
  fPath.classList.add('grow');
  const pick = ui.btn('Choose', { title: 'Open the folder picker', onClick: (e) => ui.busy(e.currentTarget, async () => {
    // Inside the Mac app the app shows the dialog and gives only the path; the hub then checks the repo (its branch, its agent
    // files) with POST /api/adopt-check. In a browser the hub shows the dialog and checks at once (POST /api/pick-folder).
    // A folder the hub refuses shows its words at the field, not as a note.
    const chosen = ctx.native.available ? await ctx.native.pickFolder() : null;
    if (chosen && !chosen.path) return; // the owner closed the dialog
    let res;
    try {
      res = chosen ? await ctx.api.post('/api/adopt-check', { path: chosen.path }, { quiet: true, throws: true })
        : await ctx.api.post('/api/pick-folder', {}, { quiet: true, throws: true });
    } catch (err) {
      // A hub without the check route: keep the path. The hub checks the folder when the job starts.
      if (chosen && err && err.status === 404) res = { path: chosen.path };
      else {
        if (chosen) { path.value = chosen.path; draft.branch = ''; draft.agentFiles = []; draft.agentFilesAck = false; set('path', chosen.path); showRepo(); }
        fPath.setError(String((err && err.message) || 'The hub could not check this folder.'));
        return;
      }
    }
    if (res && res.path) {
      path.value = res.path;
      draft.branch = typeof res.targetBranch === 'string' ? res.targetBranch : '';
      draft.agentFiles = Array.isArray(res.agentFiles) ? res.agentFiles.map(String).slice(0, 50) : [];
      draft.agentFilesAck = false;
      set('path', res.path); fPath.setError(''); showRepo();
    }
  }) });
  // An adopted repo: its target branch, and the agent-config files that Gemini workers would load (the owner accepts them once).
  const repo = h('div.wo-repo');
  const showRepo = () => mount(repo,
    draft.branch ? h('p', 'The truck ships to branch ', h('span.code', draft.branch), '. The hub works on its own branch until you approve.')
      : draft.path ? h('p.dim', 'The hub checks this folder when the job starts: it must be a git repo with at least one commit.') : null,
    draft.agentFiles.length ? h('div.callout',
      h('div.callout-title', 'This repo holds agent-config files'),
      h('p', draft.agentFiles.map((f, i) => [i ? ', ' : '', h('span.code', f)])),
      ui.checkbox('Gemini workers will load these. I accept that.', draft.agentFilesAck, (v) => set('agentFilesAck', v)),
      h('p.dim', { style: { margin: 0 } }, 'Without your yes the Gemini lab is off for this project.')) : null);
  const pathRow = h('div', h('div.wo-inline', fPath, h('div', { style: { paddingTop: '20px' } }, pick)), repo);
  const mode = ui.segmented([{ value: 'new', label: 'New project' }, { value: 'existing', label: 'Existing folder' }], draft.mode, (v) => { set('mode', v); showMode(); });
  const showMode = () => { fName.hidden = draft.mode !== 'new'; pathRow.hidden = draft.mode !== 'existing'; };

  // 3 who
  const crewOptions = [...['solo', 'standard', 'full'].filter((k) => presets[k]), ...Object.keys(presets).filter((k) => !['solo', 'standard', 'full'].includes(k))]
    .map((k) => ({ value: k, label: k, title: crewLine(presets[k]) }));
  crewOptions.push({ value: 'custom', label: 'Custom', title: 'Choose the counts yourself' });
  if (!crewOptions.some((o) => o.value === draft.crew)) draft.crew = crewOptions[0].value;
  const crew = ui.segmented(crewOptions, draft.crew, (v) => { set('crew', v); showCrew(); });
  const count = (key, label) => {
    const [lo, hi] = LIMITS[key];
    const input = h('input', { type: 'number', min: lo, max: hi, step: 1, value: draft[key], inputMode: 'numeric', oninput: () => { set(key, input.value); showCrew(); } });
    return ui.field(`${label} (${lo}-${hi})`, input);
  };
  const fB = count('bosses', 'Officers'), fM = count('managers', 'Team leads'), fK = count('makers', 'Specialists');
  const custom = h('div.wo-crew', fB, fM, fK);
  const line = h('div.wo-crewline');
  const gCrew = ui.group('Team', crew, custom, line);
  const showCrew = () => {
    custom.hidden = draft.crew !== 'custom';
    line.textContent = draft.crew === 'custom' ? 'Officers orchestrate & review (API key). Team leads & Specialists execute ($0 OSS).' : crewLine((ctx.store.settings.crewPresets || {})[draft.crew]);
  };

  // 4 rules
  const approve = ui.checkbox('Pause for plan review before specialists start building', draft.approvePlan, (v) => set('approvePlan', v));
  const budget = h('input', { type: 'text', inputMode: 'decimal', value: draft.budget, autocomplete: 'off', placeholder: 'no limit', oninput: () => set('budget', budget.value) });
  const mustBudget = ctx.sel.needsBudget(ctx.store);
  const fBudget = ui.field(mustBudget ? 'Frontier API budget in USD (required)' : 'Frontier API budget in USD', budget, { hint: mustBudget
    ? 'Caps Frontier API-key turns. OSS specialist & Stand-in turns cost $0.'
    : 'Frontier API turns only ($0 for OSS & Stand-in). Leave blank for no limit.' });
  const money = h('div.wo-money');
  budget.replaceWith(money);
  money.append(budget);

  const start = ui.btn('Start', { type: 'submit', tone: 'go', cls: 'big' });
  const demo = ui.btn('Run demo (no tokens)', { onClick: (e) => ui.busy(e.currentTarget, async () => {
    const job = await ctx.api.post('/api/demo');
    if (!job) return;
    const waits = behind(ctx, job);
    ctx.toast(waits ? `Demo ${job.id} is queued. It starts when ${waits.id} is done.` : `Demo ${job.id} is on the floor. It uses no tokens and takes a few minutes.`);
    if (!waits) ctx.openPanel('blueprint');
  }) });
  const noteBox = h('div');

  function validate() {
    let first = null;
    const fail = (f, input, msg) => { f.setError(msg); if (msg && !first) first = input; };
    fail(fTitle, title, draft.title.trim() ? '' : 'Give the work order a title.');
    fail(fBrief, brief, !draft.brief.trim() ? 'Write the brief. The bosses plan from it.' : draft.brief.trim().length > BRIEF_MAX ? `Keep the brief under ${BRIEF_MAX} characters.` : '');
    fail(fName, name, draft.mode === 'new' && draft.name.trim() && !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(draft.name.trim()) ? 'Start with a letter or digit. Then use letters, digits, space, dot, dash or underscore.' : '');
    fail(fPath, path, draft.mode === 'existing' && !draft.path.trim() ? 'Choose the folder of the project.' : '');
    if (draft.crew === 'custom') {
      for (const [key, f] of [['bosses', fB], ['managers', fM], ['makers', fK]]) {
        const n = Number(draft[key]), [lo, hi] = LIMITS[key];
        fail(f, f.control, Number.isInteger(n) && n >= lo && n <= hi ? '' : `Use a whole number from ${lo} to ${hi}.`);
      }
    }
    const b = draft.budget.trim().replace(/^\$/, '');
    fail(fBudget, budget, b === '' ? (ctx.sel.needsBudget(ctx.store) ? 'Set a budget. A lab bills per token.' : '') : Number.isFinite(Number(b)) && Number(b) >= 0 ? '' : 'Use a number of dollars (0 or more).');
    if (first) first.focus();
    return !first;
  }

  async function submit() {
    if (!validate()) return;
    const b = draft.budget.trim().replace(/^\$/, '');
    const order = {
      title: draft.title.trim(), brief: draft.brief.trim(), kind: draft.kind,
      project: draft.mode === 'new' ? { mode: 'new', name: draft.name.trim() || slug(draft.title) || 'project' } : { mode: 'existing', path: draft.path.trim(), agentFilesAck: !!draft.agentFilesAck },
      crew: draft.crew === 'custom' ? { bosses: Number(draft.bosses), managers: Number(draft.managers), makers: Number(draft.makers) } : draft.crew,
      options: { approvePlan: !!draft.approvePlan },
    };
    if (b !== '') order.budgetUsd = Number(b);
    await ui.busy(start, async () => {
      const job = await ctx.api.post('/api/jobs', order);
      if (!job) return;
      draft = null; dirty = false;
      clearTimeout(saveTimer);
      prefs.set(DRAFT_KEY, null, 300);
      const waits = behind(ctx, job);
      ctx.toast(waits ? `Work order ${job.id} is queued. It starts when ${waits.id} is done.` : `Work order ${job.id} is on the floor.`);
      if (waits) { const box = form.parentNode; view = null; clear(box); render(box, ctx); } // a fresh form; the queued job shows in the list below
      else ctx.openPanel('blueprint');
    });
  }

  const form = h('form', { novalidate: true, onsubmit: (e) => { e.preventDefault(); submit(); } },
    h('div.wo-head',
      h('div', h('h3.wo-title', 'New work order'), h('div.wo-sub', 'Describe what you want built. Officers plan & inspect; OSS specialists build in isolated branches.'))),
    noteBox,
    ui.section([h('span.wo-step', '1'), 'What to build'], fTitle, ui.group('Kind', kind), fBrief),
    ui.section([h('span.wo-step', '2'), 'Where'], ui.group('Project', mode), fName, pathRow),
    ui.section([h('span.wo-step', '3'), 'Team'], gCrew),
    ui.section([h('span.wo-step', '4'), 'Review & budget'], approve, fBudget),
    h('div.wo-actions', start, demo));
  ui.submitOnEnter(brief, submit, { mod: true });
  for (const f of [fTitle, fBrief, fName, fPath, fB, fM, fK, fBudget]) f.control.addEventListener('input', () => f.setError('')); // an error leaves when the owner types
  showMode(); showCrew(); showRepo();
  const jobsBox = h('div.wo-jobs');
  container.append(form, jobsBox);

  view = { noteBox, jobsBox, sig: null, showCrew };
  refreshNotes(ctx);
  refreshJobs(ctx);
  if (!ctx.params.nofocus) requestAnimationFrame(() => { if (view && view.noteBox === noteBox && container.contains(title)) title.focus({ preventScroll: true }); });
}

function refreshNotes(ctx) {
  const sig = notesSig(ctx);
  if (!view || view.sig === sig) return;
  view.sig = sig;
  mount(view.noteBox, notes(ctx));
}

/** Finder on a project folder: through the Mac app when it runs the page, else through the hub. */
async function revealProject(ctx, projectId) {
  const p = ctx.store.get('projects', projectId);
  if (p && p.path && ctx.native.available && (await ctx.native.reveal(p.path))) return true;
  return ctx.api.post('/api/reveal', { projectId });
}

/**
 * Jobs list: every job with status, wait reason, report, Reveal and Delete; Cancel for a job that waits in the queue.
 * Delete removes the work folders and the task, agent and delivery rows of a done or cancelled job. The job itself stays in
 * the list (title, brief, ledger, report). A job with no rows left has nothing to delete or to reveal, so both links go.
 */
function refreshJobs(ctx) {
  if (!view) return;
  const { store, sel } = ctx;
  // A deleted job leaves the list. Its title, brief, ledger and report stay, so it goes into a folded "Deleted jobs" list below.
  const all = store.list('jobs').slice().reverse();
  const jobs = all.filter((j) => !j.deleted), gone = all.filter((j) => j.deleted);
  if (!all.length) { if (view.jobsBox.firstChild) mount(view.jobsBox); view.jobsList = null; view.goneList = null; return; }
  if (!view.jobsList) {
    view.jobsList = h('ul.list');
    view.goneList = h('ul.list');
    view.goneHead = h('summary.dim');
    view.goneBox = h('details.wo-gone', { hidden: true }, view.goneHead, view.goneList);
    mount(view.jobsBox, ui.section('Jobs', view.jobsList, view.goneBox));
  }
  view.goneBox.hidden = !gone.length;
  view.goneHead.textContent = `Deleted jobs (${gone.length}): their report stays`;
  const rowsOf = (j) => sel.tasksOf(store, j.id).length + sel.agentsOf(store, j.id).length + sel.deliveriesOf(store, j.id).length;
  const spec = {
    key: (j) => j.id,
    sig: (j) => [j.title, j.status, j.pauseReason, j.waitReason, !!j.report, !!j.deleted, rowsOf(j) > 0, j.projectId, (sel.waitsFor(store, j) || {}).id, sel.cost(j, ui.fmt.money).text].join('|'),
    render: (j) => {
      const waits = sel.waitsFor(store, j);
      const over = ['done', 'cancelled'].includes(j.status);
      const rows = rowsOf(j) > 0;
      const removed = !!j.deleted || (j.status === 'done' && !rows); // the hub marks a deleted job; an old hub only removed its rows
      return h('li', { class: ['li', 'wo-job', j.deleted && 'is-deleted'] },
        h('div.wo-job-top', ui.chip(j.id, 'dark'), h('span.grow.strong', String(j.title || '')), j.deleted ? ui.chip('deleted', 'steel', { title: 'Its work folders are gone. The title, the brief, the ledger and the report stay.' }) : ui.statusChip('job', j.status)),
        h('div.wo-job-meta',
          h('span.dim', j.status === 'queued' ? (waits ? `waits for ${waits.id}` : j.waitReason ? `waits: ${String(j.waitReason).replace(/[.\s]+$/, '')}` : 'waits for a free floor') : j.status === 'paused' ? `paused: ${sel.pauseWords(j)}` : `${ui.fmt.date(j.createdAt)} · ${sel.cost(j, ui.fmt.money).text}`),
          removed ? h('span.dim', 'work folders removed') : null,
          j.report ? h('button.linkish', { type: 'button', onclick: () => ctx.modal({ title: `${j.id}: report`, wide: true, body: markdown(j.report), buttons: [{ label: 'Close', primary: true, tone: 'steel' }] }) }, 'Report') : null,
          // A job that waits in the queue has no project yet (the hub makes it when the job comes on the floor): nothing to reveal.
          j.projectId && !j.deleted && (!over || rows) ? h('button.linkish', { type: 'button', title: 'Show the project folder in Finder', onclick: (e) => ui.busy(e.currentTarget, () => revealProject(ctx, j.projectId)) }, 'Reveal') : null,
          j.status === 'queued' ? h('button.linkish', { type: 'button', title: 'Take this work order out of the queue', onclick: async (e) => {
            const button = e.currentTarget;
            if (await confirmCancel(ctx, j)) runCancel(ctx, j, button);
          } }, 'Cancel') : null,
          over && rows && !j.deleted ? h('button.linkish', { type: 'button', title: 'Remove the work folders of this job. The title, the brief, the ledger and the report stay.', onclick: async (e) => {
            const button = e.currentTarget;
            const ok = await ctx.confirm({ title: `Delete ${j.id}?`, text: 'The hub removes the work folders, the refs and the task rows of this job. The title, the brief, the ledger and the report stay. Shipped work is not touched.', okLabel: 'Delete', danger: true });
            if (!ok) return;
            ui.busy(button, async () => {
              const res = await ctx.api.del(`/api/jobs/${encodeURIComponent(j.id)}`);
              if (res) { ctx.toast(`${j.id}: work folders removed. Title, brief, ledger and report stay.`); ctx.store.refreshInbox(); }
            });
          } }, 'Delete') : null));
    },
  };
  keyed(view.jobsList, jobs, spec);
  keyed(view.goneList, gone, spec);
}

export default {
  id: 'workorder',
  title: 'New work order',
  label: '+ Work Order',
  short: '+ Order',
  primary: true,
  render,
  update(ctx) {
    const c = ctx.changes;
    if (c.has('jobs') || c.has('providers') || c.has('state')) refreshNotes(ctx);
    if (c.has('jobs') || c.has('tasks') || c.has('agents') || c.has('deliveries') || c.has('state')) refreshJobs(ctx); // the rows of a job go when it is deleted
    if (c.has('settings') && view) view.showCrew();
  },
  dispose() { if (draft && dirty) { saveDraft(true); dirty = false; } view = null; },
};
