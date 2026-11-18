#!/usr/bin/env node
// WorkShop UI stub hub.
//
// A zero-dependency stand-in for the real hub, for UI development and screenshots.
// It serves ../../ui and implements the endpoints of docs/ARCHITECTURE.md section 6 in memory,
// in the contract shapes (sections 4, 5, 7, 10, 12b, 14b), with a scripted, looping simulation of one job.
//
//   node tests/ui-stub/server.mjs --port 8911 [--speed 2] [--scenario truck] [--auth] [--named-events] [--arrays] [--child]
//
//   --auth   enforce the owner key like the real hub: the ready line then carries #k=<key>, and every /api route
//            answers 401 without the session cookie. Without it the stub needs no key (plain URLs work for screenshots).
//   --child  stop when stdin closes: a test started the stub through a pipe and has ended (or died).
//
// Scenario shortcuts (GET, no header needed):
//   /__stub/goto/<name>   jumps to a named moment and pauses the simulation there:
//       empty        no job yet
//       planning     the bosses draft the plan
//       plan_review  the plan waits for the owner's approval
//       running      a busy floor: crates on the truck, a review in progress, makers at work
//       question     a boss asked the owner something
//       loaded       3 crates are loaded while the job still runs (the owner may ship early)
//       truck        the job is in "delivering": the truck waits for the owner (the same moment as "delivering")
//       delivering   see truck
//       done         everything shipped
//       paused       the owner paused the job
//       cancelled    a cancelled job with 3 crates left on the truck (ship or discard)
//       stranded     that cancelled job, and a newer job on the floor that holds crates too: the Truck panel must reach both trucks
//       queued       a job on the floor and a second work order that waits behind it
//       inbox        one of everything that waits for the owner: a question, a hand-in that needs the owner's verdict,
//                    a failed requirement that no task serves, agent-config files to accept, a lab to set up
//       stress       14 agents, 60 tasks, 2000 board posts, logs streaming
//       loop         the default: one job after the other, for ever
//   /__stub/pause  /__stub/resume  /__stub/step/<n>  /__stub/speed/<factor>
//   /__stub/notice?level=owner&text=...[&panel=truck]   /__stub/fx/<name>   /__stub/drop   /__stub/offline/<ms>   /__stub/info
//   /__stub/lab/<id>/<state>   missing | installed | signedin | ready | cooling     (lab setup states for the strip and the Keys panel)
//   /__stub/lab/<id>/terminal  the owner finished the sign-in of this lab in Terminal. The hub does not know it until POST .../check:
//                              /detect never runs the Google CLI, so "Re-check" through /detect changes nothing (as in the real hub)
//   /__stub/behind/<n>         the target branch moved by n commits: the next ship refreshes the truck first
//   /__stub/lag/<ms>           GET /api/jobs/:id/truck answers this much later (what does the panel do while the truck loads?)
//   /__stub/default            the hub takes the default of the open owner question (as it does when the owner is away)
//   /__stub/hubpause/<reason>  the hub pauses the job: budget | caps | qa | baseline | stalled | tampered | error
//   /__stub/hold/<lab>         no lab is usable: the job shows job.hold (clear it with /__stub/hold/off)
//   /__stub/review             the next hand-in in review waits for the owner's verdict (the reviewers are used up)
//   /__stub/reqfail            QA fails a requirement that no open task serves
//   /__stub/reqopen            an open requirement that no task serves: the lead boss made no task for an owner change
//   /__stub/agentfiles         the project of the job holds agent-config files that the owner has not accepted
//   /__stub/report/hostile     the report of the job becomes hostile text: markup, lines that made the old report parser very slow,
//                              a 6 KB line, 5,000 tiny blocks (the report is written by a boss, so the UI must not trust it)
//
// A new job (POST /api/jobs, POST /api/demo, an "order" tool) waits in the queue while another job is active, as the contract
// says (section 4). It starts when that job is done or cancelled. Use /__stub/goto/empty first to start one at once.
//
// Where the contract leaves something open, the stub does what the hub on disk does (server/), so the UI meets it here first:
//   - GET /api/jobs/:id/truck lists "deliveries" by delivery id (the order of the hand-ins), not in the order they were merged.
//     Each loaded delivery carries loadedAt. One review of the script is slow, so the two orders differ on the truck.
//   - POST /api/providers/:id/login answers the same three plain steps for every lab.
//   - The inbox lists a requirement that no task serves when it is failed and also when it is open.
// --port 0 takes any free port: the ready line says which (tests/ui-stub/stub.test.mjs starts the stub this way).
//
// Nothing here is the contract. The contract is docs/ARCHITECTURE.md.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(HERE, '../../ui');
const MODELS_FILE = path.resolve(HERE, '../../config/models.json');
const HARNESSES_FILE = path.resolve(HERE, '../../config/harnesses.json');
const ROSTER_FILE = path.resolve(HERE, '../../config/roster.json');

// ------------------------------------------------------------------ args

const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
if (arg('help', false)) {
  console.log('usage: node tests/ui-stub/server.mjs --port 8911 [--speed 2] [--scenario <name>] [--auth] [--named-events] [--arrays] [--child] [--hb-ms 5000]');
  process.exit(0);
}
const HOST = '127.0.0.1';
let PORT = Number(arg('port', 8911)); // 0: any free port; set to the real one when the server listens
let SPEED = Math.max(0.1, Number(arg('speed', 1)) || 1);
const AUTH = arg('auth', false) === true;                 // enforce the owner key and the session cookie
const NAMED_EVENTS = arg('named-events', false) === true; // send "event: <type>" lines (the real hub sends none)
const ARRAYS = arg('arrays', false) === true;             // serve state collections as arrays (the real hub sends objects by id)
const START_SCENARIO = String(arg('scenario', 'loop'));
const TICK_MS = 700;
const HB_MS = Math.max(50, Number(arg('hb-ms', 5000)) || 5000); // heartbeat period (tests pass a short one)
const FF_STEP_MS = 5000;        // pretend time per step while fast-forwarding to a scenario
const AUTO_SHIP_TICKS = 90;     // loop mode: ship by itself after this many ticks so the demo loops
const DONE_LINGER_TICKS = 45;   // loop mode: restart this many ticks after "done"
const QUESTION_WAIT_TICKS = 70; // live mode: the hub takes the default of an owner question after this many ticks
const OWNER_KEY = randomBytes(32).toString('hex');
const sessions = new Set();

// ------------------------------------------------------------------ small helpers

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function mulberry32(a) {
  return function rnd() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
const plural = (n, w, many) => `${n} ${n === 1 ? w : many || w + 's'}`;
const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = (ts) => { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch)) if (k !== '__proto__' && k !== 'constructor' && k !== 'prototype') out[k] = deepMerge(out[k], v);
  return out;
}

// ------------------------------------------------------------------ store (contract section 5)

const KINDS = ['projects', 'jobs', 'tasks', 'agents', 'deliveries'];
let S;                    // { v, seq, counters, projects, jobs, tasks, agents, deliveries }
let board = [];           // Message[] (contract section 7)
let byMsgId = new Map();
let boardSeq = 0;
let bubbleSeq = 0;
let ring = [];            // persisted events for the ?since= / Last-Event-ID replay
let agentLogs = new Map();// agentId -> [{k,s}]
let fileMeta = new Map(); // deliveryId -> [{path,add,del,kind,from}]  (kind is stub-internal, never sent)
let toolkits = new Map(); // projectId -> Tool[]
let queuedOrders = new Map();  // jobId -> the order of a job that waits in the queue
let ownerReviews = new Set();  // delivery ids that wait for the owner's verdict (stub-internal)
let filesAnswered = new Set(); // project ids whose agent-config files the owner accepted or refused (stub-internal)
let lostReqs = new Set();      // `${jobId}/${reqId}`: requirements that no task serves (failed in QA, or open with no task), until the owner settles them (stub-internal)
let waitSince = new Map();     // inbox item key -> when it first waited
let toolRuns = new Set();      // `${projectId}/${toolId}` of command tools that run now
let hardStopped = new Map();   // agent id -> the status of a turn that a hard pause stopped
let presenceAt = Date.now();
let lastLoadAt = 0;            // loadedAt of the newest crate (stub-internal)
let truckLagMs = 0;            // GET /api/jobs/:id/truck answers this much later (/__stub/lag/<ms>)
const clients = new Set();
let muted = false;        // true while fast-forwarding: nothing is written to SSE
let ffClock = null;
let offlineUntil = 0;

const now = () => (ffClock === null ? Date.now() : Math.min(Date.now(), ffClock));

function freshState() {
  S = { v: 1, seq: 0, counters: { P: 0, J: 0, T: 0, A: 0, D: 0, R: 0 }, projects: {}, jobs: {}, tasks: {}, agents: {}, deliveries: {} };
  board = []; byMsgId = new Map(); boardSeq = 0; bubbleSeq = 0; ring = []; agentLogs = new Map(); fileMeta = new Map(); toolkits = new Map();
  queuedOrders = new Map(); ownerReviews = new Set(); filesAnswered = new Set(); lostReqs = new Set(); waitSince = new Map(); toolRuns = new Set(); hardStopped = new Map();
  lastLoadAt = 0; truckLagMs = 0;
}

function sseWrite(res, seq, type, json) {
  res.write(`id: ${seq}\n${NAMED_EVENTS ? `event: ${type}\n` : ''}data: ${json}\n\n`);
}

function emit(type, payload, { persist = true } = {}) {
  const evt = { type, ...payload, seq: ++S.seq, ts: now() };
  if (muted) return evt;
  const json = JSON.stringify(evt);
  if (persist) { ring.push({ seq: evt.seq, type, json }); if (ring.length > 5200) ring.splice(0, 200); }
  for (const res of clients) sseWrite(res, evt.seq, type, json);
  return evt;
}

function nextId(k) { return k + ++S.counters[k]; }
function put(kind, item) {
  const t = now();
  if (!item.createdAt) item.createdAt = t;
  item.updatedAt = t;
  S[kind][item.id] = item;
  emit('upsert', { kind, item });
  return item;
}
function remove(kind, id) { if (S[kind][id]) { delete S[kind][id]; emit('remove', { kind, id }); } }
const all = (kind, fn) => Object.values(S[kind]).filter(fn || (() => true));
const num = (id) => Number(String(id).slice(1));
const byId = (a, b) => num(a.id) - num(b.id);

function dropClients() { for (const res of clients) { try { res.end(); } catch { /* gone */ } } clients.clear(); }

// ------------------------------------------------------------------ board: ShopTalk messages (contract section 7)

const POST_KINDS = ['ASK', 'ANS', 'REQ', 'OK', 'NO', 'INFO', 'BLOCK', 'DONE', 'FAIL', 'PASS', 'FIX', 'DECIDE', 'CANCEL'];
const TRACKED = new Set(['ASK', 'REQ', 'BLOCK', 'DONE']);
const CLOSES = { ANS: 'answered', OK: 'accepted', NO: 'refused', PASS: 'passed', FIX: 'fix', CANCEL: 'cancelled' };
const CLOSE_TARGETS = { ANS: ['ASK', 'BLOCK'], OK: ['REQ'], NO: ['REQ', 'ASK', 'BLOCK'], PASS: ['DONE'], FIX: ['DONE'], CANCEL: ['ASK', 'REQ', 'BLOCK'] };
const BUBBLE = { ASK: 'ask', BLOCK: 'ask', DONE: 'done', PASS: 'done', FIX: 'warn', FAIL: 'warn', NO: 'warn' };
const CHANNELS = ['#plan', '#build', '#merge', '#ops'];
const snap = (m) => ({ ...m, slots: { ...m.slots } });

/** '@m3' | '@boss' | '@mgr' | '@human' | '@all' | an agent | null -> { to, toId, toAlias } */
function resolveTo(jobId, to) {
  if (!to) return { to: null, toId: null, toAlias: null };
  if (typeof to === 'object') return { to: to.handle, toId: to.id, toAlias: null };
  const s = String(to);
  if (s === '@human' || s === '@all' || s === '@hub' || s === '@other') return { to: s, toId: null, toAlias: null };
  const job = S.jobs[jobId];
  if ((s === '@boss' || s === '@mgr') && job) {
    const a = s === '@mgr' ? S.agents[job.managerIds[0]] || S.agents[job.leadBossId] : S.agents[job.leadBossId];
    if (a) return { to: a.handle, toId: a.id, toAlias: s };
  }
  const low = s.toLowerCase();
  const a = all('agents', (x) => x.jobId === jobId && (x.handle === low || '@' + x.name.toLowerCase() === low))[0];
  return a ? { to: a.handle, toId: a.id, toAlias: null } : { to: s, toId: null, toAlias: null };
}

/**
 * Store one post and send the board event { msg, changed? }.
 * agent: the author (null = the hub, or the owner when human is true). close:false keeps the target open (a buddy verdict).
 */
function post({ jobId, agent = null, human = false, kind, to = null, scope = null, re = null, slots = {}, body = '', close = true }) {
  const target = re != null ? byMsgId.get(re) || null : null;
  const t = resolveTo(jobId, to);
  const ts = now();
  const msg = {
    id: ++boardSeq, ts, jobId: jobId ?? null,
    from: human ? '@human' : agent ? agent.handle : '@hub', fromId: agent ? agent.id : null, role: human ? 'human' : agent ? agent.role : 'hub',
    kind, to: t.to, toId: t.toId, toAlias: t.toAlias, scope: scope || (target ? target.scope : '#build'),
    re: re ?? null, thread: 0, slots: { ...slots }, body: String(body ?? ''),
    state: TRACKED.has(kind) ? 'open' : null, due: null, seenAt: null, esc: 0, defaulted: false, stale: false,
  };
  msg.thread = target ? target.thread : msg.id;
  if (msg.state === 'open' && kind !== 'DONE') {
    const minutes = t.to === '@human' ? (settings.presence === 'away' ? 0 : settings.humanWaitMin) : kind === 'BLOCK' ? 5 : 10;
    msg.due = minutes ? ts + minutes * 60000 : null;
    if (t.toId) msg.seenAt = ts;
  }
  board.push(msg);
  byMsgId.set(msg.id, msg);
  if (board.length > 6000) for (const old of board.splice(0, board.length - 5000)) byMsgId.delete(old.id);
  const changed = [];
  if (close && target && target.state === 'open' && CLOSES[kind] && CLOSE_TARGETS[kind].includes(target.kind)) {
    target.state = CLOSES[kind]; target.due = null;
    changed.push(snap(target));
  }
  emit('board', changed.length ? { msg: snap(msg), changed } : { msg: snap(msg) });
  if (agent && S.agents[agent.id]) {
    agent.bubble = { text: clip(msg.body || kind, 64), kind: BUBBLE[kind] || 'info', seq: ++bubbleSeq };
    touch('agents', agent);
  }
  return msg;
}
const say = (agent, kind, opts = {}) => post({ jobId: agent.jobId, agent, kind, ...opts });
const hubEvt = (jobId, scope, body, { to = null, re = null } = {}) => post({ jobId, kind: 'EVT', scope, body, to, re });
/** Change an item with no post (a hub close, a default taken) and tell the UI. */
function patchMsg(msg, patch) {
  Object.assign(msg, patch);
  emit('board', { msg: null, changed: [snap(msg)] });
}

function log(agentId, ...lines) {
  let buf = agentLogs.get(agentId);
  if (!buf) agentLogs.set(agentId, (buf = []));
  buf.push(...lines);
  if (buf.length > 2600) buf.splice(0, buf.length - 2200);
  emit('agentlog', { agentId, lines }, { persist: false });
}
// panel (final wiring spec S5): the top-bar panel an owner notice is about: blueprint | truck | inbox | keys, or null for none
// (a job that ended). Left out (undefined) on the info and warn notices, like the hub.
const notice = (level, text, jobId = null, panel) => emit('notice', panel === undefined ? { level, text, jobId } : { level, text, jobId, panel });

/** "Text? A) one B) two" -> [{ key, text }] */
function parseOptions(body) {
  const out = [];
  const rx = /(?:^|\s)([A-D])\)\s+/g;
  const marks = [];
  let m;
  while ((m = rx.exec(body))) marks.push({ key: m[1], at: m.index, end: rx.lastIndex });
  marks.forEach((mk, i) => out.push({ key: mk.key, text: body.slice(mk.end, i + 1 < marks.length ? marks[i + 1].at : body.length).trim() }));
  return out;
}

// ------------------------------------------------------------------ settings (contract section 14b)

