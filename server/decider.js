// Optional Jev decider (contract section 11b).
//
// Jev is TypeSafe AI's "System One" decision model. It writes no text: the hub sends a `state`
// and typed questions, Jev returns typed answers with probabilities. The hub uses it as a fast
// second opinion on its own decisions, here the size and the sensitivity of a planned task.
//
// Rules: active only when the owner stored the key `typesafe`. One attempt, 2 s timeout, no retry.
// Any error means "no opinion" (size null, sensitive null). sizeTask never throws. The key never
// reaches the log, a URL or an error text. The orchestrator applies an answer only to RAISE care.
//
//   createDecider({ secrets, getSettings, fetchImpl, log, redactor?, baseUrl?, model?, timeoutMs? }) -> decider
//   decider.enabled() -> boolean                 // cached; refresh() and every sizeTask() update it
//   decider.refresh() -> Promise<boolean>        // re-read whether the key is set (boot, after a key change)
//   decider.sizeTask({ title, spec, acceptance, zones }) -> Promise<{ size, sensitive, why, usd }>
//   decider.stats() -> { calls, usd, failures }

import { redactSecrets } from './shoptalk.js';

export const KEY_ID = 'typesafe';
export const GEMINI_KEY_ID = 'gemini';
export const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
export const DECISION_PATH = 'v1/systemone';
export const DEFAULT_MODEL = 'jev-1.14.0'; // pinned, so thresholds keep their meaning
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
export const DEFAULT_TIMEOUT_MS = 2000;
export const GEMINI_TIMEOUT_MS = 4000;
export const MAX_RESPONSE_CHARS = 256 * 1024;
export const USD_PER_M_INPUT = 0.042; // output is free (price of 2026-11-15)
export const COVER = 0.7;

/** Cheapest first: the pick is the smallest size that holds COVER of the probability. */
const SIZE_OF = Object.freeze({ small: 'S', medium: 'M', large: 'L' });

export const QUESTIONS = Object.freeze({
  size: {
    type: 'choice',
    instructions: 'How demanding is task? Choose the least demanding option that would still do it well.',
    criteria: {
      small: 'One well-defined change in one place.',
      medium: 'Several steps or files that must fit together.',
      large: 'A design with trade-offs where a mistake is costly.',
    },
  },
  sensitive: {
    type: 'noul',
    instructions: 'Would task change credentials, permissions, billing or a production system?',
  },
});

const noop = () => {};
const FIELD_MAX = { title: 200, spec: 4000, item: 300, items: 8, zone: 200, zones: 20 };

/** kind: config | bad_request | auth | rate_limited | overloaded | server | timeout | network | decode */
export class JevError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'JevError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

function isLoopback(hostname) {
  const h = String(hostname).replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/** The decision URL for a base URL. https only; http only for a loopback host (tests). */
export function decisionUrl(baseUrl = DEFAULT_BASE_URL) {
  let u;
  try {
    u = new URL(String(baseUrl).trim());
  } catch {
    throw new JevError('config', 'the base URL is not a URL');
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u.hostname))) {
    throw new JevError('config', 'the base URL must be https (http only for a loopback host)');
  }
  if (u.username || u.password || u.search || u.hash) {
    throw new JevError('config', 'the base URL must not carry a user name, password, query or fragment');
  }
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return new URL(DECISION_PATH, u);
}

/** What an error body says. Shapes: {detail:"..."}, {detail:{error_type,message}}, {detail:[{loc,msg}]}, {error:{message}}. */
export function errorMessage(bodyText) {
  let v;
  try {
    v = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const d = v && v.detail;
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) return d.map((e) => `${Array.isArray(e?.loc) ? e.loc.join('.') : '?'}: ${e?.msg}`).join('; ');
  if (d && typeof d === 'object') return [d.error_type, d.message].filter(Boolean).join(': ');
  const e = v && v.error;
  if (typeof e === 'string') return e;
  if (e && typeof e.message === 'string') return e.message;
  if (v && typeof v.message === 'string') return v.message;
  return null;
}

