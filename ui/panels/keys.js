// Runtimes & Keys view (mounted inside Settings -> Runtimes & Keys, and kept as a module for standalone compatibility).
// Policy:
//   - OpenAI: supports official "Sign in with ChatGPT" (OAuth 2.0 + PKCE portal flow) AND OPENAI_API_KEY.
//   - Gemini & Claude: strictly API-key-only (Anthropic and Google prohibit third-party OAuth / subscription mirroring).
//   - Local OSS: $0 open-weight runtime (Ollama / vLLM / SGLang / llama.cpp / Stand-in).
// Rule: a key value never stays in the DOM or in JS after it is saved. Only the last-4 hint from GET /api/keys shows.

import { h, mount, keyed } from '../lib/dom.js';
import * as ui from '../lib/widgets.js';

const fmt = ui.fmt;
const enc = encodeURIComponent;
const LAB_OF_KEY = { anthropic: 'claude', gemini: 'gemini', openai: 'openai', oss: 'oss' };
const KEY_OF_LAB = { claude: 'anthropic', gemini: 'gemini', openai: 'openai', oss: 'oss' };
const KEY_NOTES = {
  openai: 'Optional OPENAI_API_KEY when OpenAI is in API key mode. Not needed when using "Continue with ChatGPT" subscription sign-in.',
  gemini: 'API key mode only (Google prohibits third-party OAuth mirroring): powers Gemini Officers, Review Gates, and routing.',
  anthropic: 'API key mode only (Anthropic prohibits third-party OAuth mirroring): powers Claude Officers and Final Review Gates.',
  oss: 'Optional bearer token for authenticated remote Ollama, vLLM, or SGLang endpoints. Leave empty for local servers.',
  typesafe: 'Optional TypeSafe Jev task-sizing key. When unset, your active Officer runtime handles routing.',
  'rl-port': 'Bearer token (RL_PORT_TOKEN) sent in Authorization header when connecting to a Remote RL Compute Cluster.',
};
const AUTH_WORD = { ok: 'signed in with ChatGPT', none: 'not signed in', unknown: 'not checked yet' };

let view = null;

function part(node, sig, build) {
  if (node.__sig === sig) return;
  node.__sig = sig;
  mount(node, build());
}

function labSig(ctx, p) {
  const st = (ctx.store.settings.selfTest || {})[p.id];
  const res = ctx.labs.results.get(p.id);
  return JSON.stringify([p.id, p.label, p.lab, p.installed, p.version, p.path, p.auth, p.mode, p.ack, p.keySet, p.usable, p.reason, p.cooling, p.cooledModels, p.selfTest, p.loginCmd, !!p.installHint,
    Array.isArray(p.models) ? p.models.length : null, p.limit && [p.limit.status, p.limit.utilization, p.limit.resetAt], p.policyNote, st && [st.ok, st.ts, st.version], res && res.loaded, ctx.store.settings.safety,
    ctx.labs.signinOpen(p)]);
}

const PRIMARY_KEYS = new Set(['openai', 'gemini', 'anthropic', 'oss']);
const LAB_ORDER = { oss: 0, openai: 1, gemini: 2, claude: 3 };

