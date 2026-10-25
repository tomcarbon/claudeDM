// palette.test.js — WO-0037 phase 1.
//
// Three controls live in this file. The first two are the "CI check" §4.2 asks for: the thing
// that FAILS A BUILD if a palette drifts out of its luminance window or acquires a string. The
// third is the one the design asked for by name.
//
// =============================================================================================
// THE §4.3 CONVEXITY PROPERTY TEST — why it exists, in the words of the person it holds to account
//
// The Art Director proved that WCAG relative luminance is a CONVEX function of sRGB channel
// values (the channel linearisation x -> ((x+0.055)/1.055)^2.4 is convex on the relevant range,
// and luminance is a positive weighted sum of the linearised channels). A convex function
// restricted to a straight line segment attains its maximum at an ENDPOINT. An sRGB crossfade is
// exactly a straight line segment in channel space. Therefore no intermediate state of a
// crossfade is brighter than the brighter of its two endpoints — which is precisely the case a
// static contrast check on the endpoints misses.
//
// It then flagged its own proof, unprompted:
//
//     "The convexity argument in §4.3 is mathematics I am confident in and have spot-checked
//      numerically at one point. It has not been checked by a second role, and it is
//      load-bearing... A property asserted in a design note is not a control, and this paragraph
//      is a design note."
//
// That self-assessment is correct and this test is the answer to it.
//
// VOID IF A LIGHT THEME IS EVER ADDED. Step 2 of the argument — that an interior MINIMUM is
// harmless — holds only because every foreground in this app is lighter than every background
// (lowest foreground L = 0.40198 for #aaa; highest permitted background L = 0.035), so a darker
// intermediate raises contrast. Add a light theme and this file is not merely incomplete, it is
// asserting the wrong property. Delete it and reopen the question; do not adjust it.
// =============================================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  AA_NORMAL_TEXT,
  BG_HOVER_ALPHA,
  FOREGROUNDS,
  H1_MIN_CONTRAST,
  hoverComposite,
  LUMINANCE_WINDOWS,
  PALETTE_TOKENS,
  SCENE_MOODS,
  contrastRatio,
  findStrings,
  inWindow,
  lerpFamily,
  lerpTriple,
  relativeLuminance,
  resolveFamily,
  validateFamily,
  validatePalette,
} from '../palette.js';
import { CAMPAIGN_PALETTES, paletteForCampaign } from '../../data/campaignPalettes.js';

// The two families index.css ships. They are here because they are REAL ENDPOINTS: switching
// campaign applies the new campaign's base over whatever is on screen, so a crossfade between
// two different campaigns' families can happen, and so can one between a palette-less campaign's
// shipped family and a palette. Including them makes the property test cover those cases too.
const SHIPPED = {
  forest: { bgDark: [20, 32, 26], bgCard: [23, 40, 31], bgSidebar: [22, 56, 39], border: [30, 50, 40] },
  amber:  { bgDark: [37, 28, 21], bgCard: [46, 34, 25], bgSidebar: [66, 44, 29], border: [55, 43, 34] },
};

/** Every family that can be an endpoint of a crossfade, flattened with a name for failure output. */
function allFamilies() {
  const out = Object.entries(SHIPPED).map(([name, family]) => [`shipped/${name}`, family]);
  for (const [cid, palette] of Object.entries(CAMPAIGN_PALETTES)) {
    out.push([`${cid}/calm(base)`, palette.base]);
    for (const [mood, family] of Object.entries(palette.moods || {})) out.push([`${cid}/${mood}`, family]);
  }
  return out;
}

