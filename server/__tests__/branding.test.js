import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Decision 0023: nothing a player sees names D&D. This scans the client source, the page shell,
// the server's player-facing strings and every campaign's data. Allowed by design: changelog
// history (a record of what shipped) and the SRD 5.1 licence notice (an obligation, and it names
// no D&D product).
const ROOT = path.join(__dirname, '..', '..');
const BANNED = /\bD&D\b|Dungeons\s*&\s*Dragons|Dungeons and Dragons|Dungeon Master/i;
const ALLOWED = new Set([
  path.join('client', 'src', 'data', 'changelog.js'),
]);

function walk(dir, exts, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'dist') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, exts, out);
    else if (exts.some(e => entry.name.endsWith(e))) out.push(p);
  }
  return out;
}

describe('no D&D branding where players can see it', () => {
  const files = [
    ...walk(path.join(ROOT, 'client', 'src'), ['.js', '.jsx', '.css']),
    path.join(ROOT, 'client', 'index.html'),
    ...walk(path.join(ROOT, 'server'), ['.js']),
    ...walk(path.join(ROOT, 'data', 'campaigns'), ['.json']),
    ...walk(path.join(ROOT, 'data', 'defaults'), ['.json']),
  ];

  it('scans a real tree', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('finds none', () => {
    const hits = [];
    for (const f of files) {
      const rel = path.relative(ROOT, f);
      if (ALLOWED.has(rel)) continue;
      fs.readFileSync(f, 'utf-8').split('\n').forEach((line, i) => {
        if (BANNED.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