function scrub(text, key, max = 300) {
  let t = String(text ?? '').trim();
  if (key) t = t.split(key).join('[redacted]');
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

/**
 * Pick from an ordered list (cheapest first) the cheapest entry that, with every cheaper one,
 * holds at least `cover` of the probability. A split answer rounds up, never down.
 * Returns null when `probabilities` is not a usable distribution.
 */
export function coverPick(probabilities, order, cover = COVER) {
  if (!probabilities || typeof probabilities !== 'object' || !(cover > 0.5 && cover <= 1)) return null;
  const p = order.map((k) => Number(probabilities[k] ?? 0));
  if (p.some((x) => !Number.isFinite(x) || x < 0)) return null;
  const total = p.reduce((a, b) => a + b, 0);
  if (total < 0.5 || total > 1.5) return null;
  let covered = 0;
  for (let i = 0; i < order.length; i++) {
    covered += p[i] / total;
    if (covered + 1e-9 >= cover) return order[i];
  }
  return order[order.length - 1];
}

/** A yes/no probability as three bands. */
export function noulBand(p, { yes = 0.7, no = 0.3 } = {}) {
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) return 'unsettled';
  if (p >= yes) return 'yes';
  if (p <= no) return 'no';
  return 'unsettled';
}

export function costUsd(usage) {
  const n = Number(usage?.input_tokens ?? 0);
  return Number.isFinite(n) && n > 0 ? (n * USD_PER_M_INPUT) / 1e6 : 0;
}

/**
 * One call. Returns { model, answers, usage, elapsedMs, requestId }. Throws JevError.
 * The key goes only into the Authorization header; redirects are refused so it cannot travel on.
 */
export async function jevDecide({ apiKey, state, questions, model = DEFAULT_MODEL, baseUrl = DEFAULT_BASE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch, now = () => performance.now() }) {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') throw new JevError('config', 'the API key is empty');
  if (typeof model !== 'string' || model.trim() === '') throw new JevError('config', 'the model id is empty');
  if (!(timeoutMs > 0)) throw new JevError('config', 'the timeout must be longer than zero');
  if (typeof fetchImpl !== 'function') throw new JevError('config', 'no fetch function');
  const url = decisionUrl(baseUrl);
  const body = JSON.stringify({ model: model.trim(), state, questions });
  const started = now();
  let res;
  let text;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      signal: ctl.signal,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'user-agent': 'workshop-decider/0.1' },
      body,
    });
    text = await res.text();
  } catch (e) {
    if (ctl.signal.aborted || e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new JevError('timeout', `no answer within ${timeoutMs} ms`);
    }
    const cause = e?.cause?.message ? `: ${e.cause.message}` : '';
    throw new JevError('network', scrub(`could not reach the decision API (${e?.message}${cause})`, apiKey));
  } finally {
    clearTimeout(timer);
  }
  const elapsedMs = Math.round(now() - started);
  const requestId = res.headers?.get?.('x-typesafe-request-id') || res.headers?.get?.('x-request-id') || null;
  if (!res.ok) {
    const message = scrub(errorMessage(text) || `HTTP ${res.status}`, apiKey);
    const extra = { status: res.status, requestId, elapsedMs };
    if (res.status === 401 || res.status === 403) throw new JevError('auth', message, extra);
    if (res.status === 429) throw new JevError('rate_limited', message, extra);
    if (res.status === 529 || res.status === 503) throw new JevError('overloaded', message, extra);
    if (res.status === 408 || res.status >= 500) throw new JevError('server', message, extra);
    throw new JevError('bad_request', message, extra);
  }
  if (typeof text !== 'string' || text.length > MAX_RESPONSE_CHARS) throw new JevError('decode', 'the answer is too long', { requestId });
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new JevError('decode', 'the answer is not JSON', { requestId });
  }
  if (!json || typeof json.answers !== 'object' || json.answers === null) {
    throw new JevError('decode', 'the answer has no `answers` object', { requestId });
  }
  return {
    model: typeof json.model === 'string' ? json.model : '',
    answers: json.answers,
    usage: { input_tokens: Number(json.usage?.input_tokens ?? 0) || 0, output_tokens: Number(json.usage?.output_tokens ?? 0) || 0 },
    elapsedMs,
    requestId,
  };
}

