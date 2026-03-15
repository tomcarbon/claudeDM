import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';

const { ensurePlayerDataExists, getPlayerSessionsDir } = require('../player-data');

let tmpDir;
let app;
let server;
let baseUrl;

// Helper: create players.json with test players
function setupPlayers(dataDir, players) {
  const playersMap = {};
  for (const p of players) {
    playersMap[p.email] = p;
  }
  fs.writeFileSync(path.join(dataDir, 'players.json'), JSON.stringify(playersMap, null, 2));
}

// Helper: create a session JSON file in the host's sessions directory
function createSessionFile(dataDir, hostEmail, campaignId, session) {
  ensurePlayerDataExists(dataDir, hostEmail, campaignId);
  const sessDir = getPlayerSessionsDir(dataDir, hostEmail, campaignId);
  const filePath = path.join(sessDir, `${session.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
  return filePath;
}

// Helper: make an HTTP request to the test server
function request(method, urlPath, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const options = {
      method: method.toUpperCase(),
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const HOST = { email: 'host@test.com', name: 'Host Player', role: 'player' };
const PLAYER_A = { email: 'alice@test.com', name: 'Alice', role: 'player' };
const PLAYER_B = { email: 'bob@test.com', name: 'Bob', role: 'player' };

function makeSession(overrides = {}) {
  const id = overrides.id || uuidv4();
  return {
    id,
    name: 'Test Session',
    label: null,
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
      states: { 'npc-1': 'player', 'npc-2': 'player', 'npc-3': 'selected' },
      reservations: {},
    },
    companionPlayers: {},
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudedm-sess-test-'));
  setupPlayers(tmpDir, [HOST, PLAYER_A, PLAYER_B]);

  // Create real Express app with the sessions router
  const sessionsRouter = require('../routes/sessions')(tmpDir);
  app = express();
  app.use(express.json());
  // Simulate campaignId middleware
  app.use((req, res, next) => {
    req.campaignId = req.get('x-campaign-id') || 'demo';
    next();
  });
  app.use('/api/sessions', sessionsRouter);

  // Start on a random port
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('POST /:id/join', () => {
  it('allows a player to join an open slot', async () => {
    const session = makeSession();
    createSessionFile(tmpDir, HOST.email, 'demo', session);

    const res = await request('POST', `/api/sessions/${session.id}/join`, {
      body: { npcId: 'npc-1' },
      headers: { 'x-player-email': PLAYER_A.email, 'x-campaign-id': 'demo' },
    });

    expect(res.status).toBe(200);
    expect(res.body.claimedBy.email).toBe(PLAYER_A.email);
  });

  it('prevents a player from joining two slots', async () => {
    const session = makeSession();
    session.companionPlayers = {
      'npc-1': { email: PLAYER_A.email, name: PLAYER_A.name, joinedAt: new Date().toISOString() },
    };
    createSessionFile(tmpDir, HOST.email, 'demo', session);

    const res = await request('POST', `/api/sessions/${session.id}/join`, {
      body: { npcId: 'npc-2' },
      headers: { 'x-player-email': PLAYER_A.email, 'x-campaign-id': 'demo' },
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already joined/i);
  });

  it('prevents the host from joining their own session', async () => {
    const session = makeSession();
    createSessionFile(tmpDir, HOST.email, 'demo', session);

    const res = await request('POST', `/api/sessions/${session.id}/join`, {
      body: { npcId: 'npc-1' },
      headers: { 'x-player-email': HOST.email, 'x-campaign-id': 'demo' },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/host cannot join/i);
  });

  it('prevents joining an already-claimed slot', async () => {
    const session = makeSession();
    session.companionPlayers = {
      'npc-1': { email: PLAYER_A.email, name: PLAYER_A.name, joinedAt: new Date().toISOString() },
    };
    createSessionFile(tmpDir, HOST.email, 'demo', session);

    const res = await request('POST', `/api/sessions/${session.id}/join`, {
      body: { npcId: 'npc-1' },
      headers: { 'x-player-email': PLAYER_B.email, 'x-campaign-id': 'demo' },
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already been claimed/i);
  });

  it('prevents joining a private session', async () => {
    const session = makeSession({ settings: { visibility: 'private' } });
    createSessionFile(tmpDir, HOST.email, 'demo', session);

    const res = await request('POST', `/api/sessions/${session.id}/join`, {
      body: { npcId: 'npc-1' },
      headers: { 'x-player-email': PLAYER_A.email, 'x-campaign-id': 'demo' },
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/private/i);
  });

  it('prevents joining an NPC slot that is not open for players', async () => {
    const session = makeSession();
    createSessionFile(tmpDir, HOST.email, 'demo', session);

    const res = await request('POST', `/api/sessions/${session.id}/join`, {
      body: { npcId: 'npc-3' }, // state is 'selected', not 'player'
      headers: { 'x-player-email': PLAYER_A.email, 'x-campaign-id': 'demo' },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not open/i);
  });

  it('respects slot reservations', async () => {
    const session = makeSession();
    session.companionConfig.states['npc-1'] = 'reserved';
    session.companionConfig.reservations = { 'npc-1': PLAYER_A.email };
    createSessionFile(tmpDir, HOST.email, 'demo', session);

    // Wrong player tries to join reserved slot
    const res1 = await request('POST', `/api/sessions/${session.id}/join`, {
      body: { npcId: 'npc-1' },
      headers: { 'x-player-email': PLAYER_B.email, 'x-campaign-id': 'demo' },
    });
    expect(res1.status).toBe(403);
    expect(res1.body.error).toMatch(/reserved/i);

    // Right player joins reserved slot
    const res2 = await request('POST', `/api/sessions/${session.id}/join`, {
      body: { npcId: 'npc-1' },
      headers: { 'x-player-email': PLAYER_A.email, 'x-campaign-id': 'demo' },
    });
    expect(res2.status).toBe(200);
  });

  it('requires login', async () => {
    const session = makeSession();
    createSessionFile(tmpDir, HOST.email, 'demo', session);

    const res = await request('POST', `/api/sessions/${session.id}/join`, {
      body: { npcId: 'npc-1' },
      headers: { 'x-player-email': 'guest', 'x-campaign-id': 'demo' },
    });

    expect(res.status).toBe(403);
  });

  it('two different players can join two different slots', async () => {
    const session = makeSession();
    createSessionFile(tmpDir, HOST.email, 'demo', session);

    const res1 = await request('POST', `/api/sessions/${session.id}/join`, {
      body: { npcId: 'npc-1' },
      headers: { 'x-player-email': PLAYER_A.email, 'x-campaign-id': 'demo' },
    });
    expect(res1.status).toBe(200);

    const res2 = await request('POST', `/api/sessions/${session.id}/join`, {
      body: { npcId: 'npc-2' },
      headers: { 'x-player-email': PLAYER_B.email, 'x-campaign-id': 'demo' },
    });
    expect(res2.status).toBe(200);
  });
});

describe('POST /:id/unjoin', () => {
  it('allows a player to unjoin their own slot', async () => {
    const session = makeSession();
    session.companionPlayers = {
      'npc-1': { email: PLAYER_A.email, name: PLAYER_A.name, joinedAt: new Date().toISOString() },
    };
    createSessionFile(tmpDir, HOST.email, 'demo', session);

    const res = await request('POST', `/api/sessions/${session.id}/unjoin`, {
      body: { npcId: 'npc-1' },
      headers: { 'x-player-email': PLAYER_A.email, 'x-campaign-id': 'demo' },
    });

    expect(res.status).toBe(200);
    // Verify slot is now open
    expect(res.body.companionSlots.slots.find(s => s.npcId === 'npc-1').claimedBy).toBeNull();
  });

  it('allows the host to unjoin any player', async () => {
    const session = makeSession();
    session.companionPlayers = {
      'npc-1': { email: PLAYER_A.email, name: PLAYER_A.name, joinedAt: new Date().toISOString() },
    };
    createSessionFile(tmpDir, HOST.email, 'demo', session);

    const res = await request('POST', `/api/sessions/${session.id}/unjoin`, {
      body: { npcId: 'npc-1' },
      headers: { 'x-player-email': HOST.email, 'x-campaign-id': 'demo' },
    });

    expect(res.status).toBe(200);
  });

  it('prevents a different player from unjoining someone elses slot', async () => {
    const session = makeSession();
    session.companionPlayers = {
      'npc-1': { email: PLAYER_A.email, name: PLAYER_A.name, joinedAt: new Date().toISOString() },
    };
    createSessionFile(tmpDir, HOST.email, 'demo', session);

    const res = await request('POST', `/api/sessions/${session.id}/unjoin`, {
      body: { npcId: 'npc-1' },
      headers: { 'x-player-email': PLAYER_B.email, 'x-campaign-id': 'demo' },
    });

    expect(res.status).toBe(403);
  });
});

describe('session summary — turnExpectedFromYou', () => {
  it('returns true when player has not submitted a turn', async () => {
    const session = makeSession();
    session.companionPlayers = {
      'npc-1': { email: PLAYER_A.email, name: PLAYER_A.name, joinedAt: new Date().toISOString() },
    };
    session.pendingTurns = {};
    createSessionFile(tmpDir, HOST.email, 'demo', session);

    // Host hasn't submitted — turnExpectedFromYou should be true
    const res = await request('GET', `/api/sessions/${session.id}`, {
      headers: { 'x-player-email': HOST.email, 'x-campaign-id': 'demo' },
    });

    expect(res.status).toBe(200);
    expect(res.body.turnExpectedFromYou).toBe(true);
  });

  it('returns true for companion who has not submitted', async () => {
    const session = makeSession();
    session.companionPlayers = {
      'npc-1': { email: PLAYER_A.email, name: PLAYER_A.name, joinedAt: new Date().toISOString() },
    };
    session.pendingTurns = {
      [HOST.email]: { text: 'I attack', isHost: true },
    };
    createSessionFile(tmpDir, HOST.email, 'demo', session);

    // Companion hasn't submitted — turnExpectedFromYou should be true
    const res = await request('GET', `/api/sessions/${session.id}`, {
      headers: { 'x-player-email': PLAYER_A.email, 'x-campaign-id': 'demo' },
    });

    expect(res.status).toBe(200);
    expect(res.body.turnExpectedFromYou).toBe(true);
  });

  it('returns false when player has already submitted', async () => {
    const session = makeSession();
    session.companionPlayers = {
      'npc-1': { email: PLAYER_A.email, name: PLAYER_A.name, joinedAt: new Date().toISOString() },
    };
    session.pendingTurns = {
      [HOST.email]: { text: 'I attack', isHost: true },
    };
    createSessionFile(tmpDir, HOST.email, 'demo', session);

    // Host has submitted — turnExpectedFromYou should be false
    const res = await request('GET', `/api/sessions/${session.id}`, {
      headers: { 'x-player-email': HOST.email, 'x-campaign-id': 'demo' },
    });

    expect(res.status).toBe(200);
    expect(res.body.turnExpectedFromYou).toBe(false);
  });

  it('returns false for solo sessions with no companions', async () => {
    const session = makeSession();
    session.companionPlayers = {};
    createSessionFile(tmpDir, HOST.email, 'demo', session);

    const res = await request('GET', `/api/sessions/${session.id}`, {
      headers: { 'x-player-email': HOST.email, 'x-campaign-id': 'demo' },
    });

    expect(res.status).toBe(200);
    expect(res.body.turnExpectedFromYou).toBe(false);
  });
});

describe('session settings — turnMode removed', () => {
  it('does not include turnMode in default settings', async () => {
    const session = makeSession();
    createSessionFile(tmpDir, HOST.email, 'demo', session);

    const res = await request('GET', `/api/sessions/${session.id}`, {
      headers: { 'x-player-email': HOST.email, 'x-campaign-id': 'demo' },
    });

    expect(res.status).toBe(200);
    expect(res.body.settings).not.toHaveProperty('turnMode');
    expect(res.body.settings.visibility).toBe('public');
  });

  it('ignores turnMode in old session data without error', async () => {
    const session = makeSession();
    session.settings = { visibility: 'public', turnMode: 'initiative' };
    createSessionFile(tmpDir, HOST.email, 'demo', session);

    const res = await request('GET', `/api/sessions/${session.id}`, {
      headers: { 'x-player-email': HOST.email, 'x-campaign-id': 'demo' },
    });

    // Should load fine — turnMode in old data is silently carried through
    expect(res.status).toBe(200);
  });
});
