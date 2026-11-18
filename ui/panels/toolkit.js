// Toolkit panel (contract sections 12c and 13b): the tool wall of a project. The pegboard in the scene opens it.
// A grid of chunky tool buttons with icon and name. A click runs the tool (with a confirm step when the tool asks for it):
//   command  the hub runs a shell command in the project folder; the output streams into the run log (toolrun events)
//   order    a saved work order: one click starts (or queues) a job from it
//   ask      a saved message to the lead boss or a floor manager of the running job (posted as REQ from the owner)
// "+" adds a tool (name, icon, kind, and the command, the order or the message). Each tool has Edit; Delete is in the edit dialog.
// Data: GET /api/projects/:id/toolkit -> Tool[] ; PUT { tools } ; POST /api/projects/:id/toolkit/:toolId/run -> { ok, runId?, jobId?, msgId? }
//   Tool { id, name, icon, kind:'command'|'order'|'ask', command?, order?:{ title, brief, kind, crew }, ask?:{ to:'@boss'|'@mgr', body }, confirm }
// A tool of the hub with an "action" (Run checks, Open folder) keeps its action: its command comes from the project, not from this form.

import { h, mount, keyed, showMarks } from '../lib/dom.js';
import * as ui from '../lib/widgets.js';

const fmt = ui.fmt;
const enc = encodeURIComponent;
const RUN_CAP = 6;            // runs kept in the log
const TEXT_CAP = 200 * 1024;  // output kept per run (the hub caps it at 200 KB too)
const KIND_WORD = { command: 'command', order: 'order', ask: 'message' };
const KIND_TONE = { command: 'plain', order: 'green', ask: 'blue' };

// ------------------------------------------------------------------ icons: 12 x 12 pixels, drawn on a canvas (no image files)

// k ink, s steel, S light steel, w wood, W light wood, a amber, p paper, r red, g green, b blue
const ICONS = {
  wrench: ['........kkk.', '.......ksSk.', '......ksk...', '......ksk.kk', '......kssssk', '.....ksssSk.', '....ksskkk..', '...kssk.....', '..kssk......', '.kssk.......', 'kssk........', 'kkk.........'],
  gauge: ['...kkkkkk...', '..kppppppk..', '.kpppppprpk.', 'kppppppkpppk', 'kpppppkppppk', 'kppppkpppppk', 'kpppkkpppppk', 'kpppkkpppppk', '.kppppppppk.', '..kppppppk..', '...kkkkkk...', '............'],
  folder: ['............', '.kkkk.......', 'kaaaak......', 'kaaaaakkkkk.', 'kaaaaaaaaaak', 'kWWWWWWWWWWk', 'kWWWWWWWWWWk', 'kWWWWWWWWWWk', 'kWWWWWWWWWWk', 'kWWWWWWWWWWk', '.kkkkkkkkkk.', '............'],
  clipboard: ['....kkkk....', '..kkksskkk..', '.kwwksskwwk.', '.kwppppppwk.', '.kwpkkkkpwk.', '.kwppppppwk.', '.kwpkkkkpwk.', '.kwppppppwk.', '.kwpkkpppwk.', '.kwppppppwk.', '.kwwwwwwwwk.', '..kkkkkkkk..'],
  hammer: ['..kkkkkkk...', '.ksssssSsk..', '.ksssssssk..', '..kkkwkkk...', '....kwk.....', '....kwk.....', '....kwk.....', '....kwk.....', '....kwk.....', '....kwk.....', '....kwk.....', '....kkk.....'],
  play: ['............', '..kk........', '..kgkk......', '..kgggkk....', '..kgggggkk..', '..kgggggggk.', '..kgggggggk.', '..kgggggkk..', '..kgggkk....', '..kgkk......', '..kk........', '............'],
  bolt: ['......kkkk..', '.....kaak...', '....kaak....', '...kaak.....', '..kaaakkkk..', '.kaaaaaak...', '..kkkkaak...', '.....kaak...', '....kaak....', '...kaak.....', '..kak.......', '..kk........'],
  flag: ['.kk.........', '.kwkkkkkkk..', '.kwrrrrrrrk.', '.kwrrrrrrrk.', '.kwrrrrrrrk.', '.kwrrrrrrk..', '.kwkkkkkk...', '.kwk........', '.kwk........', '.kwk........', '.kwk........', '.kkk........'],
  bug: ['..k......k..', '...k.kk.k...', '...kkrrkk...', '.k.krrrrk.k.', '..kkrkkrkk..', '...krrrrk...', '.kkkrkkrkkk.', '...krrrrk...', '..kkrrrrkk..', '.k..krrk..k.', '.....kk.....', '............'],
  book: ['............', '.kkkkkkkkkk.', '.kbbbbkbbbbk', '.kbppbkbppbk', '.kbbbbkbbbbk', '.kbppbkbppbk', '.kbbbbkbbbbk', '.kbppbkbppbk', '.kbbbbkbbbbk', '.kkkkkkkkkkk', '............', '............'],
  chat: ['............', '.kkkkkkkkkk.', 'kppppppppppk', 'kpkkkkkkpppk', 'kppppppppppk', 'kpkkkkkppppk', 'kppppppppppk', '.kkkpkkkkkk.', '...kpk......', '...kk.......', '............', '............'],
  star: ['.....kk.....', '....kaak....', '....kaak....', 'kkkkkaakkkkk', 'kaaaaaaaaaak', '.kaaaaaaaak.', '..kaaaaaak..', '..kaaaaaak..', '.kaaakkaaak.', '.kaakk.kkaak', 'kkkk....kkkk', '............'],
  search: ['...kkkk.....', '..kSSSSk....', '.kSppppSk...', '.kSppppSk...', '.kSppppSk...', '.kSppppSk...', '..kSSSSkk...', '...kkkkssk..', '.......kssk.', '........kssk', '.........kkk', '............'],
};
export const ICON_NAMES = Object.keys(ICONS);
const INK = { k: '--ink', s: '--steel', S: '--steel-light', w: '--wood', W: '--wood-light', a: '--amber', p: '--white', r: '--red', g: '--green', b: '--lab-gemini' };

