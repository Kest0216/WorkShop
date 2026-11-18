// Inbox panel (contract sections 12b and 13b): everything that waits for the owner in one list, each with its action.
//   question     answer with one option button, or with your own words; overturn or keep a default the hub took   POST /api/board (ANS)
//   truck        open the Truck panel of that job (also a cancelled job whose reviewed crates were left on the truck)
//   plan         approve the plan                                                                                 POST /api/jobs/:id/plan/approve
//   signin       open the lab in the Keys panel
//   budget       raise the budget and resume                                                                      POST /api/jobs/:id/resume { budgetUsd }
//   paused       resume, or cancel the job                                                                        POST /api/jobs/:id/resume | cancel
//   review       a hand-in waits for the owner's verdict: PASS or FIX                                             POST /api/board (PASS | FIX, re: the DONE post)
//   requirement  a requirement that no task serves (failed in QA, or open with no task): add a task, waive it,    POST changes | reqs/:rid/waive | cancel
//                or stop the job
//   agentfiles   accept or refuse the agent-config files of an adopted repo                                       POST /api/projects/:id/agentfiles { ack }
// The list is sel.inboxItems(store): the inbox of the hub, checked against the live state. What waits comes first, newest first.
// Items that do not ring (a default the hub took, a job you paused, a lab that no work waits for) follow, a little quieter.

import { h, mount, keyed } from '../lib/dom.js';
import * as ui from '../lib/widgets.js';
import { questionCard } from '../lib/questions.js';
import { diffSlot, diffView } from '../lib/diff.js';
import { confirmCancel, runCancel } from '../lib/jobs.js';

const fmt = ui.fmt;
const enc = encodeURIComponent;
const KIND_TAG = { truck: ['truck', 'amber'], plan: ['plan', 'amber'], signin: ['runtime', 'brick'], requisition: ['rft queue', 'amber'], budget: ['budget', 'red'], paused: ['paused', 'red'], review: ['verdict', 'amber'], requirement: ['requirement', 'red'], agentfiles: ['repo', 'amber'] };
let view = null;
// "Add task" on a requirement makes a NEW owner requirement (the hub never reopens the old one). For a failed requirement
// the call names it (reqId), and the hub drops its item until QA checks it again. An open requirement with no task can
// stay listed a while. Remember what the owner asked for, per job and requirement, so a card that is still up names the
// new requirement instead of asking for the same task again. (Per window: after a reload the card asks again, which is safe.)
const asked = new Map();

const jobUrl = (it) => `/api/jobs/${enc(it.jobId)}`;
/** Run one owner action on a button; the inbox is fetched again when it worked. */
function act(ctx, button, fn) {
  return ui.busy(button, async () => { const res = await fn(); if (res) ctx.store.refreshInbox(); return res; });
}

/** The frame of every card that is not a question: tag, job, title, age; then the body and the buttons. */
function frame(it, title, body, actions) {
  const [word, tone] = KIND_TAG[it.kind] || [String(it.kind || 'note'), 'plain'];
  return h('article', { class: ['callout', 'ib-card', it.quiet ? 'ib-quiet' : 'you'], dataset: { key: it.key } },
    h('div.callout-title', ui.chip(word, it.quiet ? 'steel' : tone), it.jobId ? ui.chip(String(it.jobId), 'dark') : null, h('span.grow.ib-title', title),
      it.since ? h('span.dim.ib-since', { title: fmt.date(it.since) }, fmt.ago(it.since)) : null),
    body,
    actions && actions.some(Boolean) ? h('div.row.ib-acts', actions) : null);
}

async function cancelJob(ctx, it, button) {
  const job = it.job || { id: it.jobId };
  if (await confirmCancel(ctx, job)) runCancel(ctx, job, button);
}

// ------------------------------------------------------------------ one card per kind

