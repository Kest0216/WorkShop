#!/usr/bin/env node
// WorkShop STUB hub for the launcher tests. Zero dependencies (Node 20, ESM).
// It speaks the launcher side of the contract (docs/ARCHITECTURE.md sections 3b and 6):
//
//   start    node <base>/server/index.js          no arguments, working folder <base>
//   stdout   WORKSHOP_READY http://127.0.0.1:<port>/#k=<ownerKey>      once it listens and holds the lock
//   lock     <base>/data/run/hub.lock { pid, port }. A second hub exits with a message when that pid is alive.
//   stdin    when it is a pipe: end-of-file = the launcher is gone -> clean shutdown
//   guards   Host must be 127.0.0.1:<port> or localhost:<port>; Origin (if present) must match;
//            every non-GET needs "X-WorkShop: 1" and a JSON body
//   session  POST /api/session { k } -> Set-Cookie workshop_owner_<port>=<token>; HttpOnly; SameSite=Strict; Path=/
//            every other /api route answers 401 without that cookie
//   routes   GET /api/state, GET /api/events (SSE, no "event:" field), POST /api/jobs/:id/pause { hard? }
//   log      data/logs/stub-requests.log, one line per request, the key and the session token redacted
//
// Test hooks (environment; the launcher passes WORKSHOP_STUB_* through):
//   WORKSHOP_STUB_KEY=<key>        use this owner key (the test then knows what to search for)
//   WORKSHOP_STUB_LIVE=1           job J1 starts in status "running"
//   WORKSHOP_STUB_PAUSE_FAIL=1     the pause route answers 500
//   WORKSHOP_STUB_SPAWN_KIDS=1     start three children (same group, own session, grandchild)
//   WORKSHOP_STUB_STUBBORN=1       ignore stdin end-of-file and SIGTERM
//   WORKSHOP_STUB_FAIL=boot        print errors on stderr (with the key in them) and exit 1 before READY
//   WORKSHOP_STUB_NO_READY=1       listen, but never print the READY line
//   WORKSHOP_STUB_LEAK=1           print the owner key on stderr at boot (redaction test)
//   WORKSHOP_STUB_SLOW_EXIT_MS=N   wait N ms before exiting on a clean shutdown
//   WORKSHOP_STUB_CRASH_AT_BOOT=1  start the test children, then die before READY (no shutdown handler)
// Test routes (behind the owner cookie): POST /api/stub/job { live }, /api/stub/crash, /api/stub/flood { mb, lineBytes },
//   GET /api/stub/env. Without a cookie: GET /stub-redirect-away (302 to another site).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.resolve(HERE, '..');
const UI = path.join(BASE, 'ui');
const DATA = path.join(BASE, 'data');
const RUN = path.join(DATA, 'run');
const LOGS = path.join(DATA, 'logs');
const LOCK = path.join(RUN, 'hub.lock');
const REQLOG = path.join(LOGS, 'stub-requests.log');
const HOST = '127.0.0.1';
const E = process.env;
const STUBBORN = E.WORKSHOP_STUB_STUBBORN === '1';

const ownerKey = /^[A-Za-z0-9_-]{16,}$/.test(E.WORKSHOP_STUB_KEY || '') ? E.WORKSHOP_STUB_KEY : crypto.randomBytes(32).toString('hex');
const sessionToken = crypto.randomBytes(32).toString('hex');
let port = 0;
let seq = 1000;
const jobs = { J1: { id: 'J1', title: 'Stub job', status: E.WORKSHOP_STUB_LIVE === '1' ? 'running' : 'done', prevStatus: null, pauseReason: null } };

