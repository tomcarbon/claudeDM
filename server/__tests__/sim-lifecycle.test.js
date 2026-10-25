/**
 * Simulation rails, Phase 0 (WO-0019). Four behaviours, no AI anywhere in this file.
 *
 *   1. A stopped agent releases its companion claim, so the human table it was in can play on.
 *   2. The permission listener is registered once, however many times the socket reconnects.
 *   3. A client with no injected permission policy DECLINES, and an unanswered request is
 *      declined by timeout rather than hanging the DM turn.
 *   4. The bot subsystem is mounted by the environment, and never in production.
 *
 * Zero model calls. The DM is `FakeDmEngine` (helpers/fake-dm-engine.js) injected through
 * `attachWebSocket`, and the suite-wide guard in helpers/no-live-agent.js — asserted by
 * no-live-agent.test.js — throws if any code path reaches the Claude Agent SDK's `query()`.
 * `assertNoLiveEngines()` runs after every test in this file as a third layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';

const { startTestServer, apiFetch } = require('./helpers/test-server');
const { createApp, botsAllowed } = require('../index');
const { BotWebSocketClient, DEFAULT_PERMISSION_TIMEOUT_MS } = require('../bot/bot-ws-client');
const { BotOrchestrator, SHUTDOWN_UNJOIN_TIMEOUT_MS } = require('../bot/bot-orchestrator');
const { BotApiClient, DEFAULT_API_TIMEOUT_MS } = require('../bot/bot-api-client');
const { ensurePlayerDataExists, getSessionDir, getPlayerCharactersDir } = require('../player-data');

const HOST = { email: 'host@test.com', name: 'Host Player' };
const ALICE = { email: 'alice@test.com', name: 'Alice' };
const AGENT = { email: 'bot_grix@bot.local', name: 'Bot_Grix' };

let tmpDir;
let srv;

/** The environment that turns the bot subsystem on: opt-in, and not production. */
const BOTS_ENV = { CLAUDEDM_BOTS: '1' };

// ── fixtures ────────────────────────────────────────────────────────────────────────────────

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function setupPlayers(dataDir) {
  writeJson(path.join(dataDir, 'players.json'), {
    [HOST.email]: { email: HOST.email, name: HOST.name, role: 'player' },
    [ALICE.email]: { email: ALICE.email, name: ALICE.name, role: 'player' },
    [AGENT.email]: { email: AGENT.email, name: AGENT.name, role: 'player' },
  });
}

function setupCharacterAndNpcs(dataDir) {
  ensurePlayerDataExists(dataDir, HOST.email, 'demo');
  writeJson(path.join(getPlayerCharactersDir(dataDir, HOST.email, 'demo'), 'hero.json'), {
    id: 'char-1', name: 'Bramble', race: 'Halfling', class: 'Druid', level: 3,
    hitPoints: { current: 25, max: 25 }, armorClass: 13, speed: 25, proficiencyBonus: 2,
    abilities: {
      strength: { score: 10, modifier: 0 }, dexterity: { score: 14, modifier: 2 },
      constitution: { score: 12, modifier: 1 }, intelligence: { score: 11, modifier: 0 },
      wisdom: { score: 16, modifier: 3 }, charisma: { score: 13, modifier: 1 },
    },
    status: 'alive',
  });
  writeJson(path.join(dataDir, 'defaults', 'demo', 'npcs', 'pip.json'), {
    id: 'npc-1', name: 'Pip', race: 'Gnome', class: 'Rogue', level: 2,
    hitPoints: { current: 15, max: 15 }, armorClass: 14, speed: 25, proficiencyBonus: 2,
    abilities: {
      strength: { score: 8, modifier: -1 }, dexterity: { score: 16, modifier: 3 },
      constitution: { score: 12, modifier: 1 }, intelligence: { score: 14, modifier: 2 },
      wisdom: { score: 10, modifier: 0 }, charisma: { score: 12, modifier: 1 },
    },
    status: 'alive',
  });
  writeJson(path.join(dataDir, 'defaults', 'demo', 'npcs', 'mara.json'), {
    id: 'npc-2', name: 'Mara', race: 'Human', class: 'Fighter', level: 2,
    hitPoints: { current: 20, max: 20 }, armorClass: 16, speed: 30, proficiencyBonus: 2,
    abilities: {
      strength: { score: 16, modifier: 3 }, dexterity: { score: 12, modifier: 1 },
      constitution: { score: 14, modifier: 2 }, intelligence: { score: 10, modifier: 0 },
      wisdom: { score: 11, modifier: 0 }, charisma: { score: 10, modifier: 0 },
    },
    status: 'alive',
  });
  writeJson(path.join(dataDir, 'dm-settings.json'), {
    humor: 50, drama: 50, responseLength: 'standard', difficulty: 50,
    tone: 'balanced', narrationStyle: 'descriptive', playerAgency: 'collaborative',
  });
}

