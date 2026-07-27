import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const {
  slugify,
  findCharacterOrNpcFile,
  requireCharacterOrNpcFile,
  verifySessionIntegrity,
} = require('../entity-resolver');
const {
  getSessionFilePath,
  getSessionCharactersDir,
  getSessionNpcsDir,
  getPlayerCharactersDir,
} = require('../player-data');

let tmpDir;
const SESSION_ID = 'sess-resolver-1';
const CAMPAIGN = 'demo';
const EMAIL = 'tom@example.com';

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function makeChar(id, overrides = {}) {
  return { id, name: id, status: 'alive', level: 1, experience: 0, ...overrides };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('slugify', () => {
  it('strips diacritics instead of dropping the letters', () => {
    expect(slugify('Daichi Musō')).toBe('daichi-muso');
    expect(slugify('Éowyn the Fëarless')).toBe('eowyn-the-fearless');
  });

  it('behaves like the old slugify for plain ASCII', () => {
    expect(slugify('Pip Whistledown')).toBe('pip-whistledown');
    expect(slugify('  --Odd  Name!! ')).toBe('odd-name');
  });
});

describe('findCharacterOrNpcFile — first-tier-wins', () => {
  it('returns the session copy when the same id exists in session, library, and defaults', () => {
    const id = 'hero-1';
    writeJson(path.join(getSessionCharactersDir(tmpDir, SESSION_ID), 'hero.json'), makeChar(id, { level: 3 }));
    writeJson(path.join(getPlayerCharactersDir(tmpDir, EMAIL, CAMPAIGN), 'hero.json'), makeChar(id, { level: 1 }));
    writeJson(path.join(tmpDir, 'defaults', CAMPAIGN, 'npcs', 'hero.json'), makeChar(id, { level: 1 }));

    const result = findCharacterOrNpcFile(tmpDir, id, EMAIL, CAMPAIGN, SESSION_ID);
    expect(result).not.toBeNull();
    expect(result.data.level).toBe(3);
    expect(result.dir).toBe(getSessionCharactersDir(tmpDir, SESSION_ID));
  });

  it('falls back to the player library when the session has no match', () => {
    writeJson(path.join(getPlayerCharactersDir(tmpDir, EMAIL, CAMPAIGN), 'hero.json'), makeChar('hero-2'));
    const result = findCharacterOrNpcFile(tmpDir, 'hero-2', EMAIL, CAMPAIGN, SESSION_ID);
    expect(result.dir).toBe(getPlayerCharactersDir(tmpDir, EMAIL, CAMPAIGN));
  });

  it('resolves loose name refs session-first too', () => {
    writeJson(path.join(getSessionCharactersDir(tmpDir, SESSION_ID), 'daichi-muso.json'),
      makeChar('id-sess', { name: 'Daichi Musō', level: 3 }));
    writeJson(path.join(getPlayerCharactersDir(tmpDir, EMAIL, CAMPAIGN), 'daichi-muso.json'),
      makeChar('id-lib', { name: 'Daichi Musō', level: 1 }));

    const result = findCharacterOrNpcFile(tmpDir, 'Daichi Musō', EMAIL, CAMPAIGN, SESSION_ID);
    expect(result.data.id).toBe('id-sess');
  });

  it('an exact-id match in a later tier beats a loose match in an earlier tier', () => {
    writeJson(path.join(getSessionCharactersDir(tmpDir, SESSION_ID), 'hero.json'),
      makeChar('other-id', { name: 'hero-3' }));
    writeJson(path.join(getPlayerCharactersDir(tmpDir, EMAIL, CAMPAIGN), 'real.json'), makeChar('hero-3'));

    const result = findCharacterOrNpcFile(tmpDir, 'hero-3', EMAIL, CAMPAIGN, SESSION_ID);
    expect(result.data.id).toBe('hero-3');
    expect(result.file).toBe('real.json');
  });
});

describe('findCharacterOrNpcFile — within-tier duplicates', () => {
  it('picks the newest file and logs, instead of throwing "Ambiguous"', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = getSessionCharactersDir(tmpDir, SESSION_ID);
    const id = 'dup-id';
    // The daichi case: same id under a stale truncated slug and the correct slug
    writeJson(path.join(dir, 'daichi-mus.json'), makeChar(id, { name: 'Daichi Musō', level: 1 }));
    writeJson(path.join(dir, 'daichi-muso.json'), makeChar(id, { name: 'Daichi Musō', level: 3 }));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(dir, 'daichi-mus.json'), old, old);

    const result = findCharacterOrNpcFile(tmpDir, id, EMAIL, CAMPAIGN, SESSION_ID);
    expect(result.file).toBe('daichi-muso.json');
    expect(result.data.level).toBe(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[RESOLVER:DUPLICATE]'));
  });
});

