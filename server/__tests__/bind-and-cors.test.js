import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';

const {
  createApp,
  resolveHost,
  defaultAllowedOrigins,
  resolveAllowedOrigins,
  DEFAULT_HOST,
  CLIENT_DEV_PORT,
} = require('../index');

// ─────────────────────────────────────────────────────────────────────────────────────────────
// WO-0034 — the default bind and the default CORS origin, enforced.
//
// Before 2026-09-23 this server listened on `*:3001` and answered every preflight with
// `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Headers: x-player-email` — verified
// against the chair's running process, not inferred. Identity is that header and nothing else
// (decision `0005`), and an `admin` account started existing on 2026-09-22, so the combination
// meant any page in the chair's browser, and anything on their network, could act as any account.
//
// Both defaults are now closed and both are widened by a documented variable. **This file exists
// because a default nobody measures is a default that drifts.** WO-0032 and WO-0033 between them
// produced six source claims that were wider than the code, so every claim here has an executed
// assertion under it, and the four detectors below are checked against negative controls that are
// the real defect rather than a stand-in — the house pattern from
// `mechanical-tools.test.js:805-828`.
//
// WHAT IS NOT TESTED HERE, said plainly rather than left for a reader to discover:
//   * The bind is tested two ways — `resolveHost` as a value, and a source scan of the
//     `server.listen` call site — but NOT by observing a socket. Asserting the real default bind
//     by observation would mean calling `start()`, which deletes `CLAUDECODE` from the
//     environment, attaches a real `DmEngine` factory and points at the live `data/`. That is a
//     billable agent with `Edit` on the chair's game. The scan is the affordable enforcement, and
//     its limits are listed at `bindDefects`.
//   * The WebSocket at `/ws` has no origin check and none is added here (`ws-handler.js:382`).
//     The loopback bind covers it; the origin policy does not. Out of scope for WO-0034 and
//     reported, not silently left.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const SERVER_DIR = path.join(__dirname, '..');
const INDEX_JS = path.join(SERVER_DIR, 'index.js');
const VITE_CONFIG = path.join(SERVER_DIR, '..', 'client', 'vite.config.js');

// ── 1. The defaults, as values ───────────────────────────────────────────────────────────────

describe('default bind host', () => {
  it('is loopback when the environment says nothing', () => {
    expect(resolveHost({})).toBe('127.0.0.1');
    expect(DEFAULT_HOST).toBe('127.0.0.1');
  });

  it('treats an empty or whitespace CLAUDEDM_HOST as unset — a blank value is not a widening', () => {
    expect(resolveHost({ CLAUDEDM_HOST: '' })).toBe('127.0.0.1');
    expect(resolveHost({ CLAUDEDM_HOST: '   ' })).toBe('127.0.0.1');
  });

  it('is widened only by an explicit value', () => {
    expect(resolveHost({ CLAUDEDM_HOST: '0.0.0.0' })).toBe('0.0.0.0');
    expect(resolveHost({ CLAUDEDM_HOST: '192.168.1.10' })).toBe('192.168.1.10');
    expect(resolveHost({ CLAUDEDM_HOST: ' 0.0.0.0 ' })).toBe('0.0.0.0');
  });

  it('reads the environment it is given, not the runner\'s', () => {
    // The suite must not depend on how the developer's shell happens to be set.
    expect(resolveHost({ PORT: '9999' })).toBe('127.0.0.1');
  });
});

