// Owner questions (contract section 12b): one card per question, shared by the Inbox, the Board and the Truck panel.
// A boss asks "ASK @human ... A) ... B) ... default=A". The owner answers with one click on an option,
// or with free text. When the hub already took the default, the card stays until the owner answers:
// another option overturns the default; the default option ("Keep the default") confirms it. Both are an
// ANS re:<id> from the owner, so the hub unpins the question everywhere.
//
//   questionCard(ctx, q) -> element        q comes from ctx.sel.ownerQuestions(store, jobId)
//   syncQuestions(ctx, node, questions)    keeps node's children in step with the list (keyed, focus-safe)

import { h, keyed } from './dom.js';
import * as ui from './widgets.js';

// What the owner typed stays while a card is rebuilt or the drawer is closed.
const drafts = new Map();   // question id -> text
const openText = new Set(); // question ids whose "own answer" box is open

export function questionCard(ctx, q) {
  const { store, sel } = ctx;
  const agent = q.fromId ? store.get('agents', q.fromId) : sel.agentByRef(store, q.from, q.jobId);
  const who = agent ? agent.name : q.from || 'A boss';
  const err = h('div.field-error', { role: 'alert' });
  const buttons = [];

  /** confirms: the answer is the default the hub already took, so nothing changes for the crew. */
  async function send(body, button, confirms = false) {
    err.textContent = '';
    await ui.busy(button, async () => {
      for (const b of buttons) if (b !== button) b.disabled = true;
      const res = await ctx.api.post('/api/board', { jobId: q.jobId, kind: 'ANS', re: q.id, body });
      for (const b of buttons) if (b !== button) b.disabled = false;
      if (!res) return;
      drafts.delete(q.id); openText.delete(q.id);
      if (res.msg) store.addBoard([res.msg]);
      store.refreshInbox();
      ctx.toast(confirms ? 'The default stays in force. The question left your inbox.' : q.defaulted ? `Default overturned. ${who} gets your answer.` : `Answer sent to ${who}.`);
    });
  }

  const bodyOf = (o) => `${o.key}) ${o.text}`;
  const options = q.options.map((o) => {
    const isDefault = o.key === q.default;
    const b = h('button.q-opt', { type: 'button', class: [isDefault && 'is-default', q.defaulted && isDefault && 'is-taken'],
      title: q.defaulted && isDefault ? 'The hub took this option. Press to confirm it as your answer.' : q.defaulted ? `Overturn the default: answer ${o.key}` : `Answer ${o.key}`,
      onclick: () => send(bodyOf(o), b, q.defaulted && isDefault) },
    h('span.q-key', o.key), h('span.q-opt-text', o.text),
    isDefault ? h('span.q-flag', q.defaulted ? 'taken' : 'default') : null);
    buttons.push(b);
    return b;
  });
  // "Keep the default" is the owner's answer with the default option: the hub then unpins the question (section 12b).
  const taken = q.options.find((o) => o.key === q.default);
  const keep = q.defaulted ? ui.btn('Keep the default', { small: true, title: 'Confirm the default as your answer. The question then leaves your inbox.',
    onClick: () => send(taken ? bodyOf(taken) : `${q.default || 'Default'}) I keep the default.`, keep, true) }) : null;
  if (keep) buttons.push(keep);

  const box = h('textarea', { rows: 2, value: drafts.get(q.id) || '', placeholder: 'Your own answer', 'aria-label': `Your own answer to question ${q.id}`,
    oninput: () => { drafts.set(q.id, box.value); err.textContent = ''; } });
  const sendText = ui.btn('Send answer', { tone: 'go', small: true, onClick: () => submit() });
  buttons.push(sendText);
  function submit() {
    const body = box.value.trim();
    if (!body) { err.textContent = 'Type your answer first.'; box.focus(); return; }
    send(body, sendText);
  }
  ui.submitOnEnter(box, submit);
  const own = h('div.q-own', { hidden: q.options.length > 0 && !openText.has(q.id) }, box, h('div.row', sendText, h('span.dim', 'Enter sends. Shift+Enter makes a new line.')));
  const toggle = q.options.length ? h('button.linkish', { type: 'button', 'aria-expanded': String(!own.hidden), onclick: () => {
    own.hidden = !own.hidden;
    if (own.hidden) openText.delete(q.id); else { openText.add(q.id); box.focus(); }
    toggle.setAttribute('aria-expanded', String(!own.hidden));
  } }, 'Write your own answer') : null;

  const due = q.msg && q.msg.due && !q.defaulted ? q.msg.due : null;
  return h('div', { class: ['callout', 'you', 'q-card', q.defaulted && 'is-defaulted'], dataset: { q: q.id } },
    h('div.q-from', ui.faceEl(agent, agent && ctx.avatar(agent, 2)), h('span.strong', who), h('span.dim', agent ? `${agent.role} ${agent.handle || ''}` : ''), ui.kindTag('ASK'),
      h('span.dim', `#${q.id} · ${ui.fmt.ago(q.ts)}`),
      q.defaulted ? ui.chip(`default ${q.default || ''} taken`, 'steel') : null),
    h('p.q-text.pre', q.text),
    q.defaulted
      ? h('p.dim.q-note', 'The hub took the default and the crew went on. Choose another option to overturn it, or keep the default.')
      : due ? h('p.dim.q-note', `The crew works on what does not depend on this. The hub takes the default${q.default ? ` (${q.default})` : ''} at ${ui.fmt.time(due)}.`) : null,
    options.length ? h('div.q-opts', { role: 'group', 'aria-label': 'Answers' }, options) : null,
    h('div.row.q-foot', toggle, keep),
    own, err);
}

/** Keep `node` showing one card per question. A card is rebuilt only when the question itself changes. */
export function syncQuestions(ctx, node, questions) {
  for (const id of [...drafts.keys()]) if (!questions.some((q) => q.id === id)) { drafts.delete(id); openText.delete(id); }
  return keyed(node, questions, {
    key: (q) => q.id,
    sig: (q) => [q.id, q.defaulted, q.default, q.text, q.options.map((o) => o.key + o.text).join('\u0001'), q.msg && q.msg.due].join('|'),
    render: (q) => questionCard(ctx, q),
  });
}
