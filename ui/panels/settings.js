// Settings panel (contract sections 13b and 14b). Data: ctx.store.settings. Save: PUT /api/settings { patch }.
// Limits, crew presets (editable counts), reviewer and cross-lab review, pairing, safety mode, thrift slider with a plain-language label,
// lab fallback, owner wait time, sound and scanlines. (Presence is the HERE / AWAY switch in the top bar.)
// Look-and-sound switches apply at once. Everything else is a draft until "Save settings".

import { h } from '../lib/dom.js';
import * as ui from '../lib/widgets.js';

const fmt = ui.fmt;

// What the owner changed but did not save stays while the drawer is closed: path -> value.
const keep = { draft: new Map(), advanced: false };
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

/** Remember a change (or forget it when it equals the saved value) and update the save bar. */
function set(ctx, path, v) {
  if (same(v, saved(ctx, path))) keep.draft.delete(path); else keep.draft.set(path, v);
  bar(ctx);
}

/** A number box bound to a settings path. opts: { min, max, step, unit, hint, int, dflt } (dflt shows when the hub has no value) */
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

// ------------------------------------------------------------------ sections

function lookSection(ctx) {
  // These apply at once: the scene and the beeper change now, and the hub stores the choice.
  const apply = async (key, v, box) => {
    if (key === 'scanlines') ctx.scene.setOptions({ scanlines: v });
    if (key === 'sound' && v) ctx.sound.play('test', true);
    const res = await ctx.api.put('/api/settings', { patch: { ui: { [key]: v } } });
    if (res && typeof res === 'object' && res.ui) ctx.store.set('settings', res);
    else if (!res && view) { box.input.checked = !v; if (key === 'scanlines') ctx.scene.setOptions({ scanlines: !v }); } // the hub said no: put the switch back
  };
  const scan = ui.checkbox('Scanlines on the workshop scene', false, (v) => apply('scanlines', v, scan));
  const snd = ui.checkbox('Sound: a short beep when something waits for you, when the truck leaves and when a job is done', false, (v) => apply('sound', v, snd));
  view.fields.push({ path: 'ui', valid: () => true, sync: () => { const u = (ctx.store.settings || {}).ui || {}; scan.input.checked = !!u.scanlines; snd.input.checked = !!u.sound; } });
  return ui.section(['Look and sound', h('span.count', 'applies at once')], scan, snd);
}

function youSection(ctx) {
  // Presence itself is the HERE / AWAY switch in the top bar. This section holds how long a question waits while you are here.
  const note = h('p.dim');
  view.fields.push({ path: 'presence', valid: () => true, sync: () => {
    const away = (ctx.store.settings || {}).presence === 'away';
    note.textContent = away ? 'You are away now (the switch in the top bar): the hub takes the default answer of a boss question at once. The question stays in your Inbox so you can overturn it.'
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
      h('thead', h('tr', h('th', { scope: 'col' }, 'Preset'), h('th', { scope: 'col', title: 'Orchestration officers & review gates (Frontier API key). 1 to 3.' }, 'Officers'), h('th', { scope: 'col', title: 'Team leads unblock specialists ($0 OSS). 0 to 3.' }, 'Leads'), h('th', { scope: 'col', title: 'OSS specialists build tasks. At most 8 benches. 1 to 8.' }, 'Specs'))),
      h('tbody', presets.map((p) => h('tr', h('th.st-preset', { scope: 'row' }, p), cell(p, 'bosses', 1, 3), cell(p, 'managers', 0, 3), cell(p, 'makers', 1, 8))))),
    h('div.st-inline', ui.field('Default crew of a new work order', def)));
}

function reviewSection(ctx) {
  const cur = String(saved(ctx, 'review.reviewer') || 'boss');
  const who = ui.select([...new Set(['boss', cur])].map((v) => ({ value: v, label: v === 'boss' ? 'A boss' : v })), cur, { onchange: () => set(ctx, 'review.reviewer', who.select.value) });
  view.fields.push({ path: 'review.reviewer', valid: () => true, sync: () => { who.select.value = String(value(ctx, 'review.reviewer') || 'boss'); } });
  return ui.section('Review',
    ui.field('Who reviews a hand-in', who, { hint: 'Nothing merges without a review. A boss gives the verdict.' }),
    check(ctx, 'review.crossLab', 'Cross-runtime review: the review gate uses the other Frontier runtime when usable', { hint: 'A Frontier gate checks $0 OSS specialist hand-ins before merging.' }),
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
    num(ctx, 'budgetUsd', 'Default Frontier API budget', { min: 0, max: 100000, step: 1, int: false, unit: 'USD', hint: 'Applies to Frontier API-key turns. OSS open-weight & Stand-in turns cost $0.' }),
    num(ctx, 'mockSpeed', 'Pace of the mock lab', { min: 0, max: 20, dflt: 1, hint: 'Only the mock lab, which uses no tokens. 0 runs with no pauses. A higher number is slower. The demo keeps its own slow pace.' }));
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
  adv.setOpen(keep.advanced); // built at once (its fields must exist to be saved), shown only when the owner opened it
  return ui.section('Limits',
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
    adv);
}

// ------------------------------------------------------------------ save bar

function bar(ctx) {
  if (!view) return;
  const n = keep.draft.size;
  view.bar.hidden = !n;
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
    syncAll(); bar(ctx);
    ctx.toast('Settings saved.');
  });
}

function render(container, ctx) {
  view = { fields: [], bar: null, count: h('span.grow') };
  // "Save settings" is the submit button of the form, so Enter in a field saves. It must be a button that is drawn:
  // WebKit (the Mac app) does not submit a form with many fields through a submit button that is hidden.
  // The bar shows as soon as one value differs, so the button is there when Enter can save something.
  const saveBtn = ui.btn('Save settings', { type: 'submit', tone: 'go' });
  view.bar = h('div.st-save', { hidden: true, role: 'status' }, view.count,
    ui.btn('Discard', { small: true, onClick: () => { keep.draft.clear(); syncAll(); bar(ctx); } }),
    saveBtn);
  const form = h('form.st', { novalidate: true, onsubmit: (e) => { e.preventDefault(); if (keep.draft.size) save(ctx, saveBtn); } },
    lookSection(ctx), youSection(ctx), crewSection(ctx), reviewSection(ctx), safetySection(ctx), routingSection(ctx), limitsSection(ctx),
    view.bar);
  container.append(form);
  syncAll(); bar(ctx);
}

export default {
  id: 'settings',
  title: 'Settings',
  render,
  update(ctx) { if (view && (ctx.changes.has('settings') || ctx.changes.has('state'))) { syncAll(); bar(ctx); } },
  dispose() { view = null; },
};
