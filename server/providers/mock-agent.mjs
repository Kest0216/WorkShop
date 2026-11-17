#!/usr/bin/env node
// Mock agent: a scripted fake AI CLI for the WorkShop demo and the end-to-end tests (contract sections 10, 12).
// server/providers/mock.js spawns it: the prompt comes on stdin, the hub tools are reached over MCP (JSON-RPC
// over HTTP at SHOP_MCP_URL/SHOP_TOKEN), and every stdout line is one NormEvent as JSON.
// It recognizes the turn kind from the fixed phrases of server/prompts.js (PHRASES, NUDGES below), acts like a
// competent, terse agent, and keeps a small memory per session and per job under <tmpdir>/workshop-mock.
// Flags in the brief force paths: [mock:<name>] for each name in FLAGS. MOCK_SPEED scales every delay (0 = none).
// Standalone: Node built-ins only, runs with any cwd. It runs no shell: its only child is `node --test`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// reqorphan: QA fails one requirement once and adds no task (also not on the qa_task nudge), so the owner gets the
// inbox item 'requirement' (Waive / Add task / Stop job).
export const FLAGS = Object.freeze(['reject', 'checkfail', 'zone', 'ask', 'block', 'human', 'conflict', 'claim', 'reqfail', 'reqorphan', 'nodone', 'empty', 'slow']);
/** The fixed phrases of server/prompts.js this script keys on. Keep them stable there. */
export const PHRASES = Object.freeze({
  selftest: 'You are the WorkShop self-test.',
  merge: 'MERGE THE PLANS for work order ',
  plan: 'PLAN work order ',
  checkfail: 'CHECK FAILED for work order ',
  baseline: 'Your plan is not applied yet',
  audit: 'LEDGER AUDIT of work order ',
  qa: 'FINAL CHECK of work order ',
  report: 'FINAL REPORT for work order ',
  change: 'THE OWNER ASKS FOR CHANGES',
  consult: 'CONSULT on T',
  review: 'REVIEW T',
  manager: 'EVENTS IN YOUR STREAM SINCE YOUR LAST TURN:',
  stall: 'STALL in work order ',
  digest: 'SESSION DIGEST for ',
  frozen: 'Your work is in review. Answer only.',
  retry: 'RETRY of T',
  cont: 'Continue T',
  task: 'Start now. Hand in with: DONE T',
  wake: 'Answer the open items addressed to you.',
  noHelp: 'No help is available.',
});
export const NUDGES = Object.freeze([
  ['maker', /You ended your turn without a DONE, BLOCK or FAIL post for (T\d+)/],
  ['review', /You ended your turn without a verdict\. Post PASS re:(\d+)/],
  ['plan', /You ended your turn without calling plan_submit/],
  ['qa', /You ended your turn without calling req_verify/],
  ['qa_task', /These requirements failed and no task serves them: ([R\d, ]+)/],
  ['req', /Requirement (R\d+) has no task/],
  ['report', /You ended your turn without calling job_report/],
  ['consult', /You ended your turn without an answer\. Post ANS re:(\d+)/],
  ['open', /You have open items addressed to you/],
  ['restart', /The hub restarted while you worked/],
  ['timeout', /Your last turn ran out of time/],
]);
const KINDS = ['ASK', 'ANS', 'REQ', 'OK', 'NO', 'INFO', 'BLOCK', 'DONE', 'FAIL', 'PASS', 'FIX', 'DECIDE', 'CANCEL', 'EVT'];
const SHARED_FILE = 'src/registry';
const ENV = process.env;
const running = new Set();

// ------------------------------------------------------------------ small helpers

const clean = (s, max = 200) => String(s ?? '').replace(/[^\x20-\x7E]/g, ' ').replace(/[?!;`"<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const oneLine = (s, max = 160) => String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7E]/g, ' ').trim().slice(0, max);
const uniq = (list) => [...new Set(list)];
const words = (s) => new Set((String(s).toLowerCase().match(/[a-z0-9]{3,}/g) || []));
export function similarity(a, b) {
  const A = words(a); const B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / (A.size + B.size - n);
}
const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export function flagsIn(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(/\[mock:([a-z]+)\]/g)) if (FLAGS.includes(m[1])) out.add(m[1]);
  return out;
}
const stripFlags = (s) => String(s ?? '').replace(/\[mock:[a-z]+\]/g, ' ');

/** Glob match like gitops matchZone: "*" one segment, "**" any depth, "?", "{a,b}", "dir/" and bare names cover below. */
export function matchZone(file, zones) {
  return (zones || []).some((zone) => expand(String(zone)).some((z) => zoneRe(z).test(file)));
}
function expand(z) {
  const m = /\{([^{}]*)\}/.exec(z);
  return m ? m[1].split(',').flatMap((alt) => expand(z.slice(0, m.index) + alt + z.slice(m.index + m[0].length))) : [z];
}
function zoneRe(z) {
  let src = '';
  const bare = !/[*?]/.test(z);
  const body = z.replace(/^\.\//, '').replace(/\/+$/, '');
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '*' && body[i + 1] === '*') { src += '.*'; i++; if (body[i + 1] === '/') { src = `${src.slice(0, -2)}(?:.*/)?`; i++; } }
    else if (ch === '*') src += '[^/]*';
    else if (ch === '?') src += '[^/]';
    else src += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${src}${bare || z.endsWith('/') ? '(?:/.*)?' : ''}$`);
}

// ------------------------------------------------------------------ output and pacing

const emit = (ev) => { process.stdout.write(`${JSON.stringify(ev)}\n`); };
const say = (text) => emit({ t: 'text', text });
let speed = 1;
let slow = false;
const pause = (ms) => (speed > 0 ? new Promise((r) => setTimeout(r, ms * speed * (slow ? 8 : 1))) : Promise.resolve());

// ------------------------------------------------------------------ memory: per session and per job

const stateRoot = () => path.join(os.tmpdir(), 'workshop-mock');
const safeName = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'none';
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
export const sessionFile = (sid) => path.join(stateRoot(), `s-${safeName(sid)}.json`);

/** The job folder: one per job of one hub (the work dir data/work/<job> in the cwd path), else per MCP URL and job id. */
export function jobDirFor(cwd, prompt) {
  const parts = path.resolve(cwd).split(path.sep);
  for (let i = parts.length - 1; i >= 1; i--) {
    if (parts[i - 1] === 'work' && /^J\d+$/.test(parts[i])) return path.join(stateRoot(), `j-${hash(parts.slice(0, i + 1).join(path.sep))}`);
  }
  const bp = readText(path.join(cwd, '.shop', 'BLUEPRINT.md')) || '';
  const jid = (/work order (J\d+)/.exec(bp) || /work order (J\d+)/.exec(prompt) || [])[1] || 'J0';
  return path.join(stateRoot(), `j-${hash(`${ENV.SHOP_MCP_URL || ''}|${jid}`)}`);
}
function claimOnce(c, name) {
  fs.mkdirSync(c.jobDir, { recursive: true, mode: 0o700 });
  try { fs.closeSync(fs.openSync(path.join(c.jobDir, `once-${name}`), 'wx', 0o600)); return true; } catch { return false; }
}
/** The requirement id that [mock:reqorphan] failed (one per job). */
const orphanFile = (c) => path.join(c.jobDir, 'orphan.json');
// Per task and per session: a fresh session starts clean, as a real CLI does (it knows only the card and the board).
const taskMemFile = (c, id) => path.join(c.jobDir, `task-${safeName(id)}-${hash(c.sid)}.json`);
const loadTask = (c, id) => ({ turns: 0, wrote: [], outOfZone: [], extras: [], state: null, stopFlag: null, handFlag: null, handins: 0, ...(readJson(taskMemFile(c, id)) || {}) });
const saveTask = (c, id, tm) => writeAtomic(taskMemFile(c, id), JSON.stringify(tm));

// ------------------------------------------------------------------ MCP client

function createClient(base, token) {
  let seq = 0;
  const url = new URL(`${String(base || '').replace(/\/+$/, '')}/${token}`);
  function rpc(method, params, notify = false) {
    const body = JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++seq, method, params });
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', agent: false, timeout: 120_000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-WorkShop': '1', Authorization: `Bearer ${token}`, Connection: 'close' },
      }, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          if (res.statusCode === 202 || notify) return resolve(null);
          let msg = null;
          try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* below */ }
          if (res.statusCode !== 200 || !msg) return reject(new Error(`hub answered HTTP ${res.statusCode}`));
          if (msg.error) return reject(new Error(`hub error ${msg.error.code}: ${msg.error.message}`));
          resolve(msg.result);
        });
      });
      req.on('timeout', () => req.destroy(new Error('hub did not answer in time')));
      req.on('error', reject);
      req.end(body);
    });
  }
  return {
    tools: new Set(),
    async init() {
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'workshop-mock-agent', version: '1.0.0' } });
      await rpc('notifications/initialized', {}, true);
      const list = await rpc('tools/list', {});
      for (const t of list?.tools || []) this.tools.add(t.name);
    },
    async call(name, args) {
      const res = await rpc('tools/call', { name, arguments: args });
      const text = (res?.content || []).map((p) => p.text || '').join('\n');
      return { text, isError: res?.isError === true };
    },
  };
}