for (const dir of [DATA, RUN, LOGS]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

const redact = (text) => String(text).split(ownerKey).join('[key]').split(sessionToken).join('[token]')
  .replace(/([#?&]k=)[^\s&"']+/g, '$1[redacted]').replace(/("k"\s*:\s*")[^"]*"/g, '$1[redacted]"');
function log(msg) {
  try { fs.appendFileSync(REQLOG, `${new Date().toISOString()} pid=${process.pid} ${redact(msg)}\n`, { mode: 0o600 }); } catch { /* the log must never stop the stub */ }
}
process.stdout.on('error', () => {});   // launcher gone: ignore EPIPE, the stdin watchdog handles the exit
process.stderr.on('error', () => {});

// ---------------------------------------------------------------- one hub per data folder
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readLock = () => { try { return JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch { return null; } };
{
  const other = readLock();
  if (other && Number.isInteger(other.pid) && other.pid !== process.pid && pidAlive(other.pid)) {
    log(`SECOND-HUB refused: the lock names live pid ${other.pid}`);
    process.stderr.write(`WorkShop hub: another hub (pid ${other.pid}, port ${other.port}) already runs on this data folder. This one exits.\n`);
    process.exit(1);
  }
}
if (E.WORKSHOP_STUB_FAIL === 'boot') {
  log('FAIL-AT-BOOT (test hook)');
  process.stderr.write('stub hub: reading settings\n');
  process.stderr.write(`stub hub: debug dump k=${ownerKey} token sk-ant-FAKEFAKEFAKEFAKEFAKE1234\n`);
  process.stderr.write(`stub hub: the owner key is ${ownerKey}\n`);
  process.stderr.write('stub hub: fatal: cannot open config/models.json (test hook)\n');
  process.exit(1);
}

// ---------------------------------------------------------------- helpers
function findOnPath(name) {
  for (const dir of String(E.PATH || '').split(':')) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}
const stdinIsPipe = (() => { try { const st = fs.fstatSync(0); return st.isFIFO() || st.isSocket(); } catch { return false; } })();
function envReport() {
  return {
    node: process.version, execPath: process.execPath, cwd: process.cwd(), argv: process.argv.slice(2), ppid: process.ppid,
    stdinIsPipe, path: E.PATH || '', workshopPath: E.WORKSHOP_PATH ?? null, launcherPid: E.WORKSHOP_LAUNCHER_PID ?? null,
    found: { git: findOnPath('git'), node: findOnPath('node'), claude: findOnPath('claude') },
    envNames: Object.keys(E).sort(),                    // names only, never values
  };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "frame-ancestors 'none'", 'Cache-Control': 'no-store' };
function send(res, status, type, body, extra) {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': type, ...(extra || {}) });
  res.end(body);
}
const json = (res, status, obj, extra) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj), extra);

function hasSession(req) {
  const want = Buffer.from(sessionToken);
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0 || part.slice(0, i).trim() !== `workshop_owner_${port}`) continue;
    const got = Buffer.from(part.slice(i + 1).trim());
    if (got.length === want.length && crypto.timingSafeEqual(got, want)) return true;
  }
  return false;
}
function guard(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return 'forbidden: bad Host header';
  const { origin } = req.headers;
  if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return 'forbidden: bad Origin header';
  if (req.method !== 'GET' && req.method !== 'HEAD' && String(req.headers['x-workshop'] || '').trim() !== '1') return 'forbidden: header X-WorkShop: 1 is required';
  return null;
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 2 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try { const v = JSON.parse(text); if (v === null || typeof v !== 'object') throw new Error('not an object'); resolve(v); } catch { reject(new Error('the body must be a JSON object or array')); }
    });
    req.on('error', reject);
  });
}

/** Writes about `mb` megabytes of lines of `lineBytes` bytes to a stream, waiting for 'drain' as needed. */
async function flood(stream, mb, lineBytes, tag) {
  const line = (`stub hub flood ${tag} `.padEnd(lineBytes - 1, 'x')).slice(0, lineBytes - 1) + '\n';
  let left = Math.round(mb * 1024 * 1024);
  while (left > 0) {
    const chunk = line.repeat(Math.max(1, Math.floor(65536 / lineBytes)));
    left -= chunk.length;
    if (!stream.write(chunk)) await new Promise((r) => stream.once('drain', r));
  }
}

// ---------------------------------------------------------------- http
const sse = new Map();
let sseSeq = 0;
function broadcast(event) {
  seq += 1;
  const frame = `id: ${seq}\ndata: ${JSON.stringify({ seq, ...event })}\n\n`;
  for (const c of sse.values()) { c.sent += 1; c.res.write(frame); }
}