describe('default CORS origins', () => {
  const defaults = defaultAllowedOrigins({ port: 3001 });

  it('are loopback only — every entry, checked by host, not by eyeball', () => {
    expect(defaults.length).toBeGreaterThan(0);
    for (const origin of defaults) {
      const { hostname, protocol } = new URL(origin);
      expect(protocol).toBe('http:');
      // `new URL('http://[::1]:5173').hostname` keeps the brackets — that is WHATWG, not a typo.
      expect(['localhost', '127.0.0.1', '[::1]']).toContain(hostname);
    }
  });

  it('never contains a wildcard', () => {
    expect(defaults).not.toContain('*');
    expect(defaults.join(',')).not.toContain('*');
  });

  it('covers the two origins the app is actually served from', () => {
    // Dev: the page is Vite on :5173 and the API is :3001, so the app's own calls are
    // cross-origin and would break if this entry were dropped.
    expect(defaults).toContain(`http://localhost:${CLIENT_DEV_PORT}`);
    expect(defaults).toContain(`http://127.0.0.1:${CLIENT_DEV_PORT}`);
    // Production build: this process serves the page, so a same-origin POST carries
    // `Origin: http://localhost:3001`.
    expect(defaults).toContain('http://localhost:3001');
  });

  it('skips a zero/ephemeral port rather than inventing http://localhost:0', () => {
    expect(defaultAllowedOrigins({ port: 0 })).not.toContain('http://localhost:0');
  });

  it('resolves to the defaults when nothing is configured', () => {
    const policy = resolveAllowedOrigins({}, { port: 3001 });
    expect(policy.any).toBe(false);
    expect(policy.source).toBe('default');
    expect(policy.origins).toEqual(defaults);
  });

  it('replaces the defaults when CLAUDEDM_ALLOWED_ORIGINS is set', () => {
    const policy = resolveAllowedOrigins(
      { CLAUDEDM_ALLOWED_ORIGINS: 'http://192.168.1.10:5173, http://192.168.1.10:3001' },
      { port: 3001 },
    );
    expect(policy).toEqual({
      any: false,
      origins: ['http://192.168.1.10:5173', 'http://192.168.1.10:3001'],
      source: 'env',
    });
  });

  it('allows any origin only when the environment says so in that many characters', () => {
    const policy = resolveAllowedOrigins({ CLAUDEDM_ALLOWED_ORIGINS: '*' }, { port: 3001 });
    expect(policy.any).toBe(true);
    expect(resolveAllowedOrigins({ CLAUDEDM_ALLOWED_ORIGINS: '' }, { port: 3001 }).any).toBe(false);
  });
});

// ── 2. The defaults, as behaviour of the real app ────────────────────────────────────────────

let tmpDir;

function warnCollector() {
  const lines = [];
  return { lines, warn: (msg) => lines.push(String(msg)), log: () => {}, error: () => {} };
}

/**
 * Boot the real Express app on an ephemeral loopback port against a temp data directory.
 * No WebSocket, no DM engine, no bots: this file tests one middleware and one listen call.
 */