/** One hub tool call with its NormEvents. Never throws: a failed call is { text, isError:true }. */
async function call(c, name, args) {
  if (c.client.tools.size && !c.client.tools.has(name)) {
    say(`The hub gives this role no ${name} tool.`);
    return { text: `no tool ${name}`, isError: true, tag: false };
  }
  await pause(300);
  emit({ t: 'tool', name: `mcp__shop__${name}`, summary: oneLine(name === 'post' ? args.line : JSON.stringify(args), 160) });
  let out;
  try { out = await c.client.call(name, args); } catch (err) { out = { text: err.message, isError: true }; }
  const tag = /\[board: \d+ new for you\. Call read\.\]\s*$/.test(out.text);
  out.text = out.text.replace(/\n?\[board: \d+ new for you\. Call read\.\]\s*$/, '').trim();
  out.tag = tag;
  emit({ t: 'tool_result', ok: !out.isError, summary: oneLine(out.text, 160) });
  c.outChars += JSON.stringify(args).length;
  c.calls.push({ name, ok: !out.isError, text: out.text });
  return out;
}
const post = (c, line) => call(c, 'post', { line });
const idOf = (res) => Number((/^ok (\d+)/.exec(res.text) || [])[1]) || null;

// ------------------------------------------------------------------ prompt parsing