const DEFAULT_SETTINGS = {
  crewPresets: { solo: { bosses: 1, managers: 0, makers: 2 }, standard: { bosses: 1, managers: 1, makers: 4 }, full: { bosses: 2, managers: 2, makers: 6 } },
  defaultCrew: 'standard',
  limits: { maxAgents: 6, perProvider: { claude: 2, gemini: 2, oss: 6, mock: 8 },
    maxReworks: 3, maxNudges: 2, maxRetries: 2, maxBlocks: 2, maxClaims: 5, maxReviewers: 2, maxQaRounds: 3,
    maxTasks: 40, maxTasksTotal: 60,
    turnTimeoutMin: 45, taskTimeoutMin: { S: 20, M: 45, L: 90 }, idleTimeoutMin: 12, checkTimeoutMin: 10,
    holdFallbackMin: 20, maxFileMb: 1, maxDeliveryMb: 5, maxDeliveryFiles: 500, turnUsd: 5,
    rotateTok: { boss: 40000, manager: 40000, maker: 90000 }, rotateGapMin: 5, rotateGapTok: 25000 },
  review: { reviewer: 'boss', crossLab: true, smallByManager: true },
  pairing: 'M+L',
  approvePlan: false,
  safety: 'sandboxed',
  thrift: 0.3,
  allowFallback: true,
  auth: { claude: null, gemini: null, openai: null },
  authAck: { claude: null, gemini: null, openai: null },
  selfTest: { claude: null, gemini: null, openai: null },
  oss: { engine: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', standIn: false },
  rlPort: { mode: 'sim', localUrl: 'http://127.0.0.1:8788', remoteUrl: '', remoteProvider: 'custom' },
  presence: 'here',
  humanWaitMin: 30,
  budgetUsd: 20,
  board: {},
  ui: { sound: false, scanlines: false },
};
let settings;

// ------------------------------------------------------------------ labs: ProviderStatus (contract section 10)

const POLICY = {
  claude: {
    apikey: { lines: ['You pay per token on your Anthropic API account.', 'Phase 0 uses Frontier models only as Orchestration Officers & Review Gates.', 'Consumer subscription logins are disabled for ToS compliance.'], url: 'https://www.anthropic.com/pricing' },
  },
  gemini: {
    apikey: { lines: ['You pay per token on your Gemini API account.', 'Phase 0 uses Gemini for Orchestration Officers, Review Gates & routing.', 'Consumer subscription logins are disabled for ToS compliance.'], url: 'https://ai.google.dev/pricing' },
  },
  openai: {
    subscription: { lines: ['Uses official OpenAI Sign in with ChatGPT (OAuth 2.0 + PKCE).', 'Closed-source models act as Officers & Review Gates only (blocked from GPU RL).'], url: 'https://developers.openai.com/codex/auth' },
    apikey: { lines: ['Uses OPENAI_API_KEY stored in Keychain.', 'Closed-source models act as Officers & Review Gates only.'], url: 'https://platform.openai.com/docs/pricing' },
  },
  oss: {
    standin: { lines: ['Phase 0 Stand-in simulation mode ($0).', 'Exercises Harness Rack & Employee Book locally without GPU weights.', 'Enable Ollama/vLLM in Runtimes & Keys for live inference.'], url: null },
    local: { lines: ['Open-source models run at $0 via local or cluster endpoint.', 'Benches enforce strict file containment and harness protocols.'], url: null },
  },
};
const KEY_OF_LAB = { claude: 'anthropic', gemini: 'gemini', openai: 'openai', oss: 'oss' };
const SELFTEST_CORE = [
  { name: 'Write a file outside the turn folder', ok: true, detail: 'Refused: Operation not permitted.' },
  { name: 'Read the canary file on the deny-read list', ok: true, detail: 'Refused: data/run/selftest/canary is not readable.' },
  { name: 'Print the agent token', ok: true, detail: 'The shell printed nothing.' },
];
let labs;
function freshLabs() {
  const t = Date.now();
  return {
    oss: { id: 'oss', label: 'Open-Source Runtime', lab: 'oss', installed: true, version: 'standin', path: 'http://127.0.0.1:11434/v1', auth: 'ok', cooling: null, cooledModels: {},
      loginCmd: null, models: ['qwen3-coder-32b', 'deepseek-r1-32b', 'devstral-24b', 'llama-4-scout-17b', 'qwen2.5-vl-32b', 'gemma-3-27b-it'],
      installHint: null, limit: null },
    openai: { id: 'openai', label: 'OpenAI (ChatGPT / Codex)', lab: 'openai', installed: true, version: 'siwc-1.0', path: 'https://auth.openai.com', auth: 'none', cooling: null, cooledModels: {},
      loginCmd: 'Continue with ChatGPT', models: ['gpt-6-astra', 'gpt-6.1-sol'], loginStarted: false,
      installHint: null, limit: null },
    claude: { id: 'claude', label: 'Claude Code', lab: 'anthropic', installed: true, version: '2.4.1', path: '/opt/homebrew/bin/claude', auth: 'ok', cooling: null, cooledModels: {},
      loginCmd: null, models: null, loginStarted: false,
      installHint: { text: 'Install Claude Code in Terminal: curl -fsSL https://claude.ai/install.sh | bash', url: 'https://code.claude.com/docs/en/setup' },
      limit: { status: 'allowed', type: 'five_hour', utilization: 0.41, resetAt: t + 133 * 60000, overage: false, at: t - 90000 } },
    gemini: { id: 'gemini', label: 'Antigravity CLI', lab: 'google', installed: false, version: null, path: null, auth: 'unknown', cooling: null, cooledModels: {},
      loginCmd: null, models: null, loginStarted: false,
      installHint: { text: 'Install the Gemini app for Mac (it bundles agy), or in Terminal: curl -fsSL https://antigravity.google/cli/install.sh | bash', url: 'https://antigravity.google/docs/install' },
      limit: null },
  };
}
function freshSettings() {
  const s = structuredClone(DEFAULT_SETTINGS);
  const ts = 1794700800000;
  s.auth.claude = 'apikey';
  s.authAck.claude = { mode: 'apikey', ts };
  s.selfTest.claude = { version: '2.4.1', ok: true, core: SELFTEST_CORE, advisory: [{ name: 'Reach a host that is not a registry or localhost', ok: true, detail: 'Blocked.' }], ts: ts + 3600000 };
  s.oss.standIn = true;
  return s;
}

function providerStatus(p) {
  if (p.id === 'oss') {
    const ossCfg = settings.oss || {};
    const standIn = !!ossCfg.standIn;
    const mode = standIn ? 'standin' : 'local';
    const usable = standIn || !!p.localReady;
    const reason = usable ? null : `Local OSS server unreachable at ${ossCfg.baseUrl || 'http://127.0.0.1:11434/v1'} (enable Stand-in for Phase 0).`;
    return {
      id: p.id, label: p.label, lab: p.lab, installed: true, version: standIn ? 'standin' : ossCfg.engine || 'ollama', path: ossCfg.baseUrl || '',
      auth: usable ? 'ok' : 'none', mode, ack: true, keySet: !!(keys.get('oss') || {}).value, usable, reason,
      cooling: null, cooledModels: {}, selfTest: null, policyNote: POLICY.oss, loginCmd: null, installHint: null, models: p.models, limit: null,
    };
  }
  const mode = settings.auth[p.id] ?? null;
  const ackRec = settings.authAck[p.id];
  const ack = !!(mode && ackRec && ackRec.mode === mode);
  const keySet = !!(keys.get(KEY_OF_LAB[p.id]) || {}).value;
  const st = settings.selfTest[p.id];
  if (p.cooling && p.cooling.until <= Date.now()) p.cooling = null;
  let reason = null;
  if (!p.installed) reason = `${p.label} is not installed.`;
  else if (p.id === 'openai') {
    if (!mode || !ack) reason = 'Choose "Continue with ChatGPT" or "Use API key".';
    else if (mode === 'subscription' && p.auth !== 'ok') reason = 'Click "Continue with ChatGPT" to sign in.';
    else if (mode === 'apikey' && !keySet) reason = 'No OPENAI_API_KEY saved.';
    else if (settings.safety === 'sandboxed' && !(st && st.ok)) reason = 'Run the self-test once.';
  } else if (mode !== 'apikey' || !ack) reason = 'Choose API key mode (consumer subscriptions are disabled for this provider).';
  else if (!keySet) reason = 'No API key is saved for this runtime.';
  else if (settings.safety === 'sandboxed' && !(st && st.ok && st.version === p.version)) reason = st && !st.ok ? 'The self-test failed. Agents of this runtime do not start.' : 'Run the self-test once. It proves that agents stay inside the sandbox.';
  else if (p.cooling) reason = `Paused until ${hhmm(p.cooling.until)}: ${p.cooling.reason}`;
  return {
    id: p.id, label: p.label, lab: p.lab, installed: p.installed, version: p.version, path: p.path,
    auth: p.id === 'openai' && mode === 'subscription' ? p.auth : keySet ? 'ok' : 'none', mode, ack, keySet, usable: reason === null, reason,
    cooling: p.cooling ? { until: p.cooling.until, reason: p.cooling.reason } : null, cooledModels: p.cooledModels,
    selfTest: st ? { version: st.version, ok: st.ok, ts: st.ts } : null, policyNote: POLICY[p.id],
    loginCmd: null, installHint: p.installed ? null : p.installHint, models: p.models,
    limit: p.limit,
  };
}
const providersOut = () => Object.values(labs).map(providerStatus);
const emitProviders = () => emit('providers', { providers: providersOut() });
const needLab = (id) => { const p = Object.hasOwn(labs, id) ? labs[id] : null; if (!p) throw httpError(404, `Unknown lab ${id}.`); return p; };

function setLabState(p, state) {
  if (p.id === 'oss') {
    settings.oss = settings.oss || { engine: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', standIn: false };
    if (state === 'ready') settings.oss.standIn = true;
    else if (state === 'missing') { settings.oss.standIn = false; p.localReady = false; }
    emit('settings', { settings });
    emitProviders();
    return;
  }
  const base = freshLabs()[p.id];
  const ready = () => { p.installed = true; p.version = base.version || '1.5.1'; p.path = base.path || `/Users/owner/.local/bin/${p.id === 'gemini' ? 'agy' : p.id}`; };
  const ts = Date.now();
  p.cooling = null;
  if (state === 'missing') { Object.assign(p, base, { installed: false, version: null, path: null, auth: 'unknown' }); settings.auth[p.id] = null; settings.authAck[p.id] = null; settings.selfTest[p.id] = null; }
  else if (state === 'installed') { ready(); p.auth = 'unknown'; settings.auth[p.id] = null; settings.authAck[p.id] = null; settings.selfTest[p.id] = null; }
  else if (state === 'signedin' || state === 'keyed') {
    ready(); p.auth = 'ok'; settings.auth[p.id] = 'apikey'; settings.authAck[p.id] = { mode: 'apikey', ts }; settings.selfTest[p.id] = null;
    const kid = KEY_OF_LAB[p.id]; if (kid && keys.get(kid) && !keys.get(kid).value) { keys.get(kid).value = 'stub-key-abcd'; keys.get(kid).updatedAt = ts; }
  } else if (state === 'ready' || state === 'cooling') {
    ready(); p.auth = 'ok'; settings.auth[p.id] = 'apikey'; settings.authAck[p.id] = { mode: 'apikey', ts };
    const kid = KEY_OF_LAB[p.id]; if (kid && keys.get(kid) && !keys.get(kid).value) { keys.get(kid).value = 'stub-key-abcd'; keys.get(kid).updatedAt = ts; }
    settings.selfTest[p.id] = { version: p.version, ok: true, core: SELFTEST_CORE, advisory: [], ts };
    if (state === 'cooling') p.cooling = { until: ts + 47 * 60000, reason: 'The rate limit of this runtime is reached.' };
  } else throw httpError(404, 'Lab state must be missing, installed, signedin, ready or cooling.');
  if (p.id === 'gemini' && p.auth === 'ok') p.models = ['gemini-4-carbon-high', 'gemini-4-argon-medium', 'gemini-4-hydrogen-low', 'gemini-4-hydrogen-medium', 'gemini-3.8-flash'];
  emit('settings', { settings });
  emitProviders();
}

// ------------------------------------------------------------------ models (contract section 11)

const DOMAINS = ['plan', 'backend', 'frontend', 'fix', 'review', 'test', 'data', 'algo', 'research', 'synthesis', 'docs', 'vision', 'chore'];
const ROLES = ['boss', 'manager', 'maker'];
function fallbackRegistry() {
  // Used only when config/models.json cannot be read. Same shape, a few rows, made-up numbers.
  const cat = (label) => ({ label, scale: '0-100', tie: 5, source: 'stub (made-up numbers)', date: '2026-11-13', note: '' });
  const m = (id, provider, label, tiers, power, pin, pout, scores, enabled = true) => ({ id, provider, label, tiers, power, price: { in: pin, out: pout, note: '' }, efforts: ['low', 'medium', 'high'], enabled, estimated: false, planNote: '', scores });
  return {
    version: 1, dataDate: '2026-11-13', fetchedAt: '2026-11-15',
    attribution: { text: 'Stub data (made-up numbers)', url: 'https://benchlm.ai', license: 'none' },
    tieNote: 'tie = the gap below which two values count as equal.', nullNote: 'null means that no score was found for that model. It never means zero.',
    categories: { overall: cat('Overall'), agentic: cat('Agentic'), coding: cat('Coding'), reasoning: cat('Reasoning') },
    domains: Object.fromEntries(DOMAINS.map((d) => [d, { label: d, keys: [d === 'plan' ? 'reasoning' : d === 'chore' ? 'agentic' : 'coding', 'overall'], note: '' }])),
    models: [
      m('claude-fable-5-2', 'claude', 'Claude Fable 5.2', ['boss'], 5, 8, 40, { overall: 93, agentic: 90, coding: 89, reasoning: 91 }),
      m('gemini-4-carbon', 'gemini', 'Gemini 4 Carbon', ['boss'], 5, 2, 10, { overall: 92, agentic: 88, coding: 87, reasoning: 93 }),
      m('claude-opus-5-5', 'claude', 'Claude Opus 5.5', ['manager', 'boss'], 4, 4, 20, { overall: 90, agentic: 87, coding: 88, reasoning: 86 }),
      m('gemini-4-argon', 'gemini', 'Gemini 4 Argon', ['manager'], 4, 2, 10, { overall: 88, agentic: 84, coding: 83, reasoning: 88 }),
      m('claude-sonnet-5-5', 'claude', 'Claude Sonnet 5.5', ['maker', 'manager'], 3, 2, 10, { overall: 86, agentic: 83, coding: 85, reasoning: 80 }),
      m('gemini-4-hydrogen', 'gemini', 'Gemini 4 Hydrogen', ['maker', 'manager'], 3, 1.5, 7.5, { overall: 84, agentic: 80, coding: 81, reasoning: 82 }),
      m('claude-haiku-5-5', 'claude', 'Claude Haiku 5.5', ['maker'], 2, 0.1, 0.5, { overall: 76, agentic: 70, coding: 74, reasoning: null }),
      m('gemini-3.8-flash', 'gemini', 'Gemini 3.8 Flash', ['maker'], 2, 0.75, 3.75, { overall: 74, agentic: null, coding: 72, reasoning: 70 }, false),
    ],
  };
}
function loadRegistry() {
  try {
    const r = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8'));
    if (isObj(r) && Array.isArray(r.models) && isObj(r.categories) && isObj(r.domains)) return r;
  } catch { /* fall through */ }
  return fallbackRegistry();
}
let registry;
/** router.leaders(): { [domain]: { [role]: [{ rank, id, label, provider, key, value, score }] } } */
function leaders() {
  const out = {};
  for (const [domain, def] of Object.entries(registry.domains)) {
    out[domain] = {};
    const keysOf = Array.isArray(def.keys) ? def.keys : ['overall'];
    for (const role of ROLES) {
      let cand = registry.models.filter((m) => m.enabled && Array.isArray(m.tiers) && m.tiers[0] === role);
      if (!cand.length) cand = registry.models.filter((m) => m.enabled && Array.isArray(m.tiers) && m.tiers.includes(role));
      const key = keysOf.find((k) => cand.length && cand.every((m) => typeof (m.scores || {})[k] === 'number')) || keysOf.find((k) => cand.some((m) => typeof (m.scores || {})[k] === 'number')) || 'overall';
      const lower = !!(registry.categories[key] || {}).lowerIsBetter;
      out[domain][role] = cand.filter((m) => typeof (m.scores || {})[key] === 'number')
        .sort((a, b) => (lower ? a.scores[key] - b.scores[key] : b.scores[key] - a.scores[key]))
        .map((m, i) => ({ rank: i + 1, id: m.id, label: m.label, provider: m.provider, key, value: m.scores[key], score: m.scores[key] }));
    }
  }
  return out;
}
const modelsPayload = () => ({ registry, leaders: leaders() });

// ------------------------------------------------------------------ keys (contract section 14)

const keys = new Map();
const KNOWN_KEYS = ['anthropic', 'gemini', 'openai', 'oss', 'typesafe'];
let harnessReg = { version: 1, harnesses: [] };
let rosterEntries = [];
let requisitions = [];
let reqSeq = 1;
function loadJsonSafe(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function freshKeys() {
  keys.clear();
  keys.set('anthropic', { id: 'anthropic', label: 'Anthropic API key', envVar: 'ANTHROPIC_API_KEY', value: 'stub-not-a-real-key-9fQa', updatedAt: Date.now() - 6 * 864e5 });
  keys.set('gemini', { id: 'gemini', label: 'Gemini API key', envVar: 'GEMINI_API_KEY', value: null, updatedAt: null });
  keys.set('openai', { id: 'openai', label: 'OpenAI API key', envVar: 'OPENAI_API_KEY', value: null, updatedAt: null });
  keys.set('oss', { id: 'oss', label: 'Open-Source Endpoint Token', envVar: 'OSS_API_KEY', value: null, updatedAt: null });
  keys.set('typesafe', { id: 'typesafe', label: 'TypeSafe API key (Jev decider)', envVar: 'TYPESAFE_API_KEY', value: null, updatedAt: null });
}
const keyView = (k) => ({ id: k.id, label: k.label, envVar: k.envVar, set: !!k.value, hint: k.value ? k.value.slice(-4) : null, updatedAt: k.updatedAt });

function freshConfig() {
  freshKeys();
  settings = freshSettings();
  labs = freshLabs();
  registry = loadRegistry();
  const h = loadJsonSafe(HARNESSES_FILE, { version: 1, harnesses: [] });
  harnessReg = { version: 1, updatedAt: h.updatedAt || '2026-11-16', harnesses: Array.isArray(h.harnesses) ? h.harnesses : [] };
  const r = loadJsonSafe(ROSTER_FILE, { version: 1, entries: [] });
  rosterEntries = Array.isArray(r.entries) ? r.entries : [];
  requisitions = [{
    id: 'TR1', status: 'queued_phase1', createdAt: Date.now() - 120000, updatedAt: Date.now() - 120000,
    jobId: null, taskId: null, linkedTasks: [], domain: 'algo', reason: 'missing_specialty',
    suggestedName: 'Euler', candidateBaseModel: 'deepseek-r1-32b', harnessId: 'data-algo-lab',
    rftSpec: { phase: 1, pipeline: 'rft-grpo-v0', rewardSignals: ['check_cmd_exit_zero', 'diff_minimality'], evalSuite: 'suites/algo-v0' },
    notes: 'Stub Phase 1 requisition: no curated algo specialist in Employee Book yet.', enrolledRosterId: null,
  }];
  reqSeq = 2;
}
freshConfig();

// ------------------------------------------------------------------ simulation data

const HANDLE = { boss: 'b', manager: 'f', maker: 'm' };
const ROSTER = {
  boss: [
    { name: 'Rusty', provider: 'claude', model: 'claude-fable-5-2', modelLabel: 'Claude Fable 5.2' },
    { name: 'Flux', provider: 'gemini', model: 'gemini-4-carbon', modelLabel: 'Gemini 4 Carbon' },
    { name: 'Anvil', provider: 'claude', model: 'claude-opus-5-5', modelLabel: 'Claude Opus 5.5' },
  ],
  manager: [
    { name: 'Cog', provider: 'claude', model: 'claude-opus-5-5', modelLabel: 'Claude Opus 5.5' },
    { name: 'Rivet', provider: 'gemini', model: 'gemini-4-argon', modelLabel: 'Gemini 4 Argon' },
    { name: 'Gauge', provider: 'claude', model: 'claude-opus-5-5', modelLabel: 'Claude Opus 5.5' },
  ],
  maker: [
    { name: 'Bolt', provider: 'claude', model: 'claude-haiku-5-5', modelLabel: 'Claude Haiku 5.5' },
    { name: 'Nib', provider: 'gemini', model: 'gemini-4-hydrogen', modelLabel: 'Gemini 4 Hydrogen' },
    { name: 'Tack', provider: 'claude', model: 'claude-sonnet-5-5', modelLabel: 'Claude Sonnet 5.5' },
    { name: 'Sprocket', provider: 'gemini', model: 'gemini-4-hydrogen', modelLabel: 'Gemini 4 Hydrogen' },
    { name: 'Gizmo', provider: 'claude', model: 'claude-sonnet-5-5', modelLabel: 'Claude Sonnet 5.5' },
    { name: 'Widget', provider: 'gemini', model: 'gemini-4-hydrogen', modelLabel: 'Gemini 4 Hydrogen' },
    { name: 'Pip', provider: 'claude', model: 'claude-haiku-5-5', modelLabel: 'Claude Haiku 5.5' },
    { name: 'Dot', provider: 'gemini', model: 'gemini-4-hydrogen', modelLabel: 'Gemini 4 Hydrogen' },
  ],
};
const PRICE = { 'claude-fable-5-2': [8, 40], 'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5], 'gemini-4-carbon': [2, 10], 'gemini-4-argon': [2, 10], 'gemini-4-hydrogen': [1.5, 7.5] };
const CTX_MAX = { claude: 200000, gemini: 1000000, oss: 131072, mock: 200000 };
const CTX_BASE = { claude: 12500, gemini: 24000, oss: 6000, mock: 4000 }; // first-request overhead (section 14c)

const DEFAULT_ORDER = {
  title: 'Recipe Box web app',
  kind: 'build',
  brief: [
    'Build a small web app for our family recipes.',
    '',
    'I want to save a recipe (title, ingredients, steps, a photo link), find it again by name or by ingredient, fix it when grandma corrects me, and print it on one page for the kitchen.',
    'Old recipes sit in notes and emails, so I need to paste text and get a recipe out of it.',
    '',
    'It runs on the Mac mini at home. No accounts, no cloud. Keep it simple: Node, no framework. Tests must pass with one command.',
    'I started a repo with a placeholder page and a README. Build on it.',
  ].join('\n'),
  // An existing repo, so the truck diff holds every kind of change: new, changed, deleted, renamed and binary files.
  project: { mode: 'existing', path: '/Users/owner/Code/recipe-box', agentFilesAck: true },
  crew: { bosses: 2, managers: 2, makers: 6 },
  options: { approvePlan: false },
};

const PLAN = {
  requirements: [
    'Save a recipe with title, ingredients, steps and a photo link',
    'Search recipes by name or by ingredient',
    'Edit and delete a recipe',
    'Import a recipe from pasted text',
    'Print a recipe on one page',
    'Runs on the home network with no accounts',
    'All tests pass with one command (npm test)',
  ],
  // Added by the ledger audit of the other-lab boss (source "boss").
  auditReq: 'The README explains how to back up the recipe data',
  evidence: [
    'test/api.test.js "creates a recipe with a photo link" passes; data/recipes.json holds the saved fields.',
    'test/api.test.js "search by ingredient" passes; 5,000 recipes answer in 3 ms (server/search.js:31).',
    'PUT and DELETE covered by 6 tests; the editor form saves and removes in the browser check (public/editor.js:112).',
    'server/import.js parses 12 of 12 samples in test/fixtures/pasted.txt.',
    'Print preview of a 40-ingredient recipe fits one A4 page (public/print.css:41).',
    'Server binds 127.0.0.1 and LAN; no login code, no outbound requests in the tree (server/index.js:9).',
    'npm test: 34 tests, 34 pass, 0 fail.',
    'README.md:31 holds the backup step: one cp command.',
  ],
  assumptions: [
    'One household, one user. No login.',
    'Data lives in data/recipes.json inside the project.',
    'Node 20, no framework, no build step.',
  ],
  notes: [
    'Two streams. Stream 1 (data, API, search, import, tests). Stream 2 (pages and print).',
    'Zones are disjoint per task. T3 and T4 both read store.js; only T2 writes it.',
    'Risk: search speed on a big box. Index by token, do not scan.',
  ].join('\n'),
  dropped: { n: 4, why: 'Photo upload is out of scope for this brief. The plan keeps photo links until the owner decides.' },
  setupCmd: 'npm install',
  checkCmd: 'npm test',
};

// k is the task's number inside the plan; deps and reqs point at plan numbers.
// tests: the tests= slot of the DONE post. flags: what the guard found (they show on the truck crate).
const PLAN_TASKS = [
  { k: 1, title: 'Project skeleton and dev server', domain: 'chore', size: 'S', stream: 'data', deps: [], reqs: [6], tests: '1/1',
    zones: ['package.json', 'server/index.js', 'server/static.js', 'test/placeholder.test.js', 'README.md', '.gitignore', 'public/hello.txt'],
    spec: 'Set up package.json (type module, scripts start and test). server/index.js listens on port 4100 and serves public/ through server/static.js. No dependencies. Remove the hello file.',
    acceptance: ['npm start serves public/ on port 4100', 'npm test runs node --test and passes', 'package.json has no dependencies'],
    summary: 'Skeleton is up. npm start serves public/. npm test runs node --test with 1 placeholder test.',
    flags: { checkFiles: ['package.json'] },
    files: [['package.json', 12, 3, 'mod'], ['server/index.js', 64, 0], ['server/static.js', 47, 0], ['test/placeholder.test.js', 6, 0], ['README.md', 6, 2, 'mod'], ['.gitignore', 3, 0], ['public/hello.txt', 0, 4, 'del']] },
  { k: 2, title: 'Recipe model and JSON store', domain: 'backend', size: 'M', stream: 'data', deps: [1], reqs: [1, 6], tests: '11/11',
    zones: ['server/store.js', 'server/model.js', 'data/recipes.json'],
    spec: 'server/model.js validates a recipe {id, title, ingredients[], steps[], photoUrl, tags[], updatedAt}. server/store.js loads and saves data/recipes.json with an atomic write (temp file, then rename).',
    acceptance: ['validate() rejects a recipe with no title or no ingredients', 'save() never leaves a half-written file', 'IDs are short and stable (r1, r2, ...)'],
    summary: 'Model and store are done. save() writes a temp file and renames it. data/recipes.json holds 100 seed recipes.',
    files: [['server/store.js', 118, 0], ['server/model.js', 72, 0], ['data/recipes.json', 800, 0]] },
  { k: 3, title: 'REST API for recipes', domain: 'backend', size: 'M', stream: 'data', deps: [2], reqs: [1, 3], tests: '14/14',
    zones: ['server/api.js', 'server/router.js'], claims: ['server/index.js'],
    spec: 'GET and POST /api/recipes. GET, PUT, DELETE /api/recipes/:id. JSON only. Errors are {error} with a 4xx code.',
    acceptance: ['POST with a bad body returns 400 and {error}', 'PUT on an unknown id returns 404', 'DELETE twice returns 204 both times'],
    summary: 'API is done: list, get, create, update, delete. Errors are {error} with a 4xx code. server/index.js mounts the router.',
    flags: { claimed: ['server/index.js'] },
    files: [['server/api.js', 164, 0], ['server/router.js', 58, 0], ['server/index.js', 9, 2, 'mod']] },
  { k: 4, title: 'Search by name and ingredient', domain: 'algo', size: 'M', stream: 'data', deps: [2], reqs: [2], pair: true, tests: '9/9',
    zones: ['server/search.js', 'server/tokenize.js', 'server/index-cache.js'],
    spec: 'search(q) returns recipes ranked: exact title, title prefix, ingredient match, step match. Case and accent insensitive.',
    acceptance: ['"tomato" finds recipes that list tomatoes', 'An exact title ranks first', '5,000 recipes answer in under 50 ms'],
    summary: 'Search ranks title, ingredient and step matches. It scans all recipes for each query.', acc1: 2,
    summary2: 'index-cache.js holds a token index. 5,000 recipes answer in 3 ms. The ranking did not change.', tests2: '10/10',
    files: [['server/search.js', 141, 0], ['server/tokenize.js', 44, 0]],
    files2: [['server/search.js', 163, 0], ['server/tokenize.js', 44, 0], ['server/index-cache.js', 38, 0]] },
  { k: 5, title: 'Recipe list page with live search', domain: 'frontend', size: 'M', stream: 'pages', deps: [1], reqs: [2], tests: 'none', sameLab: true,
    zones: ['public/index.html', 'public/placeholder.html', 'public/list.js', 'public/util.js', 'public/style.css', 'public/icon.png', 'public/logo.svg'],
    spec: 'public/index.html lists recipes as cards. A search box filters as you type (150 ms debounce) through GET /api/recipes?q=.',
    acceptance: ['The list shows title, tags and the first photo', 'Typing "tom" narrows the list without a reload', 'Works at 360 px and at 1440 px wide'],
    summary: 'List page is done: cards, live search with a debounce, an empty state. placeholder.html is now index.html.',
    files: [['public/index.html', 44, 6, 'rename', 'public/placeholder.html'], ['public/list.js', 132, 0], ['public/util.js', 41, 0], ['public/style.css', 96, 0],
      ['public/icon.png', 0, 0, 'binary'], ['public/logo.svg', 3, 0, 'long']] },
  // slowReview: its review takes long, so hand-ins that came after it are merged before it. On the truck the order of the
  // delivery ids then differs from the load order.
  { k: 6, title: 'Recipe editor form', domain: 'frontend', size: 'L', stream: 'pages', deps: [5], reqs: [1, 3], tests: 'none', slowReview: true,
    zones: ['public/editor.html', 'public/editor.js', 'public/validate.js', 'public/dom.js', 'public/util.js'], claims: ['public/list.js'],
    spec: 'public/editor.html creates and edits a recipe. Ingredients and steps are add/remove rows. Validate before save. Delete asks first.',
    acceptance: ['A new recipe appears in the list after save', 'An empty title shows an inline error and does not save', 'Delete needs a second click to confirm'],
    summary: 'Editor is done: create, edit, delete with a confirm step. util.js is now dom.js; list.js imports it.',
    flags: { claimed: ['public/list.js'] },
    files: [['public/editor.html', 62, 0], ['public/editor.js', 248, 0], ['public/validate.js', 71, 0], ['public/dom.js', 9, 4, 'rename', 'public/util.js'], ['public/list.js', 3, 3, 'mod']] },
  { k: 7, title: 'Import a recipe from pasted text', domain: 'data', size: 'M', stream: 'data', deps: [2], reqs: [4], tests: '12/12',
    zones: ['server/import.js', 'data/samples/**', 'test/fixtures/**'],
    spec: 'parseRecipe(text) splits pasted text into title, ingredients and steps. It handles numbered steps, bullet lists and one-paragraph recipes.',
    acceptance: ['12 sample texts in test/fixtures/pasted.txt parse to the expected fields', 'Text with no blank lines still yields steps', 'Unknown text returns {error}, never throws'],
    summary: 'Import is done. 12 of 12 samples parse. Text with no blank lines falls back to sentence ends.',
    files: [['server/import.js', 187, 0], ['test/fixtures/pasted.txt', 14, 0, 'long']] },
  { k: 8, title: 'Print-friendly recipe card', domain: 'frontend', size: 'S', stream: 'pages', deps: [5], reqs: [5], tests: 'none',
    zones: ['public/print.css', 'public/print.js'],
    spec: 'A print stylesheet and a Print button. One recipe fits one A4 or Letter page: title, ingredients in two columns, steps.',
    acceptance: ['Print preview shows one page for a normal recipe', 'No buttons or search box on paper', 'Photo scales to at most a third of the page'],
    summary: 'Print card is done. Ingredients print in two columns. The photo takes at most a third of the page.',
    files: [['public/print.css', 58, 0], ['public/print.js', 37, 0]] },
  { k: 9, title: 'API and store tests', domain: 'test', size: 'M', stream: 'data', deps: [3, 7], reqs: [7], tests: '33/33',
    zones: ['test/**'], claims: ['package.json'],
    spec: 'node --test suites for the store and the API. Use a temp data file per test. Remove the placeholder test.',
    acceptance: ['npm test runs every suite and exits 0', 'Each test uses its own temp data file', 'Coverage: every route, every 4xx path'],
    summary: 'Tests are done: 22 API tests and 11 store tests. The placeholder test is gone. package.json runs test/.',
    flags: { testsDeleted: 1, checkFiles: ['package.json'], claimed: ['package.json'] },
    files: [['test/api.test.js', 212, 0], ['test/store.test.js', 96, 0], ['test/placeholder.test.js', 0, 6, 'del'], ['package.json', 3, 1, 'mod']] },
  { k: 10, title: 'README and usage guide', domain: 'docs', size: 'S', stream: 'pages', deps: [3, 5], reqs: [6, 8], tests: 'none',
    zones: ['README.md', 'docs/**'],
    spec: 'README: what it is, how to start, how to back up data/recipes.json. docs/usage.md: add, search, import, print.',
    acceptance: ['A new reader starts the app from the README alone', 'The backup step is one copy command'],
    summary: 'README and docs/usage.md are written. They cover start, backup and the four main flows.',
    cardChange: 'Acceptance item 2 reworded: the backup step is one copy command.', flags: { cardChanged: ['acceptance'] },
    files: [['README.md', 74, 2, 'mod'], ['docs/usage.md', 51, 0]] },
  // Added by the QA boss after requirement R5 fails once.
  { k: 11, title: 'Fix print overflow on long ingredient lists', domain: 'fix', size: 'S', stream: 'pages', deps: [8], reqs: [5], late: true, tests: 'none',
    zones: ['public/print.css'],
    spec: 'A recipe with 40 ingredients spills onto a second page. Shrink the ingredient font in steps and allow three columns above 30 items.',
    acceptance: ['A 40-ingredient recipe prints on one page', 'A normal recipe looks the same as before'],
    summary: 'Print overflow is fixed: three columns above 30 items, and the font steps down to 9 pt.',
    files: [['public/print.css', 14, 6, 'mod']] },
];

const REVIEW_NOTES = {
  1: 'Starts clean. No dependencies. The static handler refuses path traversal (server/static.js:22).',
  2: 'The atomic write is right: temp file, then rename (server/store.js:41). validate() messages are clear.',
  3: 'Routes match the spec. Every 4xx path returns {error}. The claimed edit in server/index.js is 9 lines.',
  5: 'The debounce works. The empty state is handled. The layout holds at 360 px (public/style.css:58).',
  6: 'Form rows add and remove cleanly. Delete needs two clicks. The rename is consistent.',
  7: 'All 12 samples parse. The fallback for text with no blank lines has a test.',
  8: 'One page for a normal recipe. No screen controls on paper.',
  9: 'Every route and every 4xx path has a test. Each test uses its own temp file.',
  10: 'A new reader can start from the README alone.',
  11: 'A 40-ingredient recipe now fits one page. Normal recipes did not change.',
};

// Scripted board talk, fired when a task passes a progress mark on its first try.
const CHATTER = {
  2: [{ at: 0.3, kind: 'ASK', to: 'manager', body: 'Do I keep all recipes in one JSON file, or one file per recipe?', reply: 'One file: data/recipes.json. Write it through store.js only.' }],
  3: [{ at: 0.45, from: 'boss', kind: 'DECIDE', scope: '#build', body: 'API errors are {error} with a 4xx code. A response never carries a stack trace.' }],
  4: [{ at: 0.4, kind: 'ASK', to: 'manager', body: 'Do I strip accents before I match, so that "creme" finds the accented word?', reply: 'Yes. Normalize to NFD and drop the marks in server/tokenize.js.' }],
  5: [{ at: 0.35, kind: 'ASK', to: 'manager', body: 'Does the list filter as you type, or only on Enter?', reply: 'As you type, with a 150 ms debounce.' }],
  6: [{ at: 0.3, kind: 'BLOCK', slots: { why: 'blocked' }, block: true, body: 'The editor needs POST /api/recipes. T3 is not merged.', reply: 'Use test/fixtures/api.json until T3 merges. Do not wait for it.' }],
  7: [{ at: 0.55, kind: 'INFO', body: 'Pasted text with no blank lines breaks the step split. I add a fallback on sentence ends.' }],
  9: [{ at: 0.5, claim: 'package.json' }],
};

const OWNER_QUESTION = {
  body: 'Do we store photos as links, or as uploaded files? A) Links only. The app stays simple and works offline. B) Uploaded files. This needs an upload folder and a size limit.',
  short: 'Do we store photos as links, or as uploaded files?',
  default: 'A',
};

const THOUGHTS = [
  'Reading the task file and the blueprint first.',
  'The zone covers what I need. No claim required.',
  'I will keep the change small and run the check before handing in.',
  'The existing helper already does this. Reusing it.',
  'Edge case: empty input. Adding a guard and a test.',
  'The check passes locally. Writing the summary.',
  'This name is clearer. Renaming before anyone depends on it.',
  'Two callers use the old shape. Updating both.',
];
const CHECK_OK_TAIL = '# tests 34\n# suites 6\n# pass 34\n# fail 0\n# cancelled 0\n# duration_ms 812';
const CHECK_FAIL_TAIL = [
  'not ok 9 - DELETE /api/recipes/:id twice',
  '  ---',
  '  error: Expected values to be strictly equal: 500 !== 204',
  '  at TestContext.<anonymous> (test/api.test.js:118:12)',
  '  ...',
  '# tests 14', '# pass 13', '# fail 1',
].join('\n');

// ------------------------------------------------------------------ simulation engine

const sim = { paused: false, ff: false, loop: true, mode: 'job', jobId: null, tick: 0, rng: mulberry32(1), st: null, dirty: new Map(), behind: 0 };

function resetSim() {
  sim.paused = false; sim.ff = false; sim.loop = true; sim.mode = 'job'; sim.jobId = null; sim.tick = 0; sim.st = null; sim.dirty.clear(); sim.behind = 0;
}
function touch(kind, item) { sim.dirty.set(kind + ':' + item.id, [kind, item]); }
function flushDirty() {
  if (!sim.dirty.size) return;
  const items = [...sim.dirty.values()];
  sim.dirty.clear();
  for (const [kind, item] of items) if (S[kind][item.id] === item || !S[kind][item.id]) put(kind, item);
  if (sim.dirty.size) flushDirty();
}
const fakeSha = () => Array.from({ length: 40 }, () => Math.floor(sim.rng() * 16).toString(16)).join('');
const jobAgents = (job, role) => all('agents', (a) => a.jobId === job.id && (!role || a.role === role)).sort(byId);
const jobTasks = (job) => all('tasks', (t) => t.jobId === job.id).sort(byId);
// The crates on the truck of a job in the order they were merged (loaded): a ship takes every crate merged up to one commit.
// loadedAt is what the hub on disk sets when it merges a delivery (the contract shape of a Delivery does not list it yet).
const byLoad = (a, b) => (a.loadedAt || 0) - (b.loadedAt || 0) || byId(a, b);
const loadedOf = (job) => all('deliveries', (d) => d.jobId === job.id && d.status === 'loaded').sort(byLoad);
/** The time a crate is loaded. It rises with every crate, also when a scenario runs many steps in one instant. */
const loadStamp = () => (lastLoadAt = Math.max(now(), lastLoadAt + 1));
const meta = (id) => { let m = sim.st.meta.get(id); if (!m) sim.st.meta.set(id, (m = { wait: 0, said: {} })); return m; };
const planOf = (t) => PLAN_TASKS.find((p) => p.k === t._k) || {};
const newSession = (agent) => { agent.stats.ctxTok = CTX_BASE[agent.provider] || 8000; return 'ses_' + fakeSha().slice(0, 10); };

function crewCounts(crew) {
  let c = crew;
  if (typeof c === 'string') c = settings.crewPresets[c];
  if (!c || typeof c !== 'object') c = settings.crewPresets[settings.defaultCrew] || { bosses: 1, managers: 1, makers: 4 };
  const n = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Math.round(Number(v)) : d));
  return { bosses: n(c.bosses, 1, 3, 1), managers: n(c.managers, 0, 3, 1), makers: n(c.makers, 1, 8, 4) };
}

function hire(job, role, idx) {
  const base = ROSTER[role][idx % ROSTER[role].length];
  const mock = job.options.mock;
  const provider = mock ? 'mock' : base.provider;
  const a = {
    id: nextId('A'), jobId: job.id, name: base.name, handle: `@${HANDLE[role]}${++sim.st.handles[role]}`, role, lead: role === 'boss' && idx === 0,
    provider, model: mock ? `mock-${role}` : base.model, modelLabel: mock ? `Mock ${role}` : base.modelLabel, effort: role === 'boss' ? 'high' : role === 'manager' ? 'medium' : 'low',
    style: { seed: hash(base.name) % 100000 }, spot: idx,
    status: 'idle', taskId: null, sessionId: null, hold: null,
    stats: { turns: 0, inTok: 0, outTok: 0, usd: 0, ctxTok: 0, ctxMax: CTX_MAX[provider] || 200000 }, bubble: null, lastActiveAt: now(),
  };
  S.agents[a.id] = a;
  touch('agents', a);
  return a;
}

function retireJob(job, status) {
  job.prevStatus = null; job.pauseReason = null; job.status = status; job.hold = null;
  queuedOrders.delete(job.id);
  for (const d of all('deliveries', (x) => x.jobId === job.id)) ownerReviews.delete(d.id);
  touch('jobs', job);
  for (const a of jobAgents(job)) { a.status = 'off'; a.taskId = null; a.bubble = null; touch('agents', a); }
  for (const m of board) if (m.jobId === job.id && m.state === 'open') { m.state = 'cancelled'; m.due = null; }
}

function removeJobRows(job) {
  for (const kind of ['deliveries', 'tasks', 'agents']) for (const it of all(kind, (x) => x.jobId === job.id)) { sim.dirty.delete(kind + ':' + it.id); remove(kind, it.id); }
}
function pruneJobs(keep) {
  const jobs = all('jobs').sort(byId);
  for (const job of jobs.slice(0, Math.max(0, jobs.length - keep))) {
    removeJobRows(job);
    sim.dirty.delete('jobs:' + job.id); remove('jobs', job.id);
    sim.dirty.delete('projects:' + job.projectId); remove('projects', job.projectId);
  }
}

const ACTIVE = ['planning', 'plan_review', 'running', 'qa', 'delivering', 'paused']; // an active job (contract section 4)

/** The project row of a work order, with its starter tools. */
function makeProject(order) {
  const proj = order.project || {};
  const existing = proj.mode === 'existing' && !!proj.path;
  const name = existing ? path.basename(proj.path) : proj.name || slug(order.title || 'project');
  const project = put('projects', {
    id: nextId('P'), name, path: existing ? proj.path : `/Users/owner/WorkShop/projects/${name}`,
    targetBranch: 'main', hubCreated: !existing, setupCmd: null, checkCmd: null, noCheckReason: null,
    agentFiles: existing ? ['AGENTS.md'] : [], agentFilesAck: !!proj.agentFilesAck, baseline: null, headCheck: null,
  });
  toolkits.set(project.id, starterTools());
  return project;
}

/**
 * The job row of a new work order. No simulation yet: a queued job is only a row.
 * Intake runs when the job comes on the floor, not at creation (section 12): a queued job has no project yet (projectId null).
 */
function makeJob(order, status) {
  const counts = crewCounts(order.crew);
  const proj = order.project || {};
  const existing = proj.mode === 'existing' && !!proj.path;
  const project = status === 'queued' ? null : makeProject(order);
  const id = nextId('J');
  const opts = order.options || {};
  const budget = Number(order.budgetUsd);
  const job = {
    id, title: order.title, brief: order.brief, kind: order.kind || 'build', projectId: project ? project.id : null, newProject: !existing, crew: counts,
    options: { approvePlan: !!opts.approvePlan, mock: !!opts.mock },
    status, prevStatus: null, pauseReason: null, hold: null,
    requirements: [], assumptions: [], notes: '', planDrafts: null, dropped: [],
    leadBossId: null, bossIds: [], managerIds: [],
    integrationBranch: `ws/${id}/int`, integrationDir: `/Users/owner/WorkShop/data/work/${id}/_int`, intSha: null,
    qa: null, cost: { billedUsd: 0, estUsd: 0, inTok: 0, outTok: 0 }, budgetUsd: order.budgetUsd != null && order.budgetUsd !== '' && Number.isFinite(budget) ? budget : null,
    report: null, error: null,
  };
  S.jobs[id] = job;
  touch('jobs', job);
  return job;
}

/** Put a job on the floor: the simulation state, the bosses and the managers. The job goes to "planning". */
function beginJob(job) {
  const counts = job.crew;
  if (!job.projectId) job.projectId = makeProject(queuedOrders.get(job.id) || { title: job.title }).id; // intake of a job that waited in the queue
  queuedOrders.delete(job.id);
  sim.mode = 'job';
  sim.jobId = job.id; sim.tick = 0; sim.rng = mulberry32(hash(job.id) ^ 0x51ab);
  sim.st = { planTick: 0, meta: new Map(), reviewing: new Map(), intQueue: [], integrating: null, pending: [], taskByK: {},
    handles: { boss: 0, manager: 0, maker: 0 }, questionId: null, questionTick: 0, answered: false, defaulted: false, printFailed: false,
    deliverWait: 0, doneTick: 0, maxMakers: counts.makers };
  job.status = 'planning';
  job.intSha = fakeSha();
  for (let i = 0; i < counts.bosses; i++) job.bossIds.push(hire(job, 'boss', i).id);
  for (let i = 0; i < counts.managers; i++) job.managerIds.push(hire(job, 'manager', i).id);
  job.leadBossId = job.bossIds[0];
  touch('jobs', job);
  flushDirty();
  return job;
}

/** Scenarios and the demo loop: clear the floor (the job on it is cancelled) and start this work order at once. */
function startJob(order) {
  const old = sim.jobId && S.jobs[sim.jobId];
  if (old && !['done', 'cancelled'].includes(old.status)) retireJob(old, 'cancelled');
  flushDirty();
  pruneJobs(2);
  return beginJob(makeJob(order, 'planning'));
}

/** The owner's way in (POST /api/jobs, POST /api/demo, an order tool): one job is active at a time, every other new job is queued. */
function createJob(order) {
  const active = all('jobs', (j) => ACTIVE.includes(j.status)).length > 0;
  if (!active) { pruneJobs(3); return beginJob(makeJob(order, 'planning')); }
  const job = makeJob(order, 'queued');
  queuedOrders.set(job.id, order);
  flushDirty();
  notice('info', `${job.id} is queued. It starts when ${sim.jobId || 'the job on the floor'} is done or cancelled.`, job.id);
  return job;
}

/** The floor is free: the oldest queued job starts. Returns true when one started. */
function promoteQueued() {
  if (all('jobs', (j) => ACTIVE.includes(j.status)).length) return false;
  const next = all('jobs', (j) => j.status === 'queued').sort(byId)[0];
  if (!next) return false;
  beginJob(next);
  notice('info', `${next.id} is on the floor now: ${next.title}.`, next.id);
  return true;
}

function burn(job, agent, task, scale = 1) {
  const r = sim.rng;
  const inTok = Math.floor((1200 + r() * 2600) * scale), outTok = Math.floor((180 + r() * 520) * scale);
  const p = PRICE[agent.model] || [0, 0];
  const usd = (inTok * p[0] + outTok * p[1]) / 1e6;
  const s = agent.stats;
  s.inTok += inTok; s.outTok += outTok; s.usd = round(s.usd + usd, 4);
  s.ctxTok = Math.min(s.ctxMax, s.ctxTok + inTok * 4 + outTok); // tool results stay in the context
  if (agent.role !== 'maker' && s.ctxTok > settings.limits.rotateTok[agent.role]) {
    // rotation (section 12): a fresh session starts from a hub-built digest
    agent.sessionId = newSession(agent);
    s.ctxTok += 6000;
    log(agent.id, { k: 'sys', s: 'session rotated: the context was over the limit; a digest starts the new session' });
  }
  if (sim.tick % 4 === 0) s.turns += 1;
  agent.lastActiveAt = now();
  job.cost.inTok += inTok; job.cost.outTok += outTok;
  // A turn of a lab in apikey mode is billed. A subscription turn is an estimate at API prices.
  if (settings.auth[agent.provider] === 'apikey') job.cost.billedUsd = round(job.cost.billedUsd + usd, 4);
  else job.cost.estUsd = round(job.cost.estUsd + usd, 4);
  if (task) { task.cost.usd = round(task.cost.usd + usd, 4); touch('tasks', task); }
  touch('agents', agent); touch('jobs', job);
}

function workLines(task) {
  const r = sim.rng;
  const files = planOf(task).files || [['src/main.js', 10, 0]];
  const f = files[Math.floor(r() * files.length)][0];
  const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.';
  const pool = [
    () => ({ k: 'tool', s: `Read ${f}` }),
    () => ({ k: 'tool', s: `Edit ${f} (+${1 + Math.floor(r() * 28)} -${Math.floor(r() * 6)})` }),
    () => ({ k: 'tool', s: `Bash grep -n "${['export function', 'TODO', 'recipe', 'validate', 'async '][Math.floor(r() * 5)]}" ${dir}/` }),
    () => ({ k: 'tool', s: 'Bash npm test' }),
    () => ({ k: 'text', s: THOUGHTS[Math.floor(r() * THOUGHTS.length)] }),
    () => ({ k: 'tool', s: `Write ${f}` }),
    () => ({ k: 'tool', s: 'shop.read' }),
  ];
  const n = 1 + Math.floor(r() * 3);
  const out = [];
  for (let i = 0; i < n; i++) out.push(pool[Math.floor(r() * pool.length)]());
  if (r() < 0.06) out.push({ k: 'err', s: `npm test: 1 failing - ${task.title.toLowerCase()} > handles empty input` }, { k: 'text', s: 'One test fails on empty input. Fixing the guard.' });
  return out;
}

function addTask(job, p) {
  const st = sim.st;
  const id = nextId('T');
  st.taskByK[p.k] = id;
  const mgrs = job.managerIds;
  const streams = ['data', 'pages'];
  const si = Math.max(0, streams.indexOf(p.stream));
  const t = {
    id, jobId: job.id, title: p.title, spec: p.spec, acceptance: p.acceptance, reqs: p.reqs.map((n) => (typeof n === 'number' ? 'R' + n : n)), domain: p.domain, size: p.size,
    zones: p.zones, claims: [], pendingClaims: [], deps: p.deps.map((k) => st.taskByK[k]).filter(Boolean), pair: !!p.pair, allowLarge: false,
    stream: p.stream ?? null, managerId: mgrs.length ? mgrs[si % mgrs.length] : null, note: null,
    status: 'planned', why: null, assigneeId: null, buddyId: null, reviewerId: null, sessionId: null, reviewSessionId: null,
    benchDir: null, reviewDir: null, baseSha: null, headSha: null, lastReviewedSha: null,
    attempts: 0, retries: 0, blocks: 0, progress: 0, summary: null, lastError: null, hold: null, needsAction: null, cardChanges: [], cost: { usd: 0 },
  };
  Object.defineProperty(t, '_k', { value: p.k, enumerable: false });
  S.tasks[id] = t;
  touch('tasks', t);
  return t;
}

function freeMaker(job, { except = null, canHire = true, otherThan = null } = {}) {
  const makers = jobAgents(job, 'maker');
  // Hire up to the crew size first, so the whole crew shows up; then reuse whoever is free.
  if (canHire && makers.length < sim.st.maxMakers) return hire(job, 'maker', makers.length);
  return makers.find((a) => a !== except && a.status === 'idle' && !a.taskId && (!otherThan || a.provider !== otherThan)) || null;
}

// ---- planning

function stepPlanning(job) {
  const st = sim.st;
  const t = ++st.planTick;
  const bosses = jobAgents(job, 'boss'), lead = bosses[0];
  const mgrs = jobAgents(job, 'manager');
  if (t === 1) {
    hubEvt(job.id, '#plan', `${job.id} opened: ${job.title}. Lead boss: ${lead.handle}. Crew: ${plural(bosses.length, 'boss', 'bosses')}, ${plural(mgrs.length, 'manager')}.`);
    for (const b of bosses) { b.status = 'thinking'; b.sessionId = newSession(b); touch('agents', b); log(b.id, { k: 'sys', s: 'turn 1 started: draft a plan' }); }
  }
  for (const b of bosses) {
    burn(job, b, null, 1.6);
    const lines = [
      [{ k: 'tool', s: 'Read .shop/BRIEF.md' }, { k: 'text', s: 'The brief asks for five things. I will list them as requirements first.' }],
      [{ k: 'tool', s: 'Bash ls -la' }, { k: 'text', s: 'A placeholder page and a README. A skeleton task must come first.' }],
      [{ k: 'text', s: 'Two streams fit: data and API on one side, pages on the other.' }],
      [{ k: 'text', s: 'Search and import both read the store. Only one task may write it.' }, { k: 'tool', s: 'shop.read' }],
      [{ k: 'text', s: 'Zones must not overlap inside a stream. Checking each pair.' }],
      [{ k: 'text', s: 'Every requirement has a task. Sizes: 3 small, 6 medium, 1 large.' }],
    ][(t - 1) % 6];
    log(b.id, ...lines);
  }
  if (t === 3) say(lead, 'INFO', { scope: '#plan', body: 'I draft the plan now. Makers start after the skeleton task merges.' });
  if (t === 6 && bosses[1]) st.planAsk = say(bosses[1], 'ASK', { to: lead, scope: '#plan', body: 'My draft has 9 tasks in 2 streams. Do we split search from the API task?' }).id;
  if (t === 8 && bosses[1]) say(lead, 'ANS', { re: st.planAsk, body: 'Yes. Search is its own task with a buddy check.' });
  if (t === 10) submitPlan(job);
}

function submitPlan(job) {
  const st = sim.st;
  const bosses = jobAgents(job, 'boss'), lead = bosses[0], mgrs = jobAgents(job, 'manager');
  job.requirements = PLAN.requirements.map((text, i) => ({ id: 'R' + (i + 1), text, source: 'plan', status: 'open', evidence: null, waivedReason: null }));
  job.assumptions = PLAN.assumptions.map((text) => ({ text, msgId: null }));
  job.notes = PLAN.notes;
  job.dropped = bosses[1] ? [{ draft: bosses[1].handle, n: PLAN.dropped.n, why: PLAN.dropped.why }] : [];
  const project = S.projects[job.projectId];
  if (project) {
    project.setupCmd = PLAN.setupCmd; project.checkCmd = PLAN.checkCmd;
    project.baseline = { sha: job.intSha, ok: true, flaky: false, ms: 5210, tail: '# tests 1\n# pass 1\n# fail 0\n# duration_ms 5210' };
    project.headCheck = { sha: job.intSha, ok: true, tail: project.baseline.tail };
    touch('projects', project);
  }
  for (const p of PLAN_TASKS) if (!p.late) addTask(job, p);
  for (const b of bosses) { log(b.id, { k: 'tool', s: 'shop.plan_submit {requirements:7, tasks:10}' }, { k: 'sys', s: 'turn ended: the hub accepted the plan' }); b.status = 'idle'; touch('agents', b); }
  const streams = mgrs.length >= 2 ? ` ${mgrs[0].handle} runs data and API. ${mgrs[1].handle} runs pages.` : mgrs.length === 1 ? ` ${mgrs[0].handle} runs both streams.` : '';
  say(lead, 'INFO', { scope: '#plan', body: `The plan has 10 tasks and 7 requirements in 2 streams.${streams}` });
  hubEvt(job.id, '#plan', `Plan applied. Setup: ${PLAN.setupCmd}. Check: ${PLAN.checkCmd}. The baseline check is green.`);
  if (bosses[1]) { // ledger audit by the other lab (section 12)
    job.requirements.push({ id: 'R8', text: PLAN.auditReq, source: 'boss', status: 'open', evidence: null, waivedReason: null });
    log(bosses[1].id, { k: 'sys', s: 'turn started: ledger audit' }, { k: 'tool', s: 'shop.req_add {text:"The README explains how to back up the recipe data"}' }, { k: 'sys', s: 'turn ended' });
    notice('info', `${bosses[1].name} added requirement R8 in the ledger audit: ${PLAN.auditReq}.`, job.id);
  } else for (const t of jobTasks(job)) t.reqs = t.reqs.filter((r) => r !== 'R8');
  if (job.options.approvePlan) {
    job.status = 'plan_review';
    notice('owner', 'The plan is ready. Read the Blueprint and approve it to start the crew.', job.id, 'blueprint');
  } else {
    job.status = 'running';
    notice('info', `Plan applied: 10 tasks, ${job.requirements.length} requirements. Makers start now.`, job.id);
  }
  st.planTick = 99;
  touch('jobs', job);
}

function approvePlan(job) {
  job.status = 'running';
  touch('jobs', job);
  hubEvt(job.id, '#plan', 'The owner approved the plan. Makers start now.');
}

// ---- running

const RATE = { S: 0.22, M: 0.13, L: 0.085 };
const EFFORT_OF_SIZE = { S: 'low', M: 'medium', L: 'high' };

function stepRunning(job) {
  const st = sim.st;
  for (const p of st.pending.filter((x) => x.at <= sim.tick)) { st.pending.splice(st.pending.indexOf(p), 1); p.run(); }

  const tasks = jobTasks(job);
  for (const t of tasks) {
    if (t.status === 'planned' && t.deps.every((d) => S.tasks[d] && S.tasks[d].status === 'merged')) { t.status = 'ready'; touch('tasks', t); }
  }
  for (const t of tasks) {
    if (t.status !== 'ready') continue;
    const maker = freeMaker(job);
    if (!maker) break;
    startTask(job, t, maker);
  }
  for (const t of tasks) {
    const m = meta(t.id);
    if (t.status === 'working' || t.status === 'rework') stepWork(job, t, m);
    else if (t.status === 'checking') stepCheck(job, t, m);
    else if (t.status === 'buddy') stepBuddy(job, t, m);
  }
  stepReviews(job);
  stepIntegrate(job);

  const merged = tasks.filter((t) => t.status === 'merged').length;
  if (!st.questionId && merged >= 4) askOwner(job);
  if (st.questionId && !st.answered && !st.defaulted && sim.tick - st.questionTick > (sim.ff ? 5 : settings.presence === 'away' ? 1 : QUESTION_WAIT_TICKS)) takeDefault(job);

  if (tasks.length && tasks.every((t) => t.status === 'merged' || t.status === 'cancelled') && tasks.some((t) => t.status === 'merged') && !st.integrating && !st.intQueue.length) startQA(job);
}

function startTask(job, t, maker) {
  const m = meta(t.id);
  t.status = 'working'; t.assigneeId = maker.id; t.attempts = 0; t.progress = 0;
  t.benchDir = `/Users/owner/WorkShop/data/work/${job.id}/${t.id}`; t.baseSha = job.intSha;
  maker.status = 'thinking'; maker.taskId = t.id; maker.effort = EFFORT_OF_SIZE[t.size] || 'medium'; maker.bubble = null;
  t.sessionId = newSession(maker);
  m.wait = 1;
  touch('tasks', t); touch('agents', maker);
  hubEvt(job.id, t.id, `${t.id} is yours: ${t.title}. The bench is ready.`, { to: maker });
  log(maker.id, { k: 'sys', s: `turn 1 started: ${t.id} ${t.title}` }, { k: 'tool', s: 'Read .shop/TASK.md' }, { k: 'tool', s: 'Read .shop/BLUEPRINT.md' });
}

function stepWork(job, t, m) {
  const maker = S.agents[t.assigneeId];
  if (!maker) return;
  if (m.blocked) return;
  if (m.wait > 0) { m.wait--; return; }
  if (maker.status !== 'working') { maker.status = 'working'; touch('agents', maker); if (t.status === 'rework') log(maker.id, { k: 'sys', s: `turn started: rework ${t.id} (try ${t.attempts + 1})` }); }

  for (const [i, c] of (CHATTER[t._k] || []).entries()) {
    if (m.said[i] || t.progress < c.at || t.attempts !== 0) continue;
    m.said[i] = true;
    chatter(job, t, m, maker, c);
    if (c.block) return;
  }
  t.progress = Math.min(1, round(t.progress + RATE[t.size] * (0.85 + sim.rng() * 0.3)));
  burn(job, maker, t);
  log(maker.id, ...workLines(t));
  touch('tasks', t);
  if (t.progress >= 1) handIn(job, t, m, maker);
}

function chatter(job, t, m, maker, c) {
  const st = sim.st;
  const mgr = S.agents[t.managerId] || S.agents[job.leadBossId];
  if (c.claim) {
    t.claims = [...t.claims, c.claim];
    touch('tasks', t);
    log(maker.id, { k: 'tool', s: `shop.claim {paths:["${c.claim}"]}` });
    hubEvt(job.id, t.id, `Claim granted: ${c.claim}.`, { to: maker });
    return;
  }
  const from = c.from === 'boss' ? S.agents[job.leadBossId] : maker;
  const msg = say(from, c.kind, { to: c.kind === 'BLOCK' || c.to === 'manager' ? mgr : null, scope: c.scope || t.id, slots: c.slots || {}, body: c.body });
  if (c.block) {
    m.blocked = true;
    t.status = 'blocked'; t.why = 'ask'; t.blocks += 1; maker.status = 'blocked';
    touch('tasks', t); touch('agents', maker);
    log(maker.id, { k: 'tool', s: `shop.post BLOCK ${t.id} why=blocked` }, { k: 'sys', s: 'turn ended: waiting for the manager' });
    notice('warn', `${maker.name} is blocked on ${t.id}. ${mgr.name} is on it.`, job.id);
  } else if (c.reply) {
    maker.status = 'waiting'; touch('agents', maker);
    m.wait = 2;
  }
  if (c.reply) {
    if (mgr.role === 'manager') { mgr.status = 'thinking'; if (!mgr.sessionId) mgr.sessionId = newSession(mgr); touch('agents', mgr); }
    st.pending.push({ at: sim.tick + (c.block ? 4 : 2), run: () => {
      say(mgr, 'ANS', { re: msg.id, body: c.reply });
      burn(job, mgr, null, 0.5);
      if (mgr.role === 'manager') { mgr.status = 'idle'; touch('agents', mgr); }
      if (c.block && t.status === 'blocked' && !m.ownerStop) {
        m.blocked = false;
        t.status = 'working'; t.why = null; maker.status = 'working';
        touch('tasks', t); touch('agents', maker);
        log(maker.id, { k: 'sys', s: 'woken: answer from the manager' });
      }
    } });
  }
}

function plainFiles(list) { return list.map(([p, add, del]) => ({ path: p, add, del })); }
function metaFiles(list) { return list.map(([p, add, del, kind, from]) => ({ path: p, add, del, kind: kind || 'new', from: from || null })); }

function handIn(job, t, m, maker) {
  const p = planOf(t);
  const second = t.attempts > 0 && p.files2;
  const files = second ? p.files2 : p.files || [['src/main.js', 20, 2, 'mod']];
  const total = t.acceptance.length;
  const met = t.attempts === 0 && p.acc1 != null ? p.acc1 : total;
  const tests = (second && p.tests2) || p.tests || 'none';
  t.progress = 1; t.status = 'checking'; t.headSha = fakeSha();
  t.summary = (second && p.summary2) || p.summary || 'Done as specified.';
  if (p.claims) t.claims = p.claims.slice();
  const done = say(maker, 'DONE', { scope: t.id, slots: { tests, acc: `${met}/${total}` }, body: t.summary });
  maker.status = 'waiting';
  log(maker.id, { k: 'tool', s: `shop.post DONE ${t.id} tests=${tests} acc=${met}/${total}` }, { k: 'sys', s: `turn ended: ${t.id} handed in` });
  const fl = p.flags || {};
  const d = {
    id: nextId('D'), jobId: job.id, taskId: t.id, makerId: maker.id, reviewerId: null, attempt: t.attempts + 1, status: 'checking',
    summary: t.summary, acc: { met, total }, tests, stat: null, files: plainFiles(files), check: null,
    baseSha: t.baseSha, headSha: t.headSha,
    flags: { empty: false, testsDeleted: fl.testsDeleted || 0, checkFiles: fl.checkFiles || [], claimed: fl.claimed || [], cardChanged: fl.cardChanged || [] },
    doneMsgId: done.id, buddy: null, review: null, mergeSha: null,
  };
  // The stub marks every second try as squashed (the hub squashes the bench history after a refused hand-in), so the
  // Truck panel shows its 'history squashed' flag.
  if (second) d.squashed = true;
  d.stat = { files: d.files.length, add: d.files.reduce((s, f) => s + f.add, 0), del: d.files.reduce((s, f) => s + f.del, 0) };
  S.deliveries[d.id] = d;
  m.delivery = d.id;
  fileMeta.set(d.id, metaFiles(files));
  m.wait = 2;
  touch('tasks', t); touch('agents', maker); touch('deliveries', d);
}

/** A refused hand-in or a FIX verdict: delivery rejected, task rework, attempts + 1 (section 12). */
function sendBack(job, t, m, d, lastError) {
  const maker = S.agents[t.assigneeId];
  d.status = 'rejected';
  t.status = 'rework'; t.attempts += 1; t.progress = 0.6; t.lastError = lastError;
  m.wait = 2;
  if (maker) { maker.status = 'thinking'; touch('agents', maker); }
  touch('deliveries', d); touch('tasks', t);
}

function stepCheck(job, t, m) {
  if (m.wait-- > 0) return;
  const d = S.deliveries[m.delivery], maker = S.agents[t.assigneeId];
  const project = S.projects[job.projectId];
  const cmd = project && project.checkCmd;
  if (t._k === 3 && !m.checkFailed) {
    m.checkFailed = true;
    d.check = { cmd, ok: false, tail: CHECK_FAIL_TAIL };
    const done = byMsgId.get(d.doneMsgId);
    if (done && done.state === 'open') patchMsg(done, { state: 'fix', due: null });
    sendBack(job, t, m, d, 'Check failed: 1 of 14 tests (DELETE /api/recipes/:id twice returns 500).');
    t.progress = 0.8;
    hubEvt(job.id, t.id, 'Check failed. See .shop/CHECK.log.', { to: maker });
    log(maker.id, { k: 'sys', s: 'woken: the check failed' }, { k: 'err', s: 'not ok 9 - DELETE /api/recipes/:id twice (500 !== 204)' });
    return;
  }
  d.check = cmd ? { cmd, ok: true, tail: CHECK_OK_TAIL } : null;
  t.lastError = null;
  touch('deliveries', d);
  if (t.pair && !m.buddyDone) {
    const buddy = freeMaker(job, { except: maker, canHire: false, otherThan: maker.provider });
    if (buddy) {
      m.buddyDone = true;
      d.status = 'buddy'; t.status = 'buddy'; t.buddyId = buddy.id;
      buddy.status = 'reviewing';
      m.wait = 2;
      touch('tasks', t); touch('agents', buddy); touch('deliveries', d);
      log(buddy.id, { k: 'sys', s: `turn started: buddy check ${t.id}` }, { k: 'tool', s: 'Bash git diff --stat' });
      return;
    }
  }
  toReview(job, t, m, d, maker);
}

function stepBuddy(job, t, m) {
  const buddy = S.agents[t.buddyId];
  const d = S.deliveries[m.delivery];
  if (buddy) { burn(job, buddy, t, 0.6); log(buddy.id, { k: 'text', s: 'Reading the diff against the acceptance list.' }); }
  if (m.wait-- > 0) return;
  if (buddy) {
    const notes = 'The ranking order matches the spec. I did not measure the speed.';
    say(buddy, 'PASS', { re: d.doneMsgId, body: notes, close: false }); // a buddy verdict does not close the DONE
    d.buddy = { by: buddy.id, verdict: 'pass', notes };
    log(buddy.id, { k: 'tool', s: `shop.post PASS re:${d.doneMsgId}` }, { k: 'sys', s: 'turn ended' });
    buddy.status = 'idle'; buddy.bubble = null; touch('agents', buddy);
  }
  toReview(job, t, m, d, S.agents[t.assigneeId]);
}

function toReview(job, t, m, d, maker) {
  const bosses = jobAgents(job, 'boss'), mgrs = jobAgents(job, 'manager');
  const queue = (b) => all('deliveries', (x) => x.status === 'review' && x.reviewerId === b.id).length + (sim.st.reviewing.has(b.id) ? 1 : 0);
  const least = (list) => list.slice().sort((a, b) => queue(a) - queue(b) || byId(a, b))[0] || null;
  const other = (list) => list.filter((a) => a.provider !== maker.provider);
  let reviewer = S.agents[t.reviewerId] || null; // the reviewer is sticky (section 12)
  if (!reviewer) {
    if (planOf(t).sameLab) reviewer = least(bosses.filter((a) => a.provider === maker.provider)); // stub: one crate shows the same-lab flag
    if (!reviewer && settings.review.crossLab) {
      if (t.size === 'S' && !t.pair && settings.review.smallByManager) reviewer = least(other(mgrs));
      reviewer = reviewer || least(other(bosses)) || least(other(mgrs));
    }
    reviewer = reviewer || least(bosses);
  }
  d.status = 'review'; d.reviewerId = reviewer.id;
  t.status = 'review'; t.reviewerId = reviewer.id;
  touch('deliveries', d); touch('tasks', t);
}

function stepReviews(job) {
  const st = sim.st;
  for (const rev of [...jobAgents(job, 'boss'), ...jobAgents(job, 'manager')]) {
    const cur = st.reviewing.get(rev.id);
    if (cur) {
      const t = S.tasks[cur.taskId];
      burn(job, rev, null, 1.2);
      log(rev.id, ...[
        [{ k: 'tool', s: 'Bash git diff --stat' }, { k: 'text', s: 'Reading the diff against the acceptance list.' }],
        [{ k: 'tool', s: `Read ${t ? (planOf(t).files || [['src/main.js']])[0][0] : 'src/main.js'}` }, { k: 'tool', s: 'Read .shop/CHECK.log' }],
        [{ k: 'text', s: 'Zones respected. Checking the edge cases named in the spec.' }],
      ][Math.max(0, Math.min(2, 3 - cur.wait))]);
      if (--cur.wait <= 0) finishReview(job, rev, cur);
      continue;
    }
    const d = all('deliveries', (x) => x.jobId === job.id && x.status === 'review' && x.reviewerId === rev.id && !ownerReviews.has(x.id)).sort(byId)[0];
    if (!d) continue;
    const t = S.tasks[d.taskId];
    st.reviewing.set(rev.id, { deliveryId: d.id, taskId: d.taskId, wait: t && planOf(t).slowReview ? 12 : 3, prev: rev.status });
    rev.status = 'reviewing'; rev.taskId = d.taskId;
    if (t && !t.reviewSessionId) t.reviewSessionId = 'ses_' + fakeSha().slice(0, 10);
    touch('agents', rev);
    log(rev.id, { k: 'sys', s: `turn started: review ${d.taskId} (${d.id})` });
  }
}

function finishReview(job, rev, cur) {
  const st = sim.st;
  const d = S.deliveries[cur.deliveryId], t = S.tasks[cur.taskId];
  st.reviewing.delete(rev.id);
  rev.status = cur.prev === 'waiting' ? 'waiting' : 'idle'; rev.taskId = null;
  touch('agents', rev);
  if (!d || !t) return;
  const m = meta(t.id);
  const maker = S.agents[d.makerId];
  const crossLab = !!maker && maker.provider !== rev.provider;
  t.lastReviewedSha = d.headSha;
  if (t._k === 4 && d.attempt === 1) {
    const mustFix = ['Build a token index once and update it on save (server/search.js:14).', 'Add a timing check for 5,000 recipes (test/search.test.js).'];
    const notes = 'The ranking is right. The speed is not: search() scans and tokenizes every recipe for each query. 5,000 recipes take 410 ms; the limit is 50 ms.';
    d.review = { by: rev.id, verdict: 'changes', notes, mustFix, headSha: d.headSha, crossLab };
    say(rev, 'FIX', { re: d.doneMsgId, body: mustFix.map((x, i) => `${i + 1}. ${x}`).join(' ') });
    sendBack(job, t, m, d, 'Review asked for changes: token index, timing check.');
    log(rev.id, { k: 'tool', s: `shop.post FIX re:${d.doneMsgId}` }, { k: 'sys', s: 'turn ended' });
    notice('warn', `${t.id} was sent back by review. ${maker ? maker.name : 'The maker'} reworks it.`, job.id);
    return;
  }
  const notes = REVIEW_NOTES[t._k] || 'Matches the spec. The check passes. Zones respected.';
  d.status = 'approved';
  d.review = { by: rev.id, verdict: 'pass', notes, mustFix: [], headSha: d.headSha, crossLab };
  say(rev, 'PASS', { re: d.doneMsgId, body: notes });
  t.status = 'integrating'; t.lastError = null;
  st.intQueue.push(d.id);
  touch('deliveries', d); touch('tasks', t);
  log(rev.id, { k: 'tool', s: `shop.post PASS re:${d.doneMsgId}` }, { k: 'sys', s: 'turn ended' });
}

function stepIntegrate(job) {
  const st = sim.st;
  if (st.integrating) {
    if (--st.integrating.wait > 0) return;
    const d = S.deliveries[st.integrating.id];
    st.integrating = null;
    if (!d) return;
    const t = S.tasks[d.taskId], maker = S.agents[d.makerId];
    d.status = 'loaded'; d.mergeSha = fakeSha(); d.loadedAt = loadStamp();
    job.intSha = d.mergeSha;
    touch('deliveries', d); touch('jobs', job);
    const project = S.projects[job.projectId];
    if (project && project.checkCmd) { project.headCheck = { sha: job.intSha, ok: true, tail: CHECK_OK_TAIL }; touch('projects', project); }
    if (t) {
      t.status = 'merged'; t.progress = 1; t.benchDir = null;
      const change = planOf(t).cardChange;
      if (change && !t.cardChanges.length) t.cardChanges = [{ by: (S.agents[job.leadBossId] || {}).handle || '@b1', what: change, ts: now() }];
      touch('tasks', t);
    }
    if (maker) { maker.status = 'idle'; maker.taskId = null; maker.bubble = null; touch('agents', maker); }
    hubEvt(job.id, '#merge', `${d.taskId} merged. Files: ${d.files.slice(0, 4).map((f) => f.path).join(', ')}${d.files.length > 4 ? ` and ${d.files.length - 4} more` : ''}.`);
    return;
  }
  if (st.intQueue.length) st.integrating = { id: st.intQueue.shift(), wait: 2 };
}

// ---- the owner question (section 12b)

function askOwner(job) {
  const st = sim.st;
  const boss = S.agents[job.leadBossId];
  const msg = say(boss, 'ASK', { to: '@human', scope: '#plan', slots: { default: OWNER_QUESTION.default }, body: OWNER_QUESTION.body });
  st.questionId = msg.id; st.questionTick = sim.tick;
  log(boss.id, { k: 'tool', s: 'shop.post ASK @human #plan default=A' }, { k: 'sys', s: 'turn ended: the question is in the inbox of the owner' });
  notice('owner', `${boss.name} asks: ${OWNER_QUESTION.short}`, job.id, 'inbox');
}

/** The owner is away, or the wait is over: the hub answers with the default option. */
function takeDefault(job) {
  const st = sim.st;
  const q = byMsgId.get(st.questionId);
  if (!q || q.state !== 'open') return;
  const opt = parseOptions(q.body).find((o) => o.key === q.slots.default) || { key: q.slots.default, text: '' };
  st.defaulted = true;
  post({ jobId: job.id, kind: 'ANS', re: q.id, body: `${opt.key}) ${opt.text} (default taken)` });
  patchMsg(q, { defaulted: true });
  job.assumptions = [...job.assumptions, { text: `Photos: ${opt.text} (default ${opt.key})`, msgId: q.id }];
  touch('jobs', job);
  const boss = S.agents[job.leadBossId];
  if (boss) log(boss.id, { k: 'sys', s: 'woken: the hub took the default answer' });
  notice('info', `No answer yet. The hub took the default (${opt.key}) for: ${OWNER_QUESTION.short} You can still overturn it.`, job.id);
}

function ownerAnswers(job, q, text) {
  const st = sim.st;
  if (st && q.id === st.questionId) st.answered = true;
  if (q.defaulted) patchMsg(q, { defaulted: false });
  const clean = clip(text.replace(/\s+/g, ' '), 110);
  job.assumptions = [...job.assumptions.filter((a) => a.msgId !== q.id), { text: `Photos: ${clean} (owner)`, msgId: null }];
  touch('jobs', job);
  const boss = S.agents[q.fromId] || S.agents[job.leadBossId];
  if (!boss) return;
  log(boss.id, { k: 'sys', s: 'woken: answer from the owner' });
  if (st) st.pending.push({ at: sim.tick + 2, run: () => say(boss, 'DECIDE', { scope: '#build', body: `The owner decided: ${clean}` }) });
}

// ---- things that only the owner can settle (section 12b): a verdict, a lost requirement, agent-config files

/** The reviewers of the crew are used up (limits.maxReviewers): the hand-in waits for the owner's PASS or FIX. */
function needOwnerVerdict(job, d) {
  const t = S.tasks[d.taskId];
  for (const [revId, cur] of sim.st.reviewing) { // a reviewer who has it on the desk puts it down
    if (cur.deliveryId !== d.id) continue;
    sim.st.reviewing.delete(revId);
    const rev = S.agents[revId];
    if (rev) { rev.status = 'idle'; rev.taskId = null; touch('agents', rev); }
  }
  d.status = 'review'; d.reviewerId = null;
  if (t) { t.status = 'review'; t.reviewerId = null; touch('tasks', t); }
  ownerReviews.add(d.id);
  touch('deliveries', d);
  hubEvt(job.id, d.taskId, `${d.taskId}: ${settings.limits.maxReviewers} reviewers looked at it and did not agree. The hand-in waits for the verdict of the owner.`, { to: '@human', re: d.doneMsgId });
  notice('owner', `${d.taskId} waits for your verdict: the reviewers of the crew are used up. Say PASS or FIX in the Inbox.`, job.id, 'inbox');
}

/** PASS or FIX from the owner on an open DONE: the review verdict (section 7). */
function ownerVerdict(job, d, kind, text) {
  const t = S.tasks[d.taskId];
  const st = sim.st && sim.jobId === job.id ? sim.st : null;
  if (st) for (const [revId, cur] of st.reviewing) if (cur.deliveryId === d.id) { st.reviewing.delete(revId); const rev = S.agents[revId]; if (rev) { rev.status = 'idle'; rev.taskId = null; touch('agents', rev); } }
  ownerReviews.delete(d.id);
  const maker = S.agents[d.makerId];
  if (kind === 'PASS') {
    d.status = 'approved';
    d.review = { by: '@human', verdict: 'pass', notes: text || 'Accepted by the owner.', mustFix: [], headSha: d.headSha, crossLab: true };
    if (t) { t.status = 'integrating'; t.lastError = null; t.lastReviewedSha = d.headSha; touch('tasks', t); }
    if (st) st.intQueue.push(d.id);
    touch('deliveries', d);
    return;
  }
  const mustFix = text.split(/\n|(?=\b\d\.\s)/).map((x) => x.replace(/^\d+[.)]\s*/, '').trim()).filter(Boolean).slice(0, 5);
  d.review = { by: '@human', verdict: 'changes', notes: 'The owner asked for changes.', mustFix, headSha: d.headSha, crossLab: true };
  if (t && st) sendBack(job, t, meta(t.id), d, 'The owner asked for changes.');
  else { d.status = 'rejected'; touch('deliveries', d); }
  if (maker) log(maker.id, { k: 'sys', s: `woken: FIX from the owner on ${d.taskId}` });
}

/** True when an open task serves the requirement. */
const served = (job, r) => all('tasks', (t) => t.jobId === job.id && !['merged', 'cancelled'].includes(t.status) && t.reqs.includes(r.id)).length > 0;
const LOST_EVIDENCE = { R1: 'A recipe with no photo link is refused (server/model.js:18).', R2: 'A search for "creme" misses the accented word (server/tokenize.js:9).', R3: 'DELETE answers 500 when the id holds a dot (server/api.js:88).',
  R4: 'A pasted recipe with an ingredient table loses the amounts (server/import.js:88).', R6: 'The server also listens on 0.0.0.0 (server/index.js:9).', R7: 'npm test: 1 of 34 tests fails on a clean clone.' };

/** QA fails a requirement and the lead boss adds no task for it: only the owner can go on (waive, add a task, stop the job). */
function loseRequirement(job) {
  const req = job.requirements.find((r) => r.status !== 'waived' && r.status !== 'failed' && !served(job, r));
  if (!req) return null;
  req.status = 'failed';
  req.evidence = LOST_EVIDENCE[req.id] || 'QA could not confirm it on the integration branch.';
  lostReqs.add(`${job.id}/${req.id}`);
  touch('jobs', job);
  hubEvt(job.id, '#plan', `QA: ${req.id} failed and no open task serves it. The owner decides: add a task, waive it, or stop the job.`);
  notice('owner', `${req.id} failed and no task serves it. Waive it, add a task, or stop the job in the Inbox.`, job.id, 'inbox');
  return req;
}

// ---- qa, delivering, done

const qaBoss = (job) => { const b = jobAgents(job, 'boss'); const lead = S.agents[job.leadBossId]; return b.find((x) => lead && x.provider !== lead.provider) || b[1] || b[0]; };

function startQA(job) {
  const boss = qaBoss(job);
  job.status = 'qa';
  job.qa = { round: (job.qa ? job.qa.round : 0) + 1, sha: job.intSha, agentId: boss.id, sessionId: 'ses_' + fakeSha().slice(0, 10) };
  for (const r of job.requirements) if (r.status !== 'waived' && r.status !== 'verified' && !lostReqs.has(`${job.id}/${r.id}`)) r.status = 'open';
  touch('jobs', job);
  hubEvt(job.id, '#build', `All tasks are merged. QA round ${job.qa.round} checks each requirement at ${job.intSha.slice(0, 7)}.`);
}

function stepQA(job) {
  const st = sim.st;
  const boss = qaBoss(job);
  if (boss.status !== 'working') { boss.status = 'working'; touch('agents', boss); log(boss.id, { k: 'sys', s: `turn started: QA round ${job.qa ? job.qa.round : 1}` }); }
  burn(job, boss, null, 1.4);
  log(boss.id, { k: 'tool', s: 'Bash npm test' }, { k: 'text', s: 'Checking the next requirement against the integration branch.' });
  if (sim.tick % 2) return;
  const lost = (r) => (r.status === 'open' || r.status === 'failed') && lostReqs.has(`${job.id}/${r.id}`);
  const req = job.requirements.find((r) => (r.status === 'open' || r.status === 'failed') && !lost(r));
  if (!req) {
    // The job ends only when each requirement is verified or waived (principle 5). One that no task serves waits for the owner.
    if (job.requirements.some(lost)) { if (boss.status !== 'idle') { boss.status = 'idle'; touch('agents', boss); } return; }
    toDelivering(job);
    return;
  }
  if (req.id === 'R5' && !st.printFailed) {
    st.printFailed = true;
    req.status = 'failed'; req.evidence = 'A recipe with 40 ingredients prints on two pages (public/print.css:41).';
    const t = addTask(job, PLAN_TASKS.find((p) => p.k === 11));
    log(boss.id, { k: 'tool', s: 'shop.req_verify {results:8}' }, { k: 'tool', s: `shop.task_add {title:"${t.title}"}` }, { k: 'sys', s: 'turn ended' });
    hubEvt(job.id, '#plan', `QA: R5 failed. A long ingredient list prints on two pages. ${boss.handle} added ${t.id}.`);
    job.status = 'running';
    boss.status = 'idle'; touch('agents', boss);
    notice('warn', `QA found a gap in R5. ${t.id} was added to fix it.`, job.id);
  } else {
    req.status = 'verified'; req.evidence = PLAN.evidence[Number(req.id.slice(1)) - 1] || 'Checked on the integration branch.';
  }
  touch('jobs', job);
}

function writeReport(job) {
  const tasks = jobTasks(job);
  const turns = jobAgents(job).reduce((s, a) => s + a.stats.turns, 0);
  const project = S.projects[job.projectId];
  const usd = job.cost.billedUsd + job.cost.estUsd;
  return [
    `# ${job.title}: report`, '',
    '## What is on the truck',
    `- ${plural(tasks.filter((t) => t.status === 'merged').length, 'task')} merged on **${job.integrationBranch}**.`,
    `- ${job.requirements.filter((r) => r.status === 'verified').length} of ${job.requirements.length} requirements verified.`,
    `- Target branch: \`${project ? project.targetBranch : 'main'}\`.`, '',
    '## Requirements',
    ...job.requirements.map((r) => `- **${r.id}** ${r.status}: ${r.evidence || 'no evidence'}`), '',
    '## Decisions',
    '1. Photos are links, not uploads.',
    '2. One data file: `data/recipes.json`, written through `server/store.js` only.',
    '3. API errors are `{error}` with a 4xx code.', '',
    '## Not done',
    '- Photo upload. Ask for it in a new work order if you want it.', '',
    '## How to run',
    '```',
    'npm install',
    'npm start',
    'open http://127.0.0.1:4100',
    '```', '',
    '## Cost',
    `${job.cost.billedUsd > 0 ? `$${job.cost.billedUsd.toFixed(2)} billed. ` : ''}About $${usd.toFixed(2)} at API prices over ${turns} turns. See [the pricing page](https://example.com/pricing).`,
  ].join('\n');
}

function toDelivering(job) {
  const boss = qaBoss(job), lead = S.agents[job.leadBossId];
  job.status = 'delivering';
  boss.status = 'idle';
  job.report = writeReport(job);
  touch('jobs', job); touch('agents', boss);
  log(boss.id, { k: 'tool', s: `shop.req_verify {results:${job.requirements.length}}` }, { k: 'sys', s: 'turn ended' });
  if (lead) log(lead.id, { k: 'sys', s: 'turn started: write the report' }, { k: 'tool', s: 'shop.job_report {md:"..."}' }, { k: 'sys', s: 'turn ended' });
  const n = loadedOf(job).length;
  if (!n) { finalize(job); return; }
  hubEvt(job.id, '#merge', `All ${job.requirements.length} requirements are verified. The truck holds ${plural(n, 'crate')}. It waits for the owner.`);
  notice('owner', `The truck is ready: ${plural(n, 'crate')} ${n === 1 ? 'waits' : 'wait'} for your approval.`, job.id, 'truck');
}

function stepDelivering(job) {
  const st = sim.st;
  if (!loadedOf(job).length) { finalize(job); return; }
  st.deliverWait++;
  if (sim.loop && !sim.ff && st.deliverWait > AUTO_SHIP_TICKS) {
    notice('info', 'Stub: nobody shipped, so the truck leaves by itself and the demo loops.', job.id);
    ship(job, job.intSha);
  }
}

function ship(job, sha) {
  const loaded = loadedOf(job);
  if (!loaded.length) throw httpError(409, 'Nothing is on the truck.');
  if (typeof sha !== 'string' || !sha) throw httpError(400, 'Send { sha }: the head the truck panel showed, or the merge commit of a loaded crate.');
  const project = S.projects[job.projectId];
  const branch = project ? project.targetBranch : 'main';
  if (sim.behind > 0) {
    // truck refresh (section 12): the target moved, so the hub merges it in, checks, and asks the owner to look again
    const n = sim.behind;
    sim.behind = 0;
    job.intSha = fakeSha();
    touch('jobs', job);
    flushDirty();
    hubEvt(job.id, '#merge', `${branch} moved by ${plural(n, 'commit')}. The truck was refreshed and the check is green.`);
    notice('owner', `Your branch moved (${plural(n, 'new commit')} on ${branch}). Look again, then ship.`, job.id, 'truck');
    return { ok: false, reason: 'Your branch moved. Look again, then ship.', moved: true, sha: job.intSha };
  }
  let batch = loaded;
  if (sha !== job.intSha) {
    const i = loaded.findIndex((d) => d.mergeSha === sha);
    if (i < 0) return { ok: false, reason: 'That commit is not on the truck. Reload the truck and try again.' }; // like the hub: a refusal is a 200
    batch = loaded.slice(0, i + 1);
  }
  for (const d of batch) { d.status = 'shipped'; touch('deliveries', d); }
  flushDirty();
  const left = loadedOf(job).length;
  emit('fx', { name: 'ship', payload: { jobId: job.id, sha } }); // the hub sends only these two
  hubEvt(job.id, '#merge', `Shipped ${plural(batch.length, 'crate')} to ${branch} at ${sha.slice(0, 7)}. ${plural(left, 'crate')} ${left === 1 ? 'stays' : 'stay'} loaded.`);
  if (job.status === 'delivering' && !left) finalize(job);
  return { ok: true, sha, left };
}

function finalize(job) {
  const st = sim.st;
  const lead = S.agents[job.leadBossId];
  if (!job.report) job.report = writeReport(job);
  job.status = 'done';
  touch('jobs', job);
  for (const a of jobAgents(job)) {
    a.status = a === lead ? 'idle' : 'off'; a.taskId = null;
    a.bubble = a === lead ? { text: 'Job done!', kind: 'done', seq: ++bubbleSeq } : null;
    touch('agents', a);
  }
  if (st) st.doneTick = sim.tick;
  flushDirty();
  emit('fx', { name: 'confetti', payload: { jobId: job.id } });
  hubEvt(job.id, '#merge', `${job.id} is done. The report is in the Truck panel.`);
  notice('owner', `${job.id} is done.`, job.id, null); // like the hub: an owner notice that no panel needs (S5)
}

// ---- stress mode: a big busy shop for performance checks

const STRESS_WORDS = ['parser', 'router', 'cache', 'index', 'form', 'table', 'export', 'import', 'auth guard', 'log view', 'scheduler', 'queue', 'report', 'chart', 'search', 'sync'];
function buildStress() {
  const job = startJob({ ...DEFAULT_ORDER, title: 'Stress: big shop', crew: { bosses: 3, managers: 3, makers: 8 } });
  const st = sim.st;
  job.status = 'running';
  job.requirements = Array.from({ length: 14 }, (_, i) => ({ id: 'R' + (i + 1), text: `Requirement ${i + 1}: the ${STRESS_WORDS[i % STRESS_WORDS.length]} works end to end`, source: i % 5 === 4 ? 'owner' : 'plan',
    status: i < 5 ? 'verified' : 'open', evidence: i < 5 ? 'Checked on the integration branch.' : null, waivedReason: null }));
  job.assumptions = PLAN.assumptions.map((text) => ({ text, msgId: null })); job.notes = PLAN.notes;
  const project = S.projects[job.projectId];
  project.setupCmd = PLAN.setupCmd; project.checkCmd = PLAN.checkCmd; touch('projects', project);
  const makers = Array.from({ length: 8 }, (_, i) => hire(job, 'maker', i));
  const statuses = [].concat(Array(22).fill('merged'), Array(8).fill('working'), Array(2).fill('rework'), Array(3).fill('checking'), Array(3).fill('review'),
    ['buddy'], Array(2).fill('integrating'), Array(2).fill('blocked'), ['failed'], Array(6).fill('ready'), Array(9).fill('planned'), ['cancelled']);
  const bosses = jobAgents(job, 'boss');
  statuses.forEach((status, i) => {
    const w = STRESS_WORDS[i % STRESS_WORDS.length];
    const t = addTask(job, { k: 100 + i, title: `${['Build', 'Wire', 'Test', 'Harden', 'Document'][i % 5]} the ${w} (${i + 1})`, domain: DOMAINS[1 + (i % 12)], size: 'SML'[i % 3], stream: ['data', 'pages'][i % 2],
      deps: i > 2 ? [100 + i - 3] : [], reqs: [1 + (i % 14)], zones: [`src/${w.replace(' ', '-')}/**`, `test/${w.replace(' ', '-')}.test.js`],
      spec: `Make the ${w} do its job. Keep the change inside the zone.`, acceptance: ['The check passes', 'No file outside the zone changes'] });
    t.status = status;
    if (status === 'blocked') { t.why = i % 2 ? 'ask' : 'env'; t.needsAction = { kind: 'blocked', since: now() }; }
    if (status === 'failed') { t.needsAction = { kind: 'failed', since: now() }; t.lastError = 'The maker stopped: why=tests.'; }
    const active = !['planned', 'ready', 'cancelled'].includes(status);
    if (active) {
      const maker = makers[i % makers.length];
      t.assigneeId = maker.id; t.attempts = status === 'rework' ? 1 : 0;
      t.progress = status === 'working' ? round(0.1 + (i % 8) / 10) : status === 'rework' ? 0.6 : 1;
      if (status === 'working' || status === 'rework' || status === 'blocked') { maker.status = status === 'blocked' ? 'blocked' : 'working'; maker.taskId = t.id; }
      if (status !== 'working' && status !== 'blocked' && status !== 'failed') {
        const files = [[`src/${w.replace(' ', '-')}/index.js`, 40 + i, i % 7, 'mod'], [`test/${w.replace(' ', '-')}.test.js`, 30 + (i % 20), 0]];
        const rev = bosses[i % 3];
        const d = { id: nextId('D'), jobId: job.id, taskId: t.id, makerId: maker.id, reviewerId: rev.id, attempt: t.attempts + 1,
          status: status === 'merged' ? (i < 8 ? 'shipped' : 'loaded') : status === 'rework' ? 'rejected' : status === 'integrating' ? 'approved' : status === 'review' ? 'review' : status === 'buddy' ? 'buddy' : 'checking',
          summary: `The ${w} is done as specified.`, acc: { met: 2, total: 2 }, tests: `${12 + (i % 9)}/${12 + (i % 9)}`, stat: { files: 2, add: 70 + i + (i % 20), del: i % 7 }, files: plainFiles(files),
          check: { cmd: 'npm test', ok: true, tail: CHECK_OK_TAIL }, baseSha: fakeSha(), headSha: fakeSha(),
          flags: { empty: false, testsDeleted: i % 11 === 0 ? 1 : 0, checkFiles: [], claimed: [], cardChanged: [] }, squashed: i % 13 === 5, doneMsgId: null, buddy: null,
          review: status === 'merged' ? { by: rev.id, verdict: 'pass', notes: 'Matches the spec.', mustFix: [], headSha: null, crossLab: rev.provider !== maker.provider } : null, mergeSha: status === 'merged' ? fakeSha() : null };
        if (d.review) d.review.headSha = d.headSha;
        S.deliveries[d.id] = d; fileMeta.set(d.id, metaFiles(files)); touch('deliveries', d);
        if (d.status === 'loaded') { d.loadedAt = loadStamp(); job.intSha = d.mergeSha; }
      }
    }
  });
  bosses[1].status = 'reviewing'; bosses[2].status = 'thinking';
  const everyone = jobAgents(job);
  everyone.forEach((a, i) => { // every shade of the context bar, and one agent on hold
    a.stats.ctxTok = Math.round(a.stats.ctxMax * [0.08, 0.31, 0.55, 0.72, 0.86, 0.93, 0.18][i % 7]);
    a.stats.turns = 4 + i * 3; a.stats.inTok = 180000 + i * 91000; a.stats.outTok = 21000 + i * 7000; a.stats.usd = round(0.4 + i * 0.37);
  });
  makers[5].hold = { reason: 'lab', provider: makers[5].provider, model: makers[5].model, since: now() - 8 * 60000, until: now() + 22 * 60000 };
  const mgrs = jobAgents(job, 'manager');
  const pat = ['INFO', 'EVT', 'ASK', 'ANS', 'INFO', 'DONE', 'PASS', 'BLOCK', 'ANS', 'DECIDE', 'DONE', 'FIX'];
  const lines = ['zone ok, check passes', 'need the shape of the cache entry before I continue', 'use the helper in src/util, do not copy it', 'one more crate is on the truck',
    'the export breaks on empty rows, fixing', 'blocked on the router change', 'one module per feature, no shared state'];
  for (let i = 0; i < 2000; i++) {
    const kind = pat[i % pat.length];
    const a = makers[i % makers.length], mgr = mgrs[i % mgrs.length], boss = bosses[i % bosses.length];
    const scope = kind === 'EVT' ? '#merge' : kind === 'DECIDE' ? '#build' : 'T' + (1 + (i % 60));
    const author = kind === 'EVT' ? null : kind === 'ANS' ? mgr : ['PASS', 'FIX', 'DECIDE'].includes(kind) ? boss : a;
    const reply = ['ANS', 'PASS', 'FIX'].includes(kind);
    const target = reply ? board[board.length - 1] : null;
    const msg = { id: ++boardSeq, ts: now() - (2000 - i) * 4000, jobId: job.id, from: author ? author.handle : '@hub', fromId: author ? author.id : null, role: author ? author.role : 'hub',
      kind, to: kind === 'ASK' || kind === 'BLOCK' ? mgr.handle : null, toId: kind === 'ASK' || kind === 'BLOCK' ? mgr.id : null, toAlias: null, scope: target ? target.scope : scope,
      re: target ? target.id : null, thread: target ? target.thread : boardSeq, slots: kind === 'DONE' ? { tests: '12/12', acc: '2/2' } : kind === 'BLOCK' ? { why: 'blocked' } : {},
      body: `${lines[i % lines.length]} (${i + 1})`, state: TRACKED.has(kind) ? 'open' : null, due: null, seenAt: null, esc: 0, defaulted: false, stale: false };
    if (target && CLOSES[kind]) target.state = CLOSES[kind];
    board.push(msg); byMsgId.set(msg.id, msg);
  }
  flushDirty();
  sim.mode = 'stress';
}

function stepStress() {
  const job = S.jobs[sim.jobId];
  if (!job || job.status !== 'running') return;
  const r = sim.rng;
  const agents = jobAgents(job);
  for (const a of agents) {
    if (a.status === 'off') continue;
    log(a.id, { k: 'tool', s: `Edit src/${STRESS_WORDS[Math.floor(r() * 16)].replace(' ', '-')}/index.js (+${Math.floor(r() * 30)} -${Math.floor(r() * 8)})` },
      { k: 'text', s: THOUGHTS[Math.floor(r() * THOUGHTS.length)] }, { k: r() < 0.1 ? 'err' : 'tool', s: 'Bash npm test' });
    if (r() < 0.5) { const keep = a.stats.ctxTok; burn(job, a, null); a.stats.ctxTok = keep; }
  }
  for (const t of jobTasks(job)) {
    if (t.status !== 'working') continue;
    t.progress = round(t.progress + 0.04);
    if (t.progress >= 1) t.progress = 0.05;
    touch('tasks', t);
  }
  for (let i = 0; i < 3; i++) {
    const a = agents[Math.floor(r() * agents.length)], b = agents[Math.floor(r() * agents.length)];
    const kind = ['INFO', 'ASK', 'INFO', 'DECIDE', 'INFO'][Math.floor(r() * 5)];
    if (kind === 'DECIDE' && a.role === 'maker') continue;
    say(a, kind, { to: kind === 'ASK' ? b : null, scope: kind === 'DECIDE' ? '#build' : `T${1 + Math.floor(r() * 60)}`, body: kind === 'ASK' ? 'Which helper do I use for the cache entry?' : THOUGHTS[Math.floor(r() * THOUGHTS.length)] });
  }
}

// ---- stepping and scenarios

function step() {
  if (ffClock !== null) ffClock += FF_STEP_MS;
  if (!sim.jobId) return;
  const job = S.jobs[sim.jobId];
  if (!job) return;
  if (sim.mode === 'stress') { sim.tick++; stepStress(); flushDirty(); return; }
  if (['done', 'cancelled'].includes(job.status) && promoteQueued()) return; // the floor is free: the next work order starts
  if (['paused', 'cancelled'].includes(job.status)) return;
  sim.tick++;
  if (job.status === 'planning') stepPlanning(job);
  else if (job.status === 'plan_review') { if (sim.ff) approvePlan(job); }
  else if (job.status === 'running') stepRunning(job);
  else if (job.status === 'qa') stepQA(job);
  else if (job.status === 'delivering') stepDelivering(job);
  else if (job.status === 'done') { if (sim.loop && !sim.ff && sim.tick - sim.st.doneTick > DONE_LINGER_TICKS) startJob(DEFAULT_ORDER); }
  expireBubbles();
  flushDirty();
}

// A speech bubble lasts a few ticks. A question to the owner stays until it is answered.
function expireBubbles() {
  const st = sim.st, job = S.jobs[sim.jobId];
  if (!st || !job) return;
  st.bubbles ||= new Map();
  for (const a of jobAgents(job)) {
    if (!a.bubble) { st.bubbles.delete(a.id); continue; }
    const rec = st.bubbles.get(a.id);
    if (!rec || rec.seq !== a.bubble.seq) { st.bubbles.set(a.id, { seq: a.bubble.seq, tick: sim.tick }); continue; }
    const keep = a.id === job.leadBossId && st.questionId && !st.answered && !st.defaulted && a.bubble.kind === 'ask';
    if (!keep && job.status !== 'done' && sim.tick - rec.tick >= 6) { a.bubble = null; touch('agents', a); }
  }
}

function runUntil(pred, max = 4000) {
  for (let i = 0; i < max; i++) { if (pred()) return; step(); }
  throw httpError(500, 'Stub scenario was not reached. The simulation script changed.');
}
const curJob = () => S.jobs[sim.jobId];
const SCENARIOS = {
  empty() { sim.paused = true; },
  loop() { startJob(DEFAULT_ORDER); },
  planning() { startJob(DEFAULT_ORDER); runUntil(() => sim.st.planTick >= 7); sim.paused = true; },
  plan_review() { startJob({ ...DEFAULT_ORDER, options: { approvePlan: true } }); runUntil(() => curJob().status === 'plan_review'); sim.paused = true; },
  running() {
    startJob(DEFAULT_ORDER);
    // a busy moment: crates on the truck, a review in progress, makers at work, one check that failed, one blocked maker just helped
    runUntil(() => loadedOf(curJob()).length >= 3 && sim.st.reviewing.size > 0 && jobAgents(curJob(), 'maker').filter((a) => a.status === 'working').length >= 2);
    sim.paused = true;
  },
  question() { startJob(DEFAULT_ORDER); runUntil(() => sim.st.questionId !== null); step(); sim.paused = true; },
  // 3 crates are loaded and the job still runs: the truck is docked, the owner may ship early.
  loaded() { startJob(DEFAULT_ORDER); runUntil(() => loadedOf(curJob()).length === 3); sim.paused = true; },
  // The job is in "delivering": every requirement is verified, the truck waits for the owner.
  delivering() { startJob(DEFAULT_ORDER); sim.ff = true; runUntil(() => curJob().status === 'delivering'); sim.ff = false; sim.paused = true; },
  truck() { SCENARIOS.delivering(); },
  done() { startJob(DEFAULT_ORDER); sim.ff = true; runUntil(() => curJob().status === 'delivering'); ship(curJob(), curJob().intSha); sim.ff = false; sim.paused = true; },
  paused() { SCENARIOS.running(); const job = curJob(); job.prevStatus = job.status; job.status = 'paused'; job.pauseReason = 'owner'; touch('jobs', job); flushDirty(); },
  // A cancelled job whose truck is not empty: the Truck panel offers "Ship loaded crates" or "Discard".
  cancelled() { SCENARIOS.loaded(); retireJob(curJob(), 'cancelled'); flushDirty(); },
  // That cancelled job, and a newer job on the floor whose truck holds crates too (section 12, Cancel): the crates of the
  // cancelled job still wait for "Ship loaded crates" or "Discard", and the Truck panel must reach both trucks.
  stranded() {
    SCENARIOS.cancelled();
    startJob({ ...DEFAULT_ORDER, title: 'Recipe Box: second batch', brief: 'Go on with the recipe box after the first job was cancelled. Keep what the first job shipped.' });
    runUntil(() => loadedOf(curJob()).length >= 2 && jobAgents(curJob(), 'maker').filter((a) => a.status === 'working').length >= 2);
    sim.paused = true;
  },
  // A job on the floor and a second work order that waits behind it (contract section 4).
  queued() {
    SCENARIOS.running();
    const order = { title: 'Recipe Box: dark mode', kind: 'build', brief: 'Add a dark mode to the recipe pages. Follow the system setting. Keep the print page light.',
      project: { mode: 'existing', path: '/Users/owner/Code/recipe-box', agentFilesAck: true }, crew: 'standard', options: { approvePlan: true } };
    const job = makeJob(order, 'queued');
    queuedOrders.set(job.id, order);
    flushDirty();
  },
  // One of everything that waits for the owner (section 12b), on a running job.
  inbox() {
    startJob({ ...DEFAULT_ORDER, project: { ...DEFAULT_ORDER.project, agentFilesAck: false } });
    const inReview = () => all('deliveries', (d) => d.jobId === sim.jobId && d.status === 'review').sort(byId)[0];
    runUntil(() => sim.st.questionId !== null && !!inReview());
    needOwnerVerdict(curJob(), inReview());
    loseRequirement(curJob());
    flushDirty();
    sim.paused = true;
  },
  stress() { buildStress(); },
};

function gotoScenario(name) {
  const run = Object.hasOwn(SCENARIOS, name) ? SCENARIOS[name] : null;
  if (!run) throw httpError(404, `Unknown scenario "${name}". Use one of: ${Object.keys(SCENARIOS).join(', ')}.`);
  dropClients();
  muted = true;
  ffClock = Date.now() - 45 * 60 * 1000;
  try {
    freshState(); resetSim();
    freshConfig();
    sim.loop = name === 'loop' || name === 'stress'; // a scenario is one job: never roll over into the next one
    run();
    flushDirty();
  } finally {
    muted = false; ffClock = null;
  }
  return info(name);
}

function info(scenario) {
  const job = curJob();
  return { ok: true, scenario: scenario || null, paused: sim.paused, mode: sim.mode, speed: SPEED, tick: sim.tick, seq: S.seq, clients: clients.size,
    job: job ? { id: job.id, status: job.status, tasks: jobTasks(job).length, merged: jobTasks(job).filter((t) => t.status === 'merged').length, loaded: loadedOf(job).length } : null,
    board: board.length, revealed: revealed.slice(-10) };
}

let timer = null;
function loopTick() {
  timer = setTimeout(loopTick, (sim.mode === 'stress' ? 250 : TICK_MS) / SPEED);
  if (sim.paused) return;
  try { step(); } catch (e) { console.error('[stub] simulation step failed:', e); sim.paused = true; }
}

// ------------------------------------------------------------------ inbox (contract section 12b) and toolkit (12c)

function inboxOf(jobId) {
  const out = [];
  const seenKeys = new Set();
  // "since" is the moment an item first waited, not the last change of its job
  const add = (item) => { const key = `${item.kind}:${item.id}`; seenKeys.add(key); if (!waitSince.has(key)) waitSince.set(key, item.since ?? now()); out.push({ ...item, since: waitSince.get(key) }); };
  const humanAnswered = new Set(board.filter((m) => m.kind === 'ANS' && m.from === '@human' && m.re != null).map((m) => m.re));
  for (const job of all('jobs', (j) => !j.deleted).sort(byId)) {
    if (jobId && job.id !== jobId) continue;
    const open = ACTIVE.includes(job.status);
    if (open) {
      for (const m of board) {
        if (m.jobId !== job.id || m.kind !== 'ASK' || m.to !== '@human' || humanAnswered.has(m.id)) continue;
        if (m.state !== 'open' && !m.defaulted) continue;
        // like the hub: text is the question without its options; msgId and from name the post
        const opts = parseOptions(m.body);
        const head = opts.length ? m.body.slice(0, m.body.search(/(?:^|\s)A\)\s/)).trim() : m.body;
        add({ kind: 'question', id: m.id, jobId: job.id, text: head || m.body, since: m.ts, options: opts, default: m.slots.default || null, defaulted: !!m.defaulted, msgId: m.id, from: m.from });
      }
      for (const d of all('deliveries', (x) => x.jobId === job.id && x.status === 'review' && ownerReviews.has(x.id)).sort(byId)) {
        add({ kind: 'review', id: d.id, jobId: job.id, text: `${d.taskId} waits for your verdict: PASS re:${d.doneMsgId} or FIX re:${d.doneMsgId}.`, msgId: d.doneMsgId });
      }
      // Like the hub on disk: a requirement that no task serves waits for the owner, when QA failed it and also when it is open.
      for (const r of job.requirements) {
        if (r.status !== 'waived' && r.status !== 'verified' && lostReqs.has(`${job.id}/${r.id}`) && !served(job, r)) add({ kind: 'requirement', id: r.id, jobId: job.id, text: `${r.id} has no task: ${clip(r.text, 160)}`, reqId: r.id, options: [{ key: 'waive', text: 'Waive' }, { key: 'task', text: 'Add task' }, { key: 'stop', text: 'Stop job' }] });
      }
      const project = S.projects[job.projectId];
      if (project && project.agentFiles.length && !project.agentFilesAck && !filesAnswered.has(project.id)) {
        add({ kind: 'agentfiles', id: project.id, projectId: project.id, jobId: job.id, text: `${project.name} holds agent-config files: ${project.agentFiles.join(', ')}. Gemini workers will load these.` });
      }
    }
    if (job.status === 'plan_review') add({ kind: 'plan', id: job.id, jobId: job.id, text: 'The plan waits for your approval.' });
    const loaded = loadedOf(job).length;
    if (job.status === 'delivering' && loaded) add({ kind: 'truck', id: job.id, jobId: job.id, text: `The truck holds ${plural(loaded, 'crate')}. Approve to ship.` });
    if (job.status === 'cancelled' && loaded) add({ kind: 'truck', id: job.id, jobId: job.id, text: `${job.id} is cancelled. ${plural(loaded, 'reviewed crate')} ${loaded === 1 ? 'is' : 'are'} still on the truck. Ship or discard.` });
    if (job.status === 'paused') add({ kind: job.pauseReason === 'budget' ? 'budget' : 'paused', id: job.id, jobId: job.id, text: job.error || (job.pauseReason === 'owner' ? 'You paused the job.' : `The hub paused the job (${job.pauseReason}).`) });
  }
  // Like the hub: a lab is listed only when agents of a live job use it and it is signed out (auth none), with that job's id.
  for (const job of all('jobs', (j) => !j.deleted && ACTIVE.includes(j.status) && j.status !== 'paused').sort(byId)) {
    if (jobId && job.id !== jobId) continue;
    const used = new Set(jobAgents(job).filter((a) => a.status !== 'off').map((a) => a.provider));
    for (const p of providersOut()) if (used.has(p.id) && p.usable === false && p.auth === 'none') add({ kind: 'signin', id: p.id, provider: p.id, jobId: job.id, text: `${p.label || p.id}: ${p.reason || 'sign in again'}`, since: presenceAt });
  }
  if (!jobId) for (const key of [...waitSince.keys()]) if (!seenKeys.has(key)) waitSince.delete(key);
  return out.sort((a, b) => b.since - a.since);
}