function planCard(ctx, it) {
  return frame(it, 'The plan waits for you',
    h('p', 'The bosses handed in the plan. Read the requirements and the tasks in the Blueprint. The makers start when you approve.'),
    [ui.btn('Approve plan', { tone: 'go', onClick: (e) => act(ctx, e.currentTarget, async () => { const res = await ctx.api.post(`${jobUrl(it)}/plan/approve`); if (res) ctx.toast('Plan approved. The makers start.'); return res; }) }),
      ui.btn('Read the Blueprint', { onClick: () => ctx.openPanel('blueprint') })]);
}

function truckCard(ctx, it) {
  const cancelled = it.job && it.job.status === 'cancelled';
  // Every job has its own truck. The button names the job, so the truck of a cancelled job opens also while a newer job runs.
  return frame(it, cancelled ? 'Reviewed crates were left on the truck' : 'The truck waits for you',
    [h('p', it.text), cancelled ? h('p.dim', `The Truck panel of ${it.jobId} has two buttons: Ship loaded crates, and Discard.`) : null],
    [ui.btn(it.jobId ? `Open the truck of ${it.jobId}` : 'Open Truck', { tone: 'primary', onClick: () => ctx.openPanel('truck', it.jobId ? { job: it.jobId } : {}) })]);
}

function signinCard(ctx, it) {
  const lab = it.lab;
  const name = lab ? String(lab.label || lab.id) : String(it.id);
  return frame(it, `${name} is not ready`,
    [h('p', String((lab && lab.reason) || it.text || 'This lab is not usable.')),
      h('p.dim', it.quiet ? 'No work waits for this lab right now.' : 'Work of the job waits for this lab.')],
    [ui.btn('Open Runtimes', { tone: it.quiet ? undefined : 'primary', onClick: () => ctx.openPanel('settings', { tab: 'runtimes', lab: lab ? lab.id : it.id }) })]);
}

function budgetCard(ctx, it) {
  const job = it.job;
  const billed = Number(job && job.cost && job.cost.billedUsd) || 0;
  const input = h('input', { type: 'text', inputMode: 'decimal', autocomplete: 'off', value: String(Math.ceil(billed + 10)) });
  const f = ui.field(`New budget in USD (above ${fmt.money(billed)})`, input);
  f.classList.add('ib-money');
  const go = ui.btn('Raise the budget and resume', { type: 'submit', tone: 'go' });
  const submit = () => {
    const n = Number(input.value.trim().replace(/^\$/, ''));
    if (!(n > billed)) { f.setError(`Use a number above ${fmt.money(billed)}.`); input.focus(); return; }
    f.setError('');
    act(ctx, go, async () => { const res = await ctx.api.post(`${jobUrl(it)}/resume`, { budgetUsd: n }); if (res) ctx.toast(`${it.jobId} goes on with a budget of ${fmt.money(n)}.`); return res; });
  };
  input.addEventListener('input', () => f.setError(''));
  return frame(it, 'The budget is reached',
    [h('p.pre', it.text || 'The bill reached the budget of the work order.'),
      h('p.dim', `Billed on API keys so far: ${fmt.money(billed)}${job && job.budgetUsd != null ? ` of ${fmt.money(job.budgetUsd)}` : ''}. The crew goes on when the budget is higher.`),
      h('form.ib-form', { novalidate: true, onsubmit: (e) => { e.preventDefault(); submit(); } }, f, h('div.row', go, ui.btn('Cancel the job', { onClick: (e) => cancelJob(ctx, it, e.currentTarget) })))]);
}

function pausedCard(ctx, it) {
  const job = it.job;
  const mine = it.quiet;
  return frame(it, mine ? 'You paused the job' : `The hub paused the job: ${ctx.sel.pauseWords(job)}`,
    [h('p.pre', mine ? 'No new turn starts. Resume it when you want the crew to go on.' : it.text),
      mine ? null : h('p.dim', 'The hub never ends a job by itself. Resume it when the cause is gone, or cancel the job.')],
    [ui.btn('Resume', { tone: 'go', onClick: (e) => act(ctx, e.currentTarget, async () => { const res = await ctx.api.post(`${jobUrl(it)}/resume`, {}); if (res) ctx.toast(`${it.jobId} goes on.`); return res; }) }),
      ui.btn('Cancel the job', { onClick: (e) => cancelJob(ctx, it, e.currentTarget) }),
      h('button.linkish', { type: 'button', onclick: () => ctx.openPanel('blueprint') }, 'Open the Blueprint')]);
}