/** One rendered board line: id age KIND @from[>@to] scope re:id slots: body (or the short reminder form). */
export function parseLine(line) {
  const m = /^(~?)(\d+) (.+)$/.exec(line);
  if (!m) return null;
  const cut = m[3].indexOf(': ');
  const head = (cut < 0 ? m[3] : m[3].slice(0, cut)).split(' ');
  let i = /^\d+[mhd]$/.test(head[0]) ? 1 : 0;
  const kind = head[i++];
  if (!KINDS.includes(kind) || !/^@/.test(head[i] || '')) return null;
  const [from, to] = head[i++].split('>');
  const msg = { id: Number(m[2]), kind, from, to: to || null, scope: null, re: null, slots: {}, body: cut < 0 ? '' : m[3].slice(cut + 2) };
  for (const tok of head.slice(i)) {
    if (/^(T\d+|#\w+)$/.test(tok)) msg.scope = tok;
    else if (/^re:\d+$/.test(tok)) msg.re = Number(tok.slice(3));
    else if (tok.includes('=')) msg.slots[tok.slice(0, tok.indexOf('='))] = tok.slice(tok.indexOf('=') + 1);
  }
  return msg;
}

/** All board lines of a prompt, with continuation lines joined. open: the lines under OPEN FOR YOU. */
export function parseView(text) {
  const lines = []; const open = [];
  let section = null; let last = null;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trimEnd();
    if (/^OPEN FOR YOU:?$/.test(line)) { section = 'open'; continue; }
    if (/^(IN FORCE|NEW|YOUR LAST POSTS:|STATUS:)$/.test(line)) { section = line; continue; }
    if (line.startsWith('| ') && last) { last.body += `\n${line.slice(2)}`; continue; }
    const msg = parseLine(line);
    last = msg;
    if (!msg) continue;
    lines.push(msg);
    if (section === 'open') open.push(msg);
  }
  return { lines, open };
}

/** Lines of a prompt that the hub wrote (no view lines): turn detection runs on these only. */
const hubText = (prompt) => String(prompt).split('\n').filter((l) => !/^~?\d+ \S/.test(l) && !l.startsWith('| ') && !/^(OWNER (here|away)|BOARD @|-- peer posts)/.test(l)).join('\n');

export function detectTurn(prompt) {
  const t = hubText(prompt);
  const at = (p) => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm').test(t);
  if (t.includes(PHRASES.selftest)) return { kind: 'selftest' };
  if (at(PHRASES.merge)) return { kind: 'merge' };
  if (at(PHRASES.plan)) return { kind: 'plan' };
  if (at(PHRASES.checkfail)) return { kind: 'checkfail', stage: t.includes(PHRASES.baseline) ? 'baseline' : t.includes('after the first task merged') ? 'first' : 'head' };
  if (at(PHRASES.audit)) return { kind: 'audit' };
  if (at(PHRASES.qa)) return { kind: 'qa' };
  if (at(PHRASES.report)) return { kind: 'report' };
  if (at(PHRASES.change)) return { kind: 'change' };
  let m = /^CONSULT on (T\d+)\./m.exec(t);
  if (m) return { kind: 'consult', task: m[1], id: Number((/QUESTION \(message (\d+)\)/.exec(t) || [])[1]) || null };
  m = /^REVIEW (T\d+)( again)? by (@\S+?)\. Their DONE is message (\d+)\./m.exec(t);
  if (m) return { kind: 'review', task: m[1], again: Boolean(m[2]), maker: m[3], id: Number(m[4]), buddy: t.includes('You are the buddy check') };
  if (at(PHRASES.manager)) return { kind: 'manager' };
  if (at(PHRASES.stall)) return { kind: 'stall' };
  if (at(PHRASES.digest)) return { kind: 'digest', task: (/^YOUR TASK: (T\d+)/m.exec(t) || [])[1] || null };
  for (const [kind, re] of NUDGES) {
    m = re.exec(t);
    if (m) return { kind: 'nudge', nudge: kind, arg: m[1] || null };
  }
  if (at(PHRASES.frozen)) return { kind: 'frozen' };
  m = /^RETRY of (T\d+)\./m.exec(t);
  if (m) return { kind: 'retry', task: m[1] };
  m = /Continue (T\d+)\. When it is finished/.exec(t);
  if (m) return { kind: 'continue', task: m[1] };
  m = /^Start now\. Hand in with: DONE (T\d+)/m.exec(t);
  if (m) return { kind: 'task', task: m[1] };
  if (t.includes(PHRASES.wake)) return { kind: 'wake' };
  return { kind: 'unknown' };
}

/** A task card (.shop/TASK.md or the card in a prompt). */
export function parseCard(text) {
  const s = String(text ?? '');
  const head = /^TASK (T\d+): (.*)$/m.exec(s);
  if (!head) return null;
  const accept = [];
  const block = /^ACCEPT:\n((?:\d+\. .*\n?)*)/m.exec(s);
  if (block) for (const l of block[1].split('\n')) if (/^\d+\. /.test(l)) accept.push(l.replace(/^\d+\. /, ''));
  const zones = ((/^ZONES: (.*)$/m.exec(s) || [])[1] || '').split(',').map((z) => z.trim()).filter(Boolean);
  const serves = [...s.matchAll(/^- (R\d+)(?:: (.*))?$/gm)].map((x) => ({ id: x[1], text: x[2] || '' }));
  return {
    id: head[1], title: head[2], spec: (/^SPEC: (.*)$/m.exec(s) || [])[1] || '', accept, zones, serves,
    check: (/^CHECK: (.*)$/m.exec(s) || [])[1] || '',
  };
}
const between = (s, a, b) => { const i = s.indexOf(a); if (i < 0) return ''; const j = b ? s.indexOf(b, i + a.length) : -1; return s.slice(i + a.length, j < 0 ? undefined : j).trim(); };
const reqLines = (block) => [...String(block).matchAll(/^(R\d+): (.*)$/gm)].map((m) => ({ id: m[1], text: m[2] }));

// ------------------------------------------------------------------ planning

const STOP = new Set(('a an the it its must should shall can could will would be is are was were and or but to of for with that this these those in on by as at from has have had each every all any their also then when only not no user users project tool app program build make write create add support supports show shows give gives let lets use uses using do does need needs want wants we you our your there here which who what how one two three new simple small very more most some into out about list lists given same other others work order brief owner').split(' '));
const RESERVED = /^(?:thanks|thank|thx|please|pls|sorry|hello|hi|hey|greetings|cheers|kindly|awesome|maybe|perhaps|probably|index|e2e|registry|core|test|tests|src|scope|report|readme|notes|fix|change)$/;

/** Requirements: the sentences of the brief, without the mock flags. */
export function cutRequirements(brief, title = '') {
  const parts = stripFlags(brief).replace(/\r/g, '').split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9"(])/)
    .map((s) => s.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim())
    .filter((s) => s.split(' ').length >= 2 && /[a-z]/i.test(s));
  const out = [];
  for (const p of parts) {
    const text = `${p.replace(/[?!.]+$/, '').slice(0, 240)}.`;
    if (!out.some((o) => similarity(o, text) > 0.9)) out.push(text);
  }
  if (!out.length) out.push(`The project does what the title says: ${clean(title, 200) || 'the work order'}.`);
  return out.slice(0, 30);
}
function slugFor(text, used, n) {
  const cands = (String(text).toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []).filter((w) => !STOP.has(w) && !RESERVED.test(w));
  let slug = (cands[0] || `part${n}`).slice(0, 16);
  for (let k = 2; used.has(slug); k++) slug = `${(cands[0] || 'part').slice(0, 13)}-${k}`;
  used.add(slug);
  return slug;
}
function domainFor(text) {
  const s = String(text).toLowerCase();
  if (/\b(ui|page|html|css|button|screen|browser|frontend|view|form)s?\b/.test(s)) return 'frontend';
  if (/\b(data|csv|json|file|store|save|load|database|record|table)s?\b/.test(s)) return 'data';
  if (/\b(sort|search|algorithm|compute|calculate|count|math|score|rank)s?\b/.test(s)) return 'algo';
  if (/\b(test|check|verify)s?\b/.test(s)) return 'test';
  return 'backend';
}
const short = (s, n = 12) => s.replace(/\.$/, '').split(' ').slice(0, n).join(' ');

/**
 * A small plan for any brief (contract section 12, plan rules): a skeleton task that owns the root files and the
 * check script, 2 to 5 parts with disjoint zones, and a last task for the README and the end-to-end test.
 * opts: { brief, title, kind, newProject, maxTasks, existing:{ testScript:boolean }, flags:Set, asked:boolean }
 */
export function buildPlan(opts) {
  const kind = opts.kind || 'build';
  const reqs = cutRequirements(opts.brief, opts.title);
  const flags = opts.flags || new Set();
  const used = new Set();
  const all = reqs.map((_, i) => i + 1);
  const docReqs = all.filter((n) => /readme|document|docs|how to run|instruction|usage|report/i.test(reqs[n - 1]));
  const work = all.filter((n) => !docReqs.includes(n)).length ? all.filter((n) => !docReqs.includes(n)) : all;
  const nParts = Math.max(2, Math.min(5, work.length, Math.max(2, (opts.maxTasks || 40) - 2)));
  const serve = Array.from({ length: nParts }, (_, p) => {
    const list = work.filter((_, i) => i % nParts === p);
    return list.length ? list : [work[p % work.length]];
  });
  const tasks = [];
  const assumptions = [];
  if (kind === 'research') {
    tasks.push({ key: 'scope', title: 'Scope of the research', spec: 'Write notes/scope.md: the research questions of the brief, one per line, and how each is answered.', acceptance: ['notes/scope.md lists every research question of the brief.', 'Each question names the note that answers it.'], zones: ['notes/scope.md'], domain: 'docs', size: 'S', deps: [], reqs: [1], stream: 'research' });
    serve.forEach((list, p) => {
      const slug = slugFor(reqs[list[0] - 1], used, p + 1);
      tasks.push({ key: slug, title: `Research: ${short(reqs[list[0] - 1], 8)}`, spec: `Answer in notes/${slug}.md: ${list.map((n) => reqs[n - 1]).join(' ')} Give each source with its URL and date.`, acceptance: [`notes/${slug}.md answers the question with sources.`, 'Each source has a URL and a date.'], zones: [`notes/${slug}.md`], domain: 'research', size: p % 2 ? 'M' : 'S', deps: ['scope'], reqs: list, stream: p % 2 ? 'research-b' : 'research-a' });
    });
    tasks.push({ key: 'report', title: 'Write REPORT.md from the notes', spec: 'Write REPORT.md: a summary of every note in notes/ with the sources.', acceptance: ['REPORT.md summarizes every note.', 'REPORT.md lists the sources.'], zones: ['REPORT.md'], domain: 'synthesis', size: 'S', deps: tasks.map((t) => t.key), reqs: docReqs.length ? docReqs : [all[all.length - 1]], stream: 'research' });
    assumptions.push('The notes are Markdown files in notes/.', 'The mock lab cannot browse, so sources come from the brief.');
    return finish({ requirements: reqs.map((text) => ({ text })), tasks, no_check_reason: 'Research work order: the notes have no automatic check.', assumptions, notes: 'Each research question gets one note in notes/<topic>.md with sources (URL and date). REPORT.md summarizes the notes.' }, opts);
  }
  const ext = opts.newProject === false ? 'mjs' : 'js';
  const skeleton = opts.newProject === false
    ? { key: 'core', title: 'Shared core module', spec: `Create src/core/index.${ext} with the shared run(input) shape and its test. Keep the existing files as they are.`, acceptance: [`src/core/index.${ext} exports run and part.`, `test/core.test.${ext} passes with node --test.`], zones: [`src/core/**`, `test/core.test.${ext}`] }
    : { key: 'core', title: 'Project skeleton and check script', spec: 'Create package.json (type module, test script node --test), src/index.js with the shared run(input) shape, and test/index.test.js.', acceptance: ['package.json sets type module and the test script node --test.', 'src/index.js exports run and part.', 'test/index.test.js passes with node --test.'], zones: ['package.json', 'src/index.js', 'test/index.test.js'] };
  tasks.push({ ...skeleton, domain: 'chore', size: 'S', deps: [], reqs: [1], stream: 'core' });
  serve.forEach((list, p) => {
    const lead = reqs[list[0] - 1];
    const slug = slugFor(lead, used, p + 1);
    const acceptance = [`src/${slug}/index.${ext} exports run(input) for: ${short(lead)}.`, `test/${slug}.test.${ext} has at least two passing tests.`];
    if (p % 2 === 1) acceptance.push('It uses only built-in Node modules.');
    tasks.push({
      key: slug, title: `Part ${slug}: ${short(lead, 8)}`,
      spec: `Create src/${slug}/index.${ext} with a run(input) function that serves: ${list.map((n) => reqs[n - 1]).join(' ')} Write test/${slug}.test.${ext} with node:test.`,
      acceptance, zones: [`src/${slug}/**`, `test/${slug}.test.${ext}`], domain: domainFor(lead), size: lead.length > 90 || p % 3 === 2 ? 'M' : 'S',
      deps: ['core'], reqs: list, stream: p % 2 ? 'parts-b' : 'parts-a',
      ...(/password|credential|secret|payment|billing|permission/i.test(lead) ? { pair: true } : {}),
    });
  });
  tasks.push({ key: 'docs', title: 'README and end-to-end test', spec: `Write README.md (what the project does, how to run it) and test/e2e.test.${ext}, which loads every part in src/ and runs it.`, acceptance: ['README.md says what the project does and how to run the tests.', `test/e2e.test.${ext} loads every part in src/ and passes.`, 'node --test passes on the whole project.'], zones: ['README.md', `test/e2e.test.${ext}`], domain: 'docs', size: 'S', deps: tasks.map((t) => t.key), reqs: docReqs.length ? docReqs : [all[all.length - 1]], stream: 'docs' });
  assumptions.push('The project uses Node 20 with ES modules and no packages.', 'Each part is a small module with a run(input) function.');
  if (opts.asked) assumptions.push('The parts give plain text output (option A of the question to the owner) until the owner answers.');
  if (flags.has('conflict') || flags.has('claim')) assumptions.push(`Parts register in ${SHARED_FILE}.${ext} through the claim tool.`);
  const existingCheck = opts.existing && opts.existing.testScript ? 'npm test' : 'node --test';
  return finish({
    requirements: reqs.map((text) => ({ text })), tasks, check_cmd: existingCheck, assumptions,
    notes: `Node 20 ESM, built-in modules only. Each part lives in src/<part>/index.${ext} and exports part and run(input), which returns { part, count, items }. Tests live in test/<part>.test.${ext} and use node:test. The check is ${existingCheck}. Do not edit files outside your zones: use the claim tool.`,
  }, opts);
}
function finish(plan, opts) {
  const max = opts.maxTasks || 40;
  if (plan.tasks.length > max) plan.tasks = plan.tasks.slice(0, max);
  return plan;
}

/** The merge turn: the own draft (or the first) plus covers for every requirement of every draft. */
export function mergePlans(drafts, own) {
  const base = JSON.parse(JSON.stringify(own || drafts[0].plan));
  const reqText = (r) => (typeof r === 'string' ? r : r && r.text) || '';
  base.requirements = (base.requirements || []).map((r) => ({ text: reqText(r) }));
  const covers = []; const dropped = [];
  for (const d of drafts) {
    (d.plan.requirements || []).forEach((r, i) => {
      const text = reqText(r);
      let best = -1; let score = 0;
      base.requirements.forEach((f, j) => { const s = similarity(f.text, text); if (s > score) { score = s; best = j; } });
      if (best >= 0 && score >= 0.5) return covers.push({ draft: d.handle, n: i + 1, req: best + 1 });
      if (base.requirements.length >= 30 || !text) return dropped.push({ draft: d.handle, n: i + 1, why: 'The final plan has no room for it.' });
      base.requirements.push({ text });
      const n = base.requirements.length;
      const part = base.tasks.filter((t) => t.key !== 'core' && t.key !== 'docs').sort((a, b) => a.reqs.length - b.reqs.length)[0] || base.tasks[0];
      part.reqs.push(n);
      covers.push({ draft: d.handle, n: i + 1, req: n });
    });
  }
  return { ...base, covers, ...(dropped.length ? { dropped } : {}) };
}

// ------------------------------------------------------------------ the posts it can make

export const POSTS = {
  done: (task, tests, acc, files, note) => {
    const list = files.length <= 2 ? files.join(' and ') : `${files.length} files, see ${files[0]}`;
    const t = tests === 'none' ? 'No automatic test covers it. I checked the files by hand.' : `${tests.split('/')[0]} of ${tests.split('/')[1]} tests pass.`;
    const body = [files.length ? `Added ${list}.` : 'I changed no files.', t, note].filter(Boolean).join(' ');
    return `DONE ${task} tests=${tests} acc=${acc}: ${body.length <= 200 ? body : t}`;
  },
  askMgr: (task, slug) => `ASK @mgr ${task}: Should ${slug} return an empty result for empty input?`,
  block: (task, slug) => `BLOCK ${task} why=unclear: I need the output format for ${slug}. The task card does not name it.`,
  askHuman: () => 'ASK @human #plan default=A: Which output form should the parts give? A) Plain text lines B) JSON objects',
  ansAsk: (id) => `ANS re:${id}: Yes. Follow the task card and state your choice in the DONE summary.`,
  ansBlock: (id) => `ANS re:${id}: Use plain text output and keep the change inside your zones. Then hand in with DONE.`,
  ansPeer: (id) => `ANS re:${id}: My part exports run(input), see .shop/TASK.md:1. It returns part, count and items.`,
  ansConsult: (id) => `ANS re:${id}: Keep the change inside the zones of .shop/TASK.md:1 and run the check before DONE. If a check failed, read .shop/CHECK.log:1 first.`,
  okReq: (id) => `OK re:${id}: The crew follows this order now.`,
  pass: (id, n) => `PASS re:${id}: The change meets ${n ? `all ${n}` : 'the'} acceptance items. The tests are real and pass.`,
  fixReject: (id, test) => `FIX re:${id}:\n1. Add a test for empty input in ${test}:1\n2. Add a test that keeps the order of the items in ${test}:1`,
  fixAcc: (id) => `FIX re:${id}:\n1. Meet every acceptance item of the task card, see .shop/TASK.md:3`,
  fixEmpty: (id) => `FIX re:${id}:\n1. The change is empty. Add the files that .shop/TASK.md:1 asks for.`,
  fixCheck: (id) => `FIX re:${id}:\n1. The check failed. Repair the failing test, see .shop/CHECK.log:1`,
};
/** Every line this script can post, filled with sample values (for the validator tests). */
export function samplePosts() {
  return [
    POSTS.done('T3', '2/2', '3/3', ['src/alpha/index.js', 'test/alpha.test.js']),
    POSTS.done('T3', '3/4', '2/2', ['a.js', 'b.js', 'c.js'], 'I assumed plain text output.'),
    POSTS.done('T4', 'none', '2/2', ['notes/alpha.md']),
    POSTS.done('T5', '0/0', '1/1', []),
    POSTS.askMgr('T3', 'alpha'), POSTS.block('T3', 'alpha'), POSTS.askHuman(),
    POSTS.ansAsk(41), POSTS.ansBlock(41), POSTS.ansPeer(41), POSTS.ansConsult(41), POSTS.okReq(41),
    POSTS.pass(41, 3), POSTS.pass(41, 0), POSTS.fixReject(41, 'test/alpha.test.js'), POSTS.fixAcc(41), POSTS.fixEmpty(41), POSTS.fixCheck(41),
  ];
}

// ------------------------------------------------------------------ files of a maker

const SKIP_DIRS = new Set(['.git', 'node_modules', '.shop', '.agents']);
function walk(dir, max = 400) {
  const out = [];
  const go = (rel) => {
    let entries = [];
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= max) return;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) go(p);
      else if (e.isFile()) out.push(p);
    }
  };
  go('');
  return out;
}
const relImport = (from, to) => { const r = path.posix.relative(path.posix.dirname(from), to); return r.startsWith('.') ? r : `./${r}`; };

