// Hub-built texts: the status table, the blueprint and task card files, desk files, session digests,
// the report fact sheet and the stall status. Built from state only.
import fs from 'node:fs';
import path from 'node:path';
import { parseOptions, renderLine } from '../shoptalk.js';
import { clip, errText, isOpenTask, oneLine } from './context.js';

export function createDigest(ctx) {
  const D = {};
  const handle = (id) => ctx.agent(id)?.handle ?? '-';

  /** Compact table: tasks (id, status, owner, title) and agents (handle, status, task). */
  D.statusTable = (job) => {
    const tasks = ctx.tasksOf(job.id).map((t) => `${t.id} ${t.status}${t.why ? `(${t.why})` : ''} ${handle(t.assigneeId)} ${oneLine(t.title, 60)}${t.deps.length ? ` after ${t.deps.join(',')}` : ''}`);
    const agents = ctx.agentsOf(job.id, (a) => !a.hidden && a.status !== 'off').map((a) => `${a.handle} ${a.role} ${a.status}${a.hold ? ' on-hold' : ''} ${a.taskId ?? '-'}`);
    return [`JOB ${job.id} ${job.status}`, 'TASKS:', ...(tasks.length ? tasks : ['none']), 'AGENTS:', ...agents].join('\n');
  };

  D.blueprintText = (job) => {
    const agentsById = Object.fromEntries(ctx.agentsOf(job.id).map((a) => [a.id, a]));
    let decisions = [];
    try { decisions = ctx.board.decisions(job.id); } catch { decisions = []; }
    return ctx.prompts.blueprint(job, ctx.tasksOf(job.id), decisions, agentsById);
  };

  D.cardText = (task) => {
    const job = ctx.job(task.jobId);
    const project = ctx.projectOf(job);
    const reqText = Object.fromEntries((job?.requirements ?? []).map((r) => [r.id, r.text]));
    const related = ctx.openTasks(task.jobId).filter((t) => t.id !== task.id && t.assigneeId)
      .slice(0, 6).map((t) => ({ id: t.id, owner: handle(t.assigneeId), title: t.title, zones: [...t.zones, ...(t.claims ?? [])] }));
    const mgr = ctx.crew.managerOf(task);
    return ctx.prompts.taskCard(task, {
      checkCmd: project?.checkCmd ?? null,
      deps: task.deps.map((id) => ({ id, title: ctx.task(id)?.title ?? '' })),
      reqText, manager: mgr?.handle, boss: ctx.lead(job)?.handle, related,
    });
  };

  D.deskFiles = (job) => {
    const files = { '.shop/BLUEPRINT.md': D.blueprintText(job) };
    for (const t of ctx.tasksOf(job.id)) {
      files[`.shop/tasks/${t.id}.md`] = `${D.cardText(t)}\nSTATUS: ${t.status}\nBENCH: ${t.benchDir ?? 'none yet'}\n`;
    }
    return files;
  };

  /** Write a fresh .shop/TASK.md into the task's bench. */
  D.writeCard = async (task) => {
    if (!task?.benchDir) return;
    try { await ctx.git.writeHubFiles(task.benchDir, { '.shop/TASK.md': D.cardText(ctx.task(task.id) ?? task) }); } catch (err) {
      ctx.say('warn', 'orchestrator: task card write failed', { task: task.id, error: errText(err) });
    }
  };

  /** Every open bench and every desk gets a fresh .shop/BLUEPRINT.md (after a merge, a decision, a plan change). */
  const again = new Set(); // jobs whose blueprint changed while a refresh ran
  D.refreshBlueprints = (jobId) => {
    if (ctx.rt.steps.has(`blueprint:${jobId}`)) { again.add(jobId); return; }
    ctx.step(`blueprint:${jobId}`, jobId, async () => {
      again.delete(jobId);
      const job = ctx.job(jobId);
      if (!job) return;
      const text = D.blueprintText(job);
      const dirs = ctx.openTasks(jobId).map((t) => t.benchDir).filter(Boolean);
      const deskRoot = path.join(ctx.paths.work, jobId, '_desk');
      try { for (const name of fs.readdirSync(deskRoot)) dirs.push(path.join(deskRoot, name)); } catch { /* no desks yet */ }
      for (const dir of dirs) {
        try { await ctx.git.writeHubFiles(dir, { '.shop/BLUEPRINT.md': text }); } catch (err) {
          ctx.say('debug', 'orchestrator: blueprint write skipped', { dir, error: errText(err) });
        }
      }
    });
    const entry = ctx.rt.steps.get(`blueprint:${jobId}`);
    entry?.promise?.then(() => { if (again.has(jobId)) D.refreshBlueprints(jobId); });
  };

  /** Rendered board lines: the agent's open items and its last 5 posts. */
  D.boardLines = (agent) => {
    const now = ctx.now();
    let open = [];
    let mine = [];
    try { open = ctx.board.openFor(agent.id).map((m) => renderLine(m, now)); } catch { open = []; }
    try { mine = ctx.board.history({ jobId: agent.jobId, limit: 500 }).filter((m) => m.fromId === agent.id).slice(-5).map((m) => renderLine(m, now)); } catch { mine = []; }
    return { open, mine };
  };

  /** The context of a session digest (rotation): see prompts.digestPrompt. */
  D.digestCtx = async (agent, task = null) => {
    const job = ctx.job(agent.jobId);
    const { open, mine } = D.boardLines(agent);
    const out = { blueprint: '.shop/BLUEPRINT.md', status: D.statusTable(job), openItems: open, lastPosts: mine };
    if (task) {
      out.task = task;
      const d = ctx.currentDelivery(task);
      if (d?.review?.verdict === 'changes') out.fixItems = d.review.mustFix ?? [];
      else if (task.lastError && task.status === 'rework') out.fixItems = [task.lastError];
      out.checkLog = task.rejectCause === 'check';
      if (task.benchDir) {
        try {
          const st = await ctx.git.diffStat(task.benchDir);
          out.diffStat = st.files.slice(0, 30).map((f) => `${f.path} +${f.add} -${f.del}`).join('\n') || 'no changes yet';
        } catch { out.diffStat = null; }
      }
    }
    return out;
  };

  /** Facts for the report prompt. */
  D.facts = (job) => {
    let decisions = [];
    try { decisions = ctx.board.decisions(job.id); } catch { decisions = []; }
    return {
      tasks: ctx.tasksOf(job.id).map((t) => ({ id: t.id, title: t.title, status: t.status, cardChanges: t.cardChanges })),
      decisions: decisions.map((d) => ({ id: d.id, scope: d.scope, body: d.body })),
      questions: D.openQuestions(job),
    };
  };

  /** Owner questions that are still open: { id, text, default } (default: the option key and its text, or null). */
  D.openQuestions = (job) => ctx.openItems(job.id, { kind: 'ASK', to: '@human' })
    .filter((m) => m.kind === 'ASK' && m.to === '@human' && m.state === 'open')
    .sort((a, b) => a.id - b.id)
    .map((m) => {
      const parsed = parseOptions(m.body);
      const key = m.slots?.default ?? null;
      const option = key ? parsed.options.find((o) => o.key === key) : null;
      return { id: m.id, text: oneLine(parsed.text || m.body, 200), default: key ? `${key}${option ? `) ${oneLine(option.text, 80)}` : ''}` : null };
    });

  /** The report lines for open owner questions (the hub takes each default when the truck ships). */
  D.questionLines = (questions) => questions.map((q) => `- Question ${q.id}: ${q.text} ${q.default ? `Default: ${q.default}. The hub takes it when the truck ships.` : 'No default: it closes unanswered when the truck ships.'}`);

  /** The hub's own report when no boss wrote one (turn-failure table, row Report). */
  D.factReport = (job) => {
    const f = D.facts(job);
    const lines = [`# Report for ${job.id}: ${job.title}`, '', 'The bosses wrote no report. These are the facts the hub has.', '', '## Requirements'];
    for (const r of job.requirements) lines.push(`- ${r.id} [${r.status}] ${r.text}${r.status === 'waived' ? ` (waived: ${r.waivedReason})` : r.evidence ? ` (${r.evidence})` : ''}`);
    lines.push('', '## Tasks', ...f.tasks.map((t) => `- ${t.id} [${t.status}] ${t.title}`));
    if ((job.assumptions ?? []).length) lines.push('', '## Assumptions', ...job.assumptions.map((a) => `- ${a.text}`));
    if (f.decisions.length) lines.push('', '## Decisions', ...f.decisions.map((d) => `- ${d.id} ${d.scope}: ${d.body}`));
    if (f.questions.length) lines.push('', '## Open owner questions', ...D.questionLines(f.questions));
    return lines.join('\n');
  };

  /** Status table plus what waits on what, for the stall digest. */
  D.stallStatus = (job) => {
    const waits = [];
    for (const t of ctx.openTasks(job.id)) {
      if (t.status === 'planned') {
        const open = t.deps.filter((d) => ctx.task(d)?.status !== 'merged');
        if (open.length) waits.push(`${t.id} waits for ${open.join(', ')}.`);
      } else if (t.status === 'blocked' || t.status === 'failed') {
        waits.push(`${t.id} is ${t.status}${t.why ? ` (${t.why})` : ''}${t.lastError ? `: ${oneLine(t.lastError, 120)}` : ''}.`);
      }
    }
    for (const r of job.requirements) {
      if (r.status === 'waived') continue;
      const served = ctx.tasksOf(job.id, (t) => (isOpenTask(t) || t.status === 'merged') && t.reqs.includes(r.id)).length;
      if (!served) waits.push(`${r.id} has no task.`);
      else if (r.status === 'failed') waits.push(`${r.id} failed QA: ${oneLine(r.evidence, 100)}`);
    }
    return clip(`${D.statusTable(job)}\nWAITS:\n${waits.join('\n') || 'nothing named'}`, 3500);
  };

  return D;
}
