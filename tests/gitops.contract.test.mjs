// Tests for the amended contract of server/gitops.js (docs/ARCHITECTURE.md section 9, design review items).
// Real git in temp dirs under os.tmpdir(); nothing outside them. The item ids (A07, A13, ...) are the review's.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGit, HUB_PATHS } from '../server/gitops.js';

let root;
let hubEnv;
let ownerEnv;
let shops = 0;

before(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ws-gitops-contract-')));
  const home = path.join(root, 'home');
  await fs.mkdir(home, { recursive: true });
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  hubEnv = { ...base, HOME: home, LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  ownerEnv = {
    ...hubEnv,
    GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.com', GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.com',
  };
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/* ------------------------------------------------------------------ helpers */

function run(cwd, args, env) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')} failed in ${cwd}: ${stderr || err.message}`));
      else resolve(stdout.replace(/\n$/, ''));
    });
  });
}
const owner = (cwd, ...args) => run(cwd, ['-c', 'core.hooksPath=/dev/null', ...args], ownerEnv);
const agent = (cwd, ...args) => run(cwd, args, hubEnv);

async function put(dir, rel, content) {
  const file = path.join(dir, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}
const read = (dir, rel) => fs.readFile(path.join(dir, rel), 'utf8');
const there = (file) => fs.lstat(file).then(() => true, () => false);
const intHead = (s) => owner(s.project.path, 'rev-parse', 'ws/J1/int');

/** A project seeded with committed files and a started job J1. Settings default to 'trusting' here; the sandbox has its own file. */
async function shop({ seed = { 'README.md': 'hello\n' }, settings = { safety: 'trusting' }, project: extra = {}, redactor } = {}) {
  shops += 1;
  const dir = path.join(root, `shop ${shops}`);
  const paths = { projects: path.join(dir, 'projects'), work: path.join(dir, 'data', 'work') };
  const logs = [];
  const make = () => createGit({ paths, env: hubEnv, getSettings: () => settings, redactor, log: (level, msg, data) => logs.push({ level, msg, data }) });
  const git = make();
  const made = await git.initProject({ name: 'Demo App' });
  for (const [rel, content] of Object.entries(seed)) await put(made.path, rel, content);
  await owner(made.path, 'add', '-A');
  await owner(made.path, 'commit', '-q', '-m', 'seed');
  const project = { id: 'P1', name: 'Demo App', path: made.path, targetBranch: made.targetBranch, hubCreated: true, setupCmd: null, checkCmd: null, ...extra };
  const job = await git.startJob(project, 'J1');
  return { dir, paths, logs, make, git, project, job };
}

/** One whole task: bench, edits, hand-in, sync, integrate. */
async function deliver(s, taskId, changes) {
  const bench = await s.git.createBench(s.project, 'J1', taskId, {});
  for (const [rel, content] of Object.entries(changes)) await put(bench.dir, rel, content);
  await s.git.commitAll(bench.dir, `${taskId}: work`, 'Rusty');
  assert.equal((await s.git.syncBench(bench.dir)).ok, true);
  const done = await s.git.integrate(s.project, 'J1', taskId, bench.dir, `${taskId}: merge`);
  assert.equal(done.ok, true, JSON.stringify(done));
  return { ...bench, mergeSha: done.mergeSha };
}

/** The owner commits on the target branch. */
async function ownerCommit(s, files, message = 'owner work') {
  for (const [rel, content] of Object.entries(files)) await put(s.project.path, rel, content);
  await owner(s.project.path, 'add', '-A');
  await owner(s.project.path, 'commit', '-q', '-m', message);
  return owner(s.project.path, 'rev-parse', 'HEAD');
}

/* ------------------------------------------------------------------ hub paths and agent files (A07) */

describe('hub paths and agent files', () => {
  test('A07: one HUB_PATHS list, and a new bench excludes both folders', async () => {
    assert.deepEqual(HUB_PATHS, ['.shop/', '.agents/']);
    const s = await shop();
    assert.deepEqual(s.git.HUB_PATHS, HUB_PATHS);
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    const lines = (await read(bench.dir, '.git/info/exclude')).split('\n');
    for (const line of ['/.shop/', '/.agents/', '.DS_Store']) assert.ok(lines.includes(line), line);
  });

  test('A07: no add, change or delete under a hub path reaches a commit', async () => {
    const s = await shop({ seed: { 'README.md': 'hello\n', '.agents/x': 'tracked x\n', '.shop/y': 'tracked y\n' } });
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    await put(bench.dir, '.agents/hooks.json', '{"hooks":{}}');
    await put(bench.dir, '.agents/x', 'changed x\n');
    await fs.rm(path.join(bench.dir, '.shop', 'y'));
    await put(bench.dir, 'src/a.js', 'a\n');
    assert.ok(await s.git.commitAll(bench.dir, 'T1: work', 'Rusty'));
    assert.equal(await owner(bench.dir, 'diff', '--name-only', 'origin/ws/J1/int', 'HEAD'), 'src/a.js');

    // the agent commits hub files by itself, with force: the next hand-in still delivers none of it
    await agent(bench.dir, 'add', '-f', '.agents/hooks.json', '.agents/x');
    await agent(bench.dir, 'rm', '-q', '--cached', '.shop/y');
    await agent(bench.dir, 'commit', '-q', '-m', 'sneak');
    await put(bench.dir, 'src/b.js', 'b\n');
    assert.ok(await s.git.commitAll(bench.dir, 'T1: more', 'Rusty'));
    assert.equal(await owner(bench.dir, 'diff', '--name-only', 'origin/ws/J1/int', 'HEAD'), 'src/a.js\nsrc/b.js');
    assert.deepEqual(await s.git.changedFiles(bench.dir), ['src/a.js', 'src/b.js']);
    assert.equal(await read(bench.dir, '.agents/hooks.json'), '{"hooks":{}}'); // the files stay on disk
  });

  test('A07: writeHubFiles takes paths under any hub path, and nothing else', async () => {
    const s = await shop();
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    await s.git.writeHubFiles(bench.dir, { '.agents/mcp_config.json': '{}', '.shop/TASK.md': 'task', '.agents/deep/prompt.md': 'p' });
    assert.equal(await read(bench.dir, '.agents/mcp_config.json'), '{}');
    assert.equal(await read(bench.dir, '.agents/deep/prompt.md'), 'p');
    assert.equal(await owner(bench.dir, 'status', '--porcelain'), '');
    for (const bad of ['src/a.js', '.agents', '.agents/', '.agentsx/a', '../.agents/a', '.agents/../src/a.js']) {
      await assert.rejects(s.git.writeHubFiles(bench.dir, { [bad]: '' }), /Hub files must be inside/, bad);
    }
    await s.git.writeHubFiles(bench.dir, { '.agents/deep/prompt.md': null });
    assert.equal(await there(path.join(bench.dir, '.agents', 'deep', 'prompt.md')), false);
    assert.equal(s.git.writeShopFiles, s.git.writeHubFiles); // the older name until the callers move

    // a link planted at .agents is replaced: nothing is written through it
    const outside = path.join(s.dir, 'outside');
    await fs.mkdir(outside);
    await fs.rm(path.join(bench.dir, '.agents'), { recursive: true });
    await fs.symlink(outside, path.join(bench.dir, '.agents'));
    await s.git.writeHubFiles(bench.dir, { '.agents/mcp_config.json': '{"safe":true}' });
    assert.deepEqual(await fs.readdir(outside), []);
    assert.equal((await fs.lstat(path.join(bench.dir, '.agents'))).isDirectory(), true);
  });

  test('A07: cleanAgentDir keeps the keep list and tracked files, and always removes a stray hooks.json', async () => {
    const s = await shop({ seed: { 'README.md': 'hello\n', '.agents/rules/a.md': 'project rule\n', '.agents/tracked/hooks.json': '{}' } });
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    const outside = path.join(s.dir, 'victim.txt');
    await fs.writeFile(outside, 'keep me\n');
    await put(bench.dir, '.agents/hooks.json', '{"hooks":"evil"}');
    await put(bench.dir, '.agents/x', 'stray');
    await put(bench.dir, '.agents/deep/er/y', 'stray');
    await fs.symlink(outside, path.join(bench.dir, '.agents', 'link'));
    await put(bench.dir, '.agents/rules/b.md', 'agent rule\n');
    await s.git.writeHubFiles(bench.dir, { '.agents/mcp_config.json': '{}' });

    const removed = await s.git.cleanAgentDir(bench.dir, ['.agents/mcp_config.json']);
    assert.deepEqual(removed, ['.agents/deep/er/y', '.agents/hooks.json', '.agents/link', '.agents/rules/b.md', '.agents/tracked/hooks.json', '.agents/x']);
    const left = (await owner(bench.dir, 'ls-files', '--others', '--ignored', '--exclude-standard', '--cached', '.agents')).split('\n').sort();
    assert.deepEqual(left, ['.agents/mcp_config.json', '.agents/rules/a.md', '.agents/tracked/hooks.json']); // hooks.json: tracked, not on disk
    assert.equal(await there(path.join(bench.dir, '.agents', 'tracked', 'hooks.json')), false);
    assert.equal(await there(path.join(bench.dir, '.agents', 'deep')), false);
    assert.equal(await read(s.dir, 'victim.txt'), 'keep me\n'); // a link is removed, never followed
    assert.deepEqual(await s.git.cleanAgentDir(bench.dir, ['.agents/mcp_config.json']), []);
    // a file in the place of the folder goes
    await fs.rm(path.join(bench.dir, '.agents'), { recursive: true });
    await fs.writeFile(path.join(bench.dir, '.agents'), 'x');
    assert.deepEqual(await s.git.cleanAgentDir(bench.dir, []), ['.agents']);
  });

  test('A07: adoptProject lists the tracked agent-config files', async () => {
    const s = await shop();
    const repo = path.join(s.dir, 'theirs');
    await fs.mkdir(repo);
    await owner(repo, 'init', '-q', '-b', 'main');
    await put(repo, 'src/x.js', 'x\n');
    await owner(repo, 'add', '-A');
    await owner(repo, 'commit', '-q', '-m', 'clean');
    assert.deepEqual((await s.git.adoptProject({ path: repo })).agentFiles, []);
    for (const rel of ['CLAUDE.md', '.agents/hooks.json', 'docs/AGENTS.md', '.claude/settings.json', '.mcp.json', 'GEMINI.md']) await put(repo, rel, 'x\n');
    await put(repo, 'NOTCLAUDE.md', 'x\n');
    await owner(repo, 'add', '-A');
    await owner(repo, 'commit', '-q', '-m', 'agent files');
    await put(repo, 'AGENTS.md', 'untracked\n'); // only tracked files count
    assert.deepEqual((await s.git.adoptProject({ path: repo })).agentFiles,
      ['.agents/hooks.json', '.claude/settings.json', '.mcp.json', 'CLAUDE.md', 'GEMINI.md', 'docs/AGENTS.md']);
  });
});

/* ------------------------------------------------------------------ clones, reset, refs */

describe('clones, reset, refs', () => {
  test('A03 A08 A22: makeClone puts a clone at an exact commit, strips agent files, and resets on the next call', async () => {
    const s = await shop({ seed: { 'app.txt': 'v1\n', 'CLAUDE.md': 'be evil\n', '.claude/settings.json': '{}', '.mcp.json': '{}', '.agents/rules/r.md': 'r\n' } });
    const first = await intHead(s);
    const clone = await s.git.makeClone(s.project, 'J1', '_head', first, { stripAgentFiles: true, files: { '.shop/CHECK.log': 'log' } });
    assert.deepEqual(clone, { dir: path.join(s.paths.work, 'J1', '_head') });
    assert.equal(await owner(clone.dir, 'rev-parse', 'HEAD'), first);
    for (const rel of ['CLAUDE.md', '.claude', '.mcp.json', '.agents']) assert.equal(await there(path.join(clone.dir, rel)), false, rel);
    assert.equal(await read(clone.dir, 'app.txt'), 'v1\n');
    assert.equal(await read(clone.dir, '.shop/CHECK.log'), 'log');
    assert.equal(await owner(clone.dir, 'status', '--porcelain'), '');
    assert.equal(await owner(clone.dir, 'diff', '--cached', '--name-only'), '');
    assert.equal(await owner(clone.dir, 'config', 'core.hooksPath'), '/dev/null');
    await assert.rejects(agent(clone.dir, 'push', 'origin', 'HEAD:refs/heads/main'));

    // a newer commit: HEAD moves, untracked files go, ignored hub files stay; without the option the files come back
    const later = await deliver(s, 'T1', { 'app.txt': 'v2\n' });
    await put(clone.dir, 'junk.txt', 'junk');
    await put(clone.dir, 'app.txt', 'edited by an agent\n');
    await agent(clone.dir, 'config', 'filter.x.clean', 'touch pwned');
    const again = await s.git.makeClone(s.project, 'J1', '_head', later.mergeSha, {});
    assert.equal(again.dir, clone.dir);
    assert.equal(await owner(clone.dir, 'rev-parse', 'HEAD'), later.mergeSha);
    assert.equal(await there(path.join(clone.dir, 'junk.txt')), false);
    assert.equal(await read(clone.dir, 'app.txt'), 'v2\n');
    assert.equal(await read(clone.dir, 'CLAUDE.md'), 'be evil\n');
    assert.equal(await owner(clone.dir, 'status', '--porcelain'), '');
    assert.doesNotMatch(await read(clone.dir, '.git/config'), /filter/);

    await assert.rejects(s.git.makeClone(s.project, 'J1', '../x', first), /Bad clone name/);
    await assert.rejects(s.git.makeClone(s.project, 'J1', '_int', first), /Bad clone name/);
    await assert.rejects(s.git.makeClone(s.project, 'J1', '_head', 'f'.repeat(40)), /Unknown commit/);
    const desk = await s.git.makeClone(s.project, 'J1', '_desk/@b1', later.mergeSha, { files: { '.shop/BLUEPRINT.md': 'plan' } });
    assert.equal(desk.dir, path.join(s.paths.work, 'J1', '_desk', '@b1'));
    assert.equal(await read(desk.dir, '.shop/BLUEPRINT.md'), 'plan');
    await s.git.removeBench(desk.dir);
    assert.equal(await there(desk.dir), false);
  });

  test('A03: a review clone of work that is still only in the bench', async () => {
    const s = await shop();
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    await put(bench.dir, 'new.txt', 'n\n');
    const head = await s.git.commitAll(bench.dir, 'T1: work', 'Rusty');
    const rev = await s.git.makeClone(s.project, 'J1', 'T1.rev', head, { stripAgentFiles: true });
    assert.equal(await owner(rev.dir, 'rev-parse', 'HEAD'), head);
    assert.equal(await read(rev.dir, 'new.txt'), 'n\n');
    assert.equal(await owner(s.project.path, 'rev-parse', 'refs/workshop/J1/T1'), head);
    assert.equal(await owner(s.project.path, 'branch', '--list', 'ws/*', '--format=%(refname:short)'), 'ws/J1/int');
    await assert.rejects(s.git.commitAll(rev.dir, 'x', 'Rusty'), /Not a bench/); // a clone is never committed to
    await s.git.removeBench(rev.dir);
    assert.equal(await there(rev.dir), false);
  });

  test('A03: resetBench and cleanAt', async () => {
    const s = await shop({ seed: { 'README.md': 'hello\n', '.gitignore': 'node_modules/\n' } });
    const bench = await s.git.createBench(s.project, 'J1', 'T1', { files: { '.shop/TASK.md': 'task' } });
    await put(bench.dir, 'a.txt', 'a\n');
    const head = await s.git.commitAll(bench.dir, 'T1: a', 'Rusty');
    assert.equal(await s.git.cleanAt(bench.dir, head), true);
    await put(bench.dir, 'node_modules/x', 'installed\n');
    assert.equal(await s.git.cleanAt(bench.dir, head), true); // ignored files are not a change
    await put(bench.dir, 'README.md', 'dirty\n');
    await put(bench.dir, 'loose.txt', 'untracked\n');
    assert.equal(await s.git.cleanAt(bench.dir, head), false);
    await s.git.resetBench(bench.dir, head);
    assert.equal(await s.git.cleanAt(bench.dir, head), true);
    assert.equal(await read(bench.dir, 'README.md'), 'hello\n');
    assert.equal(await there(path.join(bench.dir, 'loose.txt')), false);
    assert.equal(await read(bench.dir, 'node_modules/x'), 'installed\n');
    assert.equal(await read(bench.dir, '.shop/TASK.md'), 'task');

    // another commit, a detached HEAD: back to the checked head on branch work
    await put(bench.dir, 'b.txt', 'b\n');
    await s.git.commitAll(bench.dir, 'T1: b', 'Rusty');
    await agent(bench.dir, 'checkout', '-q', '--detach');
    assert.equal(await s.git.cleanAt(bench.dir, head), false);
    await s.git.resetBench(bench.dir, head);
    assert.equal(await owner(bench.dir, 'symbolic-ref', '--short', 'HEAD'), 'work');
    assert.equal(await owner(bench.dir, 'rev-parse', 'HEAD'), head);
    await assert.rejects(s.git.resetBench(s.project.path, head), /Not a bench/);
    await assert.rejects(s.git.resetBench(bench.dir, 'f'.repeat(40)), /Unknown commit/);
  });

  test('A29: saveBench keeps uncommitted work reachable after the bench is gone', async () => {
    const s = await shop();
    const idle = await s.git.createBench(s.project, 'J1', 'T2', {});
    assert.equal(await s.git.saveBench(s.project, 'J1', 'T2', idle.dir, 'Flux'), null); // no commits of its own
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    await put(bench.dir, 'wip.txt', 'half done\n');
    const ref = await s.git.saveBench(s.project, 'J1', 'T1', bench.dir, 'Rusty');
    assert.equal(ref, 'refs/workshop/J1/T1');
    await s.git.removeBench(bench.dir);
    assert.equal(await owner(s.project.path, 'show', 'refs/workshop/J1/T1:wip.txt'), 'half done');
    assert.equal(await owner(s.project.path, 'branch', '--list', 'ws/*', '--format=%(refname:short)'), 'ws/J1/int');
    const removed = await s.git.removeJobWork(s.project, 'J1', { keepInt: true });
    assert.deepEqual(removed, { deleted: ['workshop/J1/T1'], kept: ['ws/J1/int'] });
    assert.equal(await owner(s.project.path, 'for-each-ref', 'refs/workshop/J1'), '');
    assert.ok(await owner(s.project.path, 'rev-parse', 'ws/J1/int'));
  });

  test('A13: the bench git config is the hub template before every hub git run', async () => {
    const s = await shop();
    const marker = path.join(s.dir, 'pwned');
    const bench = await s.git.createBench(s.project, 'J1', 'T1', { authorName: 'Rusty' });
    const evil = [
      '[filter "x"]', `\tclean = touch '${marker}'`, `\tsmudge = touch '${marker}'`,
      '[core]', `\tfsmonitor = touch '${marker}.fsmonitor'`, '\thooksPath = .githooks',
      '[remote "origin"]', `\turl = ${path.join(s.dir, 'elsewhere')}`,
      '[alias]', `\tcommit = !touch '${marker}.alias'`, '',
    ].join('\n');
    // proof that this config bites in plain git
    const probe = path.join(s.dir, 'probe');
    await fs.mkdir(probe);
    await owner(probe, 'init', '-q');
    await fs.appendFile(path.join(probe, '.git', 'config'), evil.replace(/pwned/g, 'probe-pwned'));
    await put(probe, '.gitattributes', '* filter=x\n');
    await put(probe, 'f.txt', 'f\n');
    await run(probe, ['add', 'f.txt'], hubEnv);
    assert.equal(await there(path.join(s.dir, 'probe-pwned')), true);

    await fs.appendFile(path.join(bench.dir, '.git', 'config'), evil);
    await put(bench.dir, '.gitattributes', '* filter=x\n');
    await put(bench.dir, 'work.txt', 'w\n');
    assert.ok(await s.git.commitAll(bench.dir, 'T1: work', 'Rusty'));
    for (const name of ['pwned', 'pwned.fsmonitor', 'pwned.alias']) assert.equal(await there(path.join(s.dir, name)), false, name);
    const config = await read(bench.dir, '.git/config');
    assert.doesNotMatch(config, /filter|fsmonitor = touch|alias|elsewhere|\.githooks/);
    assert.equal(await owner(bench.dir, 'config', 'remote.origin.url'), s.project.path);
    assert.equal(await owner(bench.dir, 'config', 'user.name'), 'Rusty');
    assert.equal(await owner(bench.dir, 'config', 'branch.work.merge'), 'refs/heads/ws/J1/int');
    assert.equal((await s.git.syncBench(bench.dir)).ok, true);
    assert.equal((await s.git.integrate(s.project, 'J1', 'T1', bench.dir, 'T1: merge')).ok, true);
    assert.equal(await there(marker), false);
    // a .git that is a link is never followed
    const other = await s.git.createBench(s.project, 'J1', 'T2', {});
    await fs.rename(path.join(other.dir, '.git'), path.join(s.dir, 'moved-git'));
    await fs.symlink(path.join(s.dir, 'moved-git'), path.join(other.dir, '.git'));
    await assert.rejects(s.git.commitAll(other.dir, 'x', 'Rusty'), /not a folder/);
  });
});

/* ------------------------------------------------------------------ setup and head check */

describe('setup and head check', () => {
  test('A20 A22: runSetup puts back the tracked files the command changed; createBench uses it', async () => {
    const seed = { 'package-lock.json': '{"v":1}\n', '.gitignore': 'node_modules/\n', 'README.md': 'r\n' };
    const setupCmd = 'echo \'{"v":2}\' > package-lock.json; rm README.md; mkdir -p node_modules; echo dep > node_modules/x; echo set up';
    const s = await shop({ seed, project: { setupCmd } });
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    assert.equal(bench.setup.ok, true);
    assert.match(bench.setup.tail, /set up/);
    assert.equal(await owner(bench.dir, 'status', '--porcelain'), '');
    assert.equal(await read(bench.dir, 'package-lock.json'), '{"v":1}\n');
    assert.equal(await read(bench.dir, 'node_modules/x'), 'dep\n');
    const again = await s.git.runSetup(bench.dir, setupCmd, {});
    assert.deepEqual(again, { ok: true, code: 0, tail: 'set up\n' });
    assert.equal(await owner(bench.dir, 'status', '--porcelain'), '');
  });

  test('A22: headCheck runs in a pristine _head clone, once per integration head', async () => {
    const counter = path.join(root, `head-runs-${Date.now()}.log`);
    const s = await shop({ project: { setupCmd: 'echo setup >> setup.log', checkCmd: `echo run >> '${counter}'; test -f README.md && echo green` } });
    const first = await s.git.headCheck(s.project, 'J1');
    assert.equal(first.sha, await intHead(s));
    assert.equal(first.ok, true);
    assert.match(first.tail, /green/);
    assert.equal(typeof first.ms, 'number');
    assert.deepEqual(await s.git.headCheck(s.project, 'J1'), first); // cached: no second run
    assert.equal(await read(root, path.basename(counter)), 'run\n');
    assert.equal(await read(path.join(s.paths.work, 'J1', '_head'), 'setup.log'), 'setup\n');

    await deliver(s, 'T1', { 'a.txt': 'a\n' });
    const second = await s.git.headCheck(s.project, 'J1');
    assert.equal(second.sha, await intHead(s));
    assert.equal(await read(root, path.basename(counter)), 'run\nrun\n');
    await s.git.headCheck(s.project, 'J1', { force: true }); // the baseline gate runs it twice
    assert.equal(await read(root, path.basename(counter)), 'run\nrun\nrun\n');
    // a result the orchestrator stored for this sha counts too (a restart)
    const restarted = s.make();
    const stored = { sha: second.sha, ok: false, tail: 'stored', ms: 5 };
    assert.deepEqual(await restarted.headCheck({ ...s.project, headCheck: stored }, 'J1'), stored);

    const red = await shop({ project: { setupCmd: 'echo broken; exit 3', checkCmd: 'echo never' } });
    const failed = await red.git.headCheck(red.project, 'J1');
    assert.equal(failed.ok, false);
    assert.match(failed.tail, /broken/);
    assert.doesNotMatch(failed.tail, /never/);
  });
});

/* ------------------------------------------------------------------ guard (A21, A20) */

describe('guard', () => {
  const settings = { safety: 'trusting', limits: { maxFileMb: 0.001, maxDeliveryMb: 0.002, maxDeliveryFiles: 3 } }; // 1 kB, 2 kB, 3 files

  test('A21: one case per refusal, and the flags of a clean change', async () => {
    const seed = { 'README.md': 'hello\n', 'tests/old.test.js': 'test\n', 'package.json': '{}\n' };
    const s = await shop({ seed, settings });
    const hand = async (taskId, files, options) => {
      const bench = await s.git.createBench(s.project, 'J1', taskId, {});
      for (const [rel, content] of Object.entries(files)) {
        if (content === null) await fs.rm(path.join(bench.dir, rel));
        else await put(bench.dir, rel, content);
      }
      await s.git.commitAll(bench.dir, `${taskId}: work`, 'Rusty');
      return s.git.guard(bench.dir, undefined, options);
    };
    const empty = await hand('T1', {});
    assert.equal(empty.ok, false);
    assert.equal(empty.why, 'empty');
    assert.equal(empty.detail, 'No changes found in your bench.');
    assert.equal(empty.flags.empty, true);

    for (const [i, rel] of ['.env', '.env.local', 'node_modules/x.js', 'src/__pycache__/m.pyc', 'keys/server.pem', 'id.key', '.venv/bin/py'].entries()) {
      const denied = await hand(`D${i}`, { [rel]: 'x' });
      assert.deepEqual([denied.ok, denied.why], [false, 'denied'], rel);
      assert.ok(denied.detail.includes(rel), denied.detail);
    }
    assert.equal((await hand('E1', { '.env.example': 'KEY=\n' })).ok, true);

    const big = await hand('L1', { 'big.bin': 'x'.repeat(2048) });
    assert.deepEqual([big.ok, big.why], [false, 'large']);
    assert.match(big.detail, /big\.bin/);
    assert.equal((await hand('L2', { 'big.bin': 'x'.repeat(2048) }, { allowLarge: true })).ok, true);
    const many = await hand('L3', { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c', 'd.txt': 'd' });
    assert.deepEqual([many.ok, many.why], [false, 'large']);
    const light = await hand('L4', { 'a.txt': 'a'.repeat(900), 'b.txt': 'b'.repeat(900) });
    assert.equal(light.ok, true); // 1.8 kB: every file and the whole delivery under the limits
    const heavy = await hand('L5', { 'a.txt': 'a'.repeat(900), 'b.txt': 'b'.repeat(900), 'c.txt': 'c'.repeat(900) });
    assert.deepEqual([heavy.ok, heavy.why], [false, 'large']); // 2.7 kB: over the delivery limit
    assert.match(heavy.detail, /delivery is/);

    const secret = 'abcdefgh12345678';
    const unsafe = await hand('U1', { 'src/conf.js': `const x = 1;\nconst api_key = ${secret};\n` });
    assert.deepEqual([unsafe.ok, unsafe.why], [false, 'unsafe']);
    assert.match(unsafe.detail, /src\/conf\.js:2/);
    assert.ok(!unsafe.detail.includes(secret), 'the detail never holds the secret');

    const clean = await hand('C1', { 'tests/old.test.js': null, 'package.json': '{"a":1}\n', 'CLAUDE.md': 'x\n' });
    assert.deepEqual(clean, { ok: true, flags: { empty: false, testsDeleted: 1, checkFiles: ['CLAUDE.md', 'package.json'] } });
    const ci = await hand('C2', { '.github/workflows/ci.yml': 'on: push\n' });
    assert.deepEqual(ci.flags.checkFiles, ['.github/workflows/ci.yml']);
  });

  test('A32 A21: the exact value of a stored key is unsafe too', async () => {
    const stored = 'plain-looking-value-918273';
    const redactor = { redact: (text) => text.split(stored).join('[redacted]'), hit: (text) => text.includes(stored) };
    const s = await shop({ redactor });
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    await put(bench.dir, 'notes.txt', `see ${stored}\n`);
    await s.git.commitAll(bench.dir, 'T1: work', 'Rusty');
    const result = await s.git.guard(bench.dir);
    assert.deepEqual([result.ok, result.why, result.detail.includes(stored)], [false, 'unsafe', false]);
  });

  test('A21: refused content in a bench commit never reaches canonical', async () => {
    const s = await shop();
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    await put(bench.dir, '.env', 'SECRET=1\n');
    await put(bench.dir, 'app.js', 'one\n');
    await s.git.commitAll(bench.dir, 'T1: first', 'Rusty');
    assert.equal((await s.git.guard(bench.dir)).why, 'denied');
    await fs.rm(path.join(bench.dir, '.env'));
    await s.git.commitAll(bench.dir, 'T1: fix', 'Rusty');
    const passed = await s.git.guard(bench.dir);
    assert.deepEqual(passed, { ok: true, flags: { empty: false, testsDeleted: 0, checkFiles: [] }, squashed: true });
    assert.equal(await owner(bench.dir, 'rev-list', '--count', 'origin/ws/J1/int..HEAD'), '1');
    assert.equal(await owner(bench.dir, 'log', '-1', '--format=%an', 'HEAD'), 'Rusty'); // the author of the last commit
    const sync = await s.git.syncBench(bench.dir);
    assert.equal((await s.git.integrate(s.project, 'J1', 'T1', bench.dir, 'T1: merge', { expectHead: sync.head })).ok, true);
    assert.equal(await owner(s.project.path, 'log', '--all', '--format=%H', '--', '.env'), '');
    assert.equal(await owner(s.project.path, 'show', 'ws/J1/int:app.js'), 'one');

    // a secret that was committed and removed before any hand-in: the history scan finds it
    const other = await s.git.createBench(s.project, 'J1', 'T2', { authorName: 'Flux' });
    const secret = 'sk-' + 'Z'.repeat(30);
    await put(other.dir, 'cfg.js', `const k = '${secret}';\n`);
    await agent(other.dir, 'add', '-A');
    await agent(other.dir, 'commit', '-q', '-m', 'oops');
    await put(other.dir, 'cfg.js', 'const k = process.env.K;\n');
    await s.git.commitAll(other.dir, 'T2: work', 'Flux');
    const scanned = await s.git.guard(other.dir);
    assert.equal(scanned.ok, true);
    assert.equal(scanned.squashed, true);
    assert.equal(await owner(other.dir, 'log', '-1', '--format=%an', 'HEAD'), 'Flux');
    const sync2 = await s.git.syncBench(other.dir);
    assert.equal((await s.git.integrate(s.project, 'J1', 'T2', other.dir, 'T2: merge', { expectHead: sync2.head })).ok, true);
    assert.doesNotMatch(await owner(s.project.path, 'log', '--all', '-p'), /sk-ZZZZ/);

    // a clean history is left as it is
    const plain = await s.git.createBench(s.project, 'J1', 'T3', {});
    await put(plain.dir, 'p.txt', 'p\n');
    await s.git.commitAll(plain.dir, 'T3: one', 'Rusty');
    await put(plain.dir, 'q.txt', 'q\n');
    const head = await s.git.commitAll(plain.dir, 'T3: two', 'Rusty');
    assert.equal((await s.git.guard(plain.dir)).squashed, undefined);
    assert.equal(await owner(plain.dir, 'rev-parse', 'HEAD'), head);
  });

  test('taintBench: content the orchestrator refused (a zone breach) is squashed out at the next guard pass', async () => {
    const s = await shop();
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    await put(bench.dir, 'scratch/notes.txt', 'notes\n');
    await put(bench.dir, 'app.js', 'one\n');
    await s.git.commitAll(bench.dir, 'T1: Add the app', 'Rusty');
    assert.equal((await s.git.guard(bench.dir)).ok, true, 'the guard itself passes it');
    await s.git.taintBench(bench.dir); // the zone check refused scratch/notes.txt
    await fs.rm(path.join(bench.dir, 'scratch'), { recursive: true });
    await s.git.commitAll(bench.dir, 'T1: Add the app', 'Rusty');
    const passed = await s.git.guard(bench.dir);
    assert.equal(passed.squashed, true);
    assert.equal(await owner(bench.dir, 'rev-list', '--count', 'origin/ws/J1/int..HEAD'), '1');
    assert.equal(await owner(bench.dir, 'log', '-1', '--format=%s%n%an', 'HEAD'), 'T1: Add the app\nRusty', 'the subject and the author stay');
    assert.deepEqual((await s.git.changedFiles(bench.dir)).sort(), ['app.js'], 'the review sees the same change');
    const sync = await s.git.syncBench(bench.dir);
    assert.equal((await s.git.integrate(s.project, 'J1', 'T1', bench.dir, 'T1: merge', { expectHead: sync.head })).ok, true);
    assert.equal(await owner(s.project.path, 'log', '--all', '--format=%H', '--', 'scratch/notes.txt'), '');
    // The mark is used once: a later clean hand-in is not squashed again.
    await put(bench.dir, 'app.js', 'two\n');
    await s.git.commitAll(bench.dir, 'T1: More', 'Rusty');
    assert.equal((await s.git.guard(bench.dir)).squashed, undefined);
  });
});

/* ------------------------------------------------------------------ truck, ship, refresh (A04, A08) */

describe('truck refresh and catch-up', () => {
  test('A04: refreshTruck merges a moved target, checks it, and fast-forwards _int', async () => {
    const counter = path.join(root, `refresh-runs-${Date.now()}.log`);
    const s = await shop({ seed: { 'story.txt': 'one\ntwo\nthree\n' }, project: { checkCmd: `echo run >> '${counter}'; test ! -f red.txt` } });
    await deliver(s, 'T1', { 'a.txt': 'a\n' });
    const before = await intHead(s);
    assert.deepEqual(await s.git.refreshTruck(s.project, 'J1'), { ok: true, sha: before, commits: [] }); // nothing moved

    const ownerSha = await ownerCommit(s, { 'owner.txt': 'mine\n' }, 'owner: notes');
    assert.equal((await s.git.truck(s.project, 'J1')).behind, 1);
    const refreshed = await s.git.refreshTruck(s.project, 'J1');
    assert.equal(refreshed.ok, true, JSON.stringify(refreshed));
    assert.deepEqual(refreshed.commits, [{ sha: ownerSha, subject: 'owner: notes' }]);
    assert.equal(refreshed.sha, await intHead(s));
    assert.deepEqual((await owner(s.project.path, 'rev-list', '--parents', '-1', refreshed.sha)).split(' ').slice(1), [before, ownerSha]);
    assert.equal(await read(s.job.integrationDir, 'owner.txt'), 'mine\n'); // the worktree moved with the branch
    assert.equal(await owner(s.job.integrationDir, 'status', '--porcelain'), '');
    const truck = await s.git.truck(s.project, 'J1');
    assert.deepEqual([truck.behind, truck.headSha], [0, refreshed.sha]);
    assert.equal(await there(path.join(s.paths.work, 'J1', '_refresh')), false);
    assert.equal(await owner(s.project.path, 'for-each-ref', 'refs/workshop/J1/_refresh'), '');
    // the head check of the refresh merge is cached: no second run
    assert.equal((await s.git.headCheck(s.project, 'J1')).sha, refreshed.sha);
    assert.equal(await read(root, path.basename(counter)), 'run\n');
    assert.deepEqual(await s.git.ship(s.project, 'J1', { sha: refreshed.sha }), { ok: true, sha: refreshed.sha, left: 0 });

    // a red check: _int does not change
    await deliver(s, 'T2', { 'b.txt': 'b\n' });
    const held = await intHead(s);
    await ownerCommit(s, { 'red.txt': 'x\n' });
    const red = await s.git.refreshTruck(s.project, 'J1');
    assert.deepEqual([red.ok, red.reason], [false, 'check']);
    assert.equal(typeof red.tail, 'string');
    assert.equal(await intHead(s), held);
    assert.equal(await there(path.join(s.job.integrationDir, 'red.txt')), false);
  });

  test('A04: a conflicting target change gives the files, and _int is unchanged', async () => {
    const s = await shop({ seed: { 'story.txt': 'one\ntwo\nthree\n' } });
    await deliver(s, 'T1', { 'story.txt': 'one\ntwo from the job\nthree\n' });
    const held = await intHead(s);
    await ownerCommit(s, { 'story.txt': 'one\ntwo from the owner\nthree\n' });
    const result = await s.git.refreshTruck(s.project, 'J1');
    assert.deepEqual(result, { ok: false, reason: 'conflict', files: ['story.txt'] });
    assert.equal(await intHead(s), held);
    assert.equal(await read(s.job.integrationDir, 'story.txt'), 'one\ntwo from the job\nthree\n');

    // A04: the catch-up bench starts with that merge in place, markers and all
    const catchUp = await s.git.createBench(s.project, 'J1', 'T9', { mergeTarget: true });
    assert.ok(await owner(catchUp.dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'));
    assert.deepEqual(await s.git.unresolved(catchUp.dir), ['story.txt']);
    assert.match(await read(catchUp.dir, 'story.txt'), /^<<<<<<< /m);
    await put(catchUp.dir, 'story.txt', 'one\ntwo from both\nthree\n');
    assert.ok(await s.git.commitAll(catchUp.dir, 'T9: resolve', 'Rusty'));
    assert.deepEqual(await s.git.unresolved(catchUp.dir), []);
    const sync = await s.git.syncBench(catchUp.dir);
    assert.equal(sync.ok, true);
    assert.equal((await s.git.integrate(s.project, 'J1', 'T9', catchUp.dir, 'T9: merge', { expectHead: sync.head })).ok, true);
    assert.equal((await s.git.truck(s.project, 'J1')).behind, 0);
    assert.equal((await s.git.ship(s.project, 'J1', { sha: await intHead(s) })).ok, true);
    assert.equal(await read(s.project.path, 'story.txt'), 'one\ntwo from both\nthree\n');
  });

  test('A04: a catch-up bench without conflicts holds the target head', async () => {
    const s = await shop();
    await deliver(s, 'T1', { 'a.txt': 'a\n' });
    const ownerSha = await ownerCommit(s, { 'o.txt': 'o\n' });
    const bench = await s.git.createBench(s.project, 'J1', 'T2', { mergeTarget: true });
    await owner(bench.dir, 'merge-base', '--is-ancestor', ownerSha, 'HEAD');
    assert.deepEqual(await s.git.unresolved(bench.dir), []);
    assert.equal(await read(bench.dir, 'o.txt'), 'o\n');
  });

  test('A08: startJob returns intSha, the target head for a new job', async () => {
    const s = await shop();
    assert.equal(s.job.intSha, await owner(s.project.path, 'rev-parse', 'main'));
  });
});
