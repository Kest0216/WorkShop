// Pure helpers of the UI: the unified diff parser, the report text parser, text marks, time stamps, the list follower.
// No server, no DOM.
// Run: node --test tests/ui-stub/ui-lib.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff } from '../../ui/lib/diff.js';
import { mdBlocks, mdInline, LINE_MAX } from '../../ui/lib/md.js';
import { showMarks, hasMarks } from '../../ui/lib/dom.js';
import { fmt, follower } from '../../ui/lib/widgets.js';

const DIFF = [
  'diff --git a/package.json b/package.json',
  'index 1111111..2222222 100644',
  '--- a/package.json',
  '+++ b/package.json',
  '@@ -3,4 +3,5 @@',
  ' {',
  '-  "start": "node a.js",',
  '+  "start": "node server/index.js",',
  '+  "test": "node --test"',
  ' }',
  ' ',
  '@@ -40 +41 @@ function x() {',
  '--- not a header: a deleted line that starts with two dashes',
  '+++ and an added one',
  'diff --git a/public/hello.txt b/public/hello.txt',
  'deleted file mode 100644',
  'index 3333333..0000000',
  '--- a/public/hello.txt',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-hello',
  '-world',
  'diff --git a/public/placeholder.html b/public/index.html',
  'similarity index 86%',
  'rename from public/placeholder.html',
  'rename to public/index.html',
  'index 4444444..5555555 100644',
  '--- a/public/placeholder.html',
  '+++ b/public/index.html',
  '@@ -1,1 +1,1 @@',
  '-<title>x</title>',
  '+<title>Recipe Box</title>',
  '\\ No newline at end of file',
  'diff --git a/public/icon.png b/public/icon.png',
  'new file mode 100644',
  'index 0000000..6666666',
  'Binary files /dev/null and b/public/icon.png differ',
  'diff --git a/docs/new file.md b/docs/new file.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/docs/new file.md',
  '@@ -0,0 +1,2 @@',
  '+# Title',
  '+text',
  '',
].join('\n');

test('parseDiff: files, status, counts and line numbers', () => {
  const files = parseDiff(DIFF);
  assert.deepEqual(files.map((f) => [f.path, f.status, f.binary, f.add, f.del]), [
    ['package.json', 'changed', false, 3, 2],
    ['public/hello.txt', 'deleted', false, 0, 2],
    ['public/index.html', 'renamed', false, 1, 1],
    ['public/icon.png', 'new', true, 0, 0],
    ['docs/new file.md', 'new', false, 2, 0],
  ]);
  const [pkg, , renamed] = files;
  assert.equal(pkg.hunks.length, 2);
  assert.deepEqual(pkg.hunks[0].lines.map((l) => `${l.t}${l.o ?? ''}/${l.n ?? ''}`), [' 3/3', '-4/', '+/4', '+/5', ' 5/6', ' 6/7']);
  // a hunk holds as many lines as its header says: "--- x" and "+++ y" inside it are changes, not file headers
  assert.deepEqual(pkg.hunks[1].lines.map((l) => l.t + l.s), ['--- not a header: a deleted line that starts with two dashes', '+++ and an added one']);
  assert.equal(pkg.hunks[1].lines[0].o, 40);
  assert.equal(pkg.hunks[1].lines[1].n, 41);
  assert.equal(renamed.oldPath, 'public/placeholder.html');
  assert.equal(renamed.hunks[0].lines.at(-1).t, '\\');
  assert.equal(files[0].oldPath, null, 'a plain change keeps no old path');
});

test('parseDiff: a bare diff, an empty answer, a cut-off diff, CRLF', () => {
  assert.deepEqual(parseDiff(''), []);
  assert.deepEqual(parseDiff('\n'), []);
  const bare = parseDiff('--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+b\n--- a/y.js\n+++ b/y.js\n@@ -1 +1,2 @@\n a\n+b\n');
  assert.deepEqual(bare.map((f) => [f.path, f.add, f.del]), [['x.js', 1, 1], ['y.js', 1, 0]]);
  const cut = parseDiff('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,50 +1,50 @@\n a\n-b\ndiff --git a/b.js b/b.js\n--- a/b.js\n+++ b/b.js\n@@ -1 +1 @@\n-x\n+y\n');
  assert.deepEqual(cut.map((f) => [f.path, f.lines]), [['a.js', 3], ['b.js', 3]], 'a hunk that is cut short ends at the next file');
  assert.equal(parseDiff('diff --git a/a b/a\r\n--- a/a\r\n+++ b/a\r\n@@ -1 +1 @@\r\n-x\r\n+y\r\n')[0].hunks[0].lines[1].s, 'y');
});

