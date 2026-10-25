import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const {
  emailToSlug,
  getPlayerCharactersDir,
  getSessionDir,
  getSessionFilePath,
  getSessionCharactersDir,
  getSessionNpcsDir,
  snapshotToSession,
  ensurePlayerDataExists,
  provisionPlayerDefaults,
} = require('../player-data');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudedm-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('emailToSlug', () => {
  it('converts email to kebab-case slug', () => {
    expect(emailToSlug('Tom@Gmail.COM')).toBe('tom-gmail-com');
  });

  it('handles special characters', () => {
    expect(emailToSlug('user+tag@example.co.uk')).toBe('user-tag-example-co-uk');
  });

  it('trims whitespace', () => {
    expect(emailToSlug('  alice@test.com  ')).toBe('alice-test-com');
  });
});

describe('path helpers', () => {
  it('getPlayerCharactersDir returns correct path', () => {
    const dir = getPlayerCharactersDir('/data', 'tom@gmail.com', 'demo');
    expect(dir).toBe('/data/players/tom-gmail-com/demo/characters');
  });

  it('defaults to demo campaign when campaignId is null', () => {
    const dir = getPlayerCharactersDir('/data', 'tom@gmail.com', null);
    expect(dir).toBe('/data/players/tom-gmail-com/demo/characters');
  });
});

describe('session path helpers (neutral location)', () => {
  it('getSessionDir returns correct path', () => {
    expect(getSessionDir('/data', 'sess-123')).toBe('/data/sessions/sess-123');
  });

  it('getSessionFilePath returns correct path', () => {
    expect(getSessionFilePath('/data', 'sess-123')).toBe('/data/sessions/sess-123/session.json');
  });

  it('getSessionCharactersDir returns correct path', () => {
    expect(getSessionCharactersDir('/data', 'sess-123')).toBe('/data/sessions/sess-123/characters');
  });

  it('getSessionNpcsDir returns correct path', () => {
    expect(getSessionNpcsDir('/data', 'sess-123')).toBe('/data/sessions/sess-123/npcs');
  });
});

