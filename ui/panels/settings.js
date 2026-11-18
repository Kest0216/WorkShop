// Settings panel: combines Shop Rules & Limits, Runtimes & Keys (OpenAI SIWC + Gemini/Claude API keys + Local OSS),
// and the Universal RL Compute Port (Local Machine GPU + Remote Cluster on Droplet/Hostinger/RunPod + Personal local/ overlay).
// Look-and-sound switches apply at once. Shop rules stay as a draft until "Save settings".

import { h, mount, clear } from '../lib/dom.js';
import * as ui from '../lib/widgets.js';
import { mountRuntimesKeysSection } from './keys.js';

const fmt = ui.fmt;
const enc = encodeURIComponent;

// What the owner changed but did not save stays while the drawer is closed: path -> value.
const keep = { tab: 'shop', draft: new Map(), advanced: false, limitsOpen: false, probeResult: null };
let view = null;

const get = (obj, path) => path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
const same = (a, b) => a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9);
const saved = (ctx, path) => get(ctx.store.settings || {}, path);
const value = (ctx, path) => (keep.draft.has(path) ? keep.draft.get(path) : saved(ctx, path));
function patchOf(draft) {
  const out = {};
  for (const [path, v] of draft) {
    const keys = path.split('.');
    let o = out;
    for (const k of keys.slice(0, -1)) o = o[k] || (o[k] = {});
    o[keys[keys.length - 1]] = v;
  }
  return out;
}

/** What thrift means, in plain words. 0 = best model always, 1 = cheapest that fits. */
export function thriftWords(t) {
  const v = Number(t);
  if (!(v > 0)) return 'Best model always. Cost does not count.';
  if (v <= 0.2) return 'Quality first. Cost only breaks a tie.';
  if (v <= 0.45) return 'Mostly quality. A cheaper model wins when it is nearly as good.';
  if (v <= 0.7) return 'Balanced. Quality and cost count about the same.';
  if (v < 1) return 'Mostly cost. A better model must be clearly better to win.';
  return 'Cheapest model that fits the task.';
}

// ------------------------------------------------------------------ fields

function set(ctx, path, v) {
  if (same(v, saved(ctx, path))) keep.draft.delete(path); else keep.draft.set(path, v);
  bar(ctx);
}

function num(ctx, path, label, { min = 0, max = 100000, step = 1, hint, unit, int = true, dflt = null } = {}) {
  const input = h('input', { type: 'number', min, max, step, inputMode: int ? 'numeric' : 'decimal' });
  const f = ui.field(unit ? `${label} (${unit})` : label, input, { hint });
  const read = () => {
    const raw = input.value.trim();
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n)) return { error: 'Type a number.' };
    if (int && !Number.isInteger(n)) return { error: 'Use a whole number.' };
    if (n < min || n > max) return { error: `Use a number from ${min} to ${max}.` };
    return { n };
  };
  input.addEventListener('input', () => {
    const r = read();
    f.setError(r.error || '');
    if (r.error) { keep.draft.set(path, NaN); bar(ctx); } else set(ctx, path, r.n);
    f.classList.toggle('is-dirty', keep.draft.has(path));
  });
  view.fields.push({ path, valid: () => !read().error || !keep.draft.has(path), focus: () => input.focus(),
    sync: () => { const v = value(ctx, path) ?? dflt; if (document.activeElement !== input || !keep.draft.has(path)) input.value = v == null || Number.isNaN(v) ? '' : String(v); f.classList.toggle('is-dirty', keep.draft.has(path)); if (!keep.draft.has(path)) f.setError(''); } });
  return f;
}

function check(ctx, path, label, { hint } = {}) {
  const box = ui.checkbox(label, false, (v) => set(ctx, path, v));
  view.fields.push({ path, valid: () => true, sync: () => { box.input.checked = !!value(ctx, path); box.classList.toggle('is-dirty', keep.draft.has(path)); } });
  return hint ? h('div.st-check', box, h('div.help', hint)) : box;
}