function clip(value, max) {
  const s = typeof value === 'string' ? value : value == null ? '' : String(value);
  return s.length > max ? s.slice(0, max) : s;
}

export function createDecider({
  secrets, getSettings = () => ({}), fetchImpl = globalThis.fetch, log = noop, redactor = null,
  baseUrl, model, geminiBaseUrl, geminiModel, timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const say = typeof log === 'function' ? log : noop;
  const counts = { calls: 0, usd: 0, failures: 0 };
  let keySet = false;
  let geminiKeySet = false;

  /** Task text without secrets: exact stored values and live tokens, then the board's secret scan. */
  function clean(text, max) {
    let t = clip(text, max);
    try { if (redactor && typeof redactor.redact === 'function') t = redactor.redact(t); } catch { /* keep the scan below */ }
    return redactSecrets(t);
  }

  function config() {
    let s = {};
    try { s = (getSettings && getSettings()) || {}; } catch { s = {}; }
    const d = s && typeof s.decider === 'object' && s.decider ? s.decider : {};
    return {
      model: typeof model === 'string' && model ? model : typeof d.model === 'string' && d.model ? d.model : DEFAULT_MODEL,
      baseUrl: typeof baseUrl === 'string' && baseUrl ? baseUrl : DEFAULT_BASE_URL,
      geminiModel: typeof geminiModel === 'string' && geminiModel ? geminiModel : typeof d.geminiModel === 'string' && d.geminiModel ? d.geminiModel : DEFAULT_GEMINI_MODEL,
      geminiBaseUrl: typeof geminiBaseUrl === 'string' && geminiBaseUrl ? geminiBaseUrl : DEFAULT_GEMINI_BASE_URL,
      off: d.enabled === false,
    };
  }

  async function readKey(id = KEY_ID) {
    if (!secrets || typeof secrets.get !== 'function') return null;
    try {
      const v = await secrets.get(id);
      return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
    } catch {
      return null;
    }
  }

  async function refresh() {
    if (config().off) { keySet = false; geminiKeySet = false; return false; }
    if (secrets && typeof secrets.list === 'function') {
      try {
        const rows = await secrets.list();
        if (Array.isArray(rows)) {
          keySet = rows.some((r) => r && r.id === KEY_ID && r.set === true);
          geminiKeySet = rows.some((r) => r && r.id === GEMINI_KEY_ID && r.set === true);
          return keySet || geminiKeySet;
        }
      } catch { /* fall back to get */ }
    }
    keySet = (await readKey(KEY_ID)) !== null;
    geminiKeySet = (await readKey(GEMINI_KEY_ID)) !== null;
    return keySet || geminiKeySet;
  }

  function none(why) {
    return { size: null, sensitive: null, why, usd: 0 };
  }

  async function geminiJson({ apiKey, promptText, gBase, gModel, limitMs = GEMINI_TIMEOUT_MS }) {
    const url = new URL(`/v1beta/models/${encodeURIComponent(gModel)}:generateContent`, gBase.endsWith('/') ? gBase : `${gBase}/`);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
      throw new JevError('config', 'Gemini base URL must be https (or loopback http)');
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.max(timeoutMs, limitMs));
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        redirect: 'error',
        signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: promptText }] }],
          generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 160, temperature: 0 },
        }),
      });
      const rawText = await res.text();
      if (!res.ok) throw new JevError(res.status === 401 || res.status === 403 ? 'auth' : 'server', scrub(`HTTP ${res.status}`, apiKey));
      const data = JSON.parse(rawText);
      const partText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const inTok = Number(data?.usageMetadata?.promptTokenCount ?? 0) || 0;
      const outTok = Number(data?.usageMetadata?.candidatesTokenCount ?? 0) || 0;
      const usd = (inTok * 0.1 + outTok * 0.4) / 1e6;
      return { json: JSON.parse(partText), usd };
    } finally {
      clearTimeout(timer);
    }
  }

  async function sizeTask(task) {
    try {
      const cfg = config();
      if (cfg.off) { keySet = false; geminiKeySet = false; return none('The decider is off in the settings.'); }
      const apiKey = await readKey(KEY_ID);
      keySet = apiKey !== null;
      if (!apiKey) {
        const gKey = await readKey(GEMINI_KEY_ID);
        geminiKeySet = gKey !== null;
        if (!gKey) return none('The decider is off: no TypeSafe key is stored.');
        const t = task && typeof task === 'object' ? task : {};
        const promptText = `Classify software task complexity and sensitivity as JSON {"size":"S"|"M"|"L","sensitive":boolean,"why":string}.\nTitle: ${clean(t.title, 160)}\nDomain: ${clean(t.domain, 40)}\nSpec: ${clean(t.spec, 800)}`;
        counts.calls += 1;
        try {
          const r = await geminiJson({ apiKey: gKey, promptText, gBase: cfg.geminiBaseUrl, gModel: cfg.geminiModel });
          counts.usd += r.usd;
          const size = ['S', 'M', 'L'].includes(r.json?.size) ? r.json.size : null;
          const sensitive = typeof r.json?.sensitive === 'boolean' ? r.json.sensitive : null;
          return { size, sensitive, why: clean(r.json?.why || 'Gemini decision officer rated task.', 180), usd: r.usd };
        } catch (err) {
          counts.failures += 1;
          say('warn', 'decider: gemini sizing failed', { error: err?.message });
          return none('No opinion: the Gemini decision officer failed.');
        }
      }
      const t = task && typeof task === 'object' ? task : {};
      const acceptance = (Array.isArray(t.acceptance) ? t.acceptance : []).slice(0, FIELD_MAX.items).map((a) => clean(a, FIELD_MAX.item));
      const zones = (Array.isArray(t.zones) ? t.zones : []).slice(0, FIELD_MAX.zones).map((z) => clean(z, FIELD_MAX.zone));
      const state = { task: { title: clean(t.title, FIELD_MAX.title), spec: clean(t.spec, FIELD_MAX.spec), acceptance, zones } };
      counts.calls += 1;
      let r;
      try {
        r = await jevDecide({ apiKey, state, questions: QUESTIONS, model: cfg.model, baseUrl: cfg.baseUrl, timeoutMs, fetchImpl });
      } catch (e) {
        counts.failures += 1;
        const kind = e instanceof JevError ? e.kind : 'error';
        say('warn', 'decider: no opinion', { kind, status: e?.status ?? null, requestId: e?.requestId ?? null });
        return none(`No opinion: the decider call failed (${kind}).`);
      }
      const usd = costUsd(r.usage);
      counts.usd += usd;
      const pick = coverPick(r.answers?.size?.probabilities, Object.keys(SIZE_OF), COVER);
      const size = pick ? SIZE_OF[pick] : null;
      const band = noulBand(r.answers?.sensitive?.noul);
      const sensitive = band === 'yes' ? true : band === 'no' ? false : null;
      const parts = [];
      parts.push(size ? `Jev rates the task ${pick} (size ${size}).` : 'Jev gave no clear size.');
      if (sensitive === true) parts.push(`It may touch credentials, permissions, billing or production (p=${r.answers.sensitive.noul.toFixed(2)}).`);
      else if (sensitive === null) parts.push('It is not sure if the task is sensitive.');
      say('debug', 'decider: answer', { size, sensitive, ms: r.elapsedMs, requestId: r.requestId });
      return { size, sensitive, why: parts.join(' '), usd };
    } catch (e) {
      counts.failures += 1;
      say('warn', 'decider: unexpected error', { error: String(e?.name || 'error') });
      return none('No opinion: the decider failed.');
    }
  }

  /**
   * Select the surgical Specialist and Harness for a task from the Employee Book & Harness Rack.
   * Uses Gemini Decision Officer when GEMINI_API_KEY is stored, with deterministic fallback. Never throws.
   */
  async function selectSpecialist({ task, roster, harnesses } = {}) {
    const domain = clean(task?.domain || 'backend', 40);
    const match = roster?.match?.({ domain, role: 'maker' }) ?? null;
    const defaultHarness = harnesses?.forDomain?.(domain, 'maker') ?? null;
    const baseline = {
      rosterId: match?.entry?.id ?? null,
      harnessId: (match?.exactDomain ? match?.entry?.harnessId : defaultHarness?.id) || match?.entry?.harnessId || defaultHarness?.id || null,
      certified: Boolean(match?.certified),
      needsRft: match ? Boolean(match.needsRft) : true,
      reason: match?.reason ?? 'missing_specialty',
      rationale: match?.entry
        ? `${match.entry.name} (${match.entry.certification}) matched for ${domain}.`
        : `No specialist covers ${domain}.`,
      via: 'heuristic',
    };
    const cfg = config();
    if (cfg.off || !roster) return baseline;
    const gKey = await readKey(GEMINI_KEY_ID);
    geminiKeySet = gKey !== null;
    if (!gKey) return baseline;

    const candidates = roster.list({ role: 'maker', enabledOnly: true });
    const rack = harnesses?.list?.() ?? [];
    if (candidates.length === 0) return baseline;

    const summary = candidates.map((c) => ({
      id: c.id, name: c.name, specialties: c.specialties, certification: c.certification, harnessId: c.harnessId, record: c.record,
    }));
    const rackSummary = rack.map((h) => ({ id: h.id, domains: h.domains }));
    const promptText = `Select the single best specialist id and harness id as JSON {"rosterId":string,"harnessId":string,"rationale":string}.\nTask: ${clean(task?.title, 140)} | domain=${domain} | size=${clean(task?.size, 8)}\nSpecialists: ${JSON.stringify(summary)}\nHarnesses: ${JSON.stringify(rackSummary)}`;

    counts.calls += 1;
    try {
      const r = await geminiJson({ apiKey: gKey, promptText, gBase: cfg.geminiBaseUrl, gModel: cfg.geminiModel });
      counts.usd += r.usd;
      const chosen = candidates.find((c) => c.id === r.json?.rosterId);
      if (!chosen) return baseline;
      const hObj = rack.find((h) => h.id === r.json?.harnessId) || harnesses?.get?.(chosen.harnessId) || defaultHarness;
      const exact = chosen.specialties.includes(domain);
      const certified = chosen.certification === 'curated';
      return {
        rosterId: chosen.id,
        harnessId: hObj?.id ?? chosen.harnessId,
        certified: exact && certified,
        needsRft: !(exact && certified),
        reason: exact && certified ? null : exact ? 'uncertified_specialist' : 'missing_specialty',
        rationale: clean(r.json?.rationale || `${chosen.name} selected by Gemini Decision Officer.`, 180),
        via: 'gemini',
      };
    } catch (err) {
      counts.failures += 1;
      say('warn', 'decider: selectSpecialist fallback to heuristic', { error: err?.message });
      return baseline;
    }
  }

  return {
    enabled: () => (keySet || geminiKeySet) && !config().off,
    backend: () => (geminiKeySet ? 'gemini' : keySet ? 'typesafe' : 'heuristic'),
    refresh,
    sizeTask,
    selectSpecialist,
    stats: () => ({ calls: counts.calls, usd: counts.usd, failures: counts.failures }),
  };
}
