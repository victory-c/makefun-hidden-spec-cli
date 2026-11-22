// Edge-case checks written from SPEC.md sentences the practice set does not show.
// Run: node tests/edge.ts   (prints each failing case, then a count)
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const MAIN = join(import.meta.dirname, '..', 'main.ts');

interface Case {
  name: string;
  argv?: string[];
  stdin?: string;
  files?: Record<string, string>;
  exit: number;
  out: string;
  after?: Record<string, string>; // full expected tree; defaults to files unchanged
}

function walk(root: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(join(root, rel))) {
    const r = rel === '' ? name : `${rel}/${name}`;
    if (statSync(join(root, r)).isDirectory()) Object.assign(out, walk(root, r));
    else out[r] = readFileSync(join(root, r), 'utf8');
  }
  return out;
}

export function runCases(cases: Case[]): void {
  let ok = 0;
  for (const c of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'mend-'));
    for (const [p, t] of Object.entries(c.files ?? {})) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), t);
    }
    const r = spawnSync('node', [MAIN, ...(c.argv ?? [])], { cwd: dir, input: c.stdin ?? '', encoding: 'utf8' });
    const tree = walk(dir);
    const want = c.after ?? c.files ?? {};
    const bad: string[] = [];
    if (r.status !== c.exit) bad.push(`exit ${r.status} want ${c.exit}`);
    if (r.stdout !== c.out) bad.push(`stdout ${JSON.stringify(r.stdout)} want ${JSON.stringify(c.out)}`);
    if (JSON.stringify(tree, Object.keys(tree).sort()) !== JSON.stringify(want, Object.keys(want).sort()))
      bad.push(`tree ${JSON.stringify(tree)} want ${JSON.stringify(want)}`);
    if (r.stderr) bad.push(`stderr ${r.stderr.slice(0, 300)}`);
    if (bad.length) console.log(`FAIL ${c.name}\n  ${bad.join('\n  ')}`);
    else ok++;
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`${ok} of ${cases.length} edge cases passed`);
}