describe('snapshotToSession', () => {
  const email = 'test@example.com';
  const campaign = 'demo';
  const sessionId = 'test-session-1';

  beforeEach(() => {
    // Set up player character library
    ensurePlayerDataExists(tmpDir, email, campaign);
    const charDir = getPlayerCharactersDir(tmpDir, email, campaign);

    fs.writeFileSync(path.join(charDir, 'bramble.json'), JSON.stringify({
      id: 'char-1', name: 'Bramble', level: 3, hitPoints: { current: 25, max: 25 },
    }, null, 2));

    fs.writeFileSync(path.join(charDir, 'grimjaw.json'), JSON.stringify({
      id: 'char-2', name: 'Grimjaw', level: 4, hitPoints: { current: 30, max: 35 },
    }, null, 2));

    // Set up campaign defaults for NPCs
    const defaultNpcDir = path.join(tmpDir, 'defaults', campaign, 'npcs');
    fs.mkdirSync(defaultNpcDir, { recursive: true });
    fs.writeFileSync(path.join(defaultNpcDir, 'pip.json'), JSON.stringify({
      id: 'npc-1', name: 'Pip Whistledown', level: 2, hitPoints: { current: 15, max: 15 },
    }, null, 2));
  });

  it('copies player characters and default NPCs to session directory', () => {
    snapshotToSession(tmpDir, sessionId, email, campaign);

    const sessCharDir = getSessionCharactersDir(tmpDir, sessionId);
    const sessNpcDir = getSessionNpcsDir(tmpDir, sessionId);

    expect(fs.existsSync(path.join(sessCharDir, 'bramble.json'))).toBe(true);
    expect(fs.existsSync(path.join(sessCharDir, 'grimjaw.json'))).toBe(true);
    expect(fs.existsSync(path.join(sessNpcDir, 'pip.json'))).toBe(true);

    // Verify content is identical
    const original = JSON.parse(fs.readFileSync(path.join(getPlayerCharactersDir(tmpDir, email, campaign), 'bramble.json'), 'utf-8'));
    const snapshot = JSON.parse(fs.readFileSync(path.join(sessCharDir, 'bramble.json'), 'utf-8'));
    expect(snapshot).toEqual(original);
  });

  it('does not overwrite existing session files', () => {
    snapshotToSession(tmpDir, sessionId, email, campaign);

    // Modify the session copy
    const sessCharDir = getSessionCharactersDir(tmpDir, sessionId);
    const bramblePath = path.join(sessCharDir, 'bramble.json');
    const modified = JSON.parse(fs.readFileSync(bramblePath, 'utf-8'));
    modified.hitPoints.current = 10;
    modified.level = 5;
    fs.writeFileSync(bramblePath, JSON.stringify(modified, null, 2));

    // Snapshot again — should NOT overwrite the modified file
    snapshotToSession(tmpDir, sessionId, email, campaign);

    const afterSecondSnapshot = JSON.parse(fs.readFileSync(bramblePath, 'utf-8'));
    expect(afterSecondSnapshot.hitPoints.current).toBe(10);
    expect(afterSecondSnapshot.level).toBe(5);
  });

  it('creates session directories if they do not exist', () => {
    const sessCharDir = getSessionCharactersDir(tmpDir, sessionId);
    expect(fs.existsSync(sessCharDir)).toBe(false);

    snapshotToSession(tmpDir, sessionId, email, campaign);

    expect(fs.existsSync(sessCharDir)).toBe(true);
  });

  it('two sessions have independent character state', () => {
    const sessionA = 'session-a';
    const sessionB = 'session-b';

    snapshotToSession(tmpDir, sessionA, email, campaign);
    snapshotToSession(tmpDir, sessionB, email, campaign);

    // Modify character in session A
    const charPathA = path.join(getSessionCharactersDir(tmpDir, sessionA), 'bramble.json');
    const charA = JSON.parse(fs.readFileSync(charPathA, 'utf-8'));
    charA.hitPoints.current = 5;
    fs.writeFileSync(charPathA, JSON.stringify(charA, null, 2));

    // Session B should be unaffected
    const charPathB = path.join(getSessionCharactersDir(tmpDir, sessionB), 'bramble.json');
    const charB = JSON.parse(fs.readFileSync(charPathB, 'utf-8'));
    expect(charB.hitPoints.current).toBe(25);

    // Session A should have the modification
    const charAReread = JSON.parse(fs.readFileSync(charPathA, 'utf-8'));
    expect(charAReread.hitPoints.current).toBe(5);
  });

  it('handles missing source directories gracefully', () => {
    expect(() => snapshotToSession(tmpDir, sessionId, email, 'nonexistent')).not.toThrow();
  });
});

describe('ensurePlayerDataExists', () => {
  it('creates characters directory', () => {
    ensurePlayerDataExists(tmpDir, 'new@user.com', 'demo');
    expect(fs.existsSync(getPlayerCharactersDir(tmpDir, 'new@user.com', 'demo'))).toBe(true);
  });

  it('is idempotent — does not fail on existing directories', () => {
    ensurePlayerDataExists(tmpDir, 'new@user.com', 'demo');
    expect(() => ensurePlayerDataExists(tmpDir, 'new@user.com', 'demo')).not.toThrow();
  });
});