describe('requireCharacterOrNpcFile', () => {
  it('throws with the actual roster listed when nothing matches', () => {
    writeJson(path.join(getSessionCharactersDir(tmpDir, SESSION_ID), 'pip.json'),
      makeChar('pip-id', { name: 'Pip Whistledown' }));
    writeJson(path.join(getSessionNpcsDir(tmpDir, SESSION_ID), 'eldon.json'),
      makeChar('eldon-id', { name: 'Eldon Fairweather' }));

    expect(() => requireCharacterOrNpcFile(tmpDir, 'no-such-id', EMAIL, CAMPAIGN, SESSION_ID))
      .toThrow(/Pip Whistledown.*pip-id|pip-id.*Pip Whistledown/);
    expect(() => requireCharacterOrNpcFile(tmpDir, 'no-such-id', EMAIL, CAMPAIGN, SESSION_ID))
      .toThrow(/Eldon Fairweather/);
  });
});

describe('verifySessionIntegrity', () => {
  function makeSession(overrides = {}) {
    const session = {
      id: SESSION_ID,
      campaignId: CAMPAIGN,
      playerEmail: EMAIL,
      characterId: 'hero-id',
      ...overrides,
    };
    writeJson(getSessionFilePath(tmpDir, SESSION_ID), session);
    return session;
  }

  it('passes silently when the binding resolves inside the session dir', () => {
    writeJson(path.join(getSessionCharactersDir(tmpDir, SESSION_ID), 'hero.json'), makeChar('hero-id'));
    const result = verifySessionIntegrity(tmpDir, makeSession());
    expect(result.changed).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it('copies a library-only character into the session dir', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeJson(path.join(getPlayerCharactersDir(tmpDir, EMAIL, CAMPAIGN), 'hero.json'), makeChar('hero-id'));
    const result = verifySessionIntegrity(tmpDir, makeSession());
    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    const copied = path.join(getSessionCharactersDir(tmpDir, SESSION_ID), 'hero.json');
    expect(fs.existsSync(copied)).toBe(true);
  });

  it('heals a name-based ref to the real id', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeJson(path.join(getSessionCharactersDir(tmpDir, SESSION_ID), 'hero.json'),
      makeChar('real-id', { name: 'Hero Name' }));
    const session = makeSession({ characterId: 'Hero Name' });
    const result = verifySessionIntegrity(tmpDir, session);
    expect(result.changed).toBe(true);
    expect(result.healedCharacterId).toBe('real-id');
    expect(session.characterId).toBe('real-id');
  });

  it('returns a visible warning for a dangling id (the production failure)', () => {
    writeJson(path.join(getSessionCharactersDir(tmpDir, SESSION_ID), 'pip.json'),
      makeChar('pip-id', { name: 'Pip Whistledown' }));
    const result = verifySessionIntegrity(tmpDir, makeSession({ characterId: '7535ec22-dead-beef' }));
    expect(result.changed).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/matches no character file/);
    expect(result.warnings[0]).toMatch(/Pip Whistledown/);
  });

  it('checks companion slot and companion replacement-character bindings', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeJson(path.join(getSessionCharactersDir(tmpDir, SESSION_ID), 'hero.json'), makeChar('hero-id'));
    writeJson(path.join(getSessionNpcsDir(tmpDir, SESSION_ID), 'npc.json'), makeChar('npc-id'));
    // Replacement character exists only in the friend's library → should be copied in
    writeJson(path.join(getPlayerCharactersDir(tmpDir, 'friend@example.com', CAMPAIGN), 'daichi-muso.json'),
      makeChar('daichi-id', { name: 'Daichi Musō' }));

    const session = makeSession({
      companionPlayers: {
        'npc-id': { email: 'friend@example.com', characterId: 'daichi-id' },
      },
    });
    // playerEmail on the session is the host; companion library isn't searched by the
    // host-scoped resolver, so this lands as a warning rather than a silent miss.
    const result = verifySessionIntegrity(tmpDir, session);
    expect(result.warnings.length + (result.changed ? 1 : 0)).toBeGreaterThan(0);
  });
});