function reviewCard(ctx, it) {
  const { store } = ctx;
  const d = it.delivery;
  const task = d ? store.get('tasks', d.taskId) : null;
  const maker = d ? store.get('agents', d.makerId) : null;
  const doneId = it.doneId;
  const acc = d && d.acc && Number.isFinite(Number(d.acc.total)) ? d.acc : null;
  const short = !!acc && Number(acc.met) < Number(acc.total);
  const stat = (d && d.stat) || null;
  const send = (kind, body, button, words) => act(ctx, button, async () => {
    const res = await ctx.api.post('/api/board', { jobId: it.jobId, kind, re: doneId, body });
    if (!res) return res;
    if (res.msg) store.addBoard([res.msg]);
    ctx.toast(words);
    return res;
  });
  const fix = (button) => {
    const box = h('textarea', { rows: 5, placeholder: '1. The list must also show the cooking time (public/list.js).\n2. Add a test for an empty list.' });
    const f = ui.field('What must change? Number the items: 1. ... 2. ...', box, { hint: 'At most 5 items. Name a file, a line or a task where you can. The maker reworks the task.' });
    ctx.modal({
      title: `Send ${d ? d.taskId : 'the hand-in'} back`, body: f,
      buttons: [{ label: 'Cancel', value: false }, { label: 'Send FIX', primary: true, tone: 'danger', run: async () => {
        const text = box.value.trim();
        if (!text) { f.setError('Write what must change.'); box.focus(); return false; }
        const res = await send('FIX', text, button, `${d ? d.taskId : 'The hand-in'} goes back to ${maker ? maker.name : 'the maker'} with your changes.`);
        return !!res;
      } }],
    });
  };
  const title = d ? [h('span.strong', String(d.taskId)), ' ', String((task && task.title) || 'A hand-in'), ' waits for your verdict'] : 'A hand-in waits for your verdict';
  return frame(it, title,
    [d ? h('div.ib-facts',
      maker ? h('span.ib-who', ui.faceEl(maker, ctx.avatar(maker, 2)), h('span.strong', maker.name), ui.labChip(maker.provider, maker.modelLabel || maker.model || maker.provider)) : null,
      Number(d.attempt) > 1 ? ui.chip(`try ${d.attempt}`, 'brick', { title: 'Earlier hand-ins of this task were sent back.' }) : null,
      acc ? ui.chip(`acc ${acc.met}/${acc.total}`, short ? 'amber' : 'green', { title: 'Acceptance items the maker says are met' }) : null,
      h('span', `tests ${d.tests || 'none'}`),
      d.check ? ui.chip(d.check.ok ? 'check ok' : 'check failed', d.check.ok ? 'green' : 'red', { title: d.check.cmd ? `Check: ${d.check.cmd}` : null }) : ui.chip('not checked', 'red', { title: 'The project has no check command, so nothing ran on this work.' }),
      stat ? h('span', fmt.plural(Number(stat.files) || 0, 'file'), ' ', ui.stat(Number(stat.add) || 0, Number(stat.del) || 0)) : null) : null,
    h('p', d && d.summary ? String(d.summary) : it.text),
    h('p.dim', 'The reviewers of the crew are used up, so the verdict is yours. PASS merges the work and loads it on the truck. FIX sends it back to the maker.'),
    short ? h('p.ib-warn', `The maker says that ${acc.met} of ${acc.total} acceptance items are met. The hub refuses a PASS until all are met: say FIX, or let a boss change the task card first.`) : null,
    d ? ui.fold('Diff of this hand-in', () => diffSlot(ctx.api, `${jobUrl(it)}/diff?delivery=${enc(d.id)}`, (text) => diffView(text))) : null],
    doneId != null ? [
      ui.btn('Pass', { tone: 'go', title: 'PASS: you accept the work (merges onto truck)', onClick: (e) => send('PASS', '', e.currentTarget, `You passed ${d ? d.taskId : 'the hand-in'}. The hub merges it and loads the truck.`) }),
      ui.btn('Fix (-1)...', { tone: 'danger', title: 'FIX: deny & send back (-1 agent rating). Say what must change.', onClick: (e) => fix(e.currentTarget) }),
      h('button.linkish', { type: 'button', title: `Show post #${doneId} on the board`, onclick: () => ctx.openPanel('board', { view: 'all', re: doneId }) }, 'Show in feed'),
    ] : [ui.btn('Show feed', { onClick: () => ctx.openPanel('board', { view: 'feed' }) })]);
}