/** A tool icon: a 12 x 12 pixel picture at 3 px per pixel. An icon name this window does not know shows the first letter of the tool. */
function iconEl(name, letter = '?') {
  const rows = Object.hasOwn(ICONS, name) ? ICONS[name] : null;
  if (!rows) return h('span.tw-icon.tw-letter', { 'aria-hidden': 'true' }, String(letter).slice(0, 1));
  const cv = h('canvas.tw-icon', { width: 12, height: 12, 'aria-hidden': 'true' });
  const g = cv.getContext('2d');
  if (!g) return cv;
  const css = getComputedStyle(document.documentElement);
  const colors = {};
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      if (c === '.' || !Object.hasOwn(INK, c)) continue;
      g.fillStyle = colors[c] || (colors[c] = css.getPropertyValue(INK[c]).trim() || '#15121e');
      g.fillRect(x, y, 1, 1);
    }
  });
  return cv;
}

// ------------------------------------------------------------------ state that outlives the drawer

const keep = { projectId: null, jobProject: null, tools: new Map(), runs: [], wired: false }; // tools: project id -> Tool[] as the hub sent it
let view = null;

/** The wall on show: the project the owner picked, else the project of the job on the floor, else the newest project. */
const projectOf = (ctx) => {
  const { store } = ctx;
  const job = ctx.job;
  const onFloor = job ? job.projectId : null;
  if (onFloor !== keep.jobProject) { keep.jobProject = onFloor; keep.projectId = null; } // another job is on the floor: its project shows again
  const mine = keep.projectId ? store.get('projects', keep.projectId) : null;
  if (mine) return mine;
  const p = onFloor ? store.get('projects', onFloor) : null;
  return p || store.list('projects').slice(-1)[0] || null;
};
const toolsOf = (pid) => keep.tools.get(pid) || null;

// ------------------------------------------------------------------ run log (toolrun events)

function runOf(runId, toolId) {
  let r = keep.runs.find((x) => x.runId === runId);
  if (!r) {
    const tool = [...keep.tools.values()].flat().find((t) => t.id === toolId);
    r = { runId, toolId, name: tool ? tool.name : String(toolId || 'tool'), at: Date.now(), text: '', done: false, code: null };
    keep.runs.unshift(r);
    if (keep.runs.length > RUN_CAP) keep.runs.length = RUN_CAP;
  }
  return r;
}

/** One toolrun event: { runId, toolId, chunk? } and at the end { runId, toolId, done, code }. */
function onRun(evt) {
  if (!evt || evt.runId == null) return;
  const r = runOf(String(evt.runId), evt.toolId);
  if (typeof evt.chunk === 'string' && evt.chunk) {
    r.text += evt.chunk;
    if (r.text.length > TEXT_CAP) r.text = r.text.slice(-TEXT_CAP);
  }
  if (evt.done) { r.done = true; r.code = typeof evt.code === 'number' ? evt.code : null; }
  // A command streams its output line by line: draw once per frame, not once per line.
  if (view && !drawFrame) drawFrame = requestAnimationFrame(() => { drawFrame = 0; if (view) drawRuns(); });
}
let drawFrame = 0;