// The tool wall of a project (section 12c). The shapes and the checks follow server/toolkit.js.
const TOOL_ID = /^[A-Za-z0-9_-]{1,40}$/;
function starterTools() {
  return [
    { id: 'check', name: 'Run checks', icon: 'gauge', kind: 'command', action: 'check', command: '', confirm: true },
    { id: 'folder', name: 'Open folder', icon: 'folder', kind: 'command', action: 'reveal', command: '', confirm: false },
    { id: 'status', name: 'Status report', icon: 'clipboard', kind: 'ask', ask: { to: '@boss', body: 'Report what was finished today and what is slow.' }, confirm: false },
    { id: 'blocked', name: 'What is blocked?', icon: 'wrench', kind: 'ask', ask: { to: '@boss', body: 'List every blocked task and what it waits for.' }, confirm: false },
  ];
}
/** One tool from the owner, checked and made regular. */
function normalizeTool(input, index) {
  const where = `Tool ${index + 1}`;
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  if (!isObj(input)) throw httpError(400, `${where} must be an object.`);
  const id = input.id == null || input.id === '' ? `t${randomBytes(3).toString('hex')}` : String(input.id);
  if (!TOOL_ID.test(id)) throw httpError(400, `${where}: the id may hold letters, digits, dash and underscore only (at most 40).`);
  const name = str(input.name);
  if (!name || name.length > 60) throw httpError(400, `${where}: the name must have 1 to 60 characters.`);
  const icon = str(input.icon) || 'wrench';
  if (icon.length > 24 || !/^[a-z0-9_-]+$/i.test(icon)) throw httpError(400, `${where}: the icon must be a short word.`);
  if (!['command', 'order', 'ask'].includes(input.kind)) throw httpError(400, `${where}: kind must be command, order or ask.`);
  const tool = { id, name, icon, kind: input.kind, confirm: input.confirm === true };
  if (input.kind === 'command') {
    const action = input.action == null || input.action === '' ? null : String(input.action);
    if (action !== null && !['check', 'reveal'].includes(action)) throw httpError(400, `${where}: action must be check or reveal.`);
    if (action) { tool.action = action; tool.command = ''; } else {
      const command = str(input.command);
      if (!command) throw httpError(400, `${where}: a command tool needs a command.`);
      if (command.length > 2000) throw httpError(400, `${where}: the command is longer than 2000 characters.`);
      tool.command = command;
    }
  } else if (input.kind === 'order') {
    const o = isObj(input.order) ? input.order : null;
    if (!o) throw httpError(400, `${where}: an order tool needs { order: { title, brief, kind, crew } }.`);
    const title = str(o.title), brief = str(o.brief);
    if (!title || title.length > 120) throw httpError(400, `${where}: the order title must have 1 to 120 characters.`);
    if (!brief) throw httpError(400, `${where}: the order needs a brief.`);
    const kind = o.kind == null || o.kind === '' ? 'build' : o.kind;
    if (!['build', 'fix', 'research'].includes(kind)) throw httpError(400, `${where}: the order kind must be build, fix or research.`);
    tool.order = { title, brief, kind, crew: o.crew == null || o.crew === '' ? null : o.crew };
    if (o.budgetUsd != null && o.budgetUsd !== '') {
      const b = Number(o.budgetUsd);
      if (!Number.isFinite(b) || b <= 0) throw httpError(400, `${where}: the order budget must be a number above 0.`);
      tool.order.budgetUsd = b;
    }
  } else {
    const a = isObj(input.ask) ? input.ask : null;
    if (!a) throw httpError(400, `${where}: an ask tool needs { ask: { to, body } }.`);
    const to = a.to == null || a.to === '' ? '@boss' : a.to;
    if (!['@boss', '@mgr'].includes(to)) throw httpError(400, `${where}: ask.to must be @boss or @mgr.`);
    const body = str(a.body);
    if (!body || body.length > 600) throw httpError(400, `${where}: the message must have 1 to 600 characters.`);
    tool.ask = { to, body };
  }
  return tool;
}
/** What the panel shows: the check tool carries the project's current check command. */
const presentTools = (project, tools) => tools.map((t) => (t.action === 'check' ? { ...t, command: project.checkCmd || '' } : { ...t }));
/** What a command prints in the stub. A command that holds "fail" ends with exit code 1. */
function fakeOutput(command) {
  if (/fail|exit 1/.test(command)) return { code: 1, chunks: ['Running...\n', 'error: the stub was asked to fail\n'] };
  if (/test|check/.test(command)) return { code: 0, chunks: ['> recipe-box@0.1.0 test\n> node --test test/\n\n', CHECK_OK_TAIL + '\n'] };
  if (/build/.test(command)) return { code: 0, chunks: ['> recipe-box@0.1.0 build\n', 'bundled 14 files in 0.8 s\n', 'done\n'] };
  return { code: 0, chunks: ['(the stub hub runs nothing; a real hub would run this in the project folder)\n'] };
}

