// Client store. One GET /api/state, then the SSE stream (contract sections 5, 6, 13b).
// Entities live in maps by id and are replaced on "upsert". No reducers.
//
//   store.ready / store.conn ('connecting' | 'online' | 'offline' | 'locked') / store.seq
//       'locked': the hub answered 401. Open WorkShop from the app (the link holds the owner key).
//   store.get(kind, id) ; store.list(kind, filterFn?)        kind: projects | jobs | tasks | agents | deliveries
//   store.board (Message[], oldest first, capped) ; store.boardRev (rises when a stored message changes)
//   store.providers (ProviderStatus[]) ; store.settings ; store.models ({ registry, leaders }) ; store.inbox (InboxItem[])
//   store.subscribe(fn) -> off      fn(changes: Set<string>) once per animation frame, with the slices that changed
//   store.on(type, fn) -> off       raw live events, at once: upsert(evt, prev) remove(evt, prev) board(msg) boardchange(msgs)
//                                   agentlog(evt) fx(evt) notice(evt) toolrun(evt) providers(evt) settings(evt) conn(state) state()
//   store.set(slice, value)         providers | settings | models | inbox, after a panel saved or fetched them
//   store.touch(...slices)          ask for a redraw (slices are free-form names, e.g. 'ui') ; store.rev rises with every touch
//   store.addBoard(msgs) ; store.markBoardSeen() ; store.boardSeenId ; store.msg(id)
//   store.connect() ; store.refetch() ; store.refreshInbox() ; store.resync() ; store.stop()
//       resync: load the state again and open a new stream (the Mac app fires "workshop:resume" after a wake or a display change)
//
// Watchdog: in WKWebView an EventSource can die without any error or readyState change. The hub sends a heartbeat message
// ({"type":"hb","seq":n}, no id) every 5 s, so a stream that is alive is never quiet for long. Any message counts as life; an hb
// never moves store.seq (it is not an event). When nothing came for WATCH.silentMs, the store asks GET /api/health:
//   health.seq above store.seq, and still above it at the next look   the stream lost events: open it again with ?since=<seq>
//   health.seq below store.seq                                          another hub run: load its state
//   no answer                                                           the hub is gone: the normal reconnect path
//
//   prefs.get(key, fallback) ; prefs.set(key, value, delayMs?) ; prefs.flush(...keys)     small JSON preferences of the owner (see below)

export const KINDS = ['projects', 'jobs', 'tasks', 'agents', 'deliveries'];
export const BOARD_CAP = 2000;
const EVENT_TYPES = ['upsert', 'remove', 'board', 'agentlog', 'fx', 'notice', 'providers', 'settings', 'harnesses', 'roster', 'requisitions', 'toolrun', 'hb'];
/** Watchdog timing in ms: a stream that sent nothing for silentMs is checked; the check runs every everyMs. */
export const WATCH = { silentMs: 12000, everyMs: 5000 };
const IN_SNAPSHOT = new Set(['upsert', 'remove', 'board', 'providers', 'settings', 'harnesses', 'roster', 'requisitions']);
const OWNER = '@human';

/**
 * Small JSON preferences of the owner: the unread mark of the board, the hidden lab strip, the work-order draft.
 * They are written to localStorage at once. The hub picks a free port at each start and localStorage belongs to
 * http://127.0.0.1:<port>, so alone it is empty after every launch. So the hub keeps a copy in settings.ui.prefs
 * (PUT /api/settings; the contract has no route of its own for this).
 * Each write to the hub rewrites the settings file and sends a settings event to every window. So the hub gets few:
 *   prefs.set(key, value)             a value that changes seldom: the hub gets it a moment later
 *   prefs.set(key, value, Infinity)   a value that changes all the time (a draft while the owner types, the unread mark while
 *                                     the board follows its newest post): it stays in this window until prefs.flush()
 *   prefs.flush(...keys)              send what stayed here (these keys, or all): a panel closes, the window is hidden
 * A value set in this window wins over the hub's copy. Never throws. Never store a secret here.
 */