function runNode(r) {
  const out = h('pre.term.tw-out', { tabIndex: 0 });
  const state = h('span');
  const node = h('div.tw-run', h('div.tw-runhead', h('span.strong', r.name), h('span.dim', fmt.time(r.at)), h('span.grow'), state), out);
  node.__run = { id: r.runId, out, state, len: -1, done: null };
  return node;
}
function drawRuns() {
  const box = view.runs;
  const sig = keep.runs.length ? 'some' : 'none';
  if (view.runSig !== sig) {
    view.runSig = sig;
    view.runList = keep.runs.length ? h('div.tw-runs') : null;
    mount(box, keep.runs.length ? ui.section(['Run log', h('span.count', 'the output of command tools'),
      h('button.linkish', { type: 'button', title: 'Empty the run log', onclick: () => { keep.runs = keep.runs.filter((r) => !r.done); view.runSig = null; drawRuns(); } }, 'Clear')], view.runList) : null);
  }
  if (!view.runList) return;
  keyed(view.runList, keep.runs, { key: (r) => r.runId, sig: (r) => r.runId, render: runNode });
  for (const node of view.runList.children) {
    const v = node.__run;
    const r = v ? keep.runs.find((x) => x.runId === v.id) : null;
    if (!r) continue;
    if (v.len !== r.text.length) {
      const stick = v.out.scrollHeight - v.out.scrollTop - v.out.clientHeight < 24;
      v.len = r.text.length;
      v.out.textContent = showMarks(r.text) || (r.done ? '(no output)' : 'Waiting for output...'); // the output of a command is text only, with hidden direction marks written out
      if (stick) v.out.scrollTop = v.out.scrollHeight;
    }
    const done = r.done ? String(r.code) : 'run';
    if (v.done !== done) {
      v.done = done;
      mount(v.state, r.done ? ui.chip(r.code === 0 ? 'done, exit 0' : r.code === null ? 'ended' : `failed, exit ${r.code}`, r.code === 0 ? 'green' : 'red') : ui.chip('running', 'amber'));
    }
  }
}

// ------------------------------------------------------------------ run a tool

function describe(ctx, tool, project) {
  if (tool.kind === 'command') {
    if (tool.action === 'reveal') return [h('p', 'Finder shows the project folder.')];
    return [h('p', 'The hub runs this command in the project folder, as you:'), h('pre.term.tw-cmd', '$ ' + String(tool.command || '(the project has no check command yet)')),
      h('p.dim', `Folder: ${project.path || project.name}. Time limit: 10 minutes. The output shows in the run log.`)];
  }
  if (tool.kind === 'order') {
    const o = tool.order || {};
    return [h('p', 'This starts a work order on this project. It waits in the queue when a job is on the floor.'),
      h('dl.kv', h('dt', 'Title'), h('dd', String(o.title || '')), h('dt', 'Kind'), h('dd', String(o.kind || 'build')), h('dt', 'Crew'), h('dd', typeof o.crew === 'string' ? o.crew : o.crew ? `${o.crew.bosses} / ${o.crew.managers} / ${o.crew.makers}` : 'default')),
      h('p.pre.tw-brief', fmt.clip(String(o.brief || ''), 600))];
  }
  const a = tool.ask || {};
  return [h('p', `This posts an order (REQ) to ${a.to === '@mgr' ? 'a floor manager' : 'the lead boss'} of the running job:`), h('p.pre.tw-brief', String(a.body || ''))];
}

async function run(ctx, tool, button) {
  const project = projectOf(ctx);
  if (!project) return;
  if (tool.confirm) {
    const ok = await new Promise((resolve) => ctx.modal({ title: `Run "${tool.name}"?`, body: h('div.stack', describe(ctx, tool, project)), focusFirst: true,
      buttons: [{ label: 'Not now', value: false }, { label: 'Run', value: true, primary: true }], onClose: (v) => resolve(v === true) }));
    if (!ok || !view) return;
  }
  await ui.busy(button, async () => {
    // "Open folder" inside the Mac app: the app opens Finder itself. Else (or when it refuses) the hub does.
    if (tool.kind === 'command' && tool.action === 'reveal' && project.path && ctx.native.available && (await ctx.native.reveal(project.path))) { ctx.toast('Finder shows the project folder.'); return; }
    const res = await ctx.api.post(`/api/projects/${enc(project.id)}/toolkit/${enc(tool.id)}/run`, {}, { timeoutMs: 120000 });
    if (!res) return;
    if (res.runId) {
      runOf(String(res.runId), tool.id).name = tool.name;
      if (view) { drawRuns(); view.runs.scrollIntoView({ block: 'nearest' }); }
      ctx.toast(`${tool.name} runs. Its output is in the run log.`);
    } else if (res.msgId != null) { // an ask tool (the answer names the job too)
      ctx.toast(`${tool.name}: sent as #${res.msgId}. The answer comes on the board.`, 'info', { action: { label: 'Open Board', run: () => ctx.openPanel('board') } });
    } else if (res.jobId) {
      const job = ctx.store.get('jobs', res.jobId);
      ctx.toast(`${tool.name}: work order ${res.jobId} is ${job && job.status === 'queued' && ctx.sel.waitsFor(ctx.store, job) ? `queued. It starts when ${ctx.sel.waitsFor(ctx.store, job).id} is done` : 'on the floor'}.`, 'info', { action: { label: 'Open Work Order', run: () => ctx.openPanel('workorder', { nofocus: 1 }) } });
    } else ctx.toast(tool.action === 'reveal' ? 'Finder shows the project folder.' : `${tool.name} is done.`);
  });
}