describe('the luminance windows themselves (§4.2, as ruled 2026-09-23)', () => {
  // The windows are numbers copied out of a design note. This asserts the arithmetic they came
  // from, so a future edit to a window has to survive the reason the window exists.
  it('derives the bgSidebar ceiling from H-1, exactly', () => {
    const lMuted = relativeLuminance(FOREGROUNDS.textMuted);
    expect(lMuted).toBeCloseTo(0.40198, 5);                       // #aaa
    // For H-1's 5.3:1 the background must satisfy L <= (lMuted + 0.05)/5.3 - 0.05.
    const h1Ceiling = (lMuted + 0.05) / H1_MIN_CONTRAST - 0.05;
    expect(h1Ceiling).toBeCloseTo(0.035279, 6);
    expect(LUMINANCE_WINDOWS.bgSidebar.max).toBe(0.035);
    expect(LUMINANCE_WINDOWS.bgSidebar.max).toBeLessThan(h1Ceiling);
    // And H-1 keeps 30% in hand against the bare AA limit, which is the point of it.
    const aaCeiling = (lMuted + 0.05) / AA_NORMAL_TEXT - 0.05;
    expect(aaCeiling).toBeCloseTo(0.05044, 5);
    expect(LUMINANCE_WINDOWS.bgSidebar.max / aaCeiling).toBeLessThan(0.71);
  });

  it('leaves the other three ceilings alone — only bgSidebar was ever derived from contrast', () => {
    expect(LUMINANCE_WINDOWS.bgDark).toEqual({ min: 0.010, max: 0.016 });
    expect(LUMINANCE_WINDOWS.bgCard).toEqual({ min: 0.015, max: 0.021 });
    expect(LUMINANCE_WINDOWS.border).toEqual({ min: 0.022, max: 0.030 });
    expect(LUMINANCE_WINDOWS.bgSidebar.min).toBe(0.026);
  });

  it('bounds every token, which is why T-4 needs no separate rule in different units', () => {
    // The spans ARE the implied per-transition delta cap. bgSidebar is 0.009 since the ruling
    // (it was 0.006); the other three are unchanged.
    const spans = {};
    for (const token of PALETTE_TOKENS) {
      const w = LUMINANCE_WINDOWS[token];
      spans[token] = Number((w.max - w.min).toFixed(4));
    }
    expect(spans).toEqual({ bgDark: 0.006, bgCard: 0.006, bgSidebar: 0.009, border: 0.008 });
  });

  it('agrees that both shipped families sit inside the windows and clear H-1', () => {
    expect(validateFamily(SHIPPED.forest, 'forest')).toEqual([]);
    expect(validateFamily(SHIPPED.amber, 'amber')).toEqual([]);
    // The pair the ruling was about: #aaa on the shipped Forest sidebar.
    expect(contrastRatio(FOREGROUNDS.textMuted, SHIPPED.forest.bgSidebar)).toBeCloseTo(5.55, 2);
    expect(contrastRatio(FOREGROUNDS.textMuted, SHIPPED.amber.bgSidebar)).toBeCloseTo(5.62, 2);
  });

  it('pins --text-muted and the shipped family to what index.css actually declares', () => {
    // The whole H-1 chain rests on FOREGROUNDS.textMuted and index.css agreeing. They are two
    // hand-maintained copies of one value in two languages, so they are asserted equal here
    // rather than assumed equal. Same for the four shipped triples the windows are derived from.
    const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf-8');

    const muted = /--text-muted:\s*#([0-9a-fA-F]{3})\s*;/.exec(css);
    expect(muted, 'index.css must declare --text-muted as a three-digit hex').not.toBeNull();
    const expanded = [...muted[1]].map(ch => parseInt(ch + ch, 16));
    expect(expanded).toEqual([...FOREGROUNDS.textMuted]);

    for (const [token, cssVar] of Object.entries({
      bgDark: '--bg-dark-rgb', bgCard: '--bg-card-rgb',
      bgSidebar: '--bg-sidebar-rgb', border: '--border-rgb',
    })) {
      const m = new RegExp(`${cssVar}:\\s*([0-9]+),\\s*([0-9]+),\\s*([0-9]+)`).exec(css);
      expect(m, `index.css must declare ${cssVar}`).not.toBeNull();
      expect([+m[1], +m[2], +m[3]], `${cssVar} vs SHIPPED.forest.${token}`)
        .toEqual([...SHIPPED.forest[token]]);
    }
  });
});

