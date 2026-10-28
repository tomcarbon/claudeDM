import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// WO-0050 revision 4, Part C. The chair, 2026-10-28: "only logged in users should be able to start a
// new game". Logged in means the email names a registered record in players.json — the test REST's
// getAuthenticatedPlayer applies, and REST POST /api/sessions already refused everyone else. This
// file holds the WebSocket half: `session_start` and a single-player `user_message` gated as a start
// (no saved session bound) are refused for guests, unregistered emails and an empty email, in the
// free demo as well as a Premium campaign. Resuming, watching, multiplayer turns and chat are left as
// they were, and are recorded here so a change to them is deliberate.
//
// Real app + real WebSocket handler (helpers/test-server.js): fake DM engine, temp data dir, no live
// agent. Nothing here reads the live data/.

const { startTestServer } = require('./helpers/test-server');
const WebSocket = require('ws');
const { isRegisteredEmail } = require('../player-auth');

const REG = 'member@test.com';          // registered, no premiumAccess field (the default)
const REG_LOCKED = 'locked@test.com';   // registered, premiumAccess: false
const OWNER_SAVE = '11111111-2222-4333-8444-555555555555';

const NOT_LOGGED_IN = [
  ['guest', 'guest'],
  ['an unregistered email', 'stranger@test.com'],
  ['an empty email', ''],
];
const CAMPAIGNS = ['demo', 'coldwar'];

let tmpDir;
let srv;

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-required-'));
  writeJson(path.join(tmpDir, 'players.json'), {
    [REG]: { email: REG, name: 'Member', role: 'player' },
    [REG_LOCKED]: { email: REG_LOCKED, name: 'Locked', role: 'player', premiumAccess: false },
  });
  for (const id of CAMPAIGNS) {
    writeJson(path.join(tmpDir, 'campaigns', id, 'campaign.json'), {
      id, title: id, listing: { badge: id === 'demo' ? 'Free' : 'Premium' },
    });
    writeJson(path.join(tmpDir, 'defaults', id, 'characters', 'a.json'), { id: 'a', name: 'A', status: 'alive' });
  }
  fs.mkdirSync(path.join(tmpDir, 'players'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'sessions'), { recursive: true });
  srv = await startTestServer(tmpDir);
});