// ------------------------------------------------------------------ add, edit, delete

async function save(ctx, project, tools, words) {
  const res = await ctx.api.put(`/api/projects/${enc(project.id)}/toolkit`, { tools });
  if (!Array.isArray(res)) return false;
  keep.tools.set(project.id, res);
  if (view) drawTools(ctx);
  ctx.toast(words);
  return true;
}

/** The dialog for a new tool (tool = null) or an existing one. */
function edit(ctx, tool) {
  const project = projectOf(ctx);
  if (!project) return;
  // The tool wall is fetched again while a job runs, so the tile's tool and this list can be different objects for the
  // same tool: match by id, never by object identity (an edit or a delete would else change nothing).
  const list = toolsOf(project.id) || [];
  const same = (t) => !!tool && t.id === tool.id;
  const d = tool ? structuredClone(tool) : { id: '', name: '', icon: 'wrench', kind: 'command', command: '', confirm: false };
  const fixed = !!d.action; // a tool of the hub: its command comes from the project
  const presets = Object.keys((ctx.store.settings || {}).crewPresets || {});

  const name = h('input', { type: 'text', maxLength: 60, autocomplete: 'off', value: d.name, placeholder: 'Build the app' });
  const fName = ui.field('Name', name);
  const icons = h('div.tw-icons', { role: 'radiogroup', 'aria-label': 'Icon' });
  let icon = Object.hasOwn(ICONS, d.icon) ? d.icon : ICON_NAMES[0];
  const iconBtns = ICON_NAMES.map((n) => h('button.tw-iconkey', { type: 'button', role: 'radio', title: n, 'aria-label': n, 'aria-checked': String(n === icon), onclick: () => { icon = n; for (const b of iconBtns) b.setAttribute('aria-checked', String(b.title === n)); } }, iconEl(n)));
  icons.append(...iconBtns);
  const kind = ui.segmented([{ value: 'command', label: 'Command', title: 'A shell command in the project folder' }, { value: 'order', label: 'Work order', title: 'A saved work order' }, { value: 'ask', label: 'Message', title: 'A saved message to a boss or a manager' }], d.kind, () => show());

  const command = h('textarea.tw-mono', { rows: 3, spellcheck: false, value: d.command || '', placeholder: 'npm run build' });
  const fCommand = ui.field('Command', command, { hint: fixed ? (d.action === 'check' ? 'This tool runs the check command of the project. The plan sets it.' : 'This tool opens the project folder in Finder.') : 'It runs in the project folder as you, with a clean environment and a 10 minute limit.' });
  command.disabled = fixed;

  const o = d.order || {};
  const oTitle = h('input', { type: 'text', maxLength: 120, autocomplete: 'off', value: o.title || '', placeholder: 'Update the dependencies' });
  const oKind = ui.segmented([{ value: 'build', label: 'Build' }, { value: 'fix', label: 'Fix' }, { value: 'research', label: 'Research' }], o.kind || 'build');
  const oBrief = h('textarea', { rows: 5, value: o.brief || '', placeholder: 'Say what you want and how you will know it is done.' });
  const oCrew = ui.select([{ value: '', label: 'Default crew' }, ...presets.map((p) => ({ value: p, label: p }))], typeof o.crew === 'string' ? o.crew : '');
  const fOTitle = ui.field('Title of the work order', oTitle), fOBrief = ui.field('Brief', oBrief), fOCrew = ui.field('Crew', oCrew);
  const orderBox = h('div', fOTitle, ui.group('Kind', oKind), fOBrief, fOCrew);

  const a = d.ask || {};
  const aTo = ui.segmented([{ value: '@boss', label: 'Lead boss' }, { value: '@mgr', label: 'Floor manager' }], a.to === '@mgr' ? '@mgr' : '@boss');
  const aBody = h('textarea', { rows: 3, maxLength: 600, value: a.body || '', placeholder: 'Report what was finished today and what is slow.' });
  const fABody = ui.field('Message', aBody, { hint: 'It is posted as an order (REQ) from you. The agent accepts or refuses it on the board.' });
  const askBox = h('div', ui.group('To', aTo), fABody);

  const confirm = ui.checkbox('Ask before it runs (show what will happen first)', !!d.confirm);
  const kindGroup = ui.group('Kind', kind);
  const show = () => { const k = kind.value; fCommand.hidden = k !== 'command'; orderBox.hidden = k !== 'order'; askBox.hidden = k !== 'ask'; };
  if (fixed) kindGroup.hidden = true;
  show();
  for (const f of [fName, fCommand, fOTitle, fOBrief, fABody]) f.control.addEventListener('input', () => f.setError(''));

  function read() {
    let first = null;
    const fail = (f, msg) => { f.setError(msg); if (msg && !first) first = f.control; };
    const k = fixed ? 'command' : kind.value;
    const out = { id: d.id || '', name: name.value.trim(), icon, kind: k, confirm: confirm.input.checked };
    fail(fName, !out.name ? 'Give the tool a name.' : (toolsOf(project.id) || list).some((t) => !same(t) && t.name === out.name) ? 'Another tool has this name.' : '');
    if (k === 'command') {
      if (fixed) { out.action = d.action; out.command = ''; } else { out.command = command.value.trim(); fail(fCommand, out.command ? '' : 'Write the command.'); }
    } else if (k === 'order') {
      out.order = { title: oTitle.value.trim(), brief: oBrief.value.trim(), kind: oKind.value || 'build', crew: oCrew.select.value || (typeof o.crew === 'object' && o.crew ? o.crew : null) };
      if (o.budgetUsd != null) out.order.budgetUsd = o.budgetUsd; // a budget the tool already carries stays
      fail(fOTitle, out.order.title ? '' : 'Give the work order a title.');
      fail(fOBrief, out.order.brief ? '' : 'Write the brief.');
    } else {
      out.ask = { to: aTo.value || '@boss', body: aBody.value.trim() };
      fail(fABody, out.ask.body ? '' : 'Write the message.');
    }
    if (first) { first.focus(); return null; }
    return out;
  }

  const buttons = [];
  if (tool) buttons.push({ label: 'Delete', tone: 'danger', run: async () => {
    const ok = await ctx.confirm({ title: `Delete "${tool.name}"?`, text: 'The tool leaves the tool wall of this project.', okLabel: 'Delete', danger: true });
    if (!ok) return false;
    return save(ctx, project, (toolsOf(project.id) || list).filter((t) => !same(t)), `"${tool.name}" is deleted.`);
  } });
  buttons.push({ label: 'Cancel', value: false }, { label: tool ? 'Save tool' : 'Add tool', primary: true, run: async () => {
    const next = read();
    if (!next) return false;
    const cur = toolsOf(project.id) || list; // the newest wall: it may have been fetched again while the dialog was open
    return save(ctx, project, tool ? cur.map((t) => (same(t) ? next : t)) : [...cur, next], tool ? `"${next.name}" is saved.` : `"${next.name}" is on the tool wall.`);
  } });
  ctx.modal({ title: tool ? `Edit "${tool.name}"` : 'Add a tool', wide: true, buttons,
    body: h('div.tw-form', fName, ui.group('Icon', icons), kindGroup, fCommand, orderBox, askBox, confirm) });
}

