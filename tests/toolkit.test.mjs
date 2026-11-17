// Toolkit (contract section 12c): starter tools, storage, validation, command / order / ask runs.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.js';
import { createRedactor } from '../server/redact.js';
import { createGit } from '../server/gitops.js';
import { paths as makePaths } from '../server/config.js';
import { createToolkit, starterTools, normalizeTool } from '../server/toolkit.js';

let tmp, store, events, unsub;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ws-toolkit-')));
  store = createStore({ dataDir: path.join(tmp, 'data'), saveDelayMs: 5 });
  events = [];
  unsub = store.subscribe((e) => { if (e.type === 'toolrun') events.push(e); });
  await fs.mkdir(path.join(tmp, 'proj'), { recursive: true });
  store.put('projects', { id: 'P1', name: 'proj', path: path.join(tmp, 'proj'), targetBranch: 'main', checkCmd: 'npm test', agentFilesAck: false });
});
afterEach(async () => {
  unsub();
  await store.flush();
  await fs.rm(tmp, { recursive: true, force: true });
});

function fakeGit(result = { ok: true, code: 0, tail: 'all good\n' }) {
  const calls = [];
  return { calls, runCheck: async (dir, cmd, opts) => { calls.push({ dir, cmd, opts }); return typeof result === 'function' ? result(cmd) : result; } };
}

describe('toolkit storage', () => {
  test('a new project gets the four starter tools, stored 0600 under data/toolkit', async () => {
    const tk = createToolkit({ store, dataDir: path.join(tmp, 'data') });
    const tools = await tk.list('P1');
    assert.deepEqual(tools.map((t) => t.name), ['Run checks', 'Open folder', 'Status report', 'What is blocked?']);
    const check = tools.find((t) => t.id === 'check');
    assert.equal(check.command, 'npm test', 'the check tool shows the project check command');
    assert.equal(check.confirm, true);
    const file = path.join(tmp, 'data', 'toolkit', 'P1.json');
    const st = await fs.stat(file);
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(raw.tools.find((t) => t.id === 'check').command, '', 'the stored check tool follows the project, not a copy');
  });

  test('save validates, keeps order and survives a new instance', async () => {
    const tk = createToolkit({ store, dataDir: path.join(tmp, 'data') });
    const saved = await tk.save('P1', [
      ...starterTools(),
      { name: 'Build', icon: 'hammer', kind: 'command', command: 'npm run build', confirm: true },
      { id: 'again', name: 'Again', kind: 'order', order: { title: 'Fix lint', brief: 'Fix every lint error.', kind: 'fix', crew: 'solo' } },
    ]);
    assert.equal(saved.length, 6);
    assert.match(saved[4].id, /^t[0-9a-f]{6}$/);
    const again = await createToolkit({ store, dataDir: path.join(tmp, 'data') }).list('P1');
    assert.deepEqual(again.map((t) => t.id), saved.map((t) => t.id));
  });

  test('bad input is refused with a plain 400 message', async () => {
    const tk = createToolkit({ store, dataDir: path.join(tmp, 'data') });
    const bad = [
      [{ name: '', kind: 'command', command: 'x' }, /name/],
      [{ name: 'x', kind: 'shell', command: 'x' }, /kind/],
      [{ name: 'x', kind: 'command' }, /needs a command/],
      [{ name: 'x', kind: 'ask', ask: { to: '@m1', body: 'hi' } }, /@boss or @mgr/],
      [{ name: 'x', kind: 'order', order: { title: 't', brief: '' } }, /brief/],
      [{ id: '../x', name: 'x', kind: 'command', command: 'ls' }, /id/],
    ];
    for (const [tool, re] of bad) {
      await assert.rejects(tk.save('P1', [tool]), (e) => e.status === 400 && re.test(e.message));
    }
    await assert.rejects(tk.save('P1', 'nope'), (e) => e.status === 400);
    await assert.rejects(tk.save('P1', [{ id: 'a', name: 'a', kind: 'command', command: 'ls' }, { id: 'a', name: 'b', kind: 'command', command: 'ls' }]), /Two tools/);
    await assert.rejects(tk.list('P9'), (e) => e.status === 404);
    await assert.rejects(tk.list('../../etc'), (e) => e.status === 404);
    assert.throws(() => normalizeTool(null), /must be an object/);
  });

  test('a broken file falls back to the starter tools and is kept as .bak', async () => {
    await fs.mkdir(path.join(tmp, 'data', 'toolkit'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'data', 'toolkit', 'P1.json'), '{nope');
    const tk = createToolkit({ store, dataDir: path.join(tmp, 'data') });
    assert.equal((await tk.list('P1')).length, 4);
    await fs.access(path.join(tmp, 'data', 'toolkit', 'P1.json.bak'));
  });
});