/**
 * A requirement that no task serves. Two cases (the hub lists both):
 *   failed  QA failed it and the lead boss added no task
 *   open    nobody works on it: the lead boss made no task for an owner change or for an item of the ledger audit
 */
function requirementCard(ctx, it) {
  const req = it.req;
  const id = req ? req.id : String(it.id);
  const failed = !!req && req.status === 'failed';
  const words = String((req && req.text) || it.text || '');
  const key = `${it.jobId}/${id}`;
  const sent = asked.get(key);
  return frame(it, failed ? `${id} failed and no task serves it` : `${id} has no task`,
    [h('p', h('span.strong', id), ' ', words),
      req && req.evidence ? h('p.dim', 'QA found: ', String(req.evidence)) : null,
      sent ? h('p.strong', `You asked for a task${sent === true ? '' : ` (requirement ${sent})`}. The lead boss plans it. QA checks ${id} again when the work is merged.`)
        : h('p.dim', failed ? 'The job cannot end while a requirement is failed. Add a task for it, waive it, or stop the job.'
          : 'The lead boss made no task for it, so nobody works on it. The job cannot end while a requirement is open. Add a task for it, waive it, or stop the job.')],
    [ui.btn(sent ? 'Add another task' : 'Add task', { tone: sent ? null : 'primary', title: 'Tell the lead boss to plan a task for this requirement', onClick: async (e) => {
      const button = e.currentTarget;
      const start = failed ? `${id} failed: ${words}${req.evidence ? ` (${req.evidence})` : ''} Add a task that makes it pass.` : `${id} has no task: ${words} Add a task for ${id}.`;
      const text = await ctx.prompt({ title: `Add a task for ${id}`, label: 'What must the task do? The lead boss turns your words into a task.', multiline: true, okLabel: 'Send to the lead boss',
        value: start.replace(/\s+/g, ' ') });
      // The hub makes a new owner requirement from these words (it never reopens the old one) and wakes the lead boss.
      // For a failed requirement the call names it (reqId): the new requirement serves it, and the hub drops this item
      // until QA checks the requirement again.
      if (text) act(ctx, button, async () => {
        const res = await ctx.api.post(`${jobUrl(it)}/changes`, failed ? { text, reqId: id } : { text });
        if (res) {
          asked.set(key, res.req && res.req.id ? String(res.req.id) : true);
          ctx.toast(`The lead boss has it${res.req && res.req.id ? ` as the new requirement ${res.req.id}` : ''} and plans a task. QA checks every requirement again.`);
          refresh(ctx);
        }
        return res;
      });
    } }),
    ui.btn('Waive', { title: `Waive ${id}: the job can end without it`, onClick: async (e) => {
      const button = e.currentTarget;
      const reason = await ctx.prompt({ title: `Waive ${id}?`, label: 'Why is this requirement not needed?', multiline: true, okLabel: 'Waive' });
      if (reason) act(ctx, button, async () => { const res = await ctx.api.post(`${jobUrl(it)}/reqs/${enc(id)}/waive`, { reason }); if (res) ctx.toast(`${id} is waived.`); return res; });
    } }),
    ui.btn('Stop job', { title: 'Cancel the job', onClick: (e) => cancelJob(ctx, it, e.currentTarget) })]);
}

