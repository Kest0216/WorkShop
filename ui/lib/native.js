// Bridge to the Mac app. Inside WorkShop.app the page runs in a WKWebView that offers
//   window.webkit.messageHandlers.workshop.postMessage(msg) -> Promise<answer>
// In a plain browser there is no bridge: every call is a no-op that resolves to null, and the page uses the hub routes instead.
// This file imports nothing, so node tests can load it with a fake window.
//
//   createNative({ win? }) -> native
//     native.available                 true inside the Mac app
//     native.notify(title, body?)      -> { ok, shown } | null     a macOS notification
//     native.badge(count)              -> answer | null            the Dock badge (0 clears it). The same count twice sends once.
//     native.quitState(live)           -> answer | null            tells the app whether a live job runs (it asks before it quits). Sent on change only.
//     native.pickFolder()              -> { path: string|null } | null    the folder dialog; null: the bridge failed (use POST /api/pick-folder)
//     native.reveal(path)              -> true | false             Finder; false: the bridge is missing or refused (use POST /api/reveal)
// No call ever throws. Nothing secret goes through the bridge.

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 3) + '...' : t; };

export function createNative({ win = typeof window !== 'undefined' ? window : null } = {}) {
  const handler = () => {
    try {
      const h = win && win.webkit && win.webkit.messageHandlers && win.webkit.messageHandlers.workshop;
      return h && typeof h.postMessage === 'function' ? h : null;
    } catch { return null; }
  };
  let lastBadge = null, lastLive = null;

  /** Send one message. Resolves to the app's answer (an object), { ok: true } when the app sends none, or null on failure. */
  async function send(msg) {
    const h = handler();
    if (!h) return null;
    try {
      const res = await h.postMessage(msg);
      if (res === undefined || res === null) return { ok: true };
      return typeof res === 'object' ? res : { ok: true, value: res };
    } catch { return null; }
  }

  return {
    get available() { return !!handler(); },
    send,
    notify(title, body) {
      const t = clip(title, 120);
      if (!t) return Promise.resolve(null);
      const msg = { type: 'notify', title: t };
      const b = clip(body, 400);
      if (b) msg.body = b;
      return send(msg);
    },
    async badge(count) {
      const n = Math.max(0, Math.floor(Number(count) || 0));
      if (!handler() || n === lastBadge) return null;
      lastBadge = n;
      const res = await send({ type: 'badge', count: n });
      if (!res) lastBadge = null; // try again next time
      return res;
    },
    async quitState(live) {
      const v = !!live;
      if (!handler() || v === lastLive) return null;
      lastLive = v;
      const res = await send({ type: 'quitState', live: v });
      if (!res) lastLive = null;
      return res;
    },
    async pickFolder() {
      const res = await send({ type: 'pickFolder' });
      if (!res || res.ok === false) return null;
      return { path: typeof res.path === 'string' && res.path ? res.path : null };
    },
    async reveal(path) {
      const p = String(path ?? '');
      if (!p.startsWith('/')) return false;
      const res = await send({ type: 'reveal', path: p });
      return !!res && res.ok !== false;
    },
  };
}
