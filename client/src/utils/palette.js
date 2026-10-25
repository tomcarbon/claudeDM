// palette.js — the arithmetic of campaign palettes. NO DOM, NO React, NO I/O.
//
// WO-0037 phase 1, implementing records/reports/2026-09-23-art-director-ceo-
// campaign-palette-and-dm-lighting.md **revision 2**. Section numbers below cite that note.
// (§2's pulsing design is struck in revision 2 and nothing here is built from it.)
//
// WHY THIS FILE IS PURE. Everything that can be got wrong about this feature is arithmetic:
// whether a palette is inside its luminance window, whether an intermediate crossfade state is
// still readable, whether a mood name is one of the eight. All of it lives here so that
// `__tests__/palette.test.js` asserts the real code rather than a reimplementation of it.
// The DOM half is `sceneLighting.js` and it contains no colour arithmetic at all.

// ---------------------------------------------------------------------------------------------
// The eight moods (§3.2). FIXED AND GLOBAL — not campaign-authorable, by CEO ruling recorded in
// WO-0037 §2. A campaign may choose what `stark` LOOKS like; it may not invent a ninth name.
//
// The reason is not tidiness. If campaigns could name their own moods, those names would have to
// reach the DM's prompt for the DM to choose between them, which recreates the
// client-controlled-prompt hazard the ethics register already carries twice (E2, E11).
//
// PHASE 2 NOTE, and it is a real gap, stated rather than hidden: the design (§6.1) calls for this
// list to be a SERVER-side constant, because that is where the prompt is built. Phase 1 is
// client-only by the tree discipline in WO-0037, so this is the client's copy and the only copy.
// Whoever builds phase 2 must make the server the source of truth and pin the two together with a
// test — two hand-maintained copies of a security-relevant enum is exactly the drift this
// comment exists to prevent.
export const SCENE_MOODS = Object.freeze([
  'calm',     // town, rest, downtime — the default, and an alias for `base`
  'travel',   // road, journey, transit, wilderness crossing
  'court',    // negotiation, audience, diplomacy, intrigue
  'levity',   // comedy, celebration, a warm scene among friends
  'mystery',  // investigation, riddle, puzzle, the unexplained
  'stark',    // cold, hard, inhuman, mineral, abandoned
  'dread',    // horror, the approach of something bad
  'combat',   // initiative has been rolled
]);

export const DEFAULT_MOOD = 'calm';

export function isSceneMood(value) {
  return typeof value === 'string' && SCENE_MOODS.includes(value);
}

// The four surface tokens, and ONLY these four (§3.1 rule 2). A palette may not touch --accent,
// --gold, --text, --text-muted, or any damage / healing / spell-school / status colour: those
// carry meaning, not decoration, and a campaign that recolours *damage* has made a rules display
// lie. index.css:18-20 already says so; across ten campaigns it stops being style and becomes
// correctness.
export const PALETTE_TOKENS = Object.freeze(['bgDark', 'bgCard', 'bgSidebar', 'border']);

// The CSS custom property each token drives. These are the same four variables index.css:24-28
// declares; nothing else is written at runtime.
export const TOKEN_CSS_VAR = Object.freeze({
  bgDark: '--bg-dark-rgb',
  bgCard: '--bg-card-rgb',
  bgSidebar: '--bg-sidebar-rgb',
  border: '--border-rgb',
});

