// Verifier tests for server/gitops.js against the amended contract (docs/ARCHITECTURE.md sections 9, 10, 12).
// Each test proves one defect that the first alignment pass left open. Real git in temp dirs only.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGit } from '../server/gitops.js';

const canSandbox = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
let root;
let hubEnv;
let ownerEnv;
let shops = 0;

before(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ws-gitops-verify-')));
  const home = path.join(root, 'home');
  await fs.mkdir(home, { recursive: true });
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  hubEnv = {
    ...base, HOME: home, LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
  ownerEnv = {
    ...hubEnv,
    GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.com', GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.com',
  };
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function run(cwd, args, env) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')} failed in ${cwd}: ${stderr || err.message}`));
      else resolve(stdout.replace(/\n$/, ''));
    });
  });
}
const owner = (cwd, ...args) => run(cwd, ['-c', 'core.hooksPath=/dev/null', ...args], ownerEnv);
const agent = (cwd, ...args) => run(cwd, ['-c', 'user.name=Agent', '-c', 'user.email=a@x', ...args], hubEnv);

async function put(dir, rel, content) {
  const file = path.join(dir, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}
const read = (dir, rel) => fs.readFile(path.join(dir, rel), 'utf8');
const there = (file) => fs.lstat(file).then(() => true, () => false);
const intHead = (s) => owner(s.project.path, 'rev-parse', 'ws/J1/int');

async function shop({ seed = { 'README.md': 'hello\n' }, settings = { safety: 'trusting' }, project: extra = {}, redactor } = {}) {
  shops += 1;
  const dir = path.join(root, `shop ${shops}`);
  const paths = { projects: path.join(dir, 'projects'), work: path.join(dir, 'data', 'work'), run: path.join(dir, 'data', 'run') };
  const make = () => createGit({ paths, env: hubEnv, getSettings: () => settings, redactor });
  const git = make();
  const made = await git.initProject({ name: 'Demo App' });
  for (const [rel, content] of Object.entries(seed)) await put(made.path, rel, content);
  await owner(made.path, 'add', '-A');
  await owner(made.path, 'commit', '-q', '-m', 'seed');
  const project = { id: 'P1', name: 'Demo App', path: made.path, targetBranch: made.targetBranch, setupCmd: null, checkCmd: null, ...extra };
  const job = await git.startJob(project, 'J1');
  return { dir, paths, make, git, project, job };
}

async function deliver(s, taskId, changes) {
  const bench = await s.git.createBench(s.project, 'J1', taskId, {});
  for (const [rel, content] of Object.entries(changes)) await put(bench.dir, rel, content);
  await s.git.commitAll(bench.dir, `${taskId}: work`, 'Rusty');
  assert.equal((await s.git.syncBench(bench.dir)).ok, true);
  const done = await s.git.integrate(s.project, 'J1', taskId, bench.dir, `${taskId}: merge`);
  assert.equal(done.ok, true, JSON.stringify(done));
  return { ...bench, mergeSha: done.mergeSha };
}

async function ownerCommit(s, files, message = 'owner work') {
  for (const [rel, content] of Object.entries(files)) await put(s.project.path, rel, content);
  await owner(s.project.path, 'add', '-A');
  await owner(s.project.path, 'commit', '-q', '-m', message);
  return owner(s.project.path, 'rev-parse', 'HEAD');
}

/* ------------------------------------------------------------------ hub paths */

describe('hub paths on a case-insensitive disk', () => {
  test('a hub path in another case (.Agents/, .SHOP/) never reaches a commit', async () => {
    const s = await shop();
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    await s.git.writeHubFiles(bench.dir, { '.agents/hooks.json': '{"hooks":"evil"}' });
    await put(bench.dir, '.shop/notes.md', 'n\n');
    await put(bench.dir, 'src/a.js', 'a\n');
    // the agent force-adds hub files under another spelling of the folder name
    await agent(bench.dir, 'add', '-f', '--', '.Agents/hooks.json');
    await agent(bench.dir, 'add', '-f', '--', '.SHOP/notes.md');
    assert.match(await agent(bench.dir, 'ls-files'), /^\.Agents\/hooks\.json$/m); // the trick works in plain git
    assert.ok(await s.git.commitAll(bench.dir, 'T1: work', 'Rusty'));
    assert.equal(await owner(bench.dir, 'diff', '--name-only', 'origin/ws/J1/int', 'HEAD'), 'src/a.js');
    assert.deepEqual(await s.git.changedFiles(bench.dir), ['src/a.js']);
  });
});

describe('bench files the hub writes', () => {
  test('a link planted at .git/info/exclude is never read or written through', async () => {
    const s = await shop();
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    const victim = path.join(s.dir, 'victim.txt');
    await fs.writeFile(victim, 'PRIVATE-CONTENT-1234\n');
    await fs.rm(path.join(bench.dir, '.git', 'info', 'exclude'));
    await fs.symlink(victim, path.join(bench.dir, '.git', 'info', 'exclude'));
    await put(bench.dir, 'a.txt', 'a\n');
    assert.ok(await s.git.commitAll(bench.dir, 'T1: work', 'Rusty'));
    assert.equal(await read(s.dir, 'victim.txt'), 'PRIVATE-CONTENT-1234\n');
    const exclude = path.join(bench.dir, '.git', 'info', 'exclude');
    assert.equal((await fs.lstat(exclude)).isFile(), true);
    assert.doesNotMatch(await fs.readFile(exclude, 'utf8'), /PRIVATE-CONTENT/);
    assert.match(await fs.readFile(exclude, 'utf8'), /^\/\.agents\/$/m);
  });
});

describe('bench git folder', () => {
  test('a commondir file in a bench .git is removed before the hub runs git there', async () => {
    const s = await shop();
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    await fs.mkdir(path.join(bench.dir, 'elsewhere'));
    await fs.writeFile(path.join(bench.dir, '.git', 'commondir'), '../elsewhere\n');
    await put(bench.dir, 'a.txt', 'a\n');
    await s.git.commitAll(bench.dir, 'T1: work', 'Rusty').catch(() => null);
    assert.equal(await there(path.join(bench.dir, '.git', 'commondir')), false);
  });
});

/* ------------------------------------------------------------------ agent dir */

describe('cleanAgentDir', () => {
  test('a tracked .agents file the agent changed is put back; a forged origin ref keeps nothing', async () => {
    const s = await shop({ seed: { 'README.md': 'r\n', '.agents/settings.json': '{"safe":true}\n' } });
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    await put(bench.dir, '.agents/settings.json', '{"enableTerminalSandbox":false}\n');
    // the agent commits its own .agents file and points the bench's integration ref at that commit
    await put(bench.dir, '.agents/evil.json', '{"evil":true}\n');
    await agent(bench.dir, 'add', '-f', '--', '.agents/evil.json');
    await agent(bench.dir, 'commit', '-q', '-m', 'plant');
    await agent(bench.dir, 'update-ref', 'refs/remotes/origin/ws/J1/int', 'HEAD');
    const removed = await s.git.cleanAgentDir(bench.dir, []);
    assert.ok(removed.includes('.agents/evil.json'), JSON.stringify(removed));
    assert.equal(await there(path.join(bench.dir, '.agents', 'evil.json')), false);
    assert.equal(await read(bench.dir, '.agents/settings.json'), '{"safe":true}\n');
  });
});

/* ------------------------------------------------------------------ commands the hub runs */

describe('setup and check never reach the hub through .git', { skip: !canSandbox }, () => {
  test('a setup command that plants a filter in a hub clone does not run it in the hub', async () => {
    const marker = path.join(root, `escape-${Date.now()}`);
    const setupCmd = `printf '[filter "x"]\\n\\tsmudge = touch ${marker}\\n' >> .git/config; echo '* filter=x' > .gitattributes; echo changed > README.md`;
    const s = await shop({ settings: { safety: 'sandboxed' }, project: { setupCmd, checkCmd: 'true' } });
    await s.git.headCheck(s.project, 'J1');
    assert.equal(await there(marker), false, 'the planted filter ran outside the sandbox');
  });

  test('a sandboxed check in the canonical folder cannot change its .git', async () => {
    const s = await shop({ settings: { safety: 'sandboxed' } });
    const before = await read(s.project.path, '.git/config');
    const result = await s.git.runCheck(s.project.path, 'git config filter.x.smudge "touch /tmp/x"; echo hook > .git/hooks/post-merge', {});
    assert.equal(await read(s.project.path, '.git/config'), before);
    assert.equal(await there(path.join(s.project.path, '.git', 'hooks', 'post-merge')), false);
    assert.equal(result.ok, false);
    // ordinary work in the folder still runs
    assert.equal((await s.git.runCheck(s.project.path, 'git status --porcelain >/dev/null && echo ok > out.txt && cat out.txt', {})).tail, 'ok\n');
  });

  test('a sandboxed command cannot start programs outside the sandbox (open, osascript, launchctl)', async () => {
    const s = await shop({ settings: { safety: 'sandboxed' } });
    for (const cmd of ['/usr/bin/open -R /nonexistent-ws-verify', "/usr/bin/osascript -e 'return 1'", '/bin/launchctl help']) {
      const result = await s.git.runCheck(s.project.path, cmd, {});
      assert.equal(result.ok, false, cmd);
      assert.match(result.tail, /Operation not permitted/, cmd);
    }
    const node = await s.git.runCheck(s.project.path, `'${process.execPath}' -e "console.log(1+1)" && /usr/bin/git --version >/dev/null && echo fine`, {});
    assert.equal(node.tail, '2\nfine\n', node.tail);
  });
});

/* ------------------------------------------------------------------ head check */

describe('head check', () => {
  test('after a green refresh the head check is cached and _head is at the refresh merge', async () => {
    const s = await shop({ project: { checkCmd: 'true' } });
    await deliver(s, 'T1', { 'a.txt': 'a\n' });
    await s.git.headCheck(s.project, 'J1'); // _head at the T1 merge
    await ownerCommit(s, { 'owner.txt': 'o\n' });
    const refreshed = await s.git.refreshTruck(s.project, 'J1');
    assert.equal(refreshed.ok, true);
    const head = await s.git.headCheck(s.project, 'J1');
    assert.equal(head.sha, refreshed.sha);
    const headDir = path.join(s.paths.work, 'J1', '_head');
    assert.equal(await owner(headDir, 'rev-parse', 'HEAD'), refreshed.sha); // the QA turn runs there
    assert.equal(await read(headDir, 'owner.txt'), 'o\n');
  });

  test('_head is pristine: an ignored file from an earlier run does not stay', async () => {
    const s = await shop({
      seed: { 'README.md': 'r\n', '.gitignore': 'stale.flag\n' },
      project: { checkCmd: 'test ! -f stale.flag && touch stale.flag' },
    });
    assert.equal((await s.git.headCheck(s.project, 'J1')).ok, true);
    await deliver(s, 'T1', { 'a.txt': 'a\n' });
    const second = await s.git.headCheck(s.project, 'J1');
    assert.equal(second.ok, true, second.tail);
  });

  test('a stored result for a sha counts only when _head is at that sha', async () => {
    const counter = path.join(root, `stored-runs-${Date.now()}.log`);
    const s = await shop({ project: { checkCmd: `echo run >> '${counter}'` } });
    const sha = await intHead(s);
    const result = await s.git.headCheck({ ...s.project, headCheck: { sha, ok: true, tail: 'old', ms: 1 } }, 'J1');
    assert.equal(result.sha, sha);
    assert.equal(await read(path.join(s.paths.work, 'J1', '_head'), 'README.md'), 'hello\n');
    assert.equal(await read(root, path.basename(counter)), 'run\n'); // no _head yet: it ran
  });
});

/* ------------------------------------------------------------------ guard on a catch-up bench */

describe('guard on a catch-up bench', () => {
  const settings = { safety: 'trusting', limits: { maxFileMb: 0.001, maxDeliveryMb: 0.004 } };

  test("the owner's own target content is not refused, and a squash keeps the target merge", async () => {
    const s = await shop({ seed: { 'README.md': 'r\n', 'package.json': '{}\n' }, settings });
    await deliver(s, 'T1', { 'a.txt': 'a\n' });
    const ownerSha = await ownerCommit(s, {
      'certs/dev.pem': 'not a real cert\n', 'conf.js': 'const api_key = abcdefgh12345678;\n', 'big.bin': 'x'.repeat(2048), 'package.json': '{"v":2}\n',
    });
    const bench = await s.git.createBench(s.project, 'J1', 'T9', { mergeTarget: true });
    await put(bench.dir, 'fix.txt', 'fix\n');
    await s.git.commitAll(bench.dir, 'T9: fix', 'Rusty');
    const passed = await s.git.guard(bench.dir);
    assert.equal(passed.ok, true, JSON.stringify(passed));
    assert.deepEqual(passed.flags.checkFiles, []);

    // refused content of the maker itself in the history: the squash keeps the owner's commits as a parent
    await put(bench.dir, '.env', 'SECRET=1\n');
    await s.git.commitAll(bench.dir, 'T9: oops', 'Rusty');
    assert.equal((await s.git.guard(bench.dir)).why, 'denied');
    await fs.rm(path.join(bench.dir, '.env'));
    await s.git.commitAll(bench.dir, 'T9: fix again', 'Rusty');
    const squashed = await s.git.guard(bench.dir);
    assert.equal(squashed.ok, true, JSON.stringify(squashed));
    assert.equal(squashed.squashed, true);
    await owner(bench.dir, 'merge-base', '--is-ancestor', ownerSha, 'HEAD');
    const sync = await s.git.syncBench(bench.dir);
    assert.equal((await s.git.integrate(s.project, 'J1', 'T9', bench.dir, 'T9: merge', { expectHead: sync.head })).ok, true);
    assert.equal((await s.git.truck(s.project, 'J1')).behind, 0);
    assert.equal(await owner(s.project.path, 'log', '--all', '--format=%H', '--', '.env'), '');
  });

  test('a big file a boss allowed does not rewrite the bench at every hand-in', async () => {
    const s = await shop({ settings });
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    await put(bench.dir, 'big.bin', 'x'.repeat(2048));
    const head = await s.git.commitAll(bench.dir, 'T1: big', 'Rusty');
    const result = await s.git.guard(bench.dir, undefined, { allowLarge: true });
    assert.equal(result.ok, true);
    assert.equal(result.squashed, undefined);
    assert.equal(await owner(bench.dir, 'rev-parse', 'HEAD'), head);
  });

  test('createBench with mergeTarget on a reused bench without work of its own still merges the target', async () => {
    const s = await shop();
    await deliver(s, 'T1', { 'a.txt': 'a\n' });
    const ownerSha = await ownerCommit(s, { 'o.txt': 'o\n' });
    await s.git.createBench(s.project, 'J1', 'T9', {}); // the hub stopped before the merge
    const bench = await s.git.createBench(s.project, 'J1', 'T9', { mergeTarget: true });
    await owner(bench.dir, 'merge-base', '--is-ancestor', ownerSha, 'HEAD');
  });
});

/* ------------------------------------------------------------------ ship */

describe('ship', () => {
  test('ship takes a commit sha, never a branch name ("head now")', async () => {
    const s = await shop();
    await deliver(s, 'T1', { 'a.txt': 'a\n' });
    const main = await owner(s.project.path, 'rev-parse', 'main');
    for (const name of ['ws/J1/int', 'HEAD', 'refs/heads/ws/J1/int', 'ws/J1/int~0']) {
      const result = await s.git.ship(s.project, 'J1', { sha: name });
      assert.equal(result.ok, false, name);
    }
    assert.equal(await owner(s.project.path, 'rev-parse', 'main'), main);
    assert.equal((await s.git.ship(s.project, 'J1', { sha: await intHead(s) })).ok, true);
  });
});