function ossCard(ctx, p) {
  const { labs, store } = ctx;
  const ossCfg = (store.settings && store.settings.oss) || {};
  const tone = p.usable ? 'ok' : 'warn';
  const st = (store.settings.selfTest || {})[p.id] || null;
  const session = labs.results.get(p.id) || null;
  const eng = ui.select([
    { value: 'ollama', label: 'Ollama (/v1)' },
    { value: 'vllm', label: 'vLLM gateway' },
    { value: 'sglang', label: 'SGLang server' },
    { value: 'llamacpp', label: 'llama.cpp server' },
    { value: 'openai', label: 'OpenAI-compatible' },
    { value: 'command', label: 'Custom command harness' },
  ], String(ossCfg.engine || 'ollama'));
  const baseUrl = h('input', { type: 'text', autocomplete: 'off', spellcheck: false, value: String(ossCfg.baseUrl || 'http://127.0.0.1:11434/v1'), placeholder: 'http://127.0.0.1:11434/v1' });
  const standIn = ui.checkbox('Enable Stand-in simulation ($0, zero local GPU required)', !!ossCfg.standIn);
  const saveBtn = ui.btn('Save & Probe', { tone: 'go', small: true, type: 'submit' });
  const saveOss = () => ui.busy(saveBtn, async () => {
    const patch = { engine: eng.select.value, baseUrl: baseUrl.value.trim(), standIn: !!standIn.input.checked };
    const res = await ctx.api.put('/api/providers/oss', patch);
    if (!res) return;
    const settings = await ctx.api.get('/api/settings', { quiet: true });
    if (settings) store.set('settings', settings);
    await labs.reload();
    ctx.toast(res.usable ? 'Open-Weight Runtime saved and ready.' : `OSS saved: ${res.reason || 'endpoint unreachable'}`);
  });
  const note = p.mode && p.policyNote && p.policyNote[p.mode] ? p.policyNote[p.mode] : p.policyNote && (p.policyNote.local || p.policyNote.standin);
  return h('article', { class: ['ky-lab', tone], dataset: { lab: p.id } },
    h('header.ky-labhead', h('span', { class: ['lab-dot', tone] }), h('span.ky-labname', String(p.label || p.id)), ui.labChip(p.id, 'oss · $0'),
      h('span.grow'), ui.chip(p.usable ? (p.mode === 'standin' ? 'stand-in active' : 'ready') : 'needs setup', p.usable ? 'green' : 'amber')),
    !p.usable ? h('p.ky-reason', String(p.reason || 'Local OSS endpoint is unreachable. Start Ollama/vLLM or enable Stand-in below.')) : null,
    h('dl.kv',
      h('dt', 'Role'), h('dd', 'Specialist Agent Brains ($0 / 1M tokens · Eligible for RL Forge)'),
      h('dt', 'Mode'), h('dd', p.mode === 'standin' ? 'Stand-in simulation ([SIM] RL)' : `Local/Cluster endpoint (${ossCfg.engine || 'ollama'})`),
      Array.isArray(p.models) ? [h('dt', 'Detected'), h('dd', { title: p.models.join('\n') }, p.models.length ? `${fmt.plural(p.models.length, 'model')}: ${p.models.slice(0, 4).join(', ')}` : 'none detected yet')] : null),
    h('form.oss-form', { novalidate: true, onsubmit: (e) => { e.preventDefault(); saveOss(); } },
      h('div.oss-cfg', ui.field('Engine', eng), ui.field('Base URL', baseUrl)),
      standIn,
      h('div.ky-acts', saveBtn,
        ui.btn('Re-check', { small: true, onClick: (e) => labs.recheckLab(p, e.currentTarget) }),
        ui.btn('Add bearer key', { small: true, onClick: () => focusKey('oss') }),
        ui.btn('Test', { small: true, onClick: (e) => labs.test(p, e.currentTarget) }))),
    note && Array.isArray(note.lines) && note.lines.length ? ui.fold('OSS runtime notes', () => h('ul.lab-policy', note.lines.map((l) => h('li', String(l))))) : null,
    session ? labs.resultView(p, session) : st && (Array.isArray(st.core) || Array.isArray(st.advisory)) ? ui.fold('Self-test results', () => labs.resultView(p, { ok: st.ok, core: st.core, advisory: st.advisory })) : null);
}

