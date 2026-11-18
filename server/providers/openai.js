// OpenAI Frontier Runtime Adapter (`openai`):
// Unlike Anthropic and Google (which prohibit third-party subscription mirroring and enforce API-key-only mode),
// OpenAI officially provides "Sign in with ChatGPT" (OAuth 2.0 + OIDC + PKCE `S256` with loopback callback),
// allowing open-source and local developer tools to authenticate via the OpenAI portal and route eligible requests
// against a user's ChatGPT Plus / Pro / Team subscription, alongside standard `OPENAI_API_KEY` mode.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createParser as createNormParser } from './mock.js';

const noop = () => {};
const AGENT_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'oss-agent.mjs');

export const OPENAI_ISSUER = 'https://auth.openai.com';
export const OPENAI_AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
export const OPENAI_TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
export const OPENAI_API_BASE = 'https://api.openai.com/v1';

export const OPENAI_POLICY_NOTE = Object.freeze({
  subscription: {
    lines: [
      'Uses OpenAI\'s official "Sign in with ChatGPT" OAuth 2.0 + PKCE portal flow for local & open-source tools.',
      'Delegates eligible Orchestration Officer & Review Gate turns to your ChatGPT Plus, Pro, or Team plan ($0 separate API key spend).',
      'Tokens live strictly in macOS Keychain; WorkShop never accesses your ChatGPT chat history.',
    ],
    url: 'https://openai.com/index/sign-in-with-chatgpt/',
  },
  apikey: {
    lines: [
      'Calls the OpenAI API with your saved OPENAI_API_KEY from macOS Keychain.',
      'You pay per token on your OpenAI platform billing account, bounded by your WorkShop job budget.',
      'Automated orchestration and review turns are explicitly allowed under OpenAI API terms.',
    ],
    url: 'https://openai.com/policies/business-terms/',
  },
});

function base64Url(buf) {
  return Buffer.from(buf).toString('base64url');
}

export function createPkcePair() {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  const state = base64Url(randomBytes(24));
  const nonce = base64Url(randomBytes(16));
  return { verifier, challenge, state, nonce };
}

/**
 * Inspect whether OpenAI's official `codex` CLI left an OAuth token bundle in `~/.codex/auth.json`,
 * as an optional zero-friction fallback when the user already signed in via `codex login`.
 */
