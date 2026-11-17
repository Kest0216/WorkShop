// Selectors: plain functions over the client store. They never change anything.
// This file imports nothing, so node tests can load it without a browser.

const LIVE = new Set(['planning', 'plan_review', 'running', 'qa', 'delivering']);
const OPEN_TASK = new Set(['planned', 'ready', 'working', 'checking', 'buddy', 'review', 'rework', 'integrating', 'blocked', 'failed']);
const OWNER = '@human';
const HUB = '@hub';
const num = (id) => Number(String(id).replace(/^\D+/, '')) || 0;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
const later = (a, b) => (!a ? b : (b.createdAt || 0) > (a.createdAt || 0) || ((b.createdAt || 0) === (a.createdAt || 0) && num(b.id) > num(a.id)) ? b : a);
// When the hub loaded a crate on the truck (merged it). The hub on disk sends loadedAt. Without it updatedAt stands in:
// a loaded delivery does not change again until it ships.
const loadTime = (d) => Number(d.loadedAt ?? d.updatedAt) || 0;
/** Sort deliveries in the order the hub merged them: the order in which "Ship up to here" ships. Never the order of an answer. */
export const byLoad = (a, b) => loadTime(a) - loadTime(b) || num(a.id) - num(b.id);

const PAUSE_WORDS = {
  owner: 'paused by you', budget: 'budget reached', caps: 'a limit was reached', qa: 'QA rounds used up', baseline: 'the check fails before any work',
  stalled: 'nothing moves', tampered: 'the work branch was changed outside the hub', error: 'an error stopped it',
};

/** "Text? A) one B) two" -> [{ key, text }]. An owner question carries 2 to 4 options (contract section 7). */
export function parseOptions(body) {
  const s = String(body ?? '');
  const marks = [];
  const rx = /(?:^|\s)([A-D])\)\s+/g;
  let m;
  while ((m = rx.exec(s))) marks.push({ key: m[1], at: m.index, end: rx.lastIndex });
  // Options come in order: A, then B, ... Anything else is prose that happens to hold "X) ".
  const ok = [];
  for (const mk of marks) if (mk.key === 'ABCD'[ok.length]) ok.push(mk);
  if (ok.length < 2) return { text: s.trim(), options: [] };
  return {
    text: s.slice(0, ok[0].at).trim(),
    options: ok.map((mk, i) => ({ key: mk.key, text: s.slice(mk.end, i + 1 < ok.length ? ok[i + 1].at : s.length).trim() })),
  };
}

// The selectors below that walk the whole board are asked several times per redraw. One answer per store revision is enough.
// (A test store has no "rev": then nothing is kept.)
const memo = new WeakMap();
function once(store, name, build) {
  if (typeof store.rev !== 'number') return build();
  let m = memo.get(store);
  if (!m || m.rev !== store.rev) memo.set(store, (m = { rev: store.rev, values: new Map() }));
  if (!m.values.has(name)) m.values.set(name, build());
  return m.values.get(name);
}

