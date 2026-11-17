// Models panel (contract sections 11 and 13b): the model registry and what the router makes of it.
// Registry table: model, lab, tier, power, price in / out, one score per benchmark category, an enabled toggle.
// The model column holds name, lab, tier, power and price in three short lines and stays in place, and the score cells are
// narrow, so the six main scores show without sideways scrolling in the (wider) drawer of this panel, also in a 1000 px window.
// Leaders per domain and tier, the data source and its date, Refresh benchmarks, Save.
// Data: ctx.store.models = { registry, leaders }. Save: PUT /api/models { registry }. Refresh: POST /api/models/refresh.
// Jev is not a model row: it is a key in the Keys panel.

import { h, mount } from '../lib/dom.js';
import * as ui from '../lib/widgets.js';

const fmt = ui.fmt;
const ROLES = ['boss', 'manager', 'maker'];
const CORE = ['overall', 'agentic', 'coding', 'reasoning', 'multimodalGrounded', 'knowledge']; // the BenchLM boards: the default score columns

// The column choice and the toggles that are not saved yet stay while the drawer is closed.
const keep = { view: 'core', draft: new Map() }; // draft: model id -> enabled
let view = null;

// ------------------------------------------------------------------ reading the registry (tolerant of older shapes)

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** [[key, { label, scale, tie, source, date, note, lowerIsBetter }]] */
function categories(r) {
  if (Array.isArray(r.categories)) return r.categories.filter((c) => c && c.id != null).map((c) => [String(c.id), c]);
  return isObj(r.categories) ? Object.entries(r.categories).filter(([, c]) => isObj(c)) : [];
}
/** [[domain, { label, keys, note }]] */
function domains(r) {
  if (!isObj(r.domains)) return [];
  return Object.entries(r.domains).map(([d, v]) => [d, Array.isArray(v) ? { label: d, keys: v } : isObj(v) && Array.isArray(v.keys) ? v : { label: d, keys: isObj(v) ? Object.keys(v) : [] }]);
}
const tiersOf = (m) => (Array.isArray(m.tiers) ? m.tiers.map(String) : m.tier ? [String(m.tier)] : []);
const scoreOf = (m, key) => { const v = isObj(m.scores) ? m.scores[key] : null; const n = isObj(v) ? v.score : v; return typeof n === 'number' && Number.isFinite(n) ? n : null; };
const enabledOf = (m) => (keep.draft.has(m.id) ? keep.draft.get(m.id) : m.enabled !== false);

function fmtScore(v, cat) {
  if (v == null) return '–';
  const scale = String((cat && cat.scale) || '');
  if (scale === 'usd') return fmt.money(v);
  if (scale === 'elo' || Math.abs(v) >= 1000) return String(Math.round(v));
  const s = Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(1);
  return s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1') + (scale === 'percent' ? '%' : '');
}
const price = (n) => (typeof n === 'number' && Number.isFinite(n) ? '$' + (n < 1 ? n.toFixed(2).replace(/0$/, '') : String(Math.round(n * 100) / 100)) : '–');

/**
 * A score column is narrow, so a long word in its head needs a place to break. It never breaks inside a syllable: only at a
 * soft hyphen (it shows only when the word does break), at a capital inside the word ("Frontier-Math"), at a hyphen it
 * already has, or between two consonants that stand between vowels ("Chartog-raphy"). A word shorter than 10 letters stays
 * whole: the head box grows to fit it (style.css .mo-th).
 */
