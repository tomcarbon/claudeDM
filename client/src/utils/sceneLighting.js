// sceneLighting.js — the runtime that puts a palette on the page.
//
// WO-0037 phase 1. Design: records/reports/2026-09-23-art-director-ceo-campaign-palette-and-
// dm-lighting.md revision 2, §2.1 (the transition envelope) and §5 (the user's control).
//
// It holds NO colour arithmetic. Every number it interpolates comes from `palette.js`, which is
// pure and tested; this file owns time, the DOM, and the three rules about who wins.
//
// =============================================================================================
// WHICH MECHANISM, AND WHY — the design (§2.1, implementation note) requires this to be stated
// in the source, because the alternative costs somebody an afternoon.
//
// CSS custom properties do not animate. The two options the design names are (a) registering the
// properties with `@property { syntax: '<color>' }` so a CSS `transition` can drive them, and
// (b) a full-bleed overlay of the incoming family whose opacity is faded. This file does NEITHER.
// It runs a requestAnimationFrame loop and writes the four `--*-rgb` variables itself.
//
// Three reasons, in order:
//   1. **T-3, retarget-not-queue, is the rule the design flags as most likely to be got wrong,
//      and this is the mechanism where it is trivially right.** Retargeting a CSS transition
//      mid-flight means reading the computed intermediate value back out of the DOM and starting
//      a new transition from it. Here the intermediate value is a variable we already hold.
//   2. **It interpolates with `lerpFamily` — the exact function the §4.3 convexity property test
//      asserts.** With @property or an overlay, the test would assert a reimplementation of the
//      browser's compositing, which is a test of the test. This way the control covers the code.
//   3. `prefers-reduced-motion` becomes duration 0 rather than a second code path, and there is
//      no overlay to interact with stacking contexts.
// The cost is a rAF loop for 1200 ms per change, a few times a session. That is the trade.
// =============================================================================================

import {
  PALETTE_TOKENS,
  TOKEN_CSS_VAR,
  TRANSITION_MS,
  DWELL_MS,
  lerpFamily,
  ease,
} from './palette.js';

function defaultWrite(family) {
  const root = document.documentElement;
  for (const token of PALETTE_TOKENS) {
    const t = family[token];
    root.style.setProperty(TOKEN_CSS_VAR[token], `${t[0]}, ${t[1]}, ${t[2]}`);
  }
}

function defaultClear() {
  const root = document.documentElement;
  for (const token of PALETTE_TOKENS) root.style.removeProperty(TOKEN_CSS_VAR[token]);
}

function sameFamily(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return PALETTE_TOKENS.every(t =>
    a[t][0] === b[t][0] && a[t][1] === b[t][1] && a[t][2] === b[t][2]);
}

function copyFamily(f) {
  const out = {};
  for (const t of PALETTE_TOKENS) out[t] = [f[t][0], f[t][1], f[t][2]];
  return out;
}

/**
 * The controller. Everything it touches from outside itself is injectable, which is what lets
 * `__tests__/sceneLighting.test.js` drive it on a fake clock with no DOM and assert T-1/T-2/T-3
 * and the reduced-motion cut as behaviour rather than as intent.
 */