// ------------------------------------------------------------------ diffs

const JS_LINES = [
  "import { readFile, writeFile, rename } from 'node:fs/promises';", "import path from 'node:path';", '', 'const cache = new Map();', '',
  'export async function load(file) {', "  const text = await readFile(file, 'utf8');", '  const data = JSON.parse(text);', '  for (const item of data) cache.set(item.id, item);', '  return data;', '}', '',
  'export function validate(recipe) {', "  if (!recipe || typeof recipe !== 'object') return 'Recipe must be an object.';", "  if (!recipe.title || !recipe.title.trim()) return 'Title is required.';",
  "  if (!Array.isArray(recipe.ingredients) || recipe.ingredients.length === 0) return 'Add at least one ingredient.';", '  return null;', '}', '',
  'export async function save(file, items) {', "  const tmp = file + '.tmp';", '  await writeFile(tmp, JSON.stringify(items, null, 2));', '  await rename(tmp, file);', '}', '',
  'function tokenize(text) {', "  return text.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);", '}', '',
  'export function rank(recipe, tokens) {', '  let score = 0;', '  for (const t of tokens) {', '    if (recipe.title.toLowerCase() === t) score += 100;', '    else if (recipe.title.toLowerCase().startsWith(t)) score += 40;',
  '    if (recipe.ingredients.some((i) => i.toLowerCase().includes(t))) score += 10;', '  }', '  return score;', '}', '',
  '// Keep handlers small: parse, call the store, answer.', 'export async function handle(req, res) {', '  try {', '    const body = await readJson(req);', '    const error = validate(body);',
  "    if (error) return send(res, 400, { error });", '    const saved = await store.put(body);', '    return send(res, 201, saved);', '  } catch (err) {', "    return send(res, 500, { error: 'Unexpected error.' });", '  }', '}', '',
];
const CSS_LINES = [
  ':root {', '  --ink: #222;', '  --paper: #fffdf6;', '  --accent: #c0392b;', '}', '', 'body {', '  margin: 0;', '  font: 16px/1.5 system-ui, sans-serif;', '  color: var(--ink);', '  background: var(--paper);', '}', '',
  '.card {', '  border: 1px solid #ddd;', '  padding: 12px 16px;', '  break-inside: avoid;', '}', '', '.card h2 {', '  margin: 0 0 8px;', '  font-size: 18px;', '}', '',
  '@media print {', '  nav, .search, button { display: none; }', '  .ingredients { columns: 2; }', '  img { max-height: 33vh; }', '}', '',
];
const HTML_LINES = [
  '<!doctype html>', '<html lang="en">', '<head>', '  <meta charset="utf-8">', '  <title>Recipe Box</title>', '  <link rel="stylesheet" href="style.css">', '</head>', '<body>',
  '  <header>', '    <h1>Recipe Box</h1>', '    <input class="search" type="search" placeholder="Search by name or ingredient" aria-label="Search">', '  </header>',
  '  <main id="list" class="cards"></main>', '  <template id="card">', '    <article class="card">', '      <h2></h2>', '      <p class="tags"></p>', '    </article>', '  </template>',
  '  <script type="module" src="list.js"></script>', '</body>', '</html>',
];
const MD_LINES = [
  '# Recipe Box', '', 'A small web app for family recipes. It runs on your own computer.', '', '## Start', '', '    npm start', '', 'Then open http://127.0.0.1:4100 in a browser.', '',
  '## Back up', '', 'All recipes live in one file. Copy it to keep a backup:', '', '    cp data/recipes.json ~/Documents/recipes-backup.json', '', '## Add a recipe', '',
  '1. Click **New recipe**.', '2. Type the title, the ingredients and the steps.', '3. Click **Save**.', '', '## Import', '', 'Paste the text of a recipe. The app finds the title, the ingredients and the steps.', '',
];
const DISHES = ['Tomato soup', 'Lentil stew', 'Apple cake', 'Roast chicken', 'Pea risotto', 'Onion tart', 'Plum jam', 'Bean chili', 'Rye bread', 'Leek pie'];
function seedJsonLines(n) {
  const out = ['['];
  for (let i = 1; out.length < n - 1; i++) {
    const d = DISHES[i % DISHES.length];
    out.push('  {', `    "id": "r${i}",`, `    "title": "${d} no. ${i}",`, `    "ingredients": ["${1 + (i % 6)} ${d.split(' ')[0].toLowerCase()}s", "1 onion", "salt", "${10 * (1 + (i % 9))} g butter"],`,
      '    "steps": ["Chop everything.", "Cook on low heat for 20 minutes.", "Season and serve."],', `    "tags": ["${['soup', 'main', 'cake', 'bread', 'jam'][i % 5]}"],`, `    "photoUrl": "https://example.com/photos/r${i}.jpg"`, '  },');
  }
  while (out.length < n - 1) out.push('');
  out.push(']');
  return out.slice(0, n);
}
function longLines(n) {
  const para = 'Grandma\'s tomato soup: take six ripe tomatoes, one large onion, two cloves of garlic, a spoon of butter and a pinch of sugar; chop the onion and the garlic and let them turn soft in the butter over low heat, then add the tomatoes cut in quarters, cover with water, add salt, and let it simmer for twenty minutes before you pass it through a sieve; ';
  return Array.from({ length: n }, (_, i) => `${i + 1}. ` + para.repeat(1 + (i % 4)) + 'serve with bread.');
}
function svgLines(n) {
  let d = 'M32 4';
  for (let i = 0; i < 420; i++) d += ` L${(32 + 26 * Math.cos(i / 9) * (1 + (i % 7) / 30)).toFixed(2)} ${(32 + 26 * Math.sin(i / 9) * (1 + (i % 5) / 30)).toFixed(2)}`;
  return ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Recipe Box">', `  <path fill="none" stroke="#c0392b" stroke-width="2" d="${d} Z"/>`, '</svg>'].slice(0, n);
}
function linesFor(file, n, seed) {
  const ext = file.path.slice(file.path.lastIndexOf('.') + 1);
  if (ext === 'svg') return svgLines(n);
  if (file.kind === 'long') return longLines(n);
  if (/recipes[^/]*\.json$/.test(file.path)) return seedJsonLines(n);
  const pool = ext === 'css' ? CSS_LINES : ext === 'html' ? HTML_LINES : ext === 'md' ? MD_LINES
    : ext === 'json' ? ['{', '  "name": "recipe-box",', '  "version": "0.1.0",', '  "type": "module",', '  "scripts": {', '    "start": "node server/index.js",', '    "test": "node --test test/"', '  }', '}']
      : ext === 'gitignore' ? ['node_modules/', 'data/*.tmp', '.DS_Store'] : ext === 'txt' ? longLines(n) : JS_LINES;
  const off = seed % pool.length;
  return Array.from({ length: n }, (_, i) => pool[(off + i) % pool.length]);
}
function fileDiff(f) {
  const seed = hash(f.path);
  const h7 = (s) => (hash(f.path + s) >>> 0).toString(16).padStart(8, '0').slice(0, 7);
  const a = f.kind === 'rename' && f.from ? f.from : f.path;
  const head = [`diff --git a/${a} b/${f.path}`];
  if (f.kind === 'binary') return head.concat('new file mode 100644', `index 0000000..${h7('b')}`, `Binary files /dev/null and b/${f.path} differ`).join('\n') + '\n';
  if (f.kind === 'del') {
    return head.concat('deleted file mode 100644', `index ${h7('a')}..0000000`, `--- a/${f.path}`, '+++ /dev/null', `@@ -1,${f.del} +0,0 @@`, ...linesFor(f, f.del, seed).map((l) => '-' + l)).join('\n') + '\n';
  }
  if (f.kind === 'new' || f.kind === 'long') {
    return head.concat('new file mode 100644', `index 0000000..${h7('b')}`, '--- /dev/null', `+++ b/${f.path}`, `@@ -0,0 +1,${f.add} @@`, ...linesFor(f, f.add, seed).map((l) => '+' + l), ...(f.kind === 'long' ? ['\\ No newline at end of file'] : [])).join('\n') + '\n';
  }
  if (f.kind === 'rename') head.push('similarity index 86%', `rename from ${f.from}`, `rename to ${f.path}`);
  head.push(`index ${h7('a')}..${h7('b')} 100644`, `--- a/${a}`, `+++ b/${f.path}`);
  const hunks = Math.max(1, Math.min(4, Math.ceil((f.add + f.del) / 14)));
  let addLeft = f.add, delLeft = f.del, oldLine = 3 + (seed % 9), shift = 0;
  const ctx = linesFor(f, 400, seed + 5), added = linesFor(f, f.add + 1, seed + 11), removed = linesFor(f, f.del + 1, seed + 23);
  let ai = 0, di = 0;
  for (let i = 0; i < hunks; i++) {
    const add = i === hunks - 1 ? addLeft : Math.ceil(f.add / hunks), del = i === hunks - 1 ? delLeft : Math.ceil(f.del / hunks);
    addLeft -= add; delLeft -= del;
    head.push(`@@ -${oldLine},${6 + del} +${oldLine + shift},${6 + add} @@${i % 2 ? ' export function validate(recipe) {' : ''}`);
    for (let c = 0; c < 3; c++) head.push(' ' + ctx[(oldLine + c) % ctx.length]);
    for (let c = 0; c < del; c++) head.push('-' + removed[di++]);
    for (let c = 0; c < add; c++) head.push('+' + added[ai++]);
    for (let c = 0; c < 3; c++) head.push(' ' + ctx[(oldLine + 3 + del + c) % ctx.length]);
    shift += add - del; oldLine += 6 + del + 18 + (seed % 13);
  }
  return head.join('\n') + '\n';
}