describe('F-1: the --bg-hover white wash composites on top of the family', () => {
  // --bg-hover is family-independent white by design (index.css), so it LIGHTENS whatever family
  // is active. A check that reads the raw token cannot see it.
  it('measures the composite factor the ruling reported', () => {
    expect(BG_HOVER_ALPHA).toBe(0.06);
    const forestRaw = relativeLuminance(SHIPPED.forest.bgSidebar);
    const forestHovered = relativeLuminance(hoverComposite(SHIPPED.forest.bgSidebar));
    expect(forestRaw).toBeCloseTo(0.03145, 5);
    expect(forestHovered).toBeCloseTo(0.04749, 5);
    expect(forestHovered / forestRaw).toBeGreaterThan(1.5);
  });

  it('is why #999 had to go: it was 3.78:1 on a HOVERED sidebar, a fail', () => {
    const old999 = [0x99, 0x99, 0x99];
    const hovered = hoverComposite(SHIPPED.forest.bgSidebar);
    expect(contrastRatio(old999, hovered)).toBeLessThan(AA_NORMAL_TEXT);
    expect(contrastRatio(old999, hovered)).toBeCloseTo(3.78, 2);
    // And #aaa clears it.
    expect(contrastRatio(FOREGROUNDS.textMuted, hovered)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(contrastRatio(FOREGROUNDS.textMuted, hovered)).toBeCloseTo(4.64, 2);
  });

  it('holds --bg-hover to its ONE call site, because a second one turns the latent case live', () => {
    // This is the assumption that lets the bgSidebar ceiling be 0.035 rather than ~0.0325: the
    // only text painted on a hovered surface today is --text, at 9.28:1. If this test fails,
    // somebody has added a hover wash somewhere new and the ceiling must be re-derived BEFORE any
    // palette is authored against it. Do not just update the count.
    const css = readFileSync(new URL('../../App.css', import.meta.url), 'utf-8');
    const sites = [...css.matchAll(/var\(--bg-hover\)/g)];
    expect(sites.length, 'App.css --bg-hover call sites').toBe(1);
    expect(css).toMatch(/\.chat-archive-date-btn:hover\s*\{[^}]*var\(--bg-hover\)/);
    // The muted-on-hovered case, as arithmetic, so the tripwire number is written down and not
    // re-derived under pressure later: at the ceiling it would be below AA.
    const atCeiling = hoverComposite([53, 52, 56]);          // L 0.0350, the worst hue found
    expect(contrastRatio(FOREGROUNDS.textMuted, atCeiling)).toBeLessThan(AA_NORMAL_TEXT);
  });
});

describe('the authored palettes (the check that fails a build)', () => {
  it('has at least one authored palette to check', () => {
    expect(Object.keys(CAMPAIGN_PALETTES).length).toBeGreaterThan(0);
  });

  it.each(Object.keys(CAMPAIGN_PALETTES))('%s validates: version, four tokens, in-window', (cid) => {
    expect(validatePalette(CAMPAIGN_PALETTES[cid], cid)).toEqual([]);
  });

  it('contains no strings anywhere — the rule that keeps a palette out of the prompt', () => {
    // §3.1 rule 3 / §6.1-6.2. No name, no description, no showWhen, no note, no lightingHint.
    expect(findStrings(CAMPAIGN_PALETTES, 'CAMPAIGN_PALETTES')).toEqual([]);
  });

  it('uses only the eight fixed mood names, and never re-states calm under moods', () => {
    for (const [cid, palette] of Object.entries(CAMPAIGN_PALETTES)) {
      for (const mood of Object.keys(palette.moods || {})) {
        expect(SCENE_MOODS, `${cid} declares mood "${mood}"`).toContain(mood);
        expect(mood, `${cid} re-states calm under moods`).not.toBe('calm');
      }
    }
  });

  it('every authored family clears AA for all three foregrounds on all four surfaces', () => {
    const failures = [];
    let worst = Infinity;
    let worstWhere = '';
    for (const [name, family] of allFamilies()) {
      for (const token of PALETTE_TOKENS) {
        for (const [fgName, fg] of Object.entries(FOREGROUNDS)) {
          const ratio = contrastRatio(fg, family[token]);
          if (ratio < worst) { worst = ratio; worstWhere = `${name}.${token} vs ${fgName}`; }
          if (ratio < AA_NORMAL_TEXT) failures.push(`${name}.${token} vs ${fgName} = ${ratio}`);
        }
      }
    }
    expect(failures).toEqual([]);
    console.log(`[WO-0037 §4.1] worst static contrast across all families: ${worst.toFixed(3)}:1 (${worstWhere})`);
    expect(worst).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it('every authored family clears H-1 (5.3:1) on the sidebar, raw and hovered', () => {
    const failures = [];
    let worstRaw = Infinity;
    let worstHovered = Infinity;
    for (const [name, family] of allFamilies()) {
      const raw = contrastRatio(FOREGROUNDS.textMuted, family.bgSidebar);
      const hovered = contrastRatio(FOREGROUNDS.text, hoverComposite(family.bgSidebar));
      if (raw < worstRaw) worstRaw = raw;
      if (hovered < worstHovered) worstHovered = hovered;
      if (raw < H1_MIN_CONTRAST) failures.push(`${name}: --text-muted on sidebar ${raw.toFixed(3)}:1 < H-1`);
      if (hovered < AA_NORMAL_TEXT) failures.push(`${name}: --text on hovered sidebar ${hovered.toFixed(3)}:1 < AA`);
    }
    expect(failures).toEqual([]);
    console.log(`[WO-0037 H-1/F-1] worst --text-muted on a sidebar ${worstRaw.toFixed(3)}:1 `
      + `(H-1 needs ${H1_MIN_CONTRAST}); worst --text on a HOVERED sidebar ${worstHovered.toFixed(3)}:1 (AA needs ${AA_NORMAL_TEXT})`);
  });

  it('a campaign with no palette gets nothing — no shared default family (§3.1)', () => {
    expect(paletteForCampaign('demo')).toBeNull();
    expect(paletteForCampaign(null)).toBeNull();
    expect(paletteForCampaign('a-campaign-that-does-not-exist')).toBeNull();
  });

  it('prefers a palette carried on the campaign record over the client-side table', () => {
    // The migration path: the day `palette` lands in campaign.json and the server summary
    // carries it, campaign-authored palettes win with no code change.
    const carried = { version: 1, base: SHIPPED.amber };
    expect(paletteForCampaign('wonderland', { palette: carried })).toBe(carried);
  });
});

describe('§4.3 convexity: no intermediate crossfade state is less readable than its endpoints', () => {
  // The property. Sampled over EVERY ordered pair of authored families — including cross-campaign
  // pairs and the shipped families — at 33 points across the crossfade.
  const SAMPLES = 33;

  // QUANTISATION, and the reason this test does not carry a magic tolerance.
  //
  // The convexity argument is about the CONTINUOUS segment between two colours. `lerpTriple`
  // rounds each channel to an integer, so a sampled state can sit up to half a channel step
  // ABOVE the segment — and the first run of this test found exactly that: Forest border
  // (30,50,40) -> Amber border (55,43,34) at t = 2/33 rounds all three channels up and lands
  // 3.1e-4 of luminance above the brighter endpoint. That is quantisation, not a hole in the
  // proof: the zero-tolerance test below shows the unrounded segment never exceeds the endpoint.
  //
  // So the tolerance is COMPUTED per sample rather than chosen: the most that rounding can add is
  // the luminance of half a step on all three channels AT THAT COLOUR. No constant to drift.
  const halfStepLuminance = (triple) =>
    relativeLuminance([triple[0] + 0.5, triple[1] + 0.5, triple[2] + 0.5]) - relativeLuminance(triple);

  // A sanity ceiling on the whole effect, so "it is only rounding" is asserted and not asserted
  // by me: every window in §4.2 spans at least 0.006, so a 1e-3 excess would be a sixth of the
  // envelope and would deserve a different explanation.
  const QUANTISATION_CEILING = 1e-3;

  const families = allFamilies();

  // NOTE ON HOW THIS IS WRITTEN. It collects failures and asserts ONCE at the end rather than
  // calling expect() inside the loop. That is not style: 650 pairs x 34 samples x 4 tokens is
  // ~88k states and ~440k assertions, and building a per-assertion failure message for each one
  // takes the test from 40 ms to over five seconds. A property test that is too slow to run is a
  // property test somebody deletes.
  it(`holds over all ${families.length * (families.length - 1)} ordered pairs of ${families.length} families`, () => {
    const failures = [];
    let worstExcess = -Infinity;
    let worstContrast = Infinity;
    let worstH1 = Infinity;
    let worstHover = Infinity;
    let checks = 0;

    const note = (msg) => { if (failures.length < 8) failures.push(msg); };

    for (const [fromName, from] of families) {
      for (const [toName, to] of families) {
        if (from === to) continue;
        for (let i = 0; i <= SAMPLES; i++) {
          const mid = lerpFamily(from, to, i / SAMPLES);
          for (const token of PALETTE_TOKENS) {
            const triple = mid[token];
            const l = relativeLuminance(triple);
            const ceiling = Math.max(relativeLuminance(from[token]), relativeLuminance(to[token]));
            const where = `${fromName} -> ${toName} @ ${i}/${SAMPLES} ${token} ${triple}`;

            // 1. THE CLAIM: never brighter than the brighter endpoint, up to quantisation.
            const excess = l - ceiling;
            if (excess > worstExcess) worstExcess = excess;
            if (l > ceiling + halfStepLuminance(triple) + 1e-12) {
              note(`brighter than both endpoints beyond quantisation: ${where} L=${l} > ${ceiling}`);
            }

            // 2. Still inside the token's own window — the readable envelope, no tolerance.
            if (!inWindow(token, triple)) note(`outside window: ${where} L=${l}`);

            // 3. And the three foreground ratios clear AA at EVERY sampled state, which is the
            //    assertion a static endpoint check does not make.
            for (const [fgName, fg] of Object.entries(FOREGROUNDS)) {
              const ratio = contrastRatio(fg, triple);
              if (ratio < worstContrast) worstContrast = ratio;
              if (ratio < AA_NORMAL_TEXT) note(`below AA: ${where} vs ${fgName} = ${ratio}`);
            }

            // 4. H-1 explicitly names "every intermediate crossfade state", so it is asserted
            //    here and not only at the endpoints. F-1's composited hover surface with it.
            if (token === 'bgSidebar') {
              const h1 = contrastRatio(FOREGROUNDS.textMuted, triple);
              if (h1 < worstH1) worstH1 = h1;
              if (h1 < H1_MIN_CONTRAST) note(`below H-1: ${where} = ${h1}`);
              const hov = contrastRatio(FOREGROUNDS.text, hoverComposite(triple));
              if (hov < worstHover) worstHover = hov;
              if (hov < AA_NORMAL_TEXT) note(`below AA on the hover composite: ${where} = ${hov}`);
            }
            checks++;
          }
        }
      }
    }

    expect(failures).toEqual([]);
    expect(checks).toBeGreaterThan(10000);
    // Reported so the quantisation claim is an observation, not a hope. If this ever approaches
    // QUANTISATION_CEILING, something other than rounding is going on.
    expect(worstExcess).toBeLessThan(QUANTISATION_CEILING);
    expect(worstContrast).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(worstH1).toBeGreaterThanOrEqual(H1_MIN_CONTRAST);
    expect(worstHover).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    console.log(`[WO-0037 §4.3] ${checks} sampled states over ${families.length} families; `
      + `worst excess over the brighter endpoint ${worstExcess.toExponential(3)} `
      + `(quantisation only, ceiling ${QUANTISATION_CEILING}); `
      + `worst contrast at any sampled state ${worstContrast.toFixed(3)}:1; `
      + `worst H-1 ${worstH1.toFixed(3)}:1; worst --text on a hovered sidebar ${worstHover.toFixed(3)}:1`);
  });

  it('holds EXACTLY, with zero tolerance, when the rounding is removed', () => {
    // The mathematics without the integer grid. This is the actual convexity claim.
    const unrounded = (from, to, t) => [0, 1, 2].map(c => from[c] + (to[c] - from[c]) * t);
    const failures = [];
    for (const [fromName, from] of families) {
      for (const [toName, to] of families) {
        for (const token of PALETTE_TOKENS) {
          const ceiling = Math.max(relativeLuminance(from[token]), relativeLuminance(to[token]));
          for (let i = 0; i <= SAMPLES; i++) {
            const l = relativeLuminance(unrounded(from[token], to[token], i / SAMPLES));
            if (l > ceiling && failures.length < 8) {
              failures.push(`${fromName} -> ${toName} ${token} @ ${i}/${SAMPLES}: ${l} > ${ceiling}`);
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  // ===========================================================================================
  // A SMALL GAP AT THE TOP OF THE bgSidebar WINDOW, FOUND BY THIS TEST. Reported, not acted on.
  //
  // H-1 requires >= 5.3:1 "in every intermediate crossfade state", and the ceiling that
  // implements it is bgSidebar L <= 0.035 against an H-1 limit of 0.035279 — 2.79e-4 of headroom.
  // Quantising an interpolated colour to integer channels can add up to 6.34e-4 of luminance in
  // that range (worst case at (53,52,56)). So a palette authored AT the ceiling could reach
  // L 0.035634 mid-crossfade, where --text-muted measures 5.278:1 — H-1 missed by 0.022.
  //
  // It is worth knowing and it is NOT worth acting on, and the difference matters: before the
  // ruling this same arithmetic crossed the AA floor (a palette at the old 0.0318 ceiling could
  // reach 4.473:1, a real accessibility failure). After it, the same effect costs 0.4% of a target
  // that itself sits 17% above AA. H-1 is a headroom rule, and spending 0.4% of the headroom on
  // rounding is what headroom is for.
  //
  // Per WO-0037 the note's number is what is implemented and the disagreement is reported. No
  // second rule is added — T-4's reasoning holds and the ruling explicitly preserved it.
  //
  // What this test does about it: it holds every authored family, AND both shipped families, to
  // H-1 at their worst quantised state. All of them pass, because they are authored at 0.0300
  // rather than at the ceiling. A palette authored at the ceiling would appear here.
  // ===========================================================================================
  it('every family clears H-1 even at the worst quantised state of a crossfade', () => {
    const worstQuantised = (triple) =>
      relativeLuminance([triple[0] + 0.5, triple[1] + 0.5, triple[2] + 0.5]);
    const lMuted = relativeLuminance(FOREGROUNDS.textMuted);
    const h1Ceiling = (lMuted + 0.05) / H1_MIN_CONTRAST - 0.05;

    const failures = [];
    for (const [name, family] of allFamilies()) {
      const l = worstQuantised(family.bgSidebar);
      if (l > h1Ceiling) failures.push(`${name}.bgSidebar ${family.bgSidebar}: worst quantised L ${l} > H-1 ceiling ${h1Ceiling}`);
    }
    expect(failures).toEqual([]);

    // The gap itself, asserted rather than only described, so it is a fact in the suite. If this
    // stops being true it is because the ceiling came down, and this block should be deleted.
    expect(worstQuantised([53, 52, 56])).toBeGreaterThan(h1Ceiling);
    // And it is comfortably inside AA, which is the point of the paragraph above.
    expect(contrastRatio(FOREGROUNDS.textMuted, [53, 52, 56])).toBeGreaterThan(AA_NORMAL_TEXT);
  });

  it('reproduces the design note\'s worked spot-check', () => {
    // §4.3: Forest bgCard #17281f (L 0.0180) -> combat red #3d1a1e (L 0.0182). The sRGB midpoint
    // is (42, 33, 31) with L 0.0168 — BELOW both endpoints, as convexity predicts for the
    // minimum, and --text contrast there is better than at the endpoint.
    const a = [0x17, 0x28, 0x1f];
    const b = [0x3d, 0x1a, 0x1e];
    expect(relativeLuminance(a)).toBeCloseTo(0.0180, 4);
    expect(relativeLuminance(b)).toBeCloseTo(0.0182, 4);
    const midpoint = lerpTriple(a, b, 0.5);
    expect(midpoint).toEqual([42, 33, 31]);
    expect(relativeLuminance(midpoint)).toBeCloseTo(0.0168, 4);
    expect(contrastRatio(FOREGROUNDS.text, midpoint)).toBeGreaterThan(contrastRatio(FOREGROUNDS.text, a));
  });
});

describe('validation rejects what the design prohibits', () => {
  const good = { version: 1, base: SHIPPED.forest };

  it('rejects a string anywhere in the palette (§3.1 rule 3)', () => {
    const errs = validatePalette({ ...good, moods: { stark: { ...SHIPPED.amber, note: 'obsidian' } } });
    expect(errs.some(e => /strings are not permitted/.test(e))).toBe(true);
  });

  it('rejects a lightened bgSidebar — the silent failure §4.1 warns about', () => {
    // #aaa on this sidebar is 5.274:1: under H-1, and invisible without a check. It trips the
    // window AND H-1, which is deliberate — the two say the same thing in different units on
    // purpose, so that editing one without understanding it still fails.
    const tooLight = { ...SHIPPED.forest, bgSidebar: [22, 60, 42] };
    expect(contrastRatio(FOREGROUNDS.textMuted, tooLight.bgSidebar)).toBeLessThan(H1_MIN_CONTRAST);
    const errors = validateFamily(tooLight);
    expect(errors.some(e => /outside window/.test(e))).toBe(true);
    expect(errors.some(e => /below H-1/.test(e))).toBe(true);
  });

  it('rejects a token outside the four, a missing token, and a non-integer channel', () => {
    expect(validateFamily({ ...SHIPPED.forest, accent: [233, 69, 96] })
      .some(e => /unknown token "accent"/.test(e))).toBe(true);
    const missing = { ...SHIPPED.forest };
    delete missing.border;
    expect(validateFamily(missing).some(e => /border: expected three integers/.test(e))).toBe(true);
    expect(validateFamily({ ...SHIPPED.forest, bgDark: [20.5, 32, 26] })
      .some(e => /bgDark: expected three integers/.test(e))).toBe(true);
  });

  it('rejects a mood name that is not one of the eight, and rejects moods.calm', () => {
    expect(validatePalette({ ...good, moods: { obsidian: SHIPPED.amber } })
      .some(e => /not one of the eight moods/.test(e))).toBe(true);
    expect(validatePalette({ ...good, moods: { calm: SHIPPED.amber } })
      .some(e => /alias for base/.test(e))).toBe(true);
  });

  it('rejects a missing or wrong version, and any unexpected top-level key', () => {
    expect(validatePalette({ base: SHIPPED.forest }).some(e => /version/.test(e))).toBe(true);
    expect(validatePalette({ ...good, themePrompt: 1 }).some(e => /unexpected key/.test(e))).toBe(true);
  });
});

describe('resolution: an undefined mood is a no-op, not a guess (§3.2)', () => {
  const palette = { version: 1, base: SHIPPED.forest, moods: { combat: SHIPPED.amber } };

  it('calm resolves to base, and so does any mood the campaign has not authored', () => {
    expect(resolveFamily(palette, 'calm')).toBe(palette.base);
    expect(resolveFamily(palette, 'dread')).toBe(palette.base);
    expect(resolveFamily(palette, 'not-a-mood')).toBe(palette.base);
    expect(resolveFamily(palette, undefined)).toBe(palette.base);
  });

  it('an authored mood resolves to its own family', () => {
    expect(resolveFamily(palette, 'combat')).toBe(palette.moods.combat);
  });

  it('falls back to base when an authored family is out of window — the client leg of the three-place check', () => {
    const bad = { version: 1, base: SHIPPED.forest, moods: { combat: { ...SHIPPED.forest, bgSidebar: [90, 140, 110] } } };
    expect(resolveFamily(bad, 'combat')).toBe(bad.base);
  });

  it('returns null when there is no palette at all', () => {
    expect(resolveFamily(null, 'combat')).toBeNull();
    expect(resolveFamily({ version: 1 }, 'combat')).toBeNull();
  });
});
