import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import express from 'express';
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';

const { attachWebSocket } = require('../ws-handler');
const { getSessionDir, getSessionCharactersDir, getSessionNpcsDir } = require('../player-data');
const { createFakeEngineFactory, createFakeSummarize } = require('./helpers/fake-dm-engine');

// ─────────────────────────────────────────────────────────────────────────────────────────────
// WO-0032 revision 1 — the half of the fix that lives in ws-handler, driven end to end.
//
// Two findings meet here.
//
//   SDET F3: nothing tested the wiring. All 43 unit tests in revision 0 called dm-audit directly
//   with a hand-made roster, so the classic failure — a fixed detector that production never
//   passes a roster to — would have gone unnoticed, and deleting the `knownEntities:` line from
//   either call site left the suite green.
//
//   Security Reviewer S4: the reconcile loop re-audited with `auditDmTurn` ALONE. `auditPlayerTurn`
//   exists precisely because the DM paraphrases and never restates the number, so on exactly the
//   turns where the player scan was the only thing that fired, the loop logged
//   "resolved after attempt=1" having verified nothing. A guard that reports success it did not
//   measure is worse than no guard, because it is evidence.
//
// These tests use the injected fake engine (no live agent, no spend) and a real session tree on
// disk, so the roster really is read by `sessionRosterSheets` from real files.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const HOST = { email: 'host@test.com', name: 'Host Player' };
const COMPANION = { email: 'companion@test.com', name: 'Companion Player' };

let tmpDir, server, wss, wsUrl, engineFactory, fakeSummarize, sessionId;

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function sheet(id, name, gold) {
  return {
    id, name, status: 'alive', race: 'Human', class: 'Bard', level: 3,
    hitPoints: { current: 20, max: 20 }, armorClass: 12, speed: 30, proficiencyBonus: 2,
    abilities: {
      strength: { score: 10, modifier: 0 }, dexterity: { score: 12, modifier: 1 },
      constitution: { score: 12, modifier: 1 }, intelligence: { score: 10, modifier: 0 },
      wisdom: { score: 10, modifier: 0 }, charisma: { score: 16, modifier: 3 },
    },
    equipment: [`A belt pouch containing ${gold} gp`],
  };
}

function connectClient(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const received = [];
    const statusLog = [];
    ws.on('message', (data) => {
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'session_status') statusLog.push(msg.status);
      received.push(msg);
    });
    ws.on('open', () => resolve({
      send(msg) { ws.send(JSON.stringify(msg)); },
      async waitForStatus(status, timeoutMs = 5000) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const idx = statusLog.indexOf(status);
          if (idx !== -1) { statusLog.splice(0, idx + 1); return status; }
          if (Date.now() >= deadline) throw new Error(`Timeout waiting for ${status} (saw ${statusLog.join(',')})`);
          await new Promise(r => setTimeout(r, 10));
        }
      },
      close() { ws.close(); },
    }));
    ws.on('error', reject);
  });
}

// A turn in which the DM edits the GIVER's sheet and nothing else — the live bug, replayed.
function oneSidedTurn(charPath) {
  return () => ([
    { type: 'tool_use', name: 'Edit', input: { file_path: charPath } },
    { type: 'dm_response', text: 'Eldon pockets it with a distracted nod.' },
    { type: 'dm_complete', sessionId: 'fake-claude-session-id' },
  ]);
}

