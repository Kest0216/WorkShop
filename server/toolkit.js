// Toolkit: one-click owner tools per project (contract section 12c).
//
// Only the owner creates, edits and runs tools (owner routes behind the cookie). Agents never get them.
//
//   Tool { id, name, icon, kind:'command'|'order'|'ask', command?, order?:{ title, brief, kind, crew }, ask?:{ to:'@boss'|'@mgr', body },
//          confirm:boolean, action?:'check'|'reveal' }
//   action 'check':  "Run checks". The command is the project's current checkCmd (filled in by list()).
//   action 'reveal': "Open folder". Finder through the injected reveal(path); no shell.
//
//   createToolkit({ store, dataDir, shellEnv, orch, git, redactor, log, getSettings?, reveal?, now? }) -> toolkit
//   toolkit.list(projectId) -> Promise<Tool[]>
//   toolkit.save(projectId, tools) -> Promise<Tool[]>
//   toolkit.run(projectId, toolId) -> Promise<{ ok, runId?, jobId?, msgId? }>
//   toolkit.running() -> [runId] ; toolkit.idle() -> Promise (all command runs settled; for shutdown and tests)
//
// Command tools run in the project folder through git.runCheck: the agent environment allow list (clean
// environment, login PATH), the check sandbox profile in safety 'sandboxed', a 10 min timeout and redacted output
// capped at 200 KB. Output streams out as transient `toolrun` events: { runId, toolId, chunk } (the '$ cmd' line, then
// whole lines as they come) and last { runId, toolId, done, code }.
// Tools are stored in <dataDir>/toolkit/<projectId>.json (dir 0700, file 0600, atomic rename).

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
export const OUTPUT_CAP = 200 * 1024;
export const MAX_TOOLS = 40;
const KINDS = ['command', 'order', 'ask'];
const ORDER_KINDS = ['build', 'fix', 'research'];
const ASK_TO = ['@boss', '@mgr'];
const ACTIONS = ['check', 'reveal'];
const LIVE = ['planning', 'plan_review', 'running', 'qa', 'delivering', 'paused'];
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const PROJECT_RE = /^P[1-9][0-9]{0,8}$/;
const noop = () => {};

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** The four tools every project starts with. */
export function starterTools() {
  return [
    { id: 'check', name: 'Run checks', icon: 'gauge', kind: 'command', action: 'check', command: '', confirm: true },
    { id: 'folder', name: 'Open folder', icon: 'folder', kind: 'command', action: 'reveal', command: '', confirm: false },
    { id: 'status', name: 'Status report', icon: 'clipboard', kind: 'ask', ask: { to: '@boss', body: 'Report what was finished today and what is slow.' }, confirm: false },
    { id: 'blocked', name: 'What is blocked?', icon: 'wrench', kind: 'ask', ask: { to: '@boss', body: 'List every blocked task and what it waits for.' }, confirm: false },
  ];
}

/** One tool from the owner, checked and normalized. Throws Error{status:400} with a plain message. */
export function normalizeTool(input, index = 0) {
  const where = `Tool ${index + 1}`;
  if (!isObj(input)) throw httpError(400, `${where} must be an object.`);
  const id = input.id == null || input.id === '' ? `t${randomBytes(3).toString('hex')}` : String(input.id);
  if (!ID_RE.test(id)) throw httpError(400, `${where}: the id may hold letters, digits, dash and underscore only (at most 40).`);
  const name = str(input.name);
  if (!name || name.length > 60) throw httpError(400, `${where}: the name must have 1 to 60 characters.`);
  const icon = str(input.icon) || 'wrench';
  if (icon.length > 24 || !/^[a-z0-9_-]+$/i.test(icon)) throw httpError(400, `${where}: the icon must be a short word.`);
  if (!KINDS.includes(input.kind)) throw httpError(400, `${where}: kind must be command, order or ask.`);
  const tool = { id, name, icon, kind: input.kind, confirm: input.confirm === true };
  if (input.kind === 'command') {
    const action = input.action == null || input.action === '' ? null : String(input.action);
    if (action !== null && !ACTIONS.includes(action)) throw httpError(400, `${where}: action must be check or reveal.`);
    if (action) {
      tool.action = action;
      tool.command = '';
    } else {
      const command = typeof input.command === 'string' ? input.command.trim() : '';
      if (!command) throw httpError(400, `${where}: a command tool needs a command.`);
      if (command.length > 2000) throw httpError(400, `${where}: the command is longer than 2000 characters.`);
      if (command.includes('\0')) throw httpError(400, `${where}: the command holds a NUL character.`);
      tool.command = command;
    }
  } else if (input.kind === 'order') {
    const o = isObj(input.order) ? input.order : null;
    if (!o) throw httpError(400, `${where}: an order tool needs { order: { title, brief, kind, crew } }.`);
    const title = str(o.title);
    const brief = str(o.brief);
    if (!title || title.length > 120) throw httpError(400, `${where}: the order title must have 1 to 120 characters.`);
    if (!brief || brief.length > 20000) throw httpError(400, `${where}: the order needs a brief (at most 20000 characters).`);
    const kind = o.kind == null || o.kind === '' ? 'build' : o.kind;
    if (!ORDER_KINDS.includes(kind)) throw httpError(400, `${where}: the order kind must be build, fix or research.`);
    let crew = o.crew == null || o.crew === '' ? null : o.crew;
    if (crew !== null && typeof crew !== 'string' && !isObj(crew)) throw httpError(400, `${where}: crew must be a preset name or { bosses, managers, makers }.`);
    if (isObj(crew)) {
      const c = {};
      for (const k of ['bosses', 'managers', 'makers']) {
        const n = Number(crew[k]);
        if (!Number.isInteger(n) || n < 0 || n > 8) throw httpError(400, `${where}: crew.${k} must be a whole number from 0 to 8.`);
        c[k] = n;
      }
      crew = c;
    }
    tool.order = { title, brief, kind, crew };
    if (o.budgetUsd != null && o.budgetUsd !== '') {
      const b = Number(o.budgetUsd);
      if (!Number.isFinite(b) || b <= 0) throw httpError(400, `${where}: the order budget must be a number above 0.`);
      tool.order.budgetUsd = b;
    }
  } else {
    const a = isObj(input.ask) ? input.ask : null;
    if (!a) throw httpError(400, `${where}: an ask tool needs { ask: { to, body } }.`);
    const to = a.to == null || a.to === '' ? '@boss' : a.to;
    if (!ASK_TO.includes(to)) throw httpError(400, `${where}: ask.to must be @boss or @mgr.`);
    const body = str(a.body);
    if (!body || body.length > 600) throw httpError(400, `${where}: the message must have 1 to 600 characters.`);
    tool.ask = { to, body };
  }
  return tool;
}