function choice(ctx, path, legend, options, { hint, onPick } = {}) {
  const seg = ui.segmented(options, undefined, async (v) => {
    if (onPick && !(await onPick(v))) { seg.value = value(ctx, path); return; }
    set(ctx, path, v);
    if (view) for (const f of view.fields) if (f.path === path) f.sync();
  });
  const note = h('div.help');
  const g = ui.group(legend, seg, note);
  view.fields.push({ path, valid: () => true, sync: () => { const v = value(ctx, path); seg.value = v; const o = options.find((x) => x.value === v); note.textContent = (o && o.note) || hint || ''; g.classList.toggle('is-dirty', keep.draft.has(path)); } });
  return g;
}

// ------------------------------------------------------------------ Shop Rules & Limits sections

function lookSection(ctx) {
  const apply = async (key, v, box) => {
    if (key === 'scanlines') ctx.scene.setOptions({ scanlines: v });
    if (key === 'sound' && v) ctx.sound.play('test', true);
    const res = await ctx.api.put('/api/settings', { patch: { ui: { [key]: v } } });
    if (res && typeof res === 'object' && res.ui) ctx.store.set('settings', res);
    else if (!res && view) { box.input.checked = !v; if (key === 'scanlines') ctx.scene.setOptions({ scanlines: !v }); }
  };
  const scan = ui.checkbox('Scanlines on the workshop scene', false, (v) => apply('scanlines', v, scan));
  const snd = ui.checkbox('Sound: a short beep when something waits for you, when the truck leaves and when a job is done', false, (v) => apply('sound', v, snd));
  view.fields.push({ path: 'ui', valid: () => true, sync: () => { const u = (ctx.store.settings || {}).ui || {}; scan.input.checked = !!u.scanlines; snd.input.checked = !!u.sound; } });
  return ui.section(['Look and sound', h('span.count', 'applies at once')], scan, snd);
}

function youSection(ctx) {
  const note = h('p.dim');
  view.fields.push({ path: 'presence', valid: () => true, sync: () => {
    const away = (ctx.store.settings || {}).presence === 'away';
    note.textContent = away ? 'You are away now (the switch in the top bar): the hub takes the default answer of a boss question at once. The question stays in your Board Action Deck so you can overturn it.'
      : `You are here now (the switch in the top bar): a boss question waits ${value(ctx, 'humanWaitMin') ?? 30} minutes for you. Then the hub takes the default.`;
  } });
  return ui.section('You',
    num(ctx, 'humanWaitMin', 'Owner wait time', { min: 1, max: 1440, unit: 'minutes', hint: 'How long a boss question waits for you while you are here. After that the hub takes the default answer.' }),
    note);
}

