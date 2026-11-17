import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createShellEnv } from '../server/shellenv.js';

function tmp(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-shellenv-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function script(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

test('WORKSHOP_PATH wins and the login shell is not run', (t) => {
  const dir = tmp(t);
  const marker = path.join(dir, 'shell-ran');
  const shell = script(path.join(dir, 'fakeshell'), `touch "${marker}"\nprintf '__WS_PATH_START__/from/shell__WS_PATH_END__'`);
  const se = createShellEnv({ env: { HOME: dir, USER: 'u', WORKSHOP_PATH: '/custom/a:/custom/b' }, loginShell: shell });
  const parts = se.path.split(':');
  assert.deepEqual(parts.slice(0, 2), ['/custom/a', '/custom/b']);
  assert.ok(!fs.existsSync(marker), 'login shell must not run when WORKSHOP_PATH is set');
  assert.ok(!parts.includes('/from/shell'));
});

test('login shell PATH is used once, cached, and noise around it is ignored', (t) => {
  const dir = tmp(t);
  const counter = path.join(dir, 'count');
  const shell = script(path.join(dir, 'fakeshell'), `echo x >> "${counter}"\necho "motd noise"\nprintf '__WS_PATH_START__/login/one:/login/two__WS_PATH_END__'\necho trailing`);
  const se = createShellEnv({ env: { HOME: dir, USER: 'u' }, loginShell: shell });
  const first = se.path;
  assert.equal(se.path, first);
  se.base();
  se.resolve('nothing-here');
  assert.deepEqual(first.split(':').slice(0, 2), ['/login/one', '/login/two']);
  assert.equal(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 1, 'login shell runs once');
});

test('fallbacks are appended: ~/.local/bin, newest nvm node, system folders; no duplicates', (t) => {
  const dir = tmp(t);
  for (const v of ['v18.20.0', 'v20.9.1', 'v20.11.0', 'junk']) fs.mkdirSync(path.join(dir, '.nvm/versions/node', v, 'bin'), { recursive: true });
  const se = createShellEnv({ env: { HOME: dir, USER: 'u', WORKSHOP_PATH: `/usr/bin:relative/dir::/usr/bin:${dir}/.local/bin` } });
  const parts = se.path.split(':');
  assert.equal(new Set(parts).size, parts.length, 'no duplicates');
  assert.ok(!parts.includes('relative/dir'));
  assert.ok(parts.includes(path.join(dir, '.local/bin')));
  assert.ok(parts.includes(path.join(dir, '.nvm/versions/node/v20.11.0/bin')), 'newest nvm version');
  assert.ok(!parts.includes(path.join(dir, '.nvm/versions/node/v18.20.0/bin')));
  for (const d of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']) assert.ok(parts.includes(d), d);
  assert.equal(parts[0], '/usr/bin');
});

test('a broken or slow login shell never throws and still gives fallbacks', (t) => {
  const dir = tmp(t);
  const logs = [];
  const missing = createShellEnv({ env: { HOME: dir, USER: 'u' }, loginShell: path.join(dir, 'no-such-shell'), log: (l, m) => logs.push([l, m]) });
  assert.ok(missing.path.split(':').includes('/usr/bin'));
  assert.ok(logs.some(([l]) => l === 'warn'));

  const slow = script(path.join(dir, 'slowshell'), 'sleep 5\nprintf "__WS_PATH_START__/late__WS_PATH_END__"');
  const t0 = Date.now();
  const se = createShellEnv({ env: { HOME: dir, USER: 'u' }, loginShell: slow, timeoutMs: 300 });
  assert.ok(!se.path.includes('/late'));
  assert.ok(Date.now() - t0 < 3000, 'timeout is enforced');

  const thrower = createShellEnv({ env: { HOME: dir, USER: 'u', WORKSHOP_PATH: '/usr/bin' }, log: () => { throw new Error('bad logger'); } });
  assert.ok(thrower.path.length > 0);
});

test('resolve finds executables on PATH and in extra dirs, and never runs them', (t) => {
  const dir = tmp(t);
  const ran = path.join(dir, 'ran');
  script(path.join(dir, 'bin', 'tool'), `touch "${ran}"`);
  script(path.join(dir, 'extra', 'other'), `touch "${ran}"`);
  fs.writeFileSync(path.join(dir, 'bin', 'notexec'), 'x', { mode: 0o644 });
  fs.mkdirSync(path.join(dir, 'bin', 'adir'));
  const se = createShellEnv({ env: { HOME: dir, USER: 'u', WORKSHOP_PATH: path.join(dir, 'bin') } });
  assert.equal(se.resolve('tool'), path.join(dir, 'bin', 'tool'));
  assert.equal(se.resolve('other'), null);
  assert.equal(se.resolve('other', [path.join(dir, 'extra')]), path.join(dir, 'extra', 'other'));
  assert.equal(se.resolve('notexec'), null);
  assert.equal(se.resolve('adir'), null);
  assert.equal(se.resolve(path.join(dir, 'bin', 'tool')), path.join(dir, 'bin', 'tool'));
  assert.equal(se.resolve(path.join(dir, 'bin', 'missing')), null);
  for (const bad of [null, undefined, '', 42, {}, 'a\0b']) assert.equal(se.resolve(bad), null);
  assert.equal(se.resolve('tool', 'not-a-list'), path.join(dir, 'bin', 'tool'));
  assert.ok(!fs.existsSync(ran), 'resolve must not execute anything');
});

test('base() is the clean environment and holds nothing else', (t) => {
  const dir = tmp(t);
  const env = {
    HOME: dir, USER: 'owner', SHELL: '/bin/zsh', LANG: 'de_DE.UTF-8', TMPDIR: '/tmp/x/', TERM: 'xterm-256color', WORKSHOP_PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'sk-secret', GEMINI_API_KEY: 'g-secret', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', NODE_OPTIONS: '--inspect',
  };
  const se = createShellEnv({ env });
  const base = se.base();
  assert.deepEqual(Object.keys(base).sort(), ['HOME', 'LANG', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'TMPDIR', 'USER']);
  assert.equal(base.HOME, dir);
  assert.equal(base.USER, 'owner');
  assert.equal(base.LOGNAME, 'owner');
  assert.equal(base.TERM, 'dumb');
  assert.equal(base.LANG, 'de_DE.UTF-8');
  assert.equal(base.TMPDIR, '/tmp/x/');
  assert.equal(base.PATH, se.path);
  base.EXTRA = '1';
  assert.equal(se.base().EXTRA, undefined, 'a new object on every call');
  assert.ok(!JSON.stringify(se.base()).includes('secret'));
});

test('defaults fill missing variables', () => {
  const se = createShellEnv({ env: { WORKSHOP_PATH: '/usr/bin' } });
  const base = se.base();
  assert.ok(base.HOME && path.isAbsolute(base.HOME));
  assert.ok(base.USER);
  assert.equal(base.LANG, 'en_US.UTF-8');
  assert.equal(base.SHELL, '/bin/zsh');
  assert.ok(base.TMPDIR);
});
