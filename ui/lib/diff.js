// Unified diff: a parser and a colored viewer. Diffs are agent-written text, so every line becomes a text node.
//
//   parseDiff(text) -> [file]                                                       (pure, no DOM)
//       file = { path, oldPath, status: 'new' | 'deleted' | 'renamed' | 'changed' | 'binary', binary, add, del, lines, meta: [string], marks,
//                hunks: [{ header, oldStart, newStart, lines: [{ t: ' ' | '+' | '-' | '\\', s, o, n }] }] }
//       marks: the path or a line holds a hidden text-direction character (U+202E and friends). The viewer writes each one
//       out as "[U+202E]" and puts a chip on the file, so code can never read differently from what ships.
//   diffView(text | files, { cap, open, onFile }) -> <div class="df">
//       cap     lines of one file that are drawn at once (default 3000); "Show more" draws the next lot
//       open    'auto' (default: open files until about 400 lines show), 'all', 'none', or a path (open that file only)
//   diffBody(text | file, { cap }) -> the lines of one file, with no file header
//   diffSlot(api, url, build, key?) -> a box that loads a diff (GET url, text/plain) and shows build(text); the text is cached under key

import { h, hasMarks } from './dom.js';

const CAP = 3000;
const stripPrefix = (p) => (p === '/dev/null' ? null : p.replace(/^[ab]\//, ''));
/** git quotes paths that hold special characters: "a/caf\303\251.txt". Undo the quotes; keep the bytes readable. */
function unquote(p) {
  let s = p.trim();
  if (s.length > 1 && s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1).replace(/\\(["\\tn])/g, (_, c) => (c === 't' ? '\t' : c === 'n' ? '\n' : c));
    try { s = decodeURIComponent(s.replace(/%/g, '%25').replace(/\\([0-7]{3})/g, (_, o) => '%' + parseInt(o, 8).toString(16).padStart(2, '0'))); } catch { /* keep the escaped form */ }
  }
  return s;
}

export function parseDiff(text) {
  const src = String(text ?? '');
  const files = [];
  let file = null, hunk = null, o = 0, n = 0, oldLeft = 0, newLeft = 0;
  const begin = () => { file = { path: '', oldPath: null, status: 'changed', binary: false, add: 0, del: 0, lines: 0, meta: [], hunks: [] }; files.push(file); hunk = null; return file; };
  let start = 0;
  const len = src.length;
  while (start <= len) {
    let end = src.indexOf('\n', start);
    if (end < 0) end = len;
    let line = src.slice(start, end);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    start = end + 1;
    if (end === len && line === '') break;

    if (line.startsWith('diff --git ')) {
      begin();
      const m = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(line);
      if (m) { file.oldPath = unquote(m[1]); file.path = unquote(m[2]); }
      file.meta.push(line);
      continue;
    }
    if (hunk && file) {
      const c = line[0];
      // A hunk holds as many lines as its header says. A "\" note may follow its last line.
      const room = oldLeft > 0 || newLeft > 0;
      if ((room && (c === '+' || c === '-' || c === ' ' || line === '')) || c === '\\') {
        if (c === '+') { hunk.lines.push({ t: '+', s: line.slice(1), o: null, n: n++ }); file.add++; newLeft--; }
        else if (c === '-') { hunk.lines.push({ t: '-', s: line.slice(1), o: o++, n: null }); file.del++; oldLeft--; }
        else if (c === '\\') hunk.lines.push({ t: '\\', s: line.slice(2), o: null, n: null });
        else { hunk.lines.push({ t: ' ', s: line.slice(1), o: o++, n: n++ }); oldLeft--; newLeft--; }
        file.lines++;
        continue;
      }
      hunk = null;
    }
    const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (hm) {
      if (!file) begin();
      o = Number(hm[1]); n = Number(hm[3]);
      oldLeft = hm[2] === undefined ? 1 : Number(hm[2]); newLeft = hm[4] === undefined ? 1 : Number(hm[4]);
      hunk = { header: line, oldStart: o, newStart: n, lines: [] };
      file.hunks.push(hunk);
      file.lines++;
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      if (!file || (line.startsWith('--- ') && file.hunks.length)) begin(); // a bare diff with no "diff --git" line
      const p = stripPrefix(unquote(line.slice(4).split('\t')[0]));
      if (line.startsWith('--- ')) { if (p) file.oldPath = p; else file.status = 'new'; }
      else if (p) file.path = p; else { file.status = 'deleted'; file.path = file.oldPath || file.path; }
      file.meta.push(line);
      continue;
    }
    if (!file) continue; // text before the first file (a commit header, an empty answer)
    if (line.startsWith('new file mode')) file.status = 'new';
    else if (line.startsWith('deleted file mode')) file.status = 'deleted';
    else if (line.startsWith('rename from ')) { file.oldPath = unquote(line.slice(12)); file.status = 'renamed'; }
    else if (line.startsWith('rename to ')) { file.path = unquote(line.slice(10)); file.status = 'renamed'; }
    else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) file.binary = true;
    file.meta.push(line);
  }
  for (const f of files) {
    if (!f.path) f.path = f.oldPath || '(unknown file)';
    if (f.status === 'renamed' && (!f.oldPath || f.oldPath === f.path)) f.status = 'changed';
    if (f.status !== 'renamed') f.oldPath = null;
    f.marks = hasMarks(f.path) || hasMarks(f.oldPath) || f.hunks.some((k) => hasMarks(k.header) || k.lines.some((l) => hasMarks(l.s)));
  }
  return files;
}

const STATUS = { new: ['NEW', 't-green'], deleted: ['DELETED', 't-red'], renamed: ['RENAMED', 't-blue'], changed: ['CHANGED', 't-plain'] };
const MARKS_NOTE = 'This file holds characters that change the direction of text without showing. Each one is written out, for example [U+202E]. Read these lines with care.';
/** The chip on a file that holds hidden text-direction characters. */
export function marksChip() { return h('span.chip.t-red.df-marks', { title: MARKS_NOTE }, 'hidden direction marks'); }

function lineRow(l) {
  const cls = l.t === '+' ? 'add' : l.t === '-' ? 'del' : l.t === '\\' ? 'note' : 'ctx';
  return h('div', { class: ['dl', cls] },
    h('span.dl-no', { 'aria-hidden': 'true' }, h('span', l.o == null ? '' : String(l.o)), h('span', l.n == null ? '' : String(l.n)), h('span.dl-sign', l.t === ' ' || l.t === '\\' ? ' ' : l.t)),
    h('span.dl-text', l.t === '\\' ? '\\ ' + l.s : l.s || '\u200b'));
}

/** Draw the lines of one file, `cap` at a time. */
function fileBody(file, cap) {
  if (file.binary) return h('div.df-note', 'Binary file. There is no text diff.');
  if (!file.hunks.length) return h('div.df-note', file.status === 'renamed' ? 'Renamed. The content did not change.' : file.status === 'new' ? 'Empty new file.' : 'No text changes.');
  // flatten: hunk headers and lines in one list, so the cap counts what is drawn
  const rows = [];
  for (const k of file.hunks) { rows.push(k); for (const l of k.lines) rows.push(l); }
  const code = h('div.df-code');
  const more = h('div.df-more');
  let at = 0;
  const draw = () => {
    const frag = document.createDocumentFragment();
    const stop = Math.min(rows.length, at + cap);
    for (; at < stop; at++) { const r = rows[at]; frag.append(r.lines ? h('div.dl.hunk', h('span.dl-no', { 'aria-hidden': 'true' }, h('span', ''), h('span', ''), h('span.dl-sign', ' ')), h('span.dl-text', r.header)) : lineRow(r)); }
    code.append(frag);
    more.replaceChildren();
    const left = rows.length - at;
    if (left > 0) {
      more.append(
        h('span', `${at} of ${rows.length} lines shown.`),
        h('button.btn.small', { type: 'button', onclick: draw }, `Show ${Math.min(cap, left)} more`),
        left > cap ? h('button.btn.small', { type: 'button', onclick: () => { cap = rows.length; draw(); } }, `Show all ${left}`) : null);
    }
    more.hidden = left <= 0;
  };
  draw();
  return h('div.df-body', h('div.df-scroll', { tabIndex: 0, role: 'group', 'aria-label': `Changes in ${file.path}` }, code), more);
}

/** diffBody(text | file, { cap }) -> the lines of one file with no file header (the first file of a text). */
export function diffBody(input, { cap = CAP } = {}) {
  const file = typeof input === 'string' ? parseDiff(input)[0] : input;
  if (!file) return h('div.df.df-solo', h('div.df-note', 'No changes.'));
  // what kind of change it is, when it is more than an edit
  const [word, tone] = file.binary ? ['BINARY', 't-steel'] : STATUS[file.status] || STATUS.changed;
  const status = file.binary || file.status !== 'changed' || file.marks ? h('div.df-status', file.binary || file.status !== 'changed' ? h('span', { class: ['chip', tone] }, word) : null,
    file.status === 'renamed' && file.oldPath ? h('span', 'from ', h('span.code', file.oldPath)) : file.status === 'new' ? 'This file is new.' : file.status === 'deleted' ? 'This file is deleted.' : null,
    file.marks ? [marksChip(), h('span', 'Hidden direction characters are written out, for example [U+202E].')] : null) : null;
  return h('div.df.df-solo', h('div.df-file.open', status, fileBody(file, cap)));
}

/**
 * diffView(text | files, { cap, open, onFile }) -> element. The result has .files (the parsed list).
 * A file body is built the first time it opens, so a big load stays light.
 */
export function diffView(input, { cap = CAP, open = 'auto', onFile } = {}) {
  const files = Array.isArray(input) ? input : parseDiff(input);
  const el = h('div.df');
  el.files = files;
  if (!files.length) { el.append(h('div.df-note', 'No changes.')); return el; }
  let budget = 400; // 'auto': lines that may show before the rest stays folded
  for (const f of files) {
    const [word, tone] = f.binary ? ['BINARY', 't-steel'] : STATUS[f.status] || STATUS.changed;
    const holder = h('div.df-hold', { hidden: true });
    let built = false;
    const head = h('button.df-head', { type: 'button', 'aria-expanded': 'false', title: f.path },
      h('span.caret', { 'aria-hidden': 'true' }),
      h('span', { class: ['chip', tone] }, word),
      h('span.df-path', f.status === 'renamed' && f.oldPath ? [h('span.df-old', f.oldPath), ' \u2192 ', f.path] : f.path),
      f.marks ? marksChip() : null,
      f.binary ? null : h('span.stat', h('span.stat-add', '+' + f.add), ' ', h('span.stat-del', '\u2212' + f.del)));
    const sec = h('section.df-file', { dataset: { path: f.path } }, head, holder);
    const setOpen = (v) => {
      if (v && !built) { built = true; holder.append(fileBody(f, cap)); }
      holder.hidden = !v;
      sec.classList.toggle('open', v);
      head.setAttribute('aria-expanded', String(v));
    };
    head.addEventListener('click', () => { const v = holder.hidden; setOpen(v); if (onFile) onFile(f, v); });
    const want = open === 'all' ? true : open === 'none' ? false : open === 'auto' ? budget > 0 : open === f.path;
    if (want) { setOpen(true); budget -= Math.max(20, f.lines); }
    el.append(sec);
  }
  return el;
}

// ------------------------------------------------------------------ loading

const texts = new Map(); // diff text by key. A diff of one delivery never changes; the whole load is keyed by its head.

/** Text of a diff: GET url (text/plain). Cached under `key`, so opening a file twice is instant. */
export function diffText(api, url, key = url) {
  const hit = texts.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  return api.get(url, { quiet: true, throws: true, timeoutMs: 120000 }).then((t) => {
    const text = typeof t === 'string' ? t : '';
    texts.set(key, text);
    if (texts.size > 80) texts.delete(texts.keys().next().value);
    return text;
  });
}

/** A box that shows a diff as soon as it is there. build(text) -> element. key: the cache key (default: the URL). */
export function diffSlot(api, url, build, key = url) {
  const slot = h('div.df-slot');
  const hit = texts.get(key);
  if (typeof hit === 'string') { slot.append(build(hit)); return slot; }
  slot.append(h('div.df-wait', { role: 'status' }, 'Loading the diff...'));
  diffText(api, url, key).then(
    (text) => slot.replaceChildren(build(text)),
    (e) => slot.replaceChildren(h('div.callout.bad', h('div.callout-title', 'The diff did not load'), h('p', String((e && e.message) || 'The hub does not answer.')),
      h('button.btn.small', { type: 'button', onclick: () => slot.replaceWith(diffSlot(api, url, build, key)) }, 'Try again'))));
  return slot;
}