const SYLLABLES = { multimodal: 'Multi-modal', improvement: 'improve-ment', intelligence: 'Intel-ligence' };
export function breakable(label) {
  const soft = '\u00AD';
  return String(label).split(' ').map((w) => {
    if (w.length < 10) return w;
    const known = SYLLABLES[w.toLowerCase()];
    if (known && known.replace(/-/g, '').toLowerCase() === w.toLowerCase()) {
      let i = 0; // keep the letters (and their case) of the label; take only the break points from the table
      return known.split('-').map((part) => { const out = w.slice(i, i + part.length); i += part.length; return out; }).join(soft);
    }
    return w.split('-').map((part) => {
      if (part.length < 8) return part;
      const at = new Set();
      for (let i = 3; i <= part.length - 3; i++) {
        const a = part[i - 1], b = part[i];
        if (/[a-z]/.test(a) && /[A-Z]/.test(b)) at.add(i);
        else if (/[aeiouy]/.test(part[i - 2]) && /[b-df-hj-np-tv-xz]/.test(a) && /[b-df-hj-np-tv-xz]/.test(b) && /[aeiouy]/.test(part[i + 1] || '')
          && !/^(ch|ck|ph|sh|th|ng|qu|wh)$/.test(a + b)) at.add(i);
      }
      let out = '', from = 0;
      for (const i of [...at].sort((x, y) => x - y)) { out += part.slice(from, i) + soft; from = i; }
      return out + part.slice(from);
    }).join('-');
  }).join(' ');
}

/** Five squares, n of them filled. */
const pips = (n) => h('span.mo-pips', { title: `Power ${n} of 5`, role: 'img', 'aria-label': `Power ${n} of 5` }, [1, 2, 3, 4, 5].map((i) => h('span', { class: i <= n ? 'on' : null })));

// ------------------------------------------------------------------ render

function part(node, sig, build) {
  if (node.__sig === sig) return;
  node.__sig = sig;
  mount(node, build());
}

function sourceLine(ctx, r) {
  const a = isObj(r.attribution) ? r.attribution : null;
  const text = a ? String(a.text || 'Benchmark data') : String(r.source || 'Benchmark data');
  const fetched = r.fetchedAt || (r.updatedAt ? fmt.date(r.updatedAt) : null);
  return h('div.mo-source',
    h('div', h('span.strong', text), a && a.license ? h('span.dim', ` (${a.license})`) : null, a && a.url ? [' ', ui.extLink('Open the source', a.url)] : null),
    h('div.dim', r.dataDate ? `Data of ${r.dataDate}` : 'The data has no date', fetched ? ` · fetched ${fetched}` : '', ` · ${fmt.plural((r.models || []).length, 'model')}, ${fmt.plural(categories(r).length, 'score', 'scores')} each`));
}