// ------------------------------------------------------------------ render

function toolSig(t) { return JSON.stringify(t); }

function toolNode(ctx, t) {
  const noCheck = t.kind === 'command' && t.action === 'check' && !String(t.command || '').trim();
  const what = t.kind === 'command' ? (t.action === 'reveal' ? 'Opens the project folder in Finder' : noCheck ? 'The project has no check command yet. The plan sets it.' : `$ ${t.command}`)
    : t.kind === 'order' ? `Work order: ${(t.order && t.order.title) || ''}` : `To ${t.ask && t.ask.to === '@mgr' ? 'a floor manager' : 'the lead boss'}: ${(t.ask && t.ask.body) || ''}`;
  return h('div.tw-tile', { dataset: { tool: t.id } },
    h('button.tw-tool', { type: 'button', title: `${what}${t.confirm ? '\nAsks before it runs.' : ''}`, onclick: (e) => run(ctx, t, e.currentTarget) },
      iconEl(t.icon, t.name), h('span.tw-name', String(t.name))),
    h('div.tw-foot', ui.chip(KIND_WORD[t.kind] || String(t.kind), KIND_TONE[t.kind] || 'plain', { title: t.confirm ? 'This tool asks before it runs' : null }),
      h('button.linkish', { type: 'button', title: `Edit or delete "${t.name}"`, onclick: () => edit(ctx, t) }, 'Edit')));
}