// ---------------------------------------------------------------------------------------------
// Luminance windows (§4.2). WCAG relative luminance, per token, floor and ceiling.
//
// ONE OF THESE FOUR CEILINGS IS NOT A MATTER OF TASTE. `bgSidebar`'s is derived from a contrast
// limit and the other three are the Art Director's aesthetic judgement. Know which is which
// before editing any of them.
//
// THE NUMBER THAT DRIVES bgSidebar: --text-muted on --bg-sidebar. It was #999 (L 0.31855) and
// measured 4.52:1 on the shipped Forest sidebar — AA by 0.0004 of luminance, about 1.4%. VP
// Marketing & Art Direction ruled that a DEFECT rather than an accepted risk on 2026-09-23 and
// --text-muted became #aaa (L 0.40198), which is 5.55:1 on the same surface. WO-0037 carries that
// one-character change in index.css, deliberately: separating a one-character edit from the check
// that enforces it is how the two get out of step.
//
// H-1, the rule that replaced the old 0.0318 guard: --text-muted on --bg-sidebar must measure
// >= 5.3:1 in every authored family, every mood, AND EVERY INTERMEDIATE CROSSFADE STATE. Against
// L(#aaa) that is exactly bgSidebar L <= 0.035, which is the ceiling below. The bare AA limit
// would be L <= 0.05044, so H-1 keeps 30% in hand, and most of that 30% is the --bg-hover white
// wash (see BG_HOVER_ALPHA below) which composites ON TOP of the family and which a raw-token
// check does not see at all.
//
// IF --text-muted IS EVER DARKENED, OR PLACED ON A HOVERED SURFACE, THIS CEILING MUST BE
// RE-DERIVED BEFORE A PALETTE IS AUTHORED AGAINST IT, NOT AFTER. At the measured hover factor,
// muted text on a hovered surface pulls the raw ceiling down to about 0.0325.
//
// Consequence, stated here instead of written down twice (§2.1 T-4): these windows bound each
// token's luminance to a span of 0.006 (0.008 for border, 0.009 for bgSidebar since the ruling),
// so the maximum possible luminance delta of ANY transition is already bounded. DO NOT add a
// separate per-transition luminance cap. A second rule saying the same thing in different units
// is a rule that drifts out of step with the first one; the Art Director considered it and said
// not to, and the ruling explicitly preserved that reasoning while changing the number.
//
// The FLOORS are about looks, not safety: they keep eight moods reading as one campaign rather
// than as eight themes. A `dread` much darker than `calm` looks like a bug, not a mood. The
// bgSidebar floor is untouched by the ruling, so that span is now ~55% wider than it was.
//
// VOID IF A LIGHT THEME IS EVER ADDED. Every window below, and the convexity argument in
// §4.3 that `__tests__/palette.test.js` asserts, hold only while every foreground is lighter
// than every background (lowest foreground L = 0.40198 for #aaa; highest permitted background
// L = 0.035). A light theme reopens the whole question and invalidates both.
export const LUMINANCE_WINDOWS = Object.freeze({
  bgDark:    Object.freeze({ min: 0.010, max: 0.016 }),
  bgCard:    Object.freeze({ min: 0.015, max: 0.021 }),
  bgSidebar: Object.freeze({ min: 0.026, max: 0.035 }),   // ceiling = H-1, not taste
  border:    Object.freeze({ min: 0.022, max: 0.030 }),
});

// The three foregrounds that sit on these surfaces, for the contrast assertions in the tests.
// They are NOT part of the family and a palette may not move them.
export const FOREGROUNDS = Object.freeze({
  text:      Object.freeze([0xee, 0xee, 0xee]),  // --text  #eee
  gold:      Object.freeze([0xf0, 0xc0, 0x40]),  // --gold  #f0c040
  textMuted: Object.freeze([0xaa, 0xaa, 0xaa]),  // --text-muted #aaa — H-1's foreground
});

export const AA_NORMAL_TEXT = 4.5;

// H-1 (vp-marketing-art, 2026-09-23). --text-muted on --bg-sidebar, in every family, every mood
// and every intermediate crossfade state.
export const H1_MIN_CONTRAST = 5.3;

// F-1 (same ruling). --bg-hover is a FAMILY-INDEPENDENT white wash — index.css declares it as
// rgba(255,255,255,0.06) so that a hover reads the same whatever the background family is. It
// therefore composites on top of the active family and RAISES the surface's luminance by about
// half again: measured here, Forest's sidebar goes 0.03145 -> 0.04749 (x1.510) and Amber's
// 0.03048 -> 0.04656 (x1.527). The ruling published x1.55 / x1.53; its Amber figure is exactly this
// one with the composited channels rounded to integers, and its Forest figure (0.04877) could not be
// reproduced here by any rounding. Use the numbers in this file, which the tests compute.
//
// So a check that looks only at the raw token can pass a palette that fails on hover. The old
// #999 on a hovered Forest sidebar was 3.78:1 — a fail — and it was latent only because
// --bg-hover has exactly ONE call site (App.css:2434, .chat-archive-date-btn:hover) whose text
// is --text at 9.28:1. `__tests__/palette.test.js` asserts that that call site is still the only
// one, because a second one is what turns the latent case live.
export const BG_HOVER_ALPHA = 0.06;

