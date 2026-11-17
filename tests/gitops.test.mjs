// Tests for server/gitops.js. Real git, temp dirs under os.tmpdir(), nothing outside them.
//
// The module runs with a hostile "owner" git config (failing hooks, forced signing with a broken
// gpg, ff-only merges, colors, external diff, no identity). It must work anyway, and no owner hook
// may ever run. Three actors use git here:
//   hub    the module under test (hostile global config, fake secrets, stray GIT_* variables)
//   agent  a maker CLI working inside a bench (same hostile global config, no identity of its own)
//   owner  the human, with a clean config; also used for read-only assertions
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGit, matchZone, zonesOverlap } from '../server/gitops.js';

let root; // everything this file creates lives here
let hubEnv;
let agentEnv;
let ownerEnv;
let hookLog;
let shops = 0;

before(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ws-gitops-')));
  hookLog = path.join(root, 'hook-ran.log');
  const hostile = path.join(root, 'hostile');
  const hook = `#!/bin/sh\necho "$(basename "$0") in $PWD" >> '${hookLog}'\nexit 1\n`;
  const hooks = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-merge-commit', 'post-merge',
    'post-checkout', 'pre-push', 'reference-transaction', 'post-rewrite', 'pre-rebase', 'post-index-change'];
  for (const dir of [path.join(hostile, 'hooks'), path.join(hostile, 'template', 'hooks')]) {
    await fs.mkdir(dir, { recursive: true });
    for (const name of hooks) await fs.writeFile(path.join(dir, name), hook, { mode: 0o755 });
  }
  const config = path.join(hostile, 'gitconfig');
  await fs.writeFile(config, [
    '[user]', '\tuseConfigOnly = true',
    '[init]', '\tdefaultBranch = trunk', `\ttemplateDir = ${path.join(hostile, 'template')}`,
    '[core]', `\thooksPath = ${path.join(hostile, 'hooks')}`, '\teditor = false', '\tquotePath = true', '\tpager = false',
    '[commit]', '\tgpgSign = true',
    '[tag]', '\tgpgSign = true',
    '[gpg]', '\tprogram = /usr/bin/false',
    '[merge]', '\tff = only', '\tconflictStyle = diff3', '\tautoStash = true', '\tlog = true', '\tverifySignatures = true',
    '[rerere]', '\tenabled = true', '\tautoUpdate = true',
    '[color]', '\tui = always',
    '[diff]', '\tnoprefix = true', '\texternal = /usr/bin/false', '\trenames = copies',
    '[fetch]', '\tprune = true', '\trecurseSubmodules = true',
    '[submodule]', '\trecurse = true',
    '[clone]', '\tdefaultRemoteName = upstream',
    '[branch]', '\tautoSetupMerge = always',
    '[pull]', '\trebase = true',
    '[status]', '\tshowUntrackedFiles = no',
    '',
  ].join('\n'));
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  base.LC_ALL = 'C'; // the tests read some git messages
  const hostileEnv = { ...base, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' };
  hubEnv = {
    ...hostileEnv,
    DEMO_API_KEY: 'sk-secret-one', DEMO_TOKEN: 'secret-two', SAFE_FLAG: 'visible',
    GIT_DIR: '/nonexistent/must-be-ignored', GIT_WORK_TREE: '/nonexistent', GIT_INDEX_FILE: '/nonexistent/index',
    GIT_AUTHOR_NAME: 'Wrong Person', GIT_COMMITTER_NAME: 'Wrong Person',
  };
  agentEnv = hostileEnv;
  ownerEnv = {
    ...base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
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
/** The owner, and every read-only assertion. Hooks off: initProject uses the owner's (hostile) template. */
const owner = (cwd, ...args) => run(cwd, ['-c', 'core.hooksPath=/dev/null', ...args], ownerEnv);
/** A maker CLI inside a bench: plain git, hostile global config, no identity in the environment. */
const agent = (cwd, ...args) => run(cwd, args, agentEnv);

async function put(dir, rel, content) {
  const file = path.join(dir, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}
const read = (dir, rel) => fs.readFile(path.join(dir, rel), 'utf8');
const there = (file) => fs.access(file).then(() => true, () => false);
const parentsOf = async (dir, rev = 'HEAD') => (await owner(dir, 'rev-list', '--parents', '-1', rev)).split(' ').slice(1);
/** The ship option for "the truck head the owner sees": ship needs the exact commit (contract section 9). */
const atHead = async (project, jobId = 'J1') => ({ sha: await owner(project.path, 'rev-parse', `ws/${jobId}/int`) });
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** True once the process is gone (polls for a few seconds: a killed process needs a moment to disappear). */
async function gone(pid, waitMs = 5000) {
  for (const end = Date.now() + waitMs; Date.now() < end; await sleep(25)) if (!alive(pid)) return true;
  return !alive(pid);
}

/** A fresh pair of folders and a module instance; make() gives another instance over the same folders (a restart). */
function sandbox() {
  shops += 1;
  const dir = path.join(root, `shop ${shops} é`); // a space and a non-ASCII letter, like many real folders
  const paths = { projects: path.join(dir, 'projects'), work: path.join(dir, 'data', 'work') };
  const logs = [];
  const make = () => createGit({ paths, env: hubEnv, log: (level, msg, data) => logs.push({ level, msg, data }) });
  return { dir, paths, logs, make, git: make() };
}

/** A project (optionally seeded with committed files) with a started job. */
async function shop({ jobId = 'J1', seed } = {}) {
  const s = sandbox();
  const made = await s.git.initProject({ name: 'Demo App' });
  if (seed) {
    for (const [rel, content] of Object.entries(seed)) await put(made.path, rel, content);
    await owner(made.path, 'add', '-A');
    await owner(made.path, 'commit', '-q', '-m', 'seed');
  }
  const project = { id: 'P1', name: 'Demo App', path: made.path, targetBranch: made.targetBranch, hubCreated: true, setupCmd: null, checkCmd: null };
  const job = await s.git.startJob(project, jobId);
  return { ...s, project, job, jobId };
}

/** One whole task: bench, edits, hand-in, sync, integrate. */
async function deliver(s, taskId, changes) {
  const bench = await s.git.createBench(s.project, s.jobId, taskId, { files: { '.shop/TASK.md': taskId } });
  for (const [rel, content] of Object.entries(changes)) await put(bench.dir, rel, content);
  await s.git.commitAll(bench.dir, `${taskId}: work`, 'Rusty');
  const sync = await s.git.syncBench(bench.dir);
  assert.equal(sync.ok, true, JSON.stringify(sync));
  const done = await s.git.integrate(s.project, s.jobId, taskId, bench.dir, `${taskId}: merge`);
  assert.equal(done.ok, true, JSON.stringify(done));
  return { ...bench, mergeSha: done.mergeSha };
}

/** Two benches that changed the same line of story.txt; A is integrated, B is not synced yet. */
async function clash(seed = { 'story.txt': 'one\ntwo\nthree\n' }, file = 'story.txt', from = 'two', toA = 'two from A', toB = 'two from B') {
  const s = await shop({ seed });
  const a = await s.git.createBench(s.project, 'J1', 'T1', {});
  const b = await s.git.createBench(s.project, 'J1', 'T2', {});
  await put(a.dir, file, seed[file].replace(from, toA));
  await put(b.dir, file, seed[file].replace(from, toB));
  await s.git.commitAll(a.dir, 'T1: A', 'Rusty');
  await s.git.commitAll(b.dir, 'T2: B', 'Flux');
  assert.equal((await s.git.syncBench(a.dir)).ok, true);
  assert.equal((await s.git.integrate(s.project, 'J1', 'T1', a.dir, 'T1: merge')).ok, true);
  return { ...s, a, b };
}

/* ------------------------------------------------------------------ zones */

describe('zones', () => {
  test('matchZone table', () => {
    const table = [
      // exact files
      ['src/a.js', ['src/a.js'], true],
      ['src/b.js', ['src/a.js'], false],
      ['README.md', ['README.md'], true],
      ['docs/README.md', ['README.md'], false],
      // "*" stays in one segment
      ['src/a.js', ['src/*.js'], true],
      ['src/x/a.js', ['src/*.js'], false],
      ['src/a.js', ['src/*'], true],
      ['src/x/a.js', ['src/*'], false],
      ['a.md', ['*.md'], true],
      ['docs/a.md', ['*.md'], false],
      ['src/.env', ['src/*'], true],
      // "**" crosses segments
      ['src/x/y/a.js', ['src/**'], true],
      ['src/a.js', ['src/**'], true],
      ['srcx/a.js', ['src/**'], false],
      ['src/x/a.js', ['src/**/*.js'], true],
      ['src/a.js', ['src/**/*.js'], true],
      ['src/a.ts', ['src/**/*.js'], false],
      ['a.test.js', ['**/*.test.js'], true],
      ['x/y/a.test.js', ['**/*.test.js'], true],
      ['x/y/a.js', ['**/*.test.js'], false],
      ['a/b', ['a/**/b'], true],
      ['a/x/y/b', ['a/**/b'], true],
      ['ab', ['a/**/b'], false],
      ['src/deep/x.min.js', ['src/**.js'], true],
      ['anything/at/all.txt', ['**'], true],
      ['anything/at/all.txt', ['.'], true],
      ['anything/at/all.txt', ['/'], true],
      ['anything/at/all.txt', ['./'], true],
      // "?" is one character, never "/"
      ['file1.txt', ['file?.txt'], true],
      ['file12.txt', ['file?.txt'], false],
      ['file.txt', ['file?.txt'], false],
      ['a/b', ['a?b'], false],
      // a trailing "/" or a bare directory name: everything below
      ['src/x/a.js', ['src/'], true],
      ['src', ['src/'], false],
      ['srcx/a.js', ['src/'], false],
      ['src/x/a.js', ['src'], true],
      ['src', ['src'], true],
      ['srcx/a.js', ['src'], false],
      ['pkg/core/src/a.js', ['pkg/*/src/'], true],
      ['src/a.js', ['src/**/'], true],
      ['src/x/a.js', ['src/**/'], true],
      ['lib/a.js', ['src/**/'], false],
      ['a.js', ['**/'], true],
      ['pkg/core/test/a.js', ['pkg/*/src/'], false],
      // normalizing
      ['./src/a.js', ['/src/a.js'], true],
      ['src//a.js', ['./src/a.js'], true],
      ['src/a.js', ['  src/a.js  '], true],
      // odd names are literal
      ['app/blog/[slug]/page.tsx', ['app/blog/[slug]/page.tsx'], true],
      ['app/blog/s/page.tsx', ['app/blog/[slug]/page.tsx'], false],
      ['app/(shop)/@modal/page.tsx', ['app/(shop)/**'], true],
      ['dir with space/ünï — файл.txt', ['dir with space/**'], true],
      ['dir with space/ünï — файл.txt', ['dir with space/ünï — файл.txt'], true],
      ['-dash.txt', ['-dash.txt'], true],
      ['docs/what?.md', ['docs/what?.md'], true],
      ['a+b.c', ['a+b.c'], true],
      ['aab.c', ['a+b.c'], false],
      ['a.b', ['a?b'], true],
      ['axb', ['a.b'], false],
      // choices
      ['src/api/x.ts', ['src/{api,ui}/**'], true],
      ['src/db/x.ts', ['src/{api,ui}/**'], false],
      ['x.ts', ['*.{js,ts}'], true],
      ['x.py', ['*.{js,ts}'], false],
      // lists, case, empty input
      ['lib/x.js', ['src/**', 'lib/**'], true],
      ['test/x.js', ['src/**', 'lib/**'], false],
      ['src/a.js', ['SRC/**'], false],
      ['src/a.js', 'src/**', true],
      ['a/b/c', [], false],
      ['a/b/c', null, false],
      ['a/b/c', [''], false],
      ['', ['**'], false],
    ];
    for (const [file, zones, want] of table) {
      assert.equal(matchZone(file, zones), want, `matchZone(${JSON.stringify(file)}, ${JSON.stringify(zones)})`);
    }
  });

  test('zonesOverlap table', () => {
    const table = [
      // clearly apart
      [['src/api/**'], ['src/ui/**'], false],
      [['src/a.js'], ['src/b.js'], false],
      [['src/'], ['lib/'], false],
      [['src'], ['lib'], false],
      [['**/*.md'], ['src/**/*.js'], false],
      [['src/*.js'], ['src/*.ts'], false],
      [['src/*'], ['src/sub/**'], false],
      [['docs/**', 'README.md'], ['src/**', 'CHANGELOG.md'], false],
      [['src/{api,ui}/**'], ['src/db/**'], false],
      [['pkg/*/src/**'], ['pkg/core/test/**'], false],
      [['file?.txt'], ['file10.txt'], false],
      [['src/api'], ['src/api2'], false],
      [[], ['src/**'], false],
      [null, undefined, false],
      // shared ground
      [['src/a.js'], ['src/a.js'], true],
      [['src/**'], ['src/api/x.js'], true],
      [['src'], ['src/api/**'], true],
      [['src/'], ['src/api/'], true],
      [['**/*.test.js'], ['src/api/**'], true],
      [['**'], ['anything'], true],
      [['*'], ['README.md'], true],
      [['docs/**', 'README.md'], ['src/**', 'README.md'], true],
      [['src/{api,ui}/**'], ['src/ui/x.js'], true],
      [['a/**/b'], ['a/b'], true],
      [['a/**/b'], ['a/*/b'], true],
      [['pkg/*/src/**'], ['pkg/core/**'], true],
      [['file?.txt'], ['fileA.txt'], true],
      [['src/*.js'], ['src/a*'], true],
      [['*.md'], ['READ*'], true],
      ['src/**', 'src/a.js', true],
      // one case-insensitive disk: names that differ only in case are the same place
      [['Docs/**'], ['docs/readme.md'], true],
      [['README.md'], ['readme.md'], true],
    ];
    for (const [a, b, want] of table) {
      assert.equal(zonesOverlap(a, b), want, `zonesOverlap(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
      assert.equal(zonesOverlap(b, a), want, `zonesOverlap(${JSON.stringify(b)}, ${JSON.stringify(a)})`);
    }
  });

  test('a path inside two zone lists means the lists overlap', () => {
    const lists = [['src/**'], ['src/api/'], ['src/*.js'], ['**/*.js'], ['docs'], ['README.md'], ['src/{api,ui}/*.js'], ['*'], ['a/**/b'], ['src/ui/**', 'docs/*.md']];
    const files = ['src/a.js', 'src/api/x.js', 'src/ui/y.js', 'docs/guide.md', 'docs/deep/more.md', 'README.md', 'a/b', 'a/x/b', 'lib/z.js'];
    for (const file of files) {
      for (const one of lists) {
        for (const two of lists) {
          if (matchZone(file, one) && matchZone(file, two)) {
            assert.equal(zonesOverlap(one, two), true, `${file} is in ${JSON.stringify(one)} and ${JSON.stringify(two)}`);
          }
        }
      }
    }
  });
});

/* ------------------------------------------------------------------ projects */

describe('projects', () => {
  test('initProject makes a repo with branch main and one empty commit', async () => {
    const { git, paths } = sandbox();
    const one = await git.initProject({ name: 'Demo App' });
    assert.deepEqual(one, { path: path.join(paths.projects, 'demo-app'), targetBranch: 'main' });
    assert.equal(await owner(one.path, 'symbolic-ref', '--short', 'HEAD'), 'main');
    assert.equal(await owner(one.path, 'rev-list', '--count', 'HEAD'), '1');
    assert.equal(await owner(one.path, 'log', '-1', '--format=%an <%ae>|%cn <%ce>'), 'WorkShop Hub <hub@workshop.local>|WorkShop Hub <hub@workshop.local>');
    assert.equal(await owner(one.path, 'ls-tree', '-r', 'HEAD'), '');
    assert.deepEqual(await fs.readdir(one.path), ['.git']);
    assert.equal(await owner(one.path, 'status', '--porcelain'), '');
  });

  test('initProject picks a safe, free folder name', async () => {
    const { git } = sandbox();
    const names = [];
    for (const name of ['Demo App', 'Demo App', 'demo  app!!', '../../Etc Passwd', '-rf /', 'Ünï Çödé', '日本語 プロジェクト', 'My.Project_v2', '', undefined, '   ']) {
      names.push(path.basename((await git.initProject({ name })).path));
    }
    assert.deepEqual(names, ['demo-app', 'demo-app-2', 'demo-app-3', 'etc-passwd', 'rf', 'uni-code', '日本語-プロジェクト', 'my-project-v2', 'project', 'project-2', 'project-3']);
    assert.equal(path.basename((await git.initProject({ name: 'x'.repeat(200) })).path).length, 48);
    await assert.rejects(createGit({ paths: {} }).initProject({ name: 'x' }), /paths\.projects/);
  });

  test('adoptProject records the checked-out branch and changes nothing', async () => {
    const { git, dir } = sandbox();
    const repo = path.join(dir, 'theirs');
    await fs.mkdir(repo, { recursive: true });
    await owner(repo, 'init', '-q', '-b', 'feature/login');
    await put(repo, 'app.js', 'one\n');
    await owner(repo, 'add', '-A');
    await owner(repo, 'commit', '-q', '-m', 'first');
    await put(repo, 'app.js', 'one\ndirty\n');
    await put(repo, 'notes.txt', 'untracked\n');
    const snapshot = async () => [
      await owner(repo, 'status', '--porcelain'), await owner(repo, 'for-each-ref'), await owner(repo, 'worktree', 'list'),
      (await fs.readdir(repo)).sort().join(), (await fs.readdir(path.join(repo, '.git'))).sort().join(),
    ];
    const before = await snapshot();
    assert.deepEqual(await git.adoptProject({ path: repo }), { path: repo, targetBranch: 'feature/login', agentFiles: [] });
    assert.deepEqual(await snapshot(), before);
    // named through a link: the real top folder comes back
    await fs.symlink(repo, path.join(dir, 'link'));
    assert.deepEqual(await git.adoptProject({ path: path.join(dir, 'link') }), { path: repo, targetBranch: 'feature/login', agentFiles: [] });
  });

  test('adoptProject refuses what it cannot work with, with a clear message', async () => {
    const { git, dir } = sandbox();
    await fs.mkdir(dir, { recursive: true });
    await assert.rejects(git.adoptProject({}), /folder is required/);
    await assert.rejects(git.adoptProject({ path: path.join(dir, 'missing') }), /Folder not found/);
    await fs.writeFile(path.join(dir, 'file.txt'), 'x');
    await assert.rejects(git.adoptProject({ path: path.join(dir, 'file.txt') }), /Folder not found/);
    await fs.mkdir(path.join(dir, 'plain'));
    await assert.rejects(git.adoptProject({ path: path.join(dir, 'plain') }), /Not a git repository/);

    const empty = path.join(dir, 'empty');
    await fs.mkdir(empty);
    await owner(empty, 'init', '-q', '-b', 'main');
    await assert.rejects(git.adoptProject({ path: empty }), /no commits yet/);

    const repo = path.join(dir, 'repo');
    await fs.mkdir(path.join(repo, 'sub', 'deeper'), { recursive: true });
    await owner(repo, 'init', '-q', '-b', 'main');
    await put(repo, 'sub/a.txt', 'a\n');
    await owner(repo, 'add', '-A');
    await owner(repo, 'commit', '-q', '-m', 'first');
    await assert.rejects(git.adoptProject({ path: path.join(repo, 'sub') }), /inside the git repository/);
    await assert.rejects(git.adoptProject({ path: path.join(repo, 'sub', 'deeper') }), /inside the git repository/);
    await assert.rejects(git.adoptProject({ path: path.join(repo, '.git') }), /no working tree/);

    await owner(dir, 'clone', '-q', '--bare', repo, path.join(dir, 'bare.git'));
    await assert.rejects(git.adoptProject({ path: path.join(dir, 'bare.git') }), /no working tree/);

    await owner(repo, 'checkout', '-q', '--detach');
    await assert.rejects(git.adoptProject({ path: repo }), /detached HEAD/);
    await owner(repo, 'checkout', '-q', 'main');
    assert.equal((await git.adoptProject({ path: repo })).targetBranch, 'main');
  });
});

/* ------------------------------------------------------------------ jobs and benches */

describe('jobs and benches', () => {
  test('startJob creates the integration branch and worktree, and is idempotent across restarts', async () => {
    const s = await shop({ seed: { 'seed.txt': 's\n' } });
    const { git, project, job, paths } = s;
    const mainSha = await owner(project.path, 'rev-parse', 'main');
    assert.deepEqual(job, { integrationBranch: 'ws/J1/int', integrationDir: path.join(paths.work, 'J1', '_int'), intSha: mainSha });
    assert.equal(await owner(project.path, 'rev-parse', 'ws/J1/int'), mainSha);
    assert.equal(await owner(job.integrationDir, 'symbolic-ref', '--short', 'HEAD'), 'ws/J1/int');
    assert.equal(await read(job.integrationDir, 'seed.txt'), 's\n');
    assert.equal(await owner(project.path, 'symbolic-ref', '--short', 'HEAD'), 'main'); // the owner's checkout is untouched
    assert.equal(await owner(project.path, 'status', '--porcelain'), '');
    assert.deepEqual(await git.startJob(project, 'J1'), job);

    // the branch moves on; a restart must not reset it
    await put(job.integrationDir, 'kept.txt', 'x\n');
    await owner(job.integrationDir, 'add', '-A');
    await owner(job.integrationDir, 'commit', '-q', '-m', 'on int');
    const intSha = await owner(project.path, 'rev-parse', 'ws/J1/int');
    const restarted = s.make();
    const moved = { ...job, intSha }; // intSha: the integration head now
    assert.deepEqual(await restarted.startJob(project, 'J1'), moved);
    assert.equal(await owner(project.path, 'rev-parse', 'ws/J1/int'), intSha);
    assert.equal((await owner(project.path, 'worktree', 'list')).split('\n').length, 2);

    // the worktree folder is lost: it comes back on the same branch, at its head
    await fs.rm(job.integrationDir, { recursive: true, force: true });
    assert.deepEqual(await restarted.startJob(project, 'J1'), moved);
    assert.equal(await owner(job.integrationDir, 'rev-parse', 'HEAD'), intSha);
    assert.equal(await read(job.integrationDir, 'kept.txt'), 'x\n');

    // junk in its place is replaced
    await fs.rm(job.integrationDir, { recursive: true, force: true });
    await put(job.integrationDir, 'junk.txt', 'junk');
    assert.deepEqual(await restarted.startJob(project, 'J1'), moved);
    assert.equal(await there(path.join(job.integrationDir, 'junk.txt')), false);
    assert.equal(await owner(job.integrationDir, 'symbolic-ref', '--short', 'HEAD'), 'ws/J1/int');
    assert.equal(await owner(job.integrationDir, 'rev-parse', 'HEAD'), intSha);
    assert.equal((await owner(project.path, 'worktree', 'list')).split('\n').length, 2);

    // a second job gets its own branch and folder, at the target head
    const second = await git.startJob(project, 'J2');
    assert.deepEqual(second, { integrationBranch: 'ws/J2/int', integrationDir: path.join(paths.work, 'J2', '_int'), intSha: mainSha });
    assert.equal(await owner(project.path, 'rev-parse', 'ws/J2/int'), mainSha);

    await assert.rejects(git.startJob(project, '../J9'), /Bad job id/);
    await assert.rejects(git.startJob(project, ''), /Bad job id/);
    await assert.rejects(git.startJob({ path: project.path }, 'J9'), /targetBranch/);
    await assert.rejects(git.startJob({ ...project, targetBranch: 'nope' }, 'J9'), /Target branch "nope" not found/);
  });

  test('createBench clones the integration head onto branch work and hides .shop', async () => {
    const s = await shop({ seed: { 'README.md': 'hello\n' } });
    const { git, project } = s;
    const intSha = await owner(project.path, 'rev-parse', 'ws/J1/int');
    const bench = await git.createBench(project, 'J1', 'T1', { files: { '.shop/TASK.md': 'do it', '.shop/BLUEPRINT.md': 'plan' }, authorName: 'Rusty' });
    assert.deepEqual(bench, { dir: path.join(s.paths.work, 'J1', 'T1'), baseSha: intSha, setup: null });
    assert.equal(await owner(bench.dir, 'rev-parse', 'HEAD'), intSha);
    assert.equal(await owner(bench.dir, 'symbolic-ref', '--short', 'HEAD'), 'work');
    assert.equal(await owner(bench.dir, 'for-each-ref', '--format=%(refname)', 'refs/heads/'), 'refs/heads/work');
    assert.equal(await owner(bench.dir, 'config', 'remote.origin.url'), project.path);
    assert.equal(await owner(bench.dir, 'rev-parse', 'origin/ws/J1/int'), intSha);
    assert.equal(git.baseRef(bench.dir), 'origin/ws/J1/int');
    assert.equal(await git.headSha(bench.dir), intSha);
    assert.equal(await read(bench.dir, 'README.md'), 'hello\n');
    assert.equal(await read(bench.dir, '.shop/TASK.md'), 'do it');
    assert.equal(await read(bench.dir, '.shop/BLUEPRINT.md'), 'plan');
    assert.match(await read(bench.dir, '.git/info/exclude'), /^\/\.shop\/$/m);
    assert.equal(await owner(bench.dir, 'status', '--porcelain'), ''); // .shop is invisible to git
    assert.deepEqual(await git.changedFiles(bench.dir), []);

    // hardlinks, not copies
    const objects = path.join(bench.dir, '.git', 'objects');
    const fanout = (await fs.readdir(objects)).find((name) => /^[0-9a-f]{2}$/.test(name));
    const object = path.join(objects, fanout, (await fs.readdir(path.join(objects, fanout)))[0]);
    assert.ok((await fs.stat(object)).nlink >= 2, 'object files are hardlinked');

    // none of the owner's template hooks came along
    assert.equal(await there(path.join(bench.dir, '.git', 'hooks', 'pre-commit')), false);

    // the maker can commit by itself, even under the owner's hostile git config
    await put(bench.dir, 'made.txt', 'x\n');
    await agent(bench.dir, 'add', '-A');
    await agent(bench.dir, 'commit', '-q', '-m', 'maker commit');
    assert.equal(await owner(bench.dir, 'log', '-1', '--format=%an <%ae>'), 'Rusty <agent@workshop.local>');
    assert.equal(await owner(bench.dir, 'ls-files', '.shop'), '');

    // but it cannot push into the canonical repo
    await assert.rejects(agent(bench.dir, 'push', 'origin', 'work'));
    await assert.rejects(agent(bench.dir, 'push', 'origin', 'HEAD:main'));
    await assert.rejects(agent(bench.dir, 'push'));
    assert.equal(await owner(project.path, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'), 'main\nws/J1/int');

    // two calls at once make one bench
    const [left, right] = await Promise.all([
      git.createBench(project, 'J1', 'T2', { files: { '.shop/TASK.md': 'twice' } }),
      git.createBench(project, 'J1', 'T2', { files: { '.shop/TASK.md': 'twice' } }),
    ]);
    assert.deepEqual(left, right);
    assert.deepEqual((await fs.readdir(path.join(s.paths.work, 'J1'))).sort(), ['T1', 'T2', '_int']); // no temp folder left

    await assert.rejects(git.createBench(project, 'J7', 'T1', {}), /startJob/);
    await assert.rejects(git.createBench(project, 'J1', 'int', {}), /Bad task id/);
    await assert.rejects(git.createBench(project, 'J1', '../T1', {}), /Bad task id/);
    await assert.rejects(git.createBench(project, 'J1', '_int', {}), /Bad task id/);
  });

  test('createBench reuses an existing bench after a restart and keeps its work', async () => {
    const s = await shop({ seed: { 'seed.txt': 's\n' } });
    const first = await s.git.createBench(s.project, 'J1', 'T1', { files: { '.shop/TASK.md': 'v1' } });
    await put(first.dir, 'committed.txt', 'c\n');
    const head = await s.git.commitAll(first.dir, 'T1: part', 'Rusty');
    await put(first.dir, 'loose.txt', 'not committed\n');
    await deliver(s, 'T2', { 'other.txt': 'o\n' }); // the integration branch moves on meanwhile

    const again = await s.make().createBench(s.project, 'J1', 'T1', { files: { '.shop/TASK.md': 'v2' }, authorName: 'Flux' });
    assert.deepEqual(again, first);
    assert.equal(await s.git.headSha(first.dir), head);
    assert.equal(await read(first.dir, 'loose.txt'), 'not committed\n');
    assert.equal(await read(first.dir, '.shop/TASK.md'), 'v2');
    assert.equal(await owner(first.dir, 'config', 'user.name'), 'Flux');
    assert.deepEqual(await s.git.changedFiles(first.dir), ['committed.txt', 'loose.txt']);

    // a corrupt bench record is rebuilt from git, and the corrupt file is kept
    await fs.writeFile(path.join(first.dir, '.git', 'workshop.json'), '{ not json');
    const rebuilt = await s.make().createBench(s.project, 'J1', 'T1', {});
    assert.deepEqual(rebuilt, first);
    assert.equal(await read(first.dir, '.git/workshop.json.bak'), '{ not json');
    assert.equal(JSON.parse(await read(first.dir, '.git/workshop.json')).integrationBranch, 'ws/J1/int');

    // a lost record and a lost exclude file come back too
    await fs.rm(path.join(first.dir, '.git', 'workshop.json'));
    await fs.rm(path.join(first.dir, '.git', 'info'), { recursive: true });
    assert.equal(s.git.baseRef(first.dir), 'origin/ws/J1/int');
    assert.deepEqual(await s.make().createBench(s.project, 'J1', 'T1', {}), first);
    assert.equal(await owner(first.dir, 'status', '--porcelain'), '?? loose.txt');
    assert.equal(await read(first.dir, 'loose.txt'), 'not committed\n');
  });

  test('createBench runs the project setup command once', async () => {
    const s = await shop();
    const project = { ...s.project, setupCmd: 'echo "$PWD" > setup.out; echo ready' };
    const bench = await s.git.createBench(project, 'J1', 'T1', { files: {} });
    assert.equal(bench.setup.ok, true);
    assert.match(bench.setup.tail, /ready/);
    assert.equal((await read(bench.dir, 'setup.out')).trim(), bench.dir);
    await fs.rm(path.join(bench.dir, 'setup.out'));
    const again = await s.make().createBench(project, 'J1', 'T1', {});
    assert.equal(again.setup, null);
    assert.equal(await there(path.join(bench.dir, 'setup.out')), false);

    const failing = await s.git.createBench({ ...s.project, setupCmd: 'echo broken; exit 7' }, 'J1', 'T2', {});
    assert.equal(failing.setup.ok, false);
    assert.equal(failing.setup.code, 7);
    assert.match(failing.setup.tail, /broken/);
    assert.equal(await owner(failing.dir, 'symbolic-ref', '--short', 'HEAD'), 'work'); // the bench is still usable

    const skipped = await s.git.createBench({ ...s.project, setupCmd: 'touch ran.txt' }, 'J1', 'T3', { setup: false });
    assert.equal(skipped.setup, null);
    assert.equal(await there(path.join(skipped.dir, 'ran.txt')), false);
  });

  test('writeShopFiles writes only under .shop', async () => {
    const s = await shop();
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    await s.git.writeShopFiles(bench.dir, { '.shop/TASK.md': 'task', '.shop/notes/deep.md': 'deep', './.shop/x.md': 'x' });
    assert.equal(await read(bench.dir, '.shop/TASK.md'), 'task');
    assert.equal(await read(bench.dir, '.shop/notes/deep.md'), 'deep');
    assert.equal(await read(bench.dir, '.shop/x.md'), 'x');
    await s.git.writeShopFiles(bench.dir, { '.shop/x.md': null, '.shop/TASK.md': 'task 2' });
    assert.equal(await there(path.join(bench.dir, '.shop', 'x.md')), false);
    assert.equal(await read(bench.dir, '.shop/TASK.md'), 'task 2');
    assert.deepEqual((await fs.readdir(path.join(bench.dir, '.shop'))).sort(), ['TASK.md', 'notes']); // no temp files left
    for (const bad of ['README.md', '.shop/../README.md', '/etc/workshop-test', '.shop/', '.shopx/a.md', '../outside.md', '.shop']) {
      await assert.rejects(s.git.writeShopFiles(bench.dir, { [bad]: 'x' }), /inside \.shop/, bad);
    }
    assert.equal(await owner(bench.dir, 'status', '--porcelain'), '');
    await assert.rejects(s.git.writeShopFiles(path.join(s.dir, 'nope'), { '.shop/a.md': 'x' }), /Bench not found/);

    // a link planted at .shop is replaced; nothing is written through it
    const outside = path.join(s.dir, 'outside');
    await fs.mkdir(outside);
    await fs.rm(path.join(bench.dir, '.shop'), { recursive: true });
    await fs.symlink(outside, path.join(bench.dir, '.shop'));
    await s.git.writeShopFiles(bench.dir, { '.shop/TASK.md': 'safe' });
    assert.deepEqual(await fs.readdir(outside), []);
    assert.equal((await fs.lstat(path.join(bench.dir, '.shop'))).isDirectory(), true);
    assert.equal(await read(bench.dir, '.shop/TASK.md'), 'safe');
    // and a link inside .shop is refused
    await fs.symlink(outside, path.join(bench.dir, '.shop', 'jump'));
    await assert.rejects(s.git.writeShopFiles(bench.dir, { '.shop/jump/a.md': 'x' }), /through a link/);
    assert.deepEqual(await fs.readdir(outside), []);
  });
});

/* ------------------------------------------------------------------ commits and diffs */

describe('commits and diffs', () => {
  const odd = ['dir with space/ünï — файл.txt', '-leading-dash.txt', '--also=dash', 'tab\tname.txt', 'new\nline.txt', 'quote"name\'.txt', 'star*name?.txt', 'emoji 🙂.md', ':colon', '[brackets].txt'];

  test('commitAll commits new, changed and deleted files with odd names, as the agent', async () => {
    const s = await shop({ seed: { 'old.txt': 'old\n', 'gone.txt': 'bye\n' } });
    const bench = await s.git.createBench(s.project, 'J1', 'T1', { files: { '.shop/TASK.md': 't' } });
    for (const name of odd) await put(bench.dir, name, `content of ${name}\n`);
    await put(bench.dir, 'old.txt', 'old\nnew line\n');
    await fs.rm(path.join(bench.dir, 'gone.txt'));
    const expected = [...odd, 'old.txt', 'gone.txt'].sort();
    assert.deepEqual(await s.git.changedFiles(bench.dir), expected); // before the commit

    const sha = await s.git.commitAll(bench.dir, 'T1: odd names', 'Rusty');
    assert.match(sha, /^[0-9a-f]{40}$/);
    assert.equal(sha, await s.git.headSha(bench.dir));
    assert.equal(await owner(bench.dir, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%s'), 'Rusty <agent@workshop.local>|Rusty <agent@workshop.local>|T1: odd names');
    assert.equal(await owner(bench.dir, 'status', '--porcelain'), '');
    assert.deepEqual(await s.git.changedFiles(bench.dir), expected); // and after it
    assert.deepEqual(await s.git.changedFiles(bench.dir, bench.baseSha), expected);
    assert.deepEqual(await s.git.changedFiles(bench.dir, null), expected);
    assert.deepEqual(await s.git.diffStat(bench.dir, null), await s.git.diffStat(bench.dir, s.git.baseRef(bench.dir)));
    const stat = await s.git.diffStat(bench.dir);
    assert.deepEqual(stat.files.map((file) => file.path).sort(), expected);
    assert.equal(stat.add, odd.length + 2); // one line each, two for the name with a line break, one in old.txt
    assert.equal(stat.del, 1);
    assert.equal(await owner(bench.dir, 'ls-files', '.shop'), '');
    assert.equal(await s.git.commitAll(bench.dir, 'T1: again', 'Rusty'), null); // nothing left to commit

    // every odd name survives the trip to the integration branch
    assert.equal((await s.git.syncBench(bench.dir)).ok, true);
    assert.equal((await s.git.integrate(s.project, 'J1', 'T1', bench.dir, 'T1: merge')).ok, true);
    for (const name of odd) assert.equal(await read(s.job.integrationDir, name), `content of ${name}\n`);
    assert.deepEqual((await s.git.truck(s.project, 'J1')).files.map((file) => file.path).sort(), expected);
    for (const name of odd) {
      assert.match(await s.git.truckDiff(s.project, 'J1', { path: name }), /^\+content of /m, name);
    }
  });

  test('commitAll works when the agent committed some or all of its work', async () => {
    const s = await shop();
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    await put(bench.dir, 'one.txt', '1\n');
    await agent(bench.dir, 'add', 'one.txt');
    await agent(bench.dir, 'commit', '-q', '-m', 'agent: one');
    await put(bench.dir, 'two.txt', '2\n');
    const sha = await s.git.commitAll(bench.dir, 'T1: rest', 'Rusty');
    assert.equal(await owner(bench.dir, 'show', '--name-only', '--format=', sha), 'two.txt');

    await put(bench.dir, 'three.txt', '3\n');
    await agent(bench.dir, 'add', '-A');
    await agent(bench.dir, 'commit', '-q', '-m', 'agent: three');
    const head = await s.git.headSha(bench.dir);
    assert.equal(await s.git.commitAll(bench.dir, 'T1: nothing left', 'Rusty'), null);
    assert.equal(await s.git.headSha(bench.dir), head);
    assert.deepEqual(await s.git.changedFiles(bench.dir), ['one.txt', 'three.txt', 'two.txt']);

    // staged but not committed work is taken too; a blank message and an unusable name fall back
    await put(bench.dir, 'four.txt', '4\n');
    await agent(bench.dir, 'add', 'four.txt');
    await put(bench.dir, 'five.txt', '5\n');
    assert.ok(await s.git.commitAll(bench.dir, '   ', '<>'));
    assert.equal(await owner(bench.dir, 'log', '-1', '--format=%an|%s'), 'Maker|WorkShop: save work');
    assert.equal(await owner(bench.dir, 'show', '--name-only', '--format=', 'HEAD'), 'five.txt\nfour.txt');

    // names and messages that look like options or carry odd characters are plain text
    await put(bench.dir, 'six.txt', '6\n');
    assert.ok(await s.git.commitAll(bench.dir, '-m is not an option here', '--Dash <x>\nO\'Neil'));
    assert.equal(await owner(bench.dir, 'log', '-1', '--format=%an|%s'), 'Dash x O\'Neil|-m is not an option here');
    await put(bench.dir, 'seven.txt', '7\n');
    assert.ok(await s.git.commitAll(bench.dir, 'T1: añade ünïcode — ✓', 'Zoë 🙂'));
    assert.equal(await owner(bench.dir, 'log', '-1', '--format=%an|%s'), 'Zoë 🙂|T1: añade ünïcode — ✓');
    await s.git.createBench(s.project, 'J1', 'T1', { authorName: '--Dash' }); // reuse: the name goes into the bench config
    assert.equal(await owner(bench.dir, 'config', 'user.name'), 'Dash');
  });

  // Contract change (A07): a hub path is never committed in any form, also a file under .shop/ that the project tracks:
  // its change stays in the working tree only.
  test('commitAll never commits hub files under .shop, even when the agent force-added them', async () => {
    const s = await shop({ seed: { '.shop/project-own.txt': 'belongs to the project\n', 'app.txt': 'a\n' } });
    const bench = await s.git.createBench(s.project, 'J1', 'T1', { files: { '.shop/TASK.md': 'task' } });
    await agent(bench.dir, 'add', '-f', '.shop/TASK.md');
    await agent(bench.dir, 'commit', '-q', '-m', 'oops: hub file');
    await put(bench.dir, 'real.txt', 'r\n');
    await put(bench.dir, '.shop/project-own.txt', 'changed by the task\n');
    await s.git.writeShopFiles(bench.dir, { '.shop/TASK.md': 'task v2' });
    assert.ok(await s.git.commitAll(bench.dir, 'T1: work', 'Rusty'));
    assert.equal(await owner(bench.dir, 'ls-tree', '-r', '--name-only', 'HEAD'), '.shop/project-own.txt\napp.txt\nreal.txt');
    assert.equal(await owner(bench.dir, 'show', 'HEAD:.shop/project-own.txt'), 'belongs to the project'); // the integration version
    assert.equal(await read(bench.dir, '.shop/TASK.md'), 'task v2'); // still on disk
    assert.deepEqual(await s.git.changedFiles(bench.dir), ['real.txt']); // hub paths never count as a change

    // forced into the index only: taken out again, and then there is nothing to commit
    await agent(bench.dir, 'add', '-f', '.shop/TASK.md');
    assert.equal(await s.git.commitAll(bench.dir, 'T1: nothing', 'Rusty'), null);
    assert.equal(await owner(bench.dir, 'ls-files', '.shop'), '.shop/project-own.txt');
    assert.equal(await owner(bench.dir, 'status', '--porcelain'), ' M .shop/project-own.txt');
  });

  test('commitAll follows the agent onto another branch when nothing is lost', async () => {
    const s = await shop();
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    await agent(bench.dir, 'checkout', '-q', '-b', 'feature/x');
    await put(bench.dir, 'f.txt', 'f\n');
    await agent(bench.dir, 'add', '-A');
    await agent(bench.dir, 'commit', '-q', '-m', 'on a feature branch');
    await put(bench.dir, 'g.txt', 'g\n');
    const sha = await s.git.commitAll(bench.dir, 'T1: g', 'Rusty');
    assert.equal(await owner(bench.dir, 'symbolic-ref', '--short', 'HEAD'), 'work');
    assert.equal(await owner(bench.dir, 'rev-parse', 'work'), sha);
    assert.deepEqual(await s.git.changedFiles(bench.dir), ['f.txt', 'g.txt']);

    // a detached HEAD on top of work is adopted the same way
    await agent(bench.dir, 'checkout', '-q', '--detach');
    await put(bench.dir, 'h.txt', 'h\n');
    await agent(bench.dir, 'add', '-A');
    await agent(bench.dir, 'commit', '-q', '-m', 'detached');
    assert.equal((await s.git.syncBench(bench.dir)).ok, true);
    assert.equal(await owner(bench.dir, 'symbolic-ref', '--short', 'HEAD'), 'work');
    assert.deepEqual(await s.git.changedFiles(bench.dir), ['f.txt', 'g.txt', 'h.txt']);

    // a HEAD that left work behind would lose commits: refuse, with the way out
    await agent(bench.dir, 'checkout', '-q', '--detach', 'HEAD~1');
    await put(bench.dir, 'side.txt', 's\n');
    await agent(bench.dir, 'add', '-A');
    await agent(bench.dir, 'commit', '-q', '-m', 'side');
    await assert.rejects(s.git.commitAll(bench.dir, 'T1: side', 'Rusty'), /does not contain branch "work"/);
    await assert.rejects(s.git.syncBench(bench.dir), /git checkout work/);
  });

  test('commitAll refuses to commit the conflict markers of a stash pop', async () => {
    const s = await shop({ seed: { 'story.txt': 'one\ntwo\nthree\n' } });
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    await put(bench.dir, 'story.txt', 'one\ntwo stashed\nthree\n');
    await agent(bench.dir, 'stash');
    await put(bench.dir, 'story.txt', 'one\ntwo committed\nthree\n');
    await agent(bench.dir, 'commit', '-q', '-am', 'agent: change');
    await assert.rejects(agent(bench.dir, 'stash', 'pop'));
    assert.match(await read(bench.dir, 'story.txt'), /^<<<<<<< /m);
    const head = await s.git.headSha(bench.dir);
    await assert.rejects(s.git.commitAll(bench.dir, 'T1: hand in', 'Rusty'), /Conflict markers are left in: story\.txt/);
    assert.equal(await s.git.headSha(bench.dir), head);
    assert.deepEqual(await s.git.unresolved(bench.dir), ['story.txt']);
    await put(bench.dir, 'story.txt', 'one\ntwo, both\nthree\n');
    assert.ok(await s.git.commitAll(bench.dir, 'T1: hand in', 'Rusty'));
    assert.deepEqual(await s.git.unresolved(bench.dir), []);
    assert.equal(await owner(bench.dir, 'show', 'HEAD:story.txt'), 'one\ntwo, both\nthree');
  });

  test('diffStat and diff describe the committed work of a bench', async () => {
    const s = await shop({ seed: { 'keep.txt': 'a\nb\nc\n', 'logo.bin': Buffer.from([0, 1, 2, 3, 0, 255]) } });
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    await put(bench.dir, 'keep.txt', 'a\nB\nc\nd\n');
    await put(bench.dir, 'logo.bin', Buffer.from([9, 0, 9, 0, 9]));
    await put(bench.dir, 'new file.txt', 'one\ntwo\n');
    await s.git.commitAll(bench.dir, 'T1: work', 'Rusty');
    const base = s.git.baseRef(bench.dir);

    assert.deepEqual(await s.git.diffStat(bench.dir, base), {
      files: [{ path: 'keep.txt', add: 2, del: 1 }, { path: 'logo.bin', add: 0, del: 0, binary: true }, { path: 'new file.txt', add: 2, del: 0 }],
      add: 4, del: 1,
    });
    await put(bench.dir, 'later.txt', 'not committed\n'); // uncommitted work: in changedFiles, not in the stat
    assert.equal((await s.git.diffStat(bench.dir, base)).files.length, 3);
    assert.deepEqual(await s.git.changedFiles(bench.dir, base), ['keep.txt', 'later.txt', 'logo.bin', 'new file.txt']);
    await fs.rm(path.join(bench.dir, 'later.txt'));

    const text = await s.git.diff(bench.dir, { base, head: 'work' });
    assert.match(text, /^diff --git a\/keep\.txt b\/keep\.txt$/m);
    assert.match(text, /^-b$/m);
    assert.match(text, /^\+B$/m);
    assert.match(text, /^Binary files a\/logo\.bin and b\/logo\.bin differ$/m); // named, not dumped
    assert.doesNotMatch(text, /GIT binary patch/);
    assert.doesNotMatch(text, /\x1b\[/); // no colors, whatever the owner's config says
    assert.equal(await s.git.diff(bench.dir, { base }), text); // head defaults to HEAD

    const only = await s.git.diff(bench.dir, { base: bench.baseSha, path: 'new file.txt' });
    assert.match(only, /^\+\+\+ b\/new file\.txt\t?$/m);
    assert.doesNotMatch(only, /keep\.txt/);
    assert.equal(await s.git.diff(bench.dir, { base, path: 'no such file' }), '');
    assert.equal(await s.git.diff(bench.dir, { base, path: '', maxBytes: '' }), text); // empty query values mean "no filter, default size"
    assert.equal(await s.git.diff(bench.dir, { base, path: [null, 'new file.txt'], maxBytes: 'abc' }), only);
    assert.match(await s.git.diff(bench.dir, { base, maxBytes: '40' }), /\[diff truncated: \d+ bytes cut\]\n$/);

    await assert.rejects(s.git.diff(bench.dir, { head: 'work' }), /needs a base/);
    await assert.rejects(s.git.diff(bench.dir, { base: 'no-such-ref' }), /Unknown base/);
    await assert.rejects(s.git.diff(bench.dir, { base, head: 'no-such-ref' }), /Unknown revision/);
    const trap = path.join(s.dir, 'trap.txt');
    await assert.rejects(s.git.diff(bench.dir, { base: `--output=${trap}` }), /Unknown base/); // a revision is never an option
    await assert.rejects(s.git.changedFiles(bench.dir, `--output=${trap}`), /Unknown base/);
    assert.equal(await there(trap), false);
  });

  test('a rename counts as one removed and one added path', async () => {
    const s = await shop({ seed: { 'old name.txt': 'same\ncontent\n' } });
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    await agent(bench.dir, 'mv', 'old name.txt', 'new name.txt');
    assert.deepEqual(await s.git.changedFiles(bench.dir), ['new name.txt', 'old name.txt']); // both must be inside the zones
    await s.git.commitAll(bench.dir, 'T1: rename', 'Rusty');
    assert.deepEqual(await s.git.changedFiles(bench.dir), ['new name.txt', 'old name.txt']);
    assert.deepEqual(await s.git.diffStat(bench.dir), {
      files: [{ path: 'new name.txt', add: 2, del: 0 }, { path: 'old name.txt', add: 0, del: 2 }], add: 2, del: 2,
    });
    assert.match(await s.git.diff(bench.dir, { base: s.git.baseRef(bench.dir) }), /^rename from old name\.txt\nrename to new name\.txt$/m); // the text diff shows it as a rename
  });

  test('diff cuts long output and says how many bytes were cut', async () => {
    const s = await shop();
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    await put(bench.dir, 'lines.txt', Array.from({ length: 400 }, (_, i) => `line number ${i}`).join('\n') + '\n');
    await put(bench.dir, 'wide.txt', `${'é'.repeat(10_000)}\n`);
    await s.git.commitAll(bench.dir, 'T1: big', 'Rusty');
    const base = bench.baseSha;

    const full = await s.git.diff(bench.dir, { base, path: 'lines.txt', maxBytes: Infinity });
    assert.doesNotMatch(full, /diff truncated/);
    assert.equal(await s.git.diff(bench.dir, { base, path: 'lines.txt', maxBytes: Buffer.byteLength(full) }), full);

    // many short lines: the cut lands on a line end
    const cut = await s.git.diff(bench.dir, { base, path: 'lines.txt', maxBytes: 1000 });
    const note = /\[diff truncated: (\d+) bytes cut\]\n$/.exec(cut);
    assert.ok(note, cut.slice(-80));
    const kept = cut.slice(0, note.index);
    assert.ok(kept.endsWith('\n') && full.startsWith(kept));
    assert.ok(Buffer.byteLength(kept) <= 1000 && Buffer.byteLength(kept) > 900);
    assert.equal(Number(note[1]), Buffer.byteLength(full) - Buffer.byteLength(kept));

    // one very long line of two-byte characters: no character is split
    const wideFull = await s.git.diff(bench.dir, { base, path: 'wide.txt', maxBytes: Infinity });
    for (const maxBytes of [5000, 5001]) {
      const wide = await s.git.diff(bench.dir, { base, path: 'wide.txt', maxBytes });
      const wideNote = /\n\[diff truncated: (\d+) bytes cut\]\n$/.exec(wide);
      assert.ok(wideNote);
      const wideKept = wide.slice(0, wideNote.index);
      assert.doesNotMatch(wideKept, /�/);
      assert.ok(wideFull.startsWith(wideKept));
      assert.ok(Buffer.byteLength(wideKept) >= maxBytes - 1 && Buffer.byteLength(wideKept) <= maxBytes);
      assert.equal(Number(wideNote[1]), Buffer.byteLength(wideFull) - Buffer.byteLength(wideKept));
    }
    assert.match(await s.git.diff(bench.dir, { base, maxBytes: 0 }), /^\[diff truncated: \d+ bytes cut\]\n$/);
  });
});

/* ------------------------------------------------------------------ sync and integrate */

describe('sync and integrate', () => {
  test('two benches on different files: the second is stale until it syncs', async () => {
    const s = await shop({ seed: { 'seed.txt': 's\n' } });
    const { git, project, job } = s;
    const a = await git.createBench(project, 'J1', 'T1', { files: { '.shop/TASK.md': 'A' } });
    const b = await git.createBench(project, 'J1', 'T2', { files: { '.shop/TASK.md': 'B' } });
    const idle = await git.createBench(project, 'J1', 'T3', {});
    await put(a.dir, 'a.txt', 'from A\n');
    await put(b.dir, 'b.txt', 'from B\n');
    const aHead = await git.commitAll(a.dir, 'T1: add a', 'Rusty');
    const bHead = await git.commitAll(b.dir, 'T2: add b', 'Flux');

    // A: up to date, so the sync changes nothing; then it merges
    assert.deepEqual(await git.syncBench(a.dir), { ok: true, head: aHead, merged: false });
    assert.deepEqual(await git.integrate(project, 'J1', 'T1', a.dir, 'T1: add a', { expectHead: 'f'.repeat(40) }),
      { ok: false, reason: 'stale', detail: `The bench head is ${aHead}, not the checked ${'f'.repeat(40)}.` });
    const first = await git.integrate(project, 'J1', 'T1', a.dir, 'T1: add a (Rusty)', { expectHead: aHead });
    assert.equal(first.ok, true);
    assert.equal(await owner(project.path, 'rev-parse', 'ws/J1/int'), first.mergeSha);
    assert.deepEqual(await parentsOf(project.path, first.mergeSha), [a.baseSha, aHead]); // --no-ff
    assert.equal(await owner(project.path, 'log', '-1', '--format=%an <%ae>|%s', first.mergeSha), 'WorkShop Hub <hub@workshop.local>|T1: add a (Rusty)');
    assert.equal(await owner(project.path, 'rev-parse', 'refs/workshop/J1/T1'), aHead); // task refs are never branches
    assert.equal(await owner(project.path, 'branch', '--list', 'ws/*', '--format=%(refname:short)'), 'ws/J1/int');
    assert.equal(await read(job.integrationDir, 'a.txt'), 'from A\n');

    // B was cut before that merge: stale, and nothing moves
    const stale = await git.integrate(project, 'J1', 'T2', b.dir, 'T2: add b');
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, 'stale');
    assert.match(stale.detail, /Sync the bench/);
    assert.equal(await owner(project.path, 'rev-parse', 'ws/J1/int'), first.mergeSha);
    assert.equal(await there(path.join(job.integrationDir, 'b.txt')), false);

    // after a sync B holds the integration head, and still only its own change counts
    const sync = await git.syncBench(b.dir);
    assert.equal(sync.ok, true);
    assert.equal(sync.merged, true);
    assert.equal(sync.head, await git.headSha(b.dir));
    assert.deepEqual(await parentsOf(b.dir), [bHead, first.mergeSha]);
    assert.equal(await owner(b.dir, 'log', '-1', '--format=%an|%s'), 'WorkShop Hub|Merge ws/J1/int into work');
    assert.equal(await read(b.dir, 'a.txt'), 'from A\n');
    assert.deepEqual(await git.changedFiles(b.dir, git.baseRef(b.dir)), ['b.txt']);
    assert.deepEqual(await git.diffStat(b.dir, git.baseRef(b.dir)), { files: [{ path: 'b.txt', add: 1, del: 0 }], add: 1, del: 0 });
    assert.deepEqual(await git.changedFiles(b.dir, b.baseSha), ['a.txt', 'b.txt']); // why the base must be baseRef, not baseSha
    assert.deepEqual(await git.syncBench(b.dir), { ok: true, head: sync.head, merged: false });

    const second = await git.integrate(project, 'J1', 'T2', b.dir, 'T2: add b (Flux)', { expectHead: sync.head });
    assert.equal(second.ok, true);
    assert.deepEqual(await parentsOf(project.path, second.mergeSha), [first.mergeSha, sync.head]);
    assert.equal(await read(job.integrationDir, 'a.txt'), 'from A\n');
    assert.equal(await read(job.integrationDir, 'b.txt'), 'from B\n');
    assert.equal(await owner(job.integrationDir, 'status', '--porcelain'), '');
    assert.equal(await owner(project.path, 'ls-tree', '-r', '--name-only', 'ws/J1/int'), 'a.txt\nb.txt\nseed.txt');
    assert.equal(await owner(project.path, 'ls-tree', '-r', '--name-only', 'main'), 'seed.txt'); // nothing shipped yet

    // a bench without commits of its own just fast-forwards
    const ff = await git.syncBench(idle.dir);
    assert.deepEqual(ff, { ok: true, head: second.mergeSha, merged: true });
    assert.deepEqual(await git.changedFiles(idle.dir), []);

    const load = await git.truck(project, 'J1');
    assert.equal(load.ahead, Number(await owner(project.path, 'rev-list', '--count', 'main..ws/J1/int')));
    assert.equal(load.behind, 0);
    assert.deepEqual(load.files, [{ path: 'a.txt', add: 1, del: 0 }, { path: 'b.txt', add: 1, del: 0 }]);
    assert.deepEqual([load.add, load.del], [2, 0]);
    assert.match(await git.deliveryDiff(project, first.mergeSha), /^\+from A$/m);
    assert.doesNotMatch(await git.deliveryDiff(project, first.mergeSha), /from B/);
    assert.match(await git.deliveryDiff(project, second.mergeSha), /^\+from B$/m);
    assert.doesNotMatch(await git.deliveryDiff(project, second.mergeSha), /from A/);
  });

  test('syncBench stops cleanly when uncommitted work is in the way', async () => {
    const s = await shop({ seed: { 'shared.txt': 'v1\n' } });
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    await deliver(s, 'T2', { 'shared.txt': 'v2\n', 'added.txt': 'new\n' });
    const head = await s.git.headSha(bench.dir);

    await put(bench.dir, 'shared.txt', 'my uncommitted edit\n'); // the hub forgot commitAll
    await assert.rejects(s.git.syncBench(bench.dir), /git merge failed[\s\S]*shared\.txt/);
    assert.equal(await read(bench.dir, 'shared.txt'), 'my uncommitted edit\n');
    assert.equal(await s.git.headSha(bench.dir), head);
    assert.equal(await owner(bench.dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').catch(() => 'none'), 'none');

    await owner(bench.dir, 'checkout', '-q', '--', 'shared.txt');
    await put(bench.dir, 'added.txt', 'an untracked file in the way\n');
    await assert.rejects(s.git.syncBench(bench.dir), /added\.txt/);
    assert.equal(await read(bench.dir, 'added.txt'), 'an untracked file in the way\n');

    // commitAll first, as the hand-in pipeline does: now it is a normal conflict
    assert.ok(await s.git.commitAll(bench.dir, 'T1: own added.txt', 'Rusty'));
    assert.deepEqual(await s.git.syncBench(bench.dir), { ok: false, conflicts: ['added.txt'] });
  });

  test('an interrupted merge in the integration worktree is dropped before the next one', async () => {
    const s = await shop({ seed: { 'seed.txt': 's\n' } });
    const { git, project, job } = s;
    await owner(project.path, 'checkout', '-q', '-b', 'side');
    await put(project.path, 'side.txt', 'side\n');
    await owner(project.path, 'add', '-A');
    await owner(project.path, 'commit', '-q', '-m', 'side');
    await owner(project.path, 'checkout', '-q', 'main');
    await owner(job.integrationDir, 'merge', '-q', '--no-ff', '--no-commit', 'side'); // the hub died here
    assert.match(await owner(job.integrationDir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), /^[0-9a-f]{40}$/);

    const delivery = await deliver(s, 'T1', { 'a.txt': 'A\n' });
    assert.deepEqual((await parentsOf(project.path, delivery.mergeSha)).length, 2);
    assert.equal(await owner(project.path, 'ls-tree', '-r', '--name-only', 'ws/J1/int'), 'a.txt\nseed.txt');
    assert.equal(await there(path.join(job.integrationDir, 'side.txt')), false);
    assert.equal(await owner(job.integrationDir, 'status', '--porcelain'), '');
  });

  test('integrate calls are serial per project', async () => {
    const s = await shop();
    const benches = [];
    for (const id of ['T1', 'T2', 'T3', 'T4']) {
      const bench = await s.git.createBench(s.project, 'J1', id, {});
      await put(bench.dir, `${id}.txt`, `${id}\n`);
      await s.git.commitAll(bench.dir, `${id}: work`, 'Rusty');
      benches.push({ id, dir: bench.dir });
    }
    const results = await Promise.all(benches.map((bench) => s.git.integrate(s.project, 'J1', bench.id, bench.dir, `${bench.id}: merge`)));
    assert.deepEqual(results.map((result) => (result.ok ? 'ok' : result.reason)).sort(), ['ok', 'stale', 'stale', 'stale']);
    assert.equal(await owner(s.job.integrationDir, 'status', '--porcelain'), '');
    // the rest follow one by one, each after its own sync
    for (const [index, bench] of benches.entries()) {
      if (results[index].ok) continue;
      assert.equal((await s.git.syncBench(bench.dir)).ok, true);
      assert.equal((await s.git.integrate(s.project, 'J1', bench.id, bench.dir, `${bench.id}: merge`)).ok, true);
    }
    assert.equal(await owner(s.project.path, 'ls-tree', '-r', '--name-only', 'ws/J1/int'), 'T1.txt\nT2.txt\nT3.txt\nT4.txt');
  });

  test('integrate cleans the integration worktree first, records empty deliveries and reports errors', async () => {
    const s = await shop({ seed: { 'seed.txt': 's\n' } });
    const { git, project, job } = s;
    // leftovers of an interrupted hub run
    await put(job.integrationDir, 'a.txt', 'stray file in the way\n');
    await put(job.integrationDir, 'seed.txt', 'half-written change\n');
    const bench = await git.createBench(project, 'J1', 'T1', {});
    await put(bench.dir, 'a.txt', 'from the bench\n');
    await git.commitAll(bench.dir, 'T1: a', 'Rusty');
    assert.equal((await git.integrate(project, 'J1', 'T1', bench.dir, 'T1: merge')).ok, true);
    assert.equal(await read(job.integrationDir, 'a.txt'), 'from the bench\n');
    assert.equal(await read(job.integrationDir, 'seed.txt'), 's\n');
    assert.equal(await owner(job.integrationDir, 'status', '--porcelain'), '');

    // a lost integration worktree is rebuilt on the way
    await fs.rm(job.integrationDir, { recursive: true, force: true });
    const next = await git.createBench(project, 'J1', 'T2', {});
    await put(next.dir, 'b.txt', 'b\n');
    await git.commitAll(next.dir, 'T2: b', 'Rusty');
    assert.equal((await git.integrate(project, 'J1', 'T2', next.dir, 'T2: merge')).ok, true);
    assert.equal(await read(job.integrationDir, 'b.txt'), 'b\n');

    // a bench with nothing to add merges nothing: no commit, so no other bench goes stale
    const before = await owner(project.path, 'rev-parse', 'ws/J1/int');
    const idle = await git.createBench(project, 'J1', 'T3', {});
    assert.deepEqual(await git.integrate(project, 'J1', 'T3', idle.dir, 'T3: nothing to change'), { ok: true, mergeSha: before, empty: true });
    assert.equal(await owner(project.path, 'rev-parse', 'ws/J1/int'), before);

    // asked twice (the hub stopped before it recorded the merge): the same answer, no second merge
    const again = await git.integrate(project, 'J1', 'T2', next.dir, 'T2: merge again');
    assert.deepEqual(again, { ok: true, mergeSha: before, already: true });
    assert.deepEqual(await git.integrate(project, 'J1', 'T1', bench.dir, 'T1: merge again'), { ok: true, mergeSha: await owner(project.path, 'rev-parse', 'ws/J1/int~1'), already: true });
    assert.equal(await owner(project.path, 'rev-parse', 'ws/J1/int'), before);
    // an idle bench that is behind is stale, like any other
    const behind = await git.createBench(project, 'J1', 'T4', {});
    await deliver(s, 'T5', { 'c.txt': 'c\n' });
    assert.equal((await git.integrate(project, 'J1', 'T4', behind.dir, 'T4: nothing')).reason, 'stale');
    assert.deepEqual(await git.syncBench(behind.dir), { ok: true, head: await owner(project.path, 'rev-parse', 'ws/J1/int'), merged: true });
    assert.equal((await git.integrate(project, 'J1', 'T4', behind.dir, 'T4: nothing')).empty, true);

    // problems come back as results, never as exceptions
    const missing = await git.integrate(project, 'J1', 'T9', path.join(s.paths.work, 'J1', 'T9'), 'T9: merge');
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'error');
    assert.equal(typeof missing.detail, 'string');
    assert.equal((await git.integrate(project, 'J1', '../T1', bench.dir, 'x')).reason, 'error');
    assert.equal((await git.integrate(null, 'J1', 'T1', bench.dir, 'x')).reason, 'error');
    assert.equal((await git.integrate(project, 'J1', 'T1', undefined, 'x')).reason, 'error');
  });

  test('conflict round trip: sync reports conflicts, the maker resolves, sync concludes', async () => {
    const s = await clash();
    const { git, project, job, b } = s;
    const first = await git.syncBench(b.dir);
    assert.deepEqual(first, { ok: false, conflicts: ['story.txt'] });
    const marked = await read(b.dir, 'story.txt');
    assert.equal(marked, 'one\n<<<<<<< HEAD\ntwo from B\n=======\ntwo from A\n>>>>>>> origin/ws/J1/int\nthree\n');
    assert.deepEqual(await git.unresolved(b.dir), ['story.txt']);
    assert.deepEqual(await git.changedFiles(b.dir), ['story.txt']); // still only the maker's own file
    assert.equal((await git.integrate(project, 'J1', 'T2', b.dir, 'T2: merge')).reason, 'stale');

    // handing in again without a fix changes nothing
    assert.equal(await git.commitAll(b.dir, 'T2: again', 'Flux'), null);
    assert.deepEqual(await git.syncBench(b.dir), { ok: false, conflicts: ['story.txt'] });
    assert.equal(await read(b.dir, 'story.txt'), marked);

    // a half fix: the separator line is still there
    await put(b.dir, 'story.txt', 'one\ntwo from B\n=======\ntwo from A\nthree\n');
    assert.deepEqual(await git.syncBench(b.dir), { ok: false, conflicts: ['story.txt'] });
    assert.deepEqual(await git.unresolved(b.dir), ['story.txt']);
    assert.equal(await owner(b.dir, 'status', '--porcelain'), 'UU story.txt'); // git still shows the conflict to the maker

    // the maker resolves by writing the file; the next sync concludes the merge
    await put(b.dir, 'story.txt', 'one\ntwo from A and B\nthree\n');
    const done = await git.syncBench(b.dir);
    assert.equal(done.ok, true);
    assert.equal(done.merged, true);
    assert.equal(done.head, await git.headSha(b.dir));
    assert.deepEqual(await git.unresolved(b.dir), []);
    assert.equal((await parentsOf(b.dir)).length, 2);
    assert.equal(await owner(b.dir, 'status', '--porcelain'), '');
    assert.deepEqual(await git.changedFiles(b.dir), ['story.txt']);
    assert.match(await git.diff(b.dir, { base: git.baseRef(b.dir) }), /^-two from A\n\+two from A and B$/m);

    const merged = await git.integrate(project, 'J1', 'T2', b.dir, 'T2: merge', { expectHead: done.head });
    assert.equal(merged.ok, true);
    assert.equal(await read(job.integrationDir, 'story.txt'), 'one\ntwo from A and B\nthree\n');
  });

  test('a Markdown heading underline is not taken for a conflict marker, a leftover separator is', async () => {
    const readme = 'Summary\n=======\n\nalpha\nbeta\n';
    const name = 'docs dir/-Read Me — é.md'; // an odd name on purpose: conflict paths are parsed NUL-separated
    const s = await clash({ [name]: readme }, name, 'beta', 'beta from A', 'beta from B');
    assert.deepEqual(await s.git.syncBench(s.b.dir), { ok: false, conflicts: [name] });
    assert.match(await read(s.b.dir, name), /^Summary\n=======\n\nalpha\n<<<<<<< HEAD\n/);
    await put(s.b.dir, name, 'Summary\n=======\n\nalpha\nbeta from B\n=======\nbeta from A\n');
    assert.deepEqual(await s.git.syncBench(s.b.dir), { ok: false, conflicts: [name] });
    await put(s.b.dir, name, 'Summary\n=======\n\nalpha\nbeta from both\n');
    assert.deepEqual(await s.git.unresolved(s.b.dir), [name]); // git's own list, until the merge is concluded
    const done = await s.git.syncBench(s.b.dir);
    assert.equal(done.ok, true);
    assert.deepEqual(await s.git.unresolved(s.b.dir), []);
    assert.equal(await read(s.b.dir, name), 'Summary\n=======\n\nalpha\nbeta from both\n');
    assert.deepEqual(await s.git.changedFiles(s.b.dir), [name]);
  });

  test('commitAll concludes a resolved merge as the agent, and refuses while markers remain', async () => {
    const s = await clash();
    const { git, b } = s;
    assert.equal((await git.syncBench(b.dir)).ok, false);
    const before = await git.headSha(b.dir);
    assert.equal(await git.commitAll(b.dir, 'T2: fix', 'Flux'), null);
    assert.equal(await git.headSha(b.dir), before);
    assert.match(await owner(b.dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), /^[0-9a-f]{40}$/); // the merge is still open

    await put(b.dir, 'story.txt', 'one\ntwo from A and B\nthree\n');
    await put(b.dir, 'extra.txt', 'also\n');
    const sha = await git.commitAll(b.dir, 'T2: resolve conflicts', 'Flux');
    assert.equal(sha, await git.headSha(b.dir));
    assert.equal((await parentsOf(b.dir)).length, 2);
    assert.equal(await owner(b.dir, 'log', '-1', '--format=%an|%s'), 'Flux|T2: resolve conflicts');
    assert.deepEqual(await git.changedFiles(b.dir), ['extra.txt', 'story.txt']);
    assert.deepEqual(await git.syncBench(b.dir), { ok: true, head: sha, merged: true });
    assert.deepEqual(await git.syncBench(b.dir), { ok: true, head: sha, merged: false });
    assert.equal((await git.integrate(s.project, 'J1', 'T2', b.dir, 'T2: merge')).ok, true);
  });

  test('markers that the agent committed itself are still caught', async () => {
    const s = await clash();
    const { git, b } = s;
    assert.equal((await git.syncBench(b.dir)).ok, false);
    await agent(b.dir, 'add', '-A');
    await agent(b.dir, 'commit', '-q', '-m', 'merge, markers and all');
    assert.deepEqual(await git.syncBench(b.dir), { ok: false, conflicts: ['story.txt'] });
    assert.deepEqual(await git.unresolved(b.dir), ['story.txt']);
    await put(b.dir, 'story.txt', 'one\ntwo, fixed\nthree\n');
    assert.ok(await git.commitAll(b.dir, 'T2: remove markers', 'Flux'));
    const done = await git.syncBench(b.dir);
    assert.equal(done.ok, true);
    assert.equal(done.merged, true);
    assert.deepEqual(await git.unresolved(b.dir), []);
  });

  test('an aborted merge is reported again on the next sync', async () => {
    const s = await clash();
    assert.equal((await s.git.syncBench(s.b.dir)).ok, false);
    await agent(s.b.dir, 'merge', '--abort');
    assert.equal(await read(s.b.dir, 'story.txt'), 'one\ntwo from B\nthree\n');
    assert.deepEqual(await s.git.unresolved(s.b.dir), []);
    assert.deepEqual(await s.git.syncBench(s.b.dir), { ok: false, conflicts: ['story.txt'] });
    assert.match(await read(s.b.dir, 'story.txt'), /^<<<<<<< HEAD$/m);
  });

  test('conflicts without markers: a deleted file and a binary file', async () => {
    const s = await shop({ seed: { 'doc.txt': 'v1\n', 'logo.bin': Buffer.from([0, 1, 2, 3]) } });
    const { git, project } = s;
    const a = await git.createBench(project, 'J1', 'T1', {});
    const b = await git.createBench(project, 'J1', 'T2', {});
    await fs.rm(path.join(a.dir, 'doc.txt'));
    await put(a.dir, 'logo.bin', Buffer.from([0, 7, 7, 7]));
    await put(b.dir, 'doc.txt', 'v1\nmore from B\n');
    await put(b.dir, 'logo.bin', Buffer.from([0, 9, 9, 9]));
    await git.commitAll(a.dir, 'T1: A', 'Rusty');
    await git.commitAll(b.dir, 'T2: B', 'Flux');
    assert.equal((await git.integrate(project, 'J1', 'T1', a.dir, 'T1: merge')).ok, true);

    assert.deepEqual(await git.syncBench(b.dir), { ok: false, conflicts: ['doc.txt', 'logo.bin'] });
    assert.deepEqual(await git.unresolved(b.dir), ['doc.txt', 'logo.bin']);
    // the maker keeps its own versions: the files as they are in the bench are the answer
    const done = await git.syncBench(b.dir);
    assert.equal(done.ok, true);
    assert.equal(done.merged, true);
    assert.equal(await read(b.dir, 'doc.txt'), 'v1\nmore from B\n');
    assert.deepEqual([...(await fs.readFile(path.join(b.dir, 'logo.bin')))], [0, 9, 9, 9]);
    assert.deepEqual(await git.unresolved(b.dir), []);
    assert.equal((await git.integrate(project, 'J1', 'T2', b.dir, 'T2: merge')).ok, true);
    assert.equal(await read(s.job.integrationDir, 'doc.txt'), 'v1\nmore from B\n');
  });
});

/* ------------------------------------------------------------------ truck and ship */

describe('truck and ship', () => {
  test('ship fast-forwards the checked-out target branch', async () => {
    const s = await shop({ seed: { 'seed.txt': 's\n' } });
    const { git, project } = s;
    const start = await owner(project.path, 'rev-parse', 'main');
    assert.deepEqual(await git.truck(project, 'J1'), { headSha: start, ahead: 0, behind: 0, files: [], add: 0, del: 0 });
    const delivery = await deliver(s, 'T1', { 'a.txt': 'A\n', 'seed.txt': 's\nmore\n' });
    const load = await git.truck(project, 'J1');
    assert.equal(load.headSha, await owner(project.path, 'rev-parse', 'ws/J1/int'));
    assert.equal(load.ahead, 2);
    assert.deepEqual(load.files, [{ path: 'a.txt', add: 1, del: 0 }, { path: 'seed.txt', add: 1, del: 0 }]);
    assert.match(await git.truckDiff(project, 'J1'), /^\+A$/m);

    const noSha = await git.ship(project, 'J1'); // ship needs the exact commit the owner saw
    assert.equal(noSha.ok, false);
    assert.match(noSha.reason, /exact commit/);
    assert.equal(await owner(project.path, 'rev-parse', 'main'), start);
    assert.deepEqual(await git.ship(project, 'J1', { sha: load.headSha }), { ok: true, sha: delivery.mergeSha, left: 0 });
    assert.equal(await owner(project.path, 'rev-parse', 'main'), delivery.mergeSha);
    assert.equal(await read(project.path, 'a.txt'), 'A\n'); // the owner's checkout moved with the branch
    assert.equal(await owner(project.path, 'status', '--porcelain'), '');
    assert.equal(await owner(project.path, 'symbolic-ref', '--short', 'HEAD'), 'main');
    assert.deepEqual(await git.truck(project, 'J1'), { headSha: delivery.mergeSha, ahead: 0, behind: 0, files: [], add: 0, del: 0 });
    assert.equal(await git.truckDiff(project, 'J1'), '');
    assert.deepEqual(await git.ship(project, 'J1', { sha: delivery.mergeSha }), { ok: true, sha: delivery.mergeSha, left: 0, already: true }); // again: nothing to do

    const noJob = await git.ship(project, 'J5', { sha: delivery.mergeSha });
    assert.equal(noJob.ok, false);
    assert.match(noJob.reason, /Integration branch ws\/J5\/int not found/);
    assert.equal((await git.ship({ ...project, targetBranch: 'nope' }, 'J1', { sha: delivery.mergeSha })).ok, false);
    await assert.rejects(git.truck(project, 'J5'), /Integration branch/);
  });

  test('an adopted repo ships to the branch that was checked out', async () => {
    const s = sandbox();
    const repo = path.join(s.dir, 'their repo');
    await fs.mkdir(repo, { recursive: true });
    await owner(repo, 'init', '-q', '-b', 'feature/login');
    await put(repo, 'app.txt', 'v1\n');
    await owner(repo, 'add', '-A');
    await owner(repo, 'commit', '-q', '-m', 'first');
    const adopted = await s.git.adoptProject({ path: repo });
    const shopLike = { ...s, jobId: 'J3', project: { id: 'P2', name: 'Theirs', hubCreated: false, setupCmd: null, checkCmd: null, ...adopted } };
    shopLike.job = await s.git.startJob(shopLike.project, 'J3');
    const delivery = await deliver(shopLike, 'T1', { 'app.txt': 'v2\n' });
    assert.deepEqual(await s.git.ship(shopLike.project, 'J3', { sha: delivery.mergeSha }), { ok: true, sha: delivery.mergeSha, left: 0 });
    assert.equal(await owner(repo, 'rev-parse', 'feature/login'), delivery.mergeSha);
    assert.equal(await read(repo, 'app.txt'), 'v2\n');
    assert.equal(await owner(repo, 'status', '--porcelain'), '');
  });

  test('ship up to one delivery', async () => {
    const s = await shop({ seed: { 'seed.txt': 's\n' } });
    const { git, project } = s;
    const one = await deliver(s, 'T1', { 'a.txt': 'A\n' });
    const two = await deliver(s, 'T2', { 'b.txt': 'B\n' });

    assert.deepEqual(await git.ship(project, 'J1', { sha: one.mergeSha }), { ok: true, sha: one.mergeSha, left: 1 }); // T2 stays loaded
    assert.equal(await owner(project.path, 'rev-parse', 'main'), one.mergeSha);
    assert.equal(await read(project.path, 'a.txt'), 'A\n');
    assert.equal(await there(path.join(project.path, 'b.txt')), false);
    assert.deepEqual((await git.truck(project, 'J1')).files, [{ path: 'b.txt', add: 1, del: 0 }]);

    // a commit that is not on the integration branch, and one that does not exist
    await owner(project.path, 'checkout', '-q', '-b', 'side');
    await put(project.path, 'side.txt', 'x\n');
    await owner(project.path, 'add', '-A');
    await owner(project.path, 'commit', '-q', '-m', 'side work');
    const stray = await owner(project.path, 'rev-parse', 'HEAD');
    await owner(project.path, 'checkout', '-q', 'main');
    const refused = await git.ship(project, 'J1', { sha: stray });
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /not on the integration branch/);
    const unknown = await git.ship(project, 'J1', { sha: 'deadbeef' });
    assert.equal(unknown.ok, false);
    assert.match(unknown.reason, /Unknown commit/);
    assert.equal(await owner(project.path, 'rev-parse', 'main'), one.mergeSha);

    // a bench commit is in the integration branch, but not on its main line: never shipped on its own
    const benchCommit = (await parentsOf(project.path, two.mergeSha))[1];
    const side = await git.ship(project, 'J1', { sha: benchCommit });
    assert.equal(side.ok, false);
    assert.match(side.reason, /not on the integration branch/);
    assert.equal(await owner(project.path, 'rev-parse', 'main'), one.mergeSha);

    assert.deepEqual(await git.ship(project, 'J1', { sha: two.mergeSha }), { ok: true, sha: two.mergeSha, left: 0 });
    assert.equal(await owner(project.path, 'rev-parse', 'main'), two.mergeSha);
    assert.equal(await read(project.path, 'b.txt'), 'B\n');
    // an older delivery is already on the target: nothing moves back
    assert.deepEqual(await git.ship(project, 'J1', { sha: one.mergeSha }), { ok: true, sha: one.mergeSha, left: 1, already: true });
    assert.equal(await owner(project.path, 'rev-parse', 'main'), two.mergeSha);
  });

  test('ship is refused when the target branch moved', async () => {
    const s = await shop({ seed: { 'seed.txt': 's\n' } });
    const { git, project } = s;
    await deliver(s, 'T1', { 'a.txt': 'A\n' });
    await put(project.path, 'owner.txt', 'mine\n');
    await owner(project.path, 'add', '-A');
    await owner(project.path, 'commit', '-q', '-m', 'owner commit');
    const mainSha = await owner(project.path, 'rev-parse', 'main');

    const refused = await git.ship(project, 'J1', await atHead(project));
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /moved/);
    assert.match(refused.reason, /1 commit/);
    assert.equal(await owner(project.path, 'rev-parse', 'main'), mainSha);
    assert.equal(await there(path.join(project.path, 'a.txt')), false);
    assert.equal(await owner(project.path, 'status', '--porcelain'), '');
    const load = await git.truck(project, 'J1');
    assert.equal(load.behind, 1);
    assert.deepEqual(load.files, [{ path: 'a.txt', add: 1, del: 0 }]); // the owner's commit is not shown as undone
  });

  // Contract change (section 9): a dirty canonical checkout stops the ship, also when the change is in another file.
  test('ship with a dirty canonical tree', async () => {
    const s = await shop({ seed: { 'app.txt': 'v1\n', 'other.txt': 'o\n' } });
    const { git, project } = s;
    const delivery = await deliver(s, 'T1', { 'app.txt': 'v2\n', 'fresh.txt': 'f\n' });
    const before = await owner(project.path, 'rev-parse', 'main');

    // an uncommitted change in a file that the truck changes
    await put(project.path, 'app.txt', 'owner edit\n');
    let result = await git.ship(project, 'J1', await atHead(project));
    assert.equal(result.ok, false);
    assert.match(result.reason, /local changes/i);
    assert.match(result.reason, /app\.txt/);
    assert.doesNotMatch(result.reason, /^hint:/m);
    assert.equal(await owner(project.path, 'rev-parse', 'main'), before);
    assert.equal(await read(project.path, 'app.txt'), 'owner edit\n');
    assert.equal(await there(path.join(project.path, 'fresh.txt')), false);

    // an untracked file in the way
    await owner(project.path, 'checkout', '-q', '--', 'app.txt');
    await put(project.path, 'fresh.txt', 'mine\n');
    result = await git.ship(project, 'J1', await atHead(project));
    assert.equal(result.ok, false);
    assert.match(result.reason, /fresh\.txt/);
    assert.equal(await owner(project.path, 'rev-parse', 'main'), before);
    assert.equal(await read(project.path, 'fresh.txt'), 'mine\n');
    await fs.rm(path.join(project.path, 'fresh.txt'));

    // a change somewhere else stops it too, and it is not touched
    await put(project.path, 'other.txt', 'owner note\n');
    result = await git.ship(project, 'J1', await atHead(project));
    assert.equal(result.ok, false);
    assert.match(result.reason, /local changes: other\.txt/);
    assert.equal(await owner(project.path, 'rev-parse', 'main'), before);
    assert.equal(await read(project.path, 'other.txt'), 'owner note\n');
    // a staged change counts as well
    await owner(project.path, 'add', 'other.txt');
    assert.equal((await git.ship(project, 'J1', await atHead(project))).ok, false);
    await owner(project.path, 'reset', '-q', '--hard');
    // an untracked file that is not in the way is no obstacle, and it survives
    await put(project.path, 'notes.txt', 'mine\n');
    assert.deepEqual(await git.ship(project, 'J1', await atHead(project)), { ok: true, sha: delivery.mergeSha, left: 0 });
    assert.equal(await read(project.path, 'notes.txt'), 'mine\n');
    assert.equal(await read(project.path, 'app.txt'), 'v2\n');
    assert.equal(await owner(project.path, 'status', '--porcelain'), '?? notes.txt');
  });

  test('ship moves only the branch when the target is not checked out', async () => {
    const s = await shop({ seed: { 'seed.txt': 's\n' } });
    const { git, project } = s;
    const one = await deliver(s, 'T1', { 'a.txt': 'A\n' });
    await owner(project.path, 'checkout', '-q', '-b', 'owner-work');
    await put(project.path, 'wip.txt', 'wip\n');
    assert.deepEqual(await git.ship(project, 'J1', await atHead(project)), { ok: true, sha: one.mergeSha, left: 0 });
    assert.equal(await owner(project.path, 'rev-parse', 'main'), one.mergeSha);
    assert.equal(await owner(project.path, 'symbolic-ref', '--short', 'HEAD'), 'owner-work');
    assert.equal(await there(path.join(project.path, 'a.txt')), false); // the owner's checkout is not touched
    assert.equal(await owner(project.path, 'status', '--porcelain'), '?? wip.txt');

    // the target is checked out in another worktree of the owner: it moves there, files included
    const elsewhere = path.join(s.dir, 'main-elsewhere');
    await owner(project.path, 'worktree', 'add', '-q', elsewhere, 'main');
    const two = await deliver(s, 'T2', { 'b.txt': 'B\n' });
    assert.deepEqual(await git.ship(project, 'J1', await atHead(project)), { ok: true, sha: two.mergeSha, left: 0 });
    assert.equal(await owner(project.path, 'rev-parse', 'main'), two.mergeSha);
    assert.equal(await read(elsewhere, 'b.txt'), 'B\n');
    assert.equal(await owner(elsewhere, 'status', '--porcelain'), '');
    assert.equal(await there(path.join(project.path, 'b.txt')), false);
  });
});

/* ------------------------------------------------------------------ checks */

describe('runCheck', () => {
  test('no command is a pass', async () => {
    const { git, dir } = sandbox();
    for (const cmd of [null, undefined, '', '   \n']) {
      assert.deepEqual(await git.runCheck(dir, cmd, {}), { ok: true, code: 0, tail: '' });
    }
  });

  test('runs in the folder, combines output and reports the exit code', async () => {
    const s = await shop();
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    assert.deepEqual(await s.git.runCheck(bench.dir, 'pwd', { timeoutMs: 10_000 }), { ok: true, code: 0, tail: `${bench.dir}\n` });
    const failed = await s.git.runCheck(bench.dir, 'echo to-stdout; echo to-stderr 1>&2; exit 3');
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 3);
    assert.match(failed.tail, /to-stdout/);
    assert.match(failed.tail, /to-stderr/);
    assert.deepEqual(await s.git.runCheck(bench.dir, 'cat'), { ok: true, code: 0, tail: '' }); // stdin is closed
    const killed = await s.git.runCheck(bench.dir, 'kill -TERM $$');
    assert.equal(killed.ok, false);
    assert.equal(killed.code, 128 + os.constants.signals.SIGTERM);
    const nowhere = await s.git.runCheck(path.join(s.dir, 'no-such-folder'), 'echo hi');
    assert.equal(nowhere.ok, false);
    assert.match(nowhere.tail, /could not start/);
    const canary = path.join(s.dir, 'must-not-exist.txt');
    for (const none of [undefined, null, '']) {
      const refused = await s.git.runCheck(none, `touch '${canary}'`); // never runs in the hub's own folder
      assert.equal(refused.ok, false);
      assert.match(refused.tail, /no folder given/);
    }
    assert.equal(await there(canary), false);
  });

  test('tail is the last 4000 characters', async () => {
    const { git, dir } = sandbox();
    await fs.mkdir(dir, { recursive: true });
    const long = await git.runCheck(dir, 'i=0; while [ $i -lt 3000 ]; do echo "line $i ünï"; i=$((i+1)); done; exit 1');
    assert.equal(long.code, 1);
    assert.equal(long.tail.length, 4000);
    assert.ok(long.tail.endsWith('line 2998 ünï\nline 2999 ünï\n'));
    assert.doesNotMatch(long.tail, /�/);
    const short = await git.runCheck(dir, 'printf abc');
    assert.equal(short.tail, 'abc');
    for (const timeoutMs of [null, undefined, NaN, 0, -5, 'soon', Infinity]) { // a broken timeout value falls back to the default
      assert.deepEqual(await git.runCheck(dir, 'sleep 0.05; echo ok', { timeoutMs }), { ok: true, code: 0, tail: 'ok\n' }, String(timeoutMs));
    }
  });

  // Contract change (A13): the command environment is an allow list, so SAFE_FLAG is gone too.
  test('the command sees no API keys and no tokens', async () => {
    const { git, dir } = sandbox();
    await fs.mkdir(dir, { recursive: true });
    const probe = (plain, key, token) => 'echo "plain=${' + plain + ':-none} key=${' + key + ':-none} token=${' + token + ':-none}"; env | grep -c -E "_(API_KEY|TOKEN)=" || true';
    const result = await git.runCheck(dir, probe('SAFE_FLAG', 'DEMO_API_KEY', 'DEMO_TOKEN'));
    assert.deepEqual(result, { ok: true, code: 0, tail: 'plain=none key=none token=none\n0\n' });
    // with no env given, process.env is read at call time, with the same rule
    process.env.WS_GITOPS_TEST_API_KEY = 'sk-from-process';
    process.env.WS_GITOPS_TEST_TOKEN = 'token-from-process';
    process.env.WS_GITOPS_TEST_PLAIN = 'plain-from-process';
    try {
      const plain = await createGit({ paths: {} }).runCheck(dir, probe('WS_GITOPS_TEST_PLAIN', 'WS_GITOPS_TEST_API_KEY', 'WS_GITOPS_TEST_TOKEN') + '; echo "home=${HOME:+set}"');
      assert.equal(plain.tail, 'plain=none key=none token=none\n0\nhome=set\n');
    } finally {
      delete process.env.WS_GITOPS_TEST_API_KEY;
      delete process.env.WS_GITOPS_TEST_TOKEN;
      delete process.env.WS_GITOPS_TEST_PLAIN;
    }
  });

  test('a timeout kills the whole process group', async () => {
    const { git, dir } = sandbox();
    await fs.mkdir(dir, { recursive: true });
    const started = Date.now();
    const result = await git.runCheck(dir, 'sleep 300 & echo $! > pids; sh -c "sleep 300 & echo \\$! >> pids; wait" & echo $! >> pids; echo started; wait', { timeoutMs: 2000 });
    assert.ok(Date.now() - started < 15_000, 'returned soon after the timeout');
    assert.deepEqual(Object.keys(result), ['ok', 'code', 'tail']);
    assert.equal(result.ok, false);
    assert.equal(result.code, 124);
    assert.match(result.tail, /started/);
    assert.match(result.tail, /stopped: no result after 2 s/);
    const pids = (await read(dir, 'pids')).trim().split('\n').map(Number);
    assert.equal(pids.length, 3); // a background child, a nested shell, and that shell's child
    for (const pid of pids) assert.equal(await gone(pid), true, `process ${pid} is gone`);
  });

  test('children left behind by a finished command are stopped too', async () => {
    const { git, dir } = sandbox();
    await fs.mkdir(dir, { recursive: true });
    const started = Date.now();
    const result = await git.runCheck(dir, 'sleep 300 & echo $! > pid; echo done', { timeoutMs: 60_000 });
    assert.ok(Date.now() - started < 15_000);
    assert.deepEqual(result, { ok: true, code: 0, tail: 'done\n' });
    assert.equal(await gone(Number((await read(dir, 'pid')).trim())), true);
  });

  test('shutdown stops running checks', async () => {
    const { git, dir } = sandbox();
    await fs.mkdir(dir, { recursive: true });
    const started = Date.now();
    const pending = git.runCheck(dir, 'echo $$ > pid; sleep 300', { timeoutMs: 60_000 });
    while (!(await there(path.join(dir, 'pid')))) await sleep(20);
    git.shutdown();
    const result = await pending;
    assert.ok(Date.now() - started < 15_000);
    assert.equal(result.ok, false);
    assert.equal(result.code, 128 + os.constants.signals.SIGKILL);
    git.shutdown(); // nothing left: no effect
  });
});

/* ------------------------------------------------------------------ cleanup */

describe('cleanup', () => {
  test('removeBench deletes benches and nothing else', async () => {
    const s = await shop({ seed: { 'seed.txt': 's\n' } });
    const { git, project, job, paths } = s;
    const bench = await git.createBench(project, 'J1', 'T1', {});
    await put(bench.dir, 'work.txt', 'w\n');
    await git.removeBench(bench.dir);
    assert.equal(await there(bench.dir), false);
    await git.removeBench(bench.dir); // already gone: fine
    await deliver(s, 'T5', { 'later.txt': 'l\n' });
    const fresh = await git.createBench(project, 'J1', 'T1', {}); // a removed bench starts again from the current integration head
    assert.equal(fresh.baseSha, await owner(project.path, 'rev-parse', 'ws/J1/int'));
    assert.equal(await there(path.join(fresh.dir, 'work.txt')), false);
    await git.removeBench(fresh.dir);

    const elsewhere = path.join(s.dir, 'elsewhere');
    await put(elsewhere, 'keep.txt', 'keep\n');
    for (const bad of [project.path, job.integrationDir, paths.work, path.join(paths.work, 'J1'), path.join(paths.work, 'J1', 'T2', 'sub'), elsewhere, s.dir]) {
      await assert.rejects(git.removeBench(bad), /Refusing to remove/, String(bad));
    }
    assert.equal(await read(elsewhere, 'keep.txt'), 'keep\n');
    assert.equal(await read(project.path, 'seed.txt'), 's\n');
    assert.equal(await read(job.integrationDir, 'seed.txt'), 's\n');

    // the same bench named through a link is accepted
    const second = await git.createBench(project, 'J1', 'T2', {});
    await fs.symlink(paths.work, path.join(s.dir, 'work-link'));
    await git.removeBench(path.join(s.dir, 'work-link', 'J1', 'T2'));
    assert.equal(await there(second.dir), false);
    assert.equal(await there(job.integrationDir), true);
  });

  // Contract change (A29): task refs live under refs/workshop/<job>/ and always go; the integration branch goes unless keepInt.
  test('removeJobWork removes folders, task refs and the integration branch; keepInt keeps unshipped work', async () => {
    const s = await shop({ seed: { 'seed.txt': 's\n' } });
    const { git, project, paths } = s;
    await deliver(s, 'T1', { 'a.txt': 'A\n' });
    assert.equal((await git.ship(project, 'J1', await atHead(project))).ok, true);
    const two = await deliver(s, 'T2', { 'b.txt': 'B\n' }); // not shipped

    const cleaned = await git.removeJobWork(project, 'J1', { keepInt: true });
    assert.deepEqual(cleaned, { deleted: ['workshop/J1/T1', 'workshop/J1/T2'], kept: ['ws/J1/int'] });
    assert.equal(await owner(project.path, 'for-each-ref', 'refs/workshop/J1'), '');
    assert.equal(await there(path.join(paths.work, 'J1')), false);
    assert.equal((await owner(project.path, 'worktree', 'list')).split('\n').length, 1);
    assert.equal(await owner(project.path, 'rev-parse', 'ws/J1/int'), two.mergeSha); // the unshipped work is still reachable
    assert.equal(await owner(project.path, 'status', '--porcelain'), '');

    // the job can pick up again from the kept branch
    const job = await git.startJob(project, 'J1');
    assert.equal(await owner(job.integrationDir, 'rev-parse', 'HEAD'), two.mergeSha);

    const forced = await git.removeJobWork(project, 'J1');
    assert.deepEqual(forced, { deleted: ['ws/J1/int'], kept: [] });
    assert.equal(await owner(project.path, 'for-each-ref', '--format=%(refname)', 'refs/heads/ws/'), '');
    assert.deepEqual(await git.removeJobWork(project, 'J1'), { deleted: [], kept: [] }); // nothing left: fine

    // the project folder is gone: the work folder is still cleaned
    const t = await shop();
    await t.git.createBench(t.project, 'J1', 'T1', {});
    await fs.rm(t.project.path, { recursive: true, force: true });
    assert.deepEqual(await t.git.removeJobWork(t.project, 'J1'), { deleted: [], kept: [] });
    assert.equal(await there(path.join(t.paths.work, 'J1')), false);
  });

  // Section 12, cancel: after Ship or Discard of a cancelled job the integration branch goes; the saved task refs
  // stay until Delete (keepRefs).
  test('removeJobWork keepRefs drops the integration branch and the folders but keeps refs/workshop/<job>/*', async () => {
    const s = await shop({ seed: { 'seed.txt': 's\n' } });
    const { git, project, paths } = s;
    await deliver(s, 'T1', { 'a.txt': 'A\n' });
    const out = await git.removeJobWork(project, 'J1', { force: true, keepRefs: true });
    assert.deepEqual(out, { deleted: ['ws/J1/int'], kept: [] });
    assert.equal(await owner(project.path, 'for-each-ref', '--format=%(refname)', 'refs/workshop/J1/'), 'refs/workshop/J1/T1');
    assert.equal(await owner(project.path, 'for-each-ref', '--format=%(refname)', 'refs/heads/ws/'), '');
    assert.equal(await there(path.join(paths.work, 'J1')), false);
    assert.deepEqual(await git.removeJobWork(project, 'J1', { force: true }), { deleted: ['workshop/J1/T1'], kept: [] }, 'Delete removes them later');
  });
});

/* ------------------------------------------------------------------ the owner's git setup stays out of it */

describe('isolation', () => {
  test('git never looks for a repository above the folder it was given', async () => {
    // A bench folder without .git, inside some other repository (like WorkShop's own folder):
    // hub commands must fail there, never act on the outer repository.
    const s = sandbox();
    const outer = path.join(s.dir, 'data');
    await fs.mkdir(path.join(s.paths.work, 'J1', 'T1'), { recursive: true });
    await owner(outer, 'init', '-q', '-b', 'main');
    await put(outer, 'outer.txt', 'outer\n');
    await owner(outer, 'add', '-A');
    await owner(outer, 'commit', '-q', '-m', 'outer');
    const before = await owner(outer, 'rev-parse', 'HEAD');
    const fake = path.join(s.paths.work, 'J1', 'T1');
    await put(fake, 'stray.txt', 'stray\n');

    await assert.rejects(s.git.commitAll(fake, 'must not land in the outer repo', 'Rusty'));
    await assert.rejects(s.git.syncBench(fake));
    await assert.rejects(s.git.changedFiles(fake, 'HEAD'));
    await assert.rejects(s.git.unresolved(fake));
    assert.equal(await s.git.headSha(fake).catch(() => 'rejected'), 'rejected');
    assert.equal(await owner(outer, 'rev-parse', 'HEAD'), before);
    assert.equal(await owner(outer, 'status', '--porcelain'), '?? work/');
  });

  test('the hostile owner config really bites outside the module', async () => {
    const dir = path.join(sandbox().dir, 'plain');
    await fs.mkdir(dir, { recursive: true });
    const quiet = ['-c', 'core.hooksPath=/dev/null'];
    await run(dir, [...quiet, 'init', '-q'], agentEnv);
    assert.equal(await run(dir, ['symbolic-ref', '--short', 'HEAD'], agentEnv), 'trunk');
    assert.match(await run(dir, ['config', 'core.hooksPath'], agentEnv), /hostile\/hooks$/);
    await assert.rejects(run(dir, [...quiet, 'commit', '--allow-empty', '-m', 'x'], agentEnv)); // no identity
    const signed = { ...agentEnv, GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@x' };
    await assert.rejects(run(dir, [...quiet, 'commit', '--allow-empty', '-m', 'x'], signed), /gpg|sign/i); // forced signing, broken gpg
  });

  test('a lock file is waited for, and a stale one in a bench is removed', async () => {
    const s = await shop({ seed: { 'seed.txt': 's\n' } });
    const quick = createGit({ paths: s.paths, env: hubEnv, timeouts: { lockWaits: [20, 20, 20], staleLock: 30_000 } });
    const bench = await quick.createBench(s.project, 'J1', 'T1', {});
    const lock = path.join(bench.dir, '.git', 'index.lock');
    const old = new Date(Date.now() - 60_000);
    await put(bench.dir, 'a.txt', 'a\n');

    // a fresh lock: some git may still be at work, so the call fails and the lock stays
    await fs.writeFile(lock, '');
    await assert.rejects(quick.commitAll(bench.dir, 'T1: a', 'Rusty'), /index\.lock/);
    assert.equal(await there(lock), true);

    // an old lock was left by a git that got killed (an agent turn that timed out): removed, and the work goes on
    await fs.utimes(lock, old, old);
    assert.ok(await quick.commitAll(bench.dir, 'T1: a', 'Rusty'));
    assert.equal(await there(lock), false);

    // a lock that goes away in time is just waited for
    await put(bench.dir, 'b.txt', 'b\n');
    await fs.writeFile(lock, '');
    setTimeout(() => fs.rm(lock, { force: true }).catch(() => {}), 30);
    assert.ok(await quick.commitAll(bench.dir, 'T1: b', 'Rusty'));
    assert.equal((await quick.syncBench(bench.dir)).ok, true);
    assert.equal((await quick.integrate(s.project, 'J1', 'T1', bench.dir, 'T1: merge')).ok, true);

    // a lock in the owner's repository is never removed, however old
    const ownerLock = path.join(s.project.path, '.git', 'index.lock');
    await fs.writeFile(ownerLock, '');
    await fs.utimes(ownerLock, old, old);
    const blocked = await quick.ship(s.project, 'J1', await atHead(s.project));
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason, /index\.lock/);
    assert.equal(await there(ownerLock), true);
    await fs.rm(ownerLock);
    assert.equal((await quick.ship(s.project, 'J1', await atHead(s.project))).ok, true);
    assert.equal(await read(s.project.path, 'b.txt'), 'b\n');
  });

  test('every git call has a timeout', async () => {
    const s = await shop();
    const hasty = createGit({ paths: s.paths, env: hubEnv, timeouts: { short: 1, long: 1 } });
    await assert.rejects(hasty.headSha(s.project.path), /git rev-parse was stopped/);
    await assert.rejects(hasty.truck(s.project, 'J1'), /was stopped/);
    assert.equal(await s.git.headSha(s.project.path), await owner(s.project.path, 'rev-parse', 'HEAD'));
  });

  test('no hook of the owner ever ran', async () => {
    assert.equal(await there(hookLog), false, await fs.readFile(hookLog, 'utf8').catch(() => ''));
  });
});