test('parseDiff: a long line and many lines stay intact', () => {
  const long = 'x'.repeat(5000);
  const many = Array.from({ length: 800 }, (_, i) => `+line ${i}`).join('\n');
  const f = parseDiff(`diff --git a/big b/big\nnew file mode 100644\n--- /dev/null\n+++ b/big\n@@ -0,0 +1,801 @@\n+${long}\n${many}\n`)[0];
  assert.equal(f.add, 801);
  assert.equal(f.hunks[0].lines[0].s.length, 5000);
  assert.equal(f.hunks[0].lines.at(-1).n, 801);
});

test('mdBlocks: headings, lists, code, paragraphs', () => {
  const blocks = mdBlocks(['# Title', '', 'One line', 'and its second line.', '', '- a', '- b **bold**', '  wrapped', '', '1. first', '2. second', '', '```', 'npm start', '<b>not html</b>', '```', '', '    indented code', '', '---', '## Next'].join('\n'));
  assert.deepEqual(blocks.map((b) => b.t), ['h', 'p', 'ul', 'ol', 'code', 'code', 'hr', 'h']);
  assert.deepEqual(blocks[0], { t: 'h', level: 1, text: 'Title' });
  assert.equal(blocks[1].text, 'One line and its second line.');
  assert.deepEqual(blocks[2].items, ['a', 'b **bold** wrapped']);
  assert.deepEqual(blocks[3].items, ['first', 'second']);
  assert.equal(blocks[4].text, 'npm start\n<b>not html</b>');
  assert.equal(blocks[5].text, 'indented code');
  assert.deepEqual(mdBlocks(''), []);
  assert.deepEqual(mdBlocks('```\nopen fence'), [{ t: 'code', text: 'open fence' }]);
});

test('mdInline: bold and code; links and images stay plain text', () => {
  assert.deepEqual(mdInline('a **b** `c **d**` e'), [{ t: 'text', s: 'a ' }, { t: 'bold', s: 'b' }, { t: 'text', s: ' ' }, { t: 'code', s: 'c **d**' }, { t: 'text', s: ' e' }]);
  assert.deepEqual(mdInline('See [the page](https://example.com/x) and ![a cat](https://example.com/c.png).'), [{ t: 'text', s: 'See the page (https://example.com/x) and image: a cat (https://example.com/c.png).' }]);
  assert.deepEqual(mdInline('<script>alert(1)</script>'), [{ t: 'text', s: '<script>alert(1)</script>' }], 'markup is only ever text');
  assert.deepEqual(mdInline(''), []);
  const plain = (s) => mdInline(s).map((r) => r.s).join('');
  assert.equal(plain('[docs](https://example.com/d "The docs") and ![](pic.png)'), 'docs (https://example.com/d) and image: no description (pic.png)', 'a title in quotes goes; an image with no words says so');
  assert.equal(plain('[https://example.com](https://example.com) [](x.md)'), 'https://example.com x.md', 'a link whose words are its address shows once');
  assert.equal(plain('[a [b](c) d](e)'), '[a b (c) d](e)', 'a label holds no "[": only the inner link is read');
  assert.equal(plain('[a](javascript:alert(1))'), '[a](javascript:alert(1))', 'an address holds no "(": the text stays as it is written');
  assert.equal(plain('[a]( b ) [a]() [a] (b)'), '[a]( b ) [a]() [a] (b)');
});

test('mdBlocks: closing marks of a heading, a line separator character, a line that is too long', () => {
  const heads = (s) => mdBlocks(s).map((b) => (b.t === 'h' ? `${b.level}:${b.text}` : b.t));
  assert.deepEqual(heads('## Title ##\n# C#\n#  Two   words  \n### a # b ###   \n# #\n####### seven\n#no space\n   # three spaces\n    # four spaces is code'),
    ['2:Title', '1:C#', '1:Two   words', '3:a # b', '1:', 'p', '1:three spaces', 'code'], 'the closing "#" run goes only after a space; 7 marks, or no space after the marks, is plain text');
  assert.deepEqual(mdBlocks('# a\u2028b\u2029- c'), [{ t: 'h', level: 1, text: 'a' }, { t: 'p', text: 'b' }, { t: 'ul', items: ['c'] }], 'U+2028 and U+2029 end a line');
  // a line over LINE_MAX is not parsed: no heading, no list item, no bold. The lines around it are parsed as usual.
  const long = '# **' + 'x'.repeat(LINE_MAX) + '**';
  assert.deepEqual(mdBlocks(`- one\n${long}\n- two\ntext`), [{ t: 'ul', items: ['one'] }, { t: 'p', text: long, plain: true }, { t: 'ul', items: ['two'] }, { t: 'p', text: 'text' }]);
  assert.equal(mdBlocks('#' + ' x'.repeat(LINE_MAX / 2 - 1) + ' ')[0].t, 'h', 'a line of exactly LINE_MAX characters is still parsed');
  assert.equal(mdBlocks('```\n' + 'y'.repeat(LINE_MAX * 2) + '\n```')[0].t, 'code', 'a long line inside a code block stays code');
});