function table(ctx, r) {
  const cats = new Map(categories(r));
  const doms = domains(r);
  const dom = doms.find(([d]) => 'd:' + d === keep.view);
  const all = [...cats.keys()];
  const keys = keep.view === 'all' ? all : dom ? dom[1].keys.filter((k) => cats.has(k)) : CORE.filter((k) => cats.has(k)).length ? CORE.filter((k) => cats.has(k)) : all.slice(0, 6);
  const models = Array.isArray(r.models) ? r.models : [];
  // the best value of each column among the models that are switched on; values inside the tie gap count as equal
  const best = new Map();
  for (const k of keys) {
    const cat = cats.get(k) || {};
    const vals = models.filter((m) => enabledOf(m)).map((m) => scoreOf(m, k)).filter((v) => v != null);
    if (vals.length) best.set(k, { v: cat.lowerIsBetter ? Math.min(...vals) : Math.max(...vals), tie: Number(cat.tie) || 0 });
  }
  const th = (k) => { const c = cats.get(k) || {}; return h('th.num', { scope: 'col', lang: 'en', title: [c.label || k, c.scale ? `Scale: ${c.scale}` : '', c.source ? `Source: ${c.source}${c.date ? ', ' + c.date : ''}` : '', c.lowerIsBetter ? 'Lower is better.' : '', c.tie ? `Tie gap: ${c.tie}` : '', c.note || ''].filter(Boolean).join('\n') }, h('div.mo-th', breakable(c.label || k))); };
  return h('div.scroll-x.mo-wrap', { tabIndex: 0, role: 'group', 'aria-label': 'Model registry' },
    h('table.table.mo-table',
      h('thead', h('tr', h('th.mo-on', { scope: 'col', title: 'Enabled: the router may pick this model' }, 'On'),
        h('th.mo-model', { scope: 'col', title: 'Model and lab. Tier: the crew role this model is picked for first. The squares show its power, 1 to 5. Price: USD per 1 million tokens, input / output.' }, 'Model', h('div.mo-headsub', 'tier · $ in / out')),
        keys.map(th))),
      h('tbody', models.map((m) => {
        const on = enabledOf(m);
        const tiers = tiersOf(m);
        const p = isObj(m.price) ? m.price : {};
        const box = ui.checkbox('', on, (v) => { if (v === (m.enabled !== false)) keep.draft.delete(m.id); else keep.draft.set(m.id, v); refresh(ctx); });
        box.input.setAttribute('aria-label', `Enable ${m.label || m.id}`);
        box.input.dataset.model = String(m.id);
        box.classList.add('mo-check');
        const notes = [m.planNote, p.note, m.estimated ? 'Some scores of this model are estimates.' : ''].filter(Boolean).join('\n');
        return h('tr', { class: [!on && 'is-off', keep.draft.has(m.id) && 'is-dirty'] },
          h('td.mo-on', box),
          h('td.mo-model', { title: [String(m.id), notes].filter(Boolean).join('\n') }, h('div.mo-box',
            h('div.strong.mo-name', String(m.label || m.id), m.estimated ? h('span.mo-est', { title: 'Some scores of this model are estimates.' }, ' est.') : null),
            h('div.mo-sub', ui.labChip(m.provider, m.provider),
              h('span.mo-tier', { title: tiers.length > 1 ? `Picked first as ${tiers[0]}. Fallback: ${tiers.slice(1).join(', ')}.` : 'Tier: the crew role this model is picked for' }, tiers.length ? tiers[0] : '–', tiers.length > 1 ? h('span.dim', ' +' + (tiers.length - 1)) : null)),
            h('div.mo-sub', pips(Math.max(0, Math.min(5, Number(m.power) || 0))),
              h('span.mo-price', { title: `USD per 1 million tokens: ${price(p.in)} in, ${price(p.out)} out${p.note ? '\n' + p.note : ''}` }, p.in === 0 && p.out === 0 ? '$0 (local)' : `${price(p.in)} / ${price(p.out)}`)))),
          keys.map((k) => {
            const v = scoreOf(m, k), b = best.get(k);
            const top = on && v != null && b && Math.abs(v - b.v) <= b.tie;
            return h('td.num', { class: [top && 'mo-best', v == null && 'dim'], title: v == null ? 'No score found. This is not zero.' : top ? (v === b.v ? 'Best of the enabled models' : 'Inside the tie gap of the best') : null }, fmtScore(v, cats.get(k)));
          }));
      }))));
}

function leaders(ctx, r, L) {
  const cats = new Map(categories(r));
  const rows = domains(r).filter(([d]) => isObj(L[d]));
  if (!rows.length) return h('p.dim', 'The hub sent no leaders.');
  return h('ul.list.mo-leaders', rows.map(([d, def]) => h('li.li.mo-lead',
    h('div.mo-dom', ui.domainChip(d), h('span', String(def.label || d))),
    h('div.mo-roles', ROLES.map((role) => {
      const list = Array.isArray(L[d][role]) ? L[d][role] : [];
      const top = list[0];
      const val = top ? top.value ?? top.score : null;
      const cat = top ? cats.get(top.key) : null;
      const title = list.map((x, i) => `${i + 1}. ${x.label} ${fmtScore(x.value ?? x.score, cats.get(x.key))}`).join('\n');
      return [h('span.mo-role', role),
        top ? h('span.mo-top', { title }, h('span', { class: ['chip', 't-plain', 'swatch'], style: { '--sw': `var(--lab-${/^[a-z0-9]+$/.test(String(top.provider)) ? top.provider : 'mock'})` } }, String(top.label))) : h('span.dim', 'no enabled model'),
        top ? h('span.mo-val', { title: cat ? `${cat.label || top.key}${cat.note ? ': ' + cat.note : ''}` : String(top.key || '') }, fmtScore(typeof val === 'number' ? val : null, cat), h('span.dim', ` ${fmt.clip((cat && cat.label) || top.key || '', 22)}`)) : h('span')];
    })))));
}

