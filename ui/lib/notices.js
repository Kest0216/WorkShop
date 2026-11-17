// A hub notice of level owner names its panel (evt.panel, final wiring spec S5). An older hub sends no such field: then these
// helpers guess, from the words, which top-bar panel the notice is about, so its sticky note can offer the right button.
// Pure functions: no DOM, so the unit tests import them.

/** True when the words are about a question the owner can answer. */
export const isAsk = (text) => /\basks?\b|question|\banswer|default/i.test(String(text || ''));

/** The panel id a notice is about, or null when no panel helps (a job that ended: its note only informs). */
export function guessPanel(text) {
  const t = String(text || '');
  // The plan summary (server/orch/plan.js) lists requirements and assumptions in free words ("default", "ship", "answer"...):
  // it is about the Blueprint, whatever else it says.
  if (/^plan for J\d+\b/i.test(t)) return 'blueprint';
  if (/^J\d+ is (done|cancelled)\.?$/i.test(t.trim())) return null;
  if (/truck|crate|\bship|branch moved/i.test(t)) return 'truck';
  if (isAsk(t)) return 'inbox';
  if (/no task\b|\bwaive/i.test(t)) return 'inbox'; // a requirement that no task serves: the Inbox holds Waive, Add task and Stop job
  if (/\bplan\b|blueprint|approve|requirement|paused|budget/i.test(t)) return 'blueprint';
  if (/\bsettings?\b|\blimits?\b/i.test(t)) return 'settings';
  if (/\bkeys?\b|sign.?in|log.?in|install|\blab\b|rate limit|self-test/i.test(t)) return 'keys';
  return 'inbox';
}