async function bootTurn({ playerText, reconcileScript, script }) {
  engineFactory = createFakeEngineFactory({
    script: script || oneSidedTurn(`data/sessions/${sessionId}/characters/zephyr.json`),
    reconcileScript,
  });
  fakeSummarize = createFakeSummarize();
  const app = express();
  server = http.createServer(app);
  wss = attachWebSocket(server, tmpDir, { createEngine: engineFactory, summarize: fakeSummarize });
  await new Promise(r => server.listen(0, r));
  wsUrl = `ws://127.0.0.1:${server.address().port}/ws`;

  const host = await connectClient(wsUrl);
  host.send({ type: 'session_watch', sessionDbId: sessionId, playerEmail: HOST.email, playerName: HOST.name });
  await new Promise(r => setTimeout(r, 50));
  host.send({ type: 'session_resume', claudeSessionId: null, characterId: 'char-zephyr', scenarioId: 'demo', campaignId: 'demo', messages: [], playerEmail: HOST.email, playerName: HOST.name });
  await host.waitForStatus('idle');
  host.send({ type: 'user_message', text: playerText });
  await host.waitForStatus('idle');
  host.close();
  return engineFactory.last();
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudedm-wo0032-'));
  writeJson(path.join(tmpDir, 'players.json'), {
    [HOST.email]: { email: HOST.email, name: HOST.name, role: 'player' },
    [COMPANION.email]: { email: COMPANION.email, name: COMPANION.name, role: 'player' },
  });
  writeJson(path.join(tmpDir, 'dm-settings.json'), { humor: 50, drama: 50, responseLength: 'standard' });

  sessionId = uuidv4();
  writeJson(path.join(getSessionDir(tmpDir, sessionId), 'session.json'), {
    id: sessionId, name: 'WO-0032', scenarioId: 'demo', characterId: 'char-zephyr', campaignId: 'demo',
    claudeSessionId: null, messages: [], ownerEmail: HOST.email, ownerName: HOST.name,
    playerEmail: HOST.email, playerName: HOST.name, status: 'active', settings: { visibility: 'public' },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    players: [{ id: uuidv4(), characterId: 'char-zephyr', email: HOST.email, name: HOST.name, role: 'owner', joinedAt: new Date().toISOString() }],
    companionConfig: { states: {}, reservations: {} }, companionPlayers: {}, pendingTurns: {},
  });
  // The roster the audit will read off disk — a player character and a DM-controlled NPC.
  writeJson(path.join(getSessionCharactersDir(tmpDir, sessionId), 'zephyr.json'), sheet('char-zephyr', 'Zephyr Shadowmend', 9));
  writeJson(path.join(getSessionNpcsDir(tmpDir, sessionId), 'eldon.json'), sheet('npc-eldon', 'Eldon Fairweather', 10));
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (wss) for (const c of wss.clients) c.terminate();
  if (server) await new Promise(r => server.close(r));
  await new Promise(r => setTimeout(r, 30));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const engine of engineFactory.created) expect(engine.constructor.name).toBe('FakeDmEngine');
});

describe('WO-0032 F3: the roster really is read off disk and threaded into the audit', () => {
  it('a one-sided transfer declared by the player triggers the reconcile pass end to end', async () => {
    const engine = await bootTurn({
      playerText: 'Eldon gets a coin too.',
      reconcileScript: () => ([]),
    });
    const reconciles = engine.calls.filter(c => c.kind === 'runReconcile');
    expect(reconciles.length).toBeGreaterThan(0);
    expect(reconciles[0].text).toContain('[currency]');
  });

  it('does NOT trigger it when both sides are written', async () => {
    engineFactory = createFakeEngineFactory({
      script: () => ([
        { type: 'tool_use', name: 'Edit', input: { file_path: `data/sessions/${sessionId}/characters/zephyr.json` } },
        { type: 'tool_use', name: 'Edit', input: { file_path: `data/sessions/${sessionId}/npcs/eldon.json` } },
        { type: 'dm_response', text: 'Eldon pockets it with a distracted nod.' },
        { type: 'dm_complete', sessionId: 'fake-claude-session-id' },
      ]),
    });
    fakeSummarize = createFakeSummarize();
    const app = express();
    server = http.createServer(app);
    wss = attachWebSocket(server, tmpDir, { createEngine: engineFactory, summarize: fakeSummarize });
    await new Promise(r => server.listen(0, r));
    wsUrl = `ws://127.0.0.1:${server.address().port}/ws`;
    const host = await connectClient(wsUrl);
    host.send({ type: 'session_watch', sessionDbId: sessionId, playerEmail: HOST.email, playerName: HOST.name });
    await new Promise(r => setTimeout(r, 50));
    host.send({ type: 'session_resume', claudeSessionId: null, characterId: 'char-zephyr', scenarioId: 'demo', campaignId: 'demo', messages: [], playerEmail: HOST.email, playerName: HOST.name });
    await host.waitForStatus('idle');
    host.send({ type: 'user_message', text: 'Eldon gets a coin too.' });
    await host.waitForStatus('idle');
    host.close();

    expect(engineFactory.last().calls.filter(c => c.kind === 'runReconcile')).toHaveLength(0);
  });
});