function refresh(ctx) {
  if (!view) return;
  const { registry: r, leaders: L } = ctx.store.models || {};
  if (!isObj(r) || !Array.isArray(r.models)) {
    for (const k of ['source', 'pick', 'table', 'save', 'leaders']) part(view[k], 'none', () => null);
    view.reg.hidden = true; view.save.hidden = true;
    part(view.empty, 'none', () => ui.emptyState('No model registry', 'The hub sent no registry. Press Refresh to load it.', ui.btn('Refresh benchmarks', { onClick: (e) => refreshBench(ctx, e.currentTarget) })));
    return;
  }
  part(view.empty, 'some', () => null);
  view.reg.hidden = false;
  // drop draft entries that match the registry again (saved elsewhere, or toggled back)
  for (const [id, v] of [...keep.draft]) { const m = r.models.find((x) => x.id === id); if (!m || (m.enabled !== false) === v) keep.draft.delete(id); }
  const doms = domains(r);
  if (keep.view !== 'core' && keep.view !== 'all' && !doms.some(([d]) => 'd:' + d === keep.view)) keep.view = 'core';
  const dom = doms.find(([d]) => 'd:' + d === keep.view);
  const stamp = [r.dataDate, r.fetchedAt, r.updatedAt, r.models.length].join('|');

  part(view.source, stamp, () => [
    h('div.mo-head', sourceLine(ctx, r), ui.btn('Refresh benchmarks', { small: true, title: 'Ask the hub to fetch newer benchmark data', onClick: (e) => refreshBench(ctx, e.currentTarget) })),
    r.tieNote || r.nullNote ? ui.fold('How to read the numbers', () => [r.nullNote ? h('p', String(r.nullNote)) : null, r.tieNote ? h('p', String(r.tieNote)) : null,
      h('p', 'A bold score is the best of its column among the enabled models, or inside the tie gap of the best. Hold the pointer on a column head for its source and date.')]) : null,
  ]);

  part(view.pick, [keep.view, doms.map(([d]) => d).join()].join('|'), () => {
    const box = ui.select([{ value: 'core', label: 'Main boards' }, { group: 'Scores the router uses for a domain', options: doms.map(([d, def]) => ({ value: 'd:' + d, label: `${def.label || d} (${d})` })) }, { value: 'all', label: `All ${categories(r).length} scores` }],
      keep.view, { onchange: () => { keep.view = box.select.value; refresh(ctx); } });
    const f = ui.field('Score columns', box, { hint: dom ? `${dom[1].note ? dom[1].note + ' ' : ''}The router compares models on the first of these scores that every candidate has.` : keep.view === 'all' ? 'Every score of the registry. The model column stays in place while you scroll sideways.' : 'The six BenchLM boards. Choose a domain to see the scores the router uses for it.' });
    f.classList.add('mo-pick');
    return f;
  });

  // A toggle rebuilds the table (the best marks move). Keep the sideways scroll and the focus where they were.
  const before = view.table.querySelector('.mo-wrap');
  const left = before ? before.scrollLeft : 0;
  const active = document.activeElement;
  const focusId = active && view.table.contains(active) && active.dataset ? active.dataset.model : null;
  part(view.table, [stamp, keep.view, r.models.map((m) => `${m.id}${m.enabled !== false ? 1 : 0}`).join(), [...keep.draft].join()].join('|'), () => table(ctx, r));
  const wrap = view.table.querySelector('.mo-wrap');
  if (wrap && wrap !== before) {
    wrap.scrollLeft = left;
    const again = focusId ? [...wrap.querySelectorAll('input[data-model]')].find((x) => x.dataset.model === focusId) : null;
    if (again) again.focus({ preventScroll: true });
  }
  moreNote();

  const n = keep.draft.size;
  view.save.hidden = !n; // the bar sticks to the bottom of the sheet while changes wait
  part(view.save, String(n), () => (n ? [
    h('span.grow', `${fmt.plural(n, 'change')} not saved`),
    ui.btn('Discard', { small: true, onClick: () => { keep.draft.clear(); refresh(ctx); } }),
    ui.btn('Save', { tone: 'go', onClick: (e) => save(ctx, e.currentTarget) })] : null));

  part(view.leaders, [stamp, JSON.stringify(L || null).length, isObj(L) ? Object.keys(L).length : 0, r.models.map((m) => (m.enabled !== false ? 1 : 0)).join('')].join('|'), () => ui.section(['Leaders by domain', h('span.count', 'who the router ranks first')],
    isObj(L) ? leaders(ctx, r, L) : h('p.dim', 'The hub sent no leaders.'),
    h('p.dim.mo-hint', 'The ranking counts quality only. The pick for a task also weighs cost by thrift, runtime load and Phase 0 roles (Frontier officers & review gates via API keys; $0 OSS specialists on benches). ',
      'Gemini / TypeSafe decision routing turns on with your Gemini or TypeSafe key in the ', h('button.linkish', { type: 'button', onclick: () => ctx.openPanel('keys') }, 'Runtimes & Keys panel'), '.')));
}

