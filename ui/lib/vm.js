// Scene view model, built from the store exactly per contract section 13.
//
// vm = {
//   shop:   { jobTitle, paused, statusLine },
//   agents: [{ id, name, role, provider, model, style:{seed}, spot, activity, task:{id,title,domain,progress}|null, bubble:{text,kind,seq}|null }],
//   deliveries: [{ id, taskId, domain, makerId, reviewerId, buddyId, stage }],
//   truck:  { state, crates },   board: { unread },   owner: { attention }
// }

import { sel } from './selectors.js';

const ACTIVITY = { working: 'work', thinking: 'think', waiting: 'wait', reviewing: 'review', blocked: 'blocked', idle: 'idle', off: 'off' };
// agent.bubble.kind is already a scene kind. A board kind maps per contract section 12:
// ASK, BLOCK -> ask; DONE, PASS -> done; FIX, FAIL, NO -> warn; everything else -> info.
const BUBBLE_KIND = { ask: 'ask', info: 'info', done: 'done', warn: 'warn', ASK: 'ask', BLOCK: 'ask', DONE: 'done', PASS: 'done', FIX: 'warn', FAIL: 'warn', NO: 'warn' };
const ROLES = new Set(['boss', 'manager', 'maker']);
const num = (id) => Number(String(id).replace(/^\D+/, '')) || 0;

/** Board kind (ASK, DONE, FIX, ...) or bubble kind -> scene bubble kind (ask | info | done | warn). */
export function bubbleKind(kind) { return BUBBLE_KIND[kind] || 'info'; }

function statusLine(store, job) {
  if (!job) return 'No work order yet';
  const c = sel.taskCounts(store, job.id);
  const loaded = sel.loadedDeliveries(store, job.id).length;
  switch (job.status) {
    case 'queued': { const w = sel.waitsFor(store, job); return w ? `Queued: waits for ${w.id}` : job.waitReason ? `Queued: ${String(job.waitReason)}` : 'Queued'; }
    case 'planning': return 'Planning: the bosses draft the plan';
    case 'plan_review': return 'Plan ready: waiting for your approval';
    case 'running': return `Running: ${c.merged}/${c.total} tasks merged`;
    case 'qa': { const r = job.requirements || []; return `QA: ${r.filter((x) => x.status === 'verified').length}/${r.length} requirements verified`; }
    case 'delivering': return `Truck ready: ${loaded} crate${loaded === 1 ? '' : 's'} wait for you`;
    case 'done': return 'Done';
    case 'paused': return `Paused: ${sel.pauseWords(job)}`; // a paused job shows the pause reason
    case 'cancelled': return 'Cancelled';
    default: return String(job.status || '');
  }
}

/**
 * Delivery -> scene stage, or null when the scene should not show it.
 * A crate the owner discarded (truck/discard of a cancelled job) is gone from the floor, and so is a rejected crate of a job
 * that is over: no maker will work on it again.
 */
export function deliveryStage(store, d) {
  if (d.discarded) return null;
  switch (d.status) {
    case 'checking': return 'to_office';
    case 'buddy': return 'buddy_check'; // the buddy visits the maker's bench
    case 'review': {
      const r = d.reviewerId ? store.get('agents', d.reviewerId) : null;
      return r && r.status === 'reviewing' && (!r.taskId || r.taskId === d.taskId) ? 'in_review' : 'to_office';
    }
    case 'rejected': { // shown until the maker works again
      const job = d.jobId ? store.get('jobs', d.jobId) : null;
      if (job && (job.status === 'done' || job.status === 'cancelled')) return null;
      const m = d.makerId ? store.get('agents', d.makerId) : null;
      const again = m && m.taskId === d.taskId && (m.status === 'working' || m.status === 'thinking');
      return again ? null : 'rejected';
    }
    case 'approved': return 'to_truck';
    case 'loaded': return 'on_truck';
    case 'shipped': return 'shipped';
    default: return null;
  }
}

/**
 * buildVM(store, { truckPhase, shipCrates, attention }) -> vm
 *   truckPhase  null, or 'leaving' | 'away' | 'returning' while the ship sequence plays
 *   shipCrates  crates on the truck while it leaves
 *   attention   true when something waits for the owner
 */
