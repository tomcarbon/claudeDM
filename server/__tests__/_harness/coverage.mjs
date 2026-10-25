/**
 * Function-level coverage for the fallback harness, using Node's built-in V8 coverage.
 * No dependency, no instrumentation, no npm install.
 *
 *   node server/__tests__/_harness/coverage.mjs                  # run suite + report
 *   node server/__tests__/_harness/coverage.mjs --only=vitals-utils,state-guard
 *
 * Reports, per source file: which top-level functions were never entered, and what percentage
 * of the file's executable ranges ran. "Never entered" is the number that matters when the
 * question is "what is still unexercised" — a partially covered function is a weaker finding
 * than one nothing has ever called.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..', '..');
const runAll = path.join(here, 'run-all.mjs');

const onlyArg = process.argv.find(a => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length).split(',').map(s => s.trim()) : null;

const covDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudedm-cov-'));

const code = await new Promise((resolve) => {
  const child = spawn(process.execPath, [runAll], {
    cwd: projectRoot,
    env: { ...process.env, NODE_V8_COVERAGE: covDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let tail = '';
  child.stdout.on('data', d => { tail += d; });
  child.stderr.on('data', d => { tail += d; });
  child.on('close', (c) => {
    const m = tail.match(/^ {2}files=.*$/m);
    if (m) console.log(m[0].trim());
    resolve(c);
  });
});

// Merge every process's coverage: a range is covered if any process ran it.
const perUrl = new Map(); // url -> Map<`${start}:${end}:${name}`, {name,start,end,count}>
for (const file of fs.readdirSync(covDir)) {
  if (!file.endsWith('.json')) continue;
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(covDir, file), 'utf-8')); } catch { continue; }
  for (const script of data.result || []) {
    if (!script.url || !script.url.startsWith('file:')) continue;
    const abs = fileURLToPath(script.url);
    if (!abs.startsWith(path.join(projectRoot, 'server'))) continue;
    if (abs.includes('__tests__')) continue;
    if (!perUrl.has(abs)) perUrl.set(abs, new Map());
    const acc = perUrl.get(abs);
    for (const fn of script.functions || []) {
      for (const r of fn.ranges || []) {
        const key = `${r.startOffset}:${r.endOffset}:${fn.functionName}`;
        const prev = acc.get(key);
        if (prev) prev.count += r.count;
        else acc.set(key, { name: fn.functionName, start: r.startOffset, end: r.endOffset, count: r.count });
      }
    }
  }
}

function lineOf(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

const files = [...perUrl.keys()].sort();
let totalNeverCalled = 0;

console.log('\n=== function coverage (V8, merged across the suite) ===\n');
for (const abs of files) {
  const rel = path.relative(projectRoot, abs);
  if (only && !only.some(o => rel.includes(o))) continue;
  const src = fs.readFileSync(abs, 'utf-8');
  const ranges = [...perUrl.get(abs).values()];

  // A function's own range is the widest range carrying its name; count 0 means never entered.
  const byName = new Map();
  for (const r of ranges) {
    if (!r.name) continue;
    const prev = byName.get(r.name);
    if (!prev || (r.end - r.start) > (prev.end - prev.start)) byName.set(r.name, r);
  }
  const never = [...byName.values()].filter(r => r.count === 0).sort((a, b) => a.start - b.start);

  // Executed byte fraction, from the top-level script range minus zero-count sub-ranges.
  const zero = ranges.filter(r => r.count === 0);
  const uncoveredBytes = new Set();
  for (const r of zero) for (let i = r.start; i < r.end; i++) uncoveredBytes.add(i);
  const pct = src.length ? (100 * (1 - uncoveredBytes.size / src.length)) : 100;

  totalNeverCalled += never.length;
  console.log(`${rel}  ${pct.toFixed(1)}% of bytes executed, ${byName.size} functions, ${never.length} never entered`);
  for (const r of never) console.log(`    never called: ${r.name}  (line ${lineOf(src, r.start)})`);
}
console.log(`\ntotal functions never entered across reported files: ${totalNeverCalled}`);
fs.rmSync(covDir, { recursive: true, force: true });
process.exit(code === 0 ? 0 : 1);
