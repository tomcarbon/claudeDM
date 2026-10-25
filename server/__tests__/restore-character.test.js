// WO-0016 — restoring a character from the player's library into a live session.
//
// The path these tests cover has never been walked in play. The CEO's structure-only survey of
// the chair's data after several hours of real play found: zero characters at 0 HP, zero deaths,
// zero death-save state, zero override records. WO-0015's arithmetic guarantee has run on every
// damage roll of those hours; the death machinery it wraps has not fired once. So until the
// evening it matters, these tests are the only evidence the restore works, and they are written
// on that assumption — the deaths below are computed by the real state machine in vitals-utils
// rather than written onto the sheet by hand, because a fixture that hand-writes `status: "dead"`
// proves the route can copy a file and nothing about whether it can undo a death.
//
// Nothing here starts an agent. The route is HTTP and the death is a pure function plus a write.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import express from 'express';

const { applyVitals } = require('../vitals-utils');
const { updateSessionFile, emailToSlug } = require('../player-data');
const { _testing: { findCharacterSeat, isDownOrDead, listSessionCharacterIds } } = require('../routes/sessions');

const HOST = { email: 'host@test.com', name: 'Tom', role: 'player' };
const FRIEND = { email: 'friend@test.com', name: 'Sam', role: 'player' };
const STRANGER = { email: 'stranger@test.com', name: 'Nobody', role: 'player' };
const ADMIN = { email: 'admin@test.com', name: 'Admin', role: 'admin' };

const SID = 'sess-restore-1';
const CAMPAIGN = 'demo';

let tmpDir;
let server;
let baseUrl;

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function sessionCharPath(file) {
  return path.join(tmpDir, 'sessions', SID, 'characters', file);
}

function libraryPath(email, file) {
  return path.join(tmpDir, 'players', emailToSlug(email), CAMPAIGN, 'characters', file);
}

function sessionJsonPath() {
  return path.join(tmpDir, 'sessions', SID, 'session.json');
}

// The library sheet: the character exactly as she was when the session began. Level 2, 300 XP,
// full hit points. Nothing in the server writes back to this file, which is the whole premise.
function librarySheet(overrides = {}) {
  return {
    id: 'char-kaelara',
    name: 'Kaelara Brightflame',
    status: 'alive',
    class: 'Cleric',
    level: 2,
    experience: 300,
    proficiencyBonus: 2,
    hitPoints: { max: 10, current: 10 },
    armorClass: 15,
    equipment: ['Mace', 'Rations (3)'],
    spellSlotsUsed: {},
    _filename: 'kaelara.json',
    ...overrides,
  };
}

// The session sheet: the same character after a few hours of play. Levelled, richer, hurt.
// Everything that differs from the library copy is what a restore is agreeing to discard.
function sessionSheet(overrides = {}) {
  return {
    ...librarySheet(),
    level: 3,
    experience: 900,
    proficiencyBonus: 2,
    hitPoints: { max: 10, current: 5 },
    equipment: ['Mace', 'Rations (1)', 'Sunblade of the Third Dawn'],
    spellSlotsUsed: { level1: 2 },
    _filename: 'kaelara.json',
    ...overrides,
  };
}

function companionLibrarySheet(overrides = {}) {
  return {
    id: 'char-daichi',
    name: 'Daichi Muso',
    status: 'alive',
    class: 'Monk',
    level: 2,
    hitPoints: { max: 12, current: 12 },
    equipment: ['Quarterstaff'],
    _filename: 'daichi.json',
    ...overrides,
  };
}

function makeSession(overrides = {}) {
  return {
    id: SID,
    name: 'Test Session',
    campaignId: CAMPAIGN,
    scenarioId: 'demo',
    characterId: 'char-kaelara',
    ownerEmail: HOST.email,
    ownerName: HOST.name,
    playerEmail: HOST.email,
    playerName: HOST.name,
    status: 'active',
    messages: [],
    settings: { visibility: 'public' },
    players: [{ email: HOST.email, name: HOST.name, role: 'owner' }],
    companionConfig: { states: { 'npc-1': 'player' }, reservations: {} },
    companionPlayers: {
      'npc-1': { email: FRIEND.email, name: FRIEND.name, characterId: 'char-daichi', characterName: 'Daichi Muso' },
    },
    worldState: {},
    ...overrides,
  };
}