export function buildVM(store, { truckPhase = null, shipCrates = 0, attention = false } = {}) {
  const job = sel.activeJob(store);
  const vm = {
    shop: { jobTitle: job ? String(job.title || '') : '', paused: !!job && job.status === 'paused', statusLine: statusLine(store, job) },
    agents: [], deliveries: [],
    truck: { state: 'docked', crates: 0 },
    board: { unread: sel.unreadBoard(store) },
    owner: { attention: !!attention },
  };
  if (!job) { if (truckPhase) vm.truck.state = truckPhase; return vm; }

  for (const a of sel.agentsOf(store, job.id)) {
    if (!ROLES.has(a.role)) continue;
    const t = a.taskId ? store.get('tasks', a.taskId) : null;
    const b = a.bubble && a.bubble.text ? { text: String(a.bubble.text), kind: bubbleKind(a.bubble.kind), seq: Number(a.bubble.seq) || 0 } : null;
    vm.agents.push({
      id: a.id, name: String(a.name || a.id), role: a.role, provider: a.provider, model: a.model,
      harnessId: a.harnessId || null, certification: a.certification || null,
      style: { seed: a.style && Number.isFinite(Number(a.style.seed)) ? Number(a.style.seed) : 0 }, spot: Number(a.spot) || 0,
      activity: ACTIVITY[a.status] || 'idle',
      task: t ? { id: t.id, title: String(t.title || ''), domain: t.domain, progress: Math.max(0, Math.min(1, Number(t.progress) || 0)) } : null,
      bubble: b,
    });
  }

  // One delivery per task: the newest attempt.
  const newest = new Map();
  for (const d of sel.deliveriesOf(store, job.id)) {
    const cur = newest.get(d.taskId);
    if (!cur || (d.attempt || 0) > (cur.attempt || 0) || ((d.attempt || 0) === (cur.attempt || 0) && num(d.id) > num(cur.id))) newest.set(d.taskId, d);
  }
  let loaded = 0;
  for (const d of newest.values()) {
    const stage = deliveryStage(store, d);
    if (!stage) continue;
    if (stage === 'on_truck') loaded++;
    const t = store.get('tasks', d.taskId);
    vm.deliveries.push({ id: d.id, taskId: d.taskId, domain: t ? t.domain : null, makerId: d.makerId || null, reviewerId: d.reviewerId || null,
      buddyId: (t && t.buddyId) || (d.buddy && d.buddy.by) || null, stage });
  }
  vm.deliveries.sort((a, b) => num(a.id) - num(b.id));

  // Truck (section 13): docked with crates while the job runs (no beacon); ready (beacon) when the job is in "delivering".
  if (truckPhase) vm.truck = { state: truckPhase, crates: truckPhase === 'leaving' || truckPhase === 'away' ? shipCrates : 0 };
  else vm.truck = { state: loaded > 0 && job.status === 'delivering' ? 'ready' : 'docked', crates: loaded };
  return vm;
}

/**
 * How many crates one ship took: the deliveries of the job that turned from loaded to shipped (fx ship carries only { jobId, sha }).
 * createShipCounter() -> { seen(prev, item), take(jobId) -> n }
 *   seen  feed every delivery upsert (prev = the row before)
 *   take  the count for that job since the last take; 0 when none was seen
 */
export function createShipCounter({ now = () => Date.now(), windowMs = 15000 } = {}) {
  const hits = new Map(); // jobId -> [times]
  return {
    seen(prev, item) {
      if (!item || item.status !== 'shipped' || !prev || prev.status !== 'loaded') return;
      const list = hits.get(item.jobId) || [];
      list.push(now());
      hits.set(item.jobId, list);
    },
    take(jobId) {
      const list = hits.get(jobId) || [];
      hits.delete(jobId);
      const t = now();
      return list.filter((at) => t - at <= windowMs).length;
    },
  };
}

/**
 * The hub sends one "fx ship". The scene wants truck states. This plays leaving -> away -> returning -> (docked | ready).
 * createTruck({ onChange, timings? }) -> { phase, crates, ship(count), reset() }
 */
export function createTruck({ onChange, timings = { leaving: 2600, away: 1800, returning: 2600 } }) {
  let timers = [];
  const truck = {
    phase: null, crates: 0, timings,
    ship(count) {
      truck.reset(false);
      truck.phase = 'leaving'; truck.crates = Math.max(0, Number(count) || 0);
      onChange();
      const at = (ms, fn) => timers.push(setTimeout(() => { fn(); onChange(); }, ms));
      at(timings.leaving, () => { truck.phase = 'away'; });
      at(timings.leaving + timings.away, () => { truck.phase = 'returning'; truck.crates = 0; });
      at(timings.leaving + timings.away + timings.returning, () => { truck.phase = null; });
    },
    reset(notify = true) {
      for (const t of timers) clearTimeout(t);
      timers = [];
      const was = truck.phase;
      truck.phase = null; truck.crates = 0;
      if (notify && was) onChange();
    },
  };
  return truck;
}