function agentFilesCard(ctx, it) {
  const p = it.project;
  const pid = p ? p.id : String(it.id);
  const files = p && Array.isArray(p.agentFiles) ? p.agentFiles : [];
  const answer = (ack, button) => act(ctx, button, async () => {
    const res = await ctx.api.post(`/api/projects/${enc(pid)}/agentfiles`, { ack });
    if (res) ctx.toast(ack ? 'Accepted. Gemini workers may work in this repo.' : 'Refused. The Gemini lab stays off for this project.');
    return res;
  });
  return frame(it, `${p ? p.name : 'The repo'} holds agent-config files`,
    [h('p', files.length ? ['This repo brings its own files for coding agents: ', files.map((f, i) => [i ? ', ' : '', h('span.code', String(f))]), '.'] : it.text),
      h('p.dim', 'Gemini workers load these files when they work in this repo, so the files can steer them. Accept only files you trust. Without your yes the Gemini lab is off for this project.')],
    [ui.btn('Accept the files', { tone: 'go', onClick: (e) => answer(true, e.currentTarget) }),
      ui.btn('Refuse', { title: 'Keep the Gemini lab off for this project', onClick: (e) => answer(false, e.currentTarget) })]);
}

function requisitionCard(ctx, it) {
  const reqn = it.reqn;
  const domain = (reqn && reqn.domain) || it.domain || 'general';
  const baseModel = (reqn && (reqn.candidateBaseModel || reqn.recommendedBaseModel)) || '';
  const harnessId = (reqn && (reqn.harnessId || reqn.recommendedHarnessId)) || '';
  const name = (reqn && (reqn.suggestedName || reqn.suggestedCharacterName)) || '';
  return frame(it, `RL Agent Forge needed: ${domain}`,
    [h('p', String((reqn && reqn.notes) || (reqn && reqn.taskTitle) || it.text || 'No certified specialist exists in the Employee Handbook for this domain yet.')),
      h('div.ib-facts',
        ui.domainChip(domain),
        name ? ui.chip(name, 'blue') : null,
        baseModel ? ui.chip(baseModel, 'plain') : null,
        harnessId ? ui.chip('harness: ' + harnessId, 'green') : null),
      h('p.dim', 'Every Handbook specialist must pass RL training + Verification QA before staffing real work. Open the Agent Forge to train & verify this agent.')],
    [ui.btn('Open Agent Forge', { tone: 'primary', onClick: () => ctx.openPanel('crew', { tab: 'forge' }) }),
      ui.btn('Dismiss', { onClick: (e) => act(ctx, e.currentTarget, async () => { const res = await ctx.api.post(`/api/requisitions/${enc(it.id)}/dismiss`); if (res) ctx.toast(`${it.id} dismissed.`); return res; }) })]);
}

function otherCard(ctx, it) {
  return frame(it, 'For you', h('p.pre', it.text || 'The hub sent an item that this window does not know.'), [ui.btn('Open Board', { onClick: () => ctx.openPanel('board') })]);
}

const CARDS = { plan: planCard, truck: truckCard, signin: signinCard, requisition: requisitionCard, budget: budgetCard, paused: pausedCard, review: reviewCard, requirement: requirementCard, agentfiles: agentFilesCard };

function card(ctx, it) {
  if (it.kind === 'question' && it.q) { const node = questionCard(ctx, it.q); node.classList.add('ib-card'); return node; }
  return (CARDS[it.kind] || otherCard)(ctx, it);
}

