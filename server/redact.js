// Exact-value redactor (contract section 14). It holds the exact value of every stored key and of
// every live agent token, in memory only. Logs, events, prompts, check tails and the board's secret
// scan pass their text through it.

/** Values shorter than this are ignored: a short value would redact ordinary words. */
const MIN_CHARS = 8;
const MARK = '[redacted]';

/**
 * Create an empty redactor.
 * @returns {{ add(value: string): void, remove(value: string): void, redact(text: string): string, hit(text: string): boolean, size(): number }}
 *   add/remove: a value that is not a string or is shorter than 8 characters is ignored; both are idempotent.
 *   redact: every exact match of a held value becomes "[redacted]"; matches that overlap become one mark, so
 *   no part of any held value is left; a text that is not a string is returned as is.
 *   hit: true when the text holds a held value.
 */
export function createRedactor() {
  const values = new Set();

  const usable = (value) => typeof value === 'string' && value.length >= MIN_CHARS;

  function add(value) {
    if (usable(value)) values.add(value);
  }

  function remove(value) {
    if (usable(value)) values.delete(value);
  }

  function redact(text) {
    if (typeof text !== 'string' || text.length < MIN_CHARS || values.size === 0) return text;
    // Every occurrence of every value, overlaps included. One alternation regex would miss the part of a
    // value that starts inside an earlier match ("AAAA-1234" + "1234-BBBB" in "AAAA-1234-BBBB").
    const ranges = [];
    for (const value of values) {
      for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) ranges.push([at, at + value.length]);
    }
    if (ranges.length === 0) return text;
    ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    let out = '';
    let pos = 0;
    for (let i = 0; i < ranges.length;) {
      const start = ranges[i][0];
      let end = ranges[i][1];
      for (i += 1; i < ranges.length && ranges[i][0] < end; i += 1) end = Math.max(end, ranges[i][1]);
      out += text.slice(pos, start) + MARK;
      pos = end;
    }
    return out + text.slice(pos);
  }

  function hit(text) {
    if (typeof text !== 'string' || text.length < MIN_CHARS) return false;
    for (const value of values) if (text.includes(value)) return true;
    return false;
  }

  return { add, remove, redact, hit, size: () => values.size };
}
