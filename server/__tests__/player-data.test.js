import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