/** A card is rebuilt only when what it shows changes, so a box the owner types in keeps its text and its focus. */
function cardSig(ctx, it) {
  const { store } = ctx;
  const job = it.job || {};
  const base = [it.kind, it.id, it.quiet, it.text];
  if (it.kind === 'question' && it.q) { const q = it.q; return JSON.stringify([...base, q.defaulted, q.default, q.text, q.options, q.msg && q.msg.due]); }
  if (it.kind === 'budget' || it.kind === 'paused') return JSON.stringify([...base, job.pauseReason, job.error, job.cost && job.cost.billedUsd, job.budgetUsd]);
  if (it.kind === 'truck') return JSON.stringify([...base, job.status]);
  if (it.kind === 'signin') return JSON.stringify([...base, it.lab && [it.lab.label, it.lab.reason]]);
  if (it.kind === 'requisition') return JSON.stringify([...base, it.reqn && [it.reqn.status, it.reqn.domain, it.reqn.recommendedBaseModel, it.reqn.recommendedHarnessId]]);
  if (it.kind === 'review') { const d = it.delivery; const m = d ? store.get('agents', d.makerId) : null; return JSON.stringify([...base, it.doneId, d && [d.id, d.status, d.attempt, d.summary, d.acc, d.tests, d.stat, d.check && d.check.ok], m && [m.name, !!ctx.avatar(m, 2)]]); }
  if (it.kind === 'requirement') return JSON.stringify([...base, it.req && [it.req.text, it.req.status, it.req.evidence], asked.get(`${it.jobId}/${it.req ? it.req.id : it.id}`) || null]);
  if (it.kind === 'agentfiles') return JSON.stringify([...base, it.project && [it.project.name, it.project.agentFiles, it.project.agentFilesAck]]);
  return JSON.stringify(base);
}

// ------------------------------------------------------------------ panel

function refresh(ctx) {
  if (!view) return;
  const { store, sel } = ctx;
  const att = sel.ownerAttention(store);
  const items = att.items.slice().sort((a, b) => Number(a.quiet) - Number(b.quiet) || b.since - a.since); // what waits first, each part newest first
  const loud = att.loud.length, quiet = items.length - loud;
  const away = store.settings && store.settings.presence === 'away';
  const headSig = [loud, quiet, away].join('|');
  if (view.headSig !== headSig) {
    view.headSig = headSig;
    mount(view.head,
      h('div.ib-sum', h('span.strong', loud ? `${fmt.plural(loud, 'thing waits', 'things wait')} for you` : 'Nothing waits for you'),
        quiet ? h('span.dim', ` · ${quiet} for later`) : null),
      away ? h('p.ib-away', 'You are away: the hub takes the default answer of every boss question at once. A default that was taken stays here until you answer.') : null);
  }
  const emptySig = items.length ? 'some' : 'none';
  if (view.emptySig !== emptySig) {
    view.emptySig = emptySig;
    mount(view.empty, items.length ? null : ui.emptyState('The inbox is empty', 'When a boss asks you something, a plan needs your approval, the truck is ready or a job is paused, it shows up here with its button.'));
  }
  keyed(view.list, items, { key: (it) => it.key, sig: (it) => cardSig(ctx, it), render: (it) => card(ctx, it) });
}

function render(container, ctx) {
  view = { head: h('div.ib-head'), empty: h('div'), list: h('div.ib-list'), headSig: null, emptySig: null };
  container.append(view.head, view.empty, view.list);
  refresh(ctx);
}

export function renderInboxItem(ctx, it) { return card(ctx, it); }
export function inboxItemSig(ctx, it) { return cardSig(ctx, it); }

export default {
  id: 'inbox',
  title: 'Inbox',
  badge: ({ store, sel }) => sel.ownerAttention(store).count,
  attention: ({ store, sel }) => sel.ownerAttention(store).any,
  render,
  update(ctx) {
    const c = ctx.changes;
    if (c.has('inbox') || c.has('board') || c.has('jobs') || c.has('deliveries') || c.has('tasks') || c.has('agents') || c.has('providers') || c.has('projects') || c.has('settings') || c.has('requisitions') || c.has('state')) refresh(ctx);
  },
  dispose() { view = null; },
};
