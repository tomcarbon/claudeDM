import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// WO-0041 (security-reviewer SR-40-2 / SR-40-3): the X-Campaign-Id and X-Session-Id headers are
// joined into file paths across the server. They are refused at the door unless they are a plain
// id — measured against the real app, with the reviewer's own deletion probe.

const { startTestServer } = require('./helpers/test-server');
const { getPlayerCampaignDir, getSessionDir } = require('../player-data');
const WebSocket = require('ws');

let tmpDir;
let srv;
const EMAIL = 'probe@test.com';

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-header-'));
  writeJson(path.join(tmpDir, 'players.json'), { [EMAIL]: { email: EMAIL, name: 'Probe', role: 'player' } });
  writeJson(path.join(tmpDir, 'campaigns', 'demo', 'campaign.json'), { id: 'demo', title: 'Demo' });
  writeJson(path.join(tmpDir, 'defaults', 'demo', 'characters', 'a.json'), { id: 'a', name: 'A' });
  writeJson(path.join(tmpDir, 'defaults', 'coldwar', 'characters', 'baseline.json'), { id: 'b', name: 'Baseline' });
  fs.mkdirSync(path.join(tmpDir, 'players'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'sessions'), { recursive: true });
  srv = await startTestServer(tmpDir);
});

afterEach(async () => {
  await srv.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const req = (p, headers, method = 'GET') => fetch(`${srv.baseUrl}${p}`, {
  method,
  headers: { 'Content-Type': 'application/json', 'X-Player-Email': EMAIL, ...headers },
  body: method === 'GET' ? undefined : JSON.stringify({}),
});

describe('X-Campaign-Id / X-Session-Id are ids, never paths', () => {
  it('refuses a traversing campaign id before any route runs — the baseline survives a reset', async () => {
    const res = await req('/api/settings/reset-my-data', { 'X-Campaign-Id': '../../defaults/coldwar' }, 'POST');
    expect(res.status).toBe(400);
    expect(fs.existsSync(path.join(tmpDir, 'defaults', 'coldwar', 'characters', 'baseline.json'))).toBe(true);
  });

  it('refuses every unsafe shape', async () => {
    for (const bad of ['..', '../demo', 'demo/../x', 'demo\\x', '.hidden', 'a'.repeat(65), 'demo%2f..']) {
      const res = await req('/api/characters', { 'X-Campaign-Id': bad });
      expect(res.status, bad).toBe(400);
    }
    for (const bad of ['../x', '..', 'a/b', '.x']) {
      const res = await req('/api/characters', { 'X-Session-Id': bad });
      expect(res.status, bad).toBe(400);
    }
  });

  it('the path helpers themselves refuse a non-id, whatever entrance it came through', () => {
    expect(() => getPlayerCampaignDir(tmpDir, EMAIL, '../../defaults/coldwar')).toThrow(/Invalid campaign id/);
    expect(() => getSessionDir(tmpDir, '../players')).toThrow(/Invalid session id/);
    expect(getPlayerCampaignDir(tmpDir, EMAIL, 'coldwar')).toBe(path.join(tmpDir, 'players', 'probe-test-com', 'coldwar'));
  });

  it('PUT /api/sessions/:id cannot re-route a session through a body campaignId', async () => {
    const sid = '11111111-2222-4333-8444-555555555555';
    writeJson(path.join(tmpDir, 'sessions', sid, 'session.json'), { id: sid, ownerEmail: EMAIL, playerEmail: EMAIL, campaignId: 'demo', messages: [] });
    const res = await fetch(`${srv.baseUrl}/api/sessions/${sid}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Player-Email': EMAIL },
      body: JSON.stringify({ campaignId: '../../defaults/coldwar', messages: [] }),
    });
    expect(res.status).toBe(200);
    const stored = JSON.parse(fs.readFileSync(path.join(tmpDir, 'sessions', sid, 'session.json'), 'utf-8'));
    expect(stored.campaignId).toBe('demo');
    expect((await fetch(`${srv.baseUrl}/api/sessions/..%2F..%2Fplayers`, { headers: { 'X-Player-Email': EMAIL } })).status).not.toBe(200);
  });

  it('the WebSocket refuses a non-id campaignId on session_start and session_resume', async () => {
    for (const type of ['session_start', 'session_resume']) {
      const ws = new WebSocket(srv.wsUrl);
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      const reply = new Promise(resolve => ws.on('message', (raw) => {
        const m = JSON.parse(String(raw));
        if (m.type === 'error') resolve(m);
      }));
      ws.send(JSON.stringify({ type, playerEmail: EMAIL, campaignId: '../../defaults/coldwar', characterId: 'a' }));
      const err = await Promise.race([reply, new Promise(r => setTimeout(() => r(null), 3000))]);
      ws.close();
      expect(err, type).not.toBeNull();
      expect(JSON.stringify(err), type).toMatch(/Invalid campaignId/);
    }
    expect(fs.existsSync(path.join(tmpDir, 'defaults', 'coldwar', 'characters', 'baseline.json'))).toBe(true);
  });

  it('a non-id session id over the WebSocket costs that message, not the server (QC/VPCS: rev 2 crashed)', async () => {
    const ws = new WebSocket(srv.wsUrl);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const replies = [];
    ws.on('message', (raw) => replies.push(JSON.parse(String(raw))));
    for (const type of ['session_watch', 'session_resume', 'chat_join', 'user_message', 'companion_turn_submit']) {
      ws.send(JSON.stringify({ type, sessionDbId: '../players', sessionId: '../players', playerEmail: EMAIL, campaignId: 'demo' }));
    }
    await new Promise(r => setTimeout(r, 800));
    ws.close();
    expect(replies.some(m => m.type === 'error')).toBe(true);
    // The process is still serving.
    expect((await req('/api/characters', { 'X-Campaign-Id': 'demo' })).status).toBe(200);
  });

  it('still serves ordinary ids, and no header at all', async () => {
    expect((await req('/api/characters', { 'X-Campaign-Id': 'demo' })).status).toBe(200);
    expect((await req('/api/characters', { 'X-Campaign-Id': ' Demo ' })).status).toBe(200);
    expect((await req('/api/characters', {})).status).toBe(200);
    expect((await req('/api/characters', { 'X-Session-Id': '52ae868a-43e2-4d42-9a93-bfccc787e711' })).status).toBe(200);
  });
});
