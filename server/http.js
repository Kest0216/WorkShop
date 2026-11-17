// Tiny HTTP layer: router, JSON bodies, request guards, owner session, static files, SSE.
// See docs/ARCHITECTURE.md sections 6 and 14b.
import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};
const JSON_TYPE = 'application/json; charset=utf-8';
const TEXT_TYPE = 'text/plain; charset=utf-8';
const noop = () => {};
/** Text of a request (a header, an error message that quotes the body) cut to a size that fits a log line. */
const clip = (value, max = 200) => (typeof value === 'string' && value.length > max ? `${value.slice(0, max)}...` : value);

/**
 * Wrap the injected logger so that a missing or broken logger never breaks a request.
 * `secrets()` lists values that must never reach the log (the owner key, the session value): a message
 * or a data field that holds one gets "[redacted]" in its place. A handler error may quote a request body.
 */
function safeLog(log, secrets = () => []) {
  if (typeof log !== 'function') return noop;
  const scrub = (value, list, depth = 0) => {
    if (typeof value === 'string') {
      let out = value;
      for (const secret of list) if (out.includes(secret)) out = out.split(secret).join('[redacted]');
      return out;
    }
    if (value === null || typeof value !== 'object' || depth > 4) return value;
    if (Array.isArray(value)) return value.map((child) => scrub(child, list, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([k, child]) => [k, scrub(child, list, depth + 1)]));
  };
  return (level, msg, data) => {
    try {
      const list = secrets().filter((secret) => typeof secret === 'string' && secret.length >= 8);
      log(level, scrub(msg, list), data === undefined ? undefined : scrub(data, list));
    } catch { /* logging must never throw */ }
  };
}

/** An error that the request handler turns into `status { error: message }`, with extra response headers. */
function httpError(status, message, responseHeaders) {
  return Object.assign(new Error(message), { status, responseHeaders });
}

/** '/api/jobs/J1/' -> ['api', 'jobs', 'J1'] ; '/' -> [''] */
function splitPath(pathname) {
  const parts = pathname.split('/').slice(1);
  if (parts.length > 1 && parts.at(-1) === '') parts.pop();
  return parts;
}

/** Split a request target into its raw path, decoded path segments and query object. */
function parseTarget(url) {
  const cut = url.indexOf('?');
  const rawPath = cut < 0 ? url : url.slice(0, cut);
  if (!rawPath.startsWith('/')) throw httpError(400, 'bad request path');
  try {
    const parts = splitPath(rawPath).map((part) => decodeURIComponent(part));
    const query = Object.fromEntries(new URLSearchParams(cut < 0 ? '' : url.slice(cut + 1)));
    return { rawPath, parts, query };
  } catch {
    throw httpError(400, 'bad request path');
  }
}

/**
 * JSON.parse for a request body. It drops the keys `__proto__` and `constructor.prototype`:
 * with them a handler that merges the body into an object (Object.assign, a deep merge)
 * would change the prototype of that object, or of every object in the hub.
 */
function parseBody(text) {
  const value = JSON.parse(text);
  // The walk runs only for a text that can hold such a key (also written as a \u escape).
  const risky = text.includes('__proto__') || text.includes('constructor') || text.includes('\\u');
  if (!risky || value === null || typeof value !== 'object') return value;
  const todo = [value]; // a loop, not recursion: a body may be nested very deep
  while (todo.length > 0) {
    const node = todo.pop();
    if (!Array.isArray(node)) {
      if (Object.hasOwn(node, '__proto__')) delete node.__proto__;
      const made = Object.hasOwn(node, 'constructor') ? node.constructor : null;
      if (made !== null && typeof made === 'object' && Object.hasOwn(made, 'prototype')) delete node.constructor;
    }
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      if (child !== null && typeof child === 'object') todo.push(child);
    }
  }
  return value;
}