export function resolveMarkers(text) {
  const out = []; let mode = null; let ours = []; let theirs = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('<<<<<<< ') || line === '<<<<<<<') { mode = 'ours'; ours = []; theirs = []; }
    else if (mode && line.startsWith('|||||||')) mode = 'base';
    else if (mode && line.trim() === '=======') mode = 'theirs';
    else if (mode && line.startsWith('>>>>>>>')) { out.push(...ours, ...theirs.filter((l) => !ours.includes(l))); mode = null; }
    else if (mode === 'ours') ours.push(line);
    else if (mode === 'theirs') theirs.push(line);
    else if (mode !== 'base') out.push(line);
  }
  return out.join('\n');
}
function resolveConflicts(c) {
  const fixed = [];
  for (const rel of walk(c.cwd)) {
    const file = path.join(c.cwd, rel);
    let text;
    try { if (fs.statSync(file).size > 512 * 1024) continue; text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (!/^<<<<<<< /m.test(text)) continue;
    fs.writeFileSync(file, resolveMarkers(text));
    emit({ t: 'tool', name: 'Edit', summary: `resolve conflict markers in ${rel}` });
    fixed.push(rel);
  }
  return fixed;
}

function moduleSource(card, slug) {
  return [`// ${oneLine(card.title, 120)} (${card.id}).`, `// Serves: ${card.serves.map((s) => s.id).join(', ') || 'see .shop/TASK.md'}.`,
    `// ${oneLine(card.spec, 160)}`, `export const part = '${slug}';`, '', '/** The items of the input, trimmed, with their count. */', 'export function run(input) {',
    '  const items = input === undefined || input === null ? [] : Array.isArray(input) ? input : [input];',
    '  return { part, count: items.length, items: items.map((item) => String(item).trim()) };', '}', ''].join('\n');
}
function testSource(slug, modRel, extras, failing) {
  const t = (name, ...body) => [`test('${slug} ${name}', () => {`, ...body.map((b) => `  ${b}`), '});'];
  const lines = [`// Tests for ${slug}. Run: node --test`, "import test from 'node:test';", "import assert from 'node:assert/strict';", `import { run } from '${modRel}';`, '',
    ...t('counts the items it gets', "assert.equal(run(['a', 'b']).count, 2);"), ...t('turns one value into a list', "assert.deepEqual(run(' x ').items, ['x']);")];
  if (extras.includes('empty')) lines.push(...t('handles empty input', 'assert.equal(run([]).count, 0);', 'assert.deepEqual(run(undefined).items, []);'));
  if (extras.includes('order')) lines.push(...t('keeps the order of the items', "assert.deepEqual(run(['b', 'a']).items, ['b', 'a']);"));
  if (extras.includes('name')) lines.push(...t('names its part', `assert.equal(run([]).part, '${slug}');`));
  if (extras.includes('extra')) lines.push(...t('returns a new object each time', 'assert.notEqual(run([]), run([]));'));
  if (failing) lines.push('// mock:checkfail start', ...t('mock check fail', 'assert.equal(run([]).count, 1);'), '// mock:checkfail end');
  return `${lines.join('\n')}\n`;
}
function e2eSource(testPath) {
  const src = relImport(testPath, 'src/').replace(/\/?$/, '/');
  return ["// End-to-end: every part in src/ loads and runs. Run: node --test", "import test from 'node:test';", "import assert from 'node:assert/strict';", "import fs from 'node:fs';", '',
    `const src = new URL('${src}', import.meta.url);`, "test('every part in src/ loads and runs', async () => {",
    '  const dirs = fs.existsSync(src) ? fs.readdirSync(src, { withFileTypes: true }).filter((d) => d.isDirectory()) : [];',
    '  for (const dir of dirs) {', "    for (const name of ['index.js', 'index.mjs']) {", '      const file = new URL(`${dir.name}/${name}`, src);',
    '      if (!fs.existsSync(file)) continue;', '      const mod = await import(file);', "      if (typeof mod.run === 'function') assert.equal(typeof mod.run([]).count, 'number');",
    '    }', '  }', '});', ''].join('\n');
}
function blueprintInfo(cwd) {
  const bp = readText(path.join(cwd, '.shop', 'BLUEPRINT.md')) || '';
  return { title: (/^# Blueprint for work order J\d+: (.*)$/m.exec(bp) || [])[1] || 'The project', brief: between(bp, '## Brief\n', '\n## '), reqs: [...bp.matchAll(/^- (R\d+) \[\w+\] (.*)$/gm)].map((m) => ({ id: m[1], text: m[2] })) };
}
function docSource(file, card, cwd) {
  const bp = blueprintInfo(cwd);
  const date = new Date().toISOString().slice(0, 10);
  if (/REPORT\.md$/.test(file)) {
    const notes = walk(cwd).filter((p) => /^notes\/.*\.md$/.test(p));
    return `# Report: ${bp.title}\n\n${notes.map((n) => `- ${n}: ${oneLine((readText(path.join(cwd, n)) || '').split('\n')[0].replace(/^#\s*/, ''), 100)}`).join('\n') || '- No notes found.'}\n\n## Sources\n\n- The brief of the owner, read on ${date}.\n`;
  }
  if (/README\.md$/i.test(file)) {
    return `# ${bp.title}\n\n${oneLine(stripFlags(bp.brief), 600)}\n\n## What it does\n\n${bp.reqs.map((r) => `- ${r.id}: ${r.text}`).join('\n') || `- ${card.title}`}\n\n## How to run\n\nRun the tests with \`node --test\` in the project folder (Node 20 or newer).\n\n## Layout\n\n- \`src/<part>/index.js\`: one part each, with a \`run(input)\` function.\n- \`test/\`: one test file for each part, and an end-to-end test.\n`;
  }
  return `# ${oneLine(card.title, 120)}\n\n${oneLine(card.spec, 600)}\n\n## Findings\n\n${card.serves.map((s) => `- ${s.id}: ${s.text}`).join('\n') || '- See the task card.'}\n\n## Sources\n\n- The brief of the owner, read on ${date}.\n`;
}

/** The files a task writes, derived from its zones (the plan above, or any plan of a real boss). */
export function designFiles(card, cwd, tm, opts = {}) {
  const zones = card.zones;
  const pkgPath = path.join(cwd, 'package.json');
  const pkg = readJson(pkgPath);
  const ext = zones.some((z) => z.endsWith('.mjs')) ? 'mjs' : zones.includes('package.json') || pkg?.type === 'module' ? 'js' : 'mjs';
  const slug = (/^Part ([a-z0-9-]+):/.exec(card.title) || [])[1] || (zones.map((z) => /^src\/([a-z0-9-]+)\//.exec(z)?.[1]).find(Boolean)) || clean(card.id, 10).toLowerCase();
  let mod = null; let testFile = null; const docs = []; let wantPkg = false;
  for (const z of zones) {
    const wild = /[*?{]/.test(z) || z.endsWith('/');
    const base = z.split(/[*?{]/)[0].replace(/\/+$/, '');
    if (z === SHARED_FILE + '.js' || z === SHARED_FILE + '.mjs') continue;
    if (!wild && z === 'package.json') wantPkg = true;
    else if (!wild && /\.md$/i.test(z)) docs.push(z);
    else if (!wild && /(^|\/)test\/|\.test\.m?js$/.test(z)) testFile = testFile || z;
    else if (!wild && /\.m?js$/.test(z)) mod = mod || z;
    else if (wild && /^(notes|docs)$/.test(base)) docs.push(`${base}/${slug}.md`);
    else if (wild && /(^|\/)tests?$/.test(base)) testFile = testFile || `${base}/${slug}.test.${ext}`;
    else if (wild && base) { mod = mod || `${base}/index.${ext}`; if (!testFile && !zones.some((y) => /test/.test(y))) testFile = `${base}/${slug}.test.${ext}`; }
  }
  const files = [];
  if (wantPkg) files.push({ path: 'package.json', content: `${JSON.stringify(pkg ? { ...pkg, scripts: { test: 'node --test', ...(pkg.scripts || {}) } } : { name: slug, version: '0.1.0', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n` });
  if (mod) files.push({ path: mod, content: moduleSource(card, slug) });
  if (testFile) {
    const e2e = !mod || /e2e|end.to.end/i.test(testFile);
    files.push({ path: testFile, test: true, content: e2e && !mod ? e2eSource(testFile) : testSource(slug, relImport(testFile, mod), tm.extras, opts.failing) });
  }
  for (const d of docs) files.push({ path: d, content: docSource(d, card, cwd) });
  if (opts.shared) {
    const rel = `${SHARED_FILE}.${ext}`;
    const old = readText(path.join(cwd, rel)) || '// Parts registered by the tasks of this work order. A shared file: edit it only through a claim.\nexport const parts = [];\n';
    files.push({ path: rel, content: old.includes(`parts.push('${slug}');`) ? old : `${old.replace(/\n*$/, '\n')}parts.push('${slug}');\n` });
  }
  return { files, slug, ext };
}

function runTests(cwd, files) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    // No token for the child. NODE_TEST_CONTEXT (set when the hub itself runs under node --test) makes a nested
    // `node --test` report to a parent that is not there and exit 0 on a red test.
    for (const k of ['SHOP_TOKEN', 'SHOP_MCP_URL', 'WORKSHOP_TOKEN', 'WORKSHOP_TAG_URL', 'NODE_TEST_CONTEXT']) delete env[k];
    emit({ t: 'tool', name: 'Bash', summary: `node --test ${files.join(' ')}` });
    let child;
    try { child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return resolve({ tests: 0, pass: 0, out: '' }); }
    running.add(child);
    let out = '';
    child.stdout.on('data', (d) => { if (out.length < 200_000) out += d; });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    const done = () => {
      clearTimeout(timer);
      running.delete(child);
      const num = (re) => Number((re.exec(out) || [])[1] || 0);
      const r = { tests: num(/^# tests (\d+)/m), pass: num(/^# pass (\d+)/m), out };
      emit({ t: 'tool_result', ok: r.tests === r.pass, summary: `${r.pass} of ${r.tests} tests pass` });
      resolve(r);
    };
    child.on('close', done);
    child.on('error', () => { clearTimeout(timer); running.delete(child); resolve({ tests: 0, pass: 0, out: '' }); });
  });
}

// ------------------------------------------------------------------ turn handlers

/** Answer the open items addressed to me (ASK, BLOCK with ANS; REQ with OK). Reads the board when told to. */
async function answerOpen(c, { peer = false, read = false } = {}) {
  let items = parseView(c.prompt).open;
  const done = new Set(c.mem.answered || []);
  let count = 0;
  for (let round = 0; round < 3; round++) {
    if (read || (round > 0)) {
      const r = await call(c, 'read', {});
      items = parseView(r.text).open;
      read = false;
    }
    let tagged = false;
    for (const m of items) {
      if (done.has(m.id) || m.from === c.handle || !['ASK', 'BLOCK', 'REQ'].includes(m.kind)) continue;
      if (m.kind === 'ASK' && m.to === '@other') continue;
      const line = m.kind === 'REQ' ? POSTS.okReq(m.id) : m.kind === 'BLOCK' ? POSTS.ansBlock(m.id) : peer ? POSTS.ansPeer(m.id) : POSTS.ansAsk(m.id);
      const r = await post(c, line);
      done.add(m.id);
      count++;
      tagged = tagged || r.tag;
    }
    if (!tagged) break;
  }
  c.mem.answered = [...done].slice(-200);
  return count;
}

function planInfo(c) {
  const p = c.prompt;
  const head = /^PLAN work order (J\d+) \((\w+)\): (.*)$/m.exec(p) || /^MERGE THE PLANS for work order (J\d+): (.*)$/m.exec(p);
  const isMerge = !/^PLAN /m.test(head?.[0] || '');
  return {
    jobId: head?.[1] || 'J0', kind: isMerge ? (p.includes('Research work order:') ? 'research' : 'build') : head?.[2] || 'build', title: (isMerge ? head?.[2] : head?.[3]) || '',
    brief: between(p, 'BRIEF FROM THE OWNER:\n', isMerge ? '\n\nDRAFT BY ' : '\n\nRULES FOR THE PLAN'),
    newProject: !p.includes('This is an existing project.'), maxTasks: Number((/At most (\d+) tasks/.exec(p) || [])[1]) || 40,
  };
}
function inspectRepo(cwd) {
  const pkg = readJson(path.join(cwd, 'package.json'));
  return { testScript: Boolean(pkg && pkg.scripts && typeof pkg.scripts.test === 'string' && !/no test specified/.test(pkg.scripts.test)) };
}
function saveFlags(c, more) {
  for (const f of more) c.flags.add(f);
  if (c.flags.size) writeAtomic(path.join(c.jobDir, 'flags.json'), JSON.stringify([...c.flags]));
  slow = c.flags.has('slow');
}
async function submitPlan(c, plan, info) {
  let r = await call(c, 'plan_submit', plan);
  if (r.isError && !plan.covers) {
    say(`The hub refused the plan: ${oneLine(r.text, 200)}. Sending a smaller plan.`);
    plan = buildPlan({ ...info, brief: info.title || info.brief, flags: new Set() });
    r = await call(c, 'plan_submit', plan);
  }
  c.mem.lastPlan = plan;
  return r.isError ? `plan refused: ${oneLine(r.text, 120)}` : `plan submitted: ${plan.requirements.length} requirements, ${plan.tasks.length} tasks`;
}
async function planTurn(c) {
  const info = /^PLAN work order /m.test(hubText(c.prompt)) || !c.mem.planInfo ? planInfo(c) : c.mem.planInfo; // a nudge has no brief
  c.mem.planInfo = info;
  saveFlags(c, flagsIn(info.brief));
  let asked = c.mem.asked === true;
  if (!asked && c.flags.has('human') && c.role === 'boss' && claimOnce(c, 'human')) {
    asked = !(await post(c, POSTS.askHuman())).isError;
    c.mem.asked = asked;
  }
  await pause(800);
  return submitPlan(c, buildPlan({ ...info, flags: c.flags, asked, existing: info.newProject ? null : inspectRepo(c.cwd) }), info);
}
async function mergeTurn(c) {
  const info = planInfo(c);
  c.mem.planInfo = info;
  saveFlags(c, flagsIn(info.brief));
  const drafts = [];
  for (const m of c.prompt.matchAll(/^DRAFT BY (@\S+):\n(.*)$/gm)) {
    try { drafts.push({ handle: m[1], plan: JSON.parse(m[2]) }); } catch { say(`The draft of ${m[1]} is not valid JSON.`); }
  }
  const own = buildPlan({ ...info, flags: c.flags, existing: info.newProject ? null : inspectRepo(c.cwd) });
  return submitPlan(c, drafts.length ? mergePlans(drafts, own) : own, info);
}
async function checkFailTurn(c) {
  if (c.turn.stage === 'baseline') {
    const info = c.mem.planInfo || { ...blueprintInfo(c.cwd), kind: 'build', newProject: false };
    const plan = { ...(c.mem.lastPlan || buildPlan({ ...info, flags: c.flags, existing: inspectRepo(c.cwd) })) };
    delete plan.covers; delete plan.dropped;
    if (plan.check_cmd && plan.check_cmd !== 'node --test') plan.check_cmd = 'node --test';
    else { delete plan.check_cmd; plan.no_check_reason = 'The check of the project fails before any change. The owner must repair it first.'; }
    return submitPlan(c, plan, info);
  }
  const tail = between(c.prompt, 'OUTPUT: ', '\n');
  const paths = uniq([...tail.matchAll(/\b((?:src|test|lib)\/[\w./-]+\.m?js)\b/g)].map((m) => m[1])).slice(0, 6);
  const r = await call(c, 'task_add', {
    title: 'Repair the red check', spec: `The check fails${c.turn.stage === 'first' ? ' after the first merge' : ' on the integration branch'}. Find the cause in the check output and repair it. Do not weaken a test.`,
    acceptance: ['The check command passes.', 'No test is deleted or weakened.'], zones: paths.length ? paths : ['src/index.js', 'test/index.test.js'], domain: 'fix', size: 'S', stream: 'core',
  });
  return r.isError ? 'fix task refused' : 'fix task added';
}
async function auditTurn(c) {
  const brief = between(c.prompt, 'BRIEF FROM THE OWNER:\n', '\nLEDGER:\n');
  const ledger = reqLines(between(c.prompt, '\nLEDGER:\n', '\nFor each thing'));
  let added = 0;
  for (const text of cutRequirements(brief)) {
    if (ledger.some((r) => similarity(r.text, text) >= 0.5)) continue;
    if (!(await call(c, 'req_add', { text, why: oneLine(stripFlags(text), 200) })).isError) added++;
  }
  return added ? `${added} requirements added` : 'the ledger covers the brief';
}
function evidenceFor(c, req, files) {
  for (const rel of files) {
    const lines = (readText(path.join(c.cwd, rel)) || '').split('\n');
    const i = lines.findIndex((l) => new RegExp(`\\b${req.id}\\b`).test(l));
    if (i >= 0) return `${rel}:${i + 1}`;
  }
  const best = files.map((rel) => ({ rel, s: similarity(rel.replace(/[/._-]/g, ' '), req.text) })).sort((a, b) => b.s - a.s)[0];
  return best && best.s > 0 ? `${best.rel}:1` : `${files.find((f) => /README\.md$|REPORT\.md$/i.test(f)) || files[0] || 'README.md'}:1`;
}
async function qaTurn(c) {
  const reqs = reqLines(between(c.prompt, '\nREQUIREMENTS:\n', '\nDECISIONS IN FORCE:'));
  c.mem.qaReqs = reqs.length ? reqs : c.mem.qaReqs || [];
  const files = walk(c.cwd).filter((f) => /\.(m?js|md)$/.test(f));
  const checked = /CHECK BY THE HUB: passed/.test(c.prompt);
  const failId = c.flags.has('reqfail') && c.mem.qaReqs.length && claimOnce(c, 'reqfail') ? c.mem.qaReqs[c.mem.qaReqs.length - 1].id : null;
  const orphanId = !failId && c.flags.has('reqorphan') && c.mem.qaReqs.length && claimOnce(c, 'reqorphan') ? c.mem.qaReqs[c.mem.qaReqs.length - 1].id : null;
  if (orphanId) writeAtomic(orphanFile(c), JSON.stringify(orphanId));
  const results = c.mem.qaReqs.map((r) => {
    const at = evidenceFor(c, r, files);
    return r.id === failId || r.id === orphanId ? { id: r.id, ok: false, evidence: `${at} does not show a test for this requirement.` } : { id: r.id, ok: true, evidence: `${at} serves ${r.id}${checked ? ', and the check passes on this commit' : ''}.` };
  });
  const r = await call(c, 'req_verify', { results });
  if (failId) {
    const ext = files.some((f) => /\.mjs$/.test(f)) ? 'mjs' : 'js';
    const slug = `fix-${failId.toLowerCase()}`;
    await call(c, 'task_add', { title: `Repair ${failId}`, spec: `Make ${failId} hold and prove it with a test: ${c.mem.qaReqs.find((q) => q.id === failId).text}`, acceptance: [`src/${slug}/index.${ext} exports run(input).`, `test/${slug}.test.${ext} proves ${failId} and passes.`], zones: [`src/${slug}/**`, `test/${slug}.test.${ext}`], domain: 'fix', size: 'S', reqs: [failId], stream: 'qa' });
  }
  return r.isError ? `req_verify refused: ${oneLine(r.text, 120)}` : `verified ${results.filter((x) => x.ok).length} of ${results.length}`;
}
async function reportTurn(c) {
  const facts = c.mem.facts || between(c.prompt, 'FACTS FROM THE HUB (use these, not your memory):\n', 'Write the final report');
  c.mem.facts = facts;
  const title = (/^FINAL REPORT for work order (J\d+: .*?)\. The work is ready/m.exec(c.prompt) || [])[1] || 'the work order';
  const part = (name) => {
    const i = facts.indexOf(`${name}:\n`);
    return i < 0 ? '' : facts.slice(i + name.length + 2).split(/\n(?=[A-Z][A-Z ]+:\n)/)[0].trim();
  };
  const bullets = (block, max = 12) => block.split('\n').filter(Boolean).slice(0, max).map((l) => `- ${oneLine(l, 160)}`).join('\n');
  const ledger = part('LEDGER');
  const notDone = [part('CANCELLED OR FAILED TASKS'), part('CHANGED TASK CARDS'), ledger.split('\n').filter((l) => /\[(waived|failed|open)\]/.test(l)).join('\n')].filter(Boolean).join('\n');
  const md = [`# Report for ${oneLine(title, 120)}`, '', '## What was built', '', bullets(ledger) || '- See the truck.', '', '## How to run', '', 'Run `node --test` in the project folder to run every test.', '',
    '## Assumptions', '', bullets(part('ASSUMPTIONS'), 8) || '- None.', '', '## Not done', '', bullets(notDone, 8) || '- Nothing: every requirement is verified.', '',
    ...(part('OPEN OWNER QUESTIONS') ? ['## Open owner questions', '', bullets(part('OPEN OWNER QUESTIONS'), 8), '', 'The hub takes each default when the truck ships.', ''] : []),
    '## Next steps', '', '- Look at the diff in the Truck panel, then ship.', '- Add tests for the inputs that the owner uses most.', ''].join('\n');
  const r = await call(c, 'job_report', { md });
  return r.isError ? 'report refused' : 'report written';
}
async function changeTurn(c) {
  const text = (/^"(.*)"$/m.exec(c.prompt) || [])[1] || 'the change the owner asked for';
  const req = (/recorded this as requirement (R\d+)/.exec(c.prompt) || [])[1] || c.turn.arg || null;
  return addTaskFor(c, req, text);
}
async function addTaskFor(c, req, text) {
  const files = walk(c.cwd);
  const ext = files.some((f) => /^src\/.*\.mjs$/.test(f)) ? 'mjs' : 'js';
  const slug = `change-${(req || 'x').toLowerCase()}`;
  const r = await call(c, 'task_add', {
    title: `Owner change${req ? ` ${req}` : ''}: ${oneLine(text, 60)}`, spec: `Do what the owner asked: ${oneLine(text, 400)} Put it in src/${slug}/index.${ext} with a test.`,
    acceptance: [`src/${slug}/index.${ext} does what the owner asked.`, `test/${slug}.test.${ext} proves it and passes.`], zones: [`src/${slug}/**`, `test/${slug}.test.${ext}`],
    domain: 'backend', size: 'S', ...(req ? { reqs: [req] } : {}), stream: 'change',
  });
  return r.isError ? `task refused: ${oneLine(r.text, 100)}` : `task added for ${req || 'the change'}`;
}
async function consultTurn(c) {
  const id = c.turn.id || Number(c.turn.arg) || null;
  if (!id) return 'no question found';
  const r = await post(c, POSTS.ansConsult(id));
  return r.isError ? `answer refused: ${oneLine(r.text, 100)}` : 'consult answered';
}
async function reviewTurn(c) {
  const id = c.turn.id;
  const card = parseCard(c.prompt) || { accept: [], zones: [], id: c.turn.task };
  const skeleton = card.zones.includes('package.json') || /^src\/(core\/|index\.)/.test(card.zones[0] || '');
  const accShort = /PASS is refused: post FIX/.test(c.prompt);
  const changed = [...c.prompt.matchAll(/^(\S+) \+\d+ -\d+$/gm)].map((m) => m[1]);
  const test = changed.find((f) => /test/.test(f)) || card.zones.find((z) => /test/.test(z) && !/[*?{]/.test(z)) || '.shop/TASK.md';
  let line;
  if (accShort) line = POSTS.fixAcc(id);
  else if (/^FLAG empty:/m.test(c.prompt)) line = POSTS.fixEmpty(id);
  else if (/^CHECK BY THE HUB: failed/m.test(c.prompt)) line = POSTS.fixCheck(id);
  else if (!c.turn.again && !c.turn.buddy && !skeleton && changed.some((f) => /\.test\.m?js$/.test(f)) && changed.some((f) => /\.m?js$/.test(f) && !/test/.test(f))
    && c.flags.has('reject') && claimOnce(c, 'reject')) line = POSTS.fixReject(id, test);
  else line = POSTS.pass(id, card.accept.length);
  await pause(600);
  let r = await post(c, line);
  if (r.isError && /E_ACC/.test(r.text)) r = await post(c, POSTS.fixAcc(id));
  c.mem.verdict = line.split(' ')[0];
  return r.isError ? `verdict refused: ${oneLine(r.text, 100)}` : `${line.split(' ')[0]} on ${c.turn.task || 'the task'}`;
}
async function manageTurn(c) {
  const answered = await answerOpen(c, { read: c.turn.nudge === 'open' });
  if (c.role === 'maker') return `${answered} items answered`;
  const events = between(c.prompt, PHRASES.manager, 'Act now with the tools.') + between(c.prompt, PHRASES.stall, 'Unblock it now');
  let acted = 0;
  if (c.turn.kind === 'manager' || c.turn.kind === 'stall' || /\b(failed|blocked)\b/.test(events)) {
    const status = (await call(c, 'status', {})).text;
    const want = (text) => [...text.matchAll(/\b(T\d+)\b[^\n]*?\b(failed|blocked)\b([^\n]*)/g)].filter((m) => m[2] === 'failed' || !/claim|owner|ask/.test(m[3])).map((m) => m[1]);
    const retries = c.mem.retries || {};
    for (const id of uniq([...want(status), ...want(events)])) {
      retries[id] = (retries[id] || 0) + 1;
      let r = { isError: true, text: '' };
      if (retries[id] <= 2) r = await call(c, 'task_retry', { id, note: 'Read .shop/CHECK.log and the FIX items first. Keep to your zones and run the check before DONE.' });
      if (r.isError) r = await splitTask(c, id);
      if (!r.isError) acted++;
    }
    c.mem.retries = retries;
  }
  return `${answered} items answered, ${acted} tasks restarted`;
}
async function splitTask(c, id) {
  const card = parseCard(readText(path.join(c.cwd, '.shop', 'tasks', `${id}.md`)) || '');
  if (!card) return { isError: true, text: 'no card' };
  const reason = `${id} failed after its retries. A new task with a fresh maker replaces it.`;
  const add = () => call(c, 'task_add', { title: oneLine(`${card.title} (new try)`, 120), spec: card.spec || card.title, acceptance: card.accept.length ? card.accept : ['The task card is met.'], zones: card.zones.length ? card.zones : ['src/**'], domain: 'fix', size: 'S', reqs: card.serves.map((s) => s.id), stream: 'retry' });
  let r = await call(c, 'task_cancel', { id, reason });
  if (!r.isError) return add();
  const added = await add();
  const newId = (/\bT\d+\b/.exec(added.text) || [])[0];
  return added.isError || !newId ? added : call(c, 'task_cancel', { id, reason, replacedBy: [newId] });
}

/** A maker work turn: task, continue, retry, wake, digest and nudges. */
async function makerTurn(c) {
  const cardText = readText(path.join(c.cwd, '.shop', 'TASK.md')) || c.prompt;
  const card = parseCard(cardText) || parseCard(c.prompt);
  const view = parseView(c.prompt);
  if (c.turn.kind === 'frozen') return `${await answerOpen(c, { peer: true })} items answered while frozen`;
  if (!card) { await answerOpen(c, { peer: true }); return 'no task card found'; }
  const id = card.id;
  const tm = loadTask(c, id);
  c.mem.task = id;
  await answerOpen(c, { peer: true, read: c.turn.nudge === 'open' });
  const zones = card.zones;
  const part = !zones.includes('package.json') && !zones.some((z) => /^src\/(core\/|index\.)/.test(z)) && !/^(scope|core)$/.test(card.title);
  const first = tm.turns === 0;
  tm.turns++;
  const done = (summary) => { saveTask(c, id, tm); return summary; };

  // A queued claim: wait until the hub grants it (the card then lists the shared file in ZONES).
  const sharedRel = (ext) => `${SHARED_FILE}.${ext}`;
  let shared = tm.state === 'claimed';
  if (tm.state === 'waitclaim') {
    const ext = zones.some((z) => z.endsWith('.mjs')) ? 'mjs' : 'js';
    const granted = zones.includes(sharedRel(ext)) || /^ok/.test((await call(c, 'claim', { paths: [sharedRel(ext)] })).text);
    if (!granted) return done('still waits for the claim');
    tm.state = 'claimed';
    shared = true;
  } else if (first && part && (c.flags.has('conflict') || c.flags.has('claim')) && (claimOnce(c, 'claim-1') || claimOnce(c, 'claim-2'))) {
    const ext = designFiles(card, c.cwd, tm).ext;
    const r = await call(c, 'claim', { paths: [sharedRel(ext)] });
    if (/^WAIT\b/.test(r.text)) { tm.state = 'waitclaim'; return done('waits for a claim'); }
    if (!r.isError) { tm.state = 'claimed'; shared = true; }
  }

  // Repairs: conflict markers, the FIX items of the reviewer or the hub, files outside the zones.
  const fixed = resolveConflicts(c);
  const fixes = view.lines.filter((m) => m.kind === 'FIX' && (!m.scope || m.scope === id)).sort((a, b) => b.id - a.id);
  const digestFix = between(c.prompt, '\nFIX ITEMS TO DO:\n', '\n\n').split('\n').filter((l) => /^\d+\. /.test(l)).join('\n');
  if (!fixes.length && digestFix) fixes.push({ id: `d-${hash(digestFix)}`, body: digestFix });
  const fix = fixes[0] && fixes[0].id !== tm.lastFix ? fixes[0] : null;
  let failing = false;
  if (fix) {
    tm.lastFix = fix.id;
    for (const item of fix.body.split(/\n|(?= \d+\. )/)) {
      if (/empty input/i.test(item)) tm.extras.push('empty');
      else if (/order/i.test(item)) tm.extras.push('order');
      else if (/name/i.test(item)) tm.extras.push('name');
      else if (/\btest\b/i.test(item) && !/check failed|CHECK\.log/i.test(item)) tm.extras.push('extra');
    }
    tm.extras = uniq(tm.extras);
    for (const p of uniq([...fix.body.matchAll(/(?:^|\s)([\w.-]+(?:\/[\w.-]+)+|[\w-]+\.\w+)(?=[\s:,.]|$)/g)].map((m) => m[1].replace(/[.,]$/, '')))) {
      if (/^\.(shop|agents)\//.test(p) || matchZone(p, zones) || !(tm.outOfZone.includes(p) || /zone|outside/i.test(fix.body))) continue;
      // The shared file is in the base: deleting it is no undo. An edit of it from an earlier session (a claim the
      // hub lost in a restart) is claimed, as the FIX says.
      if (p.startsWith(`${SHARED_FILE}.`) && !tm.outOfZone.includes(p)) {
        const r = await call(c, 'claim', { paths: [p] });
        if (/^WAIT\b/.test(r.text)) { tm.state = 'waitclaim'; return done('waits for a claim'); }
        if (!r.isError) { tm.state = 'claimed'; shared = true; }
        continue;
      }
      try { fs.rmSync(path.join(c.cwd, p), { force: true }); emit({ t: 'tool', name: 'Bash', summary: `rm ${p}` }); } catch { /* gone */ }
    }
  }
  for (const p of tm.outOfZone) { try { fs.rmSync(path.join(c.cwd, p), { force: true }); } catch { /* gone */ } }
  if (tm.outOfZone.length && tm.handins > 0) tm.outOfZone = [];

  // Forced paths that stop the first turn before the hand-in.
  const allowed = [...zones, ...(shared ? [sharedRel(designFiles(card, c.cwd, tm).ext)] : [])];
  const write = (files) => {
    for (const f of files) {
      if (!matchZone(f.path, allowed)) continue;
      fs.mkdirSync(path.dirname(path.join(c.cwd, f.path)), { recursive: true });
      fs.writeFileSync(path.join(c.cwd, f.path), f.content);
      emit({ t: 'tool', name: 'Write', summary: f.path });
      tm.wrote = uniq([...tm.wrote, f.path]);
    }
  };
  const design = designFiles(card, c.cwd, tm, { shared });
  if (first && part && !tm.stopFlag) {
    for (const flag of ['ask', 'block', 'nodone']) {
      if (!c.flags.has(flag) || !claimOnce(c, flag)) continue;
      tm.stopFlag = flag;
      write(design.files);
      if (flag === 'nodone') { say('Files written. Stopping here.'); return done('turn ended without a closing act'); }
      tm.state = flag === 'ask' ? 'asked' : 'blocked';
      const r = await post(c, flag === 'ask' ? POSTS.askMgr(id, design.slug) : POSTS.block(id, design.slug));
      return done(r.isError ? `${flag} refused` : `${flag} posted, waiting`);
    }
  }

  // Forced paths at the hand-in.
  const note = c.prompt.includes(PHRASES.noHelp) || tm.state === 'blocked' ? 'I assumed plain text output.' : tm.state === 'asked' ? 'Empty input gives an empty result.' : '';
  if (part && !tm.handFlag && tm.handins === 0) {
    if (!tm.wrote.length && c.flags.has('empty') && claimOnce(c, 'empty')) {
      tm.handFlag = 'empty';
      tm.handins++;
      const r = await post(c, POSTS.done(id, 'none', `${card.accept.length || 1}/${card.accept.length || 1}`, []));
      return done(r.isError ? 'empty DONE refused' : 'empty hand-in');
    }
    if (c.flags.has('zone') && claimOnce(c, 'zone')) {
      tm.handFlag = 'zone';
      const stray = `scratch/${id}-notes.txt`;
      fs.mkdirSync(path.join(c.cwd, 'scratch'), { recursive: true });
      fs.writeFileSync(path.join(c.cwd, stray), `Scratch notes of ${id}.\n`);
      emit({ t: 'tool', name: 'Write', summary: stray });
      tm.outOfZone = [stray];
    } else if (c.flags.has('checkfail') && design.files.some((f) => f.test && f.content.includes("import { run }")) && claimOnce(c, 'checkfail')) {
      tm.handFlag = 'checkfail';
      failing = true;
    }
  }
  const files = designFiles(card, c.cwd, tm, { shared, failing }).files;
  await pause(1200);
  write(files);
  const tests = files.filter((f) => f.test).map((f) => f.path);
  const r = tests.length ? await runTests(c.cwd, tests) : null;
  const n = card.accept.length || 1;
  const changed = uniq([...tm.wrote.filter((p) => files.some((f) => f.path === p)), ...fixed]);
  const res = await post(c, POSTS.done(id, r ? `${r.pass}/${r.tests}` : 'none', `${n}/${n}`, changed, note));
  tm.handins++;
  tm.state = res.isError ? tm.state : 'handed';
  return done(res.isError ? `DONE refused: ${oneLine(res.text, 120)}` : `handed in ${id}`);
}

async function selftestTurn(c) {
  const r = await call(c, 'selftest_ping', {});
  say('The mock lab runs no shell commands, so it skips the containment checks.');
  return r.isError ? 'selftest_ping failed' : 'OK';
}

const BOSS_REDO = { plan: planTurn, merge: mergeTurn, qa: qaTurn, report: reportTurn, audit: auditTurn, change: changeTurn };
async function nudgeTurn(c) {
  const n = c.turn.nudge;
  const was = c.mem.kind;
  if (n === 'review') { c.turn = { ...c.turn, kind: 'review', id: Number(c.turn.arg), task: c.mem.task, again: true }; return reviewTurn(c); }
  if (n === 'consult') { c.turn = { kind: 'consult', id: Number(c.turn.arg) }; return consultTurn(c); }
  if (n === 'qa_task') {
    // [mock:reqorphan]: the orphan stays without a task, so the hub asks the owner.
    const orphan = c.flags.has('reqorphan') ? readJson(orphanFile(c)) : null;
    const ids = c.turn.arg.split(/[ ,]+/).filter((id) => id && id !== orphan);
    for (const id of ids) await addTaskFor(c, id, (c.mem.qaReqs || []).find((r) => r.id === id)?.text || `Make ${id} hold`);
    return ids.length ? 'tasks added' : 'no task added';
  }
  if (n === 'req') return addTaskFor(c, c.turn.arg, `Serve ${c.turn.arg}`);
  if (BOSS_REDO[n]) return BOSS_REDO[n](c);
  if (c.role === 'maker' && n !== 'open') return makerTurn(c);
  if ((n === 'restart' || n === 'timeout') && BOSS_REDO[was]) return BOSS_REDO[was](c);
  if (was === 'review' && (n === 'restart' || n === 'timeout')) return reviewTurn({ ...c, turn: { ...c.mem.turn } });
  return manageTurn(c);
}

function route(c) {
  const k = c.turn.kind;
  const table = { selftest: selftestTurn, plan: planTurn, merge: mergeTurn, checkfail: checkFailTurn, audit: auditTurn, qa: qaTurn, report: reportTurn, change: changeTurn, consult: consultTurn, review: reviewTurn, nudge: nudgeTurn, manager: manageTurn, stall: manageTurn };
  if (table[k]) return table[k];
  if (c.role === 'maker') return makerTurn;
  return manageTurn; // wake, digest, frozen or unknown for a boss or a manager: answer the open items
}

// ------------------------------------------------------------------ main

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    const chunks = [];
    process.stdin.on('data', (d) => chunks.push(d));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
}
function fatal(kind, message, sessionId) {
  emit({ t: 'error', kind, message: oneLine(message, 300), resetAt: null });
  emit({ t: 'result', ok: false, text: '', sessionId: sessionId || null, usd: null, turns: 0, durationMs: 0 });
  process.stderr.write(`mock-agent: ${oneLine(message, 300)}\n`);
  process.exitCode = 1;
}

export async function main() {
  const t0 = Date.now();
  const s = Number(ENV.MOCK_SPEED ?? 1);
  speed = Number.isFinite(s) && s >= 0 ? Math.min(s, 20) : 1;
  const prompt = await readStdin();
  const sid = ENV.MOCK_SESSION || crypto.randomUUID();
  if (!prompt.trim()) return fatal('other', 'no prompt on stdin', sid);
  if (!ENV.SHOP_MCP_URL || !ENV.SHOP_TOKEN) return fatal('mcp', 'SHOP_MCP_URL and SHOP_TOKEN are not set', sid);
  const cwd = process.cwd();
  const memFile = sessionFile(sid);
  const mem = { turns: 0, ...(readJson(memFile) || {}) };
  const turn = detectTurn(prompt);
  const role = ENV.MOCK_ROLE || mem.role || 'maker';
  const c = { prompt, turn, role, handle: ENV.MOCK_HANDLE || '', sid, mem, cwd, jobDir: jobDirFor(cwd, prompt), flags: new Set(), calls: [], outChars: 0, client: createClient(ENV.SHOP_MCP_URL, ENV.SHOP_TOKEN) };
  const bp = readText(path.join(cwd, '.shop', 'BLUEPRINT.md')) || '';
  for (const f of [...flagsIn(prompt), ...flagsIn(bp), ...(readJson(path.join(c.jobDir, 'flags.json')) || [])]) if (FLAGS.includes(f)) c.flags.add(f);
  slow = c.flags.has('slow');
  try { await c.client.init(); } catch (err) {
    emit({ t: 'init', sessionId: sid, model: 'mock', mcpOk: false, loaded: [] });
    return fatal('mcp', `cannot reach the hub tools: ${err.message}`, sid);
  }
  emit({ t: 'init', sessionId: sid, model: 'mock', mcpOk: true, loaded: ['shop'] });
  await pause(1200);
  say(`Turn: ${turn.kind}${turn.nudge ? ` (${turn.nudge})` : ''}${mem.turns ? `, resumed session turn ${mem.turns + 1}` : ''}.`);
  let summary;
  try { summary = await route(c)(c); } catch (err) {
    saveMem(memFile, mem, role, turn);
    return fatal('other', `mock agent failed: ${err.stack || err.message}`, sid);
  }
  say(summary);
  saveMem(memFile, mem, role, turn);
  const inTok = Math.ceil(prompt.length / 4) + 900;
  const outTok = Math.ceil(c.outChars / 4) + 60;
  mem.ctx = (mem.ctx || 0) + inTok;
  emit({ t: 'usage', inTok, outTok, cacheRead: 0, cacheWrite: 0, usd: 0 });
  emit({ t: 'ctx', tokens: mem.ctx, max: 200000 });
  saveMem(memFile, mem, role, turn, false);
  emit({ t: 'result', ok: true, text: summary, sessionId: sid, usd: 0, turns: mem.turns, durationMs: Date.now() - t0 });
}
function saveMem(file, mem, role, turn, count = true) {
  if (count && !mem._counted) { mem.turns += 1; mem._counted = true; }
  mem.role = role;
  if (turn.kind !== 'nudge' && turn.kind !== 'unknown') { mem.kind = turn.kind; mem.turn = turn; }
  try { writeAtomic(file, JSON.stringify({ ...mem, _counted: undefined })); } catch { /* memory is best effort */ }
}

function stopAll(code) {
  for (const child of running) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  process.exit(code);
}
const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.on('SIGTERM', () => stopAll(143));
  process.on('SIGINT', () => stopAll(130));
  main().catch((err) => fatal('other', err.message));
}
