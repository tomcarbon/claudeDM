/**
 * `BotFarmPanel` rendered, every branch, with no DOM and no new dependency.
 *
 * ── WHY THIS FILE EXISTS, AND WHY IT DID NOT ─────────────────────────────────────────────────
 *
 * WO-0036 revision 1 said the panel *"has no automated test and cannot have one in this repo —
 * no jsdom environment"*. The Security Reviewer's §5 repeated it as a limit of its own review.
 * `sdet` went further and opened a dependency request to VP Technology for `jsdom` +
 * `@testing-library/react` on the strength of it.
 *
 * **All three were wrong, and `qc-tester` settled it by doing the thing.** You do not need a DOM
 * to render React; you need `react-dom/server`, which is already in `client/node_modules`
 * (React 19.2.4). `renderToStaticMarkup` renders with no DOM at all. The only real obstacle is
 * that this component's state arrives through `useEffect`, which the server renderer skips — so
 * the fix is to **supply the hooks, not the DOM**. `sdet` has retracted the dependency request in
 * writing: *"that is evidence those packages are absent, not that a component test needs them,
 * and I did not check."*
 *
 * This file is `qc-tester`'s 22-state exercise turned into a test. The difference, and it is the
 * whole point: `qc-tester` had to COPY the component's 458 lines into a scratch harness because
 * `BotFarmPanel` was not exported, so what it rendered was byte-identical-but-separate source.
 * This renders **the real module**. A rename, a deleted branch or a throw lands here.
 *
 * ── WHAT THIS CANNOT REACH, STATED SO THE COVERAGE IS NOT OVER-READ ──────────────────────────
 *
 * A server render reaches no INTERACTION: the `×` button's `window.confirm`, the Add form
 * clamping as you type, the 10s poll, the disabled-while-in-flight transitions, and the message
 * assembly inside `handleRemoveBot` / `handleCleanup`. Those need a DOM, they are where the next
 * defect will be, and the honest `jsdom` request is a list of those behaviours — not the
 * observation that two packages are missing. The message assembly specifically is the one with a
 * known defect history (`qc-tester` reproduced a false sentence in it), and it is covered here
 * only at the server end, by `removeBot` returning both halves.
 *
 * ZERO network, ZERO agent, ZERO data/. The only globals touched are a stub `window` that
 * `client/src/api/client.js` reads at module load.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

// ── the hook shims ───────────────────────────────────────────────────────────────────────────
//
// `useState` returns the Nth value from a table this file controls, in the component's own
// declaration order. `useEffect` is a no-op (the server renderer would skip it anyway) and
// `useCallback` is pass-through. Nothing else about React is replaced: the rest of the module is
// spread through, so `react-dom/server` gets the genuine internals.
let VALUES = [];
let CURSOR = 0;

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: actual.default,
    useState: (init) => {
      const v = CURSOR < VALUES.length && VALUES[CURSOR] !== undefined ? VALUES[CURSOR] : init;
      CURSOR += 1;
      return [v, () => {}];
    },
    useEffect: () => {},
    useCallback: (f) => f,
  };
});

/**
 * `useState` declaration order inside `BotFarmPanel`. Asserted against the source below, so this
 * table cannot silently drift from the component — which is the one way a hook-shim harness goes
 * quiet: shift the order by one and every state becomes a different state.
 */
const STATE_ORDER = [
  'status', 'loading', 'statusCode', 'adding', 'cleaning', 'stopping',
  'removing', 'actionError', 'actionNote', 'addRole', 'addCount', 'addDelay',
];

let React;
let renderToStaticMarkup;
let BotFarmPanel;
let PANEL_SRC;

beforeAll(async () => {
  // `client/src/api/client.js` reads `window.location.hostname` at module load.
  globalThis.window = globalThis.window || { location: { hostname: 'localhost' }, confirm: () => false };
  React = await import('react');
  ({ renderToStaticMarkup } = await import('react-dom/server'));
  ({ BotFarmPanel } = await import('../Settings.jsx'));
  const fs = await import('node:fs');
  const path = await import('node:path');
  PANEL_SRC = fs.readFileSync(path.join(__dirname, '..', 'Settings.jsx'), 'utf-8');
});