// What `git diff target..integration` would list for a set of deliveries, in load order.
function aggregate(deliveries) {
  const map = new Map();
  for (const d of deliveries) {
    for (const f of fileMeta.get(d.id) || []) {
      const cur = map.get(f.path);
      if (f.kind === 'del') { if (cur && (cur.kind === 'new' || cur.kind === 'long')) map.delete(f.path); else map.set(f.path, { ...f }); continue; }
      if (f.kind === 'rename') {
        const src = map.get(f.from);
        if (src && src.kind === 'new') { map.delete(f.from); map.set(f.path, { path: f.path, add: Math.max(1, src.add + f.add - f.del), del: 0, kind: 'new', from: null }); } else map.set(f.path, { ...f });
        continue;
      }
      if (!cur) { map.set(f.path, { ...f }); continue; }
      if (cur.kind === 'new' || cur.kind === 'long') cur.add = Math.max(1, cur.add + f.add - f.del);
      else { cur.add += f.add; cur.del += f.del; }
    }
  }
  return [...map.values()];
}
const stripMeta = (files) => files.map(({ path: p, add, del }) => ({ path: p, add, del }));

// ------------------------------------------------------------------ http plumbing

const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keysOf = [];
  const rx = new RegExp('^' + pattern.replace(/:([A-Za-z]+)/g, (_, k) => { keysOf.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, rx, keys: keysOf, handler, open: !!opts.open });
}
const BASE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "frame-ancestors 'none'" };
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': type, 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 2 * 1024 * 1024) { reject(httpError(413, 'Body is larger than 2 MB.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({}); // an empty body is {} (section 14c)
      try { const v = JSON.parse(text); if (v === null || typeof v !== 'object') throw new Error('not an object'); resolve(v); } catch { reject(httpError(400, 'The body must be a JSON object.')); }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.map': 'application/json; charset=utf-8' };