/** Compare two secrets in constant time (both are hashed first, so the lengths do not show). */
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/** Every value that the Cookie header of a request holds for `name`. */
function cookieValues(req, name) {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return [];
  const values = [];
  for (const part of header.split(';')) {
    const cut = part.indexOf('=');
    if (cut > 0 && part.slice(0, cut).trim() === name) values.push(part.slice(cut + 1).trim());
  }
  return values;
}

/** Sequence number from a Last-Event-ID header or a ?since= value, or null. */
function parseSeq(value) {
  return typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : null;
}

/**
 * Create the hub's HTTP server (not listening yet).
 * @param {object} deps
 * @param {string} [deps.host='127.0.0.1'] bind address
 * @param {number} [deps.port=0] 0 picks a free port; listen() returns the real one
 * @param {string} [deps.uiDir] folder of the static UI files; without it only routes are served
 * @param {string} deps.ownerKey required: the secret that opens the owner session (POST /api/session { k }).
 *   Every /api route needs the session cookie. createHttp throws without a non-empty string.
 * @param {(level: string, msg: string, data?: object) => void} [deps.log]
 * @param {number} [deps.bodyLimit=2097152] largest JSON body in bytes
 * @param {number} [deps.heartbeatMs=5000] pause between SSE heartbeat messages (a test may set a short one)
 * @param {number} [deps.sseBufferLimit=4194304] an SSE client with more unsent bytes is dropped
 * @param {number} [deps.closeGraceMs=2000] time close() gives open requests before it cuts them
 * @returns {{ route: Function, sse: Function, listen: Function, close: Function }}
 */
