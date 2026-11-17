// A small, safe Markdown view for agent-written reports (contract section 13b, rendering rule).
// It knows headings, lists, code and bold. Links and images show as plain text. Nothing here parses HTML:
// every piece of text becomes a text node through h().
//
// A report is untrusted text (a boss writes it), and the view takes up to 200,000 characters. So every pattern here
// runs in time that grows in a straight line with the text: no pattern holds two optional runs that can match the
// same characters. Three more guards: a line over LINE_MAX characters is drawn as plain text, a "line separator"
// character counts as a line break, and the view draws at most NODE_MAX blocks and list items.
//
//   mdBlocks(text) -> [{ t: 'h', level, text } | { t: 'p', text, plain? } | { t: 'ul' | 'ol', items: [text] } | { t: 'code', text } | { t: 'hr' }]   (pure, no DOM)
//       plain: the line was too long to parse; its text is drawn as it is
//   mdInline(text) -> [{ t: 'text' | 'bold' | 'code', s }]                                                                                           (pure, no DOM)
//   markdown(text, { maxChars }) -> <div class="md">

import { h } from './dom.js';

const MAX = 200000;
export const LINE_MAX = 2000; // a longer line is not parsed: it shows as plain text
const NODE_MAX = 4000;        // blocks and list items the view draws

// "[text](url)" and "![alt](url)", with an optional "title". The label holds no "[" and the URL holds no "(":
// so a run of "[" or of "[a](" can never be read in more than one way.
const LINK = /!?\[([^\[\]\n]*)\]\(([^()\s]+)(?:[ \t]+"[^"\n]*")?\)/g;

/** Links and images are not rendered. "[text](url)" reads "text (url)"; "![alt](url)" reads "image: alt (url)". */
function plainLinks(s) {
  if (!s.includes('](')) return s;
  return s.replace(LINK, (all, label, url) => {
    if (all.startsWith('!')) return `image: ${label || 'no description'} (${url})`;
    return !label || label === url ? url : `${label} (${url})`;
  });
}

/** Split one line of text into plain, bold and code runs. */
export function mdInline(text) {
  const out = [];
  const push = (t, s) => { if (!s) return; const last = out[out.length - 1]; if (last && last.t === t) last.s += s; else out.push({ t, s }); };
  // code spans first: nothing inside them is formatted
  const parts = String(text).split(/(`[^`\n]+`)/);
  for (const part of parts) {
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) { push('code', part.slice(1, -1)); continue; }
    const s = plainLinks(part);
    const rx = /\*\*([^*\n]+)\*\*|__([^_\n]+)__/g;
    let at = 0, m;
    while ((m = rx.exec(s))) {
      push('text', s.slice(at, m.index));
      push('bold', m[1] ?? m[2]);
      at = rx.lastIndex;
    }
    push('text', s.slice(at));
  }
  return out;
}

/**
 * The text of a heading line after its "#" marks. A closing run of "#" goes when a space stands before it
 * ("## Title ##" reads "Title"; "# C#" stays "C#"). Plain string code: no pattern, so no slow case.
 */
function headingText(rest) {
  const s = rest.trimEnd();
  let end = s.length;
  while (end > 0 && s[end - 1] === '#') end--;
  if (end === s.length) return s;
  return end === 0 || s[end - 1] === ' ' || s[end - 1] === '\t' ? s.slice(0, end).trimEnd() : s;
}

/** Split a document into blocks. */
export function mdBlocks(text) {
  const lines = String(text ?? '').replace(/\r\n?|[\u2028\u2029]/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flush = () => { if (para.length) { out.push({ t: 'p', text: para.join(' ') }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) { // fenced code: up to the closing fence, or the end of the text
      flush();
      const body = [];
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) body.push(lines[i]);
      out.push({ t: 'code', text: body.join('\n') });
      continue;
    }
    const prev = out[out.length - 1];
    if (line.length > LINE_MAX) { // too long to be a heading or a list item of a real report: plain text, not parsed
      flush();
      if (prev && prev.open) prev.open = false;
      out.push({ t: 'p', text: line, plain: true });
      continue;
    }
    if (!para.length && prev && prev.open && /^\s{2,}\S/.test(line) && !/^\s*(?:[-*+]|\d{1,3}[.)])\s+/.test(line)) { prev.items[prev.items.length - 1] += ' ' + line.trim(); continue; } // a wrapped list item
    if (/^( {4}|\t)\S/.test(line) && !para.length) { // indented code
      const body = [];
      for (; i < lines.length && (/^( {4}|\t)/.test(lines[i]) || (lines[i].trim() === '' && /^( {4}|\t)/.test(lines[i + 1] || ''))); i++) body.push(lines[i].replace(/^( {4}|\t)/, ''));
      i--;
      out.push({ t: 'code', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const head = /^ {0,3}(#{1,6})[ \t]+(.*)$/.exec(line);
    if (head) { flush(); out.push({ t: 'h', level: head[1].length, text: headingText(head[2]) }); continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push({ t: 'hr' }); continue; }
    const item = /^\s*(?:([-*+])|(\d{1,3})[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const kind = item[1] ? 'ul' : 'ol';
      const last = out[out.length - 1];
      if (last && last.t === kind && last.open) last.items.push(item[3]);
      else out.push({ t: kind, items: [item[3]], open: true });
      continue;
    }
    if (prev && prev.open) prev.open = false;
    para.push(line.trim());
  }
  flush();
  for (const b of out) delete b.open;
  return out;
}

const inline = (text) => mdInline(text).map((r) => (r.t === 'bold' ? h('strong', r.s) : r.t === 'code' ? h('span.code', r.s) : r.s));

/** markdown(text) -> element. Text over maxChars is cut, and the view says so. So does a text with too many blocks. */
export function markdown(text, { maxChars = MAX } = {}) {
  let src = String(text ?? '');
  const cut = src.length > maxChars;
  if (cut) src = src.slice(0, maxChars);
  const el = h('div.md');
  let room = NODE_MAX, dropped = false; // a text of 60,000 one-word blocks must not fill the page with 60,000 elements
  for (const b of mdBlocks(src)) {
    if (room <= 0) { dropped = true; break; }
    room--;
    if (b.t === 'h') el.append(h('div', { class: ['md-h', 'md-h' + Math.min(4, b.level)], role: 'heading', 'aria-level': String(Math.min(6, b.level + 3)) }, inline(b.text)));
    else if (b.t === 'p') el.append(b.plain ? h('p.md-plain', b.text) : h('p', inline(b.text)));
    else if (b.t === 'ul' || b.t === 'ol') {
      const keep = Math.max(1, room);
      if (b.items.length > keep) dropped = true;
      const items = b.items.slice(0, keep);
      room -= items.length;
      el.append(h(b.t, items.map((it) => h('li', inline(it)))));
    } else if (b.t === 'code') el.append(h('pre.md-code', b.text));
    else if (b.t === 'hr') el.append(h('div.md-hr', { role: 'separator' }));
  }
  if (dropped) el.append(h('p.dim', `The text has more than ${NODE_MAX} blocks. The rest is not shown.`));
  if (cut) el.append(h('p.dim', `The text is longer than ${maxChars} characters. The rest is not shown.`));
  return el;
}