function makeSession(dataDir, overrides = {}) {
  const id = overrides.id || uuidv4();
  const now = new Date().toISOString();
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
    createdAt: now,
    updatedAt: now,
    players: [{ id: uuidv4(), characterId: 'char-1', email: HOST.email, name: HOST.name, role: 'owner', joinedAt: now }],
    companionConfig: { states: { 'npc-1': 'player', 'npc-2': 'player' }, reservations: {} },
    companionPlayers: {},
    pendingTurns: {},
    ...overrides,
  };
  writeJson(path.join(getSessionDir(dataDir, session.id), 'session.json'), session);
  return session;
}

function readSession(dataDir, sessionId) {
  return JSON.parse(fs.readFileSync(path.join(getSessionDir(dataDir, sessionId), 'session.json'), 'utf-8'));
}

// ── a browser-shaped WS client ──────────────────────────────────────────────────────────────

const WebSocket = require('ws');

function connectClient(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const received = [];
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      received.push(msg);
    });
    ws.on('open', () => {
      resolve({
        ws,
        received,
        send(msg) { ws.send(JSON.stringify(msg)); },
        /**
         * Wait for a message of `type` that satisfies `match`, consuming it.
         *
         * The predicate matters. `turn_status` is broadcast on every join as well as on every
         * submission, so matching the first one that arrives would assert against a snapshot
         * taken before the event under test.
         */
        async waitFor(type, timeoutMs = 3000, match = () => true) {
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            const idx = received.findIndex(m => m.type === type && match(m));
            if (idx !== -1) return received.splice(idx, 1)[0];
            if (Date.now() >= deadline) {
              throw new Error(`Timeout waiting for ${type} (saw: ${received.map(m => m.type).join(', ') || 'nothing'})`);
            }
            await new Promise(r => setTimeout(r, 10));
          }
        },
        /** Assert nothing of `type` shows up in `ms`. */
        async expectNo(type, ms = 300) {
          await new Promise(r => setTimeout(r, ms));
          const seen = received.find(m => m.type === type);
          if (seen) throw new Error(`Unexpected ${type} within ${ms}ms`);
        },
        close() { ws.close(); },
      });
    });
    ws.on('error', reject);
  });
}

// Bounded teardown barrier — the same one ws-turns.test.js uses, for the same reason: two
// integrity-check calls in ws-handler are not awaited, so an atomic write can still be in flight
// when the test ends, and deleting tmpDir underneath it throws ENOENT out of writeJsonAtomic.
async function waitForQuiescence(dir, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  const hasTemp = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      if (e.isDirectory()) { if (hasTemp(path.join(d, e.name))) return true; }
      else if (e.name.includes('.tmp-')) return true;
    }
    return false;
  };
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  await new Promise(r => setTimeout(r, 25));
  while (Date.now() < deadline) {
    if (!hasTemp(dir)) return true;
    await new Promise(r => setTimeout(r, 10));
  }
  return false;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudedm-sim-'));
  setupPlayers(tmpDir);
  setupCharacterAndNpcs(tmpDir);
  srv = await startTestServer(tmpDir, { env: BOTS_ENV });
});