function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return sendText(res, 400, 'Bad path'); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(UI_DIR, '.' + rel);
  if (file !== UI_DIR && !file.startsWith(UI_DIR + path.sep)) return sendText(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendText(res, 404, 'Not found');
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function hasSession(req) {
  const m = /(?:^|;\s*)ws=([0-9a-f]+)/.exec(String(req.headers.cookie || ''));
  return !!m && sessions.has(m[1]);
}

async function onRequest(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = url.pathname;
  const isApi = pathname.startsWith('/api/') || pathname.startsWith('/mcp/');
  try {
    const host = req.headers.host;
    if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) throw httpError(403, 'Bad Host header.');
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) throw httpError(403, 'Bad Origin header.');

    if (pathname.startsWith('/__stub/')) return sendJson(res, 200, stubControl(pathname.slice('/__stub/'.length), url.searchParams));
    if (!isApi) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'Method not allowed.');
      return serveStatic(req, res, pathname);
    }
    if (Date.now() < offlineUntil) throw httpError(503, 'The stub hub is playing dead.');

    let match = null;
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const mt = r.rx.exec(pathname);
      if (mt) { match = { r, mt }; break; }
    }
    if (AUTH && pathname.startsWith('/api/') && !(match && match.r.open) && !hasSession(req)) throw httpError(401, 'Open WorkShop from the app (the link holds your key).');

    let body = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.headers['x-workshop'] !== '1') throw httpError(403, 'Missing header X-WorkShop: 1.');
      body = await readBody(req);
    }
    if (!match) throw httpError(404, `No route for ${req.method} ${pathname}.`);
    const params = {};
    match.r.keys.forEach((k, i) => { params[k] = decodeURIComponent(match.mt[i + 1]); });
    let done = false;
    const ctx = { req, res, params, query: Object.fromEntries(url.searchParams), body,
      json: (status, obj) => { done = true; sendJson(res, status, obj); },
      text: (status, text, type) => { done = true; sendText(res, status, text, type); } };
    const out = await match.r.handler(ctx);
    flushDirty();
    if (!done && !res.headersSent) sendJson(res, 200, out === undefined ? { ok: true } : out);
    return undefined;
  } catch (e) {
    flushDirty();
    if (res.headersSent) { try { res.end(); } catch { /* gone */ } return undefined; }
    if (!e.status) console.error('[stub] handler failed:', e);
    if (isApi || pathname.startsWith('/__stub/')) return sendJson(res, e.status || 500, { error: e.message || 'Unexpected error.' });
    return sendText(res, e.status || 500, e.message || 'error');
  }
}

function stubControl(cmd, q) {
  const [head, ...rest] = cmd.split('/');
  const a = rest.join('/');
  if (head === 'goto') return gotoScenario(a || 'loop');
  if (head === 'pause') { sim.paused = true; return info(); }
  if (head === 'resume') { sim.paused = false; return info(); }
  if (head === 'step') { const n = Math.max(1, Math.min(2000, Number(a) || 1)); for (let i = 0; i < n; i++) step(); return info(); }
  if (head === 'speed') { SPEED = Math.max(0.1, Math.min(50, Number(a) || 1)); return info(); }
  if (head === 'notice') { notice(q.get('level') || 'info', q.get('text') || 'Stub notice.', sim.jobId, q.has('panel') ? q.get('panel') || null : undefined); return info(); }
  if (head === 'fx') { emit('fx', { name: a || 'confetti', payload: {} }); return info(); }
  if (head === 'drop') { dropClients(); return info(); }
  if (head === 'offline') { offlineUntil = Date.now() + Math.max(0, Number(a) || 5000); dropClients(); return info(); }
  if (head === 'lab' && rest[1] === 'terminal') { // the owner finished the sign-in in Terminal. Only POST .../check finds it.
    const p = needLab(rest[0]);
    if (!p.installed) throw httpError(409, `${p.label} is not installed.`);
    p.loginStarted = true;
    return info();
  }
  if (head === 'lab') { setLabState(needLab(rest[0]), rest[1]); return info(); }
  if (head === 'lag') { truckLagMs = Math.max(0, Math.min(10000, Number(a) || 0)); return info(); }
  if (head === 'behind') { sim.behind = Math.max(0, Math.min(99, Number(a) || 0)); const job = curJob(); if (job) touch('jobs', job); flushDirty(); return info(); }
  if (head === 'default') { const job = curJob(); if (job && sim.st && sim.st.questionId && !sim.st.answered && !sim.st.defaulted) { takeDefault(job); flushDirty(); } return info(); }
  if (head === 'hubpause') {
    const job = curJob();
    const WHY = { budget: 'The bill reached the budget of $20.00.', caps: 'Three hand-ins in a row failed the check: npm test exits with 1.', qa: 'QA used 3 rounds. R5 is still failed.',
      baseline: 'The check fails on the project before any work:\nnot ok 3 - placeholder page loads', stalled: 'Nothing moves: no turn runs and no task is ready.', tampered: 'The branch ws/J1/int was changed outside the hub.', error: 'No boss handed in a plan draft: the CLI answered "model not on this plan".' };
    if (!Object.hasOwn(WHY, a)) throw httpError(404, `Reason must be one of: ${Object.keys(WHY).join(', ')}.`);
    if (!job || !LIVE.includes(job.status)) throw httpError(409, 'There is no live job to pause.');
    job.prevStatus = job.status; job.status = 'paused'; job.pauseReason = a; job.error = WHY[a];
    if (a === 'budget') { job.budgetUsd = 20; job.cost.billedUsd = 20.04; }
    touch('jobs', job); flushDirty();
    notice('owner', `The hub paused ${job.id}: ${WHY[a].split('\n')[0]} Resume or cancel it in the Blueprint.`, job.id, 'blueprint');
    return info();
  }
  if (head === 'hold') {
    const job = curJob();
    if (!job) throw httpError(409, 'There is no job.');
    job.hold = a === 'off' ? null : { reason: `${a || 'gemini'} reached its plan limit and no other lab is usable.`, lab: a || 'gemini', until: Date.now() + 38 * 60000 };
    touch('jobs', job); flushDirty();
    if (job.hold) notice('owner', `No lab is usable. ${job.id} waits until about ${hhmm(job.hold.until)}.`, job.id, 'keys');
    return info();
  }
  if (head === 'review') { // the next hand-in in review waits for the owner's verdict
    const job = curJob();
    if (!job || !sim.st) throw httpError(409, 'There is no job.');
    const d = all('deliveries', (x) => x.jobId === job.id && x.status === 'review' && !ownerReviews.has(x.id)).sort(byId)[0];
    if (!d) throw httpError(409, 'No hand-in is in review now. Let the job run a little (/__stub/step/5) and try again.');
    needOwnerVerdict(job, d);
    flushDirty();
    return info();
  }
  if (head === 'reqfail') { // QA fails a requirement that no open task serves
    const job = curJob();
    if (!job || !ACTIVE.includes(job.status)) throw httpError(409, 'There is no active job.');
    if (!loseRequirement(job)) throw httpError(409, 'Every requirement still has an open task. Let the job run a little and try again.');
    flushDirty();
    return info();
  }
  if (head === 'reqopen') { // the lead boss made no task for an owner change: the requirement stays open and nobody works on it
    const job = curJob();
    if (!job || !ACTIVE.includes(job.status)) throw httpError(409, 'There is no active job.');
    const text = 'The recipe list shows the cooking time of each recipe';
    const req = { id: 'R' + (job.requirements.length + 1), text, source: 'owner', status: 'open', evidence: null, waivedReason: null };
    job.requirements = [...job.requirements, req];
    lostReqs.add(`${job.id}/${req.id}`);
    touch('jobs', job); flushDirty();
    hubEvt(job.id, '#plan', `The lead boss made no task for ${req.id}. It stays open. The owner decides: add a task, waive it, or stop the job.`);
    notice('owner', `The lead boss made no task for ${req.id} ("${text}"). It stays open. Add it again, waive it, or stop the job.`, job.id, 'inbox');
    return info();
  }
  if (head === 'agentfiles') { // the repo of the job holds agent-config files that the owner has not accepted yet
    const job = curJob();
    const project = job ? S.projects[job.projectId] : null;
    if (!project) throw httpError(409, 'There is no job.');
    project.agentFiles = ['AGENTS.md', '.agents/rules/style.md']; project.agentFilesAck = false;
    filesAnswered.delete(project.id);
    touch('projects', project); flushDirty();
    notice('owner', `${project.name} holds agent-config files. Accept or refuse them in the Inbox.`, job.id, 'inbox');
    return info();
  }
  if (head === 'report') {
    const job = curJob();
    if (!job) throw httpError(409, 'There is no job.');
    if (a !== 'hostile') throw httpError(404, 'Use /__stub/report/hostile.');
    job.report = [
      '# Report <img src=x onerror=alert(1)>', '',
      '# ' + ' '.repeat(3000) + 'x' + ' '.repeat(3000) + 'y', '',
      '# a' + ' #'.repeat(900) + ' '.repeat(150) + 'b', '',
      '[a]('.repeat(20000), '',
      '['.repeat(60000), '',
      '**bold** and `code` and [a link](javascript:alert(1)) and ![an image](https://example.com/x.png "title")', '',
      '<script>document.title = "pwned"</script>', '',
      '- a\n'.repeat(5000),
      'The end.',
    ].join('\n');
    touch('jobs', job); flushDirty();
    return info();
  }
  if (head === 'info') return info();
  throw httpError(404, 'Unknown stub command. See the header of tests/ui-stub/server.mjs.');
}

