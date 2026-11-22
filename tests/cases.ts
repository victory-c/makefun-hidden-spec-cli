// Cases from SPEC.md sentences; run with `node tests/cases.ts`.
import { runCases } from './edge.ts';

const P = (s: string): string => s; // readability marker for patch text

runCases([
  // ---- section 1: usage ----
  { name: 'usage dup option', argv: ['--check', '--check'], exit: 2, out: 'error: usage\n' },
  { name: 'usage bad format', argv: ['--format=diff'], exit: 2, out: 'error: usage\n' },
  { name: 'usage empty format', argv: ['--format='], exit: 2, out: 'error: usage\n' },
  { name: 'usage two positionals', argv: ['a', 'b'], exit: 2, out: 'error: usage\n' },
  { name: 'usage wins over no-patch', argv: ['nope', '-x'], exit: 2, out: 'error: usage\n' },
  { name: 'dashdash positional', argv: ['--', '--check'], exit: 2, out: 'error: no-patch\n' },
  { name: 'dashdash then two', argv: ['--', 'a', 'b'], exit: 2, out: 'error: usage\n' },
  { name: 'dash is stdin', argv: ['-'], stdin: 'hello\n', exit: 2, out: 'error: format\n' },
  { name: 'empty stdin', exit: 2, out: 'error: format\n' },
  { name: 'forced v4a empty', argv: ['--format=v4a'], exit: 2, out: 'error: parse 1\n' },
  { name: 'patch is a dir', argv: ['d'], files: { 'd/x': 'a\n' }, exit: 2, out: 'error: no-patch\n' },
  // ---- section 2/3: unsafe, noop, R ----
  {
    name: 'unsafe dotdot unified',
    stdin: P('--- a/../x\n+++ b/../x\n@@ -1 +1 @@\n-a\n+b\n'),
    exit: 1,
    out: 'error: unsafe ../x\nfailed: 1 of 1 edits\n',
  },
  {
    name: 'noop change',
    files: { f: 'a\n' },
    stdin: P('--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+a\n'),
    exit: 0,
    out: 'ok: 0 files\n',
  },
  {
    name: 'git rename only',
    files: { 'old.txt': 'x\n' },
    stdin: P('diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n'),
    exit: 0,
    out: 'R old.txt -> new.txt\nok: 1 file\n',
    after: { 'new.txt': 'x\n' },
  },
  {
    name: 'move exists',
    files: { a: 'x\n', b: 'y\n' },
    stdin: P('--- a/a\n+++ b/b\n@@ -1 +1 @@\n-x\n+z\n'),
    exit: 1,
    out: 'error: exists b\nfailed: 1 of 1 edits\n',
  },
  // ---- section 5: tier 2 re-indent ----
  {
    name: 'tier2 reindent SR',
    files: { f: 'def f():\n        return 1\n' },
    stdin: P('f\n<<<<<<< SEARCH\n    return 1\n=======\n    x = 2\n    return x\n\n>>>>>>> REPLACE\n'),
    exit: 0,
    out: 'M f\nok: 1 file\n',
    after: { f: 'def f():\n        x = 2\n        return x\n\n' },
  },
  // ---- section 6: noeol and creation ----
  {
    name: 'unified create noeol',
    stdin: P('--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file\n'),
    exit: 0,
    out: 'A n.txt\nok: 1 file\n',
    after: { 'n.txt': 'a\nb' },
  },
  {
    name: 'unified add final break',
    files: { f: 'a\nb' },
    stdin: P('--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n'),
    exit: 0,
    out: 'M f\nok: 1 file\n',
    after: { f: 'a\nc\n' },
  },
  {
    name: 'hunk before section',
    stdin: P('diff --git a/f b/f\n@@ -1 +1 @@\n-a\n+b\n'),
    files: { f: 'a\n' },
    exit: 0,
    out: 'M f\nok: 1 file\n',
    after: { f: 'b\n' },
  },
  { name: 'bad git line', stdin: P('diff --git foo\n--- a/f\n+++ b/f\n'), exit: 2, out: 'error: parse 1\n' },
  { name: 'dash without plus', stdin: P('diff --git a/f b/f\n--- a/f\n@@ -1 +1 @@\n'), exit: 2, out: 'error: parse 3\n' },
  { name: 'bad hunk header', stdin: P('--- a/f\n+++ b/f\n@@ bad @@\n-a\n'), exit: 2, out: 'error: parse 3\n' },
  // ---- section 7 ----
  { name: 'SR no path', stdin: P('<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n'), exit: 2, out: 'error: parse 1\n' },
  { name: 'SR unterminated', stdin: P('f\n<<<<<<< SEARCH\na\n=======\nb\n'), exit: 2, out: 'error: parse 2\n' },
  {
    name: 'SR reuse path',
    files: { f: 'a\nb\n' },
    stdin: P('f\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n'),
    exit: 0,
    out: 'M f\nok: 1 file\n',
    after: { f: 'A\nB\n' },
  },
  // ---- section 8 ----
  { name: 'v4a no end', stdin: P('*** Begin Patch\n*** Delete File: f\n'), exit: 2, out: 'error: parse 3\n' },
  {
    name: 'v4a update no chunk',
    stdin: P('*** Begin Patch\n*** Update File: f\n*** End Patch\n'),
    exit: 2,
    out: 'error: parse 2\n',
  },
  {
    name: 'v4a move only',
    files: { f: 'a\n' },
    stdin: P('*** Begin Patch\n*** Update File: f\n*** Move to: g/h\n*** End Patch\n'),
    exit: 0,
    out: 'R f -> g/h\nok: 1 file\n',
    after: { 'g/h': 'a\n' },
  },
  {
    name: 'v4a eof insert',
    files: { f: 'a\nb\n' },
    stdin: P('*** Begin Patch\n*** Update File: f\n@@\n+c\n*** End of File\n*** End Patch\n'),
    exit: 0,
    out: 'M f\nok: 1 file\n',
    after: { f: 'a\nb\nc\n' },
  },
  // ---- section 9/10 ----
  {
    name: 'json lines partial fail',
    files: { f: 'a\n' },
    stdin: P('{"command":"create","path":"g","file_text":"x"}\n{"command":"create","path":"f","file_text":"x"}\n'),
    exit: 1,
    out: 'error: exists f\nfailed: 1 of 2 edits\n',
  },
  {
    name: 'check writes nothing',
    argv: ['--check'],
    stdin: P('{"command":"create","path":"g","file_text":"x"}\n'),
    exit: 0,
    out: 'A g\nok: 1 file\n',
  },
  {
    name: 'byte order',
    stdin: P('[{"command":"create","path":"b","file_text":""},{"command":"create","path":"B","file_text":""},{"command":"create","path":"a/z","file_text":""}]'),
    exit: 0,
    out: 'A B\nA a/z\nA b\nok: 3 files\n',
    after: { b: '', B: '', 'a/z': '' },
  },
]);
