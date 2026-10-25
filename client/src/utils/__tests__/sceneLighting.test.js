// sceneLighting.test.js — WO-0037 phase 1. The transition envelope as behaviour, not intent.
//
// T-3 (a transition in flight is RETARGETED, not queued) is the rule the Art Director flagged as
// "a correctness rule, not a comfort one, and the one most likely to be got wrong", so most of
// this file is about it. A queue would replay a backlog — which is how a player who unfreezes the
// lighting gets four transitions in a row.
//
// The controller takes its clock, its frame scheduler and its DOM writer as parameters, so all of
// this runs in node with no browser and no timing flakiness: the clock only moves when a test
// moves it.

import { describe, it, expect } from 'vitest';
import { createLightingController } from '../sceneLighting.js';
import { DWELL_MS, PALETTE_TOKENS, TRANSITION_MS, relativeLuminance, inWindow } from '../palette.js';

const A = { bgDark: [20, 32, 26], bgCard: [23, 40, 31], bgSidebar: [22, 56, 39], border: [30, 50, 40] };
const B = { bgDark: [37, 28, 21], bgCard: [46, 34, 25], bgSidebar: [66, 44, 29], border: [55, 43, 34] };
const C = { bgDark: [41, 26, 25], bgCard: [52, 31, 30], bgSidebar: [82, 33, 35], border: [65, 38, 38] };

/** A fake clock + frame scheduler + DOM writer. Nothing happens until `advance` is called. */
function harness(options = {}) {
  let t = 1000;
  let queued = null;
  let nextHandle = 1;
  const writes = [];
  const controller = createLightingController({
    now: () => t,
    schedule: (cb) => { queued = cb; return nextHandle++; },
    cancel: () => { queued = null; },
    write: (family) => { writes.push(JSON.parse(JSON.stringify(family))); },
    clear: () => { writes.push('cleared'); },
    ...options,
  });
  return {
    controller,
    writes,
    now: () => t,
    /** Move the clock forward, running one frame per 16 ms, as a browser would. */
    advance(ms) {
      const end = t + ms;
      while (t < end) {
        t = Math.min(end, t + 16);
        const cb = queued;
        queued = null;
        if (cb) cb();
      }
      // One more frame at the final instant, so a transition that ends exactly now completes.
      const cb = queued;
      queued = null;
      if (cb) cb();
    },
    pending: () => queued !== null,
  };
}

const last = (writes) => writes[writes.length - 1];

describe('first application', () => {
  it('is an instant commit, not a crossfade from nothing', () => {
    const h = harness();
    expect(h.controller.apply(A, { source: 'user' })).toBe('instant');
    expect(last(h.writes)).toEqual(A);
    expect(h.controller.peek().transitioning).toBe(false);
  });

  it('applying the family already on the page does nothing', () => {
    const h = harness();
    h.controller.apply(A, { source: 'user' });
    const n = h.writes.length;
    expect(h.controller.apply(A, { source: 'user' })).toBe('noop');
    expect(h.writes.length).toBe(n);
  });
});

describe('T-1: the crossfade is at least 1200 ms and every frame of it is in-window', () => {
  it('takes the full duration and lands exactly on the target', () => {
    const h = harness();
    h.controller.apply(A, { source: 'user' });
    expect(h.controller.apply(B, { source: 'user' })).toBe('transition');

    h.advance(TRANSITION_MS / 2);
    expect(h.controller.peek().transitioning).toBe(true);
    const mid = last(h.writes);
    expect(mid).not.toEqual(A);
    expect(mid).not.toEqual(B);

    h.advance(TRANSITION_MS / 2);
    expect(h.controller.peek().transitioning).toBe(false);
    expect(last(h.writes)).toEqual(B);
  });

  it('writes only in-window colours for the whole fade', () => {
    const h = harness();
    h.controller.apply(A, { source: 'user' });
    h.controller.apply(C, { source: 'user' });
    h.advance(TRANSITION_MS);
    expect(h.writes.length).toBeGreaterThan(50);   // ~75 frames at 16 ms
    for (const family of h.writes) {
      for (const token of PALETTE_TOKENS) {
        expect(inWindow(token, family[token]),
          `${token} ${family[token]} L=${relativeLuminance(family[token])}`).toBe(true);
      }
    }
  });

  it('TRANSITION_MS is the 1200 ms floor the design specifies', () => {
    expect(TRANSITION_MS).toBe(1200);
    expect(DWELL_MS).toBe(6000);
  });
});

