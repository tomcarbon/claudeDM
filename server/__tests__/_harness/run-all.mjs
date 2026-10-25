/**
 * Runs every server/__tests__/**\/*.test.js file in its own child process (vitest isolates per
 * file; module-level state in ws-handler.js makes that isolation load-bearing) and prints a
 * single total. Usage: node server/__tests__/_harness/run-all.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const testsDir = path.resolve(here, '..');
const runner = path.join(here, 'run-file.mjs');

const files = fs.readdirSync(testsDir).filter(f => f.endsWith('.test.js')).sort()
  .map(f => path.join(testsDir, f));

const totals = { passed: 0, failed: 0, skipped: 0, unhandled: 0 };
const perFile = [];

for (const file of files) {
  const rel = path.relative(process.cwd(), file);
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [runner, rel], { cwd: process.cwd() });
    let buf = '';
    child.stdout.on('data', d => { buf += d; });
    child.stderr.on('data', d => { buf += d; });
    child.on('close', (code) => resolve({ buf, code }));
  });
  process.stdout.write(out.buf);
  const m = out.buf.match(/SUMMARY \S+ passed=(\d+) failed=(\d+) skipped=(\d+) unhandled=(\d+)/);
  if (m) {
    totals.passed += +m[1]; totals.failed += +m[2]; totals.skipped += +m[3]; totals.unhandled += +m[4];
    perFile.push({ rel, passed: +m[1], failed: +m[2], skipped: +m[3] });
  } else {
    totals.failed += 1;
    perFile.push({ rel, passed: 0, failed: 1, skipped: 0, note: 'no summary line — the file crashed the runner' });
    console.log(`  ✗ ${rel}: runner produced no summary (exit ${out.code})`);
  }
}

console.log('\n================ TOTAL ================');
for (const f of perFile) {
  console.log(`  ${String(f.passed).padStart(3)} pass  ${String(f.failed).padStart(3)} fail  ${String(f.skipped).padStart(3)} skip   ${f.rel}${f.note ? '  (' + f.note + ')' : ''}`);
}
console.log(`\n  files=${files.length}  tests=${totals.passed + totals.failed + totals.skipped}  passed=${totals.passed}  failed=${totals.failed}  skipped=${totals.skipped}  unhandledRejections=${totals.unhandled}`);
process.exit(totals.failed > 0 ? 1 : 0);
