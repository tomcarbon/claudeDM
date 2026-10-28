import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// WO-0050: the Premium gate. A per-player `premiumAccess` flag (default true) decides whether a
// player may START a new adventure in a Premium campaign; Premium means "not on the server's free
// allowlist", never "badged Premium". Measured against the real app and the real WebSocket
// handler (helpers/test-server.js: fake DM engine, temp data dir, no live agent).

const { startTestServer } = require('./helpers/test-server');
const WebSocket = require('ws');
const {
  DEFAULT_PREMIUM_ACCESS, resolvePremiumAccess, getPremiumAccessForEmail, getAuthenticatedPlayer,
} = require('../player-auth');
const { FREE_CAMPAIGN_IDS, PREMIUM_REFUSAL_MESSAGE, isPremiumCampaign, canStartCampaign } = require('../premium-gate');

const REPO_CAMPAIGNS = path.join(__dirname, '..', '..', 'data', 'campaigns');

const NO_ACCESS = 'locked@test.com';   // premiumAccess: false
const HAS_ACCESS = 'open@test.com';    // premiumAccess: true
const NO_FIELD = 'legacy@test.com';    // record predates WO-0050: no field at all

let tmpDir;
let srv;

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function readTmpPlayers() {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, 'players.json'), 'utf-8'));
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'premium-gate-'));
  writeJson(path.join(tmpDir, 'players.json'), {
    [NO_ACCESS]: { email: NO_ACCESS, name: 'Locked', role: 'player', premiumAccess: false },
    [HAS_ACCESS]: { email: HAS_ACCESS, name: 'Open', role: 'player', premiumAccess: true },
    [NO_FIELD]: { email: NO_FIELD, name: 'Legacy', role: 'player' },
  });
  for (const id of ['demo', 'coldwar']) {
    writeJson(path.join(tmpDir, 'campaigns', id, 'campaign.json'), {
      id, title: id, listing: { badge: id === 'demo' ? 'Free' : 'Premium' },
    });
    writeJson(path.join(tmpDir, 'defaults', id, 'characters', 'a.json'), { id: 'a', name: 'A', status: 'alive' });
  }
  // A character only the Premium campaign has, so a snapshot from the wrong campaign is visible.
  writeJson(path.join(tmpDir, 'defaults', 'coldwar', 'characters', 'cw.json'), { id: 'cw', name: 'Coldwar Only', status: 'alive' });
  // A campaign whose author badged it Free and claimed `premium: false` in its own body. Neither
  // may make it free: only the server's allowlist does.
  writeJson(path.join(tmpDir, 'campaigns', 'sneaky', 'campaign.json'), {
    id: 'sneaky', title: 'Sneaky', premium: false, listing: { badge: 'Free' },
  });
  fs.mkdirSync(path.join(tmpDir, 'players'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'sessions'), { recursive: true });
  srv = await startTestServer(tmpDir);
});