afterEach(async () => {
  if (srv) {
    await srv.close();
    srv.assertNoLiveEngines();
    srv = null;
  }
  await waitForQuiescence(tmpDir);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. The stall
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Build the minimum bot record `stop()` operates on: an API client pointed at the test server,
 * a chat socket stub, and one companion session slot holding a claim. Nothing here starts a
 * lookup loop or a tick timer, because `stop()` does not care whether one was running — it
 * closes whatever slots the bot has.
 */
function makeAgentRecord(port, sessionId, { role = 'companion', companionNpcId = 'npc-1' } = {}) {
  return {
    email: AGENT.email,
    name: AGENT.name,
    role: 'either',
    turnDelayMs: 60000,
    maxSessionsPerBot: 1,
    api: new BotApiClient({ email: AGENT.email, port }),
    chatWs: { connected: false, close() { this.closed = true; } },
    sessions: new Map([[sessionId, {
      sessionId,
      sessionLabel: null,
      campaignId: 'demo',
      characterId: null,
      scenarioId: 'demo',
      character: null,
      role,
      companionNpcId,
      companionNpcName: 'Pip',
      state: 'idle',
      ws: null,
      recentMessages: [],
      allMessages: [],
      claudeSessionId: null,
      tickTimer: null,
    }]]),
    lastActionTime: null,
  };
}

describe('a stopped agent must not stall the table it was in', () => {
  it('stop() releases the companion claim, and the next checkAutoFire fires without it', async () => {
    const session = makeSession(tmpDir, {
      companionPlayers: {
        'npc-1': { email: AGENT.email, name: AGENT.name, joinedAt: new Date().toISOString() },
        'npc-2': { email: ALICE.email, name: ALICE.name, joinedAt: new Date().toISOString() },
      },
    });

    const host = await connectClient(srv.wsUrl);
    host.send({ type: 'session_watch', sessionDbId: session.id, playerEmail: HOST.email, playerName: HOST.name });
    const hostAccess = await host.waitFor('session_access');
    expect(hostAccess.canWrite).toBe(true);

    const alice = await connectClient(srv.wsUrl);
    alice.send({ type: 'session_watch', sessionDbId: session.id, playerEmail: ALICE.email, playerName: ALICE.name });
    const aliceAccess = await alice.waitFor('session_access');
    expect(aliceAccess.companionNpcId).toBe('npc-2');

    // The host takes their turn. Two companions are claimed, so the table waits.
    host.send({ type: 'host_turn_submit', text: 'We push open the chapel door.' });
    const waiting = await host.waitFor('turn_status', 3000, m => m.hostSubmitted);
    expect(waiting.hostSubmitted).toBe(true);
    expect(waiting.joinedCompanionCount).toBe(2);
    expect(waiting.allReady).toBe(false);

    // The agent goes away. This is the whole test: before the fix `stop()` closed the socket and
    // left the claim behind, so the table below could never reach allReady again.
    const orchestrator = new BotOrchestrator(tmpDir, srv.port);
    orchestrator.bots.set(AGENT.email, makeAgentRecord(srv.port, session.id));
    await orchestrator.stop();

    const after = readSession(tmpDir, session.id);
    expect(after.companionPlayers['npc-1']).toBeUndefined();   // the departed agent's claim
    expect(after.companionPlayers['npc-2']).toBeDefined();     // the human's claim is untouched
    expect(orchestrator.bots.size).toBe(0);

    // Everyone still at the table submits — and the DM fires, which it could not do while a
    // departed agent still counted as a player who owed a turn.
    alice.send({ type: 'companion_turn_submit', text: 'I ready my bow.', npcName: 'Pip' });
    const dm = await host.waitFor('dm_response', 5000);
    expect(dm.text).toContain('[fake DM]');
    await host.waitFor('dm_complete', 5000);

    host.close();
    alice.close();
  });

  it('the claim survives a slot closed without unjoining — the failure mode being fixed', async () => {
    // Guards the fix from the other side: `_closeSessionSlot` on its own still does not touch
    // the session file. If someone ever moves the unjoin into it, this test says so out loud
    // rather than leaving two places that both think they own the release.
    const session = makeSession(tmpDir, {
      companionPlayers: { 'npc-1': { email: AGENT.email, name: AGENT.name, joinedAt: new Date().toISOString() } },
    });
    const orchestrator = new BotOrchestrator(tmpDir, srv.port);
    const bot = makeAgentRecord(srv.port, session.id);
    orchestrator.bots.set(AGENT.email, bot);

    const closed = orchestrator._closeSessionSlot(bot, bot.sessions.get(session.id), { force: true });

    expect(closed).toBe(true);
    expect(readSession(tmpDir, session.id).companionPlayers['npc-1']).toBeDefined();
  });

  it('stop() leaves a host slot with a human companion alone, and claims nothing to release', async () => {
    const session = makeSession(tmpDir, {
      companionPlayers: { 'npc-2': { email: ALICE.email, name: ALICE.name, joinedAt: new Date().toISOString() } },
    });
    // The bot hosts; a human is in the party. `_closeSessionSlot`'s protection applies, and a
    // host slot holds no companion claim of its own, so nothing is unjoined.
    const orchestrator = new BotOrchestrator(tmpDir, srv.port);
    const bot = makeAgentRecord(srv.port, session.id, { role: 'host', companionNpcId: null });
    // _hasHumanCompanions reads the bot's own per-player session copy, so give it one.
    const slug = AGENT.email.toLowerCase().replace(/[^a-z0-9]/g, '-');
    writeJson(path.join(tmpDir, 'players', slug, 'demo', 'sessions', `${session.id}.json`), session);
    orchestrator.bots.set(AGENT.email, bot);

    await orchestrator.stop();

    expect(bot.sessions.size).toBe(1);                                   // slot kept alive
    expect(orchestrator.bots.size).toBe(1);                              // bot kept alive
    expect(readSession(tmpDir, session.id).companionPlayers['npc-2']).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2 & 3. The permission surface
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A bare WebSocket server that asks one permission question per connection and records the
 * answer. Deliberately not the app: the question here is what the *client* says, and routing it
 * through a DM turn would only add ways for the test to be about something else.
 */
async function startPermissionServer() {
  const answers = [];
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', path: '/ws' });
  await new Promise(resolve => wss.once('listening', resolve));
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      try { answers.push(JSON.parse(data.toString())); } catch { /* ignore */ }
    });
    ws.send(JSON.stringify({
      type: 'permission_request',
      toolUseID: 'tool-use-1',
      toolName: 'mcp__dnd-tools__OverrideMechanicalState',
      description: 'The DM wants to set Bramble\'s hit points to 25 (currently 0).',
    }));
  });
  return {
    port: wss.address().port,
    answers,
    async close() {
      for (const c of wss.clients) c.terminate();
      await new Promise(resolve => wss.close(resolve));
    },
  };
}

/** Resolves true once `answers` holds at least `n` permission responses. */
async function waitForAnswerCount(answers, n, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (answers.filter(a => a.type === 'permission_response').length >= n) return true;
    await new Promise(r => setTimeout(r, 10));
  }
  return false;
}

async function waitForAnswer(answers, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = answers.find(a => a.type === 'permission_response');
    if (found) return found;
    await new Promise(r => setTimeout(r, 10));
  }
  return null;
}