// ------------------------------------------------------------------ routes (contract section 6)

const stateOut = () => (ARRAYS ? { ...S, ...Object.fromEntries(KINDS.map((k) => [k, Object.values(S[k])])) } : S);
const needJob = (id) => { const job = Object.hasOwn(S.jobs, id) ? S.jobs[id] : null; if (!job) throw httpError(404, `Unknown job ${id}.`); return job; };
const needTask = (id) => { const t = Object.hasOwn(S.tasks, id) ? S.tasks[id] : null; if (!t) throw httpError(404, `Unknown task ${id}.`); return t; };
const LIVE = ['planning', 'plan_review', 'running', 'qa', 'delivering'];

route('POST', '/api/session', ({ body, res }) => {
  if (AUTH && body.k !== OWNER_KEY) throw httpError(401, 'That key does not open this hub.');
  const sid = randomBytes(16).toString('hex');
  sessions.add(sid);
  res.setHeader('Set-Cookie', `ws=${sid}; HttpOnly; SameSite=Strict; Path=/`);
  return { ok: true };
}, { open: true });

route('GET', '/api/state', () => ({ seq: S.seq, state: stateOut(), providers: providersOut(), settings, board: board.slice(-200), models: modelsPayload(), inbox: inboxOf(null), harnesses: harnessReg.harnesses, roster: rosterEntries, requisitions }));

route('GET', '/api/events', ({ req, res, query }) => {
  res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 2000\n: hello\n\n');
  const last = query.since !== undefined ? query.since : req.headers['last-event-id'];
  if (last !== undefined && last !== '' && Number.isFinite(Number(last))) for (const e of ring) if (e.seq > Number(last)) sseWrite(res, e.seq, e.type, e.json);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

route('POST', '/api/jobs', ({ body }) => {
  const title = String(body.title || '').trim(), brief = String(body.brief || '').trim();
  if (!title) throw httpError(400, 'The work order needs a title.');
  if (!brief) throw httpError(400, 'The work order needs a brief.');
  if (!['build', 'fix', 'research'].includes(body.kind)) throw httpError(400, 'Kind must be build, fix or research.');
  const project = body.project || {};
  if (!['new', 'existing'].includes(project.mode)) throw httpError(400, 'Project mode must be new or existing.');
  if (project.mode === 'existing' && !project.path) throw httpError(400, 'Pick the folder of the existing project.');
  if (project.mode === 'new' && project.name && !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(project.name)) throw httpError(400, 'Project name: letters, digits, space, dot, dash and underscore only.');
  if (body.budgetUsd != null && body.budgetUsd !== '' && !(Number(body.budgetUsd) >= 0)) throw httpError(400, 'budgetUsd must be a number of dollars.');
  if (typeof body.crew === 'string' && !settings.crewPresets[body.crew]) throw httpError(400, `Unknown crew preset "${body.crew}".`);
  const billed = providersOut().some((p) => p.usable && p.mode === 'apikey');
  if (billed && (body.budgetUsd == null || body.budgetUsd === '') && !(body.options && body.options.mock === true)) throw httpError(400, 'A lab bills per token (API key mode). Set a budget for this work order.');
  sim.paused = false; sim.loop = true;
  // One job is active at a time. Every other new job is queued (section 4) and starts when the floor is free.
  return createJob({ title, brief, kind: body.kind, project, crew: body.crew, options: body.options || {}, budgetUsd: body.budgetUsd });
});

// Routes that only the real hub had: the watchdog of the page asks /api/health when the stream is quiet.
route('GET', '/api/health', () => ({ ok: true, version: 'stub', pid: process.pid, uptimeMs: Math.round(process.uptime() * 1000), seq: S.seq, jobs: all('jobs').length,
  activeJob: (all('jobs', (j) => !j.deleted && ACTIVE.includes(j.status))[0] || {}).id ?? null, turns: 0, queued: 0, sse: clients.size, decider: null }));
route('GET', '/api/jobs', () => all('jobs').sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)));

route('POST', '/api/demo', () => {
  sim.paused = false; sim.loop = true;
  return createJob({ ...DEFAULT_ORDER, title: 'Demo: Recipe Box web app', options: { approvePlan: false, mock: true } });
});

route('POST', '/api/jobs/:id/pause', ({ params, body }) => {
  const job = needJob(params.id);
  if (!LIVE.includes(job.status) && job.status !== 'paused') throw httpError(409, `${job.id} is ${job.status}: only a live job can be paused.`);
  // Like the hub: a job that is paused already is accepted as it is (prevStatus kept); hard:true still stops running turns.
  if (job.status !== 'paused') { job.prevStatus = job.status; job.status = 'paused'; job.pauseReason = 'owner'; touch('jobs', job); }
  if (body.hard === true) { // also stop the turns that run now; their sessions resume later
    for (const a of jobAgents(job)) {
      if (!['working', 'thinking', 'reviewing'].includes(a.status)) continue;
      hardStopped.set(a.id, a.status); a.status = 'idle';
      touch('agents', a);
      log(a.id, { k: 'sys', s: 'turn interrupted: the owner paused the job (hard pause). The session resumes later.' });
    }
    hubEvt(job.id, '#ops', `${job.id} is paused. The running turns were stopped.`);
  }
  return job;
});
route('POST', '/api/jobs/:id/resume', ({ params, body }) => {
  const job = needJob(params.id);
  if (job.status !== 'paused') throw httpError(409, `${job.id} is not paused.`);
  const other = all('jobs', (j) => j.id !== job.id && !j.deleted && ACTIVE.includes(j.status))[0];
  if (other) throw httpError(409, `${other.id} is active. Pause it or let it finish first.`);
  if (job.pauseReason === 'budget' && !(Number(body.budgetUsd) > job.cost.billedUsd)) throw httpError(400, `Set a budget above $${job.cost.billedUsd.toFixed(2)} to go on.`);
  if (body.budgetUsd != null && Number.isFinite(Number(body.budgetUsd))) job.budgetUsd = Number(body.budgetUsd);
  job.status = job.prevStatus || 'running'; job.prevStatus = null; job.pauseReason = null; job.error = null;
  touch('jobs', job);
  for (const a of jobAgents(job)) if (hardStopped.has(a.id)) { a.status = hardStopped.get(a.id); hardStopped.delete(a.id); touch('agents', a); } // turns that a hard pause stopped go on
  sim.paused = false;
  return job;
});
route('POST', '/api/jobs/:id/cancel', ({ params }) => {
  const job = needJob(params.id);
  if (['done', 'cancelled'].includes(job.status)) throw httpError(409, `${job.id} is already ${job.status}.`);
  const wasQueued = job.status === 'queued';
  retireJob(job, 'cancelled');
  flushDirty();
  const n = loadedOf(job).length;
  if (n) notice('owner', `${job.id} is cancelled. ${plural(n, 'reviewed crate')} ${n === 1 ? 'is' : 'are'} still on the truck: ship or discard in the Truck panel.`, job.id, 'truck');
  else notice('info', `${job.id} cancelled.`, job.id);
  if (!wasQueued && promoteQueued()) sim.paused = false; // the floor is free: the next work order starts
  return job;
});
route('DELETE', '/api/jobs/:id', ({ params }) => {
  const job = needJob(params.id);
  if (!['done', 'cancelled'].includes(job.status)) throw httpError(409, `${job.id} is ${job.status}. Only a done or cancelled job can be deleted.`);
  removeJobRows(job); // the work folders, the refs and the task, agent and delivery rows go; title, brief, ledger and report stay
  Object.assign(job, { deleted: true, planDrafts: null, integrationDir: null, changes: [], mergeLog: [] }); // like the hub: the row stays, marked
  touch('jobs', job);
  return { ok: true };
});
route('POST', '/api/jobs/:id/plan/approve', ({ params }) => {
  const job = needJob(params.id);
  if (job.status !== 'plan_review') throw httpError(409, 'The plan is not waiting for approval.');
  approvePlan(job);
  return job;
});
route('POST', '/api/jobs/:id/reqs', ({ params, body }) => {
  const job = needJob(params.id);
  const text = String(body.text || '').trim();
  if (!text) throw httpError(400, 'Write the requirement.');
  // Like the hub: the ledger is open from the plan review on, and only when the plan made one.
  if (!['plan_review', 'running', 'qa', 'delivering', 'paused'].includes(job.status) || !job.requirements.length) throw httpError(409, 'Requirements can be added from the plan review on.');
  const req = { id: 'R' + (job.requirements.length + 1), text, source: 'owner', status: 'open', evidence: null, waivedReason: null };
  job.requirements = [...job.requirements, req];
  if (['qa', 'delivering'].includes(job.status)) { job.status = 'running'; job.report = null; } // a full owner change: QA runs again
  touch('jobs', job);
  hubEvt(job.id, '#plan', `The owner added ${req.id}: ${clip(text.replace(/\s+/g, ' '), 200)}`);
  return req;
});
route('POST', '/api/jobs/:id/reqs/:rid/waive', ({ params, body }) => {
  const job = needJob(params.id);
  const req = job.requirements.find((r) => r.id === params.rid);
  if (!req) throw httpError(404, `Unknown requirement ${params.rid}.`);
  const reason = String(body.reason || '').trim();
  if (!reason) throw httpError(400, 'Say why you waive it.');
  req.status = 'waived'; req.waivedReason = reason;
  lostReqs.delete(`${job.id}/${req.id}`);
  touch('jobs', job);
  return req;
});
route('POST', '/api/jobs/:id/ship', ({ params, body }) => {
  const job = needJob(params.id);
  const sha = String(body.sha || '').trim();
  if (!sha) throw httpError(400, 'Send { sha }: the commit the Truck panel showed.');
  if (!/^[0-9a-f]{4,64}$/i.test(sha)) throw httpError(400, 'sha must be a commit id (hex).');
  // Like the hub: every refusal is a 200 { ok:false, reason }; only a bad sha is a 400.
  if (!['running', 'qa', 'delivering', 'paused', 'cancelled'].includes(job.status) || !loadedOf(job).length) return { ok: false, reason: 'Nothing is loaded on the truck.' };
  const out = ship(job, body.sha);
  if (job.status === 'done' && promoteQueued()) sim.paused = false; // the floor is free: the next work order starts
  return out;
});
route('POST', '/api/jobs/:id/truck/discard', ({ params }) => {
  const job = needJob(params.id);
  if (job.status !== 'cancelled') throw httpError(409, 'Only a cancelled job can discard its truck.');
  // Like the hub: the delivery rows stay (rejected, discarded) and the integration branch goes.
  for (const d of loadedOf(job)) { d.status = 'rejected'; d.discarded = true; touch('deliveries', d); }
  job.truckKept = false; job.intDropped = true; job.integrationDir = null;
  touch('jobs', job);
  flushDirty();
  return { ok: true };
});
route('POST', '/api/jobs/:id/changes', ({ params, body }) => {
  const job = needJob(params.id);
  const text = String(body.text || '').trim();
  if (!text) throw httpError(400, 'Say what should change.');
  const lead = S.agents[job.leadBossId];
  const d = body.deliveryId ? S.deliveries[body.deliveryId] : null;
  if (body.deliveryId && !d) throw httpError(404, `Unknown delivery ${body.deliveryId}.`);
  if (!LIVE.includes(job.status) && job.status !== 'paused') throw httpError(409, `${job.id} is ${job.status}. Start a new work order for this change.`);
  // "Add task" for a requirement that failed and that no task serves (final wiring spec S7): { reqId } names it. The owner's
  // words still make a NEW requirement, which records servesReq; the named one stops asking the owner (its inbox item goes)
  // until QA checks it again. Unknown reqId: 404.
  let serves = null;
  if (body.reqId != null) {
    serves = (job.requirements || []).find((r) => r.id === String(body.reqId)) || null;
    if (!serves) throw httpError(404, `Unknown requirement ${body.reqId} in ${job.id}.`);
  }
  // The owner's words become a requirement first; then the lead boss is woken (section 12).
  const req = { id: 'R' + (job.requirements.length + 1), text: clip(text.replace(/\s+/g, ' '), 300), source: 'owner', status: 'open', evidence: null, waivedReason: null };
  if (serves) { req.servesReq = serves.id; lostReqs.delete(`${job.id}/${serves.id}`); }
  job.requirements = [...job.requirements, req];
  touch('jobs', job);
  hubEvt(job.id, d ? d.taskId : '#plan', `The owner asks for a change${d ? ` to ${d.taskId}` : ''}: ${req.text} It is requirement ${req.id}.`, { to: lead });
  if (lead && sim.st && sim.jobId === job.id) {
    const t = addTask(job, { k: 200 + S.counters.T, title: clip('Owner change: ' + text.replace(/\s+/g, ' '), 70), domain: 'fix', size: 'S', stream: 'data', deps: [], reqs: [req.id],
      zones: d ? d.files.slice(0, 3).map((f) => f.path) : ['**'], spec: text, acceptance: ['The owner change is in place', 'The check passes'] });
    log(lead.id, { k: 'sys', s: 'turn started: owner change' }, { k: 'tool', s: `shop.task_add {title:"${clip(t.title, 50)}", reqs:["${req.id}"]}` }, { k: 'sys', s: 'turn ended' });
    hubEvt(job.id, '#plan', `${lead.handle} added ${t.id} for ${req.id}.`);
    if (['qa', 'delivering'].includes(job.status)) { job.status = 'running'; touch('jobs', job); }
  }
  return { ok: true, req };
});

route('GET', '/api/jobs/:id/truck', async ({ params }) => {
  if (truckLagMs) await new Promise((r) => setTimeout(r, truckLagMs));
  const job = needJob(params.id);
  const merged = loadedOf(job);
  // Like the hub on disk: the list is sorted by delivery id (the order of the hand-ins). That is not the order of the merges.
  // The UI must sort the crates by loadedAt itself, or "Ship up to here" names the wrong crates.
  const deliveries = merged.slice().sort(byId);
  const files = aggregate(merged);
  const project = S.projects[job.projectId];
  const count = (s) => job.requirements.filter((r) => r.status === s).length;
  const hc = project && project.headCheck && project.headCheck.sha === job.intSha ? project.headCheck : null;
  return {
    headSha: job.intSha, behind: sim.jobId === job.id ? sim.behind : 0, deliveries,
    stat: { files: files.length, add: files.reduce((s, f) => s + f.add, 0), del: files.reduce((s, f) => s + f.del, 0) }, files: stripMeta(files),
    reqs: { open: count('open'), failed: count('failed'), verified: count('verified'), waived: count('waived') },
    check: project && project.checkCmd && hc ? { ok: hc.ok, tail: hc.tail } : null, report: job.report,
  };
});
route('GET', '/api/jobs/:id/diff', ({ params, query, text }) => {
  const job = needJob(params.id);
  let files;
  if (query.delivery) {
    const d = S.deliveries[query.delivery];
    if (!d || d.jobId !== job.id) throw httpError(404, `Unknown delivery ${query.delivery}.`);
    files = fileMeta.get(d.id) || [];
  } else files = aggregate(loadedOf(job));
  if (query.path) files = files.filter((f) => f.path === query.path);
  // like the hub: a path with no change gives an empty text
  text(200, files.map(fileDiff).join(''));
});

route('POST', '/api/tasks/:id/stop', ({ params, body }) => {
  const t = needTask(params.id);
  if (['checking', 'buddy', 'review', 'integrating'].includes(t.status)) throw httpError(409, `${t.id} is in review. Give a verdict, or cancel the task.`);
  if (!['planned', 'ready', 'working', 'rework', 'blocked', 'failed'].includes(t.status)) throw httpError(409, `${t.id} is ${t.status}.`);
  const note = String(body.note || '').trim() || null;
  const maker = S.agents[t.assigneeId];
  t.status = 'blocked'; t.why = 'owner'; t.note = note; t.needsAction = { kind: 'blocked', since: now() };
  touch('tasks', t);
  if (sim.st && S.jobs[t.jobId] && sim.jobId === t.jobId) { const m = meta(t.id); m.blocked = true; m.ownerStop = true; }
  if (maker) { maker.status = 'blocked'; touch('agents', maker); log(maker.id, { k: 'sys', s: `turn stopped by the owner${note ? `: ${note}` : ''}` }); }
  t.needsAction = null; // like the hub: no needsAction and no EVT for an owner stop
  return t;
});
route('POST', '/api/tasks/:id/retry', ({ params, body }) => {
  const t = needTask(params.id);
  if (!['blocked', 'failed'].includes(t.status)) throw httpError(409, `${t.id} is ${t.status}. Only a blocked or failed task can be retried.`);
  // like the hub: the owner has no retry limit
  const model = body.model == null ? 'same' : String(body.model);
  if (!['same', 'up', 'other_lab'].includes(model)) throw httpError(400, 'model must be same, up or other_lab.');
  const note = String(body.note || '').trim() || null;
  const maker = S.agents[t.assigneeId];
  t.status = 'working'; t.why = null; t.needsAction = null; t.attempts = 0; t.retries += 1; t.lastError = null; t.note = note;
  touch('tasks', t);
  if (sim.st && sim.jobId === t.jobId) { const m = meta(t.id); m.blocked = false; m.ownerStop = false; m.wait = 1; }
  if (maker) {
    maker.status = 'thinking'; t.sessionId = newSession(maker); touch('agents', maker);
    log(maker.id, { k: 'sys', s: `turn started: retry ${t.id} with a fresh session${model !== 'same' ? ` (model: ${model})` : ''}${note ? `. Note: ${note}` : ''}` });
  }
  hubEvt(t.jobId, t.id, `The owner restarted ${t.id}.${note ? ` Note: ${note}` : ''}`, { to: maker });
  return t;
});
route('POST', '/api/tasks/:id/cancel', ({ params, body }) => {
  const t = needTask(params.id);
  const reason = String(body.reason || '').trim();
  if (!reason) throw httpError(400, 'Say why you cancel the task.');
  if (['merged', 'cancelled'].includes(t.status)) throw httpError(409, `${t.id} is already ${t.status}.`);
  const replacedBy = Array.isArray(body.replacedBy) ? body.replacedBy : [];
  const dependents = all('tasks', (x) => x.jobId === t.jobId && x.deps.includes(t.id) && !['merged', 'cancelled'].includes(x.status));
  if (dependents.length && !replacedBy.length) throw httpError(409, `${dependents.map((x) => x.id).join(', ')} depend on ${t.id}. Name the tasks that replace it.`);
  for (const x of dependents) { x.deps = [...x.deps.filter((d) => d !== t.id), ...replacedBy]; touch('tasks', x); }
  const maker = S.agents[t.assigneeId];
  t.status = 'cancelled'; t.why = null; t.needsAction = null; t.note = reason;
  touch('tasks', t);
  if (maker && maker.taskId === t.id) { maker.status = 'idle'; maker.taskId = null; touch('agents', maker); }
  hubEvt(t.jobId, '#plan', `The owner cancelled ${t.id}: ${clip(reason, 120)}`);
  return t;
});

route('GET', '/api/board', ({ query }) => {
  const since = Number(query.since) || 0, limit = Math.max(1, Math.min(5000, Number(query.limit) || 200));
  return board.filter((m) => m.id > since && (!query.job || m.jobId === query.job)).slice(-limit);
});
route('POST', '/api/board', ({ body }) => {
  const kind = String(body.kind || '').toUpperCase();
  const text = String(body.body || '').trim();
  const fail = (code, hint) => { throw httpError(400, `${code}: ${hint}`); };
  if (!POST_KINDS.includes(kind)) fail('E_HEAD', `Unknown kind. Use one of: ${POST_KINDS.join(', ')}.`);
  if (!text && !['OK', 'PASS', 'CANCEL'].includes(kind)) fail('E_BODY', 'The message is empty.');
  const jobId = body.jobId || null; // like the hub: no fallback to the running job
  const job = jobId && S.jobs[jobId];
  if (!job || job.deleted) throw httpError(404, `Unknown job ${jobId}.`);
  // Like the hub (final wiring spec S6): the body of an owner post holds at most 1900 characters, so the whole post line
  // stays under the 2000 of ShopTalk (humanPostChars).
  if (text.length > 1900) throw httpError(400, `The message is too long (${text.length} chars). Max 1900.`);
  if (body.slots != null) {
    if (typeof body.slots !== 'object' || Array.isArray(body.slots)) throw httpError(400, 'slots must be an object.');
    for (const k of Object.keys(body.slots)) if (!['ttl', 'why', 'tests', 'acc', 'default', 'conf'].includes(k)) throw httpError(400, `Unknown slot ${k}.`);
  }
  const re = body.re == null || body.re === '' ? null : Number(body.re);
  const target = re != null ? byMsgId.get(re) : null;
  if (CLOSES[kind]) {
    if (!target) fail('E_RE', `${kind} needs re: the id of the post it answers.`);
    if (!CLOSE_TARGETS[kind].includes(target.kind)) fail('E_RE', `${kind} cannot answer a ${target.kind}.`);
    if (target.state !== 'open' && !(kind === 'ANS' && target.defaulted)) fail('E_CLOSED', `#${target.id} is already closed (${target.state}).`);
  }
  const to = body.to ? String(body.to).trim() : null;
  if (to && !/^@[A-Za-z0-9_-]+$/.test(to)) fail('E_TO', 'Address one agent by handle, for example @b1 or @boss.');
  if ((kind === 'ASK' || kind === 'REQ') && !to) fail('E_TO', `${kind} needs one addressee.`);
  if (kind === 'ASK' && (text.match(/\?/g) || []).length !== 1) fail('E_Q', 'ASK holds exactly one question mark.');
  let scope = body.scope ? String(body.scope).trim() : null;
  if (scope && !CHANNELS.includes(scope) && !(/^T\d+$/.test(scope) && S.tasks[scope])) fail('E_SCOPE', 'Scope is a task id (T12) or one of #plan, #build, #merge, #ops.');
  if (!scope && !target && ['INFO', 'DECIDE', 'ASK', 'REQ'].includes(kind)) scope = '#build';
  const wasDefault = !!(target && target.defaulted);
  // PASS or FIX from the owner on an open DONE is the review verdict (section 7).
  const handIn = (kind === 'PASS' || kind === 'FIX') && target ? all('deliveries', (d) => d.doneMsgId === target.id && d.jobId === job.id)[0] || null : null;
  if (handIn && kind === 'PASS' && handIn.acc && handIn.acc.met < handIn.acc.total) fail('E_ACC', `acc is ${handIn.acc.met}/${handIn.acc.total}. Post FIX, or let a boss change the task card first.`);
  const msg = post({ jobId, human: true, kind, to, scope, re, body: text, close: !wasDefault });
  if (handIn && ['checking', 'buddy', 'review'].includes(handIn.status)) ownerVerdict(job, handIn, kind, text);
  if (kind === 'ANS' && target && target.kind === 'ASK' && target.to === '@human') ownerAnswers(job, target, text);
  // The addressee owes an answer. In the stub it comes a few ticks later.
  const addressee = msg.toId ? S.agents[msg.toId] : null;
  if (addressee && (kind === 'ASK' || kind === 'REQ') && sim.st && sim.jobId === job.id) {
    sim.st.pending.push({ at: sim.tick + 3, run: () => {
      if (msg.state !== 'open') return;
      if (kind === 'REQ') say(addressee, 'OK', { re: msg.id, body: 'I start it now.' });
      else say(addressee, 'ANS', { re: msg.id, body: 'Yes. I work on it and post the result in this thread.' });
    } });
  }
  return { ok: true, msg: snap(msg) };
});
route('GET', '/api/inbox', ({ query }) => inboxOf(query.job || null));
route('PUT', '/api/presence', ({ body }) => {
  if (!['here', 'away'].includes(body.state)) throw httpError(400, 'state must be here or away.');
  settings = { ...settings, presence: body.state };
  presenceAt = Date.now();
  emit('settings', { settings });
  return { ok: true, presence: settings.presence };
});