// A report is untrusted text and the view takes 200,000 characters of it. A pattern that backtracks without limit would
// freeze the window for seconds: the heading pattern once took 8.9 s for one 4 KB line, the link pattern 8.3 s for 4 KB of
// "[a](" and 11 s for 80,000 "[". Now the time grows in a straight line with the text.
// The texts are built before the clock starts, and the best of 5 runs counts, so a busy machine does not fail the test.
function bestMs(run, input, limit) {
  let best = Infinity;
  for (let i = 0; i < 5 && best >= limit; i++) { const t = process.hrtime.bigint(); run(input); best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6); }
  return best;
}
const sp = (n) => ' '.repeat(n);
const near = (unit) => unit.repeat(Math.floor((LINE_MAX - 2) / unit.length)); // as long as a line can be before it counts as "too long"
const lines = (n, line) => Array(n).fill(line).join('\n');

test('the report parser stays fast on hostile text: each case under 50 ms', () => {
  const cases = [
    // the inputs that froze the window
    ['heading: "# " + 2,000 spaces + x + 2,000 spaces + y (4 KB)', mdBlocks, '# ' + sp(2000) + 'x' + sp(2000) + 'y'],
    ['link: "[a](" * 1,000 (4 KB)', mdInline, '[a]('.repeat(1000)],
    ['link: "[a](" * 2,000 (8 KB)', mdInline, '[a]('.repeat(2000)],
    ['link: 80,000 "["', mdInline, '['.repeat(80000)],
    // the same shapes just under the long-line limit, where the patterns themselves run (10 lines, 20 KB)
    ['heading: "# " + 990 spaces + x + 990 spaces + y', mdBlocks, '# ' + sp(990) + 'x' + sp(990) + 'y'],
    ['heading: 10 such lines', mdBlocks, lines(10, '# ' + sp(990) + 'x' + sp(990) + 'y')],
    ['heading: "# a" + " #" * 900 + spaces + b, 10 lines', mdBlocks, lines(10, '# a' + ' #'.repeat(900) + sp(150) + 'b')],
    ['heading: "#" * 6 + tabs and spaces, 10 lines', mdBlocks, lines(10, '######' + near(' \t') + '#')],
    ['rule: "- " * 990 + x, 10 lines', mdBlocks, lines(10, near('- ') + 'x')],
    ['rule: "-" + 1,990 spaces + x, 10 lines', mdBlocks, lines(10, '-' + sp(1990) + 'x')],
    ['list: "1." + 1,990 spaces, 10 lines', mdBlocks, lines(10, '1.' + sp(1990))],
    ['list: 5,000 one-letter items', mdBlocks, '- a\n'.repeat(5000)],
    ['blocks: 20,000 spaces in one line', mdBlocks, sp(20000)],
    ['blocks: 10,000 empty lines', mdBlocks, '\n'.repeat(10000)],
    // other shapes of the link, bold and code patterns (20 KB each)
    ['link: 20,000 "!["', mdInline, '!['.repeat(10000)],
    ['link: 10,000 "]("', mdInline, ']('.repeat(10000)],
    ['link: "[a](" + 20,000 x', mdInline, '[a](' + 'x'.repeat(20000)],
    ['link: "[" + 10,000 a + "](" + 10,000 x', mdInline, '[' + 'a'.repeat(10000) + '](' + 'x'.repeat(10000)],
    ['link: "[a](x " * 3,000', mdInline, '[a](x '.repeat(3000)],
    ['link: "[a](x \\"" * 3,000', mdInline, '[a](x "'.repeat(3000)],
    ['link: "[a](x" + 20,000 spaces', mdInline, '[a](x' + sp(20000)],
    ['bold: "**a " * 5,000', mdInline, '**a '.repeat(5000)],
    ['bold: "**" + 20,000 a', mdInline, '**' + 'a'.repeat(20000)],
    ['bold: "__a_" * 5,000', mdInline, '__a_'.repeat(5000)],
    ['code: "`a " * 6,000', mdInline, '`a '.repeat(6000)],
    ['code: 20,000 backticks', mdInline, '`'.repeat(20000)],
  ];
  for (const [name, run, input] of cases) {
    const ms = bestMs(run, input, 50);
    assert.ok(ms < 50, `${name}: took ${ms.toFixed(1)} ms`);
  }
});