describe('T-3: retargeted, not queued', () => {
  it('mid-crossfade, the SECOND target wins and the fade continues from where it had reached', () => {
    const h = harness();
    h.controller.apply(A, { source: 'user' });
    h.controller.apply(B, { source: 'user' });
    h.advance(600);
    const whereItReached = last(h.writes);

    expect(h.controller.apply(C, { source: 'user' })).toBe('retarget');
    expect(h.controller.peek().target).toEqual(C);

    // It continues from the colour on screen: the very next frame is near where it was, not near A
    // and not near B.
    h.advance(16);
    const justAfter = last(h.writes);
    for (const token of PALETTE_TOKENS) {
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(justAfter[token][i] - whereItReached[token][i])).toBeLessThanOrEqual(3);
      }
    }

    h.advance(TRANSITION_MS);
    expect(last(h.writes)).toEqual(C);
    // B is never reached. A queue would have arrived at B first.
    expect(h.writes.some(w => JSON.stringify(w) === JSON.stringify(B))).toBe(false);
  });

  it('three moods in quick succession produce ONE fade to the last one, not three fades', () => {
    const h = harness();
    h.controller.apply(A, { source: 'user' });
    h.controller.apply(B, { source: 'user' });
    h.advance(100);
    h.controller.apply(C, { source: 'user' });
    h.advance(100);
    h.controller.apply(A, { source: 'user' });
    h.advance(TRANSITION_MS * 3);

    expect(last(h.writes)).toEqual(A);
    expect(h.controller.peek().transitioning).toBe(false);
    expect(h.writes.some(w => JSON.stringify(w) === JSON.stringify(B))).toBe(false);
    expect(h.writes.some(w => JSON.stringify(w) === JSON.stringify(C))).toBe(false);
  });
});

describe('T-2: the dwell applies to the session, never to the player', () => {
  it('defers a session mood that arrives inside the dwell window, and the LATER one overwrites', () => {
    const h = harness();
    h.controller.apply(A, { source: 'session' });   // instant: nothing was on the page
    h.advance(TRANSITION_MS);

    expect(h.controller.apply(B, { source: 'session' })).toBe('deferred');
    expect(h.controller.apply(C, { source: 'session' })).toBe('deferred');
    // A slot of size one: B is gone, not queued behind C.
    expect(h.controller.peek().pending).toEqual(C);

    h.advance(DWELL_MS + TRANSITION_MS);
    expect(last(h.writes)).toEqual(C);
    expect(h.writes.some(w => JSON.stringify(w) === JSON.stringify(B))).toBe(false);
  });

  it('applies a session mood immediately once the dwell window has closed', () => {
    const h = harness();
    h.controller.apply(A, { source: 'session' });
    h.advance(DWELL_MS + 100);
    expect(h.controller.apply(B, { source: 'session' })).toBe('transition');
  });

  it('never makes the PLAYER wait: a click during the dwell window is immediate', () => {
    // A control that ignores your click for six seconds is broken, and §5 says the player's
    // control wins unconditionally.
    const h = harness();
    h.controller.apply(A, { source: 'session' });
    h.advance(200);
    expect(h.controller.apply(B, { source: 'user' })).toBe('transition');
    h.advance(TRANSITION_MS);
    expect(last(h.writes)).toEqual(B);
  });

  it('a player click clears a deferred session mood rather than letting it fire later', () => {
    const h = harness();
    h.controller.apply(A, { source: 'session' });
    h.controller.apply(B, { source: 'session' });
    expect(h.controller.peek().pending).toEqual(B);
    h.controller.apply(C, { source: 'user' });
    expect(h.controller.peek().pending).toBeNull();
    h.advance(DWELL_MS + TRANSITION_MS);
    expect(last(h.writes)).toEqual(C);
  });
});

describe('prefers-reduced-motion is an instant CUT, not "no change" (§4.4)', () => {
  it('changes the colour with no interpolation at all', () => {
    const h = harness();
    h.controller.setReducedMotion(true);
    h.controller.apply(A, { source: 'user' });
    const n = h.writes.length;
    expect(h.controller.apply(B, { source: 'user' })).toBe('instant');
    // Exactly one further write, and it is the destination. The colour DID change — pinning the
    // palette instead would take a product feature away on the basis of a preference about motion.
    expect(h.writes.length).toBe(n + 1);
    expect(last(h.writes)).toEqual(B);
    expect(h.controller.peek().transitioning).toBe(false);
  });

  it('turning it on mid-fade finishes the fade at once rather than resting on an unauthored blend', () => {
    const h = harness();
    h.controller.apply(A, { source: 'user' });
    h.controller.apply(B, { source: 'user' });
    h.advance(300);
    h.controller.setReducedMotion(true);
    expect(last(h.writes)).toEqual(B);
    expect(h.controller.peek().transitioning).toBe(false);
  });
});