/** Say so when score columns are off screen to the right (the scroll bar sits at the foot of a long table). */
function moreNote() {
  if (!view) return;
  const wrap = view.table.querySelector('.mo-wrap');
  view.more.hidden = !(wrap && wrap.scrollWidth > wrap.clientWidth + 2);
}

async function save(ctx, button) {
  const r = ctx.store.models.registry;
  if (!r || !keep.draft.size) return;
  const registry = { ...r, models: r.models.map((m) => (keep.draft.has(m.id) ? { ...m, enabled: keep.draft.get(m.id) } : m)) };
  await ui.busy(button, async () => {
    const res = await ctx.api.put('/api/models', { registry });
    if (!res) return;
    keep.draft.clear();
    if (isObj(res) && (res.registry || Array.isArray(res.models))) ctx.store.set('models', res);
    else { const fresh = await ctx.api.get('/api/models', { quiet: true }); ctx.store.set('models', fresh || { registry, leaders: ctx.store.models.leaders }); }
    ctx.toast('Model registry saved.');
  });
}

async function refreshBench(ctx, button) {
  await ui.busy(button, async () => {
    const res = await ctx.api.post('/api/models/refresh', {}, { timeoutMs: 120000 });
    if (!res) return;
    if (isObj(res) && res.registry) ctx.store.set('models', res);
    else { const fresh = await ctx.api.get('/api/models', { quiet: true }); if (fresh) ctx.store.set('models', fresh); }
    if (res.ok === false || res.error) ctx.toast(`The benchmarks did not refresh: ${String(res.error || 'the source did not answer')}.`, 'warn');
    else if (res.notModified || res.changed === false) ctx.toast(`The benchmarks are up to date${res.dataDate ? ` (data of ${res.dataDate})` : ''}.`);
    else ctx.toast(`Benchmarks refreshed${Number.isFinite(Number(res.updated)) ? `: ${fmt.plural(Number(res.updated), 'score')} changed` : ''}${res.dataDate ? `, data of ${res.dataDate}` : ''}.`);
  });
}

function render(container, ctx) {
  view = { empty: h('div'), source: h('div.mo-top-box'), pick: h('div'), table: h('div'), save: h('div.mo-save', { role: 'status', hidden: true }), leaders: h('div'), reg: null,
    more: h('p.mo-more', { hidden: true }, 'More score columns are to the right. Scroll the table sideways.'), onResize: () => moreNote() };
  view.reg = ui.section('Registry', view.pick, view.more, view.table, h('p.dim.mo-hint', 'Switch a model off and the router never picks it. Press Save to keep the change.'));
  container.append(view.empty, view.source, view.reg, view.leaders, view.save);
  window.addEventListener('resize', view.onResize);
  refresh(ctx);
}

export default {
  id: 'models',
  title: 'Models',
  wide: true, // the registry table needs room: a wider drawer
  render,
  update(ctx) { if (ctx.changes.has('models') || ctx.changes.has('state')) refresh(ctx); },
  dispose() { if (view) window.removeEventListener('resize', view.onResize); view = null; },
};