describe('the permission listener', () => {
  it('is registered exactly once, however many times connect() runs', async () => {
    const client = new BotWebSocketClient({ email: AGENT.email, name: AGENT.name, port: srv.port });
    const sockets = [];

    for (let i = 0; i < 3; i++) {
      client.connect();                                  // what _scheduleReconnect does
      sockets.push(client.ws);
      await new Promise((resolve, reject) => {
        client.ws.once('open', resolve);
        client.ws.once('error', reject);
      });
    }

    expect(client.listenerCount('permission_request')).toBe(1);

    client.close();                                      // sets _closed, so no reconnect fires
    for (const s of sockets) s.close();
  });

  it('answers a request exactly once even after reconnects', async () => {
    const perm = await startPermissionServer();
    try {
      const client = new BotWebSocketClient({ email: AGENT.email, name: AGENT.name, port: perm.port });
      const sockets = [];
      for (let i = 0; i < 3; i++) {
        client.connect();
        sockets.push(client.ws);
        await new Promise((resolve, reject) => {
          client.ws.once('open', resolve);
          client.ws.once('error', reject);
        });
        expect(await waitForAnswerCount(perm.answers, i + 1)).toBe(true);
      }
      // Settle before counting. Asserting the moment the count first reaches 3 is a race that
      // the duplicated-listener build wins: it emits 1, then 2, then 3 answers (six in total),
      // and passes through exactly 3 on the way. Wait for the extras to arrive if they are
      // coming, then count.
      await new Promise(r => setTimeout(r, 250));
      // Three connections, three questions, three answers — not one question answered N times.
      expect(perm.answers.filter(a => a.type === 'permission_response')).toHaveLength(3);
      client.close();
      for (const s of sockets) s.close();
    } finally {
      await perm.close();
    }
  });
});