function crewSection(ctx) {
  const presets = Object.keys((ctx.store.settings || {}).crewPresets || {});
  const cell = (name, key, lo, hi) => {
    const path = `crewPresets.${name}.${key}`;
    const input = h('input', { type: 'number', min: lo, max: hi, step: 1, inputMode: 'numeric', 'aria-label': `${name}: ${key}` });
    const td = h('td', input);
    const read = () => { const n = Number(input.value); return input.value.trim() !== '' && Number.isInteger(n) && n >= lo && n <= hi ? n : null; };
    input.addEventListener('input', () => { const n = read(); td.classList.toggle('has-error', n === null); input.title = n === null ? `Use a whole number from ${lo} to ${hi}.` : ''; if (n === null) { keep.draft.set(path, NaN); bar(ctx); } else set(ctx, path, n); td.classList.toggle('is-dirty', keep.draft.has(path)); });
    view.fields.push({ path, valid: () => read() !== null || !keep.draft.has(path), focus: () => input.focus(),
      sync: () => { const v = value(ctx, path); if (document.activeElement !== input || !keep.draft.has(path)) input.value = v == null || Number.isNaN(v) ? '' : String(v); td.classList.toggle('is-dirty', keep.draft.has(path)); if (!keep.draft.has(path)) td.classList.remove('has-error'); } });
    return td;
  };
  const def = ui.select(presets.map((p) => ({ value: p, label: p })), undefined, { onchange: () => set(ctx, 'defaultCrew', def.select.value) });
  view.fields.push({ path: 'defaultCrew', valid: () => true, sync: () => { def.select.value = value(ctx, 'defaultCrew') || presets[0] || ''; } });
  return ui.section('Crew presets',
    h('table.table.st-crew',
      h('thead', h('tr', h('th', { scope: 'col' }, 'Preset'), h('th', { scope: 'col', title: 'Orchestration officers & review gates (OpenAI SIWC or Gemini/Claude API key). 1 to 3.' }, 'Officers'), h('th', { scope: 'col', title: 'Team leads unblock specialists ($0 OSS). 0 to 3.' }, 'Leads'), h('th', { scope: 'col', title: 'RL-certified OSS specialists build tasks. 1 to 8.' }, 'Specs'))),
      h('tbody', presets.map((p) => h('tr', h('th.st-preset', { scope: 'row' }, p), cell(p, 'bosses', 1, 3), cell(p, 'managers', 0, 3), cell(p, 'makers', 1, 8))))),
    h('div.st-inline', ui.field('Default crew of a new work order', def)));
}

function reviewSection(ctx) {
  const cur = String(saved(ctx, 'review.reviewer') || 'boss');
  const who = ui.select([...new Set(['boss', cur])].map((v) => ({ value: v, label: v === 'boss' ? 'A boss' : v })), cur, { onchange: () => set(ctx, 'review.reviewer', who.select.value) });
  view.fields.push({ path: 'review.reviewer', valid: () => true, sync: () => { who.select.value = String(value(ctx, 'review.reviewer') || 'boss'); } });
  return ui.section('Review',
    ui.field('Who reviews a hand-in', who, { hint: 'Nothing merges without a review. A boss gives the verdict.' }),
    check(ctx, 'review.crossLab', 'Cross-runtime review: the review gate uses another Frontier runtime when usable', { hint: 'A Frontier gate checks $0 OSS specialist hand-ins before merging.' }),
    check(ctx, 'review.smallByManager', 'Small tasks go to the floor manager of the other lab first', { hint: 'Saves boss turns on S tasks that have no buddy check.' }),
    choice(ctx, 'pairing', 'Buddy check before the review', [
      { value: 'costly', label: 'Flagged tasks', note: 'Only the tasks that the plan marks as costly get a buddy check.' },
      { value: 'M+L', label: 'Medium and large', note: 'Also every M and L task. A maker of the other lab looks first.' },
      { value: 'all', label: 'Every task', note: 'Every task gets a buddy check. Slowest and most careful.' },
    ]));
}

function safetySection(ctx) {
  const warn = h('div.callout.bad.st-trust', { hidden: true }, h('div.callout-title', 'Trusting'), h('p', { style: { margin: 0 } }, 'Agents can do anything you can on this Mac.'));
  const g = choice(ctx, 'safety', 'Safety mode', [
    { value: 'sandboxed', label: 'Sandboxed', note: 'Every shell command of every agent runs in an OS sandbox. It writes only in its own folder and cannot read your keys or credentials.' },
    { value: 'trusting', label: 'Trusting', note: 'No OS sandbox.' },
  ], { onPick: async (v) => v !== 'trusting' || saved(ctx, 'safety') === 'trusting' || ctx.confirm({ title: 'Turn the sandbox off?', text: 'In safety mode "trusting" agents can do anything you can on this Mac: read any file, run any program, use the network.\n\nThe change takes effect when you press Save settings.', okLabel: 'Use trusting', cancelLabel: 'Keep the sandbox', danger: true }) });
  view.fields.push({ path: 'safety', valid: () => true, sync: () => { warn.hidden = value(ctx, 'safety') !== 'trusting'; } });
  return ui.section('Safety', g, warn);
}