function drawTools(ctx) {
  if (!view) return;
  const { store } = ctx;
  const project = projectOf(ctx);
  const projects = store.list('projects');
  // (the check command is part of the signature: the "Run checks" tool carries it, so the tools are fetched again when the plan sets it)
  const headSig = [project && project.id, project && project.name, project && project.path, project && project.checkCmd, projects.map((p) => p.id + p.name).join()].join('|');
  if (view.headSig !== headSig) {
    view.headSig = headSig;
    const pick = projects.length > 1 ? ui.select(projects.map((p) => ({ value: p.id, label: `${p.name} (${p.id})` })), project ? project.id : '', { 'aria-label': 'Project', onchange: () => { keep.projectId = pick.select.value; drawTools(ctx); load(ctx); } }) : null;
    mount(view.head, project ? [
      h('div.tw-title',
        h('p.panel-lead', { style: { margin: 0 } }, 'One-click shortcuts for ', h('span.strong', String(project.name)), '.'),
        pick ? h('div.tw-pick', pick) : ui.chip(String(project.name), 'plain'))] : null);
  }
  const tools = project ? toolsOf(project.id) : null;
  const state = !project ? 'none' : tools ? 'ok' : view.error ? 'err:' + view.error : 'wait';
  if (view.state !== state) {
    view.state = state;
    mount(view.note, !project ? ui.emptyState('No project tools yet', 'Tools belong to a project. Start a work order first to set up its tool wall.', ui.btn('+ Work order', { tone: 'go', onClick: () => ctx.openPanel('workorder') }))
      : tools ? null : view.error ? h('div.callout.bad', h('div.callout-title', 'The tools did not load'), h('p', String(view.error)), ui.btn('Try again', { small: true, onClick: () => load(ctx) })) : h('p.dim', 'Loading tools...'));
  }
  view.grid.hidden = !tools;
  if (!tools) return;
  const add = { id: '\u0000add' }; // the "+" tile is the last one
  keyed(view.grid, [...tools, add], { key: (t) => t.id, sig: (t) => (t === add ? 'add' : toolSig(t)),
    render: (t) => (t === add ? h('div.tw-tile', h('button.tw-tool.tw-add', { type: 'button', title: 'Add a tool to this wall', onclick: () => edit(ctx, null) }, h('span.tw-icon.tw-letter', { 'aria-hidden': 'true' }, '+'), h('span.tw-name', 'Add tool'))) : toolNode(ctx, t)) });
}

async function load(ctx) {
  const project = projectOf(ctx);
  if (!view || !project) return;
  const pid = project.id;
  const res = await ctx.api.get(`/api/projects/${enc(pid)}/toolkit`, { quiet: true, throws: true }).catch((e) => ({ failed: (e && e.message) || 'The hub does not answer.' }));
  if (!view) return;
  if (Array.isArray(res)) { keep.tools.set(pid, res); view.error = null; } else if (!toolsOf(pid)) view.error = (res && res.failed) || 'The hub sent no tool list.';
  view.state = null;
  drawTools(ctx);
}

function editHarnessModal(ctx, harnesses, item) {
  const existing = item || {
    id: '', label: '', summary: '', roleHint: 'maker', domains: ['backend'], platforms: ['node'],
    tools: ['read_file', 'write_file', 'edit_file', 'list_dir', 'search_text', 'run_shell', 'shop_mcp'],
    protocol: { workflow: ['Inspect callers first.', 'Run checks before DONE.'], systemPromptAddon: '' },
    rft: { status: 'phase1_ready', rewardSignals: ['check_cmd_exit_zero', 'diff_minimality'], evalSuite: 'suites/custom-v0', notes: '' },
  };
  const fId = h('input', { type: 'text', value: String(existing.id || ''), placeholder: 'custom-rig', readOnly: !!item });
  const fLabel = h('input', { type: 'text', value: String(existing.label || ''), placeholder: 'Custom Specialist Rig' });
  const fRole = ui.select([{ value: 'maker', label: 'Specialist (maker)' }, { value: 'manager', label: 'Team Lead (manager)' }], existing.roleHint || 'maker');
  const fDom = h('input', { type: 'text', value: (existing.domains || []).join(', '), placeholder: 'backend, fix' });
  const fTools = h('input', { type: 'text', value: (existing.tools || []).join(', '), placeholder: 'read_file, write_file, edit_file, list_dir, search_text, run_shell, shop_mcp' });
  const fSum = h('textarea', { rows: 2, value: String(existing.summary || ''), placeholder: 'What this harness equips a specialist to do.' });
  const fPrompt = h('textarea', { rows: 3, value: String((existing.protocol && existing.protocol.systemPromptAddon) || ''), placeholder: 'System prompt addendum injected into .shop/HARNESS.md' });
  const fEval = h('input', { type: 'text', value: String((existing.rft && existing.rft.evalSuite) || 'suites/custom-v0') });
  const fields = { id: ui.field('Id', fId), label: ui.field('Label', fLabel), role: ui.field('Role', fRole), dom: ui.field('Domains (comma-separated)', fDom), tools: ui.field('Tools', fTools), sum: ui.field('Summary', fSum), prompt: ui.field('Prompt addendum', fPrompt), evalSuite: ui.field('Phase 1 Eval Suite', fEval) };
  const splitCsv = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  const buttons = [];
  if (item && harnesses.length > 1) buttons.push({ label: 'Delete', tone: 'danger', run: async () => {
    if (!(await ctx.confirm({ title: `Remove "${item.label}"?`, text: 'Remove this harness from the rack?', okLabel: 'Remove', danger: true }))) return false;
    const res = await ctx.api.del(`/api/harnesses/${enc(item.id)}`);
    if (!res) return false;
    const fresh = await ctx.api.get('/api/harnesses', { quiet: true });
    if (fresh) ctx.store.set('harnesses', fresh);
    ctx.toast(`${item.label} removed from rack.`);
    return true;
  } });
  buttons.push({ label: 'Cancel', value: false }, { label: item ? 'Save harness' : 'Add to rack', primary: true, run: async () => {
    const payload = {
      ...existing,
      id: fId.value.trim(),
      label: fLabel.value.trim(),
      roleHint: fRole.select.value,
      summary: fSum.value.trim(),
      domains: splitCsv(fDom.value),
      tools: splitCsv(fTools.value),
      protocol: { ...(existing.protocol || {}), workflow: (existing.protocol && existing.protocol.workflow) || ['Run checks before DONE.'], systemPromptAddon: fPrompt.value.trim() },
      rft: { ...(existing.rft || {}), status: (existing.rft && existing.rft.status) || 'phase1_ready', evalSuite: fEval.value.trim() },
    };
    const res = await ctx.api.post('/api/harnesses', payload);
    if (!res) return false;
    const fresh = await ctx.api.get('/api/harnesses', { quiet: true });
    if (fresh) ctx.store.set('harnesses', fresh);
    ctx.toast(`${payload.label} saved to rack.`);
    return true;
  } });
  ctx.modal({ title: item ? `Edit harness: ${item.label}` : 'Add harness to rack', wide: true, buttons,
    body: h('div.tw-form', fields.id, fields.label, fields.role, fields.dom, fields.sum, fields.tools, fields.prompt, fields.evalSuite) });
}

