// WorkShop view-model normalizer + differ. Pure logic, no DOM.
// normalize() never throws: unknown values fall back to defaults and warn once per kind.

export const ROLES = ['boss', 'manager', 'maker'];
export const PROVIDERS = ['claude', 'gemini', 'openai', 'oss', 'mock'];
export const ACTIVITIES = ['off', 'idle', 'think', 'work', 'wait', 'review', 'blocked'];
export const DOMAINS = ['plan', 'backend', 'frontend', 'fix', 'review', 'test', 'data', 'algo', 'research', 'synthesis', 'docs', 'vision', 'chore'];
// Bench tooling and doohickey family per task domain.
export const FAMILY = Object.freeze({
  backend: 'machine', algo: 'machine', frontend: 'paint', vision: 'paint', research: 'study', synthesis: 'study',
  test: 'gauge', review: 'gauge', docs: 'press', data: 'files', fix: 'solder', chore: 'solder', plan: 'plan',
});
export const FAMILIES = ['machine', 'paint', 'study', 'gauge', 'press', 'files', 'solder', 'plan'];
export function familyOf(domain) { return FAMILY[domain] || 'machine'; }
export const STAGES = ['to_office', 'buddy_check', 'in_review', 'rejected', 'to_truck', 'on_truck', 'shipped'];
export const TRUCK_STATES = ['away', 'returning', 'docked', 'ready', 'leaving'];
export const BUBBLE_KINDS = ['ask', 'info', 'done', 'warn'];
export const CAPACITY = { maker: 8, boss: 3, manager: 3 };
export const MAX_AGENTS = 48, MAX_DELIVERIES = 64;

// Look vocabulary (the pixels live in sprites.js).
export const HEADGEAR = ['cap', 'beanie', 'goggles', 'bandana', 'visor', 'muffs', 'none'];
export const TOOLS = ['hammer', 'saw', 'wrench', 'iron', 'drill', 'calipers'];
export const HAIR_STYLES = ['crop', 'mop', 'bob', 'long', 'curly', 'spiky', 'pony', 'bun', 'swoop', 'buzz'];
export const LOOK_COUNTS = Object.freeze({ skin: 4, hairColor: 8, shirt: 6, apron: 8, pants: 5, gear: 6 });