route('GET', '/api/agents/:id/log', ({ params, query }) => {
  if (!Object.hasOwn(S.agents, params.id)) throw httpError(404, `Unknown agent ${params.id}.`);
  const tail = Math.max(1, Math.min(2000, Number(query.tail) || 200));
  return (agentLogs.get(params.id) || []).slice(-tail);
});

route('GET', '/api/providers', () => providersOut());
route('POST', '/api/providers/detect', () => {
  for (const p of Object.values(labs)) if (!p.installed && p.id !== 'oss') { p.installed = true; p.version = '1.5.1'; p.path = '/Users/owner/.local/bin/agy'; p.auth = 'unknown'; }
  emitProviders();
  return providersOut();
});
route('PUT', '/api/providers/oss', ({ body }) => {
  settings = deepMerge(settings, { oss: { ...(body.engine ? { engine: body.engine } : {}), ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}), ...(typeof body.standIn === 'boolean' ? { standIn: body.standIn } : {}) } });
  labs.oss.localReady = true;
  emit('settings', { settings });
  emitProviders();
  return providerStatus(labs.oss);
});
route('PUT', '/api/providers/:id/mode', ({ params, body }) => {
  const p = needLab(params.id);
  if (p.id === 'oss') return providerStatus(p);
  const allowed = p.id === 'openai' ? ['apikey', 'subscription'] : ['apikey'];
  if (!allowed.includes(body.mode)) throw httpError(400, `${p.label} supports ${allowed.join(' or ')} mode only.`);
  settings = deepMerge(settings, { auth: { [p.id]: body.mode }, authAck: { [p.id]: { mode: body.mode, ts: Date.now() } } });
  emit('settings', { settings });
  emitProviders();
  return providerStatus(p);
});
route('POST', '/api/providers/:id/login', ({ params }) => {
  const p = needLab(params.id);
  if (p.id !== 'openai') throw httpError(400, 'Interactive consumer subscription logins are disabled for Anthropic and Google. Configure an API key instead.');
  p.auth = 'ok';
  settings = deepMerge(settings, { auth: { openai: 'subscription' }, authAck: { openai: { mode: 'subscription', ts: Date.now() } } });
  emit('settings', { settings });
  emitProviders();
  return { ok: true, launched: true, method: 'browser', message: 'Signed in with ChatGPT (stub).' };
});
route('POST', '/api/providers/:id/check', ({ params }) => {
  const p = needLab(params.id);
  if (p.id === 'oss') { labs.oss.localReady = true; emitProviders(); return providerStatus(p); }
  if (!p.installed) throw httpError(409, `${p.label} is not installed.`);
  p.auth = (keys.get(KEY_OF_LAB[p.id]) || {}).value ? 'ok' : 'none';
  if (p.id === 'gemini' && p.auth === 'ok') p.models = ['gemini-4-carbon-high', 'gemini-4-argon-medium', 'gemini-4-hydrogen-low', 'gemini-4-hydrogen-medium', 'gemini-3.8-flash'];
  emitProviders();
  return providerStatus(p);
});
route('POST', '/api/providers/:id/selftest', async ({ params }) => {
  const p = needLab(params.id);
  const s = providerStatus(p);
  if (p.id !== 'oss' && (!p.installed || s.mode !== 'apikey' || !s.ack || !s.keySet)) throw httpError(409, s.reason || 'Finish the other setup steps first.');
  await new Promise((r) => setTimeout(r, 400));
  const gem = p.id === 'gemini';
  const advisory = [
    { name: 'Reach a host that is not a registry or localhost', ok: true, detail: 'Blocked: the request did not leave this Mac.' },
    ...(gem ? [{ name: 'A planted .agents/hooks.json', ok: true, detail: 'It did not run.' }, { name: 'git push', ok: false, detail: 'Not listed in denied_actions.' }] : []),
  ];
  const steps = [
    { name: 'Start one tiny turn', ok: true, detail: `${p.label} answered.` },
    { name: 'Call the hub tool "post"', ok: true, detail: 'The post arrived at the hub.' },
    { name: 'Run the containment checks in the shell', ok: true, detail: `${SELFTEST_CORE.length} core, ${advisory.length} advisory.` },
  ];
  const out = { ok: SELFTEST_CORE.every((c) => c.ok), core: SELFTEST_CORE, advisory, steps, loaded: ['shop'],
    logTail: `init: mcp shop connected\ntool: Bash touch ../outside.txt -> Operation not permitted\nresult: ok` };
  settings = deepMerge(settings, { selfTest: { [p.id]: { version: p.version, ok: out.ok, core: out.core, advisory: out.advisory, ts: Date.now() } } });
  emit('settings', { settings });
  emitProviders();
  return out;
});
route('GET', '/api/harnesses', () => harnessReg);
route('POST', '/api/harnesses', ({ body }) => {
  const item = isObj(body?.harness) ? body.harness : body;
  const idx = harnessReg.harnesses.findIndex((h) => h.id === item.id);
  if (idx >= 0) harnessReg.harnesses[idx] = item; else harnessReg.harnesses.push(item);
  emit('harnesses', { harnesses: harnessReg.harnesses });
  return item;
});
route('DELETE', '/api/harnesses/:id', ({ params }) => {
  harnessReg.harnesses = harnessReg.harnesses.filter((h) => h.id !== params.id);
  emit('harnesses', { harnesses: harnessReg.harnesses });
  return { ok: true, id: params.id };
});
route('GET', '/api/roster', () => rosterEntries);
route('POST', '/api/roster', ({ body }) => {
  const item = isObj(body?.entry) ? body.entry : body;
  const idx = rosterEntries.findIndex((e) => e.id === item.id);
  if (idx >= 0) rosterEntries[idx] = item; else rosterEntries.push(item);
  emit('roster', { roster: rosterEntries });
  return item;
});
route('DELETE', '/api/roster/:id', ({ params }) => {
  rosterEntries = rosterEntries.filter((e) => e.id !== params.id);
  emit('roster', { roster: rosterEntries });
  return { ok: true, id: params.id };
});
route('GET', '/api/requisitions', () => requisitions);
route('POST', '/api/requisitions', ({ body }) => {
  const item = { id: `TR${reqSeq++}`, status: 'queued_phase1', createdAt: Date.now(), updatedAt: Date.now(), ...body };
  requisitions.unshift(item);
  emit('requisitions', { requisitions });
  return item;
});
route('POST', '/api/requisitions/:id/enroll', ({ params, body }) => {
  const r = requisitions.find((x) => x.id === params.id);
  if (!r) throw httpError(404, 'Unknown requisition.');
  const entry = { id: `spec-${r.domain}`, name: body.name || r.suggestedName, role: 'maker', title: body.title || `${r.domain} Specialist`, baseModel: body.baseModel || r.candidateBaseModel, checkpoint: body.checkpoint || `oss://${r.candidateBaseModel}-rft`, harnessId: body.harnessId || r.harnessId, specialties: [r.domain], certification: 'curated', enabled: true, style: { seed: 2501 }, record: { tasksCompleted: 0, reworks: 0 } };
  rosterEntries.push(entry);
  r.status = 'enrolled'; r.enrolledRosterId = entry.id;
  emit('roster', { roster: rosterEntries });
  emit('requisitions', { requisitions });
  return { requisition: r, entry };
});
route('POST', '/api/requisitions/:id/dismiss', ({ params }) => {
  const r = requisitions.find((x) => x.id === params.id);
  if (!r) throw httpError(404, 'Unknown requisition.');
  r.status = 'dismissed';
  emit('requisitions', { requisitions });
  return r;
});
route('POST', '/api/training/forge', ({ body }) => {
  if (/^(claude|gemini|gpt-|o1-|o3-|o4-|openai)/i.test(String(body.baseModel || ''))) {
    throw httpError(400, 'Closed-source models cannot enter the RL training pipeline.');
  }
  const item = {
    id: `TR${reqSeq++}`,
    status: body.autoStart === false ? 'queued_phase1' : 'training',
    domain: body.domain || (body.specialties && body.specialties[0]) || 'backend',
    suggestedName: body.name || 'ForgeSpec',
    candidateBaseModel: body.baseModel || 'qwen3-coder-32b',
    harnessId: body.harnessId || 'fullstack-node',
    tools: Array.isArray(body.tools) ? body.tools : ['read_file', 'write_file', 'run_shell', 'shop_mcp'],
    portMode: (settings.rlPort && settings.rlPort.mode) || 'sim',
    rlJob: { jobId: `rl_${Date.now()}`, step: 40, totalSteps: 100, metrics: { reward: 0.84 } },
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  requisitions.unshift(item);
  emit('requisitions', { requisitions });
  return { requisition: item, rlJob: item.rlJob };
});
route('POST', '/api/requisitions/:id/start', ({ params }) => {
  const r = requisitions.find((x) => x.id === params.id);
  if (!r) throw httpError(404, 'Unknown requisition.');
  r.status = 'training';
  r.portMode = (settings.rlPort && settings.rlPort.mode) || 'sim';
  r.rlJob = { jobId: `rl_${Date.now()}`, step: 50, totalSteps: 100, metrics: { reward: 0.85 } };
  emit('requisitions', { requisitions });
  return { requisition: r };
});
route('POST', '/api/requisitions/:id/poll', ({ params }) => {
  const r = requisitions.find((x) => x.id === params.id);
  if (!r) throw httpError(404, 'Unknown requisition.');
  r.status = 'enrolled';
  r.qaReport = {
    passed: true, evalScore: 87.5, passAt1: 0.85,
    checks: [
      { id: 'open_weight_brain', ok: true, detail: r.candidateBaseModel },
      { id: 'competence_benchmark', ok: true, detail: 'evalScore=87.5, pass@1=85%' },
      { id: 'sandbox_and_hub_containment', ok: true, detail: '0 violations' },
      { id: 'harness_tool_compliance', ok: true, detail: 'adherence=94%' },
    ],
  };
  const entry = {
    id: `spec-${String(r.suggestedName || 'forge').toLowerCase()}-${r.id.toLowerCase()}`,
    name: r.suggestedName || 'ForgeSpec', role: 'maker', title: `${r.domain} Specialist`,
    baseModel: r.candidateBaseModel, checkpoint: `sim://${r.candidateBaseModel}-${r.domain}-rl`,
    harnessId: r.harnessId, tools: r.tools || [], specialties: [r.domain],
    certification: r.portMode === 'sim' ? 'sim_trained' : 'curated',
    benchmark: { evalScore: 87.5, passAt1: 0.85, portMode: r.portMode || 'sim', verifiedAt: Date.now() },
    ratings: { score: 0, shipped: 0, denied: 0, discarded: 0, history: [] },
    enabled: true, style: { seed: 2501 }, record: { tasksCompleted: 0, reworks: 0 },
  };
  rosterEntries.push(entry);
  r.enrolledRosterId = entry.id;
  emit('roster', { roster: rosterEntries });
  emit('requisitions', { requisitions });
  return { requisition: r, enrolled: entry };
});
route('POST', '/api/requisitions/:id/cancel', ({ params }) => {
  const r = requisitions.find((x) => x.id === params.id);
  if (!r) throw httpError(404, 'Unknown requisition.');
  r.status = 'queued_phase1';
  emit('requisitions', { requisitions });
  return { requisition: r };
});
route('GET', '/api/rl-port', () => ({
  ...(settings.rlPort || { mode: 'sim', localUrl: 'http://127.0.0.1:8788', remoteUrl: '', remoteProvider: 'custom' }),
  hasCustomModule: false,
  agentPrompt: 'Read ports/rl/PORT_CONTRACT.md and implement local/rl-port.mjs for my hardware.',
}));
route('PUT', '/api/rl-port', ({ body }) => {
  settings.rlPort = { ...(settings.rlPort || {}), ...body };
  emit('rlPort', settings.rlPort);
  return { ...settings.rlPort, hasCustomModule: false };
});
route('POST', '/api/rl-port/probe', () => ({
  ok: true, mode: (settings.rlPort && settings.rlPort.mode) || 'sim', engine: 'sim-rl-v1', adapter: 'stub',
}));

route('GET', '/api/keys', () => [...keys.values()].map(keyView));
route('PUT', '/api/keys/:id', ({ params, body }) => {
  const value = typeof body.value === 'string' ? body.value.trim() : '';
  if (!value) throw httpError(400, 'The key is empty.');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(params.id)) throw httpError(400, 'Key id: letters, digits, dash and underscore only.');
  const cur = keys.get(params.id) || { id: params.id, label: params.id, envVar: params.id.toUpperCase().replace(/-/g, '_') + '_API_KEY', value: null, updatedAt: null };
  if (body.label) cur.label = String(body.label).slice(0, 80);
  if (body.envVar) { if (!/^[A-Z_][A-Z0-9_]*$/.test(body.envVar)) throw httpError(400, 'Env var: capitals, digits and underscore only.'); cur.envVar = String(body.envVar); }
  cur.value = value; cur.updatedAt = Date.now();
  keys.set(cur.id, cur);
  emitProviders(); // keySet may have changed
  return keyView(cur);
});
route('DELETE', '/api/keys/:id', ({ params }) => {
  const cur = keys.get(params.id);
  if (!cur) throw httpError(404, `Unknown key ${params.id}.`);
  if (KNOWN_KEYS.includes(cur.id)) { cur.value = null; cur.updatedAt = null; } else keys.delete(cur.id);
  emitProviders();
  return { ok: true };
});

route('GET', '/api/settings', () => settings);
route('PUT', '/api/settings', ({ body }) => {
  if (!isObj(body.patch)) throw httpError(400, 'Send { patch }.');
  const next = deepMerge(settings, body.patch);
  if (!['sandboxed', 'trusting'].includes(next.safety)) throw httpError(400, 'safety must be sandboxed or trusting.');
  if (!(typeof next.thrift === 'number' && next.thrift >= 0 && next.thrift <= 1)) throw httpError(400, 'thrift must be a number from 0 to 1.');
  if (!['costly', 'M+L', 'all'].includes(next.pairing)) throw httpError(400, 'pairing must be costly, M+L or all.');
  settings = next;
  emit('settings', { settings });
  emitProviders(); // the safety mode changes what "usable" means
  return settings;
});

route('GET', '/api/models', () => modelsPayload());
route('PUT', '/api/models', ({ body }) => {
  const r = body.registry;
  if (!isObj(r) || !Array.isArray(r.models) || !isObj(r.categories) || !isObj(r.domains)) throw httpError(400, 'Send { registry } with models, categories and domains.');
  if (r.models.some((m) => !isObj(m) || typeof m.id !== 'string' || !Array.isArray(m.tiers))) throw httpError(400, 'Every model needs an id and tiers.');
  registry = r;
  return modelsPayload();
});
route('POST', '/api/models/refresh', async () => {
  await new Promise((r) => setTimeout(r, 600));
  const d = new Date();
  registry = { ...registry, fetchedAt: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` };
  return { ok: true, changed: false, updated: 0, dataDate: registry.dataDate, notModified: true, error: null, ...modelsPayload() };
});

const needProject = (id) => { const p = Object.hasOwn(S.projects, id) ? S.projects[id] : null; if (!p) throw httpError(404, `Unknown project ${id}.`); return p; };
route('GET', '/api/projects/:id/toolkit', ({ params }) => {
  const project = needProject(params.id);
  if (!toolkits.has(project.id)) toolkits.set(project.id, starterTools());
  return presentTools(project, toolkits.get(project.id));
});
route('PUT', '/api/projects/:id/toolkit', ({ params, body }) => {
  const project = needProject(params.id);
  if (!Array.isArray(body.tools)) throw httpError(400, 'Send { tools: [...] }.');
  if (body.tools.length > 40) throw httpError(400, 'A project holds at most 40 tools.');
  const out = body.tools.map((t, i) => normalizeTool(t, i));
  const ids = new Set();
  for (const t of out) { if (ids.has(t.id)) throw httpError(400, `Two tools have the id ${t.id}.`); ids.add(t.id); }
  toolkits.set(project.id, out);
  return presentTools(project, out);
});
route('POST', '/api/projects/:id/toolkit/:toolId/run', ({ params }) => {
  const project = needProject(params.id);
  const tool = (toolkits.get(project.id) || []).find((t) => t.id === params.toolId);
  if (!tool) throw httpError(404, `Unknown tool ${params.toolId}.`);
  if (tool.kind === 'command') {
    if (tool.action === 'reveal') return { ok: true }; // Finder shows the project folder
    const command = tool.action === 'check' ? String(project.checkCmd || '').trim() : tool.command;
    if (!command) throw httpError(409, 'The project has no check command yet. The plan sets it.');
    const key = `${project.id}/${tool.id}`;
    if (toolRuns.has(key)) throw httpError(409, `${tool.name} is already running.`);
    toolRuns.add(key);
    const runId = 'run_' + randomBytes(6).toString('hex');
    const { code, chunks } = fakeOutput(command);
    const send = (payload) => emit('toolrun', { runId, toolId: tool.id, ...payload }, { persist: false });
    send({ chunk: `$ ${command}\n` });
    chunks.forEach((chunk, i) => setTimeout(() => send({ chunk }), 500 * (i + 1)));
    setTimeout(() => { toolRuns.delete(key); send({ done: true, code }); }, 500 * (chunks.length + 1));
    return { ok: true, runId };
  }
  if (tool.kind === 'order') {
    sim.paused = false; sim.loop = true;
    const job = createJob({ title: tool.order.title, brief: tool.order.brief, kind: tool.order.kind, crew: tool.order.crew ?? undefined, options: {},
      project: { mode: 'existing', path: project.path, agentFilesAck: project.agentFilesAck === true }, budgetUsd: tool.order.budgetUsd ?? settings.budgetUsd });
    return { ok: true, jobId: job.id };
  }
  // ask: a REQ from the owner to the lead boss or a manager of the job that runs on this project
  const job = all('jobs', (j) => j.projectId === project.id && ACTIVE.includes(j.status)).sort(byId).at(-1);
  if (!job) throw httpError(409, 'No job runs on this project. Start a work order first.');
  const msg = post({ jobId: job.id, human: true, kind: 'REQ', to: tool.ask.to, scope: '#plan', body: tool.ask.body });
  const addressee = msg.toId ? S.agents[msg.toId] : null;
  if (addressee && sim.st && sim.jobId === job.id) sim.st.pending.push({ at: sim.tick + 3, run: () => { if (msg.state === 'open') say(addressee, 'OK', { re: msg.id, body: 'I start it now.' }); } });
  return { ok: true, msgId: msg.id, jobId: job.id };
});
// The owner accepts (or refuses) the agent-config files of an adopted repo (section 9).
route('POST', '/api/projects/:id/agentfiles', ({ params, body }) => {
  const project = needProject(params.id);
  if (typeof body.ack !== 'boolean') throw httpError(400, 'Send { ack: true } or { ack: false }.');
  project.agentFilesAck = body.ack;
  filesAnswered.add(project.id);
  touch('projects', project);
  hubEvt(sim.jobId, '#ops', body.ack ? `The owner accepted the agent-config files of ${project.name}. Gemini workers may work in it.` : `The owner refused the agent-config files of ${project.name}. The Gemini lab is off for this project.`);
  return project;
});

let pickCount = 0;
const revealed = []; // the reveal calls, for GET /__stub/info: { jobId, open }
route('POST', '/api/pick-folder', () => (++pickCount % 4 === 0 ? { path: null } : { path: '/Users/owner/Code/recipe-box', targetBranch: 'main', agentFiles: ['AGENTS.md'] }));
// The Mac app shows the folder dialog itself and sends only the path (final wiring spec S2). Like the hub: an absolute path of at
// most 4096 chars with no NUL; it reads and changes nothing. Stub folders: a path that ends in /not-git (or holds "not-a-repo")
// is no repository, /empty-repo has no commits; a path with "plain" has no agent-config files.
route('POST', '/api/adopt-check', ({ body }) => {
  const p = body.path;
  if (typeof p !== 'string' || !p.trim()) throw httpError(400, 'A project folder is required.');
  if (!p.startsWith('/') || p.length > 4096 || p.includes('\0')) throw httpError(400, 'The path must be absolute, at most 4096 characters, with no NUL.');
  const dir = p.length > 1 ? p.replace(/\/+$/, '') : p;
  if (/\/not-git$|not-a-repo/.test(dir)) throw httpError(400, `Not a git repository: ${dir}`);
  if (/\/empty-repo$/.test(dir)) throw httpError(400, `${dir} has no commits yet. Make a first commit, then try again.`);
  return { path: dir, targetBranch: 'main', agentFiles: /plain/.test(dir) ? [] : ['AGENTS.md'] };
});
// open:false (final wiring spec S3): make the _preview copy and answer its path, but do not open Finder (the Mac app does).
route('POST', '/api/reveal', ({ body }) => {
  if (body.jobId) {
    needJob(body.jobId);
    if (body.what !== 'truck') throw httpError(400, 'what must be "truck".');
    if (body.open !== undefined && typeof body.open !== 'boolean') throw httpError(400, 'open must be true or false.');
    revealed.push({ jobId: body.jobId, open: body.open !== false });
    return { ok: true, path: `/Users/owner/WorkShop/data/work/${body.jobId}/_preview` };
  }
  if (!Object.hasOwn(S.projects, body.projectId)) throw httpError(404, `Unknown project ${body.projectId}.`);
  return { ok: true };
});

route('POST', '/mcp/:token', ({ body }) => {
  if (body.method === 'initialize') return { jsonrpc: '2.0', id: body.id ?? null, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'shop-stub', version: '0' } } };
  if (body.method === 'ping') return { jsonrpc: '2.0', id: body.id ?? null, result: {} };
  if (body.method === 'tools/list') return { jsonrpc: '2.0', id: body.id ?? null, result: { tools: [] } };
  return { jsonrpc: '2.0', id: body.id ?? null, error: { code: -32601, message: 'The stub hub has no agent tools.' } };
});
route('GET', '/mcp/:token/tag', ({ res }) => { res.writeHead(204, BASE_HEADERS); res.end(); });

// ------------------------------------------------------------------ boot

freshState();
resetSim();
{
  muted = true;
  try {
    if (Object.hasOwn(SCENARIOS, START_SCENARIO)) {
      ffClock = START_SCENARIO === 'loop' ? null : Date.now() - 45 * 60 * 1000;
      sim.loop = START_SCENARIO === 'loop' || START_SCENARIO === 'stress';
      SCENARIOS[START_SCENARIO]();
      flushDirty();
    } else {
      console.error(`[stub] unknown scenario "${START_SCENARIO}". Use one of: ${Object.keys(SCENARIOS).join(', ')}.`);
      process.exit(2);
    }
  } finally { muted = false; ffClock = null; }
}

const server = http.createServer(onRequest);
// Heartbeat like the hub (final wiring spec S1): a data message every 5 s with no id line, so Last-Event-ID does not move.
// Its seq is the one GET /api/health reports. One timer for all clients.
const heartbeat = setInterval(() => { if (!clients.size) return; const line = `data: ${JSON.stringify({ type: 'hb', seq: S.seq })}\n\n`; for (const res of clients) res.write(line); }, HB_MS);
server.on('error', (e) => { console.error(`[stub] cannot listen on ${HOST}:${PORT}: ${e.message}`); process.exit(1); });
server.listen(PORT, HOST, () => {
  PORT = server.address().port;
  console.log(`WORKSHOP_STUB_READY http://${HOST}:${PORT}/${AUTH ? `#k=${OWNER_KEY}` : ''}  (ui: ${UI_DIR}, scenario: ${START_SCENARIO}, speed: ${SPEED}${AUTH ? ', owner key enforced' : ''})`);
  loopTick();
});
function shutdown() { clearTimeout(timer); clearInterval(heartbeat); dropClients(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500).unref(); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
if (arg('child', false) === true) { process.stdin.on('end', shutdown); process.stdin.on('error', shutdown); process.stdin.resume(); } // the starter went away
