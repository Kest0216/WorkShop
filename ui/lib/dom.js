// DOM helpers. All text from the server is untrusted, so nothing here ever parses HTML.
// Build every node with h(); text children become text nodes.
// Hidden text-direction characters (U+202E and friends) are drawn as a visible mark, so agent text can never
// read differently from what it holds (the "Trojan Source" trick).

const BLOCKED = new Set(['innerHTML', 'outerHTML', 'srcdoc']);
const URL_ATTRS = new Set(['href', 'src', 'action', 'formAction', 'poster']);
const BOOL_PROPS = new Set(['disabled', 'checked', 'hidden', 'selected', 'readOnly', 'required', 'multiple', 'open', 'autofocus']);
const TEXT_ATTRS = new Set(['title', 'alt', 'placeholder', 'aria-label']);

// Characters that change the direction of text without showing: ALM, LRM, RLM, the embeddings and overrides, the isolates.
const MARKS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const MARKS_ALL = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
/** True when the text holds a hidden direction mark. */
export function hasMarks(text) { return MARKS.test(String(text ?? '')); }
/** The text with every hidden direction mark written out, for example "[U+202E]". Other text is returned as it is. */
export function showMarks(text) {
  const s = String(text ?? '');
  return MARKS.test(s) ? s.replace(MARKS_ALL, (c) => `[U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}]`) : s;
}

/** True for http(s), same-page (#), relative paths and image data URLs. Refuses javascript: and friends. */
export function safeUrl(value) {
  const s = String(value).trim();
  if (s.startsWith('#') || s.startsWith('/') || s.startsWith('./') || s.startsWith('../')) return true;
  if (/^https?:\/\//i.test(s)) return true;
  if (/^data:image\/(png|gif|jpeg|webp);/i.test(s)) return true;
  if (/^blob:/i.test(s)) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(s);
}

function addClass(el, v) {
  if (!v) return;
  const list = Array.isArray(v) ? v : String(v).split(/\s+/);
  for (const c of list) if (c) el.classList.add(c);
}

function setProp(el, key, value) {
  if (BLOCKED.has(key)) { console.warn(`h(): "${key}" is not allowed. Use text children.`); return; }
  if (key === 'class' || key === 'className') { addClass(el, value); return; }
  if (key === 'style') {
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) { if (v == null) continue; if (k.startsWith('--')) el.style.setProperty(k, String(v)); else el.style[k] = v; }
    }
    return;
  }
  if (key === 'dataset') { if (value) for (const [k, v] of Object.entries(value)) if (v != null) el.dataset[k] = String(v); return; }
  if (key === 'attrs') { if (value) for (const [k, v] of Object.entries(value)) setProp(el, k, v); return; }
  if (key.length > 2 && key.startsWith('on')) {
    if (typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value != null) console.warn(`h(): "${key}" must be a function.`);
    return;
  }
  if (BOOL_PROPS.has(key)) { el[key] = !!value; return; }
  if (key === 'spellcheck' || key === 'draggable') { el.setAttribute(key, value ? 'true' : 'false'); return; } // "false" must be written out
  if (value == null || value === false) return;
  if (TEXT_ATTRS.has(key) && typeof value === 'string') value = showMarks(value);
  if (URL_ATTRS.has(key)) { if (safeUrl(value)) el.setAttribute(key === 'formAction' ? 'formaction' : key, String(value)); return; }
  if (key === 'for') { el.htmlFor = String(value); return; }
  if (!key.includes('-') && key in el) {
    try { el[key] = value; return; } catch { /* read-only property: fall through to the attribute */ }
  }
  el.setAttribute(key, value === true ? '' : String(value));
}

function append(el, kids) {
  for (const c of kids) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(showMarks(c)));
  }
}

/**
 * h(tag, props?, ...children) -> HTMLElement
 *   tag       'div', or shorthand 'button.btn.go#save'
 *   props     plain object (optional): class | style{} | dataset{} | attrs{} | on<event>: fn | any DOM property | any attribute
 *   children  strings and numbers (as text), nodes, arrays; null / false are skipped
 */
export function h(tag, props, ...children) {
  let name = tag, id = null, classes = null;
  if (/[.#]/.test(tag)) {
    const parts = tag.split(/(?=[.#])/);
    name = parts[0] || 'div';
    for (const p of parts.slice(1)) { if (p[0] === '#') id = p.slice(1); else (classes ||= []).push(p.slice(1)); }
  }
  const el = document.createElement(name);
  if (id) el.id = id;
  if (classes) el.className = classes.join(' ');
  const isProps = props != null && typeof props === 'object' && !(props instanceof Node) && !Array.isArray(props);
  if (!isProps) { children.unshift(props); props = null; }
  let late = null; // "value" of a <select> only sticks after its options exist
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (k === 'value' && name === 'select') { late = v; continue; }
      setProp(el, k, v);
    }
  }
  append(el, children);
  if (late != null) el.value = late;
  return el;
}

/** Remove every child. */
export function clear(el) { el.replaceChildren(); return el; }

/** Replace the children of el. */
export function mount(el, ...children) { const f = document.createDocumentFragment(); append(f, children); el.replaceChildren(f); return el; }

const KEYED = new WeakMap();
/**
 * keyed(parent, items, { key, sig, render }) keeps parent's children in step with items without rebuilding what did not change.
 *   key(item)     -> stable id
 *   sig(item)     -> string or number; the node is rebuilt only when this changes (default: always rebuild)
 *   render(item)  -> HTMLElement
 * parent must hold only keyed children. Returns the number of nodes that were built.
 */
export function keyed(parent, items, { key, sig, render }) {
  const old = KEYED.get(parent) || new Map();
  const next = new Map();
  let built = 0;
  // Drop the nodes of vanished items first, so the nodes that stay are not moved (a move blurs focus).
  const keys = items.map(key);
  if (old.size) {
    const alive = new Set(keys);
    for (const [k, rec] of old) if (!alive.has(k)) { if (rec.node.parentNode === parent) parent.removeChild(rec.node); old.delete(k); }
  }
  let cursor = parent.firstChild;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const k = keys[i];
    const s = sig ? sig(item) : NaN;
    let rec = old.get(k);
    if (!rec || rec.sig !== s) {
      const node = render(item);
      built++;
      if (rec && rec.node.parentNode === parent) { if (cursor === rec.node) cursor = node; parent.replaceChild(node, rec.node); }
      rec = { node, sig: s };
    }
    next.set(k, rec);
    if (rec.node === cursor) cursor = cursor.nextSibling;
    else parent.insertBefore(rec.node, cursor);
  }
  KEYED.set(parent, next);
  return built;
}

let uid = 0;
/** A document-unique id for label/input pairs. */
export function newId(prefix = 'f') { return `${prefix}-${++uid}`; }

/** Focusable elements inside root, in tab order. */
export function focusables(root) {
  return [...root.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.type !== 'hidden' && el.getClientRects().length > 0);
}

/** Open an external link in a new window without giving it a handle on this one. Only http(s). */
export function openExternal(url) {
  if (/^https?:\/\//i.test(String(url))) window.open(String(url), '_blank', 'noopener');
}
