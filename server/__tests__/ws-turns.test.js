import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import express from 'express';
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';

const { attachWebSocket } = require('../ws-handler');
const { ensurePlayerDataExists, getPlayerSessionsDir, getPlayerCharactersDir, getPlayerNpcsDir } = require('../player-data');

let tmpDir;
let server;
let wss;
let wsUrl;

const HOST = { email: 'host@test.com', name: 'Host Player' };
const COMPANION = { email: 'alice@test.com', name: 'Alice' };

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function setupPlayers(dataDir) {
  writeJson(path.join(dataDir, 'players.json'), {
    [HOST.email]: { email: HOST.email, name: HOST.name, role: 'player' },
    [COMPANION.email]: { email: COMPANION.email, name: COMPANION.name, role: 'player' },
  });
}

function makeSession(dataDir, overrides = {}) {
  const id = overrides.id || uuidv4();
  const session = {
    id,
    name: 'Test Session',
    scenarioId: 'demo',
    characterId: 'char-1',
    campaignId: 'demo',
    claudeSessionId: null,
    messages: [],
    ownerEmail: HOST.email,
    ownerName: HOST.name,
    playerEmail: HOST.email,
    playerName: HOST.name,
    status: 'active',
    settings: { visibility: 'public' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    players: [{ id: uuidv4(), characterId: 'char-1', email: HOST.email, name: HOST.name, role: 'owner', joinedAt: new Date().toISOString() }],
    companionConfig: {
      states: { 'npc-1': 'player', 'npc-2': 'selected' },
      reservations: {},
    },
    companionPlayers: {},
    pendingTurns: {},
    ...overrides,
  };
  ensurePlayerDataExists(dataDir, HOST.email, 'demo');
  const sessDir = getPlayerSessionsDir(dataDir, HOST.email, 'demo');
  writeJson(path.join(sessDir, `${session.id}.json`), session);
  return session;
}

function setupCharacterAndNpc(dataDir) {
  writeJson(path.join(getPlayerCharactersDir(dataDir, HOST.email, 'demo'), 'hero.json'), {
    id: 'char-1', name: 'Bramble', race: 'Halfling', class: 'Druid', level: 3,
    hitPoints: { current: 25, max: 25 }, armorClass: 13, speed: 25, proficiencyBonus: 2,
    abilities: { strength: { score: 10, modifier: 0 }, dexterity: { score: 14, modifier: 2 },
      constitution: { score: 12, modifier: 1 }, intelligence: { score: 11, modifier: 0 },
      wisdom: { score: 16, modifier: 3 }, charisma: { score: 13, modifier: 1 } },
    status: 'alive',
  });
  writeJson(path.join(getPlayerNpcsDir(dataDir, HOST.email, 'demo'), 'pip.json'), {
    id: 'npc-1', name: 'Pip', race: 'Gnome', class: 'Rogue', level: 2,
    hitPoints: { current: 15, max: 15 }, armorClass: 14, speed: 25, proficiencyBonus: 2,
    abilities: { strength: { score: 8, modifier: -1 }, dexterity: { score: 16, modifier: 3 },
      constitution: { score: 12, modifier: 1 }, intelligence: { score: 14, modifier: 2 },
      wisdom: { score: 10, modifier: 0 }, charisma: { score: 12, modifier: 1 } },
    status: 'alive',
  });
  // DM settings
  writeJson(path.join(dataDir, 'dm-settings.json'), {
    humor: 50, drama: 50, verbosity: 50, difficulty: 50,
    tone: 'balanced', narrationStyle: 'descriptive', playerAgency: 'collaborative',
  });
}

// Connect a WebSocket client and return helpers
function connectClient(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const received = [];
    ws.on('open', () => {
      resolve({
        ws,
        received,
        send(msg) { ws.send(JSON.stringify(msg)); },
        // Wait for a message of a specific type, with timeout
        waitFor(type, timeoutMs = 2000) {
          // Check already-received messages first
          const existing = received.find(m => m.type === type);
          if (existing) {
            received.splice(received.indexOf(existing), 1);
            return Promise.resolve(existing);
          }
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error(`Timeout waiting for ${type}`)), timeoutMs);
            const handler = (data) => {
              const msg = JSON.parse(data.toString());
              if (msg.type === type) {
                clearTimeout(timer);
                ws.off('message', handler);
                res(msg);
              } else {
                received.push(msg);
              }
            };
            ws.on('message', handler);
          });
        },
        // Collect all messages for a duration
        async collectFor(ms) {
          await new Promise(r => setTimeout(r, ms));
          return [...received];
        },
        close() { ws.close(); },
      });
    });
    ws.on('error', reject);
  });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudedm-ws-test-'));
  setupPlayers(tmpDir);
  setupCharacterAndNpc(tmpDir);

  const app = express();
  server = http.createServer(app);
  wss = attachWebSocket(server, tmpDir);

  await new Promise((resolve) => {
    server.listen(0, () => {
      wsUrl = `ws://127.0.0.1:${server.address().port}/ws`;
      resolve();
    });
  });
});