test('the report parser takes the 200,000 characters that the view accepts, of any shape, well under a second', () => {
  const whole = (text) => mdBlocks(text).map((b) => (b.items ? b.items.map(mdInline) : mdInline(b.text || '')));
  const cases = [
    ['100 heading lines just under the long-line limit', lines(100, '# ' + sp(990) + 'x' + sp(990) + 'y')],
    ['100 rule lines of "- "', lines(100, near('- ') + 'x')],
    ['50,000 one-letter list items', '- a\n'.repeat(50000)],
    ['200,000 line breaks', '\n'.repeat(200000)],
    ['one line of "[a]("', '[a]('.repeat(50000)],
    ['one paragraph of 25,000 short lines of "[a](**b` "', lines(25000, '[a](**b`')],
    ['200,000 "["', '['.repeat(200000)],
    ['"**a " * 50,000', '**a '.repeat(50000)],
    ['"`a " * 66,000', '`a '.repeat(66000)],
  ];
  for (const [name, input] of cases) {
    const ms = bestMs(whole, input, 1000);
    assert.ok(ms < 1000, `${name}: took ${ms.toFixed(0)} ms`);
  }
});

test('hidden text-direction characters are written out', () => {
  assert.equal(showMarks('user\u202Etxt.exe'), 'user[U+202E]txt.exe');
  assert.equal(showMarks('a\u2066b\u2069c\u200Ed\u200Fe\u061Cf\u202Ag\u202C'), 'a[U+2066]b[U+2069]c[U+200E]d[U+200F]e[U+061C]f[U+202A]g[U+202C]');
  assert.equal(showMarks('plain text, with an accent: cr\u00E8me'), 'plain text, with an accent: cr\u00E8me', 'other text is not touched');
  assert.equal(showMarks(null), '');
  assert.equal(hasMarks('if (admin\u202E) return;'), true);
  assert.equal(hasMarks('if (admin) return;'), false);
});

test('parseDiff marks a file whose path or lines hold a hidden direction character', () => {
  const clean = parseDiff('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-x\n+y\n');
  assert.equal(clean[0].marks, false);
  const line = parseDiff('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-x\n+if (isAdmin\u202E) {\n');
  assert.equal(line[0].marks, true);
  const name = parseDiff('diff --git a/x\u202Egnp.js b/x\u202Egnp.js\nnew file mode 100644\n--- /dev/null\n+++ b/x\u202Egnp.js\n@@ -0,0 +1 @@\n+ok\n');
  assert.equal(name[0].marks, true);
});

test('a post from another day shows its date', () => {
  const now = new Date(2026, 10, 15, 9, 30).getTime();
  assert.equal(fmt.stamp(new Date(2026, 10, 15, 8, 5).getTime(), now), '08:05');
  assert.equal(fmt.stamp(new Date(2026, 10, 14, 22, 10).getTime(), now), 'Nov 14 22:10');
  assert.equal(fmt.stamp(new Date(2025, 10, 15, 8, 5).getTime(), now), 'Nov 15 08:05', 'the same day of another year is another day');
  assert.equal(fmt.stamp('nonsense', now), '');
});

// A stand-in for a scrolling element: the browser keeps scrollTop inside the content, and tells about a scroll later.
function fakeList({ content = 1000, box = 200, width = 300 } = {}) {
  const fns = new Set();
  let top = 0;
  return {
    scrollHeight: content, clientHeight: box, clientWidth: width,
    get scrollTop() { return top; },
    set scrollTop(v) { top = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)); },
    addEventListener(type, fn) { if (type === 'scroll') fns.add(fn); },
    removeEventListener(type, fn) { fns.delete(fn); },
    scrolled() { for (const fn of fns) fn(); },
    get gap() { return this.scrollHeight - top - this.clientHeight; },
  };
}

