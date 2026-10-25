import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import express from 'express';

// WO-0044: the GM model is the admin's instance-wide choice and nobody else's.
//
// Before the fix, PUT /api/dm-settings (any logged-in player) accepted `model` in its body and
// copied the global model into the player's file, and loadDmSettings let that file override the
// global one. So a non-admin could pick the GM model through the API, and a player who had ever
// saved personal settings stayed on whatever model was set at that moment.

const dmSettingsRouter = require('../routes/dm-settings');
const { loadDmSettings } = require('../dm-engine');
const { emailToSlug } = require('../player-data');

const ADMIN = 'admin@example.com';
const PLAYER = 'player@example.com';

let tmpDir;
let server;
let baseUrl;

const writeJson = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(data, null, 2)); };
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));
const playerFile = (email) => path.join(tmpDir, 'dm-settings', `${emailToSlug(email)}.json`);

async function put(url, email, body) {
  return fetch(`${baseUrl}${url}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Player-Email': email }, body: JSON.stringify(body) });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-model-test-'));
  writeJson(path.join(tmpDir, 'players.json'), {
    [ADMIN]: { email: ADMIN, name: 'Admin', role: 'admin' },
    [PLAYER]: { email: PLAYER, name: 'Player', role: 'player' },
  });
  fs.mkdirSync(path.join(tmpDir, 'dm-settings'), { recursive: true });
  const app = express();
  app.use(express.json());
  app.use('/api/dm-settings', dmSettingsRouter(tmpDir));
  server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise(r => server.close(r));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('the GM model is admin-only (WO-0044)', () => {
  it('refuses a non-admin on the global route', async () => {
    const res = await put('/api/dm-settings/global', PLAYER, { model: 'claude-opus-5-5' });
    expect(res.status).toBe(403);
  });

  it('drops `model` from a player\'s personal save, and never copies the global one in', async () => {
    expect((await put('/api/dm-settings/global', ADMIN, { model: 'claude-sonnet-5-5' })).status).toBe(200);
    const res = await put('/api/dm-settings', PLAYER, { humor: 80, model: 'claude-opus-5-5' });
    expect(res.status).toBe(200);
    const saved = readJson(playerFile(PLAYER));
    expect(saved.humor).toBe(80);
    expect('model' in saved).toBe(false);
    // The engine runs the player's turns on the admin's model, not the one the player asked for.
    expect(loadDmSettings(tmpDir, PLAYER).model).toBe('claude-sonnet-5-5');
  });

  it('applies a later admin change to a player who saved personal settings earlier', async () => {
    // The file shape every pre-fix personal save has: a copy of the global model at save time.
    writeJson(playerFile(PLAYER), { humor: 70, model: '' });
    expect((await put('/api/dm-settings/global', ADMIN, { model: 'claude-opus-5-5' })).status).toBe(200);
    expect(loadDmSettings(tmpDir, PLAYER).model).toBe('claude-opus-5-5');
    expect(loadDmSettings(tmpDir, PLAYER).humor).toBe(70);
    const effective = await (await fetch(`${baseUrl}/api/dm-settings`, { headers: { 'X-Player-Email': PLAYER } })).json();
    expect(effective.model).toBe('claude-opus-5-5');
  });

  it('ignores a model a player file already carries', () => {
    writeJson(playerFile(PLAYER), { model: 'claude-opus-5-5' });
    // No global model set: the player's turns use the SDK default, not the player's pick.
    expect(loadDmSettings(tmpDir, PLAYER).model).toBeUndefined();
    writeJson(path.join(tmpDir, 'dm-settings.json'), { model: 'claude-haiku-4-5-20251001' });
    expect(loadDmSettings(tmpDir, PLAYER).model).toBe('claude-haiku-4-5-20251001');
  });
});
