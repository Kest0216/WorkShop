// Lab setup actions, shared by the first-run strip (app.js) and the Keys panel (ctx.labs).
// The hub installs nothing and never starts a sign-in by itself: the owner does each step, the UI guides.
// Lab state comes only from ProviderStatus.usable and .reason (contract sections 10 and 13b).
//
//   createLabs({ api, store, toasts, modals, openPanel }) -> labs
//   labs.step(p)                 -> 'install' | 'mode' | 'key' | 'signin' | 'test' | 'cooling' | 'ready' | 'other'   the next setup step of a lab
//   labs.install(p)              dialog with installHint and a copy button
//   labs.chooseMode(p, mode, b?) dialog with the policy note of that mode; on yes: PUT /api/providers/:id/mode
//   labs.login(p, b?)            POST .../login (Terminal opens with the sign-in command), then the steps as a checklist.
//                                While a sign-in of this window is still open it starts no second one: it shows the steps again.
//   labs.steps(p)                the steps again, with no new POST .../login ("Show the steps again")
//   labs.signinOpen(p)           -> the time a sign-in was started in this window, while the lab is not signed in yet; else 0
//   labs.openNote(p)             -> one line that says so and what to do next, for a lab card or a strip row; else ''
//   labs.signedIn(p, b?)         "I signed in" on a lab card or a strip row: POST .../check, then one note that says what the hub found
//   labs.check(p, b?)            POST .../check; resolves to the new status of the lab, or null
//   labs.recheck(b?)             POST /api/providers/detect (the cheap look at every lab), then one note
//   labs.recheckLab(p, b?)       "Re-check" on one lab card: POST .../check for an installed lab with a sign-in mode, else the cheap look
//   labs.test(p, b?)             POST .../selftest, with a result dialog
//   labs.results                 Map lab id -> the last self-test answer of this window ({ ok, core, advisory, steps, loaded, logTail })
//   labs.billing(mode)           one plain sentence about who pays
//
// Why "I signed in" and not only "Re-check": the cheap look (/detect) never runs the Google CLI, so it cannot see a sign-in
// that the owner just finished in Terminal. Only POST .../check verifies it. And every POST .../login opens a new Terminal
// sign-in with a new code. So the check must be in reach without a second login.

import { h, showMarks } from './dom.js';
import * as ui from './widgets.js';
import { sel } from './selectors.js';

const MODE_LABEL = {
  apikey: 'Use an API key',
  subscription: 'Continue with ChatGPT (subscription)',
};
const BILLING = {
  apikey: 'Billing: you pay per token on your API account, bounded by your WorkShop job budget.',
  subscription: 'Billing: routes eligible OpenAI Officer & Gate turns through your existing ChatGPT Plus/Pro/Team subscription ($0 separate API key spend).',
};
// The steps of a sign-in in the words of this window: every button they name exists here.
// (The steps that the hub sends are the same for every lab and name a "Re-check" button. They show for a lab this window does not know.)
const SIGNIN_STEPS = {
  openai: [
    'Your browser opens to OpenAI ("Continue with ChatGPT" OAuth + PKCE portal).',
    'Sign in with your OpenAI account and authorize ChatGPT plan usage for WorkShop.',
    'Wait for the browser confirmation tab ("Signed in with ChatGPT!"), then press "I signed in".',
  ],
  claude: [
    'A Terminal window opens and runs: claude auth login',
    'Your browser opens. Sign in with your Claude account.',
    'Wait until Terminal says that the login worked.',
    'Come back here and press "I signed in".',
  ],
  gemini: [
    'A Terminal window opens and runs: agy',
    'Your browser opens. Sign in with your Google account.',
    'When the browser shows a sign-in code: copy it, paste it into that Terminal window, and press Return.',
    'Answer the first-run questions in Terminal. Then type /exit.',
    'Come back here and press "I signed in".',
  ],
};
const SIGNIN_NOTES = {
  gemini: 'The code belongs in that Terminal window only. Do not paste it into WorkShop, a chat or a web page. A code works one time. Each new sign-in makes a new code, and the code of an older sign-in stops working.',
};
// One more sentence for a lab whose sign-in hands out a code, where the UI says that a sign-in is open.
const OPEN_HINTS = { gemini: 'Paste the code from your browser into that Terminal window only.' };
const AGAIN_HINTS = { gemini: 'Each new sign-in makes a new code, and the old code stops working.' };
const OTHER_STEPS = ['A Terminal window opens with the sign-in command of the lab.', 'Finish the sign-in there.', 'Come back here and press "I signed in".'];
const enc = encodeURIComponent;
/** Text that ends like a sentence. */
const sentence = (s) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return !t || /[.!?:]$/.test(t) ? t : t + '.'; };