describe('Freeze wins unconditionally, drops rather than queues, and is client-local (§5)', () => {
  it('drops incoming session moods while frozen', () => {
    const h = harness();
    h.controller.apply(A, { source: 'user' });
    h.controller.setFrozen(true);
    expect(h.controller.apply(B, { source: 'session' })).toBe('dropped-frozen');
    h.advance(DWELL_MS * 2);
    expect(last(h.writes)).toEqual(A);
  });

  it('unfreezing does NOT replay a backlog', () => {
    // The specific failure §5 names. Four moods arrive while frozen; unfreezing shows none of them.
    const h = harness();
    h.controller.apply(A, { source: 'user' });
    h.controller.setFrozen(true);
    for (const f of [B, C, B, C]) h.controller.apply(f, { source: 'session' });
    expect(h.controller.peek().pending).toBeNull();
    h.controller.setFrozen(false);
    h.advance(DWELL_MS + TRANSITION_MS);
    expect(last(h.writes)).toEqual(A);
  });

  it('freezing mid-fade completes the fade so the page rests on an authored family', () => {
    const h = harness();
    h.controller.apply(A, { source: 'user' });
    h.controller.apply(B, { source: 'user' });
    h.advance(400);
    h.controller.setFrozen(true);
    expect(last(h.writes)).toEqual(B);
    expect(h.controller.peek().transitioning).toBe(false);
  });

  it('the player can still change the mood while frozen, from their own switcher', () => {
    // Freeze stops the SESSION changing the page. It is not a lock against its owner.
    const h = harness();
    h.controller.apply(A, { source: 'user' });
    h.controller.setFrozen(true);
    expect(h.controller.apply(B, { source: 'user' })).toBe('transition');
  });
});

describe('reset and stop', () => {
  it('reset clears the variables so the shipped family shows through again', () => {
    const h = harness();
    h.controller.apply(A, { source: 'user' });
    h.controller.reset();
    expect(last(h.writes)).toBe('cleared');
    expect(h.controller.peek().current).toBeNull();
    // And the next application is instant again, not a fade from a colour nobody can see.
    expect(h.controller.apply(B, { source: 'user' })).toBe('instant');
  });

  it('stop cancels the frame loop and leaves the page as it is', () => {
    const h = harness();
    h.controller.apply(A, { source: 'user' });
    h.controller.apply(B, { source: 'user' });
    h.controller.stop();
    expect(h.pending()).toBe(false);
  });
});

describe('the default DOM writer', () => {
  // Runs against a stub <html>, so the variable NAMES and the value format are asserted rather
  // than assumed. index.css consumes these as `rgb(var(--bg-card-rgb))` and
  // `rgba(var(--bg-card-rgb), 0.9)`, so the value must be the three channels and nothing else.
  it('sets exactly the four *-rgb variables as "r, g, b", and removes exactly those four', () => {
    const props = new Map();
    const stub = { documentElement: { style: {
      setProperty: (k, v) => props.set(k, v),
      removeProperty: (k) => props.delete(k),
    } } };
    const saved = globalThis.document;
    globalThis.document = stub;
    try {
      const controller = createLightingController({
        now: () => 0,
        schedule: () => 1,
        cancel: () => {},
      });
      controller.apply(A, { source: 'user' });
      expect([...props.keys()].sort()).toEqual(
        ['--bg-card-rgb', '--bg-dark-rgb', '--bg-sidebar-rgb', '--border-rgb']);
      expect(props.get('--bg-card-rgb')).toBe('23, 40, 31');
      // Nothing semantic is touched: no --accent, no --gold, no --text, no --text-muted.
      for (const k of props.keys()) expect(k).toMatch(/^--(bg-(dark|card|sidebar)|border)-rgb$/);
      controller.reset();
      expect(props.size).toBe(0);
    } finally {
      if (saved === undefined) delete globalThis.document; else globalThis.document = saved;
    }
  });
});