const hub = { read: () => null, write: null, queue: {}, held: {}, timer: 0, at: 0 };
const mine = new Map(); // what this window set, by key
function flushPrefs() {
  clearTimeout(hub.timer);
  hub.timer = 0;
  const patch = hub.queue;
  if (!Object.keys(patch).length) return;
  if (hub.write && hub.write(patch)) { hub.queue = {}; return; }
  hub.at = Date.now() + 5000;
  hub.timer = setTimeout(flushPrefs, 5000); // the hub is not there yet: keep the values and try again
}
export const prefs = {
  get(key, fallback = null) {
    if (mine.has(key)) { const v = mine.get(key); return v == null ? fallback : v; }
    try {
      const saved = hub.read();
      if (saved && Object.hasOwn(saved, key) && saved[key] != null) return saved[key];
    } catch { /* fall through to localStorage */ }
    try { const v = localStorage.getItem('ws.' + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  /**
   * delayMs: the longest time the hub waits for this value. Infinity: the hub does not get it until prefs.flush().
   * A pending write is never pushed back.
   */
  set(key, value, delayMs = 1200) {
    const v = value === undefined ? null : value;
    mine.set(key, v);
    try { if (v === null) localStorage.removeItem('ws.' + key); else localStorage.setItem('ws.' + key, JSON.stringify(v)); } catch { /* private mode or full: ignore */ }
    if (delayMs === Infinity) { hub.held[key] = v; delete hub.queue[key]; return; }
    delete hub.held[key];
    hub.queue[key] = v;
    const at = Date.now() + delayMs;
    if (hub.timer && hub.at <= at) return;
    clearTimeout(hub.timer);
    hub.at = at;
    hub.timer = setTimeout(flushPrefs, delayMs);
  },
  /** Send the values that stayed in this window to the hub now: the given keys, or all of them. */
  flush(...keys) {
    const list = (keys.length ? keys : Object.keys(hub.held)).filter((k) => Object.hasOwn(hub.held, k));
    if (!list.length) return;
    for (const k of list) { hub.queue[k] = hub.held[k]; delete hub.held[k]; }
    flushPrefs();
  },
};

/** Sort ids like T2 < T10. */
export function byId(a, b) {
  const x = String(a.id), y = String(b.id);
  const nx = Number(x.replace(/^\D+/, '')), ny = Number(y.replace(/^\D+/, ''));
  if (Number.isFinite(nx) && Number.isFinite(ny) && nx !== ny) return nx - ny;
  return x < y ? -1 : x > y ? 1 : 0;
}

function normProviders(p) {
  const list = Array.isArray(p) ? p : p && typeof p === 'object' ? Object.values(p) : [];
  return list.filter((x) => x && typeof x === 'object' && x.id != null);
}
function normModels(m) {
  if (!m || typeof m !== 'object') return { registry: null, leaders: null };
  if (m.registry && typeof m.registry === 'object') return { registry: m.registry, leaders: m.leaders || null };
  return Array.isArray(m.models) ? { registry: m, leaders: null } : { registry: null, leaders: null };
}
const normInbox = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
const normList = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
const normHarnesses = (v) => (Array.isArray(v) ? normList(v) : v && Array.isArray(v.harnesses) ? normList(v.harnesses) : []);

// Headless Chrome with --virtual-time-budget (the screenshot command) never finishes while a stream is open:
// an open EventSource holds virtual time still. So in headless Chrome the store polls GET /api/state once a second
// instead of opening the stream. ?stream=1 forces the stream (tests that drive headless Chrome in real time),
// ?stream=0 forces polling. A real browser and the Mac app always use the stream.
const streamParam = new URLSearchParams(location.search).get('stream');
const POLLING = streamParam === '0' || (streamParam !== '1' && /HeadlessChrome/.test(navigator.userAgent));

export function createStore({ api, watch = WATCH }) {
  const ents = Object.fromEntries(KINDS.map((k) => [k, new Map()]));
  const sorted = {};
  const subs = new Set();
  const handlers = new Map();
  const boardIds = new Map(); // id -> message
  let dirty = new Set();
  let frame = 0;

  let stream = null, retry = 0, retryTimer = 0, syncing = null, queue = [], hiddenAt = 0, stopped = false, inboxTimer = 0, sessionTried = false;
  let lastHeard = 0, watchTimer = 0, probing = false, lostAt = 0; // watchdog: lostAt = a health seq the stream had not reached yet

  const store = {
    ready: false, conn: 'connecting', seq: 0, rev: 0, polling: POLLING,
    board: [], boardRev: 0, providers: [], settings: {}, models: { registry: null, leaders: null }, inbox: [],
    harnesses: [], roster: [], requisitions: [], rlPort: null,
    boardSeenId: Number(prefs.get('boardSeen', -1)),

    get(kind, id) { const m = ents[kind]; return m && id != null ? m.get(id) || null : null; },
    list(kind, filter) {
      const m = ents[kind];
      if (!m) return [];
      const all = sorted[kind] || (sorted[kind] = [...m.values()].sort(byId));
      return filter ? all.filter(filter) : all;
    },
    /** A board message the store holds, by id. */
    msg(id) { return boardIds.get(Number(id)) || null; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    on(type, fn) {
      let set = handlers.get(type);
      if (!set) handlers.set(type, (set = new Set()));
      set.add(fn);
      return () => set.delete(fn);
    },
    set(slice, value) {
      if (slice === 'providers') store.providers = normProviders(value);
      else if (slice === 'settings') store.settings = value && typeof value === 'object' ? value : {};
      else if (slice === 'models') store.models = normModels(value);
      else if (slice === 'inbox') store.inbox = normInbox(value);
      else if (slice === 'harnesses') store.harnesses = normHarnesses(value);
      else if (slice === 'roster') store.roster = normList(value);
      else if (slice === 'requisitions') store.requisitions = normList(value);
      else if (slice === 'rlPort') store.rlPort = value && typeof value === 'object' ? value : null;
      else return;
      touch(slice);
    },
    touch,
    addBoard(msgs) { if (addBoard(msgs)) touch('board'); },
    markBoardSeen() {
      const last = store.board.length ? store.board[store.board.length - 1].id : 0;
      if (last === store.boardSeenId) return;
      store.boardSeenId = last;
      prefs.set('boardSeen', last, Infinity); // it moves with every post while the board follows: the hub gets it when the Board panel closes
      touch('board');
    },
    connect, refetch, refreshInbox, resync,
    stop() { stopped = true; clearTimeout(retryTimer); clearTimeout(inboxTimer); clearInterval(watchTimer); watchTimer = 0; closeStream(); },
  };

  // The hub's copy of the small preferences: settings.ui.prefs (the settings file keeps keys it does not know).
  hub.read = () => (store.settings && store.settings.ui && store.settings.ui.prefs) || null;
  hub.write = (patch) => {
    if (stopped) return true;
    if (!store.ready || store.conn !== 'online') return false;
    api.put('/api/settings', { patch: { ui: { prefs: patch } } }, { quiet: true, keepalive: document.hidden }); // keepalive: the window may be closing
    return true;
  };

  function touch(...slices) {
    store.rev++;
    for (const s of slices) dirty.add(s);
    if (!frame) frame = requestAnimationFrame(flush);
  }
  function flush() {
    frame = 0;
    const changes = dirty;
    dirty = new Set();
    for (const fn of [...subs]) { try { fn(changes); } catch (e) { console.error('store subscriber failed', e); } }
  }
  function fire(type, a, b) {
    const set = handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) { try { fn(a, b); } catch (e) { console.error(`store "${type}" handler failed`, e); } }
  }

  // ---- board

  function addBoard(msgs) {
    let added = false;
    const b = store.board;
    for (const m of Array.isArray(msgs) ? msgs : []) {
      if (!m || typeof m.id !== 'number' || boardIds.has(m.id)) continue;
      boardIds.set(m.id, m);
      if (!b.length || m.id > b[b.length - 1].id) b.push(m);
      else { let i = b.length; while (i > 0 && b[i - 1].id > m.id) i--; b.splice(i, 0, m); }
      added = true;
    }
    if (b.length > BOARD_CAP + 200) for (const m of b.splice(0, b.length - BOARD_CAP)) boardIds.delete(m.id);
    return added;
  }
  /** Replace stored messages whose state changed (an answered question, a passed DONE, a default taken). */
  function patchBoard(list) {
    const hit = [];
    for (const m of Array.isArray(list) ? list : list ? [list] : []) {
      if (!m || typeof m.id !== 'number' || !boardIds.has(m.id)) continue;
      const b = store.board;
      let lo = 0, hi = b.length - 1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (b[mid].id === m.id) { b[mid] = m; break; } if (b[mid].id < m.id) lo = mid + 1; else hi = mid - 1; }
      boardIds.set(m.id, m);
      hit.push(m);
    }
    if (hit.length) store.boardRev++;
    return hit;
  }
  const forOwner = (m) => !!m && (m.to === OWNER || m.from === OWNER);

  /** True when an upsert can add an item to the owner's inbox or take one away (contract section 12b). */
  function inboxMayChange(kind, prev, item) {
    if (!prev) return kind !== 'agents' && kind !== 'tasks';
    if (kind === 'jobs') return prev.status !== item.status || prev.pauseReason !== item.pauseReason || reqSig(prev) !== reqSig(item);
    if (kind === 'deliveries') return prev.status !== item.status;
    if (kind === 'projects') return prev.agentFilesAck !== item.agentFilesAck;
    return false;
  }
  const reqSig = (job) => (Array.isArray(job.requirements) ? job.requirements.map((r) => `${r.id}${r.status}`).join() : '');

  /** The inbox has no event of its own. Fetch it again shortly after something that can change it. */
  function refreshInbox() {
    if (inboxTimer || stopped || POLLING) return;
    inboxTimer = setTimeout(async () => {
      inboxTimer = 0;
      const list = await api.get('/api/inbox', { quiet: true });
      if (Array.isArray(list)) { store.inbox = normInbox(list); touch('inbox'); }
    }, 400);
  }

  // ---- snapshot and events

  function ingest(data) {
    const st = (data && data.state) || {};
    for (const kind of KINDS) {
      const src = st[kind];
      const map = ents[kind];
      map.clear();
      for (const it of Array.isArray(src) ? src : src && typeof src === 'object' ? Object.values(src) : []) if (it && it.id != null) map.set(it.id, it);
      sorted[kind] = null;
    }
    store.seq = typeof data.seq === 'number' ? data.seq : typeof st.seq === 'number' ? st.seq : 0;
    store.providers = normProviders(data.providers);
    store.settings = data.settings && typeof data.settings === 'object' ? data.settings : {};
    store.models = normModels(data.models);
    store.inbox = normInbox(data.inbox);
    store.harnesses = normHarnesses(data.harnesses);
    store.roster = normList(data.roster);
    store.requisitions = normList(data.requisitions);
    store.rlPort = data.rlPort && typeof data.rlPort === 'object' ? data.rlPort : null;
    store.board = [];
    boardIds.clear();
    store.boardRev++;
    addBoard(data.board);
    // The unread mark comes from the preferences (the hub keeps them over a restart). What was on the board before the
    // very first window opened counts as read. A stale mark from another hub run is clamped.
    const last = store.board.length ? store.board[store.board.length - 1].id : 0;
    const seen = Number(prefs.get('boardSeen', -1));
    store.boardSeenId = Number.isFinite(seen) ? seen : -1;
    if (!(store.boardSeenId >= 0) || store.boardSeenId > last) { store.boardSeenId = last; prefs.set('boardSeen', last, 10000); }
    store.ready = true;
    touch(...KINDS, 'board', 'providers', 'settings', 'models', 'inbox', 'harnesses', 'roster', 'requisitions', 'state');
  }

  /** held: the event waited while a state fetch ran, so the snapshot may hold it already. */
  function apply(evt, held = false) {
    if (typeof evt.seq === 'number') {
      if (evt.seq > store.seq) store.seq = evt.seq;
      else if (IN_SNAPSHOT.has(evt.type)) {
        // The snapshot already holds a held event. On the live stream a lower id means another hub run: load its state (section 14c).
        if (!held && evt.seq < store.seq) refetch();
        return;
      }
    }
    switch (evt.type) {
      case 'upsert': {
        const map = ents[evt.kind], item = evt.item;
        if (!map || !item || item.id == null) return;
        const prev = map.get(item.id) || null;
        map.set(item.id, item);
        sorted[evt.kind] = null;
        touch(evt.kind);
        if (inboxMayChange(evt.kind, prev, item)) refreshInbox();
        fire('upsert', evt, prev);
        break;
      }
      case 'remove': {
        const map = ents[evt.kind];
        if (!map || !map.has(evt.id)) return;
        const prev = map.get(evt.id);
        map.delete(evt.id);
        sorted[evt.kind] = null;
        touch(evt.kind);
        if (evt.kind !== 'agents') refreshInbox();
        fire('remove', evt, prev);
        break;
      }
      case 'board': {
        // patch:true is a change without a new post ({ msg: the item, changed: [the item] }). Its msg is not new: an item older
        // than what this window holds must not be added as a fresh post (it would ring and play a note).
        const changed = patchBoard(evt.changed || (evt.patch ? evt.msg : null));
        const fresh = !evt.patch && !!evt.msg && addBoard([evt.msg]);
        if (changed.length || fresh) touch('board');
        if (changed.length) fire('boardchange', changed);
        if (fresh) fire('board', evt.msg);
        if (forOwner(evt.msg) || changed.some(forOwner)) refreshInbox();
        break;
      }
      case 'providers': store.providers = normProviders(evt.providers); touch('providers'); refreshInbox(); fire('providers', evt); break;
      case 'settings': store.settings = evt.settings && typeof evt.settings === 'object' ? evt.settings : {}; touch('settings'); fire('settings', evt); break;
      case 'harnesses': store.harnesses = normHarnesses(evt.harnesses); touch('harnesses'); fire('harnesses', evt); break;
      case 'roster': store.roster = normList(evt.roster); touch('roster'); fire('roster', evt); break;
      case 'requisitions': store.requisitions = normList(evt.requisitions); touch('requisitions'); refreshInbox(); fire('requisitions', evt); break;
      case 'agentlog': case 'fx': case 'notice': case 'toolrun': fire(evt.type, evt); break;
      default: break; // unknown event types are ignored
    }
  }

  function onRaw(data, named) {
    lastHeard = Date.now();
    let evt;
    try { evt = JSON.parse(data); } catch { return; }
    if (!evt || typeof evt !== 'object') return;
    if (!evt.type && named) evt.type = named;
    if (evt.type === 'hb') return; // life only: its seq is the hub's, not an event of this stream (the watchdog asks /api/health)
    if (syncing) queue.push(evt); else apply(evt);
  }

  // ---- connection

  function setConn(c) {
    if (store.conn === c) return;
    store.conn = c;
    touch('conn');
    fire('conn', c);
  }
  function closeStream() {
    if (stream) { stream.onopen = stream.onerror = stream.onmessage = null; try { stream.close(); } catch { /* already closed */ } }
    stream = null;
  }
  /** Open the event stream from store.seq. The snapshot is not loaded again: the hub replays what came after that seq. */
  function openStream() {
    closeStream();
    let src;
    try { src = new EventSource(`/api/events?since=${encodeURIComponent(store.seq)}`); } catch { fail(); return; }
    stream = src;
    lastHeard = Date.now(); lostAt = 0;
    src.onopen = () => { if (stream === src) lastHeard = Date.now(); };
    src.onerror = () => { if (stream === src) fail(); };
    src.onmessage = (e) => { if (stream === src) onRaw(e.data, null); };
    for (const t of EVENT_TYPES) src.addEventListener(t, (e) => { if (stream === src) onRaw(e.data, t); });
    if (!watchTimer && watch && watch.everyMs > 0) watchTimer = setInterval(checkStream, watch.everyMs);
  }
  /** The watchdog (see the head of this file). */
  async function checkStream() {
    if (stopped || POLLING || !stream || syncing || probing || store.conn !== 'online') return;
    if (typeof document !== 'undefined' && document.hidden) return; // a hidden window is checked when it comes back
    if (Date.now() - lastHeard < watch.silentMs) return;
    probing = true;
    let health = null, status = 0;
    try { health = await api.get('/api/health', { quiet: true, throws: true, timeoutMs: Math.max(2000, watch.everyMs) }); } catch (e) { status = (e && e.status) || 0; }
    probing = false;
    if (stopped || !stream || syncing) return;
    if (!health || typeof health !== 'object') {
      if (status === 404) { lastHeard = Date.now(); return; } // a hub without the route: nothing to compare
      fail(status === 401);
      return;
    }
    const seq = Number(health.seq);
    if (!Number.isFinite(seq)) { lastHeard = Date.now(); return; }
    if (seq < store.seq) { lostAt = 0; connect(); return; } // another hub run
    if (seq > store.seq) {
      if (lostAt && store.seq < lostAt) { lostAt = 0; openStream(); return; } // still behind since the last look: the stream is dead
      lostAt = seq; // events may be on their way: look again at the next tick
      return;
    }
    lostAt = 0;
    lastHeard = Date.now(); // a quiet hub, and the stream holds all of it
  }
  /** Load the state again and open a new stream: after a wake, a display change, or when the network came back. */
  function resync() {
    if (stopped) return;
    retry = 0;
    connect();
  }
  function fail(locked = false) {
    closeStream();
    setConn(locked ? 'locked' : 'offline');
    if (stopped) return;
    // Locked (401): asking again on a timer only fills the hub log with refusals, and nothing changes by itself. The page
    // asks again when something can have changed: the window comes back to the front (the owner opened the link in another
    // tab), the address gets a new #k= (the Mac app loads the new link after a hub restart), or "workshop:resume".
    if (locked) { clearTimeout(retryTimer); retry++; return; }
    const delay = Math.min(10000, 500 * 2 ** retry) * (0.8 + Math.random() * 0.4);
    retry++;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, delay);
  }

  /**
   * The app opens the UI as <url>#k=<ownerKey>. Post the key once to get the session cookie, and drop the fragment.
   * The key is never stored: it lives in this function only.
   */
  async function openSession() {
    if (sessionTried) return;
    sessionTried = true;
    const m = /(?:^#|&)k=([^&]+)/.exec(location.hash || '');
    if (!m) return;
    try { history.replaceState(null, '', location.pathname + location.search); } catch { /* not allowed in this host */ }
    let k = m[1];
    try { k = decodeURIComponent(k); } catch { /* keep it as it is */ }
    await api.post('/api/session', { k }, { quiet: true });
  }

  /** Session (first time), then the state, then the stream from that seq. After a lost stream: all of it again. */
  async function connect() {
    if (stopped) return;
    clearTimeout(retryTimer);
    closeStream();
    await openSession();
    const ok = await refetch();
    if (!ok || stopped) return;
    if (POLLING) { retryTimer = setTimeout(connect, 1000); return; } // no stream: fetch the state again in a second
    openStream();
  }

  /** Fetch the whole state again. Events that arrive meanwhile are held back and replayed on top. Resolves to true when it worked. */
  function refetch() {
    if (syncing) return syncing;
    queue = [];
    syncing = (async () => {
      try {
        const data = await api.get('/api/state', { quiet: true, throws: true, timeoutMs: 20000 });
        if (!data || typeof data !== 'object') throw new Error('bad state');
        ingest(data);
        syncing = null;
        const held = queue; queue = [];
        for (const evt of held) apply(evt, true);
        retry = 0;
        setConn('online');
        fire('state');
        return true;
      } catch (e) {
        syncing = null;
        queue = [];
        fail(!!e && e.status === 401);
        return false;
      }
    })();
    return syncing;
  }

  // A stream can die silently while the Mac sleeps. Load again when the window comes back after a while.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > 60000 && store.conn === 'online') resync();
    hiddenAt = 0;
  });
  window.addEventListener('online', () => { if (store.conn !== 'online') resync(); });
  // A locked page asks again when the owner comes back to it (at most every 2 s).
  let unlockAt = 0;
  const tryUnlock = () => {
    if (store.conn !== 'locked' || (typeof document !== 'undefined' && document.hidden) || Date.now() - unlockAt < 2000) return;
    unlockAt = Date.now();
    resync();
  };
  window.addEventListener('focus', tryUnlock);
  document.addEventListener('visibilitychange', tryUnlock);
  // A new key in the address of a page that is already open. A load of the same address with only a new #k= is no page
  // load in WebKit (the Mac app after a hub restart, or the owner pasting the link): post the new key and load again.
  window.addEventListener('hashchange', () => {
    if (!/(?:^#|&)k=/.test(location.hash || '')) return;
    sessionTried = false;
    resync();
  });
  // The Mac app fires this after a wake or a display change (launcher contract): the stream may be dead without a sign.
  window.addEventListener('workshop:resume', () => resync());

  return store;
}