function routingSection(ctx) {
  const slider = h('input', { type: 'range', min: 0, max: 1, step: 0.05, 'aria-describedby': 'st-thrift-words' });
  const out = h('span.st-thrift-num'), words = h('div.st-thrift-words#st-thrift-words', { role: 'status' });
  const show = () => { const v = Number(slider.value); out.textContent = v.toFixed(2); words.textContent = thriftWords(v); };
  slider.addEventListener('input', () => { set(ctx, 'thrift', Math.round(Number(slider.value) * 100) / 100); show(); f.classList.toggle('is-dirty', keep.draft.has('thrift')); });
  const f = ui.field('Thrift', slider);
  f.classList.add('st-thrift');
  slider.after(h('div.st-thrift-scale', h('span', 'best model'), out, h('span', 'cheapest model')), words);
  view.fields.push({ path: 'thrift', valid: () => true, sync: () => { if (document.activeElement !== slider || !keep.draft.has('thrift')) slider.value = String(value(ctx, 'thrift') ?? 0.3); show(); f.classList.toggle('is-dirty', keep.draft.has('thrift')); } });
  return ui.section('Models and money', f,
    check(ctx, 'allowFallback', 'Lab fallback: route work to the other lab when one is cooling or missing', { hint: 'Off: work for a lab that is not usable waits until that lab is back.' }),
    check(ctx, 'approvePlan', 'New work orders start with "Show me the plan first"'),
    num(ctx, 'budgetUsd', 'Default Frontier API budget', { min: 0, max: 100000, step: 1, int: false, unit: 'USD', hint: 'Applies to metered API-key turns. OpenAI ChatGPT subscription & OSS open-weight turns cost $0 billed.' }),
    num(ctx, 'mockSpeed', 'Pace of the mock lab', { min: 0, max: 20, dflt: 1, hint: 'Only the mock lab, which uses no tokens. 0 runs with no pauses. A higher number is slower.' }));
}