/** The surface a reader actually sees when --bg-hover is painted over `triple`. */
export function hoverComposite(triple, alpha = BG_HOVER_ALPHA) {
  return [
    (1 - alpha) * triple[0] + alpha * 255,
    (1 - alpha) * triple[1] + alpha * 255,
    (1 - alpha) * triple[2] + alpha * 255,
  ];
}

// Transition envelope (§2.1). T-1 minimum crossfade, T-2 minimum dwell between transitions that
// the user did not ask for. Both are floors; raising them is a taste decision, lowering them is
// not (below ~400 ms a colour change reads as a rendering fault rather than as the room changing).
export const TRANSITION_MS = 1200;
export const DWELL_MS = 6000;

// ---------------------------------------------------------------------------------------------
// sRGB relative luminance, WCAG 2.x definition.

function linearise(channel8) {
  const c = channel8 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(triple) {
  return 0.2126 * linearise(triple[0])
       + 0.7152 * linearise(triple[1])
       + 0.0722 * linearise(triple[2]);
}

export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

export function inWindow(token, triple) {
  const w = LUMINANCE_WINDOWS[token];
  if (!w) return false;
  const l = relativeLuminance(triple);
  return l >= w.min && l <= w.max;
}

// ---------------------------------------------------------------------------------------------
// Validation. Returns a list of human-readable problems; empty means valid.
//
// This runs in THREE places, because any one of them can be forgotten and three cannot be
// forgotten silently (§4.2): the test suite over every authored palette (the one that fails a
// build), the client on apply (`sceneLighting.js`, falling back to base and then to no palette
// at all), and — phase 2, not here — the server on load.
//
// THE HONEST SCOPE OF THE CLAIM, which must not be widened: the DM holds Edit over PROJECT_ROOT
// (E3/C2, waived under decision 0005) and could write a campaign file. This is NOT a claim that
// such a file is protected. It is the claim that an out-of-window palette DOES NOT RENDER — a
// property of the reader, not of the writer, and the only kind of claim available here.

function isTriple(value) {
  return Array.isArray(value)
    && value.length === 3
    && value.every(n => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255);
}

export function validateFamily(family, where = 'family') {
  const errors = [];
  if (!family || typeof family !== 'object' || Array.isArray(family)) {
    return [`${where}: not an object`];
  }
  for (const key of Object.keys(family)) {
    if (!PALETTE_TOKENS.includes(key)) {
      errors.push(`${where}: unknown token "${key}" — a palette may move only ${PALETTE_TOKENS.join(', ')}`);
    }
  }
  for (const token of PALETTE_TOKENS) {
    const triple = family[token];
    if (!isTriple(triple)) {
      errors.push(`${where}.${token}: expected three integers 0-255, got ${JSON.stringify(triple)}`);
      continue;
    }
    if (!inWindow(token, triple)) {
      const w = LUMINANCE_WINDOWS[token];
      errors.push(`${where}.${token}: luminance ${relativeLuminance(triple).toFixed(5)} outside window ${w.min}-${w.max}`);
    }
  }

  // H-1, stated as the contrast rule it is rather than only as the luminance ceiling it implies.
  // The two are equivalent today; writing both down means a future edit to the ceiling that
  // forgets why the ceiling exists still fails here.
  const sidebar = family.bgSidebar;
  if (isTriple(sidebar)) {
    const ratio = contrastRatio(FOREGROUNDS.textMuted, sidebar);
    if (ratio < H1_MIN_CONTRAST) {
      errors.push(`${where}.bgSidebar: --text-muted contrast ${ratio.toFixed(3)}:1 below H-1's ${H1_MIN_CONTRAST}:1`);
    }
    // F-1: the composited hover surface, not the raw token. Checked against the foreground that
    // is actually painted on --bg-hover today (--text). If --text-muted ever lands on a hovered
    // surface this must become H1_MIN_CONTRAST against FOREGROUNDS.textMuted, and the bgSidebar
    // ceiling has to come down to ~0.0325 first — see LUMINANCE_WINDOWS above.
    const hovered = hoverComposite(sidebar);
    const hoverRatio = contrastRatio(FOREGROUNDS.text, hovered);
    if (hoverRatio < AA_NORMAL_TEXT) {
      errors.push(`${where}.bgSidebar: --text on the --bg-hover composite ${hoverRatio.toFixed(3)}:1 below AA`);
    }
  }

  return errors;
}

// Walks the whole object and rejects ANY string value. §3.1 rule 3 / §6.2: no `name`, no
// `description`, no `showWhen`, no `note`, no `lightingHint`, no free string of any name.
// This rule is load-bearing rather than fussy — it is what keeps a palette from becoming a
// second `dmPersonality`-shaped channel into the highest-trust region of the prompt. A palette
// is numbers consumed by a renderer, and a renderer is not a language model.
export function findStrings(node, path = 'palette') {
  if (typeof node === 'string') return [path];
  if (Array.isArray(node)) return node.flatMap((v, i) => findStrings(v, `${path}[${i}]`));
  if (node && typeof node === 'object') {
    return Object.keys(node).flatMap(k => findStrings(node[k], `${path}.${k}`));
  }
  return [];
}

export function validatePalette(palette, where = 'palette') {
  if (!palette || typeof palette !== 'object' || Array.isArray(palette)) {
    return [`${where}: not an object`];
  }
  const errors = [];

  if (palette.version !== 1) {
    errors.push(`${where}.version: expected 1, got ${JSON.stringify(palette.version)}`);
  }

  for (const strPath of findStrings(palette, where)) {
    errors.push(`${strPath}: strings are not permitted anywhere in a palette (§3.1 rule 3)`);
  }

  errors.push(...validateFamily(palette.base, `${where}.base`));

  const moods = palette.moods;
  if (moods !== undefined) {
    if (!moods || typeof moods !== 'object' || Array.isArray(moods)) {
      errors.push(`${where}.moods: not an object`);
    } else {
      for (const name of Object.keys(moods)) {
        if (name === 'calm') {
          // `calm` IS `base` (§3.2). Two places to state the resting family is two places to
          // disagree, so the file is not allowed to say it twice.
          errors.push(`${where}.moods.calm: "calm" is an alias for base — define it in base, not in moods`);
          continue;
        }
        if (!isSceneMood(name)) {
          errors.push(`${where}.moods.${name}: not one of the eight moods (${SCENE_MOODS.join(', ')})`);
          continue;
        }
        errors.push(...validateFamily(moods[name], `${where}.moods.${name}`));
      }
    }
  }

  const unknown = Object.keys(palette).filter(k => !['version', 'base', 'moods'].includes(k));
  for (const k of unknown) errors.push(`${where}.${k}: unexpected key`);

  return errors;
}

// ---------------------------------------------------------------------------------------------
// Resolution. An undefined mood is a NO-OP that falls back to base, not a guess (§3.2).

export function resolveFamily(palette, mood) {
  if (!palette) return null;
  const base = palette.base;
  if (!base) return null;
  if (!isSceneMood(mood) || mood === DEFAULT_MOOD) return base;
  const family = palette.moods && palette.moods[mood];
  if (!family) return base;
  // The client half of the three-place check. An out-of-window family does not render; the
  // campaign's base does instead.
  if (validateFamily(family).length > 0) return base;
  return family;
}

// ---------------------------------------------------------------------------------------------
// Interpolation. sRGB, straight line in channel space (T-5).
//
// NOT a polar space, for two reasons. The convexity argument that makes every intermediate
// crossfade state readable (§4.3) is about sRGB interpolation and has been verified there and
// nowhere else. And hue interpolation in HSL/LCH passes through hues neither endpoint implies —
// a green-to-red crossfade goes through yellow or through cyan depending on direction, which
// looks like a bug and is not what anybody asked for. sRGB interpolation between two dark
// colours goes straight through dark.

export function lerpTriple(from, to, t) {
  const k = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return [
    Math.round(from[0] + (to[0] - from[0]) * k),
    Math.round(from[1] + (to[1] - from[1]) * k),
    Math.round(from[2] + (to[2] - from[2]) * k),
  ];
}

export function lerpFamily(from, to, t) {
  const out = {};
  for (const token of PALETTE_TOKENS) out[token] = lerpTriple(from[token], to[token], t);
  return out;
}

// Ease-in-out on the PARAMETER only. It reparametrises time; it does not leave the straight line
// in channel space, so §4.3's convexity argument is untouched by it. (If anybody ever replaces
// this with an easing that overshoots — a spring, a back-ease — the argument breaks, because an
// overshoot leaves the segment between the endpoints. Do not.)
export function ease(t) {
  const k = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
}