async function boot({ env = {}, log = warnCollector() } = {}) {
  const app = createApp(tmpDir, { port: 0, env, log });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    log,
    baseUrl: `http://127.0.0.1:${port}`,
    policy: app.locals.corsPolicy,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function preflight(baseUrl, origin) {
  return fetch(`${baseUrl}/api/players/lookup`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'x-player-email',
    },
  });
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudedm-cors-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('the running app, with no environment set', () => {
  it('answers a cross-origin preflight with 403 and no allow-origin header', async () => {
    const s = await boot();
    try {
      const res = await preflight(s.baseUrl, 'https://evil.example');
      expect(res.status).toBe(403);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(res.headers.get('access-control-allow-headers')).toBeNull();
      const body = await res.json();
      expect(body.error).toMatch(/not allowed/i);
      // "A rejected origin must fail visibly, not silently" (WO-0034 DoD 2). Visible in the
      // response, and visible in the log: the `cors` package on its own answers a rejected
      // preflight 204 with the header merely absent, which reads as success.
      expect(body.hint).toContain('CLAUDEDM_ALLOWED_ORIGINS');
      expect(s.log.lines.filter((l) => l.includes('https://evil.example'))).toHaveLength(1);
    } finally {
      await s.close();
    }
  });

  it('never answers with a wildcard, on any route or method', async () => {
    const s = await boot();
    try {
      for (const origin of ['https://evil.example', 'http://localhost:5173', null]) {
        const res = await fetch(`${s.baseUrl}/api/players/lookup`, {
          headers: origin ? { Origin: origin } : {},
        });
        expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
      }
    } finally {
      await s.close();
    }
  });

  it('lets the client\'s own dev origin through, reflected exactly', async () => {
    const s = await boot();
    try {
      const res = await preflight(s.baseUrl, 'http://localhost:5173');
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
      expect(res.headers.get('access-control-allow-headers')).toBe('x-player-email');

      const get = await fetch(`${s.baseUrl}/api/players/lookup`, {
        headers: { Origin: 'http://localhost:5173', 'X-Player-Email': 'someone@example.com' },
      });
      expect(get.status).toBe(200);
      expect(get.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
      expect(s.log.lines).toHaveLength(0);
    } finally {
      await s.close();
    }
  });

  it('leaves callers that send no Origin alone — curl, the bot clients, this suite', async () => {
    // `bot/bot-api-client.js` calls http://localhost:<port>/api with no Origin header, and so do
    // the other 24 test files. A policy that broke them would break the game to protect nothing:
    // CORS is a browser-side control and has nothing to say about a caller that is not a browser.
    const s = await boot();
    try {
      const res = await fetch(`${s.baseUrl}/api/players/lookup`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({});
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(s.log.lines).toHaveLength(0);
    } finally {
      await s.close();
    }
  });
});

describe('the running app, widened on purpose', () => {
  it('accepts exactly the origins CLAUDEDM_ALLOWED_ORIGINS lists, and refuses the rest', async () => {
    const s = await boot({ env: { CLAUDEDM_ALLOWED_ORIGINS: 'http://192.168.1.10:5173' } });
    try {
      const ok = await preflight(s.baseUrl, 'http://192.168.1.10:5173');
      expect(ok.status).toBe(204);
      expect(ok.headers.get('access-control-allow-origin')).toBe('http://192.168.1.10:5173');

      // The variable REPLACES the default list. This is the documented behaviour and the reason
      // the README tells the chair to list their own origin when playing over a network.
      const nope = await preflight(s.baseUrl, 'http://localhost:5173');
      expect(nope.status).toBe(403);
    } finally {
      await s.close();
    }
  });

  it('restores allow-any when the environment asks for it explicitly', async () => {
    const s = await boot({ env: { CLAUDEDM_ALLOWED_ORIGINS: '*' } });
    try {
      const res = await preflight(s.baseUrl, 'https://evil.example');
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    } finally {
      await s.close();
    }
  });
});

// ── 3. The bind, as a property of the source ─────────────────────────────────────────────────

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Index of the closing quote/backtick of the string starting at `i`. */
function endOfString(text, i) {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === '\\') { j += 2; continue; }
    if (text[j] === quote) return j;
    j++;
  }
  return text.length - 1;
}

/** The argument text of every `X.listen( ... )` call, parens and strings balanced. */
function listenCalls(code) {
  const calls = [];
  const re = /\.listen\s*\(/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const start = re.lastIndex;
    let depth = 1;
    let i = start;
    while (i < code.length && depth > 0) {
      const ch = code[i];
      if (ch === "'" || ch === '"' || ch === '`') { i = endOfString(code, i); }
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    calls.push(code.slice(start, i - 1));
    re.lastIndex = i;
  }
  return calls;
}

function splitArgs(text) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = endOfString(text, i);
      cur += text.slice(i, end + 1);
      i = end;
      continue;
    }
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts.map((s) => s.trim()).filter((s) => s !== '');
}

const looksLikeCallback = (arg) => /=>/.test(arg)
  || /^(async\s+)?function\b/.test(arg)
  || /^\(\s*\)/.test(arg);

/**
 * Every reason a `listen` call in this file is not a governed bind.
 *
 * The rule: the host must be the second positional argument, and it must be an identifier that
 * this file assigned from `resolveHost(...)`. A string literal fails even when the literal is
 * `'127.0.0.1'` — a hard-coded loopback is not "widenable by a documented variable" (DoD 1), and
 * the next person who needs the LAN would edit the source instead of setting the variable.
 *
 * Known limits, so nobody over-trusts it: it is one file, it does not follow a host through a
 * helper in another module, it treats an identifier callback (`server.listen(0, resolve)`) as a
 * host, and it proves nothing about a socket — see the header of this file.
 */