function limitsSection(ctx) {
  const L = (ctx.store.settings || {}).limits || {};
  const per = Object.keys(L.perProvider || {}).filter((k) => k !== 'mock');
  const grid = (...kids) => h('div.st-grid', kids);
  const adv = ui.fold('Session rotation (advanced)', () => grid(
    num(ctx, 'limits.rotateTok.boss', 'Boss rotates over', { min: 5000, max: 2000000, step: 1000, unit: 'tokens' }),
    num(ctx, 'limits.rotateTok.manager', 'Manager rotates over', { min: 5000, max: 2000000, step: 1000, unit: 'tokens' }),
    num(ctx, 'limits.rotateTok.maker', 'Maker rotates over', { min: 5000, max: 2000000, step: 1000, unit: 'tokens' }),
    num(ctx, 'limits.rotateGapMin', 'Idle gap', { min: 1, max: 600, unit: 'minutes', hint: 'A boss or manager that sat idle this long starts fresh...' }),
    num(ctx, 'limits.rotateGapTok', '...when its context is over', { min: 1000, max: 2000000, step: 1000, unit: 'tokens' })), { open: true, onToggle: (v) => { keep.advanced = v; } });
  adv.setOpen(keep.advanced);
  const fold = ui.fold('Show 22 advanced concurrency, retry & timeout limits', () => [
    h('div.caps.st-sub', 'Agents at work at once'),
    grid(num(ctx, 'limits.maxAgents', 'All labs', { min: 1, max: 14, hint: 'Turns that run at the same time.' }),
      per.map((p) => num(ctx, `limits.perProvider.${p}`, `Lab ${p}`, { min: 0, max: 14 }))),
    h('div.caps.st-sub', 'Tries before the hub stops and asks'),
    grid(num(ctx, 'limits.maxReworks', 'Reworks of a task', { min: 0, max: 20, hint: 'Then the task fails.' }), num(ctx, 'limits.maxNudges', 'Nudges of a turn', { min: 0, max: 20, hint: 'A turn that ends with no hand-in gets a reminder.' }),
      num(ctx, 'limits.maxRetries', 'Retries of a task', { min: 0, max: 20 }), num(ctx, 'limits.maxBlocks', 'Blocks of a task', { min: 0, max: 20 }),
      num(ctx, 'limits.maxClaims', 'Claims of a task', { min: 0, max: 50, hint: 'Paths outside its zone.' }), num(ctx, 'limits.maxReviewers', 'Reviewers', { min: 1, max: 10, hint: 'Per hand-in. Then it waits for your verdict.' }),
      num(ctx, 'limits.maxQaRounds', 'QA rounds', { min: 1, max: 20, hint: 'Then the job pauses.' })),
    h('div.caps.st-sub', 'Size of a plan'),
    grid(num(ctx, 'limits.maxTasks', 'Tasks in the plan', { min: 1, max: 200 }), num(ctx, 'limits.maxTasksTotal', 'Tasks in the job', { min: 1, max: 400, hint: 'The plan plus tasks added later.' })),
    h('div.caps.st-sub', 'Time limits in minutes'),
    grid(num(ctx, 'limits.taskTimeoutMin.S', 'Small task', { min: 1, max: 1440 }), num(ctx, 'limits.taskTimeoutMin.M', 'Medium task', { min: 1, max: 1440 }), num(ctx, 'limits.taskTimeoutMin.L', 'Large task', { min: 1, max: 1440 }),
      num(ctx, 'limits.turnTimeoutMin', 'Other turns', { min: 1, max: 1440 }), num(ctx, 'limits.idleTimeoutMin', 'Silent turn', { min: 1, max: 1440, hint: 'No output for this long ends the turn.' }),
      num(ctx, 'limits.checkTimeoutMin', 'Check command', { min: 1, max: 1440 }), num(ctx, 'limits.holdFallbackMin', 'Hold before fallback', { min: 1, max: 1440, hint: 'A lab on hold this long hands its work to the other lab.' })),
    h('div.caps.st-sub', 'Size of a hand-in, and cost of a turn'),
    grid(num(ctx, 'limits.maxFileMb', 'One file', { min: 0.1, max: 1000, step: 0.1, int: false, unit: 'MB' }), num(ctx, 'limits.maxDeliveryMb', 'One hand-in', { min: 0.1, max: 5000, step: 0.1, int: false, unit: 'MB' }),
      num(ctx, 'limits.maxDeliveryFiles', 'Files in a hand-in', { min: 1, max: 100000 }), num(ctx, 'limits.turnUsd', 'One turn', { min: 0.1, max: 1000, step: 0.1, int: false, unit: 'USD', hint: 'API key mode only.' })),
    adv,
  ], { open: true, onToggle: (v) => { keep.limitsOpen = v; } });
  fold.setOpen(keep.limitsOpen);
  return ui.section('Advanced limits', fold);
}

// ------------------------------------------------------------------ Universal RL Compute Port Tab

