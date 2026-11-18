// Board events -> orchestrator state (sections 7 and 12): DONE, BLOCK, FAIL, verdicts, consults, decisions,
// owner defaults and overturns, closures, escalations, and the wake rule. Wakes are persisted on the agent
// (agent.wake) so that the tick, not this handler, starts the turn: a restart loses no wake.
import { NO_HELP_LINE } from '../prompts.js';
import { renderLine } from '../shoptalk.js';
import { clip, errText, oneLine } from './context.js';

const WAKE_KINDS = new Set(['ASK', 'ANS', 'REQ', 'BLOCK', 'FIX', 'CANCEL']);
const BUBBLE = { ASK: 'ask', BLOCK: 'ask', DONE: 'done', PASS: 'done', FIX: 'warn', FAIL: 'warn', NO: 'warn' };

export function createWakes(ctx) {
  const W = {};
  /** Mark that an agent needs a turn. opts: { line, key, owner }. Idempotent per key. */
  W.add = (agentId, { line = '', key = null, owner = false } = {}) => {
    const a = ctx.agent(agentId);
    if (!a || a.hidden || (a.role === 'maker' && !a.taskId)) return; // an unbound maker has no session to wake
    const w = a.wake ?? { since: ctx.now(), lines: [], keys: [], owner: false };
    if (key && w.keys.includes(key)) return;
    ctx.patch('agents', agentId, {
      wake: {
        ...w, at: ctx.now(), owner: w.owner || owner,
        lines: line ? [...w.lines, clip(line, 400)].slice(-8) : w.lines, keys: key ? [...w.keys, key].slice(-30) : w.keys,
      },
    });
    ctx.kick();
  };
  return W;
}

export function createEvents(ctx) {
  const V = {};
  const line = (m) => renderLine(m, ctx.now());

  function bubble(m) {
    if (!m.fromId) return;
    ctx.patch('agents', m.fromId, { bubble: { text: oneLine(m.body || m.kind, 120), kind: BUBBLE[m.kind] ?? 'info', seq: m.id } });
  }

  function onPost(m) {
    bubble(m);
    let wake = WAKE_KINDS.has(m.kind) || (m.kind === 'EVT' && Boolean(m.toId));
    switch (m.kind) {
      case 'DONE': ctx.tasksApi.onDone(m); break;
      case 'BLOCK': if (ctx.tasksApi.onBlock(m).consult) wake = false; break;
      case 'FAIL': ctx.tasksApi.onFail(m); break;
      case 'PASS':
      case 'FIX': {
        const target = m.re ? ctx.board.get(m.re) : null;
        if (target?.kind === 'DONE') {
          if (m.kind === 'FIX' && m.role === 'human') {
            const d = ctx.deliveriesOf(m.jobId, (x) => x.doneMsgId === target.id)[0] ?? null;
            const t = d ? ctx.task(d.taskId) : null;
            const maker = (d?.makerId ? ctx.agent(d.makerId) : null) || (target.fromId ? ctx.agent(target.fromId) : null);
            const rosterId = d?.rosterId || t?.rosterId || maker?.rosterId || null;
            if (rosterId) {
              ctx.roster?.recordRating?.(rosterId, {
                delta: -1,
                outcome: 'denied',
                jobId: m.jobId,
                taskId: d?.taskId ?? null,
                deliveryId: d?.id ?? null,
                note: String(m.body || 'Denied by owner in review'),
              });
            }
          }
          ctx.review.onVerdict(m);
          if (m.role !== 'hub') wake = false; // the verdict wakes the maker when it takes effect
        }
        break;
      }
      case 'ASK':
        if (m.toAlias === '@other' && !m.toId && m.fromId) {
          ctx.consult.onAsk(m);
          wake = false;
        }
        break;
      case 'ANS':
        if (m.role === 'human') overturn(m);
        break;
      case 'DECIDE': ctx.digest.refreshBlueprints(m.jobId); break;
      default: break;
    }
    if (wake && m.toId && m.toId !== m.fromId) ctx.wakes.add(m.toId, { line: m.kind === 'EVT' ? line(m) : '', key: `m${m.id}`, owner: m.role === 'human' });
    ctx.kick();
  }

  /** The owner answers an ASK @human after the hub took the default: the same option confirms, another replaces it. */
  function overturn(m) {
    const ask = m.re ? ctx.board.get(m.re) : null;
    if (!ask || ask.kind !== 'ASK' || ask.to !== '@human') return;
    const job = ctx.job(m.jobId);
    if (!job) return;
    const had = (job.assumptions ?? []).some((a) => a.msgId === ask.id);
    if (!had) return; // a plain owner answer before any default
    const assumptions = job.assumptions.map((a) => (a.msgId === ask.id
      ? (m.overturn ? { text: `${oneLine(ask.body, 160)} Owner: ${oneLine(m.body, 200)}`, msgId: ask.id, owner: true } : { ...a, confirmed: true })
      : a));
    ctx.patch('jobs', job.id, { assumptions });
    if (m.overturn) {
      const lead = ctx.lead(job);
      if (lead && lead.id !== ask.fromId) ctx.wakes.add(lead.id, { line: `The owner overturned the default of ${ask.id}: ${oneLine(m.body, 200)} Decide if rework is needed (task_add).`, key: `over:${m.id}`, owner: true });
      if (ask.fromId) ctx.wakes.add(ask.fromId, { line: `The owner overturned the default of ${ask.id}: ${oneLine(m.body, 200)}`, key: `over:${m.id}:a`, owner: true });
    }
  }

  function onClose(e) {
    const m = e.msg;
    if (m.kind === 'BLOCK') ctx.tasksApi.onBlockClosed(m);
    if (m.kind === 'DONE') return; // verdicts and refusals wake the maker themselves
    if (!e.wake || !m.fromId) return;
    const closing = e.by ? line(e.by) : `${m.kind} ${m.id} is closed as ${m.state}.`;
    const help = (e.by?.kind === 'NO' || (m.kind === 'BLOCK' && m.state === 'expired')) ? ` ${NO_HELP_LINE}` : '';
    ctx.wakes.add(m.fromId, { line: `${closing}${help}`, key: `c${m.id}`, owner: e.by?.role === 'human' });
  }

  function onExpire(e) {
    if (e.msg.kind === 'DONE') ctx.review.onReviewExpired(e.next ?? e.msg);
    // the hub EVT that moved the item is addressed: its post event woke the new addressee
  }

  function onDefault(e) {
    const job = ctx.job(e.msg.jobId);
    if (!job) return;
    if ((job.assumptions ?? []).some((a) => a.msgId === e.msg.id)) return;
    const text = `${oneLine(e.msg.body, 200).replace(/\s*[A-D]\).*$/, '')} Default ${e.option}: ${oneLine(e.text, 160)}`;
    ctx.patch('jobs', job.id, { assumptions: [...(job.assumptions ?? []), { text, msgId: e.msg.id }] });
  }

  V.handle = (e) => {
    try {
      if (e.type === 'post') onPost(e.msg);
      else if (e.type === 'close') onClose(e);
      else if (e.type === 'expire') onExpire(e);
      else if (e.type === 'default') onDefault(e);
    } catch (err) {
      ctx.say('error', 'orchestrator: board event failed', { type: e?.type, error: errText(err) });
    }
  };
  return V;
}