test('a list that follows its end stops only when the owner scrolls up, never for a change of layout', () => {
  const list = fakeList();
  const seen = [];
  const f = follower(list, { onChange: (on) => seen.push(on) });
  f.pin();
  assert.equal(list.gap, 0);
  assert.equal(f.on, true);

  // new lines go in, the panel pins again
  list.scrollHeight = 1400; f.pin(); list.scrolled();
  assert.equal(list.gap, 0);

  // the window gets lower: the box shrinks, the view is short of the end. The scroll event of the last pin arrives only now.
  list.clientHeight = 120; list.scrolled();
  assert.equal(f.on, true, 'a lower box is not the owner scrolling');
  assert.equal(list.gap, 0, 'the list went back to its end');

  // a row above got taller (same box): the view is short of the end, but it did not move up
  list.scrollHeight = 1500; list.scrolled();
  assert.equal(f.on, true);

  // the window gets wider and lower at once: lines unwrap, the browser moves the view up to keep its anchor
  f.pin();
  list.clientWidth = 500; list.clientHeight = 90; list.scrollHeight = 1300; list.scrollTop = list.scrollTop - 150; list.scrolled();
  assert.equal(f.on, true, 'a move up that comes with a new box is layout');
  assert.equal(list.gap, 0);
  assert.deepEqual(seen, [], 'nothing changed for the panel so far');

  // the owner scrolls up
  list.scrollTop = list.scrollTop - 300; list.scrolled();
  assert.equal(f.on, false);
  assert.deepEqual(seen, [false]);
  // more lines while the owner reads: the view stays; a change of the window does not pull it down either
  const at = list.scrollTop;
  list.scrollHeight = 1600; list.clientHeight = 200; list.scrolled();
  assert.equal(f.on, false);
  assert.equal(list.scrollTop, at);
  // a little way down is not the end
  list.scrollTop = at + 100; list.scrolled();
  assert.equal(f.on, false);
  // back at the end (within the slack): it follows again
  list.scrollTop = list.scrollHeight - list.clientHeight - 10; list.scrolled();
  assert.equal(f.on, true);
  assert.deepEqual(seen, [false, true]);

  // a jump to one line for the owner: follows only when that left the view at the end
  f.move(() => { list.scrollTop = 40; });
  assert.equal(f.on, false);
  list.clientHeight = 150; list.scrolled(); // the scroll event of the jump, with a new box: the place stays
  assert.equal(list.scrollTop, 40);
  f.move(() => { list.scrollTop = list.scrollHeight; });
  assert.equal(f.on, true);

  // "Jump to latest"
  list.scrollTop = 0; list.scrolled();
  assert.equal(f.on, false);
  f.pin();
  assert.equal(f.on, true);
  assert.equal(list.gap, 0);

  f.stop();
  list.scrollTop = 0; list.scrolled();
  assert.equal(f.on, true, 'a stopped follower listens to nothing');
});

// ---- notices: which top-bar panel a hub notice of level owner is about (live QA: a plan summary got an "Answer" button)
import { guessPanel, isAsk } from '../../ui/lib/notices.js';

test('guessPanel: the plan summary opens the Blueprint even when its assumptions say "default" or "answer"', () => {
  const plan = 'Plan for J5: 4 tasks, 1 requirements. R1: Build a clock. Assumptions: Default taken: the owner is away, so the answer is A.; Ship as one module. Dropped: none.';
  assert.equal(guessPanel(plan), 'blueprint');
  assert.equal(isAsk(plan), true, 'the words alone would have said Inbox');
});

test('guessPanel: the notices of the hub map to the panel that holds their button', () => {
  assert.equal(guessPanel('J1: every requirement is verified or waived. The lead boss writes the report; then the truck waits for you.'), 'truck');
  assert.equal(guessPanel('Your branch moved. Look again, then ship. The truck took in the new commits of main.'), 'truck');
  assert.equal(guessPanel('J3: R2 failed and no task serves them. Waive them, add a task (Request changes), or stop the job.'), 'inbox');
  assert.equal(guessPanel('R4 ("x") has no task. Waive it, add a task (Request changes), or stop the job.'), 'inbox');
  assert.equal(guessPanel('J2 paused (budget).'), 'blueprint');
  assert.equal(guessPanel('J2 waits: no lab can run a boss now. Sign in or choose a mode in the Keys panel.'), 'keys');
  assert.equal(guessPanel('T12 has no reviewer verdict. Post PASS re:40 or FIX re:40 on the board.'), 'inbox');
});

test('guessPanel: a job that ended gets a note with no button', () => {
  assert.equal(guessPanel('J4 is done.'), null);
  assert.equal(guessPanel('J4 is cancelled.'), null);
  assert.equal(guessPanel(''), 'inbox');
});