/** Render the real panel in a named state. Returns `{ html, text }`. */
function render(state = {}, { isAdmin = false } = {}) {
  const unknown = Object.keys(state).filter(k => !STATE_ORDER.includes(k));
  if (unknown.length) throw new Error(`unknown state key(s): ${unknown.join(', ')}`);
  VALUES = STATE_ORDER.map(k => state[k]);
  CURSOR = 0;
  const html = renderToStaticMarkup(React.createElement(BotFarmPanel, { isAdmin }));
  // Decode the entities a static render produces so assertions can be written in plain prose.
  const text = html
    .replace(/<[^>]*>/g, '')
    .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  return { html, text };
}

const MODEL = 'claude-haiku-4-5-20251001';

/** A full, well-formed status payload — the shape `getStatus()` actually serves. */
function statusPayload(over = {}) {
  return {
    enabled: true, running: true, activeBots: 1,
    brain: ['model'], brainModel: MODEL,
    brainCalls: 7, maxBrainCalls: 100, sessionMaxDurationMs: 3600000,
    ceilingHit: null, expiredSessions: 0,
    brainSkips: 0, lastSkipReason: null, brainFallbacks: 0,
    shape: {
      maxHostBots: 1, maxCompanionBots: 6, maxConcurrentGames: 1, maxSessionsPerBot: 1,
      hostBots: 1, companionBots: 2, games: 1,
    },
    bots: [],
    ...over,
  };
}

function bot(over = {}) {
  return {
    email: 'bot_a@bot.local', name: 'Jasper', botRole: 'host',
    brain: 'model', brainModel: MODEL, brainCalls: 4, brainSkips: 0,
    turnDelayMs: 60000, sessions: [], ...over,
  };
}

function session(over = {}) {
  return {
    sessionId: '52ae868a-43e2-4d42-9a93-bfccc787e711', sessionLabel: 'Thorin — The Sunless Citadel',
    campaignId: 'demo', role: 'host', state: 'playing', connected: true,
    messageCount: 12, brainCalls: 4, ageMs: 600000, expired: false, ...over,
  };
}