async function handle(req, res) {
  const u = new URL(req.url, `http://${HOST}`);
  const ua = String(req.headers['user-agent'] || '').slice(0, 60);
  res.on('finish', () => {
    if (u.pathname !== '/api/events') log(`REQ ${req.method} ${req.url} -> ${res.statusCode} cookie=${hasSession(req) ? 'yes' : 'no'} xws=${req.headers['x-workshop'] || '-'} origin=${req.headers.origin || '-'} ua="${ua}"`);
  });
  const refused = guard(req);
  if (refused) return json(res, 403, { error: refused });

  if (u.pathname.startsWith('/api/')) {
    let body = {};
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      try { body = await readJson(req); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && u.pathname === '/api/session') {                  // the only open /api route
      const a = Buffer.from(String(body.k ?? '')), b = Buffer.from(ownerKey);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return json(res, 401, { error: 'wrong owner key' });
      log('SESSION opened');
      return json(res, 200, { ok: true }, { 'Set-Cookie': `workshop_owner_${port}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/` });
    }
    if (!hasSession(req)) return json(res, 401, { error: 'no owner session' });

    if (req.method === 'GET' && u.pathname === '/api/state') {
      return json(res, 200, { seq, state: { projects: {}, jobs, tasks: {}, agents: {}, deliveries: {} }, providers: [], settings: {}, board: [], models: {}, inbox: [] });
    }
    if (req.method === 'GET' && u.pathname === '/api/events') {
      res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      const c = { id: ++sseSeq, t0: Date.now(), sent: 0, res };
      sse.set(c.id, c);
      log(`SSE open id=${c.id} since=${u.searchParams.get('since') ?? '-'} ua="${ua}"`);
      res.on('close', () => { sse.delete(c.id); log(`SSE close id=${c.id} open_ms=${Date.now() - c.t0} sent=${c.sent}`); });
      return undefined;
    }
    const pause = /^\/api\/jobs\/([^/]+)\/(pause|resume)$/.exec(u.pathname);
    if (req.method === 'POST' && pause) {
      const job = jobs[decodeURIComponent(pause[1])];
      if (!job) return json(res, 404, { error: 'no such job' });
      if (pause[2] === 'pause') {
        log(`PAUSE ${job.id} body=${JSON.stringify(body)} status-before=${job.status}`);
        if (E.WORKSHOP_STUB_PAUSE_FAIL === '1') return json(res, 500, { error: 'stub: the pause was refused (test hook)' });
        if (job.status !== 'paused') { job.prevStatus = job.status; job.status = 'paused'; job.pauseReason = 'owner'; }
      } else if (job.status === 'paused') { job.status = job.prevStatus || 'running'; job.prevStatus = null; job.pauseReason = null; }
      fs.writeFileSync(path.join(RUN, 'jobs.json'), JSON.stringify(jobs));          // the tests read this after the hub is gone
      broadcast({ type: 'jobs', item: job });
      return json(res, 200, job);
    }
    if (req.method === 'POST' && u.pathname === '/api/stub/job') {                 // test control: make J1 live or done
      jobs.J1.status = body.live ? 'running' : 'done';
      jobs.J1.pauseReason = null;
      broadcast({ type: 'jobs', item: jobs.J1 });
      return json(res, 200, jobs.J1);
    }
    if (req.method === 'GET' && u.pathname === '/api/stub/env') return json(res, 200, envReport());
    if (req.method === 'POST' && u.pathname === '/api/stub/crash') {               // test control: die with a noisy stderr
      json(res, 200, { ok: true });
      setTimeout(() => {
        process.stderr.write('stub hub: something went wrong in the orchestrator\n');
        process.stderr.write(`stub hub: request url was http://127.0.0.1:${port}/#k=${ownerKey}\n`);
        process.stderr.write(`stub hub: leaked value ${ownerKey} and cookie workshop_owner_${port}=${sessionToken}\n`);
        process.stderr.write('stub hub: fatal: TypeError: cannot read properties of undefined (test hook)\n');
        log('CRASH (test hook)');
        process.exit(7);
      }, 50);
      return undefined;
    }
    if (req.method === 'POST' && u.pathname === '/api/stub/flood') {               // test control: N MB on stdout and stderr
      const mb = Math.min(Math.max(Number(body.mb) || 1, 0.1), 50);
      const lineBytes = Math.min(Math.max(Number(body.lineBytes) || 100, 2), 8 * 1024 * 1024);
      const t0 = Date.now();
      Promise.all([flood(process.stdout, mb, lineBytes, 'out'), flood(process.stderr, mb, lineBytes, 'err')])
        .then(() => log(`FLOOD done mb=${mb} lineBytes=${lineBytes} ms=${Date.now() - t0}`));
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && u.pathname === '/api/beacon') {
      log('BEACON ' + JSON.stringify(body).slice(0, 3000));
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && u.pathname === '/api/download-sample') {
      return send(res, 200, 'text/plain; charset=utf-8', 'hello from the WorkShop stub download\n', { 'Content-Disposition': 'attachment; filename="workshop-sample.txt"' });
    }
    return json(res, 404, { error: 'not found' });
  }

  // test control: a hub page that redirects away from the hub (the launcher must not follow it in the window)
  if (u.pathname === '/stub-redirect-away') return send(res, 302, 'text/plain', 'moved', { Location: 'https://example.com/redirected-from-hub' });

  // static files from ui/ (no cookie needed), path traversal refused
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
  const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname).replace(/^\/+/, '');
  const file = path.resolve(UI, rel);
  if (file !== UI && !file.startsWith(UI + path.sep)) return json(res, 403, { error: 'forbidden' });
  let data;
  try { data = fs.readFileSync(file); } catch { return json(res, 404, { error: 'not found' }); }
  return send(res, 200, TYPES[path.extname(file)] || 'application/octet-stream', data);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => { log('HANDLER-ERROR ' + (e && e.stack || e)); try { json(res, 500, { error: 'stub error' }); } catch { res.destroy(); } });
});

