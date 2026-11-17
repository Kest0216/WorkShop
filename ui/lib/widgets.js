// Shared widgets: chips, tags, buttons, form fields, toasts and the modal dialog.
// Everything is built with h(), so server text can never become markup.

import { h, newId, focusables, openExternal, showMarks } from './dom.js';

// ------------------------------------------------------------------ formatting

const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmt = {
  money(usd) { const n = Number(usd); if (!Number.isFinite(n)) return '$0.00'; if (n > 0 && n < 0.005) return '<$0.01'; return '$' + (n >= 1000 ? Math.round(n).toString() : n.toFixed(2)); },
  tokens(v) { const n = Number(v) || 0; if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'; if (n >= 1e4) return Math.round(n / 1e3) + 'k'; if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'; return String(n); },
  time(ts) { const d = new Date(ts); return Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`; },
  date(ts) { const d = new Date(ts); return Number.isNaN(d.getTime()) ? '' : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`; },
  /** The time of a post: "22:10" for today, "Nov 14 22:10" for another day (a job can run for days). */
  stamp(ts, now = Date.now()) {
    const d = new Date(ts), n = new Date(now);
    if (Number.isNaN(d.getTime())) return '';
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate() ? hm : `${MONTHS[d.getMonth()]} ${d.getDate()} ${hm}`;
  },
  ago(ts) {
    const s = Math.max(0, (Date.now() - Number(ts)) / 1000);
    if (!Number.isFinite(s)) return '';
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  },
  plural(n, one, many) { return `${n} ${n === 1 ? one : many || one + 's'}`; },
  clip(s, n) { const t = String(s ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; },
  /** 1234567 -> "1,234,567" */
  num(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '0'; },
  /** A commit id as people read it: the first 7 characters. */
  sha(s) { return typeof s === 'string' && s ? s.slice(0, 7) : 'none'; },
  /** Time left until ts: "in 12 min", "in 2 h 5 min", "now". */
  until(ts) {
    const s = (Number(ts) - Date.now()) / 1000;
    if (!Number.isFinite(s)) return '';
    if (s <= 30) return 'now';
    if (s < 3600) return `in ${Math.round(s / 60)} min`;
    return `in ${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  },
  /** 0.412 -> "41%" */
  pct(v) { const n = Number(v); return Number.isFinite(n) ? `${Math.round(n * 100)}%` : ''; },
};

// ------------------------------------------------------------------ chips and tags

const TONES = {
  job: { queued: 'plain', planning: 'blue', plan_review: 'amber', running: 'green', qa: 'blue', delivering: 'amber', done: 'dark', paused: 'steel', cancelled: 'steel' },
  task: { planned: 'plain', ready: 'blue', working: 'green', checking: 'blue', buddy: 'blue', review: 'amber', rework: 'brick', integrating: 'amber', merged: 'dark', blocked: 'red', failed: 'red', cancelled: 'steel' },
  req: { open: 'plain', verified: 'green', failed: 'red', waived: 'steel' },
  delivery: { checking: 'blue', buddy: 'blue', review: 'amber', rejected: 'brick', approved: 'green', loaded: 'amber', shipped: 'dark' },
  agent: { idle: 'plain', working: 'green', thinking: 'blue', waiting: 'amber', reviewing: 'amber', blocked: 'red', off: 'steel', hold: 'brick' },
  verdict: { pass: 'green', changes: 'brick' },
  // state of a tracked board item (ASK, REQ, BLOCK, DONE)
  msg: { open: 'amber', answered: 'green', accepted: 'green', passed: 'green', refused: 'red', fix: 'brick', cancelled: 'steel', expired: 'steel' },
};
const TONE_SET = new Set(['plain', 'green', 'amber', 'red', 'blue', 'brick', 'steel', 'dark']);
/** The 13 ShopTalk kinds and the hub's EVT (contract section 7). */
export const KINDS = ['ASK', 'ANS', 'REQ', 'OK', 'NO', 'INFO', 'BLOCK', 'DONE', 'FAIL', 'PASS', 'FIX', 'DECIDE', 'CANCEL', 'EVT'];
const KIND_SET = new Set(KINDS);

/** chip(text, tone) -> small colored tag. tone: plain | green | amber | red | blue | brick | steel | dark */
export function chip(text, tone = 'plain', props) {
  return h('span', { class: ['chip', 't-' + (TONE_SET.has(tone) ? tone : 'plain')], ...props }, String(text));
}
/** statusChip(type, status). type: job | task | req | delivery | agent | verdict */
export function statusChip(type, status) {
  const map = TONES[type] || {};
  const tone = Object.hasOwn(map, status) ? map[status] : 'plain';
  return chip(String(status ?? '?').replace(/_/g, ' '), tone);
}
/** kindTag(kind) -> board kind tag. One color per ShopTalk kind (style.css .k-<KIND>): ASK amber, ANS green, INFO blue-gray, BLOCK brick, FAIL red, ... */
export function kindTag(kind) {
  const k = KIND_SET.has(kind) ? kind : 'X';
  return h('span', { class: ['tag', 'k-' + k] }, KIND_SET.has(kind) ? kind : fmt.clip(kind ?? '?', 6));
}

/** domainChip(domain) -> tag with the domain's color square (the color of its crates in the scene). */
export function domainChip(domain) {
  const name = String(domain ?? '?');
  const safe = /^[a-z]{1,20}$/.test(name) ? name : null;
  return h('span', { class: ['chip', 't-plain', 'swatch'], style: safe ? { '--sw': `var(--dom-${safe})` } : null, title: 'Domain' }, fmt.clip(name, 20));
}
/** labChip(provider, label?) -> tag with the lab's color square (the color on the name plates in the scene). */
export function labChip(provider, label) {
  const name = String(provider ?? '?');
  const safe = /^[a-z0-9]{1,20}$/.test(name) ? name : null;
  return h('span', { class: ['chip', 't-plain', 'swatch'], style: safe ? { '--sw': `var(--lab-${safe})` } : null, title: 'Lab' }, fmt.clip(label ?? name, 24));
}

// ------------------------------------------------------------------ buttons and fields

/**
 * btn(label, { onClick, tone, small, type, title, disabled, ...props }) -> <button>
 *   tone: undefined (paper) | 'primary' (amber) | 'go' (green) | 'danger' (red) | 'steel'
 */
export function btn(label, { onClick, tone, small, type = 'button', cls, ...props } = {}) {
  return h('button', { class: ['btn', tone, small && 'small', cls], type, onclick: onClick, ...props }, label);
}

/** Run an async action once: the button is disabled and looks pressed until it settles. */
export async function busy(button, fn) {
  if (button.disabled) return undefined;
  button.disabled = true;
  button.classList.add('is-busy');
  try { return await fn(); } finally { button.disabled = false; button.classList.remove('is-busy'); }
}

/**
 * field(label, control, { hint }) -> <div class="field"> with a real <label for>.
 *   control  an input, textarea or select, or a wrapper that carries the real control as .select or .input
 *            (the result of select() or checkbox()).
 * The result has .control (the real control) and .setError(message | '') to show or clear an inline error.
 */
export function field(label, control, { hint } = {}) {
  // (a textarea has a native .select() method, so only an element counts as a wrapped control)
  const inner = [control.select, control.input].find((x) => x instanceof HTMLElement);
  const target = inner || control;
  if (!target.id) target.id = newId('in');
  const err = h('div.field-error', { role: 'alert' });
  const el = h('div.field', h('label.label', { for: target.id }, label), control, hint ? h('div.help', hint) : null, err);
  el.control = target;
  el.setError = (msg) => {
    err.textContent = msg || '';
    el.classList.toggle('has-error', !!msg);
    if (msg) target.setAttribute('aria-invalid', 'true'); else target.removeAttribute('aria-invalid');
  };
  return el;
}

/** group(legend, ...children) -> <fieldset> for a set of controls that share one label. Has .setError like field(). */
export function group(legend, ...children) {
  const err = h('div.field-error', { role: 'alert' });
  const el = h('fieldset.field.group', h('legend.label', legend), ...children, err);
  el.setError = (msg) => { err.textContent = msg || ''; el.classList.toggle('has-error', !!msg); };
  return el;
}

/**
 * segmented(options, value, onChange) -> radio buttons that look like a row of arcade keys.
 *   options: [{ value, label, title? }]. The result has .value (get/set).
 */
export function segmented(options, value, onChange) {
  const name = newId('seg');
  const inputs = [];
  const el = h('div.seg', { role: 'radiogroup' });
  for (const o of options) {
    const id = newId('sg');
    const input = h('input', { type: 'radio', name, id, value: o.value, checked: o.value === value, onchange: () => { if (input.checked && onChange) onChange(o.value); } });
    inputs.push(input);
    el.append(input, h('label', { for: id, title: o.title }, o.label));
  }
  Object.defineProperty(el, 'value', {
    get: () => (inputs.find((i) => i.checked) || {}).value,
    set: (v) => { for (const i of inputs) i.checked = i.value === v; },
  });
  return el;
}

/** checkbox(label, checked, onChange) -> <div class="check">. The result has .input (the real checkbox). */
export function checkbox(label, checked, onChange) {
  const id = newId('cb');
  const input = h('input', { type: 'checkbox', id, checked: !!checked, onchange: () => onChange && onChange(input.checked) });
  const el = h('div.check', input, h('label', { for: id }, label));
  el.input = input;
  return el;
}

/** select(options, value, props) -> wrapped <select>. options: [{ value, label }] or [{ group, options }]. The result has .select. */
export function select(options, value, props = {}) {
  const opt = (o) => h('option', { value: o.value }, o.label ?? o.value);
  const sel = h('select', { ...props, value }, options.map((o) => (o.group ? h('optgroup', { label: o.group }, o.options.map(opt)) : opt(o))));
  const el = h('span.select', sel);
  el.select = sel;
  return el;
}

/** section(title, ...children). title may be a string or an array of nodes (e.g. text plus a chip). */
export function section(title, ...children) {
  return h('section.sec', h('h3.sec-title', title), ...children);
}

/**
 * Pixel avatar of an agent. url comes from ctx.avatar(agent, scale).
 * Without one (the scene module is the stand-in, or it is missing) a neutral tile with the first letter stands in.
 */
export function avatarEl(agent, url, size = 24, { natural = false } = {}) {
  // natural: the picture keeps the size it was drawn at (a whole number of screen pixels per sprite pixel), so it stays sharp
  if (url) return h('img.avatar', { src: url, alt: '', draggable: false, style: natural ? null : { height: size + 'px', width: 'auto' } });
  const role = agent && /^(boss|manager|maker)$/.test(agent.role) ? agent.role : null;
  return h('span.avatar.blank', { style: { width: size + 'px', height: size + 'px', lineHeight: size - 4 + 'px', fontSize: Math.max(11, Math.round(size * 0.45)) + 'px', '--role': role ? `var(--role-${role})` : null }, 'aria-hidden': 'true' },
    String((agent && agent.name) || '?').slice(0, 1));
}

/**
 * The head of an agent sprite, for a line of text. url comes from ctx.avatar(agent, scale): the sprite at that whole-number scale.
 * The picture keeps that scale (so every pixel stays sharp) and the frame cuts it under the chin. Sprites differ in height
 * (a hat, big hair), but the body under the chin is about 11 sprite pixels in all of them: the frame leaves those out.
 * Without a picture the same neutral tile as avatarEl() stands in.
 */
export function faceEl(agent, url, scale = 2) {
  if (!url) return avatarEl(agent, null, scale > 1 ? 24 : 18);
  const img = h('img', { src: url, alt: '', draggable: false });
  const el = h('span.avatar.face', { 'aria-hidden': 'true', style: { height: 14 * scale + 'px' } }, img);
  const crop = () => { if (img.naturalHeight > 12 * scale) el.style.height = img.naturalHeight - 11 * scale + 'px'; };
  if (img.complete) crop(); else img.addEventListener('load', crop, { once: true });
  return el;
}

/** bar(value 0..1) -> chunky progress bar. */
export function bar(value) {
  const pct = Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100);
  return h('span.bar', { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct, title: pct + '%' }, h('span.bar-fill', { style: { width: pct + '%' } }));
}

/** emptyState(title, text, ...actions) -> the "nothing here yet" block of a panel. */
export function emptyState(title, text, ...actions) {
  return h('div.empty', h('div.empty-title', title), text ? h('p', text) : null, actions.length ? h('div.row', actions) : null);
}

/** "+12 -3" with the add count in green and the delete count in red. */
export function stat(add, del) {
  return h('span.stat', h('span.stat-add', '+' + fmt.num(add)), ' ', h('span.stat-del', '\u2212' + fmt.num(del)));
}

/** A short commit id. The title holds the full one. */
export function sha(value) {
  return h('span.code.sha', { title: typeof value === 'string' ? value : '' }, fmt.sha(value));
}

/**
 * ctxBar(tok, max) -> the share of the model's context window in use: green under 50%, amber under 80%, red above.
 * The result has .set(tok, max) to move it in place.
 */
export function ctxBar(tok, max) {
  const fill = h('span.bar-fill');
  const el = h('span.bar.ctx', { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 }, fill);
  el.set = (t, m) => {
    const share = Number(m) > 0 ? Math.max(0, Math.min(1, (Number(t) || 0) / Number(m))) : 0;
    const pct = Math.round(share * 100);
    fill.style.width = pct + '%';
    el.classList.toggle('warn', share >= 0.5 && share < 0.8);
    el.classList.toggle('hot', share >= 0.8);
    el.setAttribute('aria-valuenow', pct);
    el.title = Number(m) > 0 ? `Context: ${fmt.tokens(t)} of ${fmt.tokens(m)} tokens (${pct}%)` : 'Context size is not known yet';
  };
  el.set(tok, max);
  return el;
}

/** A button that copies text to the clipboard and says so for a moment. */
export function copyButton(text, label = 'Copy', props = {}) {
  const b = btn(label, { small: true, ...props, onClick: async () => {
    let ok = false;
    try { await navigator.clipboard.writeText(String(text)); ok = true; } catch {
      // Older WKWebView: copy through a hidden text box.
      const box = h('textarea', { value: String(text), readOnly: true, style: { position: 'fixed', left: '-9999px', top: '0' }, 'aria-hidden': 'true', tabIndex: -1 });
      document.body.append(box);
      box.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      box.remove();
      b.focus({ preventScroll: true });
    }
    b.textContent = ok ? 'Copied' : 'Select and copy it';
    clearTimeout(b.__t);
    b.__t = setTimeout(() => { b.textContent = label; }, 1600);
  } });
  return b;
}

/** A text link to an outside page. It opens in a new window (http and https only). */
export function extLink(label, url) {
  return h('button.linkish', { type: 'button', title: String(url), onclick: () => openExternal(url) }, label);
}

/**
 * fold(summary, build, { open, onToggle }) -> a disclosure: a caret button and a body that is built the first time it opens.
 * summary: text or nodes. build() -> nodes. The result has .setOpen(bool) and .isOpen.
 */
export function fold(summary, build, { open = false, onToggle, cls } = {}) {
  const body = h('div.fold-body', { hidden: true });
  let built = false;
  const head = h('button.fold-head', { type: 'button', 'aria-expanded': 'false', onclick: () => { el.setOpen(!el.isOpen); if (onToggle) onToggle(el.isOpen); } }, h('span.caret', { 'aria-hidden': 'true' }), summary);
  const el = h('div', { class: ['fold', cls] }, head, body);
  el.isOpen = false;
  el.setOpen = (v) => {
    el.isOpen = !!v;
    if (el.isOpen && !built) { built = true; const kids = build(); if (kids != null) body.append(...(Array.isArray(kids) ? kids.flat(Infinity).filter((k) => k != null && k !== false) : [kids])); }
    body.hidden = !el.isOpen;
    el.classList.toggle('open', el.isOpen);
    head.setAttribute('aria-expanded', String(el.isOpen));
  };
  if (open) el.setOpen(true);
  return el;
}

/**
 * Enter in a textarea calls submit().
 *   mod: false (default)  Enter submits, Shift+Enter makes a new line (short posts)
 *   mod: true             Cmd/Ctrl+Enter submits, Enter makes a new line (long text)
 */
export function submitOnEnter(textarea, submit, { mod = false } = {}) {
  textarea.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    if (mod ? !(e.metaKey || e.ctrlKey) : e.shiftKey || e.altKey) return;
    e.preventDefault();
    submit();
  });
}

/**
 * follower(list, { slack = 24, onChange }) -> { on, pin(), move(fn), stop() }
 * Keeps a scrolling list on its newest line until the owner reads further up (the live log, the board).
 *   on             true while the list follows its end
 *   pin()          go to the end and follow. Call it after new lines went in while `on` was true, or when the owner asks.
 *   move(fn)       the panel moves the view for the owner (a jump to one line): fn() scrolls, and the list follows
 *                  afterwards only when that left the view at the end
 *   onChange(on)   called when the list starts or stops to follow
 * Only a move up ends the following, and only the owner moves the view up. A change of layout (the window, a part of the
 * sheet that appears or grows) can leave the view short of the end, but it is not the owner scrolling: the list goes
 * back to its end. The list follows again when the owner scrolls back to the end.
 */
export function follower(list, { slack = 24, onChange } = {}) {
  let on = true, top = 0, boxW = -1, boxH = -1, dead = false;
  const atEnd = () => list.scrollHeight - list.scrollTop - list.clientHeight < slack;
  const note = () => { top = list.scrollTop; boxW = list.clientWidth; boxH = list.clientHeight; };
  const set = (value) => { if (value === on) return; on = value; if (onChange) onChange(on); };
  function pin() { list.scrollTop = list.scrollHeight; note(); set(true); }
  function onScroll() {
    if (dead) return;
    if (on && (list.clientWidth !== boxW || list.clientHeight !== boxH)) { pin(); return; } // the box changed its size: layout, not the owner
    if (atEnd()) { note(); set(true); } else if (list.scrollTop < top - 1) set(false);
  }
  list.addEventListener('scroll', onScroll, { passive: true });
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (on && !dead) pin(); }) : null;
  if (ro) ro.observe(list);
  return {
    get on() { return on; },
    pin,
    move(fn) { fn(); if (atEnd()) { note(); set(true); } else set(false); },
    stop() { dead = true; list.removeEventListener('scroll', onScroll); if (ro) ro.disconnect(); },
  };
}

// ------------------------------------------------------------------ toasts

const LEVELS = { info: 'NOTE', warn: 'WARN', error: 'ERROR', owner: 'FOR YOU' };
const NARROW = 220; // px: the least width in which a note reads well

/**
 * createToasts(root) -> toasts
 *   toasts.show({ level, text, sticky?, key?, panel?, action?: { label, run }, ms?, onDismiss? }) -> id
 *       level: info | warn | error | owner. Level owner is sticky: it stays until dismissed.
 *       key: a second show() with the same key (or the same level and text) refreshes the first instead of stacking.
 *       onDismiss: called when the owner closes the note (the X or its action button), not when the app removes it.
 *   toasts.dismiss(id) ; toasts.dismissWhere(fn(toast)) ; toasts.list() ; toasts.onChange(fn)
 *   toasts.layout()   fold again after the room of the stack changed (the drawer opened or closed)
 * The newest notes show in full. Older sticky notes fold into one "n more notes for you" button, so the stack
 * never grows over the top bar; no sticky note is dropped until the owner dismisses it. In a stack that is too
 * narrow to read (a wide drawer in a small window) every sticky note folds into that button.
 */
export function createToasts(root) {
  const items = [];
  const listeners = new Set();
  let next = 0, expanded = false;
  const notify = () => { for (const fn of listeners) { try { fn(); } catch (e) { console.error(e); } } };
  // how many notes show at once: fewer in a short window
  const room = () => (window.innerHeight < 760 ? { loose: 2, stuck: 2 } : { loose: 3, stuck: 3 });
  const more = h('button.toast-more', { type: 'button', hidden: true, onclick: () => { expanded = !expanded; layout(); } });
  root.append(more);

  function layout() {
    // A wide drawer in a small window leaves the notes a narrow strip of floor (style.css sets the width of the stack).
    // Under NARROW px a note would be a tall column of short lines: then every sticky note folds into the button.
    const narrow = root.clientWidth > 0 && root.clientWidth < NARROW;
    const keepOpen = narrow ? 0 : room().stuck;
    const stuck = items.filter((x) => x.sticky);
    const extra = Math.max(0, stuck.length - keepOpen);
    if (!extra) expanded = false;
    stuck.forEach((t, i) => { t.el.hidden = !expanded && i < extra; });
    more.hidden = !extra;
    more.textContent = expanded ? 'Show fewer notes' : extra === stuck.length ? `${extra} ${extra === 1 ? 'note' : 'notes'} for you` : `${extra} more ${extra === 1 ? 'note' : 'notes'} for you`;
    more.setAttribute('aria-expanded', String(expanded));
  }
  function arm(t) {
    clearTimeout(t.timer);
    if (!t.sticky) t.timer = setTimeout(() => dismiss(t.id), t.ms);
  }
  function drop(id) {
    const i = items.findIndex((t) => t.id === id);
    if (i < 0) return false;
    const [t] = items.splice(i, 1);
    clearTimeout(t.timer);
    t.el.remove();
    return true;
  }
  function dismiss(id, byOwner = false) {
    const t = items.find((x) => x.id === id);
    if (!drop(id)) return;
    layout(); notify();
    if (byOwner && t && t.onDismiss) { try { t.onDismiss(); } catch (e) { console.error(e); } }
  }
  function show({ level = 'info', text, sticky, key = null, panel = null, action = null, ms, onDismiss = null } = {}) {
    if (!Object.hasOwn(LEVELS, level)) level = 'info';
    const body = String(text ?? '').trim();
    if (!body) return null;
    const same = items.find((t) => (key && t.key === key) || (t.level === level && t.text === body));
    if (same) {
      if (same.text !== body && same.level === level) { same.text = body; same.el.querySelector('.toast-text').textContent = showMarks(body); } // the same note with newer words
      arm(same); same.el.classList.remove('bump'); void same.el.offsetWidth; same.el.classList.add('bump');
      return same.id;
    }
    const t = { id: ++next, level, text: body, key, panel, sticky: sticky ?? level === 'owner', ms: ms || (level === 'error' ? 9000 : level === 'warn' ? 7000 : 5000), timer: 0, el: null, onDismiss };
    t.el = h('div', { class: ['toast', 'lv-' + level, t.sticky && 'is-sticky'], role: level === 'error' || level === 'owner' ? 'alert' : 'status', dataset: { key: key || null, panel: (t.sticky && panel) || null },
      onmouseenter: () => clearTimeout(t.timer), onmouseleave: () => arm(t) },
    h('span.toast-tag', LEVELS[level]),
    h('div.toast-text', body),
    action ? h('button.btn.small.primary', { type: 'button', onclick: () => { dismiss(t.id, true); action.run(); } }, action.label) : null,
    h('button.toast-x', { type: 'button', 'aria-label': 'Dismiss this note', title: 'Dismiss', onclick: () => dismiss(t.id, true) }, 'X'));
    items.push(t);
    root.append(t.el);
    arm(t);
    const loose = items.filter((x) => !x.sticky);
    for (const x of loose.slice(0, Math.max(0, loose.length - room().loose))) drop(x.id);
    const stuck = items.filter((x) => x.sticky);
    for (const x of stuck.slice(0, Math.max(0, stuck.length - 12))) drop(x.id); // a runaway hub must not fill the page
    layout();
    notify();
    return t.id;
  }
  window.addEventListener('resize', layout);
  return {
    show, dismiss: (id) => dismiss(id), layout,
    dismissWhere(fn) { let hit = false; for (const t of items.filter(fn)) hit = drop(t.id) || hit; if (hit) { layout(); notify(); } },
    list: () => items.slice(),
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

// ------------------------------------------------------------------ modal dialog (never window.alert / confirm / prompt)

/**
 * createModals(root, { fallbackFocus? }) -> modals
 *   fallbackFocus() -> element: where the focus goes when the control that opened a dialog is gone after the close
 *   modals.open({ title, body, buttons, onClose, wide, focusFirst }) -> { close(result), buttons: [<button>] }
 *       buttons: [{ label, value?, run?, primary?, tone?, disabled? }]. The primary button is the form's submit, so Enter triggers it.
 *       run() may return false (or a promise of false) to keep the dialog open.
 *       The result holds the button elements in the same order, so a dialog can switch one off until its form is complete.
 *   modals.confirm({ title, text, okLabel, cancelLabel, danger, focusCancel }) -> Promise<boolean>
 *       danger or focusCancel: the focus starts on the cancel button, so Enter never confirms something that cannot be undone.
 *   modals.prompt({ title, label, value, placeholder, multiline, okLabel, required }) -> Promise<string | null>
 *   modals.closeTop() -> true when a dialog was closed (used by Esc) ; modals.count()
 */
export function createModals(root, { fallbackFocus = null } = {}) {
  const stack = [];
  // The control that opened a dialog is often re-rendered away by what the dialog did (a Waive button on a requirement that
  // is now waived). Focus then falls to <body>. For a short while after a close, put it on fallbackFocus() instead.
  let guard = 0;
  function guardFocus(prev) {
    clearInterval(guard);
    if (typeof fallbackFocus !== 'function') return;
    const until = Date.now() + 4000;
    guard = setInterval(() => {
      if (stack.length || Date.now() > until) { clearInterval(guard); return; }
      const a = document.activeElement;
      if (a && a !== document.body && a.isConnected) { if (a !== prev) clearInterval(guard); return; } // the owner moved on
      clearInterval(guard);
      const t = fallbackFocus();
      if (t && t.isConnected && typeof t.focus === 'function') t.focus({ preventScroll: true });
    }, 100);
  }
  // While a dialog is open the rest of the page cannot be clicked or focused.
  const shield = () => { for (const node of root.parentElement ? root.parentElement.children : []) if (node !== root) node.inert = stack.length > 0; };

  function open({ title, body, buttons = [], onClose, wide = false, focusFirst = false }) {
    const prevFocus = document.activeElement;
    const titleId = newId('dlg');
    let closed = false;
    const entry = { close };

    function close(result) {
      if (closed) return;
      closed = true;
      stack.splice(stack.indexOf(entry), 1);
      layer.remove();
      root.classList.toggle('open', stack.length > 0);
      shield();
      if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === 'function') prevFocus.focus({ preventScroll: true });
      if (!stack.length) guardFocus(prevFocus && prevFocus !== document.body ? prevFocus : null);
      if (onClose) onClose(result);
    }
    async function run(b) {
      let result = b.value;
      if (b.run) { result = await b.run(); if (result === false) return; }
      close(result);
    }
    const primary = buttons.find((b) => b.primary);
    const nodes = buttons.map((b) => h('button', { type: b.primary ? 'submit' : 'button', class: ['btn', b.tone || (b.primary ? 'go' : null)], disabled: !!b.disabled, onclick: b.primary ? null : () => run(b) }, b.label));
    entry.buttons = nodes;
    const form = h('form', { class: ['modal', wide && 'wide'], role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, novalidate: true,
      onsubmit: (e) => { e.preventDefault(); if (primary && !nodes[buttons.indexOf(primary)].disabled) run(primary); } },
    h('div.modal-title', { id: titleId }, title),
    h('div.modal-body', body),
    h('div.modal-foot', nodes));
    const layer = h('div.modal-layer', {
      onmousedown: (e) => { if (e.target === layer) close(undefined); },
      onkeydown: (e) => {
        if (e.key !== 'Tab') return;
        const f = focusables(form);
        if (!f.length) { e.preventDefault(); return; }
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      },
    }, form);
    stack.push(entry);
    root.append(layer);
    root.classList.add('open');
    shield();
    // Focus: a box to type in when the dialog has one, else the primary button, so Enter confirms.
    // (A link or a copy button in the body must not catch the Enter key.)
    const f = focusables(form);
    const typing = f.find((el) => el.closest('.modal-body') && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'range'].includes(el.type))));
    const target = (focusFirst && f[0]) || typing || form.querySelector('.modal-foot button[type=submit]') || f[0];
    if (target) target.focus({ preventScroll: true });
    return entry;
  }

  function confirm({ title = 'Are you sure?', text = '', okLabel = 'OK', cancelLabel = 'Cancel', danger = false, focusCancel = false } = {}) {
    return new Promise((resolve) => {
      open({
        title, body: h('p.modal-text', text), focusFirst: danger || focusCancel,
        buttons: [{ label: cancelLabel, value: false }, { label: okLabel, value: true, primary: true, tone: danger ? 'danger' : 'go' }],
        onClose: (v) => resolve(v === true),
      });
    });
  }

  function prompt({ title = 'Your input', label = 'Text', value = '', placeholder = '', multiline = false, okLabel = 'OK', cancelLabel = 'Cancel', required = true } = {}) {
    return new Promise((resolve) => {
      const input = multiline ? h('textarea', { rows: 5, placeholder, value }) : h('input', { type: 'text', placeholder, value, autocomplete: 'off' });
      const f = field(label, input);
      const submit = () => {
        const v = input.value.trim();
        if (required && !v) { f.setError('Type something first.'); input.focus(); return false; }
        return v;
      };
      const dlg = open({
        title, body: f,
        buttons: [{ label: cancelLabel, value: null }, { label: okLabel, primary: true, run: submit }],
        onClose: (v) => resolve(typeof v === 'string' ? v : null),
      });
      if (multiline) submitOnEnter(input, () => { const v = submit(); if (v !== false) dlg.close(v); }, { mod: true });
    });
  }

  return {
    open, confirm, prompt,
    count: () => stack.length,
    closeTop() { const top = stack[stack.length - 1]; if (!top) return false; top.close(undefined); return true; },
  };
}