function drawRlPortTab(ctx, box) {
  const rl = ctx.store.rlPort || { mode: 'sim', localUrl: 'http://127.0.0.1:8788', remoteUrl: '', providerHint: 'custom', hasAdapterScript: false };
  const cfg = rl.config || rl;
  const hasAdapter = !!(rl.hasAdapterScript || rl.hasCustomModule);
  let curMode = rl.mode || cfg.mode || 'sim';
  let curRemoteProv = rl.providerHint || cfg.providerHint || rl.remoteProvider || 'custom';
  if (curRemoteProv === 'local-gpu') curRemoteProv = 'droplet';

  const modeSeg = ui.segmented([
    { value: 'local', label: 'Local Machine GPU', title: 'Run RL locally via local/rl-port.mjs or local HTTP trainer' },
    { value: 'remote', label: 'Remote Compute Cluster', title: 'Offload RL to DigitalOcean Droplet, Hostinger VPS, RunPod, or any HTTPS endpoint' },
    { value: 'sim', label: '[SIM] Demo Sandbox', title: 'Zero-GPU simulation for testing the Forge & QA pipeline' },
  ], curMode, (v) => { curMode = v; syncVisibility(); });

  const localUrlIn = h('input', { type: 'text', spellcheck: false, value: String(cfg.localUrl || rl.localUrl || 'http://127.0.0.1:8788'), placeholder: 'http://127.0.0.1:8788' });
  const remoteProvSel = ui.select([
    { value: 'droplet', label: 'DigitalOcean GPU Droplet' },
    { value: 'hostinger', label: 'Hostinger VPS / Cloud' },
    { value: 'runpod', label: 'RunPod / Lambda Cluster' },
    { value: 'custom', label: 'Custom Remote Endpoint' },
  ], curRemoteProv, { onchange: () => { curRemoteProv = remoteProvSel.select.value; } });
  const remoteUrlIn = h('input', { type: 'text', spellcheck: false, value: String(cfg.remoteUrl || rl.remoteUrl || ''), placeholder: 'https://rl-cluster.example.com:8788' });

  const localCfg = h('div.stack',
    h('p.dim', hasAdapter
      ? 'Detected personal adapter: local/rl-port.mjs (git-ignored). WorkShop invokes your local module directly.'
      : 'No local/rl-port.mjs found yet. Copy starter template ports/rl/template-local.mjs -> local/rl-port.mjs or point to a local trainer daemon below:'),
    ui.field('Local Trainer HTTP URL (used when local/rl-port.mjs is absent)', localUrlIn, { hint: 'Standard Universal RL Port v1 endpoints: GET /health, POST /jobs, GET /jobs/:id' }));

  const remoteCfg = h('div.stack',
    h('div.oss-cfg', ui.field('Cluster Provider', remoteProvSel), ui.field('Remote RL Port URL', remoteUrlIn)),
    h('p.dim', 'Authentication: save a custom key with id ', h('span.code', 'rl-port'), ' (', h('span.code', 'RL_PORT_TOKEN'), ') in ',
      h('button.linkish', { type: 'button', onclick: () => ctx.setParams({ tab: 'runtimes' }) }, 'Runtimes & Keys'),
      ' — WorkShop sends it as Authorization: Bearer <token> and never writes it to disk.'));

  const simCfg = h('div.callout',
    h('div.callout-title', '[SIM] Zero-GPU Demo Trainer'),
    h('p', { style: { margin: 0 } }, 'Simulates RL trajectory steps and runs full Verification & QA checks locally. Enrolled agents carry a clear [SIM] badge and are stored in git-ignored local/roster.json so public config/roster.json stays clean.'));

  function syncVisibility() {
    localCfg.hidden = curMode !== 'local';
    remoteCfg.hidden = curMode !== 'remote';
    simCfg.hidden = curMode !== 'sim';
  }
  syncVisibility();

  const probeBox = h('div');
  function renderProbe() {
    const p = keep.probeResult;
    if (!p) { clear(probeBox); return; }
    mount(probeBox, h('div', { class: ['callout', p.ok ? 'ok' : 'bad'] },
      h('div.callout-title', p.ok ? `Port Ready (${p.backend || p.engine || p.mode})` : 'Port Unreachable / Needs Wiring'),
      h('p', { style: { margin: 0 } }, p.ok
        ? `${p.detail || `Connected (${p.mode})`}${Array.isArray(p.gpus) && p.gpus.length ? ` · GPUs: ${p.gpus.join(', ')}` : ''}`
        : String(p.detail || p.reason || 'Endpoint did not answer.')),
      p.hint ? h('p.dim', { style: { margin: '4px 0 0' } }, String(p.hint)) : null));
  }
  renderProbe();

  const saveProbeBtn = ui.btn('Save & Probe RL Port', { tone: 'go', onClick: (e) => ui.busy(e.currentTarget, async () => {
    const updated = await ctx.api.put('/api/rl-port', {
      mode: curMode,
      localUrl: localUrlIn.value.trim(),
      remoteUrl: remoteUrlIn.value.trim(),
      providerHint: curMode === 'local' ? 'local-gpu' : curRemoteProv,
    });
    const status = await ctx.api.get('/api/rl-port', { quiet: true });
    if (status) ctx.store.set('rlPort', status); else if (updated) ctx.store.set('rlPort', updated);
    const probe = updated && Object.hasOwn(updated, 'ok') ? updated : await ctx.api.post('/api/rl-port/probe', {});
    if (probe) {
      keep.probeResult = probe;
      renderProbe();
      ctx.toast(probe.ok ? `RL Port (${curMode}) connected!` : `RL Port saved (${probe.detail || probe.reason || 'not reachable yet'}).`, probe.ok ? 'info' : 'warn');
    }
  }) });

  const copyPromptBtn = ui.btn('Copy Agent Prompt to Wire My Port', { tone: 'primary', onClick: async () => {
    const fresh = (await ctx.api.get('/api/rl-port', { quiet: true })) || rl;
    const text = fresh.agentPrompt || 'Read ports/rl/PORT_CONTRACT.md and implement local/rl-port.mjs for my hardware.';
    let copied = false;
    try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); copied = true; } } catch { copied = false; }
    if (copied) ctx.toast('Agent wiring prompt copied! Paste it into your coding agent to finalize the connection.');
    else ctx.modal({ title: 'Universal RL Port · Agent Wiring Prompt', wide: true, buttons: [{ label: 'Close', primary: true }], body: h('pre.term', text) });
  } });

  mount(box,
    ui.section(['Universal RL Compute Port', h('span.count', 'Open-Weight Specialist Post-Training')],
      h('p.dim', 'WorkShop provides a universal RL port contract (ports/rl/PORT_CONTRACT.md) rather than hardcoding one GPU vendor. Connect your own Mac/Linux GPU or offload to DigitalOcean Droplet, Hostinger, or RunPod — or hand the 1-click prompt to your coding agent to wire your exact machine.'),
      ui.group('Active RL Port Mode', modeSeg),
      localCfg, remoteCfg, simCfg,
      h('div.row', { style: { marginTop: '10px' } }, saveProbeBtn, copyPromptBtn),
      probeBox),
    ui.section(['Public Repo vs. Personal Machine Overlay', h('span.count', 'local/ is git-ignored')],
      h('p.dim', 'This repository stays clean and universal for public GitHub users while your personal RL connections, private checkpoints, and custom harnesses live in git-ignored overlay files on this machine:'),
      h('ul.list',
        h('li.li', h('span.code', 'local/rl-port.mjs'), h('span.grow.dim', 'Personal local GPU or SSH/tunnel RL adapter'), ui.chip(hasAdapter ? 'present' : 'optional', hasAdapter ? 'green' : 'plain')),
        h('li.li', h('span.code', 'local/rl-port.json'), h('span.grow.dim', 'Personal cluster URL & port mode override (no secrets)')),
        h('li.li', h('span.code', 'local/roster.json'), h('span.grow.dim', 'Personal RL-trained specialists & owner +1/-1/0 ratings')),
        h('li.li', h('span.code', 'local/harnesses.json'), h('span.grow.dim', 'Personal custom harnesses')),
        h('li.li', h('span.code', 'ports/rl/PORT_CONTRACT.md'), h('span.grow.dim', 'Agent-readable Universal RL Port v1 specification & templates')))));
}