function readCodexAuthFallback(homeDir) {
  if (!homeDir) return null;
  const candidate = path.join(homeDir, '.codex', 'auth.json');
  try {
    if (!fs.existsSync(candidate)) return null;
    const raw = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    const token = raw?.tokens?.access_token || raw?.access_token || null;
    if (typeof token === 'string' && token.length > 16) {
      return { accessToken: token, source: 'codex-cli' };
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Create the OpenAI Frontier adapter (`subscription` via Sign in with ChatGPT OAuth PKCE, or `apikey`).
 */
export function createOpenaiAdapter({
  shellEnv,
  getSettings = () => ({}),
  secrets = null,
  fetchImpl = globalThis.fetch,
  openUrl = null,
  log = noop,
  script = AGENT_SCRIPT,
  now = () => Date.now(),
} = {}) {
  if (!shellEnv) throw new Error('createOpenaiAdapter needs shellEnv');
  const say = (level, msg, data) => {
    try { log(level, msg, data); } catch { /* ignore */ }
  };

  let activeFlow = null; // { url, port, startedAt, close() }

  function hostId(dataDir) {
    if (!dataDir) return 'workshop-local-host';
    const f = path.join(dataDir, 'openai-host-id');
    try {
      if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
      const id = `ws_${randomBytes(12).toString('hex')}`;
      fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
      fs.writeFileSync(f, `${id}\n`, { mode: 0o600 });
      return id;
    } catch {
      return 'workshop-local-host';
    }
  }

  async function readStoredOAuth() {
    if (secrets && typeof secrets.list === 'function' && typeof secrets.get === 'function') {
      try {
        const list = await secrets.list();
        const hit = Array.isArray(list) ? list.find((k) => k.id === 'openai-oauth' && k.set === true) : null;
        if (hit) {
          const raw = await secrets.get('openai-oauth');
          if (raw) {
            try {
              const parsed = JSON.parse(raw);
              if (parsed?.accessToken) return parsed;
            } catch {
              return { accessToken: raw.trim(), source: 'keychain' };
            }
          }
        }
      } catch { /* fall through */ }
    }
    const baseEnv = shellEnv.base?.() || {};
    return readCodexAuthFallback(baseEnv.HOME || os.homedir());
  }

  async function saveOAuthBundle(bundle) {
    if (!secrets || typeof secrets.set !== 'function') return false;
    const payload = JSON.stringify({
      accessToken: bundle.accessToken,
      refreshToken: bundle.refreshToken || null,
      expiresAt: bundle.expiresAt || null,
      clientId: bundle.clientId || null,
      savedAt: now(),
    });
    await secrets.set('openai-oauth', payload, {
      label: 'OpenAI ChatGPT Sign-In (OAuth)',
      envVar: 'OPENAI_OAUTH_TOKEN',
    });
    return true;
  }

  async function refreshIfNeeded(stored) {
    if (!stored || !stored.accessToken) return null;
    if (!stored.expiresAt || stored.expiresAt > now() + 60_000 || !stored.refreshToken) {
      return stored;
    }
    try {
      const s = getSettings() || {};
      const clientId = stored.clientId || s?.openai?.clientId || 'dynamic_agent_client';
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: stored.refreshToken,
        client_id: clientId,
      });
      const res = await fetchImpl(OPENAI_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
      });
      if (!res.ok) return stored;
      const data = await res.json();
      if (data?.access_token) {
        const updated = {
          accessToken: data.access_token,
          refreshToken: data.refresh_token || stored.refreshToken,
          expiresAt: data.expires_in ? now() + Number(data.expires_in) * 1000 : null,
          clientId,
        };
        await saveOAuthBundle(updated);
        return updated;
      }
    } catch (err) {
      say('warn', 'openai: OAuth token refresh failed', { error: err?.message });
    }
    return stored;
  }

  async function hasOAuthSession() {
    const stored = await readStoredOAuth();
    return Boolean(stored?.accessToken);
  }

  /**
   * Launch OpenAI's "Sign in with ChatGPT" OAuth 2.0 + PKCE (`S256`) loopback listener on 127.0.0.1
   * and open the user's browser to `auth.openai.com`.
   */
  async function startOAuthLogin({ dataDir = null, onSignedIn = noop } = {}) {
    if (activeFlow && now() - activeFlow.startedAt < 5 * 60_000) {
      if (typeof openUrl === 'function') await openUrl(activeFlow.url).catch(() => {});
      return {
        ok: true,
        authorizeUrl: activeFlow.url,
        steps: [
          'Your browser opens to OpenAI ("Continue with ChatGPT").',
          'Sign in and authorize WorkShop to use your ChatGPT plan.',
          'The browser redirects back to WorkShop automatically (or click "I signed in" to verify).',
        ],
      };
    }
    if (activeFlow) activeFlow.close();

    const s = getSettings() || {};
    const clientId = String(s?.openai?.clientId || 'dynamic_agent_client').trim();
    const pkce = createPkcePair();
    const extHostId = hostId(dataDir);

    const server = http.createServer();
    const port = await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    const redirectUri = `http://localhost:${port}/auth/callback`;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid profile email offline_access',
      state: pkce.state,
      nonce: pkce.nonce,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
    });
    if (clientId === 'dynamic_agent_client') {
      params.set('agent_name_hint', 'WorkShop');
      params.set('ext_agent_host_id', extHostId);
    }
    const authorizeUrl = `${OPENAI_AUTHORIZE_URL}?${params.toString()}`;

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(expireTimer);
      try { server.close(); } catch { /* ignore */ }
      if (activeFlow?.server === server) activeFlow = null;
    };
    const expireTimer = setTimeout(close, 10 * 60_000);
    expireTimer.unref?.();

    server.on('request', async (req, res) => {
      try {
        const u = new URL(req.url || '/', `http://127.0.0.1:${port}`);
        if (u.pathname !== '/auth/callback') {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found');
          return;
        }
        const code = u.searchParams.get('code');
        const state = u.searchParams.get('state');
        const issuedClient = u.searchParams.get('client_id') || clientId;
        if (!code || state !== pkce.state) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><meta charset="utf-8"><title>WorkShop Sign-In</title><body style="font-family:system-ui;padding:32px"><h2>Sign-in state mismatch or cancelled</h2><p>Return to WorkShop and try "Continue with ChatGPT" again.</p></body>');
          close();
          return;
        }
        const tokenBody = new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: issuedClient,
          code_verifier: pkce.verifier,
        });
        const tokenRes = await fetchImpl(OPENAI_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: tokenBody.toString(),
        });
        if (!tokenRes.ok) {
          res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><meta charset="utf-8"><title>WorkShop Sign-In</title><body style="font-family:system-ui;padding:32px"><h2>Token exchange failed</h2><p>OpenAI returned HTTP ' + tokenRes.status + '. Check your client setup in WorkShop Settings.</p></body>');
          close();
          return;
        }
        const data = await tokenRes.json();
        const accessToken = data?.access_token || data?.id_token;
        if (!accessToken) throw new Error('No access_token in OpenAI OAuth response');
        await saveOAuthBundle({
          accessToken,
          refreshToken: data?.refresh_token || null,
          expiresAt: data?.expires_in ? now() + Number(data.expires_in) * 1000 : null,
          clientId: issuedClient,
        });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf-8"><title>Signed in to WorkShop</title><body style="font-family:system-ui;padding:32px;background:#f8f6f0;color:#1d1c22"><h2>Signed in with ChatGPT!</h2><p>Your OpenAI subscription is connected to WorkShop. You can close this tab and return to the shop.</p></body>');
        close();
        await Promise.resolve(onSignedIn()).catch(() => {});
      } catch (err) {
        say('warn', 'openai: OAuth callback failed', { error: err?.message });
        try {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Sign-in callback error. Return to WorkShop.');
        } catch { /* ignore */ }
        close();
      }
    });

    activeFlow = { url: authorizeUrl, port, server, startedAt: now(), close };
    if (typeof openUrl === 'function') {
      await openUrl(authorizeUrl).catch((err) => say('warn', 'openai: browser open failed', { error: err?.message }));
    }

    return {
      ok: true,
      authorizeUrl,
      steps: [
        'Your browser opens to OpenAI ("Continue with ChatGPT").',
        'Approve ChatGPT plan usage for WorkShop.',
        'Come back and click "I signed in" (or wait a second for automatic detection).',
      ],
    };
  }

  function buildRun({
    agent, model, effort, prompt, systemPrompt, cwd, sessionId, resume, mcp, access, runDir, mode, keyEnv, maxTurns, timeoutMs,
  } = {}) {
    if (!cwd || !runDir) throw new Error('openai: buildRun needs cwd and runDir');
    const turnFile = path.join(runDir, 'openai-turn.json');
    const payload = {
      runDir,
      cwd,
      agent: { id: agent?.id ?? null, handle: agent?.handle ?? null, role: agent?.role ?? 'boss', name: agent?.name ?? null },
      model: String(model || 'gpt-6-astra'),
      effort: effort || 'high',
      prompt: String(prompt ?? ''),
      systemPrompt: String(systemPrompt ?? ''),
      sessionId: typeof sessionId === 'string' && sessionId ? sessionId : null,
      resume: resume === true,
      access: access === 'read' ? 'read' : 'write',
      maxTurns: Number.isInteger(maxTurns) ? maxTurns : 28,
      timeoutMs: typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? timeoutMs : 30 * 60_000,
      mode: 'openai',
      baseUrl: OPENAI_API_BASE,
      engine: 'openai',
      harness: null,
      mcp: mcp?.url ? { url: String(mcp.url), token: String(mcp.token ?? '') } : null,
    };

    const env = { ...shellEnv.base() };
    const bearer = keyEnv?.OPENAI_OAUTH_TOKEN || keyEnv?.OPENAI_API_KEY || '';
    if (bearer) env.OSS_API_KEY = bearer;

    return {
      cmd: process.execPath,
      args: [script, turnFile],
      env,
      cwd,
      stdin: '',
      files: [{ path: turnFile, content: `${JSON.stringify(payload, null, 2)}\n`, cleanup: true }],
      hubFiles: {},
      sessionId: payload.sessionId,
      stopSignal: 'SIGTERM',
      authMode: mode || 'subscription',
    };
  }

  function createParser() {
    return createNormParser();
  }

  return {
    id: 'openai',
    label: 'OpenAI (ChatGPT / API)',
    lab: 'openai',
    binary: 'node',
    keyVar: 'OPENAI_API_KEY',
    selfTestModel: 'gpt-6.1-sol',
    policyNote: () => structuredClone(OPENAI_POLICY_NOTE),
    locate: () => process.execPath,
    hasOAuthSession,
    readOAuth: async () => refreshIfNeeded(await readStoredOAuth()),
    startOAuthLogin,
    dispose: () => { if (activeFlow) activeFlow.close(); },
    buildRun,
    createParser,
    classify: (text) => {
      const s = String(text || '');
      if (/\b401\b|invalid_api_key|unauthorized/i.test(s)) return { kind: 'auth', message: 'OpenAI rejected the token or API key.', resetAt: null };
      if (/\b429\b|rate_limit|quota/i.test(s)) return { kind: 'limit', message: 'OpenAI rate or plan limit reached.', resetAt: null };
      return { kind: null, message: '', resetAt: null };
    },
    loginCommand: () => ({ display: 'Continue with ChatGPT (Browser OAuth + PKCE)' }),
    installHint: () => null,
  };
}