// WO-0026. The snapshot used to copy campaign defaults BEFORE the player library, and the skip
// was "destination filename already exists". provisionPlayerDefaults seeds the library from those
// same defaults under the same slugified filenames, so the pristine template always won the race
// into a new session and the player's progressed sheet was skipped. Reproduced by the CEO against
// the real module: a level-5 character with a Shortbow +1, a Bag of Holding and 430 gp entered a
// new session as a level-1 template with a Shortbow and Arrows (20).
describe('snapshotToSession precedence — the library outranks the campaign default', () => {
  const email = 'player@example.com';
  const campaign = 'demo';
  const sessionId = 'precedence-session';

  let libDir;
  let defaultCharDir;

  // The pristine template the character grew out of: level 1, starting kit, no purse.
  const pristineDefault = {
    id: 'char-7',
    name: 'Seraphina',
    level: 1,
    experience: 0,
    hitPoints: { current: 8, max: 8 },
    equipment: ['Shortbow', 'Arrows (20)'],
    gold: 10,
  };

  // The same character after thirty hours of play, as the player's library holds her.
  const progressedLibrary = {
    id: 'char-7',
    name: 'Seraphina',
    level: 5,
    experience: 6500,
    hitPoints: { current: 38, max: 44 },
    equipment: ['Shortbow +1', 'Bag of Holding', 'Arrows (14)'],
    gold: 430,
  };

  function writeSheet(dir, filename, data) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2));
  }

  function sessionSheets() {
    const dir = getSessionCharactersDir(tmpDir, sessionId);
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => ({ filename: f, data: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) }));
  }

  beforeEach(() => {
    ensurePlayerDataExists(tmpDir, email, campaign);
    libDir = getPlayerCharactersDir(tmpDir, email, campaign);
    defaultCharDir = path.join(tmpDir, 'defaults', campaign, 'characters');
  });

  it('a progressed character enters a new session at her real level, with her real gear and gold', () => {
    // Same filename in both tiers — the production case, because the library was seeded from
    // this very default file by provisionPlayerDefaults.
    writeSheet(defaultCharDir, 'seraphina.json', pristineDefault);
    writeSheet(libDir, 'seraphina.json', progressedLibrary);

    snapshotToSession(tmpDir, sessionId, email, campaign);

    const sheets = sessionSheets();
    expect(sheets).toHaveLength(1);
    const sheet = sheets[0].data;
    expect(sheet.level).toBe(5);
    expect(sheet.experience).toBe(6500);
    expect(sheet.equipment).toContain('Shortbow +1');
    expect(sheet.equipment).toContain('Bag of Holding');
    expect(sheet.equipment).not.toContain('Arrows (20)');
    expect(sheet.gold).toBe(430);
    expect(sheet.hitPoints).toEqual({ current: 38, max: 44 });
  });

  it('a character the library does not hold still comes from the campaign default', () => {
    writeSheet(defaultCharDir, 'seraphina.json', pristineDefault);
    writeSheet(defaultCharDir, 'tobin.json', { id: 'char-8', name: 'Tobin', level: 1, equipment: ['Club'] });
    writeSheet(libDir, 'seraphina.json', progressedLibrary);

    snapshotToSession(tmpDir, sessionId, email, campaign);

    const byId = Object.fromEntries(sessionSheets().map(s => [s.data.id, s.data]));
    expect(Object.keys(byId).sort()).toEqual(['char-7', 'char-8']);
    expect(byId['char-7'].level).toBe(5); // library
    expect(byId['char-8'].equipment).toEqual(['Club']); // default fills the gap
  });

  // DoD 2 / ADR 0006 §8.1. Filenames are slugified names, so renaming a character in the library
  // gives her a filename the default does not have. With a filename-keyed skip BOTH files land and
  // one id has two sheets, which entity-resolver reports as [RESOLVER:DUPLICATE] and resolves
  // newest-wins — i.e. by mtime, not by which one is the player's.
  it('a character renamed in the library cannot mint a second file for one id', () => {
    writeSheet(defaultCharDir, 'seraphina.json', pristineDefault);
    writeSheet(libDir, 'seraphina-of-the-vale.json', { ...progressedLibrary, name: 'Seraphina of the Vale' });

    snapshotToSession(tmpDir, sessionId, email, campaign);

    const sheets = sessionSheets();
    expect(sheets).toHaveLength(1);
    expect(sheets.filter(s => s.data.id === 'char-7')).toHaveLength(1);
    expect(sheets[0].filename).toBe('seraphina-of-the-vale.json');
    expect(sheets[0].data.level).toBe(5);
    expect(sheets[0].data.name).toBe('Seraphina of the Vale');
  });

  it('the id-keyed skip holds in the other direction too: a default renamed upstream adds nothing', () => {
    writeSheet(defaultCharDir, 'seraphina-the-swift.json', { ...pristineDefault, name: 'Seraphina the Swift' });
    writeSheet(libDir, 'seraphina.json', progressedLibrary);

    snapshotToSession(tmpDir, sessionId, email, campaign);

    const sheets = sessionSheets();
    expect(sheets).toHaveLength(1);
    expect(sheets[0].filename).toBe('seraphina.json');
    expect(sheets[0].data.level).toBe(5);
  });

  it('a second snapshot over a live session still changes nothing', () => {
    writeSheet(defaultCharDir, 'seraphina.json', pristineDefault);
    writeSheet(libDir, 'seraphina.json', progressedLibrary);
    snapshotToSession(tmpDir, sessionId, email, campaign);

    // Play happens: she loses the bag and drops to 4 hp, in the session copy only.
    const sessPath = path.join(getSessionCharactersDir(tmpDir, sessionId), 'seraphina.json');
    const inPlay = JSON.parse(fs.readFileSync(sessPath, 'utf-8'));
    inPlay.hitPoints.current = 4;
    inPlay.equipment = ['Shortbow +1', 'Arrows (2)'];
    fs.writeFileSync(sessPath, JSON.stringify(inPlay, null, 2));

    snapshotToSession(tmpDir, sessionId, email, campaign);

    const after = JSON.parse(fs.readFileSync(sessPath, 'utf-8'));
    expect(after.hitPoints.current).toBe(4);
    expect(after.equipment).not.toContain('Bag of Holding');
    expect(sessionSheets()).toHaveLength(1);
  });

  // DoD 5. NPCs are copied from campaign defaults only and this work order does not touch that.
  it('NPCs still come from campaign defaults only, and no player NPC directory is consulted', () => {
    writeSheet(defaultCharDir, 'seraphina.json', pristineDefault);
    writeSheet(libDir, 'seraphina.json', progressedLibrary);
    writeSheet(path.join(tmpDir, 'defaults', campaign, 'npcs'), 'pip.json', { id: 'npc-1', name: 'Pip', level: 2 });
    // A legacy players/<slug>/<campaign>/npcs/ directory exists for some accounts (project
    // CLAUDE.md, data structure). It is unused, and it stays unused.
    writeSheet(path.join(getPlayerCharactersDir(tmpDir, email, campaign), '..', 'npcs'), 'pip.json', { id: 'npc-1', name: 'Pip the Usurper', level: 20 });

    snapshotToSession(tmpDir, sessionId, email, campaign);

    const npcDir = getSessionNpcsDir(tmpDir, sessionId);
    const npcs = fs.readdirSync(npcDir).filter(f => f.endsWith('.json'));
    expect(npcs).toEqual(['pip.json']);
    const pip = JSON.parse(fs.readFileSync(path.join(npcDir, 'pip.json'), 'utf-8'));
    expect(pip.name).toBe('Pip');
    expect(pip.level).toBe(2);
  });

  it('a sheet with no id falls back to filename precedence and the library still wins', () => {
    writeSheet(defaultCharDir, 'nameless.json', { name: 'Nameless', level: 1 });
    writeSheet(libDir, 'nameless.json', { name: 'Nameless', level: 9 });

    snapshotToSession(tmpDir, sessionId, email, campaign);

    const sheets = sessionSheets();
    expect(sheets).toHaveLength(1);
    expect(sheets[0].data.level).toBe(9);
  });
});