function drawRack(ctx) {
  if (!view || !view.rackBox) return;
  const harnesses = Array.isArray(ctx.store.harnesses) ? ctx.store.harnesses : [];
  const sig = JSON.stringify(harnesses);
  if (view.rackSig === sig) return;
  view.rackSig = sig;
  const preview = (item) => {
    const wf = (item.protocol && item.protocol.workflow) || [];
    const rewards = (item.rft && item.rft.rewardSignals) || [];
    ctx.modal({ title: `.shop/HARNESS.md · ${item.label}`, wide: true, buttons: [{ label: 'Close', primary: true, tone: 'steel' }],
      body: h('div.stack',
        h('p', String(item.summary || '')),
        h('div.hr-meta', ui.chip(item.id, 'dark'), ui.chip(item.roleHint === 'manager' ? 'Team Lead' : 'Specialist', 'plain'), ...(item.domains || []).map((d) => ui.domainChip(d))),
        item.protocol && item.protocol.systemPromptAddon ? h('pre.term', String(item.protocol.systemPromptAddon)) : null,
        wf.length ? [h('div.caps', 'Workflow'), h('ul.list', wf.map((s) => h('li.li', String(s))))] : null,
        h('div.caps', 'Tools'),
        h('div.hr-meta', ...(item.tools || []).map((t) => ui.chip(String(t), 'blue'))),
        rewards.length ? [h('div.caps', 'Phase 1 RFT Rewards'), h('div.hr-meta', ...rewards.map((r) => ui.chip(String(r), 'amber')))] : null,
        item.rft && item.rft.notes ? h('p.dim', String(item.rft.notes)) : null) });
  };
  const iconFor = { backend: 'wrench', fix: 'bug', frontend: 'star', test: 'gauge', data: 'search', algo: 'bolt', research: 'book', plan: 'clipboard' };
  mount(view.rackBox,
    h('p.panel-lead', 'Open-weight specialist rigs injected as ', h('span.code', '.shop/HARNESS.md'), ' into task benches and paired with Phase 1 RFT reward specs.'),
    harnesses.length ? h('div.hr-grid', harnesses.map((item) => {
      const firstDom = (item.domains || [])[0];
      const toolsCount = Array.isArray(item.tools) ? item.tools.length : 0;
      return h('article.hr-card', { dataset: { harness: item.id } },
        h('div.hr-cardhead', iconEl(iconFor[firstDom] || 'wrench', item.label),
          h('div.hr-cardhead-main',
            h('span.strong', String(item.label || item.id)),
            ui.chip(item.roleHint === 'manager' ? 'Team Lead' : 'Specialist', 'plain'))),
        h('p.hr-summary', String(item.summary || '')),
        (item.domains || []).length ? h('div.hr-meta', ...(item.domains || []).map((d) => ui.domainChip(d))) : null,
        h('div.dim', `${fmt.plural(toolsCount, 'tool')} · ${item.id}`),
        h('div.hr-acts', ui.btn('Inspect', { small: true, onClick: () => preview(item) }), ui.btn('Edit', { small: true, onClick: () => editHarnessModal(ctx, harnesses, item) })));
    })) : ui.emptyState('Harness Rack is empty', 'Add a specialist harness rig to inject tools and protocols into open-weight benches.'));
}