// warn(kind, message): prints each kind only once.
export function createWarner(sink) {
  const seen = new Set();
  const out = sink || ((m) => { try { console.warn(m); } catch (e) { /* ignore */ } });
  const warn = (kind, msg) => {
    if (seen.has(kind)) return;
    if (seen.size > 200) return;
    seen.add(kind);
    out('[scene] ' + msg);
  };
  warn.seen = seen;
  return warn;
}

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function str(v, max, dflt = '') {
  if (v == null) return dflt;
  let s;
  try { s = String(v); } catch (e) { return dflt; }
  return s.length > max ? s.slice(0, max) : s;
}
function num(v, dflt) { const n = typeof v === 'number' ? v : Number(v); return Number.isFinite(n) ? n : dflt; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function oneOf(v, list, dflt, warn, kind) {
  if (list.includes(v)) return v;
  if (v != null && warn) warn(kind + ':' + str(v, 20), 'unknown ' + kind + ' "' + str(v, 20) + '", using "' + dflt + '"');
  return dflt;
}

export function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The whole look derives from seed + role. Optional overrides: hat, tool (makers only).
// The order of the pick() calls is part of the contract: changing it changes every agent's face.
export function lookFromSeed(seed, role, overrides) {
  const r = ROLES.includes(role) ? role : 'maker';
  const base = typeof seed === 'number' && Number.isFinite(seed) ? seed >>> 0 : hashString(str(seed, 64, 'x'));
  const rng = mulberry32((base ^ hashString(r)) >>> 0);
  const pick = (n) => Math.floor(rng() * n);
  const C = LOOK_COUNTS;
  const look = {
    role: r,
    skin: pick(C.skin),
    hairStyle: HAIR_STYLES[pick(HAIR_STYLES.length)],
    hairColor: pick(C.hairColor),
    shirt: pick(C.shirt),
    apron: pick(C.apron),
    pants: pick(C.pants),
    gear: pick(C.gear),
    hat: 'none',
    tool: 'none',
    glasses: false,
    outfit: 'apron',
  };
  const a = pick(HEADGEAR.length), b = pick(TOOLS.length), c = pick(2), d = pick(2);
  if (r === 'maker') {
    look.hat = HEADGEAR[a];
    look.tool = TOOLS[b];
  } else if (r === 'manager') {
    look.hat = 'hardhat';
    look.tool = 'clipboard';
    look.outfit = 'hivis';
  } else {
    look.tool = 'magnifier';
    look.glasses = c === 1;
    look.outfit = d === 1 ? 'vest' : 'blazer';
    if (look.hairStyle === 'spiky') look.hairStyle = 'crop';
  }
  if (isObj(overrides)) {
    if (r === 'maker' && HEADGEAR.includes(overrides.hat)) look.hat = overrides.hat;
    if (r === 'maker' && TOOLS.includes(overrides.tool)) look.tool = overrides.tool;
  }
  return look;
}

export function lookKey(look, provider) {
  return [look.role, look.skin, look.hairStyle, look.hairColor, look.shirt, look.apron, look.pants, look.gear, look.hat, look.tool, look.glasses ? 1 : 0, look.outfit, provider].join('|');
}

// Growth stage 0..3 from task progress 0..1.
export function progressStage(p) {
  const v = clamp(num(p, 0), 0, 1);
  return v >= 0.75 ? 3 : v >= 0.5 ? 2 : v >= 0.25 ? 1 : 0;
}

function normTask(t, warn) {
  if (!isObj(t)) return null;
  return {
    id: str(t.id, 24, ''),
    title: str(t.title, 60, ''),
    domain: oneOf(t.domain, DOMAINS, 'backend', warn, 'domain'),
    progress: clamp(num(t.progress, 0), 0, 1),
  };
}

function normBubble(b) {
  if (!isObj(b)) return null;
  const text = str(b.text, 90, '').trim();
  if (!text) return null;
  return { text, kind: BUBBLE_KINDS.includes(b.kind) ? b.kind : 'info', seq: str(b.seq, 24, '0') };
}

// vm: raw view model (anything). prev: previous normalized model or null. Returns a clean model.
export function normalize(vm, prev, warn) {
  const w = warn || (() => {});
  const src = isObj(vm) ? vm : {};
  if (!isObj(vm)) w('vm', 'view model is not an object, using an empty shop');
  const shopIn = isObj(src.shop) ? src.shop : {};
  const model = {
    shop: { jobTitle: str(shopIn.jobTitle, 60, ''), paused: shopIn.paused === true, statusLine: str(shopIn.statusLine, 60, '') },
    agents: [], agentById: new Map(), overflow: 0,
    deliveries: [], deliveryById: new Map(),
    truck: { state: 'away', crates: 0 },
    board: { unread: 0 },
    owner: { attention: false },
  };

  // --- agents ---
  const list = Array.isArray(src.agents) ? src.agents : [];
  if (src.agents != null && !Array.isArray(src.agents)) w('agents', 'agents is not an array');
  const wanted = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!isObj(a)) { w('agent-shape', 'agent entry is not an object, skipped'); continue; }
    const id = str(a.id, 32, '').trim();
    if (!id) { w('agent-id', 'agent without id, skipped'); continue; }
    if (model.agentById.has(id)) { w('agent-dup', 'duplicate agent id "' + id + '", keeping the first'); continue; }
    if (model.agents.length >= MAX_AGENTS) { w('agent-max', 'more than ' + MAX_AGENTS + ' agents, extra ignored'); break; }
    const role = oneOf(a.role, ROLES, 'maker', w, 'role');
    const style = isObj(a.style) ? a.style : {};
    const seed = Number.isFinite(style.seed) ? style.seed : hashString(id);
    const agent = {
      id,
      name: str(a.name, 16, id) || id,
      handle: str(a.handle, 16, ''),
      role,
      provider: oneOf(a.provider, PROVIDERS, 'mock', w, 'provider'),
      model: str(a.model, 40, ''),
      harnessId: str(a.harnessId, 48, ''),
      certification: str(a.certification, 24, ''),
      seed,
      look: lookFromSeed(seed, role, style),
      spot: null,
      present: false,
      activity: oneOf(a.activity, ACTIVITIES, 'idle', w, 'activity'),
      task: normTask(a.task, w),
      bubble: normBubble(a.bubble),
    };
    model.agents.push(agent);
    model.agentById.set(id, agent);
    const cap = CAPACITY[role];
    const req = Number.isInteger(a.spot) && a.spot >= 0 && a.spot < cap ? a.spot : null;
    if (a.spot != null && req === null) w('spot:' + role, 'invalid spot for a ' + role + ', using the first free one');
    wanted.push(req);
  }
  // spot assignment: explicit requests first, then the previous spot, then the first free spot
  const taken = { maker: new Set(), boss: new Set(), manager: new Set() };
  model.agents.forEach((a, i) => {
    if (a.activity === 'off' || wanted[i] === null || taken[a.role].has(wanted[i])) return;
    a.spot = wanted[i]; taken[a.role].add(a.spot);
  });
  model.agents.forEach((a) => {
    if (a.activity === 'off' || a.spot !== null) return;
    const before = prev && prev.agentById && prev.agentById.get(a.id);
    if (before && before.role === a.role && before.spot !== null && !taken[a.role].has(before.spot)) {
      a.spot = before.spot; taken[a.role].add(a.spot);
    }
  });
  model.agents.forEach((a) => {
    if (a.activity === 'off') return;
    if (a.spot === null) {
      for (let s = 0; s < CAPACITY[a.role]; s++) if (!taken[a.role].has(s)) { a.spot = s; taken[a.role].add(s); break; }
    }
    if (a.spot === null) model.overflow++;
    else a.present = true;
  });

  // --- deliveries ---
  const dl = Array.isArray(src.deliveries) ? src.deliveries : [];
  for (let i = 0; i < dl.length; i++) {
    const d = dl[i];
    if (!isObj(d)) { w('delivery-shape', 'delivery entry is not an object, skipped'); continue; }
    const id = str(d.id, 32, '').trim();
    if (!id) { w('delivery-id', 'delivery without id, skipped'); continue; }
    if (model.deliveryById.has(id)) { w('delivery-dup', 'duplicate delivery id "' + id + '", keeping the first'); continue; }
    if (!STAGES.includes(d.stage)) { w('stage:' + str(d.stage, 20), 'unknown delivery stage "' + str(d.stage, 20) + '", skipped'); continue; }
    if (model.deliveries.length >= MAX_DELIVERIES) { w('delivery-max', 'more than ' + MAX_DELIVERIES + ' deliveries, extra ignored'); break; }
    const makerId = str(d.makerId, 32, '');
    const maker = model.agentById.get(makerId);
    const dflt = maker && maker.task ? maker.task.domain : 'backend';
    const del = {
      id,
      taskId: str(d.taskId, 24, ''),
      domain: DOMAINS.includes(d.domain) ? d.domain : oneOf(d.domain, DOMAINS, dflt, w, 'domain'),
      makerId,
      reviewerId: str(d.reviewerId, 32, ''),
      buddyId: str(d.buddyId, 32, ''),
      stage: d.stage,
    };
    model.deliveries.push(del);
    model.deliveryById.set(id, del);
  }

  // --- truck, board, owner ---
  const tr = isObj(src.truck) ? src.truck : {};
  model.truck.state = oneOf(tr.state, TRUCK_STATES, 'away', w, 'truck');
  model.truck.crates = clamp(Math.floor(num(tr.crates, 0)), 0, 999);
  model.board.unread = clamp(Math.floor(num(isObj(src.board) ? src.board.unread : 0, 0)), 0, 999);
  model.owner.attention = isObj(src.owner) && src.owner.attention === true;
  return model;
}