afterEach(async () => {
  // Close all WebSocket connections
  if (wss) {
    for (const client of wss.clients) {
      client.terminate();
    }
  }
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('session_watch — room management', () => {
  it('host receives session_access with canWrite=true', async () => {
    const session = makeSession(tmpDir);
    const host = await connectClient(wsUrl);

    host.send({ type: 'session_watch', sessionDbId: session.id, playerEmail: HOST.email, playerName: HOST.name });
    const access = await host.waitFor('session_access');

    expect(access.canWrite).toBe(true);
    expect(access.readOnly).toBe(false);
    expect(access.sessionDbId).toBe(session.id);

    host.close();
  });

  it('companion receives session_access with companionNpcId', async () => {
    const session = makeSession(tmpDir, {
      companionPlayers: { 'npc-1': { email: COMPANION.email, name: COMPANION.name, joinedAt: new Date().toISOString() } },
    });
    const companion = await connectClient(wsUrl);

    companion.send({ type: 'session_watch', sessionDbId: session.id, playerEmail: COMPANION.email, playerName: COMPANION.name });
    const access = await companion.waitFor('session_access');

    expect(access.canWrite).toBe(false);
    expect(access.companionNpcId).toBe('npc-1');

    companion.close();
  });

  it('observer receives read-only access', async () => {
    const session = makeSession(tmpDir);
    const observer = await connectClient(wsUrl);

    observer.send({ type: 'session_watch', sessionDbId: session.id, playerEmail: 'random@test.com', playerName: 'Random' });
    const access = await observer.waitFor('session_access');

    expect(access.canWrite).toBe(false);
    expect(access.readOnly).toBe(true);
    expect(access.companionNpcId).toBeUndefined();

    observer.close();
  });
});

describe('single player — no queueing', () => {
  it('user_message fires immediately for solo session (no companionPlayers)', async () => {
    const session = makeSession(tmpDir, { companionPlayers: {} });
    const host = await connectClient(wsUrl);

    // Watch session first, then start engine context
    host.send({ type: 'session_watch', sessionDbId: session.id, playerEmail: HOST.email, playerName: HOST.name });
    await host.waitFor('session_access');

    // Resume session to set up engine
    host.send({ type: 'session_resume', claudeSessionId: null, characterId: 'char-1', scenarioId: 'demo', campaignId: 'demo', messages: [], playerEmail: HOST.email, playerName: HOST.name });
    await host.waitFor('session_status'); // idle

    // Send a message — should get session_status: thinking (not queued)
    host.send({ type: 'user_message', text: 'Hello' });
    const status = await host.waitFor('session_status');
    expect(status.status).toBe('thinking');

    host.close();
  });
});

describe('multiplayer — turn queueing', () => {
  it('host_turn_submit queues turn and broadcasts turn_status', async () => {
    const session = makeSession(tmpDir, {
      companionPlayers: { 'npc-1': { email: COMPANION.email, name: COMPANION.name, joinedAt: new Date().toISOString() } },
    });

    const host = await connectClient(wsUrl);
    host.send({ type: 'session_watch', sessionDbId: session.id, playerEmail: HOST.email, playerName: HOST.name });
    await host.waitFor('session_access');
    host.send({ type: 'session_resume', claudeSessionId: null, characterId: 'char-1', scenarioId: 'demo', campaignId: 'demo', messages: [], playerEmail: HOST.email, playerName: HOST.name });
    await host.waitFor('session_status');

    // Submit host turn
    host.send({ type: 'host_turn_submit', text: 'I attack the goblin' });
    const turnStatus = await host.waitFor('turn_status');

    expect(turnStatus.hostSubmitted).toBe(true);
    expect(turnStatus.pendingTurns).toHaveLength(1);
    expect(turnStatus.pendingTurns[0].text).toBe('I attack the goblin');
    expect(turnStatus.pendingTurns[0].isHost).toBe(true);

    // Verify persisted to session JSON
    const sessFile = JSON.parse(fs.readFileSync(
      path.join(getPlayerSessionsDir(tmpDir, HOST.email, 'demo'), `${session.id}.json`), 'utf-8'));
    expect(sessFile.pendingTurns[HOST.email]).toBeDefined();
    expect(sessFile.pendingTurns[HOST.email].text).toBe('I attack the goblin');

    host.close();
  });

  it('host_turn_retract returns original text', async () => {
    const session = makeSession(tmpDir, {
      companionPlayers: { 'npc-1': { email: COMPANION.email, name: COMPANION.name, joinedAt: new Date().toISOString() } },
    });

    const host = await connectClient(wsUrl);
    host.send({ type: 'session_watch', sessionDbId: session.id, playerEmail: HOST.email, playerName: HOST.name });
    await host.waitFor('session_access');
    host.send({ type: 'session_resume', claudeSessionId: null, characterId: 'char-1', scenarioId: 'demo', campaignId: 'demo', messages: [], playerEmail: HOST.email, playerName: HOST.name });
    await host.waitFor('session_status');

    // Submit then retract
    host.send({ type: 'host_turn_submit', text: 'I attack the goblin' });
    await host.waitFor('turn_status');

    host.send({ type: 'host_turn_retract' });
    const retracted = await host.waitFor('host_turn_retracted');

    expect(retracted.text).toBe('I attack the goblin');

    // Verify removed from session JSON
    const sessFile = JSON.parse(fs.readFileSync(
      path.join(getPlayerSessionsDir(tmpDir, HOST.email, 'demo'), `${session.id}.json`), 'utf-8'));
    expect(sessFile.pendingTurns[HOST.email]).toBeUndefined();

    host.close();
  });

  it('companion_turn_submit queues turn and persists', async () => {
    const session = makeSession(tmpDir, {
      companionPlayers: { 'npc-1': { email: COMPANION.email, name: COMPANION.name, joinedAt: new Date().toISOString() } },
    });

    const companion = await connectClient(wsUrl);
    companion.send({ type: 'session_watch', sessionDbId: session.id, playerEmail: COMPANION.email, playerName: COMPANION.name });
    await companion.waitFor('session_access');

    companion.send({ type: 'companion_turn_submit', text: 'I sneak behind the goblin', npcName: 'Pip' });
    const turnsUpdate = await companion.waitFor('companion_turns_update');

    expect(turnsUpdate.turns).toHaveLength(1);
    expect(turnsUpdate.turns[0].text).toBe('I sneak behind the goblin');

    // Verify persisted
    const sessFile = JSON.parse(fs.readFileSync(
      path.join(getPlayerSessionsDir(tmpDir, HOST.email, 'demo'), `${session.id}.json`), 'utf-8'));
    expect(sessFile.pendingTurns[COMPANION.email]).toBeDefined();
    expect(sessFile.pendingTurns[COMPANION.email].text).toBe('I sneak behind the goblin');

    companion.close();
  });

  it('companion_turn_retract returns original text', async () => {
    const session = makeSession(tmpDir, {
      companionPlayers: { 'npc-1': { email: COMPANION.email, name: COMPANION.name, joinedAt: new Date().toISOString() } },
    });

    const companion = await connectClient(wsUrl);
    companion.send({ type: 'session_watch', sessionDbId: session.id, playerEmail: COMPANION.email, playerName: COMPANION.name });
    await companion.waitFor('session_access');

    companion.send({ type: 'companion_turn_submit', text: 'I sneak behind the goblin', npcName: 'Pip' });
    await companion.waitFor('companion_turns_update');

    companion.send({ type: 'companion_turn_retract' });
    const retracted = await companion.waitFor('companion_turn_retracted');

    expect(retracted.text).toBe('I sneak behind the goblin');

    companion.close();
  });

  it('pending turns survive reconnection', async () => {
    const session = makeSession(tmpDir, {
      companionPlayers: { 'npc-1': { email: COMPANION.email, name: COMPANION.name, joinedAt: new Date().toISOString() } },
    });

    // Companion submits a turn
    const companion1 = await connectClient(wsUrl);
    companion1.send({ type: 'session_watch', sessionDbId: session.id, playerEmail: COMPANION.email, playerName: COMPANION.name });
    await companion1.waitFor('session_access');
    companion1.send({ type: 'companion_turn_submit', text: 'I hide', npcName: 'Pip' });
    await companion1.waitFor('companion_turns_update');
    companion1.close();

    // Wait for disconnect to process
    await new Promise(r => setTimeout(r, 100));

    // Verify persisted to session JSON (the ground truth)
    const sessFile = JSON.parse(fs.readFileSync(
      path.join(getPlayerSessionsDir(tmpDir, HOST.email, 'demo'), `${session.id}.json`), 'utf-8'));
    expect(sessFile.pendingTurns[COMPANION.email]).toBeDefined();
    expect(sessFile.pendingTurns[COMPANION.email].text).toBe('I hide');

    // Companion reconnects — should see their turn restored from session JSON
    const companion2 = await connectClient(wsUrl);
    companion2.send({ type: 'session_watch', sessionDbId: session.id, playerEmail: COMPANION.email, playerName: COMPANION.name });
    const turnsUpdate = await companion2.waitFor('companion_turns_update');

    expect(turnsUpdate.turns.length).toBeGreaterThanOrEqual(1);
    expect(turnsUpdate.turns.some(t => t.text === 'I hide')).toBe(true);

    companion2.close();
  });
});

describe('session_start — state isolation', () => {
  it('sends empty session_participants on session_start to clear stale state', async () => {
    const client = await connectClient(wsUrl);

    // Start a solo session directly (no prior session_watch)
    client.send({ type: 'session_start', characterId: 'char-1', scenarioId: 'demo', campaignId: 'demo', playerEmail: COMPANION.email, playerName: COMPANION.name });

    // Should receive empty participants
    const participants = await client.waitFor('session_participants');
    expect(participants.participants).toHaveLength(0);

    client.close();
  });

  it('user_message in solo session fires immediately, not queued', async () => {
    // Create a multiplayer session (to pollute state)
    const mpSession = makeSession(tmpDir, {
      companionPlayers: { 'npc-1': { email: COMPANION.email, name: COMPANION.name, joinedAt: new Date().toISOString() } },
    });

    const client = await connectClient(wsUrl);

    // Watch multiplayer session briefly
    client.send({ type: 'session_watch', sessionDbId: mpSession.id, playerEmail: HOST.email, playerName: HOST.name });
    await client.waitFor('session_access');

    // Now start a solo session
    client.send({ type: 'session_start', characterId: 'char-1', scenarioId: 'demo', campaignId: 'demo', playerEmail: HOST.email, playerName: HOST.name });
    await client.waitFor('session_participants'); // empty participants
    await client.waitFor('session_status'); // idle

    // Send message — should fire immediately (thinking), not queue
    client.send({ type: 'user_message', text: 'Hello world' });
    const status = await client.waitFor('session_status');
    expect(status.status).toBe('thinking');

    client.close();
  });
});

describe('multiplayer detection', () => {
  it('user_message queues when session has companionPlayers', async () => {
    const session = makeSession(tmpDir, {
      companionPlayers: { 'npc-1': { email: COMPANION.email, name: COMPANION.name, joinedAt: new Date().toISOString() } },
    });

    const host = await connectClient(wsUrl);
    host.send({ type: 'session_watch', sessionDbId: session.id, playerEmail: HOST.email, playerName: HOST.name });
    await host.waitFor('session_access');
    host.send({ type: 'session_resume', claudeSessionId: null, characterId: 'char-1', scenarioId: 'demo', campaignId: 'demo', messages: [], playerEmail: HOST.email, playerName: HOST.name });
    await host.waitFor('session_status');

    // Send user_message — should be queued (turn_status), NOT fire immediately (thinking)
    host.send({ type: 'user_message', text: 'I attack' });
    const msg = await host.waitFor('turn_status');

    expect(msg.hostSubmitted).toBe(true);
    expect(msg.pendingTurns.some(t => t.text === 'I attack')).toBe(true);

    host.close();
  });

  it('user_message fires immediately when session has no companionPlayers', async () => {
    const session = makeSession(tmpDir, { companionPlayers: {} });

    const host = await connectClient(wsUrl);
    host.send({ type: 'session_watch', sessionDbId: session.id, playerEmail: HOST.email, playerName: HOST.name });
    await host.waitFor('session_access');
    host.send({ type: 'session_resume', claudeSessionId: null, characterId: 'char-1', scenarioId: 'demo', campaignId: 'demo', messages: [], playerEmail: HOST.email, playerName: HOST.name });
    await host.waitFor('session_status');

    host.send({ type: 'user_message', text: 'Hello' });
    const status = await host.waitFor('session_status');

    // Should get 'thinking' — not turn_status
    expect(status.status).toBe('thinking');

    host.close();
  });
});

describe('host_skip_companion', () => {
  it('removes companion turn and updates status', async () => {
    const session = makeSession(tmpDir, {
      companionPlayers: { 'npc-1': { email: COMPANION.email, name: COMPANION.name, joinedAt: new Date().toISOString() } },
    });

    // Companion submits turn
    const companion = await connectClient(wsUrl);
    companion.send({ type: 'session_watch', sessionDbId: session.id, playerEmail: COMPANION.email, playerName: COMPANION.name });
    await companion.waitFor('session_access');
    companion.send({ type: 'companion_turn_submit', text: 'I hide', npcName: 'Pip' });
    await companion.waitFor('companion_turns_update');

    // Host skips companion
    const host = await connectClient(wsUrl);
    host.send({ type: 'session_watch', sessionDbId: session.id, playerEmail: HOST.email, playerName: HOST.name });
    await host.waitFor('session_access');
    host.send({ type: 'session_resume', claudeSessionId: null, characterId: 'char-1', scenarioId: 'demo', campaignId: 'demo', messages: [], playerEmail: HOST.email, playerName: HOST.name });
    await host.waitFor('session_status');

    host.send({ type: 'host_skip_companion', playerEmail: COMPANION.email });
    const turnsUpdate = await host.waitFor('companion_turns_update');

    expect(turnsUpdate.turns).toHaveLength(0);

    // Verify removed from session JSON
    const sessFile = JSON.parse(fs.readFileSync(
      path.join(getPlayerSessionsDir(tmpDir, HOST.email, 'demo'), `${session.id}.json`), 'utf-8'));
    expect(sessFile.pendingTurns[COMPANION.email]).toBeUndefined();

    host.close();
    companion.close();
  });
});