describe('WO-0032 S2/S7 end to end: the roster payload the audit needs comes off disk', () => {
  it('a pronoun giver is resolved to the player character — Edit to the receiver alone still warns', async () => {
    // Needs `kind: character` on the roster, which only sessionRosterSheets can supply.
    const engine = await bootTurn({
      playerText: 'ok',
      script: () => ([
        { type: 'tool_use', name: 'Edit', input: { file_path: `data/sessions/${sessionId}/npcs/eldon.json` } },
        { type: 'dm_response', text: 'You hand Eldon 1 gp.' },
        { type: 'dm_complete', sessionId: 'fake-claude-session-id' },
      ]),
      reconcileScript: () => ([]),
    });
    expect(engine.calls.filter(c => c.kind === 'runReconcile').length).toBeGreaterThan(0);
  });

  it('an Edit to a same-named file outside the session does not satisfy the check', async () => {
    // Needs `dir` on the roster. The library copy has the same basename as the session sheet.
    const engine = await bootTurn({
      playerText: 'ok',
      script: () => ([
        { type: 'tool_use', name: 'Edit', input: { file_path: `data/sessions/${sessionId}/characters/zephyr.json` } },
        { type: 'tool_use', name: 'Edit', input: { file_path: 'data/players/host-test-com/demo/npcs/eldon.json' } },
        { type: 'dm_response', text: 'Gave Eldon 1 gp. Zephyr\'s gold: 8 gp.' },
        { type: 'dm_complete', sessionId: 'fake-claude-session-id' },
      ]),
      reconcileScript: () => ([]),
    });
    expect(engine.calls.filter(c => c.kind === 'runReconcile').length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// REVISION 3 — SDET N8 and Security R2-2, found independently, and they are the same hole.
//
// Everything revision 2 added to ws-handler.js could be deleted with all 188 tests green:
// reverting the file entirely killed 0, `turnSpeakers = []` killed 0, dropping `id` from
// `sessionRosterSheets` killed 0. What that bought, executed by the SDET: with a stale or wrong
// speaker id, `"You hand Eldon 1 gp."` + Edit→Eldon + Edit→a NON-speaker goes silent — money
// created, suite green. That is the exact shape Security R3 / QC N1 was filed for, reopening one
// layer up from the fix.
//
// It was correct in production only by coincidence: on the live session `session.characterId` is
// `550e8400-…-440005` and Zephyr's sheet carries the same `id`, so they happened to match. That is
// a fact about today's data, not a property anything maintained. These cases maintain it.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('WO-0032 revision 3: the speaker really reaches the audit (SDET N8 / Security R2-2)', () => {
  // A second player character, so "a character was written" and "the SPEAKER was written" can
  // differ. Without one there is nothing for the any-character fallback to wrongly accept.
  function addSecondCharacter() {
    writeJson(path.join(getSessionCharactersDir(tmpDir, sessionId), 'thorin.json'),
      sheet('char-thorin', 'Thorin Ironfist', 12));
  }

  const PRONOUN_TRANSFER = 'You hand Eldon 1 gp.';

  it('a write to a character who did NOT speak does not satisfy the transfer', async () => {
    // Kills `turnSpeakers = []` and kills dropping `id` from the roster: under either, the audit
    // falls back to the any-character rule, finds Thorin written, and stays silent while a gold
    // piece is created.
    addSecondCharacter();
    const engine = await bootTurn({
      playerText: 'ok',
      script: () => ([
        { type: 'tool_use', name: 'Edit', input: { file_path: `data/sessions/${sessionId}/npcs/eldon.json` } },
        { type: 'tool_use', name: 'Edit', input: { file_path: `data/sessions/${sessionId}/characters/thorin.json` } },
        { type: 'dm_response', text: PRONOUN_TRANSFER },
        { type: 'dm_complete', sessionId: 'fake-claude-session-id' },
      ]),
      reconcileScript: () => ([]),
    });
    expect(engine.calls.filter(c => c.kind === 'runReconcile').length).toBeGreaterThan(0);
  });

  it('...and a write to the character who DID speak satisfies it', async () => {
    // The control, and the half that stops an over-correcting "always warn" fix passing the test
    // above. `session.characterId` is `char-zephyr` and zephyr.json carries `"id": "char-zephyr"`,
    // which is the id→sheet match the whole fix rests on.
    addSecondCharacter();
    const engine = await bootTurn({
      playerText: 'ok',
      script: () => ([
        { type: 'tool_use', name: 'Edit', input: { file_path: `data/sessions/${sessionId}/npcs/eldon.json` } },
        { type: 'tool_use', name: 'Edit', input: { file_path: `data/sessions/${sessionId}/characters/zephyr.json` } },
        { type: 'dm_response', text: PRONOUN_TRANSFER },
        { type: 'dm_complete', sessionId: 'fake-claude-session-id' },
      ]),
      reconcileScript: () => ([]),
    });
    expect(engine.calls.filter(c => c.kind === 'runReconcile')).toHaveLength(0);
  });

  it('a companion cannot nominate another character as the speaker over the wire (Security R2-1)', async () => {
    // `companion_turn_submit` takes `msg.characterId` unvalidated, and the host-character
    // rejection on `companion_set_character` does not cover the per-turn field. Executed by the
    // Security Reviewer: speakers [Zephyr, Thorin] is SILENT where [Zephyr] warns, and a valid
    // other character's id widens the rule without even producing the `speaker-unresolved` log a
    // bogus one would. This companion has registered no character at all, so the wire value is the
    // only thing that could put Thorin in the speaker set — and it must not.
    addSecondCharacter();
    engineFactory = createFakeEngineFactory({
      script: () => ([
        { type: 'tool_use', name: 'Edit', input: { file_path: `data/sessions/${sessionId}/npcs/eldon.json` } },
        { type: 'tool_use', name: 'Edit', input: { file_path: `data/sessions/${sessionId}/characters/thorin.json` } },
        { type: 'dm_response', text: PRONOUN_TRANSFER },
        { type: 'dm_complete', sessionId: 'fake-claude-session-id' },
      ]),
      reconcileScript: () => ([]),
    });
    fakeSummarize = createFakeSummarize();

    // Make it a multiplayer session with one joined companion, so the host's message queues and
    // the companion's submission is what fires the DM.
    const sessionPath = path.join(getSessionDir(tmpDir, sessionId), 'session.json');
    const sessionFile = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
    sessionFile.companionPlayers = {
      'npc-eldon': { email: COMPANION.email, name: COMPANION.name, joinedAt: new Date().toISOString() },
    };
    writeJson(sessionPath, sessionFile);

    const app = express();
    server = http.createServer(app);
    wss = attachWebSocket(server, tmpDir, { createEngine: engineFactory, summarize: fakeSummarize });
    await new Promise(r => server.listen(0, r));
    wsUrl = `ws://127.0.0.1:${server.address().port}/ws`;

    const host = await connectClient(wsUrl);
    host.send({ type: 'session_watch', sessionDbId: sessionId, playerEmail: HOST.email, playerName: HOST.name });
    await new Promise(r => setTimeout(r, 50));
    host.send({ type: 'session_resume', claudeSessionId: null, characterId: 'char-zephyr', scenarioId: 'demo', campaignId: 'demo', messages: [], playerEmail: HOST.email, playerName: HOST.name });
    await host.waitForStatus('idle');

    const companion = await connectClient(wsUrl);
    companion.send({ type: 'session_watch', sessionDbId: sessionId, playerEmail: COMPANION.email, playerName: COMPANION.name });
    await new Promise(r => setTimeout(r, 50));

    host.send({ type: 'user_message', text: 'ok' });
    await new Promise(r => setTimeout(r, 50));
    // The attack: a characterId this companion never registered, naming the other player character.
    companion.send({ type: 'companion_turn_submit', text: 'I wait.', npcName: 'Eldon', characterId: 'char-thorin', characterName: 'Thorin Ironfist' });
    await host.waitForStatus('idle');
    host.close();
    companion.close();

    // The multiplayer path creates the session engine on `session_watch` as well as on resume, so
    // the turn does not necessarily run on `last()`. Count across every engine this factory made.
    const reconciles = engineFactory.created
      .flatMap(e => e.calls.filter(c => c.kind === 'runReconcile'));
    expect(reconciles.length).toBeGreaterThan(0);
  });
});

describe('WO-0032 S4: the reconcile loop re-audits the player side too', () => {
  it('does not log "resolved" when the pass fixed nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await bootTurn({ playerText: 'Eldon gets a coin too.', reconcileScript: () => ([]) });
    const resolved = log.mock.calls.flat().filter(l => typeof l === 'string' && l.includes('RECONCILE') && l.includes('resolved'));
    expect(resolved).toEqual([]);
  });

  it('does log "resolved" once the missing side is actually written', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await bootTurn({
      playerText: 'Eldon gets a coin too.',
      reconcileScript: () => ([{ type: 'tool_use', name: 'Edit', input: { file_path: `data/sessions/${sessionId}/npcs/eldon.json` } }]),
    });
    const resolved = log.mock.calls.flat().filter(l => typeof l === 'string' && l.includes('RECONCILE') && l.includes('resolved'));
    expect(resolved.length).toBe(1);
  });

  it('spends at most ONE model pass on a warning only the player scan raised', async () => {
    // S3's other half: each attempt is a full resumed query against a budget line of 0, and a
    // player can provoke this class on demand by naming a rostered NPC beside a coin phrase.
    const engine = await bootTurn({ playerText: 'Eldon gets a coin too.', reconcileScript: () => ([]) });
    expect(engine.calls.filter(c => c.kind === 'runReconcile')).toHaveLength(1);
  });
});