function bindDefects(source) {
  const code = stripComments(source);
  const fromResolveHost = new Set();
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*)/g)) {
    if (/resolveHost\s*\(/.test(m[2])) fromResolveHost.add(m[1]);
  }

  const defects = [];
  for (const call of listenCalls(code)) {
    const positional = splitArgs(call).filter((a) => !looksLikeCallback(a));
    if (positional.length < 2) {
      defects.push(`listen(${call.split('\n')[0].trim()}…) has no host argument — binds every interface`);
      continue;
    }
    const host = positional[1];
    if (/^['"`]/.test(host)) {
      defects.push(`listen host is the literal ${host} — not widenable by CLAUDEDM_HOST`);
    } else if (!fromResolveHost.has(host)) {
      defects.push(`listen host \`${host}\` was not assigned from resolveHost()`);
    }
  }
  return defects;
}

describe('the bind in server/index.js', () => {
  it('passes a resolveHost()-derived host to listen', () => {
    expect(bindDefects(fs.readFileSync(INDEX_JS, 'utf-8'))).toEqual([]);
  });

  // ── Negative controls. Each is the real defect, verbatim or one edit away from it. ──────────

  it('flags the line that actually shipped — `server.listen(PORT, () => {`', () => {
    const THE_DEFECT = [
      '  server.listen(PORT, () => {',
      "    console.log(`D&D Companion server running on http://localhost:${PORT}`);",
      '  });',
    ].join('\n');
    expect(bindDefects(THE_DEFECT)).toHaveLength(1);
    expect(bindDefects(THE_DEFECT)[0]).toMatch(/no host argument/);
  });

  it('flags a literal widening', () => {
    expect(bindDefects("server.listen(PORT, '0.0.0.0', () => {});")).toHaveLength(1);
    expect(bindDefects('server.listen(PORT, "::", () => {});')).toHaveLength(1);
  });

  it('flags a hard-coded loopback too — a default nobody can widen is its own defect', () => {
    expect(bindDefects("server.listen(PORT, '127.0.0.1', () => {});")).toHaveLength(1);
  });

  it('flags the quiet version: same shape, host from somewhere else', () => {
    const SNEAKY = [
      "  const host = process.env.HOST || '0.0.0.0';",
      '  server.listen(PORT, host, () => {});',
    ].join('\n');
    expect(bindDefects(SNEAKY)).toHaveLength(1);
    expect(bindDefects(SNEAKY)[0]).toMatch(/not assigned from resolveHost/);
  });

  it('does not flag the governed form, and is not fooled by a template literal in the callback', () => {
    const GOOD = [
      '  const host = resolveHost(process.env);',
      '  server.listen(PORT, host, () => {',
      '    console.log(`running on http://localhost:${PORT} (bound to ${host})`);',
      '  });',
    ].join('\n');
    expect(bindDefects(GOOD)).toEqual([]);
  });

  it('is not satisfied by a comment claiming the bind is loopback', () => {
    // The WO-0032/WO-0033 lesson in one assertion: prose is not a control.
    const COMMENTED = [
      '  // Binds to 127.0.0.1 only.',
      '  server.listen(PORT, () => {});',
    ].join('\n');
    expect(bindDefects(COMMENTED)).toHaveLength(1);
  });
});

// ── 4. The Vite dev server's bind ────────────────────────────────────────────────────────────

/**
 * The client dev server is a second listener on the same machine, and it serves the page whose
 * origin the policy above trusts. It was `host: '0.0.0.0'` until 2026-09-23. It reads the same
 * variable as the API server so that one switch moves both — widening one alone gives the chair's
 * friend a page that loads and an app that cannot reach its API.
 */
function viteHostDefects(source) {
  const code = stripComments(source);
  const m = code.match(/host\s*:\s*([^,\n]+)/);
  if (!m) return ['no server.host in vite.config.js — vite\'s own default is not stated here'];
  const value = m[1].trim();
  if (/^['"`]/.test(value)) return [`vite server.host is the literal ${value}`];
  if (!/process\.env\.CLAUDEDM_HOST\s*\|\|\s*['"]127\.0\.0\.1['"]/.test(value)) {
    return [`vite server.host is not "CLAUDEDM_HOST or loopback": ${value}`];
  }
  return [];
}

describe('the bind in client/vite.config.js', () => {
  it('defaults to loopback and reads the same variable as the API server', () => {
    expect(viteHostDefects(fs.readFileSync(VITE_CONFIG, 'utf-8'))).toEqual([]);
  });

  it('flags the value that shipped — `host: \'0.0.0.0\'`', () => {
    expect(viteHostDefects("  server: {\n    host: '0.0.0.0',\n  }")).toHaveLength(1);
  });

  it('flags a different variable, which would silently decouple the two listeners', () => {
    expect(viteHostDefects("  server: { host: process.env.HOST || '127.0.0.1', }")).toHaveLength(1);
  });
});