export function createHttp({
  host = '127.0.0.1', port = 0, uiDir, ownerKey, log,
  bodyLimit = 2 * 1024 * 1024, heartbeatMs = 5000, sseBufferLimit = 4 * 1024 * 1024, closeGraceMs = 2000,
} = {}) {
  // The owner key is required (contract 14b): without it the owner API could not open. The message never holds a value.
  if (typeof ownerKey !== 'string' || ownerKey === '') throw new TypeError('createHttp needs ownerKey (a non-empty string)');
  // Contract section 6: bind 127.0.0.1 only. Another interface would open the hub to the network.
  if (host !== '127.0.0.1' && host !== 'localhost') throw new TypeError('createHttp: host must be 127.0.0.1 (or localhost)');
  // The owner key and the session value never reach the log (contract section 6), also not through a handler
  // error that quotes a body. `sessionToken` is set below, before any request can arrive.
  const say = safeLog(log, () => [ownerKey, sessionToken]);
  const uiRoot = uiDir ? path.resolve(uiDir) : null;
  const routes = [];
  const streams = new Set(); // SSE endpoints, for close()
  let server = null;
  let starting = null; // promise of listen()
  let closing = null; // promise of close()
  let allowedHosts = new Set();
  let allowedOrigins = new Set();
  let lastRefusedLog = 0;

  // ---- owner session ----
  // The browser posts the owner key once and gets a cookie. The cookie holds a token of this
  // server run, not the key. Cookies are per host and not per port: the name carries the port,
  // so two hubs on this Mac do not replace each other's cookie.
  const key = ownerKey;
  const sessionToken = randomBytes(32).toString('base64url'); // memory only: a new hub run means a new session
  let cookieName = 'workshop_owner';

  /** True when the request carries the cookie of an open owner session. */
  function isOwner(req) {
    return cookieValues(req, cookieName).some((value) => sameSecret(value, sessionToken));
  }

  // ---- responses ----
  function send(res, status, type, body, headers) {
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  }

  function sendJson(res, status, value, headers) {
    if (typeof status !== 'number') [status, value] = [200, status]; // json(obj) is accepted too
    let body;
    try {
      body = JSON.stringify(value) ?? 'null';
    } catch (err) {
      say('error', 'http: a response has no JSON form', { error: err.message });
      status = 500;
      body = '{"error":"response has no JSON form"}';
    }
    send(res, status, JSON_TYPE, body, headers);
  }

  function sendText(res, status, text, contentType) {
    if (typeof status !== 'number') [status, text] = [200, status]; // text(string) is accepted too
    send(res, status, contentType || TEXT_TYPE, String(text ?? ''));
  }

  function fail(req, res, err, pattern) {
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status <= 599 ? err.status : 500;
    const message = typeof err?.message === 'string' && err.message !== '' ? err.message : 'internal error';
    const where = `${req.method} ${pattern ?? '(no route)'}`; // the pattern, not the URL: a URL may hold an agent token
    if (status >= 500) {
      say('error', `http: ${where} failed`, { status, error: clip(String(err?.stack ?? err), 4000) });
    } else if (status === 403 || status === 401) {
      // At most one line per second: a hostile page or a local process must not be able to fill the log.
      const t = Date.now();
      if (t - lastRefusedLog >= 1000) {
        lastRefusedLog = t;
        say('warn', `http: ${where} refused`, { error: clip(message), host: clip(req.headers.host), origin: clip(req.headers.origin) });
      }
    } else {
      say('debug', `http: ${where} -> ${status}`, { error: clip(message, 1000) });
    }
    if (res.writableEnded) return; // the handler answered in full before it failed: that answer stands
    if (res.headersSent) res.destroy(); // half an answer is out: too late for an error body
    else sendJson(res, status, { error: message }, err?.responseHeaders);
  }

  // ---- guards ----
  /** Returns the reason to refuse a request, or null. Stops DNS rebinding and cross-site requests. */
  function guard(req) {
    if (!allowedHosts.has(String(req.headers.host ?? '').toLowerCase())) return 'forbidden: bad Host header';
    const { origin } = req.headers;
    if (origin !== undefined && !allowedOrigins.has(String(origin).toLowerCase())) return 'forbidden: bad Origin header';
    const safe = req.method === 'GET' || req.method === 'HEAD';
    if (!safe && String(req.headers['x-workshop'] ?? '').trim() !== '1') return 'forbidden: header X-WorkShop: 1 is required';
    return null;
  }

  // ---- body ----
  /** Read a JSON body (object or list). An empty body gives {}. Rejects with status 400 (bad JSON) or 413 (too large). */
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const hardLimit = bodyLimit * 4; // up to here the rest is read and thrown away, so the client can read the 413
      const tooLarge = (cut) => httpError(413, `request body is larger than ${bodyLimit} bytes`, cut ? { Connection: 'close' } : undefined);
      if (Number(req.headers['content-length']) > hardLimit) {
        reject(tooLarge(true));
        return;
      }
      const chunks = [];
      let size = 0;
      let done = false;
      const settle = (fn, value) => {
        if (done) return;
        done = true;
        req.off('data', onData).off('end', onEnd).off('error', onError).off('close', onClose);
        fn(value);
      };
      function onData(chunk) {
        size += chunk.length;
        if (size <= bodyLimit) {
          chunks.push(chunk);
        } else if (size > hardLimit) {
          settle(reject, tooLarge(true));
          req.resume(); // keep the socket moving until the response closes it
        } else {
          chunks.length = 0;
        }
      }
      function onEnd() {
        if (size > bodyLimit) return settle(reject, tooLarge(false));
        const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
        if (text.trim() === '') return settle(resolve, {});
        let value;
        try {
          value = parseBody(text);
        } catch {
          return settle(reject, httpError(400, 'request body is not valid JSON'));
        }
        // Handlers read fields from the body, so a bare null, number or string is refused.
        if (value === null || typeof value !== 'object') return settle(reject, httpError(400, 'request body must be a JSON object or list'));
        return settle(resolve, value);
      }
      function onError(err) {
        settle(reject, httpError(400, `request failed: ${err.message}`));
      }
      function onClose() {
        settle(reject, httpError(400, 'request was cut off'));
      }
      req.on('data', onData).on('end', onEnd).on('error', onError).on('close', onClose);
    });
  }

  // ---- router ----
  /**
   * Add a route. `pattern` is a path like '/api/jobs/:id/ship'. The handler gets
   * ctx = { req, res, params, query, body, json(status, obj), text(status, string, contentType?) }.
   * It may return a value (sent as JSON 200; a string is sent as text) or answer through ctx.
   * A thrown error becomes `500 { error }`; an error with `.status` uses that status.
   * A route under /api needs the owner cookie (401 without it) unless `options.open` is true.
   */
  function route(method, pattern, handler, options) {
    const verb = String(method).toUpperCase();
    if (typeof pattern !== 'string' || !pattern.startsWith('/')) throw new TypeError(`http.route: bad pattern "${pattern}"`);
    if (typeof handler !== 'function') throw new TypeError(`http.route: ${verb} ${pattern} needs a handler`);
    if (routes.some((r) => r.method === verb && r.pattern === pattern)) throw new Error(`http.route: ${verb} ${pattern} is already defined`);
    const parts = splitPath(pattern);
    routes.push({ method: verb, pattern, parts, handler, open: options?.open === true, fixed: parts.filter((part) => !part.startsWith(':')).length });
  }

  /** Best route for a method and path (most fixed segments wins), plus the methods of other matches. */
  function findRoute(method, parts) {
    let best = null;
    const allow = new Set();
    for (const candidate of routes) {
      if (candidate.parts.length !== parts.length) continue;
      const params = {};
      const fits = candidate.parts.every((want, i) => {
        if (!want.startsWith(':')) return want === parts[i];
        params[want.slice(1)] = parts[i];
        return parts[i] !== '';
      });
      if (!fits) continue;
      if (candidate.method !== method) allow.add(candidate.method);
      else if (best === null || candidate.fixed > best.route.fixed) best = { route: candidate, params };
    }
    return { best, allow };
  }

  async function runRoute({ route: hit, params }, req, res, query) {
    const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readBody(req);
    const ctx = {
      req, res, params, query, body,
      json: (status, value) => sendJson(res, status, value),
      text: (status, text, contentType) => sendText(res, status, text, contentType),
    };
    const result = await hit.handler(ctx);
    if (res.headersSent || res.writableEnded) return; // the handler answered through ctx or res
    if (typeof result === 'string') sendText(res, 200, result);
    else sendJson(res, 200, result === undefined ? { ok: true } : result);
  }

  // ---- static files ----
  async function serveStatic(req, res, rawPath) {
    if (uiRoot === null) throw httpError(404, 'not found');
    let decoded;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      throw httpError(400, 'bad request path');
    }
    const parts = decoded.split('/').filter((part) => part !== '');
    if (decoded.includes('\0') || decoded.includes('\\') || parts.includes('..')) throw httpError(403, 'forbidden path');
    if (parts.some((part) => part.startsWith('.'))) throw httpError(404, 'not found'); // no dotfiles
    const file = path.join(uiRoot, ...(parts.length > 0 ? parts : ['index.html']));
    let real;
    let info;
    try {
      const root = await fsp.realpath(uiRoot);
      real = await fsp.realpath(file);
      if (!real.startsWith(root + path.sep)) throw httpError(403, 'forbidden path'); // a symlink that leaves ui/
      info = await fsp.stat(real);
    } catch (err) {
      throw err.status ? err : httpError(404, 'not found');
    }
    if (!info.isFile()) throw httpError(404, 'not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD' || info.size === 0) {
      res.end();
      return;
    }
    await new Promise((resolve) => {
      pipeline(fs.createReadStream(real, { end: info.size - 1 }), res, (err) => {
        if (err) say('debug', 'http: a static file was not sent in full', { error: err.message });
        resolve();
      });
    });
  }

  // ---- request entry ----
  async function onRequest(req, res) {
    let pattern = null;
    res.on('error', noop); // a write to a closed socket must never become an uncaught error
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'SAMEORIGIN'); // no other site may frame the UI and steal a click on "ship"
      res.setHeader('Content-Security-Policy', "frame-ancestors 'none'"); // the same guard for current browsers (contract section 6)
      const denied = guard(req);
      if (denied) throw httpError(403, denied);
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      const target = parseTarget(req.url);
      const { best, allow } = findRoute(method, target.parts);
      if (best) pattern = best.route.pattern;
      // The owner API: everything under /api, known or not, before a body is read.
      if (target.parts[0] === 'api' && !best?.route.open && !isOwner(req)) throw httpError(401, 'owner session required');
      if (best) {
        await runRoute(best, req, res, target.query);
      } else if (allow.size > 0) {
        throw httpError(405, 'method not allowed', { Allow: [...allow].join(', ') });
      } else if (method !== 'GET' || target.parts[0] === 'api') {
        throw httpError(404, 'not found');
      } else {
        await serveStatic(req, res, target.rawPath);
      }
    } catch (err) {
      fail(req, res, err, pattern);
    }
  }

  // ---- server-sent events ----
  /**
   * Add an SSE endpoint (GET `pattern`). `replay(sinceSeq)` returns the events a client
   * missed; it runs when the client sends Last-Event-ID (or ?since=<seq>).
   * Every heartbeatMs one timer sends `heartbeat()` (default { type: 'hb' }) to every client as a data
   * message with NO id line: a page sees it (EventSource hides comments), and it never moves Last-Event-ID.
   * @returns {{ send(event: object): void, count(): number }} send() writes to every client;
   *   event.seq becomes the SSE id.
   */
  function sse(pattern, { replay, heartbeat } = {}) {
    const clients = new Set();
    let beat = null;

    function drop(client) {
      clients.delete(client);
      if (clients.size === 0 && beat !== null) {
        clearInterval(beat);
        beat = null;
      }
    }

    /** Write to one client. Returns false while the bytes wait in the socket buffer. */
    function write(client, chunk) {
      const { res } = client;
      if (res.destroyed || res.writableEnded) {
        drop(client);
        return true;
      }
      const flushed = res.write(chunk);
      if (res.writableLength > client.limit) {
        say('warn', 'http: an SSE client is too slow, dropped', { buffered: res.writableLength });
        drop(client);
        res.destroy();
      }
      return flushed;
    }

    function frame(event) {
      try {
        const id = Number.isSafeInteger(event?.seq) ? `id: ${event.seq}\n` : '';
        return `${id}data: ${JSON.stringify(event)}\n\n`;
      } catch (err) {
        say('error', 'http: an SSE event has no JSON form', { error: err.message });
        return null;
      }
    }

    /** The heartbeat as one data frame, never with an id line. null when it has no JSON form. */
    function beatFrame() {
      try {
        const event = typeof heartbeat === 'function' ? heartbeat() : { type: 'hb' };
        return `data: ${JSON.stringify(event ?? { type: 'hb' })}\n\n`;
      } catch (err) {
        say('error', 'http: the SSE heartbeat failed', { error: err.message });
        return null;
      }
    }

    // The handler below runs in one go, so with a caller that sends in the tick of the emit
    // every event is either in replay() or is sent after the client joined. `replayedTo`
    // covers a caller that sends later (batching): it would repeat events of the replay.
    route('GET', pattern, ({ req, res, query }) => {
      if (closing) throw httpError(503, 'server is closing');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'close', // one stream per connection: the socket ends with the stream
        'X-Accel-Buffering': 'no',
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const since = parseSeq(req.headers['last-event-id'] ?? query.since);
      let first = 'retry: 2000\n\n';
      let replayedTo = -1; // highest seq in the replay: a late live copy of such an event is skipped
      if (since !== null && typeof replay === 'function') {
        try {
          for (const event of replay(since) ?? []) {
            first += frame(event) ?? '';
            if (Number.isSafeInteger(event?.seq) && event.seq > replayedTo) replayedTo = event.seq;
          }
        } catch (err) {
          say('error', 'http: SSE replay failed', { error: String(err?.stack ?? err) });
        }
      }
      // A long replay is written in one go and may wait in the socket buffer once.
      // It does not count against the slow-client limit until the buffer has drained.
      const client = { res, replayedTo, limit: sseBufferLimit + Buffer.byteLength(first) };
      const normalLimit = () => {
        client.limit = sseBufferLimit;
      };
      res.on('close', () => drop(client));
      clients.add(client);
      if (beat === null) {
        beat = setInterval(() => {
          const chunk = beatFrame();
          if (chunk !== null) for (const each of clients) write(each, chunk);
        }, heartbeatMs);
        beat.unref();
      }
      if (write(client, first)) normalLimit();
      else res.once('drain', normalLimit);
    });

    streams.add({
      end() {
        for (const client of clients) client.res.end();
      },
    });

    return {
      send(event) {
        if (clients.size === 0) return;
        const chunk = frame(event);
        if (chunk === null) return;
        const seq = Number.isSafeInteger(event?.seq) ? event.seq : -1;
        for (const client of clients) {
          // A caller that sends later than the store emits may repeat an event of the replay.
          if (seq < 0 || seq > client.replayedTo) write(client, chunk);
        }
      },
      count: () => clients.size,
    };
  }

  // The one open route under /api: the UI posts the owner key from its URL fragment and gets the session cookie.
  route('POST', '/api/session', ({ res, body }) => {
    if (!sameSecret(body?.k, key)) throw httpError(401, 'wrong owner key');
    res.setHeader('Set-Cookie', `${cookieName}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`);
    return { ok: true };
  }, { open: true });

  // ---- lifecycle ----
  /**
   * Start listening. Resolves with the real port: { port, url }. Works once; a closed server stays closed.
   * `at` overrides the port of createHttp. A failed listen (EADDRINUSE) rejects, and listen() may be called again.
   */
  function listen(at = port) {
    if (closing) return Promise.reject(new Error('http.listen: the server was closed')); // close() could not stop it again
    if (server !== null) return Promise.reject(new Error('http.listen was already called'));
    if (!Number.isInteger(at) || at < 0 || at > 65535) return Promise.reject(new TypeError('http.listen: the port must be 0 to 65535'));
    const created = http.createServer({ noDelay: true }, (req, res) => {
      onRequest(req, res).catch((err) => {
        say('error', 'http: request handling failed', { error: String(err?.stack ?? err) });
        res.destroy();
      });
    });
    server = created; // Node's default 'clientError' handling answers 400 and closes a broken connection
    starting = new Promise((resolve, reject) => {
      const onError = (err) => {
        server = null;
        reject(err);
      };
      created.once('error', onError);
      created.listen(at, host, () => {
        created.off('error', onError);
        created.on('error', (err) => say('error', 'http: server error', { error: err.message }));
        const actual = created.address().port;
        cookieName = `workshop_owner_${actual}`;
        allowedHosts = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]);
        allowedOrigins = new Set([...allowedHosts].map((name) => `http://${name}`));
        resolve({ port: actual, url: `http://${host}:${actual}` });
      });
    });
    return starting;
  }

  /** End the SSE clients and stop the server. Resolves when every connection is closed. Never rejects. */
  function close() {
    if (closing) return closing;
    closing = (async () => {
      for (const stream of streams) stream.end();
      if (starting !== null) await starting.catch(noop); // a listen() that is still on its way
      const current = server;
      if (current === null) return;
      await new Promise((resolve) => {
        const force = setTimeout(() => current.closeAllConnections(), closeGraceMs);
        current.close(() => {
          clearTimeout(force);
          resolve();
        });
        current.closeIdleConnections();
      });
    })();
    return closing;
  }

  return { route, sse, listen, close };
}