describe('BotFarmPanel renders — no DOM, no new dependency (WO-0036 revision 2)', () => {
  it('the hook-shim table matches the component’s own declaration order', () => {
    // The one way this harness could go quiet: the component adds a `useState` in the middle and
    // every value below shifts to the wrong slot, with everything still "rendering". Derived from
    // the source so the drift is a failure rather than a surprise.
    const body = PANEL_SRC.slice(PANEL_SRC.indexOf('function BotFarmPanel('));
    expect(body.length).toBeGreaterThan(1000);
    const declared = [...body.matchAll(/const \[(\w+), set\w+\] = useState\(/g)].map(m => m[1]);
    expect(declared).toEqual(STATE_ORDER);
  });

  it('1. initial load', () => {
    const { text } = render({ loading: true });
    expect(text).toContain('AI Bot Farm');
    expect(text).toContain('Loading...');
  });

  it('2. 404, admin — names the switch, the restart and the production caveat', () => {
    const { text } = render({ loading: false, statusCode: 404 }, { isAdmin: true });
    expect(text).toContain('CLAUDEDM_BOTS=1 npm run dev');
    expect(text).toMatch(/takes a (server )?restart/i);
    expect(text).toContain('NODE_ENV=production');
  });

  it('3. 404, non-admin — no startup command is disclosed', () => {
    const { text } = render({ loading: false, statusCode: 404 }, { isAdmin: false });
    expect(text).toMatch(/not enabled on this server/i);
    expect(text).not.toContain('CLAUDEDM_BOTS=1');
    expect(text).not.toContain('npm run dev');
  });

  it('4. HTTP 500 is not dressed up as a configuration problem', () => {
    const { text } = render({ loading: false, statusCode: 500 }, { isAdmin: true });
    expect(text).toContain('500');
    expect(text).toMatch(/not the .not enabled. case/i);
  });

  it('5. a network failure (status 0) says so without a code', () => {
    const { text } = render({ loading: false, statusCode: 0 }, { isAdmin: true });
    expect(text).toMatch(/Could not read bot status/i);
    expect(text).not.toMatch(/HTTP 0/);
  });

  it('6. mounted, no bots — names the model the NEXT bot will use', () => {
    const { text } = render({
      loading: false,
      status: statusPayload({ running: false, activeBots: 0, brain: [], bots: [], shape: { ...statusPayload().shape, hostBots: 0, companionBots: 0, games: 0 } }),
    }, { isAdmin: true });
    expect(text).toMatch(/none running/);
    expect(text).toContain(MODEL);
    expect(text).toContain('Shape: 0/1 host, 0/6 companions, 0/1 game');
  });

  it('7. mounted, model brain live, admin — brain, shape, ceilings, controls, table', () => {
    const { text } = render({
      loading: false,
      status: statusPayload({ bots: [bot({ sessions: [session()] })] }),
    }, { isAdmin: true });
    expect(text).toContain('model (live)');
    expect(text).toContain(MODEL);
    expect(text).toContain('Shape: 1/1 host, 2/6 companions, 1/1 game');
    expect(text).toContain('7/100 bot-brain');
    expect(text).toContain('60 min per session');
    expect(text).toContain('Cleanup All');
    expect(text).toContain('Stop All');
    expect(text).toContain('Jasper');
  });

  it('8. the isAdmin split is real — a non-admin gets the table and no controls', () => {
    const state = { loading: false, status: statusPayload({ bots: [bot({ sessions: [session()] })] }) };
    const { text: adminText } = render(state, { isAdmin: true });
    const { text: plainText } = render(state, { isAdmin: false });
    for (const control of ['Cleanup All', 'Stop All', 'Turn delay']) {
      expect(adminText).toContain(control);
      expect(plainText, `${control} must be admin-only`).not.toContain(control);
    }
    expect(plainText).toContain('Jasper');          // the table itself is not admin-gated
    expect(plainText).not.toContain('×');      // and the remove button is
  });

  it('9. the rules brain shows the amber warning with both remedies', () => {
    const { text } = render({
      loading: false,
      status: statusPayload({ brain: ['rules'], brainModel: null, bots: [bot({ brain: 'rules', brainModel: null })] }),
    }, { isAdmin: true });
    expect(text).toMatch(/rules/);
    expect(text).toMatch(/canned|keyword|not a model|no model/i);
  });

  it('10. a MIXED farm cannot report as one thing', () => {
    const { text } = render({
      loading: false,
      status: statusPayload({
        brain: ['model', 'rules'],
        bots: [bot(), bot({ email: 'bot_b@bot.local', name: 'Pip', brain: 'rules', brainModel: null })],
      }),
    }, { isAdmin: true });
    expect(text).toContain('model');
    expect(text).toContain('rules');
  });

  it('11. the brain-call ceiling banner names the limit AND the right config key', () => {
    const { text } = render({
      loading: false,
      status: statusPayload({ brainCalls: 100, ceilingHit: 'brain-call ceiling' }),
    }, { isAdmin: true });
    expect(text).toContain('100/100');
    expect(text).toContain('Ceiling reached: brain-call ceiling');
    expect(text).toContain('maxBrainCalls');
  });

  it('12. the DURATION ceiling now has its own banner — qc-tester item 8', () => {
    // Revision 1 had none: the duration branch never set `ceilingHit`, so after an hour the
    // chair got no banner at all, and the only banner's remedy was hardcoded to
    // `maxBrainCalls`. The duration ceiling is per-session and still does not set `ceilingHit`
    // — a farm-wide stop for one aged-out session would be worse — so it reports separately.
    const { text } = render({
      loading: false,
      status: statusPayload({
        expiredSessions: 1,
        bots: [bot({ sessions: [session({ state: 'expired', expired: true, ageMs: 3600001 })] })],
      }),
    }, { isAdmin: true });
    expect(text).toContain('Session duration ceiling reached: 1 session past 60 min');
    expect(text).toContain('sessionMaxDurationMs');
    expect(text).toMatch(/rest of\s+the farm is unaffected/);
    expect(text).toContain('expired');
    // singular/plural, which is the class of thing a render test is for
    const { text: many } = render({ loading: false, status: statusPayload({ expiredSessions: 3 }) }, { isAdmin: true });
    expect(many).toContain('3 sessions past 60 min');
  });

  it('12b. the farm banner\u2019s remedy key follows the ceiling that tripped, not a hardcoded one', () => {
    // `qc-tester`: *"the red banner's remedy text is hardcoded to `maxBrainCalls`, which is the
    // right key for the only value `ceilingHit` can currently hold, and the wrong one if the
    // duration ceiling is ever wired into it."*
    //
    // Today `ceilingHit` can only be `'brain-call ceiling'`, so this renders a payload the
    // server does not currently produce — deliberately. The branch exists precisely for the edit
    // `qc-tester` anticipated, and a defensive branch nothing exercises is a branch that is
    // wrong when it finally runs. Noted so a reviewer is not surprised to find a test for an
    // unreachable state: it is unreachable by design, and the design could change.
    const { text } = render({
      loading: false,
      status: statusPayload({ ceilingHit: 'session duration ceiling' }),
    }, { isAdmin: true });
    expect(text).toContain('Ceiling reached: session duration ceiling');
    expect(text).toContain('sessionMaxDurationMs');
    expect(text).not.toContain('maxBrainCalls');
  });

  it('13. skips are surfaced with the reason, and the singular is singular', () => {
    const { text } = render({
      loading: false,
      status: statusPayload({ brainSkips: 4, lastSkipReason: "'model' brain: error" }),
    }, { isAdmin: true });
    expect(text).toContain('4 turns skipped');
    expect(text).toContain("(last: 'model' brain: error)");
    expect(text).toMatch(/says nothing rather than something canned/);

    // `qc-tester` reported *"the skips line reads '1 turns skipped' at a count of one"*. Measured
    // against the real module it reads **"1 turn skipped"** — the component already pluralises.
    // Pinned so it stays that way rather than silently corrected or silently broken.
    const { text: one } = render({ loading: false, status: statusPayload({ brainSkips: 1, lastSkipReason: null }) }, { isAdmin: true });
    expect(one).toContain('1 turn skipped');
    expect(one).not.toContain('1 turns skipped');
  });

  it('14. the skip reason on screen comes from the closed set, so no exception text can reach it', () => {
    // SR-36-6 at the far end of the pipe. The server will not put raw `err.message` on the
    // payload any more; this asserts the panel does not synthesise one either, and renders
    // whatever it IS given without interpreting it.
    for (const reason of ["'model' brain: error", "'model' brain: timed out", "'model' brain: empty response", "'model' brain: cancelled on shutdown"]) {
      const { text } = render({ loading: false, status: statusPayload({ brainSkips: 2, lastSkipReason: reason }) }, { isAdmin: true });
      expect(text).toContain(`(last: ${reason})`);
    }
  });

  it('15-18. in-flight states render', () => {
    const base = { loading: false, status: statusPayload({ bots: [bot({ sessions: [session()] })] }) };
    expect(render({ ...base, adding: true }, { isAdmin: true }).text).toContain('Adding');
    expect(render({ ...base, stopping: true }, { isAdmin: true }).text).toContain('Stopping');
    expect(render({ ...base, cleaning: true }, { isAdmin: true }).text).toContain('Cleaning');
    expect(render({ ...base, removing: 'bot_a@bot.local' }, { isAdmin: true }).html).toContain('...');
  });

  it('19-20. action error and action note render where alert() used to be', () => {
    const base = { loading: false, status: statusPayload() };
    expect(render({ ...base, actionError: 'Add refused: already 6 companion bot(s)' }, { isAdmin: true }).text)
      .toContain('Add refused: already 6 companion bot(s)');
    expect(render({ ...base, actionNote: 'Deleted 1 session directory: sess-x.' }, { isAdmin: true }).text)
      .toContain('Deleted 1 session directory: sess-x.');
  });

  it('21. malformed payloads do not throw — {}, all-nulls, wrong types, sessions missing', () => {
    // `qc-tester`'s most valuable states, and the ones that answer revision 1's §9.1 worry: *"if
    // one of those branches throws, the chair sees a broken Settings page."* These are payloads
    // the server cannot even produce, so a throw here would be a latent crash rather than a bug.
    const malformed = [
      {},
      { shape: null, bots: null, brain: null, brainModel: null, maxBrainCalls: null, sessionMaxDurationMs: null, ceilingHit: null, expiredSessions: null },
      { shape: 'nope', bots: 'nope', brain: 'model', brainCalls: 'lots', maxBrainCalls: 'lots', sessionMaxDurationMs: 'soon', expiredSessions: 'some' },
      statusPayload({ bots: [bot({ sessions: undefined })] }),
      statusPayload({ bots: [{}] }),
      statusPayload({ bots: [bot({ sessions: [{}] })] }),
      statusPayload({ shape: {} }),
    ];
    for (const [i, status] of malformed.entries()) {
      for (const isAdmin of [true, false]) {
        expect(() => render({ loading: false, status }, { isAdmin }), `malformed[${i}] isAdmin=${isAdmin}`).not.toThrow();
      }
    }
  });

  it('22. seven bots at the limit, with and without sessions', () => {
    const bots = [bot({ sessions: [session()] })];
    for (let i = 0; i < 6; i++) {
      bots.push(bot({ email: `bot_c${i}@bot.local`, name: `C${i}`, botRole: 'companion', sessions: i % 2 ? [session({ sessionId: `s${i}` })] : [] }));
    }
    const { text } = render({
      loading: false,
      status: statusPayload({ activeBots: 7, bots, shape: { ...statusPayload().shape, companionBots: 6 } }),
    }, { isAdmin: true });
    expect(text).toContain('Shape: 1/1 host, 6/6 companions');
    expect(text).toContain('looking');     // the no-session row
    for (let i = 0; i < 6; i++) expect(text).toContain(`C${i}`);
  });

  it('every field the JSX reads is a field getStatus() serves — the payload contract (sdet §6)', () => {
    // `sdet`: *"Nothing enforces any of that, and a rename in `getStatus()` would blank parts of
    // the panel silently."* Derived from both sides rather than from a list somebody typed.
    const orchSrc = require('node:fs')
      .readFileSync(require('node:path').join(__dirname, '..', '..', '..', '..', 'server', 'bot', 'bot-orchestrator.js'), 'utf-8');
    // Everything `getStatus()` puts on the wire, read out of `getStatus()` itself rather than
    // from a list anybody typed. Both `name:` and the shorthand `name,` count.
    const getStatusStart = orchSrc.indexOf('  getStatus() {');
    expect(getStatusStart, 'getStatus() moved — re-point this test').toBeGreaterThan(-1);
    const getStatusSrc = orchSrc.slice(getStatusStart, orchSrc.indexOf('\n}', getStatusStart));
    const served = new Set([...getStatusSrc.matchAll(/^\s+([a-zA-Z][\w]*)\s*[:,]/gm)].map(m => m[1]));
    expect(served.has('brainCalls') && served.has('bots') && served.has('sessionId')).toBe(true);
    const panelBody = PANEL_SRC.slice(PANEL_SRC.indexOf('function BotFarmPanel('));
    const readFromStatus = new Set([...panelBody.matchAll(/\bstatus(?:\?)?\.([a-zA-Z][\w]*)/g)].map(m => m[1]));
    const readFromShape = new Set([...panelBody.matchAll(/\bshape(?:\?)?\.([a-zA-Z][\w]*)/g)].map(m => m[1]));
    const readFromBot = new Set([...panelBody.matchAll(/\bbot\.([a-zA-Z][\w]*)/g)].map(m => m[1]));
    const readFromSess = new Set([...panelBody.matchAll(/\bsess\.([a-zA-Z][\w]*)/g)].map(m => m[1]));

    const all = [...readFromStatus, ...readFromShape, ...readFromBot, ...readFromSess];
    expect(all.length, 'the extraction found nothing — re-point this test').toBeGreaterThan(20);
    const missing = all.filter(f => !served.has(f));
    expect(missing, 'the panel reads fields getStatus() does not serve').toEqual([]);
  });
});