describe('toolkit runs', () => {
  test('Run checks goes through git.runCheck in the project folder and streams toolrun events', async () => {
    const git = fakeGit({ ok: false, code: 1, tail: 'not ok 1 - add\n' });
    const tk = createToolkit({ store, dataDir: path.join(tmp, 'data'), git });
    const r = await tk.run('P1', 'check');
    assert.equal(r.ok, true);
    assert.match(r.runId, /^run_/);
    await tk.idle();
    assert.equal(git.calls.length, 1);
    assert.equal(git.calls[0].dir, path.join(tmp, 'proj'));
    assert.equal(git.calls[0].cmd, 'npm test');
    assert.equal(git.calls[0].opts.timeoutMs, 10 * 60 * 1000);
    const mine = events.filter((e) => e.runId === r.runId);
    assert.equal(mine[0].chunk, '$ npm test\n');
    assert.equal(mine[1].chunk, 'not ok 1 - add\n');
    assert.deepEqual({ done: mine.at(-1).done, code: mine.at(-1).code, toolId: mine.at(-1).toolId }, { done: true, code: 1, toolId: 'check' });
  });

  test('a second run of a busy tool is refused; no check command gives 409', async () => {
    let release;
    const git = { runCheck: () => new Promise((res) => { release = () => res({ ok: true, code: 0, tail: '' }); }) };
    const tk = createToolkit({ store, dataDir: path.join(tmp, 'data'), git });
    await tk.run('P1', 'check');
    await assert.rejects(tk.run('P1', 'check'), (e) => e.status === 409);
    assert.equal(tk.running().length, 1);
    release();
    await tk.idle();
    assert.equal(tk.running().length, 0);
    store.patch('projects', 'P1', { checkCmd: null });
    await assert.rejects(tk.run('P1', 'check'), (e) => e.status === 409 && /no check command/.test(e.message));
    await assert.rejects(tk.run('P1', 'nope'), (e) => e.status === 404);
  });

  test('output is redacted with the shared redactor', async () => {
    const redactor = createRedactor();
    redactor.add('super-secret-value-1');
    const git = fakeGit({ ok: true, code: 0, tail: 'key=super-secret-value-1\n' });
    const tk = createToolkit({ store, dataDir: path.join(tmp, 'data'), git, redactor });
    await tk.save('P1', [{ id: 'echo', name: 'Echo', kind: 'command', command: 'echo super-secret-value-1' }]);
    const { runId } = await tk.run('P1', 'echo');
    await tk.idle();
    const text = events.filter((e) => e.runId === runId).map((e) => e.chunk || '').join('');
    assert.equal(text.includes('super-secret-value-1'), false);
    assert.match(text, /\[redacted\]/);
  });

  test('Open folder calls the injected reveal, never a shell', async () => {
    const opened = [];
    const git = fakeGit();
    const tk = createToolkit({ store, dataDir: path.join(tmp, 'data'), git, reveal: async (p) => opened.push(p) });
    assert.deepEqual(await tk.run('P1', 'folder'), { ok: true });
    assert.deepEqual(opened, [path.join(tmp, 'proj')]);
    assert.equal(git.calls.length, 0);
  });

  test('an order tool starts a job through orch.createJob', async () => {
    const orders = [];
    const orch = { createJob: async (o) => { orders.push(o); return { id: 'J7' }; } };
    const tk = createToolkit({ store, dataDir: path.join(tmp, 'data'), orch, getSettings: () => ({ budgetUsd: 20 }) });
    await tk.save('P1', [{ id: 'o', name: 'Lint', kind: 'order', order: { title: 'Fix lint', brief: 'Fix lint errors.', kind: 'fix', crew: 'solo' } }]);
    assert.deepEqual(await tk.run('P1', 'o'), { ok: true, jobId: 'J7' });
    assert.deepEqual(orders[0].project, { mode: 'existing', path: path.join(tmp, 'proj'), agentFilesAck: false });
    assert.equal(orders[0].budgetUsd, 20);
    assert.equal(orders[0].crew, 'solo');
  });

  test('an ask tool posts a REQ from the owner to the running job; none running is 409', async () => {
    const posts = [];
    const orch = { ownerPost: async (p) => { posts.push(p); return { ok: true, msg: { id: 41 } }; } };
    const tk = createToolkit({ store, dataDir: path.join(tmp, 'data'), orch });
    await assert.rejects(tk.run('P1', 'status'), (e) => e.status === 409);
    store.put('jobs', { id: 'J1', projectId: 'P1', status: 'running' });
    const r = await tk.run('P1', 'status');
    assert.deepEqual(r, { ok: true, msgId: 41, jobId: 'J1' });
    assert.deepEqual(posts[0], { jobId: 'J1', kind: 'REQ', to: '@boss', scope: '#plan', body: 'Report what was finished today and what is slow.' });
    orch.ownerPost = async () => ({ ok: false, code: 'E_TO', hint: 'no manager' });
    await assert.rejects(tk.run('P1', 'blocked'), (e) => e.status === 400 && /E_TO/.test(e.message));
  });

  test('a real command through gitops (safety trusting) in a temp project', async () => {
    const p = makePaths({ dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'config'), projectsDir: path.join(tmp, 'projects') });
    const git = createGit({ paths: p, getSettings: () => ({ safety: 'trusting', limits: { checkTimeoutMin: 1 } }) });
    const tk = createToolkit({ store, dataDir: p.data, git });
    await tk.save('P1', [{ id: 'hi', name: 'Hi', kind: 'command', command: 'echo hello-from-tool && exit 3' }]);
    const { runId } = await tk.run('P1', 'hi');
    await tk.idle();
    const mine = events.filter((e) => e.runId === runId);
    assert.match(mine.map((e) => e.chunk || '').join(''), /hello-from-tool/);
    assert.equal(mine.at(-1).code, 3);
    if (typeof git.shutdown === 'function') await git.shutdown();
  });

  test('command output streams in whole lines while it runs, redacted, and stops at 200 KB (section 12c)', async () => {
    const p = makePaths({ dataDir: path.join(tmp, 'data2'), configDir: path.join(tmp, 'config2'), projectsDir: path.join(tmp, 'projects') });
    const redactor = { redact: (t) => String(t).split('stream-secret-0123').join('[redacted]') };
    const git = createGit({ paths: p, redactor, getSettings: () => ({ safety: 'trusting', limits: { checkTimeoutMin: 1 } }) });
    const tk = createToolkit({ store, dataDir: p.data, git, redactor });
    // Line one, a pause (so two chunks arrive at different times), then about 300 KB of output.
    const cmd = "echo first-line stream-secret-0123; sleep 0.3; i=0; while [ $i -lt 3000 ]; do printf '%0100d\\n' $i; i=$((i+1)); done";
    await tk.save('P1', [{ id: 'big', name: 'Big', kind: 'command', command: cmd }]);
    const { runId } = await tk.run('P1', 'big');
    await tk.idle();
    const mine = events.filter((e) => e.runId === runId);
    const chunks = mine.filter((e) => typeof e.chunk === 'string').map((e) => e.chunk);
    assert.ok(chunks.length >= 3, `streamed in several events (${chunks.length})`);
    assert.equal(chunks[1], 'first-line [redacted]\n', 'the first line came on its own, before the pause ended, redacted');
    for (const c of chunks.slice(1, -1)) assert.ok(c.endsWith('\n'), 'every streamed chunk is whole lines');
    const all = chunks.slice(1).join('');
    assert.ok(all.length <= 200 * 1024 + 200, `capped: ${all.length}`);
    assert.match(all, /\[output cut after \d+ characters\]/);
    assert.equal(mine.at(-1).done, true);
    assert.equal(mine.at(-1).code, 0);
    await git.shutdown();
  });
});
