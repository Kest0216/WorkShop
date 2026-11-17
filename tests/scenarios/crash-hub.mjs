// A hub that kills itself with SIGKILL at one exact point (tests/scenarios/restart-and-holds.test.mjs).
// It is the real entry point (server/index.js main) with the mock lab only, plus one crash trigger from the
// environment variable WS_CRASH (JSON). No graceful stop runs: no store flush, no turn stop, no lock release.
// The agent processes it started stay alive as orphans, as after a real crash of the app.
//
//   WS_CRASH = { point:'turn',  kind:'work', nth?:1, promptHas?:'regex', count?:n, afterMs?:0 }
//                 kill afterMs after the nth turn of that kind started (count: when n turns of it run at once)
//                 spawned:n waits first until n agent processes run (a turn start is not yet a process)
//            | { point:'post',  kind:'PASS', from?:'@hub', nth?:1, afterMs?:0 }   board post (after the hub handled it)
//            | { point:'store', kind:'tasks', match:{ status:'review' }, nth?:1, afterMs?:0 }   an upsert in memory
//            | { point:'git',   fn:'integrate', when:'before'|'after', nth?:1, afterMs?:0 }
//                 before: start the real call and kill afterMs later (mid-call); after: kill when it returned
//   WS_TURNS = file: one JSON line per turn start (agent, kind, task, prompt head) for the test to read.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { main } from '../../server/index.js';

const spec = JSON.parse(process.env.WS_CRASH || '{}');
const turnsFile = process.env.WS_TURNS || null;
let fired = false;
// The .crash file records the agent processes that run at the kill (agents: a count). An orphan can end soon
// after (its next write to the dead hub fails), so the test reads this count, not a later process list.
const kill = () => {
  try { fs.writeFileSync(`${turnsFile ?? '/dev/null'}.crash`, JSON.stringify({ at: Date.now(), spec, agents: agentProcs() })); } catch { /* best effort */ }
  process.kill(process.pid, 'SIGKILL');
};
const fire = (ms = spec.afterMs ?? 0) => {
  if (fired) return;
  fired = true;
  if (ms > 0) setTimeout(kill, ms); else kill();
};
const counter = () => {
  let n = 0;
  return () => ++n === (spec.nth ?? 1);
};
/** Agent processes (the mock agent) that this hub started and that still run. */
const agentProcs = () => {
  try {
    return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n')
      .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter((m) => m && Number(m[2]) === process.pid && /mock-agent/.test(m[3])).length;
  } catch { return 0; }
};
/**
 * spawned: n (true = 1): the trigger waits until n agent processes run, then fires afterMs later. A turn start
 * is not yet a process: on a loaded machine the spawn can take longer than afterMs.
 */
let waiting = false;
const fireWhenSpawned = () => {
  if (waiting) return;
  waiting = true;
  const need = spec.spawned === true ? 1 : Number(spec.spawned);
  const timer = setInterval(() => { if (agentProcs() >= need) { clearInterval(timer); fire(); } }, 25);
};

const app = await main(process.argv.slice(2), process.env, {
  tickMs: 150,
  runnerTuning: { minSpawnGapMs: 50 },
  orchTuning: { managerDebounceMs: 300, managerMaxDelayMs: 1500 },
  power: { hold() {}, release() {} }, pickFolder: async () => null, reveal: async () => {},
});

// Every turn start goes to WS_TURNS; the 'turn' trigger counts them.
const run = app.runner.run;
const hit = counter();
let live = 0;
app.runner.run = async (agentId, o) => {
  const a = app.store.get('agents', agentId);
  if (turnsFile) {
    try { fs.appendFileSync(turnsFile, `${JSON.stringify({ hub: 1, agentId, handle: a?.handle, kind: o.kind, taskId: o.taskId ?? null, resume: o.resume === true, head: String(o.prompt ?? '').slice(0, 300), at: Date.now() })}\n`); } catch { /* best effort */ }
  }
  const mine = spec.point === 'turn' && o.kind === spec.kind && (!spec.promptHas || new RegExp(spec.promptHas).test(String(o.prompt ?? '')));
  if (mine) {
    live++;
    if (spec.count ? live >= spec.count : hit()) {
      if (spec.spawned && !fired) fireWhenSpawned();
      else fire();
    }
  }
  try {
    return await run.call(app.runner, agentId, o);
  } finally {
    if (mine) live--;
  }
};

if (spec.point === 'post') {
  const n = counter();
  app.board.on((e) => {
    if (e.type === 'post' && e.msg?.kind === spec.kind && (!spec.from || e.msg.from === spec.from) && (!spec.notFrom || e.msg.from !== spec.notFrom) && n()) fire();
  });
}

if (spec.point === 'store') {
  const n = counter();
  const at = (item, key) => key.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), item);
  const match = (item) => Object.entries(spec.match ?? {}).every(([k, v]) => (v === '*' ? at(item, k) !== null && at(item, k) !== undefined : JSON.stringify(at(item, k)) === JSON.stringify(v)));
  app.store.subscribe((e) => {
    if (e.type === 'upsert' && e.kind === spec.kind && match(e.item) && n()) fire();
  });
}

if (spec.point === 'git') {
  const real = app.git[spec.fn];
  const n = counter();
  app.git[spec.fn] = async (...args) => {
    const mine = n();
    if (mine && spec.when !== 'after') fire();
    const r = await real.apply(app.git, args);
    if (mine && spec.when === 'after') fire();
    return r;
  };
}