export function createToolkit({ store, dataDir, shellEnv, orch, git, redactor, log = noop, getSettings = () => ({}), reveal = null, now = Date.now } = {}) {
  if (!store) throw new TypeError('createToolkit needs store');
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('createToolkit needs dataDir');
  const say = typeof log === 'function' ? log : noop;
  const dir = path.join(dataDir, 'toolkit');
  const runs = new Map(); // runId -> { toolId, projectId, promise }
  const busyTool = new Set(); // `${projectId}/${toolId}` with a command run in progress
  let writing = Promise.resolve();
  void shellEnv; // the clean environment and login PATH come from gitops (runCheck), which owns the child process

  function project(projectId) {
    if (typeof projectId !== 'string' || !PROJECT_RE.test(projectId)) throw httpError(404, `Unknown project ${projectId}.`);
    const p = store.get('projects', projectId);
    if (!p) throw httpError(404, `Unknown project ${projectId}.`);
    return p;
  }

  const fileOf = (projectId) => path.join(dir, `${projectId}.json`);

  async function readTools(projectId) {
    let text;
    try {
      text = await fs.readFile(fileOf(projectId), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    try {
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : isObj(data) && Array.isArray(data.tools) ? data.tools : null;
      if (!list) throw new Error('no tool list');
      const out = [];
      list.forEach((t, i) => { try { out.push(normalizeTool(t, i)); } catch { say('warn', 'toolkit: a stored tool is skipped', { projectId, index: i }); } });
      return out;
    } catch (err) {
      say('warn', 'toolkit: the tool file is broken; the starter tools are used', { projectId, error: err.message });
      await fs.rename(fileOf(projectId), `${fileOf(projectId)}.bak`).catch(noop);
      return null;
    }
  }

  function writeTools(projectId, tools) {
    const job = writing.then(async () => {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = `${fileOf(projectId)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify({ v: 1, tools }, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(tmp, fileOf(projectId));
    });
    writing = job.catch(noop);
    return job;
  }

  /** What the panel shows: the check tool carries the project's current check command. */
  function present(p, tools) {
    return tools.map((t) => (t.action === 'check' ? { ...t, command: p.checkCmd || '' } : { ...t }));
  }

  async function stored(projectId) {
    const p = project(projectId);
    let tools = await readTools(projectId);
    if (tools === null) {
      tools = starterTools();
      await writeTools(projectId, tools);
    }
    return { p, tools };
  }

  async function list(projectId) {
    const { p, tools } = await stored(projectId);
    return present(p, tools);
  }

  async function save(projectId, tools) {
    const p = project(projectId);
    if (!Array.isArray(tools)) throw httpError(400, 'Send { tools: [...] }.');
    if (tools.length > MAX_TOOLS) throw httpError(400, `A project holds at most ${MAX_TOOLS} tools.`);
    const out = tools.map((t, i) => normalizeTool(t, i));
    const seen = new Set();
    for (const t of out) {
      if (seen.has(t.id)) throw httpError(400, `Two tools have the id ${t.id}.`);
      seen.add(t.id);
    }
    await writeTools(projectId, out);
    return present(p, out);
  }

  function emit(payload) {
    try { store.emit('toolrun', payload, { persist: false }); } catch (err) { say('warn', 'toolkit: event not sent', { error: err.message }); }
  }

  function clean(text) {
    let t = String(text ?? '');
    try { if (redactor && typeof redactor.redact === 'function') t = redactor.redact(t); } catch { /* the tail is already redacted by gitops */ }
    if (t.length > OUTPUT_CAP) t = `[output cut to the last ${OUTPUT_CAP} bytes]\n${t.slice(-OUTPUT_CAP)}`;
    return t;
  }

  function startCommand(p, tool, command) {
    if (!git || typeof git.runCheck !== 'function') throw httpError(503, 'The hub cannot run commands now.');
    const key = `${p.id}/${tool.id}`;
    if (busyTool.has(key)) throw httpError(409, `${tool.name} is already running.`);
    const runId = `run_${randomBytes(6).toString('hex')}`;
    busyTool.add(key);
    const startedAt = now();
    emit({ runId, toolId: tool.id, chunk: clean(`$ ${command}\n`) });
    const promise = (async () => {
      let code = -1;
      try {
        // Streamed (section 12c): gitops hands over whole redacted lines as they come, at most OUTPUT_CAP in all.
        let streamed = false;
        const onOutput = (text) => { streamed = true; emit({ runId, toolId: tool.id, chunk: clean(text) }); };
        const r = await git.runCheck(p.path, command, { timeoutMs: COMMAND_TIMEOUT_MS, onOutput, maxStreamChars: OUTPUT_CAP });
        code = typeof r?.code === 'number' ? r.code : r?.ok ? 0 : 1;
        // A git without streaming (or a command that printed nothing but a hub note) still shows its tail once.
        if (!streamed && r?.tail) emit({ runId, toolId: tool.id, chunk: clean(r.tail) });
        else if (streamed && /\n\[(stopped|could not start)[^\n]*\]\n?$/.test(r?.tail ?? '')) emit({ runId, toolId: tool.id, chunk: clean(r.tail.slice(r.tail.lastIndexOf('\n['))) });
      } catch (err) {
        emit({ runId, toolId: tool.id, chunk: clean(`[the command did not run: ${err?.message || 'error'}]\n`) });
      } finally {
        busyTool.delete(key);
        runs.delete(runId);
        emit({ runId, toolId: tool.id, done: true, code });
        say('info', 'toolkit: command finished', { projectId: p.id, toolId: tool.id, code, ms: now() - startedAt });
      }
    })();
    runs.set(runId, { toolId: tool.id, projectId: p.id, promise });
    return { ok: true, runId };
  }

  function liveJob(projectId) {
    const jobs = store.list('jobs', (j) => j.projectId === projectId && LIVE.includes(j.status));
    jobs.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return jobs.at(-1) || null;
  }

  async function run(projectId, toolId) {
    const { p, tools } = await stored(projectId);
    const tool = tools.find((t) => t.id === toolId);
    if (!tool) throw httpError(404, `Unknown tool ${toolId}.`);
    if (tool.kind === 'command') {
      if (tool.action === 'reveal') {
        if (typeof reveal !== 'function') throw httpError(503, 'Finder cannot be opened from this hub.');
        await reveal(p.path);
        return { ok: true };
      }
      const command = tool.action === 'check' ? String(p.checkCmd || '').trim() : tool.command;
      if (!command) throw httpError(409, 'The project has no check command yet. The plan sets it.');
      return startCommand(p, tool, command);
    }
    if (tool.kind === 'order') {
      if (!orch || typeof orch.createJob !== 'function') throw httpError(503, 'The hub cannot start jobs now.');
      let budget = tool.order.budgetUsd;
      if (budget == null) {
        try { const s = getSettings() || {}; if (typeof s.budgetUsd === 'number') budget = s.budgetUsd; } catch { /* no default */ }
      }
      const order = {
        title: tool.order.title,
        brief: tool.order.brief,
        kind: tool.order.kind,
        project: { mode: 'existing', path: p.path, agentFilesAck: p.agentFilesAck === true },
        crew: tool.order.crew ?? undefined,
        options: {},
      };
      if (budget != null) order.budgetUsd = budget;
      const job = await orch.createJob(order);
      return { ok: true, jobId: job?.id ?? null };
    }
    // ask: a REQ from @human to the lead boss or a manager of the running job.
    if (!orch || typeof orch.ownerPost !== 'function') throw httpError(503, 'The hub cannot post now.');
    const job = liveJob(p.id);
    if (!job) throw httpError(409, 'No job runs on this project. Start a work order first.');
    const r = await orch.ownerPost({ jobId: job.id, kind: 'REQ', to: tool.ask.to, scope: '#plan', body: tool.ask.body });
    if (!r || r.ok === false) throw httpError(400, r?.hint ? `${r.code || 'ERR'}: ${r.hint}` : 'The board refused the message.');
    return { ok: true, msgId: r.msg?.id ?? null, jobId: job.id };
  }

  return {
    list,
    save,
    run,
    running: () => [...runs.keys()],
    idle: () => Promise.all([...runs.values()].map((r) => r.promise)).then(noop),
  };
}