afterEach(async () => {
  srv.assertNoLiveEngines();
  await srv.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function post(p, { email, campaignId, body = {} } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (email) headers['X-Player-Email'] = email;
  if (campaignId) headers['X-Campaign-Id'] = campaignId;
  return fetch(`${srv.baseUrl}${p}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

const createSession = (email, campaignId) => post('/api/sessions', {
  email, campaignId, body: { name: 'T', scenarioId: campaignId, characterId: 'a', messages: [] },
});

// A WebSocket client that records every message it is sent.
async function connect() {
  const ws = new WebSocket(srv.wsUrl);
  const got = [];
  ws.on('message', (raw) => { try { got.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return {
    got,
    send: (m) => ws.send(JSON.stringify(m)),
    async waitFor(pred, ms = 2000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const hit = got.find(pred);
        if (hit) return hit;
        if (Date.now() > deadline) return null;
        await new Promise(r => setTimeout(r, 10));
      }
    },
    close: () => ws.close(),
  };
}
const isRefusal = (m) => m.type === 'error' && m.error === PREMIUM_REFUSAL_MESSAGE;
const isIdle = (m) => m.type === 'session_status' && m.status === 'idle';
const startMsg = (email, campaignId) => ({ type: 'session_start', playerEmail: email, playerName: 'P', campaignId, characterId: 'a', scenarioId: campaignId });
const engineRuns = () => srv.engineFactory.created.reduce((n, e) => n + e.calls.filter(c => c.kind === 'run').length, 0);

describe('the flag (player-auth.js)', () => {
  it('defaults to true; absent means the default; only exactly `true` grants; anything else fails closed', () => {
    expect(DEFAULT_PREMIUM_ACCESS).toBe(true);
    expect(resolvePremiumAccess(null)).toBe(true);
    expect(resolvePremiumAccess({})).toBe(true);
    expect(resolvePremiumAccess({ premiumAccess: true })).toBe(true);
    expect(resolvePremiumAccess({ premiumAccess: false })).toBe(false);
    for (const v of ['false', 'true', 0, 1, null]) expect(resolvePremiumAccess({ premiumAccess: v }), String(v)).toBe(false);
  });

  it('guests and unknown emails get the default; a record decides for its own email', () => {
    expect(getPremiumAccessForEmail(tmpDir, 'guest')).toBe(true);
    expect(getPremiumAccessForEmail(tmpDir, '')).toBe(true);
    expect(getPremiumAccessForEmail(tmpDir, 'nobody@test.com')).toBe(true);
    expect(getPremiumAccessForEmail(tmpDir, NO_FIELD)).toBe(true);
    expect(getPremiumAccessForEmail(tmpDir, HAS_ACCESS)).toBe(true);
    expect(getPremiumAccessForEmail(tmpDir, ` ${NO_ACCESS.toUpperCase()} `)).toBe(false);
  });

  it('getAuthenticatedPlayer passes the raw field through (undefined = use default), like maxSessions', () => {
    const asReq = (email) => ({ get: (h) => (h.toLowerCase() === 'x-player-email' ? email : undefined) });
    expect(getAuthenticatedPlayer(tmpDir, asReq(NO_FIELD)).premiumAccess).toBeUndefined();
    expect(getAuthenticatedPlayer(tmpDir, asReq(NO_ACCESS)).premiumAccess).toBe(false);
  });
});

describe('which campaigns are Premium (premium-gate.js)', () => {
  it('the free allowlist is the demo; everything else — unknown, missing, user-created — is Premium', () => {
    expect([...FREE_CAMPAIGN_IDS]).toEqual(['demo']);
    expect(isPremiumCampaign('demo')).toBe(false);
    for (const id of ['coldwar', 'campaign1', 'sneaky', 'no-such-campaign', '', null, undefined]) {
      expect(isPremiumCampaign(id), String(id)).toBe(true);
    }
    expect(canStartCampaign(false, 'demo')).toBe(true);
    expect(canStartCampaign(false, 'coldwar')).toBe(false);
    expect(canStartCampaign(true, 'coldwar')).toBe(true);
    expect(canStartCampaign(true, 'no-such-campaign')).toBe(true);
  });

  it('the refusal says nothing about money or buying (decision 0008)', () => {
    expect(PREMIUM_REFUSAL_MESSAGE).toBe("This campaign isn't available on your account.");
    expect(PREMIUM_REFUSAL_MESSAGE).not.toMatch(/buy|purchas|pay|price|cost|upgrade|subscri|\$|money|premium/i);
  });

  it('the shipped badges agree with the allowlist: Free exactly for allowlisted ids, Premium for every other', () => {
    const shipped = fs.readdirSync(REPO_CAMPAIGNS)
      .filter(d => fs.existsSync(path.join(REPO_CAMPAIGNS, d, 'campaign.json')))
      .map(d => JSON.parse(fs.readFileSync(path.join(REPO_CAMPAIGNS, d, 'campaign.json'), 'utf-8')));
    expect(shipped.length).toBeGreaterThan(1);
    for (const id of FREE_CAMPAIGN_IDS) expect(shipped.some(c => c.id === id), `allowlisted ${id} ships`).toBe(true);
    for (const c of shipped) {
      expect(c.listing?.badge, c.id).toBe(isPremiumCampaign(c.id) ? 'Premium' : 'Free');
    }
  });

  it('GET /api/campaigns reports `premium` from the allowlist, not the badge or a body field', async () => {
    const list = await (await fetch(`${srv.baseUrl}/api/campaigns`)).json();
    const byId = Object.fromEntries(list.map(c => [c.id, c]));
    expect(byId.demo.premium).toBe(false);
    expect(byId.coldwar.premium).toBe(true);
    expect(byId.sneaky.listing.badge).toBe('Free');
    expect(byId.sneaky.premium).toBe(true);
    const full = await (await fetch(`${srv.baseUrl}/api/campaigns/sneaky`)).json();
    expect(full.premium).toBe(true);
  });
});

describe('players routes', () => {
  it('register writes premiumAccess: <default> and IGNORES a premiumAccess in the request body', async () => {
    for (const [email, sent] of [['a@test.com', false], ['b@test.com', 'false'], ['c@test.com', true]]) {
      const res = await post('/api/players/register', { body: { email, name: 'N', password: 'pw1', premiumAccess: sent } });
      expect(res.status, email).toBe(201);
      expect((await res.json()).premiumAccess, email).toBe(DEFAULT_PREMIUM_ACCESS);
      expect(readTmpPlayers()[email].premiumAccess, email).toBe(DEFAULT_PREMIUM_ACCESS);
    }
  });

  it('login reports the resolved flag: false for a false record, the default for a record with none', async () => {
    const reg = await post('/api/players/register', { body: { email: 'd@test.com', name: 'D', password: 'pw1' } });
    expect(reg.status).toBe(201);
    const players = readTmpPlayers();
    players['d@test.com'].premiumAccess = false; // the only way to change it: edit the file
    writeJson(path.join(tmpDir, 'players.json'), players);
    const login = await post('/api/players/login', { body: { email: 'd@test.com', password: 'pw1' } });
    expect((await login.json()).premiumAccess).toBe(false);

    delete players['d@test.com'].premiumAccess;
    writeJson(path.join(tmpDir, 'players.json'), players);
    const again = await post('/api/players/login', { body: { email: 'd@test.com', password: 'pw1' } });
    expect((await again.json()).premiumAccess).toBe(true);
  });
});

describe('POST /api/sessions — a new adventure over REST', () => {
  it('refuses a false player in a Premium campaign with 403 and the message, and writes no session', async () => {
    const res = await createSession(NO_ACCESS, 'coldwar');
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(PREMIUM_REFUSAL_MESSAGE);
    expect(fs.readdirSync(path.join(tmpDir, 'sessions'))).toEqual([]);
  });

  it('allows a true player and a player with no field (the default) in the same campaign', async () => {
    for (const email of [HAS_ACCESS, NO_FIELD]) {
      const res = await createSession(email, 'coldwar');
      expect(res.status, email).toBe(201);
      expect((await res.json()).campaignId, email).toBe('coldwar');
    }
  });

  it('allows a false player in the free allowlist, with or without an explicit header', async () => {
    expect((await createSession(NO_ACCESS, 'demo')).status).toBe(201);
    expect((await createSession(NO_ACCESS, undefined)).status).toBe(201);
  });

  it('refuses a false player in an unknown campaign and in a self-badged Free one', async () => {
    for (const cid of ['no-such-campaign', 'sneaky']) {
      expect((await createSession(NO_ACCESS, cid)).status, cid).toBe(403);
    }
  });

  it('refuses a false player in a campaign they just created through POST /api/campaigns, badged Free', async () => {
    const made = await post('/api/campaigns', {
      email: NO_ACCESS, body: { id: 'my-own', title: 'Mine', premium: false, listing: { badge: 'Free' } },
    });
    expect(made.status).toBe(201);
    expect((await made.json()).premium).toBe(true);
    expect((await createSession(NO_ACCESS, 'my-own')).status).toBe(403);
  });

  it('a body campaignId cannot route around the header', async () => {
    const res = await post('/api/sessions', {
      email: NO_ACCESS, campaignId: 'coldwar', body: { name: 'T', campaignId: 'demo', characterId: 'a' },
    });
    expect(res.status).toBe(403);
  });
});

describe('WebSocket — a new adventure over the socket', () => {
  it('session_start: a false player in a Premium campaign is refused, and the next user_message does not reach the GM', async () => {
    const c = await connect();
    c.send(startMsg(NO_ACCESS, 'coldwar'));
    expect(await c.waitFor(isRefusal)).not.toBeNull();
    expect(c.got.some(isIdle)).toBe(false);
    // The client sends its opening prompt ~500 ms after session_start. It must not run anywhere.
    c.got.length = 0;
    c.send({ type: 'user_message', text: 'Begin the adventure.' });
    expect(await c.waitFor(isRefusal)).not.toBeNull();
    await new Promise(r => setTimeout(r, 100));
    expect(engineRuns()).toBe(0);
    c.close();
  });

  it('session_start: true, absent and the free allowlist are allowed, and the GM runs', async () => {
    // Revision 4 (Part C) removed `['unregistered@test.com', 'coldwar']` from this list: it asserted
    // that an unregistered email may start a game, which the chair reversed ("only logged in users
    // should be able to start a new game"). Its refusal is tested in login-required.test.js.
    for (const [email, cid] of [[HAS_ACCESS, 'coldwar'], [NO_FIELD, 'coldwar'], [NO_ACCESS, 'demo']]) {
      const c = await connect();
      c.send(startMsg(email, cid));
      expect(await c.waitFor(isIdle), `${email} ${cid}`).not.toBeNull();
      expect(c.got.some(isRefusal), `${email} ${cid}`).toBe(false);
      c.close();
    }
    const c = await connect();
    c.send(startMsg(NO_ACCESS, 'demo'));
    await c.waitFor(isIdle);
    c.got.length = 0;
    c.send({ type: 'user_message', text: 'hello' });
    expect(await c.waitFor(isIdle)).not.toBeNull();
    expect(engineRuns()).toBe(1);
    c.close();
  });

  it('session_start: unknown and self-badged campaigns are refused for a false player', async () => {
    for (const cid of ['no-such-campaign', 'sneaky']) {
      const c = await connect();
      c.send(startMsg(NO_ACCESS, cid));
      expect(await c.waitFor(isRefusal), cid).not.toBeNull();
      c.close();
    }
  });

  // Revision 3: changed from "the next user_message runs in demo" to "the next user_message is
  // refused". A refusal is now sticky (`startRefused`) until a successful start, resume or own-save
  // watch, so a turn sent after a refused resume runs nowhere rather than in the previous context.
  it('session_resume with no saved game cannot be used as a start; the next user_message is refused, and a fresh start clears it', async () => {
    const c = await connect();
    c.send(startMsg(NO_ACCESS, 'demo'));
    await c.waitFor(isIdle);
    c.got.length = 0;
    c.send({ type: 'session_resume', playerEmail: NO_ACCESS, campaignId: 'coldwar', characterId: 'a', messages: [] });
    expect(await c.waitFor(isRefusal)).not.toBeNull();
    c.got.length = 0;
    c.send({ type: 'user_message', text: 'hello' });
    expect(await c.waitFor(isRefusal)).not.toBeNull();
    await new Promise(r => setTimeout(r, 100));
    expect(srv.engineFactory.created.flatMap(e => e.calls).filter(x => x.kind === 'run')).toHaveLength(0);
    c.got.length = 0;
    c.send(startMsg(NO_ACCESS, 'demo'));
    await c.waitFor(isIdle);
    c.got.length = 0;
    c.send({ type: 'user_message', text: 'hello' });
    await c.waitFor(isIdle, 3000);
    const run = srv.engineFactory.created.flatMap(e => e.calls).find(x => x.kind === 'run');
    expect(run.opts.campaignId).toBe('demo');
    c.close();
  });

  it('resuming a SAVED Premium game is not gated (out of scope, WO-0050 A3) — recorded so a change is deliberate', async () => {
    const sid = '11111111-2222-4333-8444-555555555555';
    writeJson(path.join(tmpDir, 'sessions', sid, 'session.json'), {
      id: sid, ownerEmail: NO_ACCESS, playerEmail: NO_ACCESS, campaignId: 'coldwar', characterId: 'a', messages: [],
      players: [{ email: NO_ACCESS, role: 'owner' }],
    });
    const c = await connect();
    c.send({ type: 'session_watch', sessionDbId: sid, playerEmail: NO_ACCESS });
    await c.waitFor(m => m.type === 'session_access');
    c.send({ type: 'session_resume', playerEmail: NO_ACCESS, campaignId: 'coldwar', characterId: 'a', messages: [] });
    expect(await c.waitFor(isIdle)).not.toBeNull();
    expect(c.got.some(isRefusal)).toBe(false);
    // ...but the same saved session cannot be used to resume into a DIFFERENT Premium campaign.
    c.got.length = 0;
    c.send({ type: 'session_resume', playerEmail: NO_ACCESS, campaignId: 'sneaky', characterId: 'a', messages: [] });
    expect(await c.waitFor(isRefusal)).not.toBeNull();
    c.close();
  });
});

// Revision 2 (SR-50-1, Security Reviewer; found independently by QC Tester as P1). The bound
// session's saved campaign decides where a single-player turn runs, not the connection's leftover.
describe('WebSocket — the bound session decides the campaign of a turn (revision 2)', () => {
  const runs = () => srv.engineFactory.created.flatMap(e => e.calls).filter(x => x.kind === 'run');
  const sessionChars = (sid) => fs.readdirSync(path.join(tmpDir, 'sessions', sid, 'characters'))
    .map(f => JSON.parse(fs.readFileSync(path.join(tmpDir, 'sessions', sid, 'characters', f), 'utf-8')).id).sort();

  async function ownDemoSave(email) {
    const res = await createSession(email, 'demo');
    expect(res.status).toBe(201);
    return (await res.json()).id;
  }

  it('SR-50-1: refused start (Premium) -> watch own demo save -> user_message runs in demo and snapshots only demo', async () => {
    const sid = await ownDemoSave(NO_ACCESS);
    const c = await connect();
    c.send(startMsg(NO_ACCESS, 'coldwar'));
    expect(await c.waitFor(isRefusal)).not.toBeNull();
    c.send({ type: 'session_watch', sessionDbId: sid, playerEmail: NO_ACCESS });
    expect((await c.waitFor(m => m.type === 'session_access')).canWrite).toBe(true);
    c.got.length = 0;
    c.send({ type: 'user_message', text: 'Begin the adventure.' });
    expect(await c.waitFor(isIdle, 3000)).not.toBeNull();
    const r = runs();
    expect(r.length).toBe(1);
    expect(r[0].opts.campaignId).toBe('demo');
    expect(r[0].opts.sessionDbId).toBe(sid);
    expect(sessionChars(sid)).toEqual(['a']); // no Premium character copied into the demo save
    c.close();
  });

  it('a session_resume naming another campaign cannot re-route a bound save, even for a player with access', async () => {
    const sid = await ownDemoSave(HAS_ACCESS);
    const c = await connect();
    c.send({ type: 'session_watch', sessionDbId: sid, playerEmail: HAS_ACCESS });
    await c.waitFor(m => m.type === 'session_access');
    c.send({ type: 'session_resume', playerEmail: HAS_ACCESS, campaignId: 'coldwar', characterId: 'a', messages: [] });
    await c.waitFor(isIdle);
    c.got.length = 0;
    c.send({ type: 'user_message', text: 'hello' });
    expect(await c.waitFor(isIdle, 3000)).not.toBeNull();
    expect(runs()[0].opts.campaignId).toBe('demo');
    expect(sessionChars(sid)).toEqual(['a']);
    c.close();
  });

  // Revision 3: a refused start no longer assigns the refused campaign to the connection, so this
  // test now gets a Premium campaign onto the connection the only way a false player can — by
  // resuming their own saved Premium game — and then binds a save whose campaignId cannot be
  // trusted (absent, or ill-formed per SR-50-5). Each must be gated as a start, on that campaign.
  it('a bound save with no campaignId, or an ill-formed one, is gated as a start on the connection campaign', async () => {
    const own = '33333333-4444-4555-8666-777777777777';
    writeJson(path.join(tmpDir, 'sessions', own, 'session.json'), {
      id: own, ownerEmail: NO_ACCESS, playerEmail: NO_ACCESS, campaignId: 'coldwar', characterId: 'a', messages: [],
      players: [{ email: NO_ACCESS, role: 'owner' }],
    });
    const cases = [['22222222-3333-4444-8555-666666666666', undefined], ['44444444-5555-4666-8777-888888888888', '../coldwar'],
      ['55555555-6666-4777-8888-999999999999', 'COLDWAR'], ['66666666-7777-4888-8999-aaaaaaaaaaaa', ['demo']]];
    for (const [sid, cid] of cases) {
      const rec = { id: sid, ownerEmail: NO_ACCESS, playerEmail: NO_ACCESS, characterId: 'a', messages: [], players: [{ email: NO_ACCESS, role: 'owner' }] };
      if (cid !== undefined) rec.campaignId = cid;
      writeJson(path.join(tmpDir, 'sessions', sid, 'session.json'), rec);
      const c = await connect();
      c.send({ type: 'session_watch', sessionDbId: own, playerEmail: NO_ACCESS });
      await c.waitFor(m => m.type === 'session_access');
      c.send({ type: 'session_resume', playerEmail: NO_ACCESS, campaignId: 'coldwar', characterId: 'a', messages: [] });
      await c.waitFor(isIdle);
      c.send({ type: 'session_watch', sessionDbId: sid, playerEmail: NO_ACCESS });
      await c.waitFor(m => m.type === 'session_access' && m.sessionDbId === sid);
      c.got.length = 0;
      c.send({ type: 'user_message', text: 'hello' });
      expect(await c.waitFor(isRefusal), JSON.stringify(cid)).not.toBeNull();
      c.close();
    }
    await new Promise(r => setTimeout(r, 100));
    expect(srv.engineFactory.created.flatMap(e => e.calls).filter(x => x.kind === 'run')).toHaveLength(0);
  });

  it('an ill-formed saved campaignId never reaches the engine, even where the gate allows the turn', async () => {
    for (const [sid, cid] of [['77777777-8888-4999-8aaa-bbbbbbbbbbbb', '../coldwar'], ['88888888-9999-4aaa-8bbb-cccccccccccc', 'COLDWAR']]) {
      writeJson(path.join(tmpDir, 'sessions', sid, 'session.json'), {
        id: sid, ownerEmail: HAS_ACCESS, playerEmail: HAS_ACCESS, campaignId: cid, characterId: 'a', messages: [],
        players: [{ email: HAS_ACCESS, role: 'owner' }],
      });
      const c = await connect();
      c.send({ type: 'session_watch', sessionDbId: sid, playerEmail: HAS_ACCESS });
      await c.waitFor(m => m.type === 'session_access');
      c.got.length = 0;
      c.send({ type: 'user_message', text: 'hello' });
      await c.waitFor(isIdle, 3000);
      c.close();
    }
    const seen = srv.engineFactory.created.flatMap(e => e.calls).filter(x => x.kind === 'run').map(x => x.opts.campaignId);
    expect(seen).toHaveLength(2);
    for (const v of seen) expect(v === null || v === 'demo', String(v)).toBe(true);
  });
});

// Revision 2 (SR-50-3). `String(['demo'])` is 'demo', so an array used to pass the id regex.
describe('WebSocket — a campaignId must be a string (revision 2)', () => {
  it('session_start and session_resume refuse non-string campaignIds; the engine never sees one', async () => {
    for (const type of ['session_start', 'session_resume']) {
      for (const cid of [['demo'], ['coldwar'], { toString: 'demo' }, 0, true, 7]) {
        const c = await connect();
        c.send({ type, playerEmail: HAS_ACCESS, campaignId: cid, characterId: 'a', messages: [] });
        const err = await c.waitFor(m => m.type === 'error');
        expect(err?.error, `${type} ${JSON.stringify(cid)}`).toBe('Invalid campaignId.');
        c.close();
      }
    }
    const c = await connect();
    c.send(startMsg(HAS_ACCESS, ['demo']));
    await c.waitFor(m => m.type === 'error');
    c.send({ type: 'user_message', text: 'x' });
    await c.waitFor(isIdle, 3000);
    for (const r of srv.engineFactory.created.flatMap(e => e.calls)) {
      expect(r.opts.campaignId == null || typeof r.opts.campaignId === 'string').toBe(true);
    }
    c.close();
  });
});

// Revision 3 (SR-50-4, Security Reviewer RT10). A session_start landing between the gate and
// engine.run must not swap the in-flight turn into the refused Premium campaign. Raced 24 times at
// 0, 1 and 2 ms; every run must be in demo and bound to the save.
describe('WebSocket — a turn\'s inputs are pinned at the gate (revision 3)', () => {
  const runs = () => srv.engineFactory.created.flatMap(e => e.calls).filter(x => x.kind === 'run');
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  it('SR-50-4: user_message on a bound demo save, then session_start(coldwar) 0-2 ms later, x24', async () => {
    const res = await createSession(NO_ACCESS, 'demo');
    const sid = (await res.json()).id;
    for (let i = 0; i < 24; i++) {
      const c = await connect();
      c.send({ type: 'session_watch', sessionDbId: sid, playerEmail: NO_ACCESS });
      await c.waitFor(m => m.type === 'session_access');
      c.got.length = 0;
      c.send({ type: 'user_message', text: 'go ' + i });
      if (i % 3) await sleep(i % 3);
      c.send({ ...startMsg(NO_ACCESS, 'coldwar'), characterId: 'cw' });
      // The turn either completes (idle) or is refused because the refusal landed first.
      await c.waitFor(m => isIdle(m) || c.got.filter(isRefusal).length >= 2, 1500);
      await sleep(20);
      c.close();
    }
    const r = runs();
    // Both outcomes must occur for the race to have been exercised at all.
    expect(r.length).toBeGreaterThan(0);
    expect(r.length).toBeLessThan(24);
    for (const x of r) {
      expect(x.opts.campaignId, JSON.stringify(x.opts)).toBe('demo');
      expect(x.opts.sessionDbId).toBe(sid);
      expect(x.opts.characterId).not.toBe('cw');
    }
    const chars = fs.readdirSync(path.join(tmpDir, 'sessions', sid, 'characters'));
    expect(chars).not.toContain('cw.json');
  }, 60000);

  // The pinning itself (half (a)). An ALLOWED context change mid-turn — watching and resuming the
  // player's own saved Premium game, which A3 leaves ungated — rewrites the connection's campaign to
  // coldwar while a turn on the demo save is in flight. That turn must still run in demo, on D.
  it('an allowed mid-turn resume of the player\'s own Premium save does not re-route the in-flight demo turn, x24', async () => {
    const d = (await (await createSession(NO_ACCESS, 'demo')).json()).id;
    const p = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
    writeJson(path.join(tmpDir, 'sessions', p, 'session.json'), {
      id: p, ownerEmail: NO_ACCESS, playerEmail: NO_ACCESS, campaignId: 'coldwar', characterId: 'cw', messages: [],
      players: [{ email: NO_ACCESS, role: 'owner' }],
    });
    for (let i = 0; i < 24; i++) {
      const c = await connect();
      c.send({ type: 'session_watch', sessionDbId: d, playerEmail: NO_ACCESS });
      await c.waitFor(m => m.type === 'session_access');
      c.got.length = 0;
      const before = runs().length;
      c.send({ type: 'user_message', text: 'go ' + i });
      if (i % 3) await sleep(i % 3);
      c.send({ type: 'session_watch', sessionDbId: p, playerEmail: NO_ACCESS });
      c.send({ type: 'session_resume', playerEmail: NO_ACCESS, campaignId: 'coldwar', characterId: 'cw', scenarioId: 'coldwar', messages: [] });
      await c.waitFor(m => m.type === 'dm_complete' || (m.type === 'error' && /session changed/.test(m.error)), 1500);
      await sleep(30);
      for (const x of runs().slice(before)) {
        expect(x.opts.campaignId, `try ${i}`).toBe('demo');
        expect(x.opts.sessionDbId, `try ${i}`).toBe(d);
      }
      c.close();
    }
    expect(runs().length).toBeGreaterThan(0);
    expect(fs.readdirSync(path.join(tmpDir, 'sessions', d, 'characters'))).not.toContain('cw.json');
  }, 60000);

  it('a refused session_start assigns no connection state; the next user_message is refused until a fresh start', async () => {
    const c = await connect();
    c.send(startMsg(NO_ACCESS, 'demo'));
    await c.waitFor(isIdle);
    c.send({ ...startMsg(NO_ACCESS, 'coldwar'), characterId: 'cw' });
    await c.waitFor(isRefusal);
    c.got.length = 0;
    c.send({ type: 'user_message', text: 'x' });
    expect(await c.waitFor(isRefusal)).not.toBeNull();
    await sleep(80);
    expect(runs()).toHaveLength(0);
    c.close();
  });
});