function openaiCard(ctx, p) {
  const { labs, store } = ctx;
  const step = labs.step(p);
  const st = (store.settings.selfTest || {})[p.id] || null;
  const session = labs.results.get(p.id) || null;
  const waitingSignin = labs.signinOpen(p);
  const tone = p.usable ? 'ok' : step === 'cooling' ? 'warn' : 'idle';
  const badgeText = p.usable ? (p.mode === 'subscription' ? 'ChatGPT signed in' : 'API key ready') : step === 'signin' ? 'sign-in needed' : step === 'test' ? 'needs self-test' : 'not set up';
  const badgeTone = p.usable ? 'green' : step === 'signin' || step === 'test' ? 'amber' : 'steel';
  const sandboxed = (store.settings.safety || 'sandboxed') === 'sandboxed';
  const note = (p.policyNote && (p.policyNote[p.mode || 'subscription'] || p.policyNote.subscription)) || null;

  const acts = [
    ui.btn(p.mode === 'subscription' && p.auth === 'ok' ? 'Re-authenticate ChatGPT' : 'Continue with ChatGPT', {
      small: true,
      tone: p.mode !== 'subscription' || p.auth !== 'ok' ? 'go' : undefined,
      title: 'Official OpenAI Sign in with ChatGPT OAuth 2.0 + PKCE portal flow',
      onClick: async (e) => {
        const btn = e.currentTarget;
        if (p.mode !== 'subscription' || p.ack === false) {
          const ok = await labs.chooseMode(p, 'subscription', btn);
          if (!ok) return;
        }
        await labs.signin(p, btn);
      },
    }),
    waitingSignin || (p.mode === 'subscription' && p.auth !== 'ok')
      ? ui.btn('I signed in · Check', { small: true, tone: 'primary', onClick: (e) => labs.recheckLab(p, e.currentTarget, { signedIn: true }) })
      : null,
    ui.btn(p.mode === 'apikey' ? (p.keySet ? 'Switch / Manage API Key' : 'Add OPENAI_API_KEY') : 'Use API key instead', {
      small: true,
      tone: p.mode === 'apikey' && !p.keySet ? 'primary' : undefined,
      onClick: async (e) => {
        if (p.mode !== 'apikey' || p.ack === false) await labs.chooseMode(p, 'apikey', e.currentTarget);
        if (!p.keySet) focusKey('openai');
      },
    }),
    ui.btn('Re-check', { small: true, onClick: (e) => labs.recheckLab(p, e.currentTarget) }),
    ui.btn('Test', { small: true, tone: step === 'test' ? 'primary' : undefined, onClick: (e) => labs.test(p, e.currentTarget) }),
  ];

  return h('article', { class: ['ky-lab', tone], dataset: { lab: p.id } },
    h('header.ky-labhead', h('span', { class: ['lab-dot', tone] }), h('span.ky-labname', String(p.label || 'OpenAI')), ui.labChip('openai', 'openai · SIWC / API'),
      h('span.grow'), ui.chip(badgeText, badgeTone)),
    !p.usable ? h('p.ky-statusline', String(p.reason || 'Sign in with your ChatGPT subscription portal or configure OPENAI_API_KEY.')) : null,
    h('dl.kv',
      h('dt', 'Role'), h('dd', 'Frontier Orchestration Officer & Final Review Gate (Closed weights · Blocked from RL Forge)'),
      h('dt', 'Auth'), h('dd', p.mode === 'subscription'
        ? `${AUTH_WORD[p.auth] || p.auth} (Sign in with ChatGPT OAuth + PKCE)`
        : p.mode === 'apikey'
          ? (p.keySet ? 'OPENAI_API_KEY saved in Keychain' : 'API key mode selected — paste OPENAI_API_KEY below')
          : h('span.dim', 'Choose "Continue with ChatGPT" or "Use API key"')),
      Array.isArray(p.models) ? [h('dt', 'Models'), h('dd', p.models.join(', '))] : null),
    h('p.ky-bill', labs.billing(p.mode || 'subscription')),
    note && Array.isArray(note.lines) && note.lines.length ? ui.fold('OpenAI portal & policy note', () => [h('ul.lab-policy', note.lines.map((l) => h('li', String(l)))), note.url ? h('p', ui.extLink('OpenAI Sign in with ChatGPT docs', note.url)) : null]) : null,
    h('div.ky-acts', acts),
    h('div.ky-test',
      h('div.row', h('span.caps', 'Self-test'),
        st ? [ui.chip(st.ok ? 'passed' : 'failed', st.ok ? 'green' : 'red'), h('span.dim', fmt.date(st.ts))]
          : h('span.dim', sandboxed ? 'not run yet. Required in safety mode "sandboxed".' : 'optional in safety mode "trusting".')),
      session ? labs.resultView(p, session)
        : st && (Array.isArray(st.core) || Array.isArray(st.advisory)) ? ui.fold('Core and advisory results', () => labs.resultView(p, { ok: st.ok, core: st.core, advisory: st.advisory })) : null));
}

