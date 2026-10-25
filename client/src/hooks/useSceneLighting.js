// useSceneLighting.js — wires the campaign palette to React.
//
// WO-0037 phase 1. Design: records/reports/2026-09-23-art-director-ceo-campaign-palette-and-
// dm-lighting.md revision 2.
//
// Mounted ONCE, in App.jsx's AppContent, because a campaign's colour is the campaign's, not the
// adventure screen's — the sidebar names the campaign on every page and should be the campaign's
// colour on every page. The mood switcher and the Freeze button live in the adventure header and
// drive this through the object it returns.
//
// It owns no colour arithmetic (that is utils/palette.js) and no timing (utils/sceneLighting.js).
// What it owns is React: one controller for the lifetime of the app, and the four inputs that
// decide what is on the page.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createLightingController, prefersReducedMotion } from '../utils/sceneLighting.js';
import { paletteForCampaign } from '../data/campaignPalettes.js';
import {
  DEFAULT_MOOD,
  SCENE_MOODS,
  isSceneMood,
  resolveFamily,
  validatePalette,
} from '../utils/palette.js';
import {
  DISPLAY_SETTINGS_EVENT,
  getDisplaySettings,
  saveDisplaySettings,
} from '../utils/displaySettings.js';

export default function useSceneLighting(campaignId, campaign = null) {
  // Lazy useState rather than a ref, so the controller is built exactly once and nothing reads a
  // ref during render (react-hooks/refs). The setter is never called; this is a constant.
  const [controller] = useState(createLightingController);

  const [settings, setSettings] = useState(getDisplaySettings);
  const [reduced, setReduced] = useState(prefersReducedMotion);

  const appearance = settings.appearance;
  const frozen = settings.freezeLighting;
  const mood = (campaignId && settings.sceneMoods[campaignId]) || DEFAULT_MOOD;

  // The campaign's palette, or null. A palette that fails validation is treated as absent: the
  // campaign renders as index.css ships, which is the inert case and never a guess. This is the
  // client leg of the three-place check (§4.2).
  const palette = useMemo(() => {
    const p = paletteForCampaign(campaignId, campaign);
    if (!p) return null;
    const errors = validatePalette(p, `campaign ${campaignId} palette`);
    if (errors.length > 0) {
      console.warn('[Lighting] Palette rejected; rendering the shipped family instead:', errors);
      return null;
    }
    return p;
  }, [campaignId, campaign]);

  // Follow the media query live: a player who changes the OS setting mid-session gets the change
  // without a reload.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Settings lives on another page and writes the same localStorage key. Without this the
  // Appearance radio would change the stored value and nothing on screen until a reload.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onChange = () => setSettings(getDisplaySettings());
    window.addEventListener(DISPLAY_SETTINGS_EVENT, onChange);
    window.addEventListener('storage', onChange);   // the same player's other tab
    return () => {
      window.removeEventListener(DISPLAY_SETTINGS_EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);

  useEffect(() => { controller.setReducedMotion(reduced); }, [controller, reduced]);
  useEffect(() => { controller.setFrozen(frozen); }, [controller, frozen]);

  // The one place a family reaches the page.
  //
  // `source: 'user'` for every application in phase 1, and that is not a shortcut: in phase 1
  // there is no unattended source of a mood at all. The mood is whatever the player last chose
  // from the switcher, restored from their own browser. Phase 2's SetSceneMood frame is what
  // arrives as `source: 'session'`, and the dwell rule (T-2) exists for it.
  useEffect(() => {
    if (appearance === 'classic' || !palette) {
      controller.reset();
      return;
    }
    controller.apply(resolveFamily(palette, mood), { source: 'user' });
  }, [controller, palette, mood, appearance]);

  // Said plainly rather than faked: in PHASE 1, 'campaign' and 'campaign+moods' behave
  // identically, because the only mood that exists is one the player chose and §5 says the
  // player's control always wins. The setting is not decoration — it is the gate phase 2 needs,
  // and `acceptSessionMoods` below is the one line phase 2 reads. It ships now, with the switcher
  // it governs visible, so the player can find and set it BEFORE the DM can move anything.
  const acceptSessionMoods = appearance === 'campaign+moods';

  // Cancel the frame loop if the app unmounts. The variables are left where they are: unmounting
  // AppContent means the page is going away.
  useEffect(() => () => controller.stop(), [controller]);

  const update = useCallback((patch) => {
    setSettings(prev => {
      const next = { ...prev, ...patch };
      saveDisplaySettings(next);
      return next;
    });
  }, []);

  const setMood = useCallback((nextMood) => {
    if (!campaignId || !isSceneMood(nextMood)) return;
    setSettings(prev => {
      const next = { ...prev, sceneMoods: { ...prev.sceneMoods, [campaignId]: nextMood } };
      saveDisplaySettings(next);
      return next;
    });
  }, [campaignId]);

  const setFrozen = useCallback((value) => update({ freezeLighting: !!value }), [update]);
  const setAppearance = useCallback((value) => update({ appearance: value }), [update]);

  return {
    // Which moods this campaign has actually authored. The switcher greys out the rest rather
    // than hiding them, so the player can see that a mood exists and that this campaign has not
    // defined it — an undefined mood falls back to `base` and is a no-op, not a guess (§3.2).
    moods: SCENE_MOODS,
    authoredMoods: useMemo(() => new Set([
      DEFAULT_MOOD,
      ...(palette && palette.moods ? Object.keys(palette.moods).filter(isSceneMood) : []),
    ]), [palette]),
    hasPalette: !!palette,
    mood,
    setMood,
    frozen,
    setFrozen,
    appearance,
    setAppearance,
    // Phase 2 reads this before applying a mood that arrived from the session.
    acceptSessionMoods,
    reducedMotion: reduced,
  };
}