function post(urlPath, body, email) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const payload = JSON.stringify(body || {});
    const req = http.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(email ? { 'x-player-email': email } : {}),
        'x-campaign-id': CAMPAIGN,
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function restore(body, email) {
  return post(`/api/sessions/${SID}/restore-character`, body, email);
}

/** Kill Kaelara the way the game does: enough damage in one blow for instant death. */
function killKaelara() {
  return applyVitals(tmpDir, { action: 'damage', characterId: 'char-kaelara', amount: 40 },
    { playerEmail: HOST.email, campaignId: CAMPAIGN, sessionId: SID });
}

/** Drop Kaelara to 0 without killing her, then land one more hit for a death-save failure. */
function downKaelara() {
  const ctx = { playerEmail: HOST.email, campaignId: CAMPAIGN, sessionId: SID };
  applyVitals(tmpDir, { action: 'damage', characterId: 'char-kaelara', amount: 5 }, ctx);
  return applyVitals(tmpDir, { action: 'damage', characterId: 'char-kaelara', amount: 1 }, ctx);
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-char-'));

  // Real rules files: the death machine reads its numbers out of them, so the deaths these tests
  // compute are the deaths the shipped game computes.
  const realRules = path.join(__dirname, '..', '..', 'data', 'rules');
  fs.mkdirSync(path.join(tmpDir, 'rules'), { recursive: true });
  for (const f of ['combat.json', 'classes.json', 'leveling.json']) {
    fs.copyFileSync(path.join(realRules, f), path.join(tmpDir, 'rules', f));
  }

  writeJson(path.join(tmpDir, 'players.json'), {
    [HOST.email]: HOST, [FRIEND.email]: FRIEND, [STRANGER.email]: STRANGER, [ADMIN.email]: ADMIN,
  });
  writeJson(sessionJsonPath(), makeSession());
  writeJson(sessionCharPath('kaelara.json'), sessionSheet());
  writeJson(sessionCharPath('daichi.json'), { ...companionLibrarySheet(), hitPoints: { max: 12, current: 4 } });
  writeJson(libraryPath(HOST.email, 'kaelara.json'), librarySheet());
  writeJson(libraryPath(FRIEND.email, 'daichi.json'), companionLibrarySheet());

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.campaignId = req.get('x-campaign-id') || CAMPAIGN; next(); });
  app.use('/api/sessions', require('../routes/sessions')(tmpDir));
  await new Promise(r => { server = app.listen(0, r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise(r => server.close(r));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── The premise ───────────────────────────────────────────────────────────────────────────────

describe('the premise: nothing writes back to the library, so the pre-death character is already on disk', () => {
  it('a computed death changes the session copy and leaves the library copy untouched', () => {
    const before = readJson(libraryPath(HOST.email, 'kaelara.json'));
    const outcome = killKaelara();

    expect(outcome.outcome).toBe('death');
    expect(readJson(sessionCharPath('kaelara.json')).status).toBe('dead');
    // If this ever fails, the restore route is restoring from a file that already knows about the
    // death, and this whole work order's cheapness argument has gone with it.
    expect(readJson(libraryPath(HOST.email, 'kaelara.json'))).toEqual(before);
  });
});

// ── The happy path ────────────────────────────────────────────────────────────────────────────

describe('restoring after a computed death', () => {
  it('brings the character back as they were when the session began', async () => {
    killKaelara();

    const res = await restore({ characterId: 'char-kaelara', confirm: true }, HOST.email);

    expect(res.status).toBe(200);
    expect(res.body.restored).toBe(true);
    expect(res.body.name).toBe('Kaelara Brightflame');
    expect(res.body.hitPoints).toEqual({ current: 10, max: 10 });

    const onDisk = readJson(sessionCharPath('kaelara.json'));
    expect(onDisk.status).toBe('alive');
    expect(onDisk.hitPoints).toEqual({ max: 10, current: 10 });
    // The character, not a level-1 template: this is the whole difference from reset-my-data.
    expect(onDisk.name).toBe('Kaelara Brightflame');
    expect(onDisk.level).toBe(2);
    expect(onDisk.experience).toBe(300);
  });

  it('discards the in-session progress it said it would discard, and nothing else', async () => {
    killKaelara();
    await restore({ characterId: 'char-kaelara', confirm: true }, HOST.email);

    const onDisk = readJson(sessionCharPath('kaelara.json'));
    // Gone, because it happened during the session: the level, the XP, the loot, the spent slots.
    expect(onDisk.level).toBe(2);
    expect(onDisk.experience).toBe(300);
    expect(onDisk.equipment).not.toContain('Sunblade of the Third Dawn');
    expect(onDisk.spellSlotsUsed).toEqual({});
    // Kept, because it is the library copy verbatim.
    expect(onDisk.armorClass).toBe(15);
    expect(onDisk.class).toBe('Cleric');
  });

  it('restores a character who is down at 0 HP but not yet dead', async () => {
    downKaelara();
    const downed = readJson(sessionCharPath('kaelara.json'));
    expect(downed.status).toBe('alive');
    expect(downed.hitPoints.current).toBe(0);
    expect(downed.deathSaves.failures).toBe(1);

    const res = await restore({ characterId: 'char-kaelara', confirm: true }, HOST.email);
    expect(res.status).toBe(200);
    expect(readJson(sessionCharPath('kaelara.json')).hitPoints.current).toBe(10);
  });

  it('clears death-save state', async () => {
    downKaelara();
    expect(readJson(sessionCharPath('kaelara.json')).deathSaves).toBeTruthy();

    await restore({ characterId: 'char-kaelara', confirm: true }, HOST.email);
    expect(readJson(sessionCharPath('kaelara.json')).deathSaves).toBeUndefined();
  });

  it('clears death-save state even when the library copy is carrying some', async () => {
    // The library copy should never have this — nothing writes back to it. "Should never" is not
    // a guarantee, and the route deletes the field rather than copying whatever it finds.
    writeJson(libraryPath(HOST.email, 'kaelara.json'),
      librarySheet({ deathSaves: { successes: 2, failures: 1, stable: false } }));
    killKaelara();

    await restore({ characterId: 'char-kaelara', confirm: true }, HOST.email);
    expect(readJson(sessionCharPath('kaelara.json')).deathSaves).toBeUndefined();
  });

  it('lets a companion player restore their own character', async () => {
    applyVitals(tmpDir, { action: 'damage', characterId: 'char-daichi', amount: 40 },
      { playerEmail: FRIEND.email, campaignId: CAMPAIGN, sessionId: SID });
    expect(readJson(sessionCharPath('daichi.json')).status).toBe('dead');

    const res = await restore({ characterId: 'char-daichi', confirm: true }, FRIEND.email);
    expect(res.status).toBe(200);
    expect(res.body.seat).toBe('companion');
    expect(readJson(sessionCharPath('daichi.json')).hitPoints.current).toBe(12);
  });

  it('writes over the session\'s own file rather than minting a second one from the name', async () => {
    // The session file is named differently from the library file — the shape that produced
    // daichi-mus.json and daichi-muso.json for one character.
    fs.renameSync(sessionCharPath('kaelara.json'), sessionCharPath('kaelara-brightflame.json'));
    writeJson(sessionCharPath('kaelara-brightflame.json'),
      sessionSheet({ _filename: 'kaelara-brightflame.json' }));
    killKaelara();

    const res = await restore({ characterId: 'char-kaelara', confirm: true }, HOST.email);
    expect(res.status).toBe(200);

    const files = fs.readdirSync(path.join(tmpDir, 'sessions', SID, 'characters')).sort();
    expect(files).toEqual(['daichi.json', 'kaelara-brightflame.json']);
    expect(readJson(sessionCharPath('kaelara-brightflame.json'))._filename).toBe('kaelara-brightflame.json');
  });
});

// ── Visible to the party ──────────────────────────────────────────────────────────────────────

describe('the party is told', () => {
  it('puts a system message in the transcript naming the character, the player and the cost', async () => {
    killKaelara();
    const res = await restore({ characterId: 'char-kaelara', confirm: true }, HOST.email);

    const saved = readJson(sessionJsonPath());
    const notice = saved.messages.find(m => m.type === 'system');
    expect(notice).toBeTruthy();
    expect(notice.text).toContain('Kaelara Brightflame');
    expect(notice.text).toContain('Tom');           // who did it
    expect(notice.text).toContain('10/10');          // what state they are in now
    expect(notice.text).toContain('replaced');       // what it cost
    expect(res.body.notice).toBe(notice.text);
  });

  it('writes nothing to the transcript when the restore is refused', async () => {
    const res = await restore({ characterId: 'char-kaelara', confirm: true }, HOST.email);
    expect(res.status).toBe(409);
    expect(readJson(sessionJsonPath()).messages).toEqual([]);
  });
});

// ── Refusals ──────────────────────────────────────────────────────────────────────────────────

describe('refusals', () => {
  it('refuses while the character is alive and on their feet, and says the hit points', async () => {
    const res = await restore({ characterId: 'char-kaelara', confirm: true }, HOST.email);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('alive at 5/10 hit points');
    expect(readJson(sessionCharPath('kaelara.json')).experience).toBe(900);
  });

  it('refuses a restore of somebody else\'s character', async () => {
    killKaelara();
    const res = await restore({ characterId: 'char-kaelara', confirm: true }, FRIEND.email);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Tom');
    expect(readJson(sessionCharPath('kaelara.json')).status).toBe('dead');
  });

  it('refuses the host acting on a companion player\'s behalf — it is their character', async () => {
    applyVitals(tmpDir, { action: 'damage', characterId: 'char-daichi', amount: 40 },
      { playerEmail: FRIEND.email, campaignId: CAMPAIGN, sessionId: SID });

    const res = await restore({ characterId: 'char-daichi', confirm: true }, HOST.email);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Sam');
    expect(readJson(sessionCharPath('daichi.json')).status).toBe('dead');
  });

  it('refuses an admin who is not the character\'s player', async () => {
    killKaelara();
    const res = await restore({ characterId: 'char-kaelara', confirm: true }, ADMIN.email);
    expect(res.status).toBe(403);
    expect(readJson(sessionCharPath('kaelara.json')).status).toBe('dead');
  });

  it('refuses a guest', async () => {
    killKaelara();
    const res = await restore({ characterId: 'char-kaelara', confirm: true }, null);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Login required');
  });

  it('refuses an unconfirmed POST and says what the confirmation is for', async () => {
    killKaelara();
    const res = await restore({ characterId: 'char-kaelara' }, HOST.email);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('discards everything');
    expect(readJson(sessionCharPath('kaelara.json')).status).toBe('dead');
  });

  it('says so usefully rather than 500-ing when there is no library copy', async () => {
    killKaelara();
    fs.unlinkSync(libraryPath(HOST.email, 'kaelara.json'));

    const res = await restore({ characterId: 'char-kaelara', confirm: true }, HOST.email);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('no saved copy of Kaelara Brightflame');
    expect(res.body.error).toContain('Nothing has been changed');
    expect(readJson(sessionCharPath('kaelara.json')).status).toBe('dead');
  });

  it('refuses when the library copy is itself dead — a restore that costs everything and gives nothing', async () => {
    killKaelara();
    writeJson(libraryPath(HOST.email, 'kaelara.json'),
      librarySheet({ status: 'dead', hitPoints: { max: 10, current: 0 } }));

    const res = await restore({ characterId: 'char-kaelara', confirm: true }, HOST.email);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('itself dead');
    expect(readJson(sessionCharPath('kaelara.json')).experience).toBe(900);
  });

  it('refuses when the library copy is at 0 hit points', async () => {
    killKaelara();
    writeJson(libraryPath(HOST.email, 'kaelara.json'),
      librarySheet({ hitPoints: { max: 10, current: 0 } }));

    const res = await restore({ characterId: 'char-kaelara', confirm: true }, HOST.email);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('down at 0/10 hit points');
  });

  it('refuses an unknown character and lists the ones the session does have', async () => {
    const res = await restore({ characterId: 'char-nobody', confirm: true }, HOST.email);
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('char-kaelara');
    expect(res.body.error).toContain('char-daichi');
  });

  it('refuses when the session has no file for a character it has a seat for', async () => {
    fs.unlinkSync(sessionCharPath('kaelara.json'));
    const res = await restore({ characterId: 'char-kaelara', confirm: true }, HOST.email);
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('nothing to restore over');
  });

  it('requires a characterId', async () => {
    const res = await restore({ confirm: true }, HOST.email);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('characterId is required');
  });

  it('404s on a session that does not exist', async () => {
    const res = await post('/api/sessions/no-such-session/restore-character',
      { characterId: 'char-kaelara', confirm: true }, HOST.email);
    expect(res.status).toBe(404);
  });
});

// ── The race the lost-update fix was about ────────────────────────────────────────────────────

describe('a restore landing while the DM\'s turn is being persisted', () => {
  it('keeps both the restore and the turn — the shape WO-0015 found silently losing writes', async () => {
    killKaelara();

    // The turn's own persistence, in flight, exactly as UpdateWorldState does it. Before the
    // lost-update fix this pattern overwrote a concurrent route write and told the player it had
    // succeeded; a restore is that same shape, with a character's life as the payload.
    const turnWrite = updateSessionFile(tmpDir, SID, (live) => {
      live.worldState = { location: 'The Sunken Chapel', updatedAt: new Date().toISOString() };
    });
    const restoring = restore({ characterId: 'char-kaelara', confirm: true }, HOST.email);
    const [, res] = await Promise.all([turnWrite, restoring]);

    expect(res.status).toBe(200);
    const saved = readJson(sessionJsonPath());
    expect(saved.worldState.location).toBe('The Sunken Chapel');
    // The notice survived the turn write that landed at the same moment. If the restore wrote
    // session.json outside the queue, this is the assertion that fails.
    expect(saved.messages.filter(m => m.type === 'system')).toHaveLength(1);
    expect(readJson(sessionCharPath('kaelara.json')).status).toBe('alive');
  });

  it('two restores fired at once leave one restore and one refusal, not two notices', async () => {
    killKaelara();
    const [a, b] = await Promise.all([
      restore({ characterId: 'char-kaelara', confirm: true }, HOST.email),
      restore({ characterId: 'char-kaelara', confirm: true }, HOST.email),
    ]);

    const statuses = [a.status, b.status].sort();
    // The second one runs after the first has committed, re-reads the sheet inside the lock, and
    // finds a character who is alive again — so it is refused by the same check that keeps the
    // button away from the living.
    expect(statuses).toEqual([200, 409]);
    expect(readJson(sessionJsonPath()).messages.filter(m => m.type === 'system')).toHaveLength(1);
  });
});

// ── The wire name, pinned at both ends ────────────────────────────────────────────────────────
//
// The route is HTTP, the notice is a WebSocket message, and the client handles it by string. That
// is three files with no compiler between them, so the name is checked here by reading both ends.
// A rename on one side alone means a restore that happens silently: the sheet changes, the party
// board keeps its old numbers, and nothing appears in the transcript until somebody reloads.

describe('the restore notice reaches the client under the name the client listens for', () => {
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sessions.js'), 'utf-8');
  const hookSource = fs.readFileSync(
    path.join(__dirname, '..', '..', 'client', 'src', 'hooks', 'useWebSocket.js'), 'utf-8');

  it('the server broadcasts session_character_restored, and the client has a case for it', () => {
    expect(routeSource).toContain("broadcastToSessionRoom(req.params.id, 'session_character_restored'");
    expect(hookSource).toContain("case 'session_character_restored':");
  });

  it('sends exactly one broadcast, and not on the player channel where it would look like speech', () => {
    const at = routeSource.indexOf("router.post('/:id/restore-character'");
    expect(at).toBeGreaterThan(-1);
    const next = routeSource.indexOf('router.', at + 40);
    const body = routeSource.slice(at, next === -1 ? routeSource.length : next);
    // Matched on the call rather than on the text, so the comment above the call — which names
    // the player channel in order to explain why it is not used — cannot satisfy or break this.
    const broadcasts = [...body.matchAll(/broadcastToSessionRoom\(\s*req\.params\.id,\s*'([a-z_]+)'/g)]
      .map(m => m[1]);
    expect(broadcasts).toEqual(['session_character_restored']);
  });

  it('the client files it as a system message, matching how session.json stores it', () => {
    const at = hookSource.indexOf("case 'session_character_restored':");
    const body = hookSource.slice(at, at + 320);
    expect(body).toContain("type: 'system'");
    expect(body).toContain('setPartyChanged');
  });

  it('and session.json stores it as a system message', async () => {
    killKaelara();
    await restore({ characterId: 'char-kaelara', confirm: true }, HOST.email);
    const stored = readJson(sessionJsonPath()).messages.at(-1);
    expect(stored.type).toBe('system');
  });
});

// ── The two rules, without a server ───────────────────────────────────────────────────────────

describe('findCharacterSeat: who is allowed to press the button', () => {
  it('gives the host the seat for the session character', () => {
    const seat = findCharacterSeat(makeSession(), 'char-kaelara');
    expect(seat).toEqual({ email: HOST.email, name: HOST.name, seat: 'host', npcId: null });
  });

  it('gives a companion player the seat for the character on their claim', () => {
    const seat = findCharacterSeat(makeSession(), 'char-daichi');
    expect(seat).toEqual({ email: FRIEND.email, name: FRIEND.name, seat: 'companion', npcId: 'npc-1' });
  });

  it('gives nobody a seat for a character the session is not playing', () => {
    expect(findCharacterSeat(makeSession(), 'char-nobody')).toBeNull();
  });

  it('lowercases a claim\'s email, so a capitalised login still matches its own seat', () => {
    const session = makeSession();
    session.companionPlayers['npc-1'].email = 'Friend@Test.com';
    expect(findCharacterSeat(session, 'char-daichi').email).toBe(FRIEND.email);
  });

  it('lists every character with a seat', () => {
    expect(listSessionCharacterIds(makeSession()).sort()).toEqual(['char-daichi', 'char-kaelara']);
  });
});

describe('isDownOrDead: ADR 0005 §7.3 says "down" is derived, so this is the derivation', () => {
  it('is true for a dead character', () => {
    expect(isDownOrDead({ status: 'dead', hitPoints: { max: 10, current: 0 } })).toBe(true);
  });

  it('is true for a living character at 0 hit points', () => {
    expect(isDownOrDead({ status: 'alive', hitPoints: { max: 10, current: 0 } })).toBe(true);
  });

  it('is false for a character on 1 hit point — badly hurt is not the same as down', () => {
    expect(isDownOrDead({ status: 'alive', hitPoints: { max: 10, current: 1 } })).toBe(false);
  });

  it('is false for a sheet with no hit points block at all', () => {
    expect(isDownOrDead({ status: 'alive' })).toBe(false);
  });
});