function labCard(ctx, p) {
  if (p.id === 'oss') return ossCard(ctx, p);
  if (p.id === 'openai') return openaiCard(ctx, p);
  const { labs, store } = ctx;
  const step = labs.step(p);
  const cooling = p.cooling && p.cooling.until > Date.now() ? p.cooling : null;
  const st = (store.settings.selfTest || {})[p.id] || null;
  const session = labs.results.get(p.id) || null;
  const broken = !p.usable && (p.auth === 'none' || (p.keySet && p.mode === 'apikey' && /refused/i.test(String(p.reason || ''))) || (step === 'test' && st && st.ok === false));
  const tone = p.usable ? 'ok' : step === 'cooling' ? 'warn' : broken ? 'bad' : 'idle';
  const badgeText = p.usable ? 'ready' : step === 'cooling' ? 'cooling' : broken ? 'error' : step === 'test' ? 'needs self-test' : 'not set up';
  const badgeTone = p.usable ? 'green' : step === 'cooling' ? 'amber' : broken ? 'red' : step === 'test' ? 'amber' : 'steel';
  const sandboxed = (store.settings.safety || 'sandboxed') === 'sandboxed';
  const note = (p.policyNote && p.policyNote.apikey) || null;
  const cooled = p.cooledModels && typeof p.cooledModels === 'object' ? Object.entries(p.cooledModels).filter(([, c]) => c && c.until > Date.now()) : [];
  const limit = p.limit && typeof p.limit === 'object' ? p.limit : null;
  const needsAck = p.mode !== 'apikey' || p.ack === false;

  const acts = [
    !p.installed ? ui.btn('Install', { small: true, tone: step === 'install' ? 'primary' : undefined, title: 'Show how to install it. The hub installs nothing.', onClick: () => labs.install(p) }) : null,
    p.installed && needsAck ? ui.btn('Use API key', { small: true, tone: step === 'mode' || step === 'signin' ? 'primary' : undefined, onClick: (e) => labs.chooseMode(p, 'apikey', e.currentTarget) }) : null,
    p.installed && !needsAck && !p.keySet ? ui.btn('Add the key', { small: true, tone: 'primary', onClick: () => focusKey(KEY_OF_LAB[p.id]) }) : null,
    ui.btn('Re-check', { small: true, title: 'Look again for this CLI and API key status', onClick: (e) => labs.recheckLab(p, e.currentTarget) }),
    p.installed ? ui.btn('Test', { small: true, tone: step === 'test' ? 'primary' : undefined, title: 'Self-test: one tiny real turn that must stay inside the sandbox', onClick: (e) => labs.test(p, e.currentTarget) }) : null,
  ];

  return h('article', { class: ['ky-lab', tone], dataset: { lab: p.id } },
    h('header.ky-labhead', h('span', { class: ['lab-dot', tone] }), h('span.ky-labname', String(p.label || p.id)), ui.labChip(p.id, p.lab || p.id),
      h('span.grow'), ui.chip(badgeText, badgeTone)),
    !p.usable ? (broken || tone === 'warn'
      ? h('p.ky-reason', String(p.reason || 'This runtime hit an error.'))
      : h('p.ky-statusline', String(p.reason || 'Optional unless you choose this runtime.'))) : null,
    h('dl.kv',
      h('dt', 'Program'), h('dd', p.installed ? [h('span.strong', String(p.version || 'installed')), p.path ? h('span.dim', ` ${p.path}`) : null] : h('span.dim', 'not installed')),
      h('dt', 'Role'), h('dd', 'Frontier Orchestration Officer & Final Review Gate (API key only · OAuth disabled)'),
      h('dt', 'Auth'), h('dd', p.mode === 'apikey' && p.ack !== false ? (p.keySet ? 'API key saved' : h('span.dim', 'API key not saved yet')) : h('span.dim', 'API key mode only (subscription mirroring prohibited by provider)')),
      limit ? [h('dt', 'Plan limit'), h('dd', `${String(limit.status || 'unknown').replace(/_/g, ' ')}${typeof limit.utilization === 'number' ? `, ${fmt.pct(limit.utilization)} used` : ''}${limit.resetAt ? `, resets ${fmt.time(limit.resetAt)} (${fmt.until(limit.resetAt)})` : ''}`)] : null,
      cooling ? [h('dt', 'Cooling'), h('dd', ui.chip(`until ${fmt.time(cooling.until)}`, 'amber'), ' ', String(cooling.reason || ''))] : null,
      cooled.length ? [h('dt', 'Cooled models'), h('dd', cooled.map(([m, c]) => h('div', h('span.code', m), ` until ${fmt.time(c.until)}`)))] : null,
      Array.isArray(p.models) ? [h('dt', 'Models'), h('dd', { title: p.models.join('\n') }, `${fmt.plural(p.models.length, 'model')}`)] : null),
    h('p.ky-bill', labs.billing('apikey')),
    note && Array.isArray(note.lines) && note.lines.length ? ui.fold('Policy note of the runtime', () => [h('ul.lab-policy', note.lines.map((l) => h('li', String(l)))), note.url ? h('p', ui.extLink('Read the terms of the lab', note.url)) : null]) : null,
    h('div.ky-acts', acts),
    h('div.ky-test',
      h('div.row', h('span.caps', 'Self-test'),
        st ? [ui.chip(st.ok ? 'passed' : 'failed', st.ok ? 'green' : 'red'), h('span.dim', `${fmt.date(st.ts)}${st.version ? `, version ${st.version}` : ''}${p.version && st.version && st.version !== p.version ? '. The program changed since: test again.' : ''}`)]
          : h('span.dim', sandboxed ? 'not run yet. Required in safety mode "sandboxed".' : 'not run yet. Safety mode "trusting" does not need it.')),
      session ? labs.resultView(p, session)
        : st && (Array.isArray(st.core) || Array.isArray(st.advisory)) ? ui.fold('Core and advisory results', () => labs.resultView(p, { ok: st.ok, core: st.core, advisory: st.advisory })) : null));
}

