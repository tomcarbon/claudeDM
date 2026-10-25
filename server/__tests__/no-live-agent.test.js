import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import express from 'express';
import WebSocket from 'ws';

const { attachWebSocket } = require('../ws-handler');
const { DmEngine } = require('../dm-engine');
const { createFakeEngineFactory } = require('./helpers/fake-dm-engine');
const { SDK_MODULE, GUARD_MARK, isQueryGuarded } = require('./helpers/no-live-agent');

// These tests are the standing proof that `npm test` cannot start a live Claude agent.
// If one of them fails, stop running the suite and fix the guard — do not skip it. The
// failure mode being guarded against is silent: an unguarded run does not error, it spends
// money and edits files under data/.

let tmpDir;
let server;
let wss;
let wsUrl;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudedm-guard-test-'));
  fs.writeFileSync(path.join(tmpDir, 'players.json'), '{}');
  const app = express();
  server = http.createServer(app);
});

afterEach(async () => {
  if (wss) {
    for (const client of wss.clients) client.terminate();
    wss = null;
  }
  if (server && server.listening) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function listen() {
  await new Promise((resolve) => {
    server.listen(0, () => {
      wsUrl = `ws://127.0.0.1:${server.address().port}/ws`;
      resolve();
    });
  });
}

function connectAndClose(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => { ws.close(); resolve(); });
    ws.on('error', reject);
  });
}

describe('no-live-agent guard', () => {
  it('the Claude Agent SDK query() seen by this test file is the guarded one', () => {
    // Deliberately uses this file's own `require` — the same mechanism every other test file
    // uses to load server/dm-engine.js. Asserting through a different loader would prove
    // nothing about the path the suite actually takes.
    // The other loader is asserted in no-live-agent-esm.test.js (WO-0035), not here.
    const sdk = require(SDK_MODULE);
    expect(typeof sdk.query).toBe('function');
    expect(sdk.query[GUARD_MARK]).toBe(true);
    expect(isQueryGuarded(require)).toBe(true);
  });

  it('the guarded query() throws instead of spawning, with a message that names the fix', () => {
    const sdk = require(SDK_MODULE);
    expect(() => sdk.query({ prompt: 'x', options: {} })).toThrow(/BLOCKED/);
    expect(() => sdk.query({ prompt: 'x', options: {} })).toThrow(/createEngine/);
  });

  it('leaves the rest of the SDK surface intact so dm-engine can still build its MCP server', () => {
    const sdk = require(SDK_MODULE);
    expect(typeof sdk.tool).toBe('function');
    expect(typeof sdk.createSdkMcpServer).toBe('function');
  });
});

describe('attachWebSocket engine injection', () => {
  it('uses the injected createEngine for a new connection', async () => {
    const factory = createFakeEngineFactory();
    wss = attachWebSocket(server, tmpDir, { createEngine: factory });
    await listen();
    await connectAndClose(wsUrl);
    expect(factory.created.length).toBe(1);
    expect(factory.last().constructor.name).toBe('FakeDmEngine');
    expect(factory.last().dataDir).toBe(tmpDir);
  });

  it('falls back to a real DmEngine when nothing is injected, so production is unchanged', async () => {
    // Constructing a DmEngine is inert — the constructor only assigns fields. The billable
    // behaviour lives in run()/runReconcile(), which this test never calls.
    let seen = null;
    wss = attachWebSocket(server, tmpDir, {
      createEngine: (dir) => { seen = new DmEngine(dir); return seen; },
    });
    await listen();
    await connectAndClose(wsUrl);
    expect(seen).toBeInstanceOf(DmEngine);

    // And the real default, with no options object at all.
    const server2 = http.createServer(express());
    const wss2 = attachWebSocket(server2, tmpDir);
    await new Promise((resolve) => server2.listen(0, resolve));
    const url2 = `ws://127.0.0.1:${server2.address().port}/ws`;
    await connectAndClose(url2);
    for (const c of wss2.clients) c.terminate();
    await new Promise((resolve) => server2.close(resolve));
  });
});
