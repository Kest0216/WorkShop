// The environment that child processes (agent CLIs, git) get.
// A Mac app started from Finder has a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), so the PATH is built
// from the launcher's WORKSHOP_PATH or the login shell, plus well-known folders.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const noop = () => {};
const MARK_A = '__WS_PATH_START__';
const MARK_B = '__WS_PATH_END__';

/** "v20.11.1" -> [20, 11, 1]; unknown names sort last. */
function versionKey(name) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(name);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [-1, -1, -1];
}

function isExecutableFile(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * A real pipe (FIFO) that is already at end-of-file, as a file descriptor for the stdin of a child process.
 *
 * Why: some CLIs look at the type of stdin. An agy without a login starts a browser sign-in when stdin is
 * /dev/null (a character device) and fails cleanly when stdin is a pipe. Node's stdio 'pipe' is a socket pair,
 * not a pipe, and 'ignore' is /dev/null. This gives the case that was seen to be safe: a pipe with no writer.
 *
 * The caller passes the descriptor as stdio[0] and closes it right after the spawn. A program that reads this
 * stdin with a plain read() gets end-of-file at once. (A Node child that reads process.stdin as a stream does
 * not see the end on macOS, so use it only for programs that do not read stdin that way.)
 *
 * @param {string} [dir] folder for the short-lived FIFO file (default: the temp folder)
 * @param {{ mkfifo?: string }} [options]
 * @returns {number|null} an open file descriptor, or null when the pipe cannot be made
 */
export function openClosedPipe(dir, { mkfifo = '/usr/bin/mkfifo' } = {}) {
  let folder = null;
  let writer = null;
  let reader = null;
  try {
    const base = typeof dir === 'string' && dir ? dir : os.tmpdir();
    fs.mkdirSync(base, { recursive: true });
    folder = fs.mkdtempSync(path.join(base, 'stdin-'));
    const fifo = path.join(folder, 'pipe');
    const made = spawnSync(mkfifo, ['-m', '600', fifo], { stdio: 'ignore', timeout: 3000, killSignal: 'SIGKILL' });
    if (made.status !== 0 || !fs.statSync(fifo).isFIFO()) return null;
    writer = fs.openSync(fifo, fs.constants.O_RDWR); // read and write: this open never waits for a peer
    reader = fs.openSync(fifo, fs.constants.O_RDONLY); // a writer exists, so this returns at once
    return reader; // the writer is closed below: the pipe is then at end-of-file
  } catch {
    if (reader !== null) {
      try { fs.closeSync(reader); } catch { /* already closed */ }
    }
    return null;
  } finally {
    if (writer !== null) {
      try { fs.closeSync(writer); } catch { /* already closed */ }
    }
    if (folder) {
      try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* a leftover empty temp folder */ }
    }
  }
}

/**
 * @param {object} [deps]
 * @param {Record<string, string|undefined>} [deps.env] the hub's own environment (default process.env)
 * @param {(level: string, msg: string, data?: object) => void} [deps.log]
 * @param {string} [deps.loginShell] shell that is asked for its PATH (default /bin/zsh; tests inject a fake)
 * @param {number} [deps.timeoutMs] time limit of the login-shell call (default 5000)
 * @returns {{ path: string, resolve(binaryName: string, extraDirs?: string[]): string|null, base(): Record<string, string> }}
 */