function refreshLabs(ctx) {
  if (!view) return;
  const list = ctx.sel.labs(ctx.store).slice().sort((a, b) => (LAB_ORDER[a.id] ?? 9) - (LAB_ORDER[b.id] ?? 9));
  part(view.labsHead, String(list.length), () => (list.length ? null : h('p.dim', 'The hub lists no lab.')));
  keyed(view.labs, list, { key: (p) => p.id, sig: (p) => labSig(ctx, p), render: (p) => labCard(ctx, p) });
}

export function focusKey(id) {
  if (!view) return;
  const sel = `[data-key="${String(id).replace(/[^A-Za-z0-9_-]/g, '')}"]`;
  const row = view.keys.querySelector(sel) || view.extraKeys.querySelector(sel);
  if (!row) return;
  if (view.extraKeys.contains(row) && !view.extraFold.isOpen) {
    view.extraOpen = true;
    view.extraFold.setOpen(true);
  }
  row.scrollIntoView({ block: 'center' });
  const input = row.querySelector('input[type="password"]');
  if (input) input.focus({ preventScroll: true });
}

async function loadKeys(ctx) {
  const list = await ctx.api.get('/api/keys', { quiet: true, throws: true }).catch((e) => ({ failed: (e && e.message) || 'The hub does not answer.' }));
  if (!view) return;
  if (!Array.isArray(list)) { view.keyList = null; view.keyError = (list && list.failed) || 'The hub sent no key list.'; } else { view.keyList = list; view.keyError = null; }
  refreshKeys(ctx);
}

function offerApiMode(ctx, keyId) {
  const p = ctx.store.providers.find((x) => x.id === LAB_OF_KEY[keyId]);
  if (p && !p.mode) ctx.toast(`${p.label || p.id} has no sign-in mode yet. Use this key for it?`, 'info', { sticky: true, key: 'mode-' + p.id, action: { label: 'Use the API key', run: () => ctx.labs.chooseMode(p, 'apikey') } });
}