// ---------------------------------------------------------------- shutdown
let shuttingDown = false;
const kids = [];
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`SHUTDOWN reason=${reason} sse_open=${sse.size} jobs=${JSON.stringify(Object.values(jobs).map((j) => `${j.id}:${j.status}`))}`);
  for (const k of kids) { try { process.kill(k.detached ? -k.pid : k.pid, 'SIGTERM'); } catch { /* already gone */ } }
  // Also the hub's own process group (the launcher makes the hub its leader): this reaches grandchildren
  // whose parent died first. When the hub is not a group leader (started by hand) this throws ESRCH.
  try { process.kill(-process.pid, 'SIGTERM'); } catch { /* not a group leader */ }
  const lock = readLock();
  if (lock && lock.pid === process.pid) { try { fs.unlinkSync(LOCK); } catch { /* fine */ } }
  const finish = () => { log('EXIT code=0'); process.exit(0); };
  const wait = parseInt(E.WORKSHOP_STUB_SLOW_EXIT_MS || '0', 10) || 0;
  if (wait > 0) setTimeout(finish, wait); else finish();
}
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(s, () => { if (STUBBORN) log('STUBBORN: ignoring ' + s); else shutdown(s); });
}
process.on('uncaughtException', (e) => { log('UNCAUGHT ' + (e && e.stack || e)); process.stderr.write(`stub hub: ${e && e.message}\n`); process.exit(1); });

function watchLauncher() {
  if (!stdinIsPipe) return log('WATCHDOG off: stdin is not a pipe (started by hand)');
  if (STUBBORN) return log('WATCHDOG off (STUBBORN test hook)');
  const gone = (how) => shutdown(`stdin-${how} (launcher gone)`);
  process.stdin.on('end', () => gone('eof'));
  process.stdin.on('close', () => gone('close'));
  process.stdin.on('error', () => gone('error'));
  process.stdin.resume();
  return log('WATCHDOG on: stdin is a pipe held by the launcher');
}

// The odd durations (6000.731 s ...) make the test children unique on this Mac: the tests look for
// "sleep 600[0-2].731", so an unrelated "sleep 600" of another program never counts as a leftover.
function spawnTestKids() {
  const a = spawn('/bin/sleep', ['6000.731'], { stdio: 'ignore' });                  // same process group as the hub
  const b = spawn('/bin/sleep', ['6001.731'], { stdio: 'ignore', detached: true });  // own session and group, like an agent
  const c = spawn('/bin/sh', ['-c', 'sleep 6002.731 & wait'], { stdio: 'ignore' });  // a child that has its own child
  kids.push({ pid: a.pid, detached: false }, { pid: b.pid, detached: true }, { pid: c.pid, detached: false });
  fs.writeFileSync(path.join(RUN, 'kids.json'), JSON.stringify(kids));
  log('KIDS ' + JSON.stringify(kids));
}

// ---------------------------------------------------------------- start
server.on('error', (e) => { process.stderr.write(`stub hub: cannot listen: ${e.message}\n`); process.exit(1); });
server.listen(0, HOST, () => {
  port = server.address().port;
  const tmp = `${LOCK}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, port }) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, LOCK);
  const er = envReport();
  log(`START port=${port} node=${er.node} cwd=${er.cwd} argv=${JSON.stringify(er.argv)} ppid=${er.ppid} stdinIsPipe=${er.stdinIsPipe} launcherPid=${er.launcherPid}`);
  log(`ENV PATH=${er.path}`);
  log(`ENV WORKSHOP_PATH=${er.workshopPath}`);
  log(`ENV found=${JSON.stringify(er.found)} names=${er.envNames.join(',')}`);
  watchLauncher();
  if (E.WORKSHOP_STUB_SPAWN_KIDS === '1' || E.WORKSHOP_STUB_CRASH_AT_BOOT === '1') spawnTestKids();
  process.stderr.write(`stub hub: listening on ${HOST}:${port}\n`);
  if (E.WORKSHOP_STUB_CRASH_AT_BOOT === '1') {
    log('CRASH-AT-BOOT (test hook): children started, dying before READY');
    setTimeout(() => { process.stderr.write('stub hub: fatal: crashed during boot (test hook)\n'); process.exit(9); }, 500);
    return undefined;
  }
  if (E.WORKSHOP_STUB_LEAK === '1') process.stderr.write(`stub hub: debug: the owner key is ${ownerKey} (test hook)\n`);
  if (E.WORKSHOP_STUB_NO_READY === '1') return log('NO-READY (test hook): the READY line is withheld');
  process.stdout.write(`WORKSHOP_READY http://${HOST}:${port}/#k=${ownerKey}\n`);
  setInterval(() => broadcast({ type: 'tick', live: jobs.J1.status === 'running' }), 1000);
  setInterval(() => { for (const c of sse.values()) c.res.write(': hb\n\n'); }, 15000);
  return undefined;
});