// ------------------------------------------------------------------ save bar & panel

function bar() {
  if (!view || !view.bar) return;
  const n = keep.draft.size;
  view.bar.hidden = !n || view.tab !== 'shop';
  view.count.textContent = `${fmt.plural(n, 'change')} not saved`;
}

function syncAll() { if (view) for (const f of view.fields) f.sync(); }

async function save(ctx, button) {
  const bad = view.fields.find((f) => keep.draft.has(f.path) && !f.valid());
  if (bad) { ctx.toast('Fix the fields marked in red first.', 'warn'); if (bad.focus) bad.focus(); return; }
  await ui.busy(button, async () => {
    const res = await ctx.api.put('/api/settings', { patch: patchOf(keep.draft) });
    if (!res) return;
    keep.draft.clear();
    if (res && typeof res === 'object' && (res.limits || res.ui || res.crewPresets)) ctx.store.set('settings', res);
    else { const fresh = await ctx.api.get('/api/settings', { quiet: true }); if (fresh) ctx.store.set('settings', fresh); }
    syncAll(); bar();
    ctx.toast('Settings saved.');
  });
}

function render(container, ctx) {
  const wantedTab = ctx.params.tab && ['runtimes', 'rlport', 'shop'].includes(String(ctx.params.tab))
    ? String(ctx.params.tab)
    : ctx.params.lab ? 'runtimes' : keep.tab;
  keep.tab = wantedTab;

  const tabs = h('div.panel-tabs',
    ui.segmented([
      { value: 'runtimes', label: 'Runtimes & Keys', title: 'OpenAI Sign in with ChatGPT, Gemini/Claude API keys, Local OSS & Keychain Vault' },
      { value: 'rlport', label: 'RL Compute Port', title: 'Connect a Local GPU or Remote Cluster (Droplet / Hostinger / RunPod) + personal local/ overlay' },
      { value: 'shop', label: 'Shop Rules & Limits', title: 'Look & sound, crew presets, review gates, sandbox safety, thrift & concurrency limits' },
    ], wantedTab, (v) => { keep.tab = v; ctx.setParams({ tab: v, lab: null }); }));

  view = { tab: wantedTab, fields: [], bar: null, count: h('span.grow'), runtimesSub: null, rlBox: h('div') };
  container.append(tabs);

  if (wantedTab === 'runtimes') {
    const rtBox = h('div');
    container.append(rtBox);
    view.runtimesSub = mountRuntimesKeysSection(rtBox, ctx);
    return;
  }

  if (wantedTab === 'rlport') {
    container.append(view.rlBox);
    if (!ctx.store.rlPort) {
      ctx.api.get('/api/rl-port', { quiet: true }).then((d) => {
        if (d) ctx.store.set('rlPort', d);
        if (view && view.tab === 'rlport') drawRlPortTab(ctx, view.rlBox);
      });
    }
    drawRlPortTab(ctx, view.rlBox);
    return;
  }

  const saveBtn = ui.btn('Save settings', { type: 'submit', tone: 'go' });
  view.bar = h('div.st-save', { hidden: true, role: 'status' }, view.count,
    ui.btn('Discard', { small: true, onClick: () => { keep.draft.clear(); syncAll(); bar(); } }),
    saveBtn);
  const form = h('form.st', { novalidate: true, onsubmit: (e) => { e.preventDefault(); if (keep.draft.size) save(ctx, saveBtn); } },
    lookSection(ctx), youSection(ctx), crewSection(ctx), reviewSection(ctx), safetySection(ctx), routingSection(ctx), limitsSection(ctx),
    view.bar);
  container.append(form);
  syncAll(); bar();
}

export default {
  id: 'settings',
  title: 'Settings, Runtimes & Keys',
  label: 'Settings',
  short: 'Settings',
  wide: true,
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
    if (view.tab === 'runtimes' && view.runtimesSub) { view.runtimesSub.update(); return; }
    if (view.tab === 'rlport') {
      if (ctx.changes.has('rlPort') || ctx.changes.has('state')) drawRlPortTab(ctx, view.rlBox);
      return;
    }
    if (ctx.changes.has('settings') || ctx.changes.has('state')) { syncAll(); bar(); }
  },
  dispose() {
    if (view && view.runtimesSub) view.runtimesSub.dispose();
    view = null;
  },
};