export function createLightingController(options = {}) {
  const {
    now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    schedule = (cb) => requestAnimationFrame(cb),
    cancel = (h) => cancelAnimationFrame(h),
    write = defaultWrite,
    clear = defaultClear,
    transitionMs = TRANSITION_MS,
    dwellMs = DWELL_MS,
  } = options;

  let current = null;       // what is on the page right now
  let from = null;          // where the in-flight crossfade started
  let target = null;        // where the in-flight crossfade is going
  let startedAt = 0;
  let handle = null;
  let reducedMotion = false;
  let frozen = false;
  let pending = null;       // AT MOST ONE deferred session target (see T-3, below)
  let lastCommitAt = -Infinity;

  function stopLoop() {
    if (handle !== null) { cancel(handle); handle = null; }
  }

  function startLoop() {
    if (handle === null) handle = schedule(tick);
  }

  function commit(family, at) {
    current = copyFamily(family);
    from = null;
    target = null;
    write(current);
    lastCommitAt = at;
  }

  function beginTransition(family, at) {
    from = current ? copyFamily(current) : copyFamily(family);
    target = copyFamily(family);
    startedAt = at;
    lastCommitAt = at;
    startLoop();
  }

  function tick() {
    handle = null;
    const t = now();

    if (target) {
      const raw = transitionMs <= 0 ? 1 : (t - startedAt) / transitionMs;
      if (raw >= 1) {
        current = copyFamily(target);
        from = null;
        target = null;
        write(current);
      } else {
        current = lerpFamily(from, target, ease(raw));
        write(current);
      }
    }

    // A deferred session target becomes live the moment its dwell window closes.
    if (!target && pending && (t - lastCommitAt) >= dwellMs) {
      const next = pending;
      pending = null;
      if (!sameFamily(current, next)) {
        if (reducedMotion || !current) commit(next, t);
        else beginTransition(next, t);
      } else {
        lastCommitAt = t;
      }
    }

    if (target || pending) startLoop();
  }

  return {
    /**
     * Put `family` on the page.
     *
     * `source` is the whole of the dwell rule, and the reading is deliberate, so it is written
     * down here rather than inferred later:
     *
     *   'user'    — a click on the switcher, or a palette applied because the player changed a
     *               setting. ALWAYS immediate. T-2's six-second dwell is anti-thrash for a source
     *               the player does not control; a control that ignores your click for six seconds
     *               is broken, and §5 says the user's control wins unconditionally.
     *   'session' — a mood that arrived from the session (a restored `sceneMood` today; the DM's
     *               tool in phase 2). Subject to the dwell.
     *
     * T-3, RETARGETED NOT QUEUED, in both places it can happen:
     *   - mid-crossfade: `from` stays where the fade has reached and `target` is replaced. The
     *     fade continues from where it is to the new colour. Nothing is queued.
     *   - inside a dwell window: `pending` is a slot of size ONE and the later arrival OVERWRITES
     *     it. The earlier mood is never rendered. A queue would replay a backlog — which is how a
     *     player who unfreezes the lighting would get four transitions in a row.
     *
     * Returns a short string naming what happened, for the tests and for nothing else.
     */
    apply(family, { source = 'session' } = {}) {
      if (!family) return 'noop';
      const t = now();

      if (frozen) {
        // §5: Freeze DROPS incoming frames rather than queueing them.
        if (source !== 'user') { pending = null; return 'dropped-frozen'; }
      }

      const destination = target || current;
      if (sameFamily(destination, family) && !pending) return 'noop';

      if (source === 'user') {
        pending = null;
        if (reducedMotion || !current) { commit(family, t); return 'instant'; }
        const retarget = target !== null;
        beginTransition(family, t);
        return retarget ? 'retarget' : 'transition';
      }

      // source === 'session'
      if (target !== null) {
        // Mid-flight: retarget. Keep the current visible colour as the new origin.
        from = copyFamily(current);
        target = copyFamily(family);
        startedAt = t;
        lastCommitAt = t;
        startLoop();
        return 'retarget';
      }

      if ((t - lastCommitAt) < dwellMs) {
        pending = copyFamily(family);   // size-one slot; a later arrival overwrites it
        startLoop();
        return 'deferred';
      }

      if (reducedMotion || !current) { commit(family, t); return 'instant'; }
      beginTransition(family, t);
      return 'transition';
    },

    /**
     * `prefers-reduced-motion: reduce` means an INSTANT CUT, not "no change" (§4.4). The colour
     * still changes; only the interpolation goes. A 1200 ms interpolation *is* an animation and
     * the preference is a request not to animate — but a step change contains no motion, and
     * pinning the palette instead would silently remove a product feature from a group of users
     * on the basis of a preference about animation. A player who wants that has the Appearance
     * setting, which is a choice rather than an inference.
     */
    setReducedMotion(value) {
      reducedMotion = !!value;
      if (reducedMotion && target) {
        // Finish the fade now rather than leaving the page on an unauthored blend.
        const t = now();
        commit(target, t);
        stopLoop();
        if (pending) startLoop();
      }
    },

    /**
     * The player's Freeze. It wins unconditionally over the session, it is client-local, and it
     * drops rather than queues.
     *
     * Freezing mid-crossfade COMPLETES the fade instantly instead of stopping where it is. An
     * intermediate blend is inside the luminance windows (§4.3) so it is readable, but it is not
     * a family anybody authored or looked at, and the page should not come to rest on one.
     */
    setFrozen(value) {
      frozen = !!value;
      if (frozen) {
        pending = null;
        if (target) {
          const t = now();
          commit(target, t);
          stopLoop();
        }
      }
    },

    /** Remove the four variables, so index.css's shipped family shows through again. */
    reset() {
      stopLoop();
      current = null; from = null; target = null; pending = null;
      lastCommitAt = -Infinity;
      clear();
    },

    /** Cleanup on unmount. Leaves the current colours in place; cancels the loop. */
    stop() { stopLoop(); },

    /** Inspection, for tests. Not used by the app. */
    peek() {
      return {
        current: current && copyFamily(current),
        target: target && copyFamily(target),
        pending: pending && copyFamily(pending),
        transitioning: target !== null,
        reducedMotion,
        frozen,
        looping: handle !== null,
      };
    },
  };
}

/** Does this browser session ask for reduced motion? Safe when there is no `matchMedia`. */
export function prefersReducedMotion() {
  try {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