// Office index that reviews a delivery: the reviewer's office, else the first boss, else office 0.
export function officeOf(model, delivery) {
  const rev = model.agentById.get(delivery.reviewerId);
  if (rev && rev.role === 'boss' && rev.spot !== null) return rev.spot;
  for (const a of model.agents) if (a.role === 'boss' && a.spot !== null) return a.spot;
  return 0;
}

// True when a delivery is reviewed at the maker's bench: the reviewer is a present manager (or another maker).
// A boss, or an unknown reviewer, reviews at the office desk.
export function reviewAtBench(model, delivery) {
  const rev = model.agentById.get(delivery.reviewerId);
  return !!rev && rev.role !== 'boss' && rev.id !== delivery.makerId;
}

// Who walks to the maker's bench to inspect a delivery, or null:
// stage buddy_check -> the buddy; stage in_review with a bench reviewer -> the reviewer.
// The inspector must be present and not a boss (bosses stay in their offices), and the maker must be at a bench.
export function inspectorOf(model, delivery) {
  let id = '';
  if (delivery.stage === 'buddy_check') id = delivery.buddyId;
  else if (delivery.stage === 'in_review' && reviewAtBench(model, delivery)) id = delivery.reviewerId;
  if (!id || id === delivery.makerId) return null;
  const a = model.agentById.get(id), mk = model.agentById.get(delivery.makerId);
  if (!a || !a.present || a.role === 'boss' || !mk || !mk.present || mk.role !== 'maker') return null;
  return a;
}

// One-shot transitions between two normalized models. prev may be null (first sync).
export function diff(prev, next) {
  const ev = [];
  ev.initial = !prev;
  const pa = prev ? prev.agentById : new Map();
  for (const a of next.agents) {
    const b = pa.get(a.id);
    if (!b) { ev.push({ type: 'agentAdded', id: a.id }); if (a.bubble && prev) ev.push({ type: 'bubble', id: a.id }); continue; }
    if (b.spot !== a.spot || b.role !== a.role || b.present !== a.present) ev.push({ type: 'agentMoved', id: a.id });
    if (b.activity !== a.activity) ev.push({ type: 'activity', id: a.id, from: b.activity, to: a.activity });
    if (a.bubble && (!b.bubble || b.bubble.seq !== a.bubble.seq)) ev.push({ type: 'bubble', id: a.id });
  }
  for (const b of prev ? prev.agents : []) if (!next.agentById.has(b.id)) ev.push({ type: 'agentRemoved', id: b.id });
  const pd = prev ? prev.deliveryById : new Map();
  for (const d of next.deliveries) {
    const b = pd.get(d.id);
    if (!b) ev.push({ type: 'deliveryAdded', id: d.id, to: d.stage });
    else if (b.stage !== d.stage) ev.push({ type: 'deliveryStage', id: d.id, from: b.stage, to: d.stage });
  }
  for (const b of prev ? prev.deliveries : []) if (!next.deliveryById.has(b.id)) ev.push({ type: 'deliveryRemoved', id: b.id, from: b.stage });
  if (prev && prev.truck.state !== next.truck.state) ev.push({ type: 'truck', from: prev.truck.state, to: next.truck.state });
  if (prev && prev.board.unread !== next.board.unread) ev.push({ type: 'unread', from: prev.board.unread, to: next.board.unread });
  return ev;
}
