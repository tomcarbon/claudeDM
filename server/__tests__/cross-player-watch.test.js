import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// F1 / SR-2026-10-28-1 (WO-0050 revision 3, tests only). On HEAD before revision 3, a player who
// sent a user_message and then — while the GM was still working — did a session_watch of ANOTHER
// player's save had the turn written into the victim's session.json, and the victim's
// claudeSessionId overwritten. Revision 3's pinned turn (turnSessionDbId, toWatchers) closes it;
// these tests hold it closed — both the file write and the broadcast to the victim's table. Four cases: public and private victim saves, attacker bound to their
// own save and unbound. The fake engine's turn is held open with a deferred so the watch lands
// mid-turn deterministically, not by timing luck.
//
// Built from QC's Q3/Q4 probes, the Security Reviewer's xplayer test and SDET's scenarios. Every
// player is at the default (premiumAccess true): this is a cross-player integrity test, not a
// Premium test.

const { startTestServer } = require('./helpers/test-server');
const WebSocket = require('ws');

const ATTACKER = 'attacker@test.com';
const VICTIM = 'victim@test.com';
const VICTIM_CLAUDE_ID = 'victim-claude-session-id';
let tmpDir;
let srv;
let hold = null; // when set, the fake GM awaits it before yielding its turn

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}
function deferred() { let r; const p = new Promise(x => { r = x; }); p.release = r; return p; }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isIdle = (m) => m.type === 'session_status' && m.status === 'idle';

beforeEach(async () => {
  hold = null;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xplayer-watch-'));
  writeJson(path.join(tmpDir, 'players.json'), {
    [ATTACKER]: { email: ATTACKER, name: 'Attacker', role: 'player' },
    [VICTIM]: { email: VICTIM, name: 'Victim', role: 'player' },
  });
  writeJson(path.join(tmpDir, 'campaigns', 'demo', 'campaign.json'), { id: 'demo', title: 'demo', listing: { badge: 'Free' } });
  writeJson(path.join(tmpDir, 'defaults', 'demo', 'characters', 'a.json'), { id: 'a', name: 'A', status: 'alive' });
  fs.mkdirSync(path.join(tmpDir, 'players'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'sessions'), { recursive: true });
  srv = await startTestServer(tmpDir, { engineOptions: { script: async (m) => {
    if (hold) await hold;
    return [
      { type: 'dm_response', text: `[fake DM] acknowledged: ${String(m).slice(0, 120)}` },
      { type: 'dm_complete', sessionId: 'attacker-claude-' + String(m).slice(0, 20) },
    ];
  } } });
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
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  return {
    got,
    send: (m) => ws.send(JSON.stringify(m)),
    async waitFor(pred, ms = 2000) {
      const d = Date.now() + ms;
      for (;;) {
        const h = got.find(pred);
        if (h) return h;
        if (Date.now() > d) return null;
        await sleep(5);
      }
    },
    close: () => ws.close(),
  };
}

async function createSave(email) {
  const res = await fetch(`${srv.baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Player-Email': email, 'X-Campaign-Id': 'demo' },
    body: JSON.stringify({ name: 'T', scenarioId: 'demo', characterId: 'a', messages: [] }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).id;
}
const savePath = (sid) => path.join(tmpDir, 'sessions', sid, 'session.json');
const readSave = (sid) => JSON.parse(fs.readFileSync(savePath(sid), 'utf-8'));

async function victimSave(visibility) {
  const sid = await createSave(VICTIM);
  const rec = readSave(sid);
  rec.claudeSessionId = VICTIM_CLAUDE_ID;
  rec.settings = { ...(rec.settings || {}), visibility };
  rec.messages = [{ type: 'player', text: 'the victim\'s own line', sessionId: sid }];
  writeJson(savePath(sid), rec);
  return sid;
}

describe('a mid-turn session_watch of another player\'s save cannot write the turn into it (F1 / SR-2026-10-28-1)', () => {
  for (const visibility of ['public', 'private']) {
    for (const bound of [true, false]) {
      it(`${visibility} victim save, attacker ${bound ? 'bound to their own save' : 'unbound'}`, async () => {
        const victim = await victimSave(visibility);
        const before = readSave(victim);
        const own = bound ? await createSave(ATTACKER) : null;
        // The victim is at their table, watching their own save: nothing from the attacker's turn
        // may be broadcast to them either (SDET's R15 reopened that half alone).
        const v = await connect();
        v.send({ type: 'session_watch', sessionDbId: victim, playerEmail: VICTIM });
        await v.waitFor(m => m.type === 'session_access' && m.sessionDbId === victim);
        const c = await connect();
        if (own) {
          c.send({ type: 'session_watch', sessionDbId: own, playerEmail: ATTACKER });
          await c.waitFor(m => m.type === 'session_access' && m.sessionDbId === own);
        } else {
          c.send({ type: 'session_start', playerEmail: ATTACKER, playerName: 'A', campaignId: 'demo', characterId: 'a', scenarioId: 'demo' });
          await c.waitFor(isIdle);
        }
        c.got.length = 0;
        hold = deferred();
        const text = `xplayer-${visibility}-${bound}`;
        c.send({ type: 'user_message', text });
        // The turn is now inside the fake GM, held. Watch the victim's save while it is.
        await sleep(40);
        expect(srv.engineFactory.created.flatMap(e => e.calls).some(x => x.kind === 'run' && x.text === text)).toBe(true);
        c.send({ type: 'session_watch', sessionDbId: victim, playerEmail: ATTACKER });
        const access = await c.waitFor(m => m.type === 'session_access' && m.sessionDbId === victim);
        expect(access, 'the watch landed').not.toBeNull();
        expect(access.canWrite).toBe(false);
        hold.release();
        hold = null;
        expect(await c.waitFor(m => m.type === 'dm_complete', 3000)).not.toBeNull();
        await c.waitFor(isIdle, 3000);
        await sleep(100);

        const after = readSave(victim);
        expect(after.messages, 'victim messages gain nothing').toEqual(before.messages);
        expect(after.claudeSessionId, 'victim claudeSessionId unchanged').toBe(VICTIM_CLAUDE_ID);
        const leaked = v.got.filter(m => JSON.stringify(m).includes(text) || m.type === 'dm_response' || m.type === 'dm_complete');
        expect(leaked, 'nothing from the turn reaches the victim\'s table').toEqual([]);
        v.close();
        if (own) {
          // The turn went where it was sent: the attacker's own save.
          expect((readSave(own).messages || []).some(m => m.type === 'dm' && String(m.text).includes(text))).toBe(true);
        }
        c.close();
      });
    }
  }
});