// WO-0026, SDET review 2026-09-19. Four behaviours the delivered seven leave unpinned. Each was
// mutation-checked: P1 and P3 fail if the id-keyed skip is reverted to a filename-keyed one, P3
// also fails if copySheetsIfIdNotPresent stops updating its indexes as it writes, and P2 fails if
// the destination-parse try/catch is removed. Production code was not touched to write them.
describe('snapshotToSession precedence — SDET additions (WO-0026 review)', () => {
  const email = 'sdet-review@example.com';
  const campaign = 'demo';
  const sessionId = 'sdet-review-session';

  function writeSheet(dir, filename, data) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  }

  function sessionSheetNames() {
    return fs.readdirSync(getSessionCharactersDir(tmpDir, sessionId)).filter(f => f.endsWith('.json')).sort();
  }

  beforeEach(() => {
    ensurePlayerDataExists(tmpDir, email, campaign);
  });

  // The behaviour change the author flagged for a deliberate ruling: a rename in the library while
  // a session is LIVE. It used to mint a second file for one id (resolved newest-wins by mtime,
  // with a [RESOLVER:DUPLICATE] warning); now the session keeps the sheet it has, with its
  // in-session progress. The delivered re-snapshot test does not cover this — its filenames match,
  // so the filename check alone carries it.
  it('a library rename mid-session neither mints a second sheet nor claws back in-session progress', () => {
    const libDir = getPlayerCharactersDir(tmpDir, email, campaign);
    writeSheet(path.join(tmpDir, 'defaults', campaign, 'characters'), 'seraphina.json', { id: 'char-7', name: 'Seraphina', level: 1 });
    writeSheet(libDir, 'seraphina.json', { id: 'char-7', name: 'Seraphina', level: 5, hitPoints: { current: 38, max: 44 } });
    snapshotToSession(tmpDir, sessionId, email, campaign);

    // A turn is played: she takes damage in the session copy only.
    const sessionPath = path.join(getSessionCharactersDir(tmpDir, sessionId), 'seraphina.json');
    const inPlay = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
    inPlay.hitPoints.current = 4;
    fs.writeFileSync(sessionPath, JSON.stringify(inPlay, null, 2));

    // The player renames her in the library while the session is live.
    fs.unlinkSync(path.join(libDir, 'seraphina.json'));
    writeSheet(libDir, 'seraphina-of-the-vale.json', { id: 'char-7', name: 'Seraphina of the Vale', level: 5, hitPoints: { current: 44, max: 44 } });

    snapshotToSession(tmpDir, sessionId, email, campaign); // the next turn fire

    expect(sessionSheetNames()).toEqual(['seraphina.json']);
    expect(JSON.parse(fs.readFileSync(sessionPath, 'utf-8')).hitPoints.current).toBe(4);
  });

  // The one new failure mode this change introduces: the destination directory is now PARSED, and
  // it is parsed on every turn fire. A corrupt session sheet must not take the snapshot down.
  it('an unparseable sheet already in the session does not abort the snapshot', () => {
    writeSheet(getPlayerCharactersDir(tmpDir, email, campaign), 'seraphina.json', { id: 'char-7', level: 5 });
    writeSheet(getSessionCharactersDir(tmpDir, sessionId), 'corrupt.json', '{ this is not json');

    expect(() => snapshotToSession(tmpDir, sessionId, email, campaign)).not.toThrow();
    expect(sessionSheetNames()).toEqual(['corrupt.json', 'seraphina.json']);
  });

  // The indexes are updated as the loop writes, so one id cannot land twice from a single source
  // directory either — a library that already holds a duplicate (the very state the old
  // filename-keyed snapshot could create) does not propagate it into a new session.
  it('two sheets in one source directory sharing an id yield a single session sheet', () => {
    const libDir = getPlayerCharactersDir(tmpDir, email, campaign);
    writeSheet(libDir, 'a-seraphina.json', { id: 'char-7', name: 'Seraphina', level: 5 });
    writeSheet(libDir, 'b-seraphina.json', { id: 'char-7', name: 'Seraphina (copy)', level: 5 });

    snapshotToSession(tmpDir, sessionId, email, campaign);

    expect(sessionSheetNames()).toHaveLength(1);
  });

  // Campaign isolation is the invariant the reordering rides on: the library read is per-campaign,
  // and making the library win must not make another campaign's library win anything.
  it('the reordering does not reach across campaigns', () => {
    writeSheet(getPlayerCharactersDir(tmpDir, email, 'campaign1'), 'intruder.json', { id: 'char-99', name: 'Intruder', level: 20 });
    writeSheet(path.join(tmpDir, 'defaults', campaign, 'characters'), 'seraphina.json', { id: 'char-7', level: 1 });

    snapshotToSession(tmpDir, sessionId, email, campaign);

    expect(sessionSheetNames()).toEqual(['seraphina.json']);
  });

  // WO-0026 revision 2, SDET delta review. The SEC-1 fix reads through safeReadJsonFile rather
  // than a bare try/catch for exactly one stated reason: it re-reads once before giving up,
  // because the DM's Edit tool writes these sheets non-atomically and this copier runs on every
  // turn fire, so "the read failed" and "the file is corrupt" are different events here. Nothing
  // pinned that. json-recovery.js has no test file of its own, safeReadJsonFile is named by no
  // other test, and replacing the call with a bare try/catch + continue passes the whole suite.
  // A transient read must cost the player nothing; permanent corruption is what the six SEC-1
  // tests cover. Fails if the retry is dropped (bare catch, or safeReadJsonFile's loop bound
  // reduced to one attempt).
  it('a library sheet that fails to parse once and reads cleanly on the retry is still copied', () => {
    const libDir = getPlayerCharactersDir(tmpDir, email, campaign);
    writeSheet(libDir, 'seraphina.json', { id: 'char-7', name: 'Seraphina', level: 5 });
    const target = path.join(libDir, 'seraphina.json');
    const good = fs.readFileSync(target, 'utf-8');

    // The first read of THIS file returns a truncated buffer — what a mid-write Edit looks like.
    // Every later read, and every read of every other file, is the real one.
    let firstReadIntercepted = false;
    const realRead = fs.readFileSync;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => {
      if (String(p) === target && !firstReadIntercepted) {
        firstReadIntercepted = true;
        return good.slice(0, 12);
      }
      return realRead.call(fs, p, ...rest);
    });
    try {
      snapshotToSession(tmpDir, sessionId, email, campaign);
    } finally {
      spy.mockRestore();
    }

    expect(firstReadIntercepted).toBe(true); // the fixture took effect; not a vacuous pass
    expect(sessionSheetNames()).toEqual(['seraphina.json']);
    const copied = JSON.parse(fs.readFileSync(path.join(getSessionCharactersDir(tmpDir, sessionId), 'seraphina.json'), 'utf-8'));
    expect(copied.level).toBe(5);
    expect(copied.name).toBe('Seraphina');
  });
});