export function createShellEnv({ env = process.env, log = noop, loginShell = '/bin/zsh', timeoutMs = 5000 } = {}) {
  const say = (level, msg, data) => {
    try { log(level, msg, data); } catch { /* a broken logger must not break the environment */ }
  };
  let home = '';
  try { home = env.HOME || os.homedir() || ''; } catch { home = env.HOME || ''; }
  let user = env.USER || env.LOGNAME || '';
  if (!user) {
    try { user = os.userInfo().username; } catch { user = ''; }
  }
  let cachedPath = null;

  /** PATH of the login shell, or '' when it cannot be read. Runs at most once. */
  function loginShellPath() {
    try {
      const out = spawnSync(loginShell, ['-lic', `printf '${MARK_A}%s${MARK_B}' "$PATH"`], {
        env: { HOME: home, USER: user, LOGNAME: user, SHELL: loginShell, TERM: 'dumb', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
      const text = typeof out.stdout === 'string' ? out.stdout : '';
      const a = text.lastIndexOf(MARK_A);
      const b = text.indexOf(MARK_B, a);
      if (a < 0 || b < 0) {
        say('warn', 'shellenv: the login shell gave no PATH', { shell: loginShell, error: out.error?.code ?? null, status: out.status });
        return '';
      }
      return text.slice(a + MARK_A.length, b);
    } catch (err) {
      say('warn', 'shellenv: cannot ask the login shell for PATH', { shell: loginShell, error: err?.message ?? String(err) });
      return '';
    }
  }

  /** Newest ~/.nvm/versions/node/<version>/bin, or null. */
  function newestNvmBin() {
    if (!home) return null;
    try {
      const root = path.join(home, '.nvm', 'versions', 'node');
      const names = fs.readdirSync(root).filter((name) => versionKey(name)[0] >= 0);
      names.sort((x, y) => {
        const a = versionKey(x);
        const b = versionKey(y);
        return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
      });
      for (const name of names) {
        const bin = path.join(root, name, 'bin');
        try {
          if (fs.statSync(bin).isDirectory()) return bin;
        } catch { /* try the next version */ }
      }
    } catch { /* no nvm */ }
    return null;
  }

  function buildPath() {
    const first = typeof env.WORKSHOP_PATH === 'string' && env.WORKSHOP_PATH.trim() ? env.WORKSHOP_PATH : loginShellPath();
    const fallbacks = [
      home ? path.join(home, '.local', 'bin') : null,
      newestNvmBin(),
      '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    ];
    const seen = new Set();
    const parts = [];
    for (const raw of [...String(first).split(':'), ...fallbacks]) {
      if (typeof raw !== 'string') continue;
      const dir = raw.trim();
      if (!dir || !path.isAbsolute(dir) || dir.includes('\n') || seen.has(dir)) continue;
      seen.add(dir);
      parts.push(dir);
    }
    return parts.join(':');
  }

  function getPath() {
    if (cachedPath === null) {
      try {
        cachedPath = buildPath();
      } catch (err) {
        say('warn', 'shellenv: PATH build failed, using the system default', { error: err?.message ?? String(err) });
        cachedPath = '/usr/bin:/bin:/usr/sbin:/sbin';
      }
    }
    return cachedPath;
  }

  /**
   * Find an executable. A name with a slash is checked as a path. Otherwise PATH is searched, then extraDirs.
   * Only reads the file system: it never runs the binary.
   */
  function resolve(binaryName, extraDirs = []) {
    try {
      if (typeof binaryName !== 'string' || !binaryName || binaryName.includes('\0')) return null;
      if (binaryName.includes('/')) {
        const file = path.resolve(binaryName);
        return isExecutableFile(file) ? file : null;
      }
      const dirs = [...getPath().split(':'), ...(Array.isArray(extraDirs) ? extraDirs : [])];
      for (const dir of dirs) {
        if (typeof dir !== 'string' || !dir || !path.isAbsolute(dir)) continue;
        const file = path.join(dir, binaryName);
        if (isExecutableFile(file)) return file;
      }
    } catch { /* never throw */ }
    return null;
  }

  /** The clean environment for a child process. A new object on every call. */
  function base() {
    let tmp = env.TMPDIR;
    if (!tmp) {
      try { tmp = os.tmpdir(); } catch { tmp = '/tmp'; }
    }
    return {
      HOME: home,
      USER: user,
      LOGNAME: env.LOGNAME || user,
      SHELL: env.SHELL || '/bin/zsh',
      TERM: 'dumb',
      LANG: env.LANG || 'en_US.UTF-8',
      TMPDIR: tmp,
      PATH: getPath(),
    };
  }

  return {
    get path() { return getPath(); },
    resolve,
    base,
  };
}