function render(container, ctx) {
  if (!keep.wired) { keep.wired = true; ctx.store.on('toolrun', onRun); } // once per window: a run goes on while the drawer is closed
  const tab = ctx.params.tab === 'tools' ? 'tools' : 'rack';
  const tabs = h('div.panel-tabs',
    ui.segmented([
      { value: 'rack', label: 'Harness Rack', title: 'Specialist rigs injected as .shop/HARNESS.md' },
      { value: 'tools', label: 'Project Tools', title: 'Per-project shell commands, saved orders, and board asks' },
    ], tab, (v) => ctx.setParams({ tab: v })),
    tab === 'rack' ? ui.btn('+ New harness', { small: true, tone: 'go', onClick: () => editHarnessModal(ctx, Array.isArray(ctx.store.harnesses) ? ctx.store.harnesses : [], null) }) : null);
  view = { tab, head: h('div.tw-head'), note: h('div'), grid: h('div.tw-grid', { hidden: true }), runs: h('div.tw-log'), rackBox: h('div'), rackSig: null, headSig: null, state: null, runSig: null, runList: null, error: null };
  container.append(tabs);
  if (tab === 'rack') {
    container.append(view.rackBox);
    drawRack(ctx);
  } else {
    container.append(view.head, view.note, view.grid, view.runs);
    drawTools(ctx);
    drawRuns();
    load(ctx);
  }
}

export { iconEl, editHarnessModal };

export function previewHarnessModal(ctx, item) {
  const wf = (item.protocol && item.protocol.workflow) || [];
  const rewards = (item.rft && item.rft.rewardSignals) || [];
  ctx.modal({ title: `.shop/HARNESS.md · ${item.label}`, wide: true, buttons: [{ label: 'Close', primary: true, tone: 'steel' }],
    body: h('div.stack',
      h('p', String(item.summary || '')),
      h('div.hr-meta', ui.chip(item.id, 'dark'), ui.chip(item.roleHint === 'manager' ? 'Team Lead' : 'Specialist', 'plain'), ...(item.domains || []).map((d) => ui.domainChip(d))),
      item.protocol && item.protocol.systemPromptAddon ? h('pre.term', String(item.protocol.systemPromptAddon)) : null,
      wf.length ? [h('div.caps', 'Workflow'), h('ul.list', wf.map((s) => h('li.li', String(s))))] : null,
      h('div.caps', 'Tools'),
      h('div.hr-meta', ...(item.tools || []).map((t) => ui.chip(String(t), 'blue'))),
      rewards.length ? [h('div.caps', 'RL Reward Signals'), h('div.hr-meta', ...rewards.map((r) => ui.chip(String(r), 'amber')))] : null,
      item.rft && item.rft.notes ? h('p.dim', String(item.rft.notes)) : null) });
}

export function mountProjectToolsSection(container, ctx) {
  if (!keep.wired) { keep.wired = true; ctx.store.on('toolrun', onRun); }
  view = { tab: 'tools', head: h('div.tw-head'), note: h('div'), grid: h('div.tw-grid', { hidden: true }), runs: h('div.tw-log'), rackBox: h('div'), rackSig: null, headSig: null, state: null, runSig: null, runList: null, error: null };
  container.append(view.head, view.note, view.grid, view.runs);
  drawTools(ctx);
  drawRuns();
  load(ctx);
  return {
    update() {
      if (!view) return;
      const c = ctx.changes;
      if (c.has('projects') || c.has('jobs') || c.has('state')) {
        const before = view.headSig;
        drawTools(ctx);
        if (view.headSig !== before || c.has('state')) load(ctx);
      }
    },
    dispose() { view = null; },
  };
}

export default {
  id: 'toolkit',
  title: 'Harnesses & Toolkit',
  label: 'Harnesses',
  short: 'Rack',
  render,
  update(ctx) {
    if (!view) return;
    const c = ctx.changes;
    if (view.tab === 'rack') {
      if (c.has('harnesses') || c.has('state')) drawRack(ctx);
      return;
    }
    if (c.has('projects') || c.has('jobs') || c.has('state')) {
      const before = view.headSig;
      drawTools(ctx);
      if (view.headSig !== before || c.has('state')) load(ctx); // another project is on the floor, or the hub came back
    }
  },
  dispose() { view = null; },
};