// WO-0026 SEC-1 (security-reviewer, FAIL on revision 1). The reordering made an old throw much
// worse: the source parse in copySheetsIfIdNotPresent had no try, and with the library copied
// FIRST one unparseable library sheet aborted the snapshot before any campaign default had
// landed — a joinable session with zero characters, repeated on every turn fire. Measured then:
//   OLD (defaults first) -> threw | session party 4/4 -> PLAYABLE
//   NEW (library first)  -> threw | session party 0/4 -> <EMPTY>
// These tests pin the half SDET's mutation E did not reach: E pinned the DESTINATION catch, this
// is the SOURCE read. They fail against revision 1.
describe('snapshotToSession — an unreadable library sheet costs one character, never the party (WO-0026 SEC-1)', () => {
  const email = 'sec1@example.com';
  const campaign = 'demo';

  function writeSheet(dir, filename, data) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  }

  function sessionParty(sessionId) {
    const dir = getSessionCharactersDir(tmpDir, sessionId);
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .map(f => ({ filename: f, data: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) }));
  }

  // The security reviewer's fixture: four campaign defaults, and a library holding one progressed
  // sheet plus one file that will not parse.
  function seedFourDefaults() {
    const defaults = path.join(tmpDir, 'defaults', campaign, 'characters');
    writeSheet(defaults, 'aria.json', { id: 'char-1', name: 'Aria', level: 1 });
    writeSheet(defaults, 'borin.json', { id: 'char-2', name: 'Borin', level: 1 });
    writeSheet(defaults, 'cassia.json', { id: 'char-3', name: 'Cassia', level: 1 });
    writeSheet(defaults, 'hero.json', { id: 'char-4', name: 'Hero', level: 1, equipment: ['Shortbow'] });
    return defaults;
  }

  beforeEach(() => {
    ensurePlayerDataExists(tmpDir, email, campaign);
  });

  it('a corrupt library sheet does not empty the party: the defaults still land and progression still wins', () => {
    seedFourDefaults();
    const libDir = getPlayerCharactersDir(tmpDir, email, campaign);
    // The player's real, progressed Hero — this must still reach the session.
    writeSheet(libDir, 'hero.json', { id: 'char-4', name: 'Hero', level: 5, equipment: ['Shortbow +1', 'Bag of Holding'] });
    // ...and a sheet that will not parse, sorting BEFORE it so the old code threw first.
    writeSheet(libDir, 'aria.json', '{ "id": "char-1", "name": "Ar');

    expect(() => snapshotToSession(tmpDir, 'sec1-session', email, campaign)).not.toThrow();

    const party = sessionParty('sec1-session');
    expect(party.map(p => p.data.id).sort()).toEqual(['char-1', 'char-2', 'char-3', 'char-4']);
    // The character whose library sheet was unreadable falls back to the campaign default...
    expect(party.find(p => p.data.id === 'char-1').data.level).toBe(1);
    // ...and every other character is unaffected: Hero is still the library's level 5.
    expect(party.find(p => p.data.id === 'char-4').data.level).toBe(5);
    expect(party.find(p => p.data.id === 'char-4').data.equipment).toContain('Bag of Holding');
  });

  it('the party does not depend on where the corrupt file falls in the directory listing', () => {
    // Same corruption, two filenames. Revision 1 gave 0/4 for "aaa-" and 1/4 for "zzz-" because
    // readdir order on ext4 is hash order; the party a player got depended on a filename.
    for (const [n, corruptName] of [['aaa', 'aaa-corrupt.json'], ['zzz', 'zzz-corrupt.json']]) {
      seedFourDefaults();
      writeSheet(getPlayerCharactersDir(tmpDir, email, campaign), corruptName, 'not json at all');
      snapshotToSession(tmpDir, `sec1-order-${n}`, email, campaign);
    }
    const aaa = sessionParty('sec1-order-aaa').map(p => p.data.id).sort();
    const zzz = sessionParty('sec1-order-zzz').map(p => p.data.id).sort();
    expect(aaa).toEqual(['char-1', 'char-2', 'char-3', 'char-4']);
    expect(zzz).toEqual(aaa);
  });

  it('later turn fires are not poisoned either, and in-session play survives them', () => {
    // snapshotToSession runs on EVERY turn fire (ADR 0001), so revision 1 failed again on turns
    // 2 and 3 and copied nothing again. The corrupt file is left in place throughout.
    seedFourDefaults();
    writeSheet(getPlayerCharactersDir(tmpDir, email, campaign), 'broken.json', '{{{');
    const sessionId = 'sec1-turns';
    snapshotToSession(tmpDir, sessionId, email, campaign);

    const ariaPath = path.join(getSessionCharactersDir(tmpDir, sessionId), 'aria.json');
    const inPlay = JSON.parse(fs.readFileSync(ariaPath, 'utf-8'));
    inPlay.hitPoints = { current: 3, max: 11 };
    fs.writeFileSync(ariaPath, JSON.stringify(inPlay, null, 2));

    expect(() => snapshotToSession(tmpDir, sessionId, email, campaign)).not.toThrow(); // turn 2
    expect(() => snapshotToSession(tmpDir, sessionId, email, campaign)).not.toThrow(); // turn 3

    expect(sessionParty(sessionId).map(p => p.filename)).toEqual(['aria.json', 'borin.json', 'cassia.json', 'hero.json']);
    expect(JSON.parse(fs.readFileSync(ariaPath, 'utf-8')).hitPoints.current).toBe(3);
  });

  it('the skipped file is reported on the server log, named, and is not a silent drop', () => {
    seedFourDefaults();
    writeSheet(getPlayerCharactersDir(tmpDir, email, campaign), 'broken.json', '{ "id": ');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let logged;
    try {
      snapshotToSession(tmpDir, 'sec1-log', email, campaign);
      // Read the calls BEFORE restoring: mockRestore() clears mock.calls as well as the stub.
      logged = spy.mock.calls.map(c => String(c[0]));
    } finally {
      spy.mockRestore();
    }
    expect(logged.some(line => line.includes('broken.json'))).toBe(true);
    expect(logged.some(line => /skipping unreadable character sheet/i.test(line))).toBe(true);
  });

  it('a library-only character with an unreadable sheet is the only thing lost', () => {
    // No campaign default to fall back on: that one character is absent, everything else stands.
    seedFourDefaults();
    const libDir = getPlayerCharactersDir(tmpDir, email, campaign);
    writeSheet(libDir, 'homebrew.json', '[[[not json');
    snapshotToSession(tmpDir, 'sec1-libonly', email, campaign);

    const party = sessionParty('sec1-libonly');
    expect(party.map(p => p.filename)).toEqual(['aria.json', 'borin.json', 'cassia.json', 'hero.json']);
  });

  it('an unreadable CAMPAIGN DEFAULT is skipped too, and the library characters still arrive', () => {
    // The same loop serves both passes. A bad default must not cost the player the sheets the
    // library already provided (which are, after the reordering, copied first and already on disk).
    const defaults = seedFourDefaults();
    fs.writeFileSync(path.join(defaults, 'cassia.json'), 'corrupt');
    writeSheet(getPlayerCharactersDir(tmpDir, email, campaign), 'hero.json', { id: 'char-4', name: 'Hero', level: 5 });

    expect(() => snapshotToSession(tmpDir, 'sec1-default', email, campaign)).not.toThrow();

    const party = sessionParty('sec1-default');
    expect(party.map(p => p.data.id).sort()).toEqual(['char-1', 'char-2', 'char-4']);
    expect(party.find(p => p.data.id === 'char-4').data.level).toBe(5);
  });
});