function keyRow(ctx, k) {
  const known = Object.hasOwn(KEY_NOTES, k.id);
  const input = h('input', { type: 'password', autocomplete: 'new-password', spellcheck: false, placeholder: k.set ? 'Type a new value to replace it' : 'Paste the key', 'aria-label': `Value of ${k.label || k.id}` });
  const err = h('div.field-error', { role: 'alert' });
  const save = ui.btn('Save', { type: 'submit', tone: 'go', small: true });
  async function submit() {
    const value = input.value.trim();
    if (!value) { err.textContent = 'Paste the key first.'; input.focus(); return; }
    err.textContent = '';
    await ui.busy(save, async () => {
      const res = await ctx.api.put(`/api/keys/${enc(k.id)}`, { value });
      if (!res) return;
      input.value = '';
      ctx.toast(`${k.label || k.id} is saved. Only its last 4 characters show from now on.`);
      await loadKeys(ctx);
      ctx.labs.reload();
      if (!k.set) offerApiMode(ctx, k.id);
    });
  }
  return h('form.ky-key', { novalidate: true, autocomplete: 'off', dataset: { key: k.id }, onsubmit: (e) => { e.preventDefault(); submit(); } },
    h('input', { type: 'text', autocomplete: 'username', value: String(k.envVar || k.id), hidden: true, readOnly: true, tabIndex: -1, 'aria-hidden': 'true' }),
    h('div.ky-keytop',
      h('span.strong', String(k.label || k.id)), h('span.code', String(k.envVar || '')),
      h('span.grow'),
      ui.chip(k.set ? 'set' : 'not set', k.set ? 'green' : 'plain')),
    h('div.ky-keymeta',
      k.set ? [h('span', 'ends in ', h('span.code.ky-hint', '…' + String(k.hint || '????'))), h('span.dim', k.updatedAt ? `saved ${fmt.date(k.updatedAt)} (${fmt.ago(k.updatedAt)})` : '')] : h('span.dim', 'No value is stored.')),
    known ? h('p.ky-note', KEY_NOTES[k.id]) : h('p.ky-note', `Custom key "${k.id}". The hub passes it to no lab by itself.`),
    h('div.ky-keyrow', input, save,
      k.set ? ui.btn('Remove', { small: true, title: known ? 'Delete the stored value' : 'Delete this key', onClick: async (e) => {
        const button = e.currentTarget;
        const ok = await ctx.confirm({ title: `Remove ${k.label || k.id}?`, text: `The stored value is deleted from the Keychain.${LAB_OF_KEY[k.id] ? ' A lab in API key mode stops working until you save a new key.' : ''}`, okLabel: 'Remove', danger: true });
        if (!ok) return;
        await ui.busy(button, async () => { const res = await ctx.api.del(`/api/keys/${enc(k.id)}`); if (res) { input.value = ''; ctx.toast(`${k.label || k.id} is removed.`); await loadKeys(ctx); ctx.labs.reload(); } });
      } }) : null),
    err);
}

function refreshKeys(ctx) {
  if (!view) return;
  const list = view.keyList;
  part(view.keysHead, list ? 'ok' : view.keyError ? 'err:' + view.keyError : 'wait', () => (list ? null
    : view.keyError ? h('div.callout.bad', h('div.callout-title', 'The keys did not load'), h('p', String(view.keyError)), ui.btn('Try again', { small: true, onClick: () => loadKeys(ctx) })) : h('p.dim', 'Loading the keys...')));
  const all = Array.isArray(list) ? list : [];
  const primary = all.filter((k) => PRIMARY_KEYS.has(k.id));
  const secondary = all.filter((k) => !PRIMARY_KEYS.has(k.id));
  const spec = { key: (k) => k.id, sig: (k) => [k.label, k.envVar, k.set, k.hint, k.updatedAt].join('|'), render: (k) => keyRow(ctx, k) };
  keyed(view.keys, primary, spec);
  keyed(view.extraKeys, secondary, spec);
  if (list && view.extraOpen === null) {
    view.extraOpen = secondary.some((k) => k.set);
    view.extraFold.setOpen(view.extraOpen);
  }
}

function addForm(ctx) {
  const id = h('input', { type: 'text', autocomplete: 'off', spellcheck: false, maxLength: 40, placeholder: 'rl-port' });
  const label = h('input', { type: 'text', autocomplete: 'off', maxLength: 80, placeholder: 'Remote RL Cluster Token' });
  const env = h('input', { type: 'text', autocomplete: 'off', spellcheck: false, maxLength: 60, placeholder: 'RL_PORT_TOKEN' });
  const value = h('input', { type: 'password', autocomplete: 'new-password', spellcheck: false, placeholder: 'Paste the key' });
  const fId = ui.field('Id', id, { hint: 'Lowercase letters, digits, dash.' }), fLabel = ui.field('Label', label), fEnv = ui.field('Env var', env, { hint: 'Capitals, digits, underscore.' }), fValue = ui.field('Value', value);
  const add = ui.btn('Add key', { type: 'submit', tone: 'go' });
  id.addEventListener('input', () => { if (!env.dataset.edited) env.value = id.value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, ''); });
  env.addEventListener('input', () => { env.dataset.edited = env.value ? '1' : ''; });
  for (const f of [fId, fLabel, fEnv, fValue]) f.control.addEventListener('input', () => f.setError(''));
  async function submit() {
    let first = null;
    const fail = (f, msg) => { f.setError(msg); if (msg && !first) first = f.control; };
    const cleanId = id.value.trim().toLowerCase();
    const taken = (view.keyList || []).some((k) => k.id === cleanId);
    fail(fId, !/^[a-z0-9][a-z0-9-]{0,39}$/.test(cleanId) ? 'Use lowercase letters, digits, or dashes (e.g. rl-port).' : taken ? 'A key with this id exists. Save a new value in its row.' : '');
    fail(fLabel, label.value.trim() ? '' : 'Give the key a name you will know.');
    fail(fEnv, /^[A-Z_][A-Z0-9_]*$/.test(env.value.trim()) ? '' : 'Use capitals, digits and underscore, for example RL_PORT_TOKEN.');
    fail(fValue, value.value.trim() ? '' : 'Paste the key.');
    if (first) { first.focus(); return; }
    await ui.busy(add, async () => {
      const res = await ctx.api.put(`/api/keys/${enc(cleanId)}`, { value: value.value.trim(), label: label.value.trim(), envVar: env.value.trim() });
      if (!res) return;
      value.value = ''; id.value = ''; label.value = ''; env.value = ''; env.dataset.edited = '';
      ctx.toast('The key is saved in Keychain. Only its last 4 characters show from now on.');
      await loadKeys(ctx);
    });
  }
  env.autocomplete = 'username';
  return h('form.ky-add', { novalidate: true, autocomplete: 'off', onsubmit: (e) => { e.preventDefault(); submit(); } },
    h('div.ky-addgrid', fId, fLabel, fEnv), fValue, h('div.row', add, h('span.dim', 'Enter saves.')));
}