/** The command inside an install hint ("... in Terminal: curl ... | bash"), or null. */
function commandIn(text) {
  const m = /(?:Terminal|shell|run):\s*(.+)$/i.exec(String(text || ''));
  return m ? m[1].trim() : null;
}

export function createLabs({ api, store, toasts, modals, openPanel }) {
  const results = new Map();
  const started = new Map(); // lab id -> when this window opened a Terminal sign-in for it (cleared when the hub sees the sign-in)
  const run = (button, fn) => (button && button.isConnected ? ui.busy(button, fn) : fn());
  const find = (id) => store.providers.find((x) => x.id === id) || null;
  const say = (text, level = 'info', opts = {}) => toasts.show({ ...opts, level, text });
  const nameOf = (p) => String(p.label || p.id);

  /** Fetch the lab list again and put it in the store. Events bring it too; this makes the answer show at once. */
  async function reload() {
    const list = await api.get('/api/providers', { quiet: true });
    if (Array.isArray(list)) { store.set('providers', list); prune(); }
    store.refreshInbox();
    return list;
  }
  /** A lab that the hub sees signed in (or that is gone) has no open sign-in any more. */
  function prune() { for (const id of [...started.keys()]) { const p = find(id); if (!p || p.auth === 'ok') setStarted(id, 0); } }

  const step = (p) => sel.labStep(p, store.settings);
  const STATE_WORD = { install: 'not installed', mode: 'needs auth mode', key: 'needs its API key', signin: 'ready to sign in', oss: 'needs OSS endpoint or Stand-in', test: 'needs the self-test', cooling: 'cooling down', ready: 'ready', other: 'not ready' };
  /** "Claude Code ready, Antigravity CLI not installed" */
  const summary = (list) => list.filter((p) => p.id !== 'mock').map((p) => `${nameOf(p)} ${STATE_WORD[step(p)]}`).join(', ');

  /** When this window started a Terminal sign-in for the lab that the hub has not seen finished yet; else 0. */
  function signinOpen(p) {
    const now = (p && find(p.id)) || p;
    if (!now || !started.has(now.id)) return 0;
    return now.installed && now.mode === 'subscription' && now.auth !== 'ok' ? started.get(now.id) : 0;
  }
  /** One line for a lab card or a strip row while a sign-in of this window is open in Terminal; else ''. */
  function openNote(p) {
    const since = signinOpen(p);
    return since ? `A sign-in is open in Terminal since ${ui.fmt.time(since)}. Finish it there. ${OPEN_HINTS[p.id] ? OPEN_HINTS[p.id] + ' ' : ''}Then press "I signed in".` : '';
  }
  function setStarted(id, ts) {
    if (ts) started.set(id, ts); else if (!started.delete(id)) return;
    store.touch('providers'); // the lab card and the strip row show other buttons now
  }

  /** quiet: the caller says the result itself (the install dialog). */
  function recheck(button, { quiet = false } = {}) {
    return run(button, async () => {
      const before = summary(store.providers);
      const list = await api.post('/api/providers/detect');
      if (!Array.isArray(list)) return false;
      store.set('providers', list);
      prune();
      store.refreshInbox();
      const after = summary(store.providers);
      if (!quiet) say(after ? `${after === before ? 'Looked again. Nothing changed' : 'Looked again'}: ${after}.` : 'Looked again. The hub lists no lab.', 'info', { key: 'recheck' });
      return true;
    });
  }

  function install(p) {
    const hint = p.installHint || {};
    const text = String(hint.text || `Install ${nameOf(p)} with the installer of the lab.`);
    const cmd = commandIn(text);
    const note = h('p.dim', { role: 'status' });
    const dlg = modals.open({
      title: `Install ${nameOf(p)}`,
      body: h('div.stack',
        h('p', 'The hub installs nothing on your Mac. Do this step yourself, then press Re-check.'),
        h('p.pre', cmd ? text.slice(0, text.length - cmd.length).trim() : text),
        cmd ? h('pre.term.lab-cmd', { tabIndex: 0 }, cmd) : null,
        h('div.row', ui.copyButton(cmd || text, cmd ? 'Copy the command' : 'Copy'), hint.url ? ui.extLink('Open the install page', hint.url) : null),
        note),
      buttons: [
        { label: 'Close', value: false },
        { label: 'Re-check', primary: true, run: async () => {
          note.textContent = 'Looking for the program...';
          await recheck(null, { quiet: true });
          const now = find(p.id);
          if (now && now.installed) { say(`${nameOf(now)} ${now.version || ''} is installed.`.replace('  ', ' ')); return true; }
          note.textContent = showMarks(`${nameOf(p)} is still not found. Finish the install, then press Re-check again.`);
          return false;
        } },
      ],
    });
    return dlg;
  }

  function chooseMode(p, mode, button) {
    if (!Object.hasOwn(MODE_LABEL, mode)) return Promise.resolve(false);
    const note = (p.policyNote && p.policyNote[mode]) || {};
    const lines = Array.isArray(note.lines) ? note.lines : [];
    return new Promise((resolve) => {
      modals.open({
        title: `${nameOf(p)}: ${MODE_LABEL[mode].toLowerCase()}`,
        body: h('div.stack',
          h('p.strong', mode === 'subscription'
            ? 'Authenticate directly through OpenAI\'s official "Continue with ChatGPT" portal (OAuth 2.0 + PKCE).'
            : 'Agents use the API key that you save in Settings -> API Keys Vault.'),
          lines.length ? h('ul.lab-policy', lines.map((l) => h('li', String(l)))) : h('p.dim', 'The hub sent no policy note for this mode.'),
          h('p', BILLING[mode]),
          note.url ? h('p', ui.extLink('Read the terms of the lab', note.url)) : null,
          h('p.dim', mode === 'subscription'
            ? 'Anthropic and Google forbid third-party OAuth subscription mirroring; OpenAI officially supports Sign in with ChatGPT for local & open-source tools.'
            : 'Pressing the button records that you read this note.')),
        buttons: [
          { label: 'Cancel', value: false },
          { label: MODE_LABEL[mode], primary: true, run: async () => {
            const res = await api.put(`/api/providers/${enc(p.id)}/mode`, { mode });
            if (res === undefined) return false;
            await reload();
            return true;
          } },
        ],
        onClose: (ok) => {
          resolve(ok === true);
          if (ok !== true) return;
          const now = find(p.id) || p;
          const next = step(now);
          if (next === 'key') say(`${nameOf(now)} uses an API key now. Save the key to finish.`, 'info', { action: { label: 'Open Keys', run: () => openPanel('settings', { tab: 'keys', lab: now.id }) } });
          else if (next === 'signin') login(now, button);
          else if (next === 'test') say(`${nameOf(now)}: one step is left. Run the self-test.`, 'info', { action: { label: 'Test', run: () => test(now) } });
          else say(`${nameOf(now)}: ${MODE_LABEL[mode].toLowerCase()}.`);
        },
      });
    });
  }

  /** POST .../check: the hub verifies the sign-in of the lab. Resolves to the new status, or null when the call failed. */
  function check(p, button) {
    return run(button, async () => {
      const res = await api.post(`/api/providers/${enc(p.id)}/check`, {}, { timeoutMs: 60000 });
      if (res === undefined) return null;
      const list = await reload(); // (a lab that is signed in now has no open sign-in any more: see prune)
      if (!Array.isArray(list) && res && res.id === p.id) { store.set('providers', store.providers.map((x) => (x.id === res.id ? res : x))); prune(); } // the list did not come: the answer itself is the new status
      return find(p.id) || res;
    });
  }

  /** The note after a sign-in that the hub confirmed. */
  function saySignedIn(now) {
    toasts.dismissWhere((t) => t.key === 'signin-no-' + now.id); // an older "not signed in" note is not true any more
    if (step(now) === 'test') say(`${nameOf(now)} is signed in. One step is left: run the self-test.`, 'info', { key: 'signin-ok-' + now.id, action: { label: 'Test', run: () => test(now) } });
    else say(`${nameOf(now)} is signed in.`, 'info', { key: 'signin-ok-' + now.id });
  }
  /** What the owner does next when the hub sees no sign-in. */
  const notYet = (now) => (signinOpen(now) ? 'Finish the steps in Terminal, then press "I signed in" again.' : 'Press Sign in to start.');

  /** "I signed in" on a lab card or a strip row: the hub verifies the sign-in, and one note says what it found. */
  function signedIn(p, button) {
    return run(button, async () => {
      const now = await check(p);
      if (!now) return false;
      if (now.auth === 'ok') { saySignedIn(now); return true; }
      say(`${sentence(now.reason || `${nameOf(now)} is not signed in.`)} ${notYet(now)}`, 'warn', { key: 'signin-no-' + now.id, action: signinOpen(now) ? { label: 'Show the steps', run: () => steps(now) } : null });
      return false;
    });
  }

  /**
   * "Re-check" on one lab card. For an installed lab with a sign-in mode the hub verifies that lab (POST .../check):
   * the cheap look (/detect) never runs the Google CLI, so it sees no new sign-in and no version. Else: the cheap look.
   */
  function recheckLab(p, button) {
    if (!p || !p.installed || !p.mode) return recheck(button);
    return run(button, async () => {
      const was = find(p.id) || p;
      const before = summary([was]);
      const now = await check(p);
      if (!now) return false;
      if (was.auth !== 'ok' && now.auth === 'ok') { saySignedIn(now); return true; } // the check found a sign-in: say that first
      const same = summary([now]) === before;
      const next = step(now);
      const action = next === 'test' ? { label: 'Test', run: () => test(now) } : signinOpen(now) ? { label: 'Show the steps', run: () => steps(now) } : null;
      say(`${same ? 'Looked again. Nothing changed' : 'Looked again'}: ${now.usable ? `${nameOf(now)} is ready.` : sentence(now.reason || `${nameOf(now)} is ${STATE_WORD[next]}`)}`, 'info', { key: 'recheck', action });
      return true;
    });
  }

  /**
   * The steps of the sign-in as a checklist, with "I signed in". It starts nothing: the sign-in itself runs in Terminal.
   *   fresh     Terminal was opened just now (POST .../login). Else: "the steps again", with a way to start a new sign-in.
   *   hubSteps  the steps of the hub's answer, for a lab this window has no steps of its own for
   */
  function steps(p, { fresh = false, hubSteps = null } = {}) {
    const list = SIGNIN_STEPS[p.id] || (Array.isArray(hubSteps) && hubSteps.length ? hubSteps.map(String) : OTHER_STEPS);
    const since = signinOpen(p);
    const note = h('p.field-error', { role: 'alert' });
    modals.open({
      title: `Sign in to ${nameOf(p)}`,
      body: h('div.stack',
        fresh ? h('p', p.id === 'openai'
          ? 'Your browser opened to OpenAI ("Continue with ChatGPT"). Sign in there, then click "I signed in".'
          : 'You sign in yourself. The hub only opened Terminal with the command of the lab.')
          : h('div.callout.you', h('div.callout-title', since ? `A sign-in is open in Terminal since ${ui.fmt.time(since)}` : 'The sign-in runs in Terminal'),
            h('p', { style: { margin: 0 } }, `Finish it in that Terminal window. Do not start a second one.${AGAIN_HINTS[p.id] ? ' ' + AGAIN_HINTS[p.id] : ''}`)),
        h('div.lab-steps', list.map((s, i) => ui.checkbox(`${i + 1}. ${s}`, false))),
        SIGNIN_NOTES[p.id] ? h('p.lab-code', SIGNIN_NOTES[p.id]) : null,
        p.loginCmd ? h('p.dim', 'Command: ', h('span.code', String(p.loginCmd))) : null,
        h('p.dim', 'You can close this note. The button "I signed in" stays on the lab card in the Keys panel.'),
        note),
      buttons: [
        { label: 'Close', value: false },
        fresh ? null : { label: 'Start a new sign-in', value: 'again' },
        { label: 'I signed in', primary: true, run: async () => {
          note.textContent = '';
          const now = await check(p);
          if (!now) return false;
          if (now.auth === 'ok') { saySignedIn(now); return true; }
          note.textContent = showMarks(`${sentence(now.reason || 'The hub still sees no sign-in.')} Finish the steps in Terminal, then press "I signed in" again.`);
          return false;
        } },
      ].filter(Boolean),
      // "Start a new sign-in": the owner closed the Terminal window, or the sign-in ran out. Only then a second login starts.
      onClose: (v) => { if (v === 'again') login(find(p.id) || p, null, { fresh: true }); },
    });
  }

  /**
   * "Sign in": the hub opens Terminal with the sign-in command of the lab, and the steps show.
   * While a sign-in that this window started is still open, a second press starts no new one (a new sign-in makes a new
   * code and the old code stops working): it shows the steps again. fresh: start a new one all the same.
   */
  function login(p, button, { fresh = false } = {}) {
    if (!fresh && signinOpen(p)) { steps(find(p.id) || p); return Promise.resolve(true); }
    return run(button, async () => {
      const res = await api.post(`/api/providers/${enc(p.id)}/login`);
      if (res === undefined) return false;
      setStarted(p.id, Date.now());
      steps(find(p.id) || p, { fresh: true, hubSteps: res.steps });
      return true;
    });
  }

  const checkList = (title, list) => (Array.isArray(list) && list.length ? [
    h('div.caps', title),
    h('ul.list.lab-checks', list.map((c) => h('li.li', ui.chip(c.ok ? 'ok' : 'fail', c.ok ? 'green' : 'red'), h('span', h('span.strong', String(c.name ?? '')), c.detail ? h('div.dim', String(c.detail)) : null)))),
  ] : null);

  /** The body of a self-test result: verdict, core and advisory checks, steps, loaded servers, log tail. */
  function resultView(p, res) {
    const extra = (Array.isArray(res.loaded) ? res.loaded : []).filter((x) => x !== 'shop');
    return h('div.stack',
      h('div', { class: ['callout', res.ok ? null : 'bad'] }, h('div.callout-title', ui.chip(res.ok ? 'passed' : 'failed', res.ok ? 'green' : 'red'), res.ok ? 'Agents of this lab stay inside the sandbox' : 'A core check failed'),
        h('p', { style: { margin: 0 } }, res.ok ? `${nameOf(p)} can work in safety mode "sandboxed".` : 'Agents of this lab do not start in safety mode "sandboxed" until every core check passes.')),
      checkList('Core checks (all must pass)', res.core),
      checkList('Advisory checks', res.advisory),
      checkList('Steps', res.steps),
      extra.length ? h('div.callout.bad', h('div.callout-title', 'The worker loaded more than the hub tools'),
        h('p', { style: { margin: 0 } }, 'Besides "shop" it loaded: ', extra.map((x, i) => [i ? ', ' : '', h('span.code', String(x))]), '. Remove these from the settings of the CLI if you do not want agents to use them.')) : null,
      res.logTail ? ui.fold('Log of the test turn', () => h('pre.term.lab-log', String(res.logTail))) : null);
  }

  function test(p, button) {
    return run(button, async () => {
      const body = h('div', h('p', `One tiny real turn of ${nameOf(p)}. It must call the hub and must fail to leave its sandbox.`), h('p.dim', { role: 'status' }, 'Running. This can take a minute...'));
      const dlg = modals.open({ title: `Self-test: ${nameOf(p)}`, body, wide: true, buttons: [{ label: 'Close', value: false, primary: true, tone: 'steel' }] });
      const res = await api.post(`/api/providers/${enc(p.id)}/selftest`, {}, { timeoutMs: 240000, quiet: true, throws: true }).catch((e) => ({ failed: e && e.message ? e.message : 'The self-test did not run.' }));
      if (res.failed) { body.replaceChildren(h('div.callout.bad', h('div.callout-title', 'The self-test did not run'), h('p', { style: { margin: 0 } }, String(res.failed)))); return null; }
      results.set(p.id, res);
      await reload();
      store.touch('providers');
      body.replaceChildren(resultView(p, res));
      void dlg;
      return res;
    });
  }

  // The hub can see a sign-in by itself (a Claude sign-in shows in the cheap look): then nothing is open any more.
  store.on('providers', prune);

  return { step, install, chooseMode, login, steps, signinOpen, openNote, signedIn, check, recheck, recheckLab, test, results, resultView, reload,
    billing: (mode) => BILLING[mode] || '', modeLabel: (mode) => MODE_LABEL[mode] || String(mode) };
}