describe('the permission policy', () => {
  it('declines when no policy is injected', async () => {
    const perm = await startPermissionServer();
    try {
      const client = new BotWebSocketClient({ email: AGENT.email, name: AGENT.name, port: perm.port });
      client.connect();
      const answer = await waitForAnswer(perm.answers);
      expect(answer).not.toBeNull();
      expect(answer.allowed).toBe(false);
      expect(answer.toolUseID).toBe('tool-use-1');
      client.close();
    } finally {
      await perm.close();
    }
  });

  it('asks the injected policy, and passes it the whole request', async () => {
    const perm = await startPermissionServer();
    try {
      const seen = [];
      const client = new BotWebSocketClient({
        email: AGENT.email, name: AGENT.name, port: perm.port,
        onPermissionRequest: (msg) => { seen.push(msg); return true; },
      });
      client.connect();
      const answer = await waitForAnswer(perm.answers);
      expect(answer.allowed).toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0].toolName).toBe('mcp__dnd-tools__OverrideMechanicalState');
      expect(seen[0].description).toContain('hit points');
      client.close();
    } finally {
      await perm.close();
    }
  });

  it('declines when the policy returns anything other than true', async () => {
    for (const verdict of [false, null, undefined, 'yes', 1]) {
      const perm = await startPermissionServer();
      try {
        const client = new BotWebSocketClient({
          email: AGENT.email, name: AGENT.name, port: perm.port,
          onPermissionRequest: () => verdict,
        });
        client.connect();
        const answer = await waitForAnswer(perm.answers);
        expect(answer.allowed, `verdict ${String(verdict)} must not be an approval`).toBe(false);
        client.close();
      } finally {
        await perm.close();
      }
    }
  });

  it('declines when the policy throws', async () => {
    const perm = await startPermissionServer();
    try {
      const client = new BotWebSocketClient({
        email: AGENT.email, name: AGENT.name, port: perm.port,
        onPermissionRequest: () => { throw new Error('policy exploded'); },
      });
      client.connect();
      const answer = await waitForAnswer(perm.answers);
      expect(answer.allowed).toBe(false);
      client.close();
    } finally {
      await perm.close();
    }
  });

  it('declines by timeout when the policy never answers, and answers only once', async () => {
    const perm = await startPermissionServer();
    try {
      let release;
      const client = new BotWebSocketClient({
        email: AGENT.email, name: AGENT.name, port: perm.port,
        permissionTimeoutMs: 60,
        onPermissionRequest: () => new Promise((resolve) => { release = resolve; }),
      });
      client.connect();

      const answer = await waitForAnswer(perm.answers);
      expect(answer.allowed).toBe(false);

      // The late approval loses. Whoever got there first is the answer; the engine has already
      // been told no and must not be told yes afterwards.
      release(true);
      await new Promise(r => setTimeout(r, 100));
      expect(perm.answers.filter(a => a.type === 'permission_response')).toHaveLength(1);
      client.close();
    } finally {
      await perm.close();
    }
  });

  it('defaults the timeout to 20 seconds', () => {
    const client = new BotWebSocketClient({ email: AGENT.email, name: AGENT.name, port: srv.port });
    expect(client.permissionTimeoutMs).toBe(20_000);
    expect(DEFAULT_PERMISSION_TIMEOUT_MS).toBe(20_000);
    client.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 4. The production gate
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('the bot subsystem is gated by the environment', () => {
  it('botsAllowed requires an explicit opt-in and fails closed (SR-1)', () => {
    // The absent variable is the case that matters. NODE_ENV is set nowhere in this project, so
    // a gate of `NODE_ENV !== 'production'` reads `undefined !== 'production'` — true — and
    // mounts the bot admin router on a real server. An unset environment must mean no.
    expect(botsAllowed({})).toBe(false);
    // NOT `botsAllowed(undefined)`: that triggers the default parameter and reads the ambient
    // `process.env`, so it asserted nothing about the argument and passed only because the
    // variable happens to be unset on this machine. `null` skips the default and exercises the
    // `(env || {})` guard, which is the thing under test.
    expect(botsAllowed(null)).toBe(false);
    expect(botsAllowed({ NODE_ENV: 'development' })).toBe(false);
    expect(botsAllowed({ NODE_ENV: undefined })).toBe(false);

    expect(botsAllowed({ CLAUDEDM_BOTS: '1' })).toBe(true);
    expect(botsAllowed({ CLAUDEDM_BOTS: '1', NODE_ENV: 'development' })).toBe(true);

    // Production wins over the opt-in.
    expect(botsAllowed({ CLAUDEDM_BOTS: '1', NODE_ENV: 'production' })).toBe(false);

    // Only the exact string opts in — no truthiness, no 'true', no 'yes'.
    for (const v of ['0', '', 'true', 'yes', 'on', 1, true]) {
      expect(botsAllowed({ CLAUDEDM_BOTS: v }), `CLAUDEDM_BOTS=${String(v)} must not opt in`).toBe(false);
    }
  });

  it('reads process.env when called with no argument, against a stubbed environment', () => {
    // The default parameter is real behaviour and worth pinning, but it must be pinned against a
    // stubbed environment rather than the developer's shell — otherwise exporting CLAUDEDM_BOTS=1
    // turns the suite red for a reason that has nothing to do with the code.
    const saved = Object.prototype.hasOwnProperty.call(process.env, 'CLAUDEDM_BOTS')
      ? process.env.CLAUDEDM_BOTS
      : undefined;
    try {
      delete process.env.CLAUDEDM_BOTS;
      expect(botsAllowed()).toBe(false);

      process.env.CLAUDEDM_BOTS = '1';
      const savedNode = Object.prototype.hasOwnProperty.call(process.env, 'NODE_ENV')
        ? process.env.NODE_ENV
        : undefined;
      try {
        delete process.env.NODE_ENV;
        expect(botsAllowed()).toBe(true);
        process.env.NODE_ENV = 'production';
        expect(botsAllowed()).toBe(false);
      } finally {
        if (savedNode === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = savedNode;
      }
    } finally {
      if (saved === undefined) delete process.env.CLAUDEDM_BOTS;
      else process.env.CLAUDEDM_BOTS = saved;
    }
  });

  it('mounts nothing without the opt-in — the default on the chair\'s box', async () => {
    const app = createApp(tmpDir, { port: 0, env: {} });
    expect(app.locals.botOrchestrator).toBeNull();

    const plain = await startTestServer(tmpDir);   // env defaults to {}
    try {
      const res = await apiFetch(plain.baseUrl, '/api/bots/status');
      expect(res.status).toBe(404);
      expect(res.json === null || res.json.activeBots === undefined).toBe(true);
    } finally {
      await plain.close();
    }
  });

  it('mounts nothing when NODE_ENV=production, opt-in or not', async () => {
    expect(createApp(tmpDir, { port: 0, env: { NODE_ENV: 'production' } }).locals.botOrchestrator).toBeNull();
    expect(createApp(tmpDir, { port: 0, env: { NODE_ENV: 'production', CLAUDEDM_BOTS: '1' } })
      .locals.botOrchestrator).toBeNull();

    const prod = await startTestServer(tmpDir, { env: { NODE_ENV: 'production', CLAUDEDM_BOTS: '1' } });
    try {
      const res = await apiFetch(prod.baseUrl, '/api/bots/status', { email: HOST.email });
      // Whatever production serves at that path, it is not the orchestrator's status.
      expect(res.json === null || res.json.activeBots === undefined).toBe(true);
    } finally {
      await prod.close();
    }
  });

  it('mounts the router when opted in, with no bot-config.json anywhere', async () => {
    // The chicken-and-egg this replaced: the router that writes data/bot-config.json only
    // mounted when that file already existed and said enabled:true. One environment variable
    // now gets you the admin UI that writes the file.
    expect(fs.existsSync(path.join(tmpDir, 'bot-config.json'))).toBe(false);

    expect(srv.app.locals.botOrchestrator).not.toBeNull();
    const res = await apiFetch(srv.baseUrl, '/api/bots/status', { email: HOST.email });
    expect(res.status).toBe(200);
    expect(res.json.activeBots).toBe(0);
    expect(res.json.enabled).toBe(false);   // mounted, but no bots run until config says so
  });

  it('mounting the subsystem starts nothing — no bots, no timers, no config written', async () => {
    const orchestrator = srv.app.locals.botOrchestrator;
    expect(orchestrator.bots.size).toBe(0);
    expect(orchestrator._running).toBe(false);
    expect(orchestrator._lookupTimers.size).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, 'bot-config.json'))).toBe(false);
  });
});