export function render(container, ctx) {
  const extraKeys = h('div.ky-keys');
  const addBox = h('div.ky-extra', h('p.caps', { style: { marginBottom: '10px' } }, 'Add custom key (e.g. rl-port / RL_PORT_TOKEN)'), addForm(ctx));
  const extraFold = ui.fold('Optional & custom environment keys', () => [extraKeys, addBox], { open: true, onToggle: (v) => { if (view) view.extraOpen = v; } });
  extraFold.setOpen(false);
  view = { labsHead: h('div'), labs: h('div.ky-labs'), keysHead: h('div'), keys: h('div.ky-keys'), extraKeys, extraFold, extraOpen: null, keyList: null, keyError: null };
  container.append(
    ui.section(['Runtimes', h('span.count', '$0 Open-Weight Specialists · OpenAI SIWC · Gemini & Claude API Keys')], view.labsHead, view.labs),
    ui.section(['API Keys Vault', h('span.count', 'stored in macOS Keychain')],
      h('p.dim.ky-where', 'Saved under Keychain service "WorkShop" with metadata in ', h('span.code', 'data/keys-meta.json'), '. Only the last 4 characters ever return to the UI.'),
      view.keysHead, view.keys,
      h('div.ky-extra', extraFold)));
  refreshLabs(ctx);
  refreshKeys(ctx);
  loadKeys(ctx);
  if (ctx.params.lab) requestAnimationFrame(() => {
    if (!view) return;
    const card = [...view.labs.children].find((n) => n.dataset.lab === String(ctx.params.lab));
    if (card) { card.scrollIntoView({ block: 'start' }); card.classList.add('flash'); }
    const p = ctx.store.providers.find((x) => x.id === String(ctx.params.lab));
    if (p && p.mode === 'apikey' && !p.keySet && view.keyList) focusKey(KEY_OF_LAB[p.id]);
  });
}

export function mountRuntimesKeysSection(container, ctx) {
  render(container, ctx);
  return {
    update() {
      if (!view) return;
      const c = ctx.changes;
      if (c.has('providers') || c.has('settings') || c.has('state')) refreshLabs(ctx);
      if (c.has('state') && view.keyError) loadKeys(ctx);
    },
    dispose() { view = null; },
  };
}

export default {
  id: 'keys',
  title: 'Runtimes & Keys',
  label: 'Runtimes',
  short: 'Keys',
  badge: ({ store, sel }) => {
    const labs = sel.labs(store);
    if (!labs.length) return 0;
    const hasOss = labs.some((p) => p.id === 'oss' && p.usable);
    const hasBoss = labs.some((p) => p.id !== 'oss' && p.usable);
    return (hasOss ? 0 : 1) + (hasBoss ? 0 : 1);
  },
  render,
  update(ctx) {
    if (!view) return;
    const c = ctx.changes;
    if (c.has('providers') || c.has('settings') || c.has('state')) refreshLabs(ctx);
    if (c.has('state') && view.keyError) loadKeys(ctx);
  },
  dispose() { view = null; },
};