export const sel = {
  OWNER, HUB,

  /** Every job the owner can see. A deleted job (DELETE /api/jobs/:id) keeps its row with deleted:true: it is left out here. */
  jobs(store, filter) { return store.list('jobs', (j) => !j.deleted && (!filter || filter(j))); },

  /** The job on the floor: a live one first, then a paused one, then the most recent other one. null when there is none. */
  activeJob(store) {
    let live = null, paused = null, any = null;
    for (const j of sel.jobs(store)) {
      if (LIVE.has(j.status)) live = later(live, j);
      else if (j.status === 'paused') paused = later(paused, j);
      any = later(any, j);
    }
    return live || paused || any;
  },
  /** planning, plan_review, running, qa or delivering */
  isLive(job) { return !!job && LIVE.has(job.status); },
  /** live or paused: the job can still go on */
  isOpen(job) { return !!job && (LIVE.has(job.status) || job.status === 'paused'); },
  projectOf(store, job) { return job ? store.get('projects', job.projectId) : null; },
  /** Plain words for job.pauseReason. */
  pauseWords(job) { return job && job.pauseReason ? PAUSE_WORDS[job.pauseReason] || String(job.pauseReason) : 'paused'; },
  /** The job a queued job waits for, or null. */
  waitsFor(store, job) {
    if (!job || job.status !== 'queued') return null;
    return sel.jobs(store, (j) => j.id !== job.id && (LIVE.has(j.status) || j.status === 'paused'))[0] || null;
  },
  /** { billed, est, total, text, title }: billed = API-key turns, est = subscription turns at API prices (contract section 12). */
  cost(job, money) {
    const c = (job && job.cost) || {};
    const billed = Number(c.billedUsd) || 0, est = Number(c.estUsd) || 0;
    const parts = [];
    if (billed > 0 || est <= 0) parts.push(money(billed));
    if (est > 0) parts.push(`~${money(est)} est.`);
    return { billed, est, total: billed + est, text: parts.join(' + '),
      title: `${money(billed)} billed on API keys. ${money(est)} estimated at API prices for subscription turns.` };
  },

  tasksOf(store, jobId) { return store.list('tasks', (t) => t.jobId === jobId); },
  agentsOf(store, jobId) { return store.list('agents', (a) => a.jobId === jobId); },
  deliveriesOf(store, jobId) { return store.list('deliveries', (d) => d.jobId === jobId); },
  /**
   * Deliveries on the truck, in the order they were loaded (merged): by loadedAt, else updatedAt, then by id.
   * The hub ships every crate that was merged up to one commit, so this order decides what "Ship up to here" ships.
   * The order of a list the hub sends (state, the truck answer) says nothing: the hub sorts those by id.
   */
  loadedDeliveries(store, jobId) {
    return store.list('deliveries', (d) => d.jobId === jobId && d.status === 'loaded').sort(byLoad);
  },
  /** A copy of a list of deliveries in load order. */
  loadOrder(list) { return (Array.isArray(list) ? list.filter((d) => d && d.id != null) : []).sort(byLoad); },
  /**
   * Every job whose truck holds loaded crates: [{ job, n, waits }]. The job on the floor comes first, then the newest.
   *   waits  the truck waits for the owner: the job is in "delivering", or it is cancelled and its reviewed crates were left behind
   */
  trucks(store) {
    return once(store, 'trucks', () => {
      const counts = new Map();
      for (const d of store.list('deliveries')) if (d.status === 'loaded') counts.set(d.jobId, (counts.get(d.jobId) || 0) + 1);
      const floor = sel.activeJob(store);
      const out = [];
      for (const j of sel.jobs(store)) if (counts.has(j.id)) out.push({ job: j, n: counts.get(j.id), waits: j.status === 'delivering' || j.status === 'cancelled' });
      return out.sort((a, b) => Number(b.job === floor) - Number(a.job === floor) || (later(a.job, b.job) === a.job ? -1 : 1));
    });
  },
  /**
   * The job whose truck the Truck button stands for: one whose truck waits for the owner (the job on the floor first),
   * else the job on the floor. So the reviewed crates of a cancelled job stay in reach while a newer job runs.
   */
  truckJob(store) {
    const waiting = sel.trucks(store).find((t) => t.waits);
    return waiting ? waiting.job : sel.activeJob(store);
  },
  /** { total, merged, open, cancelled, byStatus } for the tasks of a job. */
  taskCounts(store, jobId) {
    const out = { total: 0, merged: 0, open: 0, cancelled: 0, byStatus: {} };
    for (const t of store.list('tasks')) {
      if (t.jobId !== jobId) continue;
      out.byStatus[t.status] = (out.byStatus[t.status] || 0) + 1;
      if (t.status === 'cancelled') { out.cancelled++; continue; }
      out.total++;
      if (t.status === 'merged') out.merged++;
      else if (OPEN_TASK.has(t.status)) out.open++;
    }
    return out;
  },
  leadBoss(store, job) { return job ? store.get('agents', job.leadBossId) || sel.agentsOf(store, job.id).find((a) => a.role === 'boss') || null : null; },
  /** Find an agent by id ("A5"), by board handle ("@m3") or by persona name ("Rusty"). */
  agentByRef(store, ref, jobId) {
    if (ref == null) return null;
    const byIdHit = store.get('agents', ref);
    if (byIdHit) return byIdHit;
    const s = String(ref).toLowerCase();
    const name = s.replace(/^@/, '');
    let hit = null;
    for (const a of store.list('agents')) {
      if (jobId && a.jobId !== jobId) continue;
      if ((a.handle && a.handle.toLowerCase() === s) || (a.name && a.name.toLowerCase() === name)) hit = later(hit, a);
    }
    return hit;
  },
  /** The task a maker is bound to, or the task a boss or manager reviews right now. */
  taskOf(store, agent) { return agent && agent.taskId ? store.get('tasks', agent.taskId) : null; },
  /** True when the agent, or the task it works on, is on hold for its lab (rate limit, sign-in). */
  onHold(store, agent) {
    if (!agent) return null;
    if (agent.hold) return agent.hold;
    const t = sel.taskOf(store, agent);
    return t && t.hold && t.assigneeId === agent.id ? t.hold : null;
  },

  /** Board messages of a job (messages with no job are kept too). */
  boardOf(store, jobId) { return jobId ? store.board.filter((m) => !m.jobId || m.jobId === jobId) : store.board; },
  isToOwner(msg) { return !!msg && msg.to === OWNER; },
  isFromOwner(msg) { return !!msg && msg.from === OWNER; },
  isFromHub(msg) { return !!msg && (msg.from === HUB || msg.kind === 'EVT'); },
  /** Persona name for a message author or addressee: "Rusty" for @b1, "you" for @human, "hub" for @hub. */
  who(store, handle, id) {
    if (handle === OWNER) return 'you';
    if (handle === HUB) return 'hub';
    const a = id ? store.get('agents', id) : null;
    if (a && a.name) return a.name;
    return handle == null ? '' : String(handle);
  },
  /**
   * Questions that wait for the owner, oldest first (contract section 12b):
   * an open ASK to @human, or one where the hub took the default and the owner has not answered it yet.
   * An answer of the owner (also one that confirms the default) unpins the question.
   * -> [{ id, jobId, from, fromId, text, options: [{ key, text }], default, defaulted, ts, msg }]
   */
  ownerQuestions(store, jobId) {
    const answered = new Set();
    for (const m of store.board) if (m.kind === 'ANS' && m.from === OWNER && m.re != null) answered.add(m.re);
    const out = new Map();
    const want = (id, job) => !answered.has(id) && (!jobId || !job || job === jobId);
    for (const m of store.board) {
      if (m.kind !== 'ASK' || m.to !== OWNER || !want(m.id, m.jobId)) continue;
      if (m.state !== 'open' && !m.defaulted) continue;
      const p = parseOptions(m.body);
      out.set(m.id, { id: m.id, jobId: m.jobId, from: m.from, fromId: m.fromId, text: p.text, options: p.options, default: (m.slots && m.slots.default) || null, defaulted: !!m.defaulted, ts: m.ts, msg: m });
    }
    // The inbox also holds questions that are older than the board posts this window loaded.
    for (const it of store.inbox || []) {
      if (it.kind !== 'question' || out.has(it.id) || !want(it.id, it.jobId)) continue;
      const m = store.msg ? store.msg(it.id) : null;
      if (m && m.state !== 'open' && !m.defaulted) continue; // closed since the inbox was fetched
      const p = parseOptions(it.text);
      out.set(it.id, { id: it.id, jobId: it.jobId, from: m ? m.from : it.from || null, fromId: m ? m.fromId : null, text: p.text,
        options: Array.isArray(it.options) && it.options.length ? it.options : p.options, default: it.default || null, defaulted: !!it.defaulted, ts: it.since, msg: m });
    }
    return [...out.values()].sort((a, b) => a.id - b.id);
  },
  /** Open items the agent owes an answer to (ASK, REQ, BLOCK addressed to it). */
  openFor(store, agent) { return agent ? store.board.filter((m) => m.state === 'open' && m.toId === agent.id && m.kind !== 'DONE') : []; },
  /** Open items the agent itself waits on (its own ASK, BLOCK or DONE). */
  openBy(store, agent) { return agent ? store.board.filter((m) => m.state === 'open' && m.fromId === agent.id) : []; },
  /** Number of board posts that arrived since the owner last looked at the board. The owner's own posts do not count. */
  unreadBoard(store) {
    let n = 0;
    const b = store.board;
    for (let i = b.length - 1; i >= 0 && b[i].id > store.boardSeenId; i--) if (b[i].from !== OWNER) n++;
    return n;
  },
  unreadForOwner(store) {
    let n = 0;
    const b = store.board;
    for (let i = b.length - 1; i >= 0 && b[i].id > store.boardSeenId; i--) if (b[i].to === OWNER) n++;
    return n;
  },

  /** Labs the owner can set up (the mock lab is not one of them). Lab state comes only from usable and reason (contract 13b). */
  labs(store) { return store.providers.filter((p) => p.id !== 'mock'); },
  labNeedsSetup(p) { return !p.usable; },
  labUsable(p) { return !!p.usable; },
  /** The cooling episode of a lab that still runs ({ until, reason }), or null. A plan limit was reached: the lab comes back by itself. */
  labCooling(p, now = Date.now()) { return p && p.cooling && Number(p.cooling.until) > now ? p.cooling : null; },
  /**
   * The next thing to do for a lab: install | mode | key | signin | test | cooling | ready | other.
   * "cooling" means that nothing is left to set up: the lab waits for its plan limit to reset.
   */
  labStep(p, settings, now = Date.now()) {
    if (!p) return 'other';
    if (p.id === 'oss') {
      if (p.usable) return 'ready';
      if (sel.labCooling(p, now)) return 'cooling';
      return 'oss';
    }
    if (!p.installed) return 'install';
    if (!p.mode || p.ack === false) return 'mode';
    if (p.mode === 'apikey' && !p.keySet) return 'key';
    if (p.mode === 'subscription' && p.auth !== 'ok') return 'signin';
    if (p.usable) return 'ready';
    const safety = (settings && settings.safety) || 'sandboxed';
    const st = p.selfTest;
    if (safety === 'sandboxed' && !(st && st.ok && (!p.version || st.version === p.version))) return 'test';
    if (sel.labCooling(p, now)) return 'cooling';
    return 'other';
  },
  /** Labs that the owner must set up (a lab that only cools down is not one of them). */
  labsToSetUp(store) { return sel.labs(store).filter((p) => !p.usable && sel.labStep(p, store.settings) !== 'cooling'); },
  /** True when a usable lab bills per token: a new job then needs a budget. */
  needsBudget(store) { return store.providers.some((p) => p.usable && p.mode === 'apikey'); },
  /** True when work of an open job waits for this lab (a hold on the job, on an agent or on a task). */
  labHoldsWork(store, labId) {
    for (const j of sel.jobs(store)) {
      if (!sel.isOpen(j)) continue;
      if (j.hold && j.hold.lab === labId) return true;
      if (store.list('agents', (a) => a.jobId === j.id && a.hold && a.hold.provider === labId).length) return true;
      if (store.list('tasks', (t) => t.jobId === j.id && t.hold && t.hold.provider === labId).length) return true;
    }
    return false;
  },

  /**
   * The hand-in a "review" inbox item is about: { delivery, doneId }. The hub sends id = the delivery id and msgId = the id of
   * the DONE post. An older form sent the DONE id as the item id: that still works.
   */
  reviewTarget(store, it) {
    let delivery = typeof it.id === 'string' ? store.get('deliveries', it.id) : null;
    let doneId = delivery && delivery.doneMsgId != null ? delivery.doneMsgId : it.msgId != null && Number.isFinite(Number(it.msgId)) ? Number(it.msgId) : null;
    if (!delivery && it.id != null && it.id !== '' && Number.isFinite(Number(it.id))) {
      doneId = Number(it.id);
      delivery = store.list('deliveries', (d) => d.doneMsgId === doneId)[0] || null;
    }
    return { delivery, doneId };
  },

  /**
   * The attention inbox (contract section 12b): everything that waits for the owner, newest first.
   * It is the inbox of the hub without what the live state has settled since, plus what the state itself shows
   * (a question on the board, a plan in review, a loaded truck, a paused job), so nothing waits for the next inbox fetch.
   * -> [{ key, kind, id, jobId, text, since, quiet, job?, q?, delivery?, doneId?, req?, project?, lab? }]
   *   kind   question | truck | plan | signin | budget | paused | review | requirement | agentfiles (or one this UI does not know)
   *   quiet  it is listed, but it does not ring: a default the hub took, a job the owner paused, a lab that no work waits for
   */
  inboxItems(store) {
    return once(store, 'inbox', () => {
      const items = new Map();
      const add = (it) => { if (!items.has(it.key)) items.set(it.key, it); };
      const questions = new Map();
      for (const j of sel.jobs(store)) if (sel.isOpen(j)) for (const q of sel.ownerQuestions(store, j.id)) questions.set(q.id, q);
      const truckWaits = (j) => !!j && (j.status === 'delivering' || j.status === 'cancelled') && sel.loadedDeliveries(store, j.id).length > 0;
      const pausedKind = (j) => (j.pauseReason === 'budget' ? 'budget' : 'paused');

      for (const raw of store.inbox || []) {
        const kind = String(raw.kind || '');
        const job = raw.jobId ? store.get('jobs', raw.jobId) : null;
        const it = { key: `${kind}:${raw.id}`, kind, id: raw.id, jobId: raw.jobId ?? null, text: String(raw.text ?? ''), since: Number(raw.since) || 0, quiet: false, job };
        if (kind === 'question') {
          const q = questions.get(Number(raw.id));
          if (q) add({ ...it, id: q.id, key: 'question:' + q.id, q, quiet: !!q.defaulted, since: q.ts || it.since });
        } else if (kind === 'plan') {
          if (job && job.status === 'plan_review') add(it);
        } else if (kind === 'truck') {
          if (truckWaits(job)) add(it);
        } else if (kind === 'budget' || kind === 'paused') {
          if (job && job.status === 'paused') add({ ...it, kind: pausedKind(job), key: `${pausedKind(job)}:${job.id}`, quiet: job.pauseReason === 'owner' });
        } else if (kind === 'signin') {
          // The hub lists a lab only when agents of a live job use it and it is signed out (jobId set): then work waits for it.
          const labId = raw.provider || raw.id;
          const lab = store.providers.find((p) => p.id === labId) || null;
          if (lab && lab.usable) continue;
          if (job && !sel.isLive(job)) continue;
          const waits = !!lab && (!!raw.jobId || sel.labHoldsWork(store, lab.id));
          add({ ...it, id: labId, lab, quiet: !lab || sel.labStep(lab, store.settings) === 'cooling' || !waits });
        } else if (kind === 'review') {
          const { delivery, doneId } = sel.reviewTarget(store, raw);
          const done = doneId != null && store.msg ? store.msg(doneId) : null;
          if (delivery && ['approved', 'loaded', 'shipped', 'rejected'].includes(delivery.status)) continue; // a verdict is in
          if (done && done.state && done.state !== 'open') continue;
          add({ ...it, delivery, doneId });
        } else if (kind === 'requirement') {
          // A requirement that no task serves: one that QA failed, or an open one that the lead boss made no task for.
          // It waits for the owner until it is gone, waived or verified.
          const rid = raw.reqId || raw.id;
          const req = job ? (job.requirements || []).find((r) => r.id === rid) || null : null;
          if (job && (!sel.isOpen(job) || !req || req.status === 'waived' || req.status === 'verified')) continue;
          add({ ...it, id: rid, key: `requirement:${rid}`, req });
        } else if (kind === 'agentfiles') {
          const project = store.get('projects', raw.projectId || raw.id) || (job ? store.get('projects', job.projectId) : null);
          if (project && project.agentFilesAck) continue;
          add({ ...it, project });
        } else if (kind === 'requisition') {
          const rid = raw.reqId || raw.id;
          const reqn = (store.requisitions || []).find((r) => r.id === rid) || null;
          if (reqn && reqn.status !== 'queued_phase1') continue;
          add({ ...it, id: rid, key: `requisition:${rid}`, reqn, quiet: true });
        } else add(it);
      }

      for (const q of questions.values()) add({ key: 'question:' + q.id, kind: 'question', id: q.id, jobId: q.jobId, text: q.text, since: q.ts || 0, quiet: !!q.defaulted, job: q.jobId ? store.get('jobs', q.jobId) : null, q });
      for (const j of sel.jobs(store)) {
        const at = j.updatedAt || j.createdAt || 0;
        if (j.status === 'plan_review') add({ key: 'plan:' + j.id, kind: 'plan', id: j.id, jobId: j.id, text: 'The plan waits for your approval.', since: at, quiet: false, job: j });
        if (truckWaits(j)) { // also the truck of a cancelled job that is not on the floor any more: its crates still wait
          const n = sel.loadedDeliveries(store, j.id).length;
          add({ key: 'truck:' + j.id, kind: 'truck', id: j.id, jobId: j.id, since: at, quiet: false, job: j,
            text: j.status === 'cancelled' ? `${j.id} is cancelled. ${plural(n, 'reviewed crate is', 'reviewed crates are')} still on the truck. Ship or discard.` : `The truck holds ${plural(n, 'crate')}. Approve to ship.` });
        }
        if (j.status === 'paused') {
          const mine = j.pauseReason === 'owner' || !j.pauseReason;
          add({ key: `${pausedKind(j)}:${j.id}`, kind: pausedKind(j), id: j.id, jobId: j.id, since: at, quiet: mine, job: j,
            text: String(j.error || (mine ? 'You paused the job.' : `The hub paused the job: ${sel.pauseWords(j)}.`)) });
        }
      }
      return [...items.values()].sort((a, b) => b.since - a.since || (a.key < b.key ? -1 : 1));
    });
  },

  /**
   * What waits for the owner, derived from state (so it survives a reload):
   * { any, count, items, loud, questions, planReview, truckJob, truckLoad, truckWaiting, cancelledLoad, hubPaused, panels: { inbox, board, blueprint, truck } }
   *   any        something rings: the scene bell, the Inbox button and the window title
   *   count      every item in the Inbox panel (the number on the Inbox button)
   *   truckJob   the job whose truck the Truck button stands for (sel.truckJob); truckLoad: the crates on that truck
   *   panels     what makes each top-bar button pulse
   */
  ownerAttention(store) {
    return once(store, 'attention', () => {
      const job = sel.activeJob(store);
      const items = sel.inboxItems(store);
      const loud = items.filter((it) => !it.quiet);
      const questions = sel.isOpen(job) ? sel.ownerQuestions(store, job.id) : []; // a finished job asks nothing
      const planReview = !!job && job.status === 'plan_review';
      const truckJob = sel.truckJob(store);
      const truckLoad = truckJob ? sel.loadedDeliveries(store, truckJob.id).length : 0;
      const cancelledLoad = !!truckJob && truckJob.status === 'cancelled' && truckLoad > 0; // reviewed work that was left behind: ship or discard
      const truckWaiting = !!truckJob && truckLoad > 0 && (truckJob.status === 'delivering' || cancelledLoad);
      const hubPaused = !!job && job.status === 'paused' && !!job.pauseReason && job.pauseReason !== 'owner'; // the hub stopped: resume or cancel
      const open = questions.filter((q) => !q.defaulted).length; // a default that was taken does not block anyone
      const lost = loud.filter((it) => it.kind === 'requirement' && job && it.jobId === job.id).length; // requirements that no task serves (failed, or open with no task)
      const panels = { inbox: loud.length, board: open, blueprint: (planReview ? 1 : 0) + (hubPaused ? 1 : 0) + lost, truck: truckWaiting ? 1 : 0 };
      return { any: loud.length > 0, count: items.length, items, loud, questions, planReview, truckJob, truckLoad, truckWaiting, cancelledLoad, hubPaused, panels };
    });
  },
};