afterEach(async () => {
  srv.assertNoLiveEngines();
  await srv.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isLoginRefusal = (m) => m.type === 'error' && m.code === 'login_required';
const isIdle = (m) => m.type === 'session_status' && m.status === 'idle';
const startMsg = (email, campaignId) => ({ type: 'session_start', playerEmail: email, playerName: 'P', campaignId, characterId: 'a', scenarioId: campaignId });
const runs = () => srv.engineFactory.created.flatMap(e => e.calls).filter(x => x.kind === 'run');

function writeSave(sid, owner, campaignId, extra = {}) {
  writeJson(path.join(tmpDir, 'sessions', sid, 'session.json'), {
    id: sid, ownerEmail: owner, playerEmail: owner, campaignId, characterId: 'a', messages: [],
    players: [{ email: owner, role: 'owner' }], ...extra,
  });
}

describe('isRegisteredEmail (player-auth.js)', () => {
  it('is true only for an email with its own record; case and spaces are normalised like REST', () => {
    expect(isRegisteredEmail(tmpDir, REG)).toBe(true);
    expect(isRegisteredEmail(tmpDir, ` ${REG.toUpperCase()} `)).toBe(true);
    expect(isRegisteredEmail(tmpDir, REG_LOCKED)).toBe(true);
    for (const e of ['guest', 'GUEST', '', '   ', null, undefined, 'stranger@test.com', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(isRegisteredEmail(tmpDir, e), String(e)).toBe(false);
    }
  });

  it('is false for everyone when players.json is missing or unreadable', () => {
    fs.rmSync(path.join(tmpDir, 'players.json'));
    expect(isRegisteredEmail(tmpDir, REG)).toBe(false);
    fs.writeFileSync(path.join(tmpDir, 'players.json'), '{ not json');
    expect(isRegisteredEmail(tmpDir, REG)).toBe(false);
  });
});

describe('WebSocket session_start — only a logged-in player starts a new game', () => {
  for (const [label, email] of NOT_LOGGED_IN) {
    for (const cid of CAMPAIGNS) {
      it(`refuses ${label} in ${cid} with code login_required, assigns nothing, and the next user_message is refused`, async () => {
        const c = await connect();
        c.send(startMsg(email, cid));
        const refusal = await c.waitFor(isLoginRefusal);
        expect(refusal, `${label} ${cid}`).not.toBeNull();
        expect(typeof refusal.error).toBe('string');
        expect(refusal.error).not.toMatch(/buy|purchas|pay|price|cost|upgrade|subscri|\$|money|premium/i);
        expect(c.got.some(isIdle), 'a refused start must not report idle').toBe(false);
        c.got.length = 0;
        c.send({ type: 'user_message', text: 'Begin the adventure.' });
        expect(await c.waitFor(isLoginRefusal)).not.toBeNull();
        await sleep(60);
        expect(runs()).toHaveLength(0);
        c.close();
      });
    }
  }

  it('refuses a start with no playerEmail field at all, keeping its old message and gaining the code', async () => {
    const c = await connect();
    c.send({ type: 'session_start', campaignId: 'demo', characterId: 'a', scenarioId: 'demo' });
    const refusal = await c.waitFor(isLoginRefusal);
    expect(refusal).not.toBeNull();
    expect(refusal.error).toBe('playerEmail is required to start a session.');
    c.close();
  });

  it('a registered player still starts, in demo and in a Premium campaign, and the GM runs', async () => {
    for (const cid of CAMPAIGNS) {
      const c = await connect();
      c.send(startMsg(REG, cid));
      expect(await c.waitFor(isIdle), cid).not.toBeNull();
      expect(c.got.some(m => m.type === 'error'), cid).toBe(false);
      c.got.length = 0;
      const before = runs().length;
      c.send({ type: 'user_message', text: 'Begin the adventure.' });
      expect(await c.waitFor(m => m.type === 'dm_complete', 3000), cid).not.toBeNull();
      expect(runs().length).toBe(before + 1);
      expect(runs().at(-1).opts.campaignId).toBe(cid);
      c.close();
    }
  });

  it('the email is matched case-insensitively, as REST does', async () => {
    const c = await connect();
    c.send(startMsg(REG.toUpperCase(), 'demo'));
    expect(await c.waitFor(isIdle)).not.toBeNull();
    expect(c.got.some(isLoginRefusal)).toBe(false);
    c.close();
  });

  it('the login refusal comes before the Premium one: a registered false player in coldwar gets campaign_unavailable, a guest gets login_required', async () => {
    const a = await connect();
    a.send(startMsg(REG_LOCKED, 'coldwar'));
    expect(await a.waitFor(m => m.type === 'error' && m.code === 'campaign_unavailable')).not.toBeNull();
    a.close();
    const b = await connect();
    b.send(startMsg('guest', 'coldwar'));
    expect(await b.waitFor(isLoginRefusal)).not.toBeNull();
    expect(b.got.some(m => m.code === 'campaign_unavailable')).toBe(false);
    b.close();
  });

  it('a refused guest start after a registered one is sticky: the earlier registered context does not run the next turn', async () => {
    const c = await connect();
    c.send(startMsg(REG, 'demo'));
    await c.waitFor(isIdle);
    c.send(startMsg('guest', 'demo'));
    await c.waitFor(isLoginRefusal);
    c.got.length = 0;
    c.send({ type: 'user_message', text: 'hello' });
    expect(await c.waitFor(isLoginRefusal)).not.toBeNull();
    await sleep(60);
    expect(runs()).toHaveLength(0);
    c.close();
  });

  it('a refused start clears on a registered start', async () => {
    const c = await connect();
    c.send(startMsg('guest', 'demo'));
    await c.waitFor(isLoginRefusal);
    c.send(startMsg(REG, 'demo'));
    expect(await c.waitFor(isIdle)).not.toBeNull();
    c.got.length = 0;
    c.send({ type: 'user_message', text: 'hello' });
    expect(await c.waitFor(m => m.type === 'dm_complete', 3000)).not.toBeNull();
    expect(runs()).toHaveLength(1);
    c.close();
  });
});

// The user_message gate is tested on its own here: these identities reach an unbound
// user_message WITHOUT a refused session_start, so `startRefused` is not what refuses them.
describe('WebSocket user_message with no saved session bound — refused unless logged in', () => {
  it('a fresh connection that never started (no email at all) cannot run a turn', async () => {
    const c = await connect();
    c.send({ type: 'user_message', text: 'hello' });
    expect(await c.waitFor(isLoginRefusal)).not.toBeNull();
    await sleep(60);
    expect(runs()).toHaveLength(0);
    c.close();
  });

  for (const [label, email] of NOT_LOGGED_IN.filter(([, e]) => e)) {
    for (const cid of CAMPAIGNS) {
      it(`${label}, via a session_resume with no saved game in ${cid} (unchanged, still allowed), cannot then run a turn`, async () => {
        const c = await connect();
        c.send({ type: 'session_resume', playerEmail: email, campaignId: cid, characterId: 'a', messages: [] });
        // session_resume itself is not changed by Part C ("no changes"): it is accepted as before.
        expect(await c.waitFor(isIdle), `${label} ${cid}`).not.toBeNull();
        c.got.length = 0;
        c.send({ type: 'user_message', text: 'hello' });
        expect(await c.waitFor(isLoginRefusal), `${label} ${cid}`).not.toBeNull();
        await sleep(60);
        expect(runs()).toHaveLength(0);
        c.close();
      });

      it(`${label}, by a chat_join email swap after a registered start in ${cid}, cannot then run a turn`, async () => {
        const c = await connect();
        c.send(startMsg(REG, cid));
        await c.waitFor(isIdle);
        c.send({ type: 'chat_join', chatKey: 'global', playerEmail: email || 'x', playerName: 'X' });
        await sleep(30);
        c.got.length = 0;
        c.send({ type: 'user_message', text: 'hello' });
        expect(await c.waitFor(isLoginRefusal), `${label} ${cid}`).not.toBeNull();
        await sleep(60);
        expect(runs()).toHaveLength(0);
        c.close();
      });
    }
  }

  it('an empty playerEmail in session_resume is refused by its existing check, and the next turn is refused too', async () => {
    const c = await connect();
    c.send({ type: 'session_resume', playerEmail: '', campaignId: 'demo', characterId: 'a', messages: [] });
    expect(await c.waitFor(m => m.type === 'error' && /required to resume/.test(m.error))).not.toBeNull();
    c.got.length = 0;
    c.send({ type: 'user_message', text: 'hello' });
    expect(await c.waitFor(isLoginRefusal)).not.toBeNull();
    expect(runs()).toHaveLength(0);
    c.close();
  });
});

describe('unchanged by Part C: resume, watch, chat', () => {
  it('a registered owner watches and resumes their saved game and plays it', async () => {
    writeSave(OWNER_SAVE, REG, 'coldwar');
    const c = await connect();
    c.send({ type: 'session_watch', sessionDbId: OWNER_SAVE, playerEmail: REG });
    const access = await c.waitFor(m => m.type === 'session_access');
    expect(access.canWrite).toBe(true);
    c.send({ type: 'session_resume', playerEmail: REG, campaignId: 'coldwar', characterId: 'a', messages: [] });
    expect(await c.waitFor(isIdle)).not.toBeNull();
    c.got.length = 0;
    c.send({ type: 'user_message', text: 'onward' });
    expect(await c.waitFor(m => m.type === 'dm_complete', 3000)).not.toBeNull();
    expect(runs()).toHaveLength(1);
    expect(runs()[0].opts.campaignId).toBe('coldwar');
    expect(runs()[0].opts.sessionDbId).toBe(OWNER_SAVE);
    c.close();
  });

  it('a saved game whose owner has no record (deleted account) still plays: a bound, well-formed save is a resume, not a start', async () => {
    writeSave(OWNER_SAVE, 'gone@test.com', 'demo');
    const c = await connect();
    c.send({ type: 'session_watch', sessionDbId: OWNER_SAVE, playerEmail: 'gone@test.com' });
    expect((await c.waitFor(m => m.type === 'session_access')).canWrite).toBe(true);
    c.send({ type: 'user_message', text: 'onward' });
    expect(await c.waitFor(m => m.type === 'dm_complete', 3000)).not.toBeNull();
    expect(c.got.some(isLoginRefusal)).toBe(false);
    c.close();
  });

  for (const [label, email] of NOT_LOGGED_IN) {
    it(`${label} can still watch a public save read-only, and cannot write to it`, async () => {
      writeSave(OWNER_SAVE, REG, 'demo', { settings: { visibility: 'public' } });
      const c = await connect();
      c.send({ type: 'session_watch', sessionDbId: OWNER_SAVE, playerEmail: email });
      const access = await c.waitFor(m => m.type === 'session_access');
      expect(access, label).not.toBeNull();
      expect(access.sessionDbId).toBe(OWNER_SAVE);
      expect(access.canWrite).toBe(false);
      expect(c.got.some(isLoginRefusal)).toBe(false);
      c.close();
    });
  }

  it('guests can still chat', async () => {
    const c = await connect();
    c.send({ type: 'chat_join', chatKey: 'room-x', playerEmail: 'guest', playerName: 'Guest' });
    await sleep(20);
    c.send({ type: 'chat_message', text: 'hi all' });
    expect(await c.waitFor(m => m.type === 'chat_message' && m.text === 'hi all')).not.toBeNull();
    expect(c.got.some(isLoginRefusal)).toBe(false);
    c.close();
  });

  it('REST POST /api/sessions refuses the same identities (it already did)', async () => {
    for (const [label, email] of NOT_LOGGED_IN) {
      const headers = { 'Content-Type': 'application/json', 'X-Campaign-Id': 'demo' };
      if (email) headers['X-Player-Email'] = email;
      const res = await fetch(`${srv.baseUrl}/api/sessions`, {
        method: 'POST', headers, body: JSON.stringify({ name: 'T', scenarioId: 'demo', characterId: 'a', messages: [] }),
      });
      expect(res.status, label).toBe(403);
    }
  });
});

// Revision 3's race safety, with the new refusal. A registered player's turn on their bound demo
// save is in flight; a session_start as `guest` lands 0-2 ms later. The login refusal must assign no
// state, so every turn that runs stays in demo on the save.
describe('the login refusal keeps revision 3\'s pinning', () => {
  it('user_message on a bound save, then session_start(guest, coldwar) 0-2 ms later, x24', async () => {
    writeSave(OWNER_SAVE, REG, 'demo');
    for (let i = 0; i < 24; i++) {
      const c = await connect();
      c.send({ type: 'session_watch', sessionDbId: OWNER_SAVE, playerEmail: REG });
      await c.waitFor(m => m.type === 'session_access');
      c.got.length = 0;
      c.send({ type: 'user_message', text: 'go ' + i });
      if (i % 3) await sleep(i % 3);
      c.send({ ...startMsg('guest', 'coldwar'), characterId: 'cw' });
      await c.waitFor(m => isIdle(m) || c.got.filter(isLoginRefusal).length >= 2, 1500);
      await sleep(20);
      c.close();
    }
    const r = runs();
    expect(r.length).toBeGreaterThan(0);
    for (const x of r) {
      expect(x.opts.campaignId, JSON.stringify(x.opts)).toBe('demo');
      expect(x.opts.sessionDbId).toBe(OWNER_SAVE);
      expect(x.opts.characterId).not.toBe('cw');
    }
  }, 60000);
});