describe('who can reach the bot endpoints, as it actually is', () => {
  // Written against the behaviour, not the intention. The comment on routes/bots.js used to
  // claim /status was "visible to all logged-in users"; it is declared above requireAdmin, so
  // Express never applies the middleware to it and there is no login in it at all. The previous
  // version of this test only ever asked with a valid email, which cannot tell the two apart.
  it('GET /status answers a caller with no headers at all', async () => {
    const res = await apiFetch(srv.baseUrl, '/api/bots/status');   // no X-Player-Email
    expect(res.status).toBe(200);
    expect(res.json.activeBots).toBe(0);
    expect(Array.isArray(res.json.bots)).toBe(true);
  });

  it('every mutating endpoint refuses a caller with no headers', async () => {
    const attempts = [
      ['POST', '/api/bots/add', { role: 'host', count: 1 }],
      ['POST', '/api/bots/stop', {}],
      ['POST', '/api/bots/disconnect', { botEmail: AGENT.email, sessionId: 'x' }],
      ['DELETE', `/api/bots/bot/${encodeURIComponent(AGENT.email)}`, undefined],
    ];
    for (const [method, route, body] of attempts) {
      const res = await apiFetch(srv.baseUrl, route, { method, body });
      expect(res.status, `${method} ${route}`).toBe(403);
    }
    // And nothing was created by trying.
    expect(srv.app.locals.botOrchestrator.bots.size).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, 'bot-config.json'))).toBe(false);
  });

  it('a non-admin player is refused the mutating endpoints too', async () => {
    const res = await apiFetch(srv.baseUrl, '/api/bots/add', {
      method: 'POST', email: HOST.email, body: { role: 'host', count: 1 },
    });
    expect(res.status).toBe(403);
  });
});

