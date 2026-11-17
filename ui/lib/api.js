// API client for the hub. Every non-GET request carries "X-WorkShop: 1" and a JSON body.
// A failed call shows a toast and resolves to undefined, so a caller can write:
//     const job = await api.post('/api/jobs', order);  if (!job) return;
// Pass { throws: true } to get a rejected ApiError instead, and { quiet: true } to skip the toast.

export class ApiError extends Error {
  constructor(message, status) { super(message); this.name = 'ApiError'; this.status = status; }
}

/**
 * createApi({ onError(message, status), base? }) -> api
 *   api.get(path, opts?)          api.post(path, body?, opts?)
 *   api.put(path, body?, opts?)   api.del(path, body?, opts?)
 *   opts: { quiet?: boolean, throws?: boolean, timeoutMs?: number, keepalive?: boolean }
 *         keepalive: the request may outlive the page (a last write while the window closes). Browsers allow it for small bodies only.
 * JSON responses are parsed; anything else comes back as text.
 */
export function createApi({ onError = () => {}, base = '' } = {}) {
  async function request(method, path, body, opts = {}) {
    const { quiet = false, throws = false, timeoutMs = 60000, keepalive = false } = opts;
    const init = { method, headers: { Accept: 'application/json, text/plain' }, cache: 'no-store' };
    if (method !== 'GET') {
      init.headers['X-WorkShop'] = '1';
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body == null ? {} : body);
      if (keepalive && init.body.length < 60000) init.keepalive = true;
    }
    const ctl = new AbortController();
    init.signal = ctl.signal;
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let error;
    try {
      const res = await fetch(base + path, init);
      const type = res.headers.get('content-type') || '';
      let data;
      if (type.includes('application/json')) { try { data = await res.json(); } catch { data = undefined; } } else data = await res.text();
      if (res.ok) return data === undefined ? {} : data;
      const message = data && typeof data === 'object' && typeof data.error === 'string' ? data.error
        : `The hub answered ${res.status}${typeof data === 'string' && data && data.length < 200 ? ': ' + data : ''}.`;
      error = new ApiError(message, res.status);
    } catch (e) {
      error = new ApiError(e && e.name === 'AbortError' ? 'The hub took too long to answer.' : 'The hub does not answer.', 0);
    } finally {
      clearTimeout(timer);
    }
    if (!quiet) { try { onError(error.message, error.status); } catch { /* a toast must never break a call */ } }
    if (throws) throw error;
    return undefined;
  }

  return {
    request,
    get: (path, opts) => request('GET', path, undefined, opts),
    post: (path, body, opts) => request('POST', path, body, opts),
    put: (path, body, opts) => request('PUT', path, body, opts),
    del: (path, body, opts) => request('DELETE', path, body, opts),
  };
}