describe('shutdown is bounded (SR-5)', () => {
  it('every bot API call carries an abort deadline', () => {
    expect(Number.isFinite(DEFAULT_API_TIMEOUT_MS)).toBe(true);
    expect(new BotApiClient({ email: AGENT.email, port: srv.port }).timeoutMs).toBe(DEFAULT_API_TIMEOUT_MS);
    expect(Number.isFinite(SHUTDOWN_UNJOIN_TIMEOUT_MS)).toBe(true);
    expect(SHUTDOWN_UNJOIN_TIMEOUT_MS).toBeLessThan(DEFAULT_API_TIMEOUT_MS);
  });

  it('stop() returns even when the unjoin never gets a reply', async () => {
    // A server that accepts the connection and then says nothing, forever. Before the abort
    // signal this is where Ctrl-C went to die: SIGINT awaits stop(), stop() awaits fetch(),
    // and fetch has no default timeout.
    const net = require('net');
    const deafSockets = [];
    const deaf = net.createServer((socket) => {
      deafSockets.push(socket);   // accept, never respond, never close
    });
    await new Promise(resolve => deaf.listen(0, '127.0.0.1', resolve));
    const deafPort = deaf.address().port;

    try {
      const session = makeSession(tmpDir, {
        companionPlayers: { 'npc-1': { email: AGENT.email, name: AGENT.name, joinedAt: new Date().toISOString() } },
      });
      const orchestrator = new BotOrchestrator(tmpDir, deafPort);
      const bot = makeAgentRecord(deafPort, session.id);
      bot.api = new BotApiClient({ email: AGENT.email, port: deafPort, timeoutMs: 150 });
      orchestrator.bots.set(AGENT.email, bot);

      const started = Date.now();
      await orchestrator.stop();
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(2000);
      // The slot is still torn down — a failed unjoin must not leave the bot half-alive.
      expect(bot.sessions.size).toBe(0);
      expect(orchestrator.bots.size).toBe(0);
    } finally {
      // Destroy the accepted sockets first. The aborted request leaves one open on the server
      // side and net.Server.close() waits for it, so closing alone hangs the teardown — which
      // is how this test first failed, at 5s, looking exactly like the bug it tests for.
      for (const socket of deafSockets) socket.destroy();
      await new Promise(resolve => deaf.close(resolve));
    }
  });
});
