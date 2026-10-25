import { isSceneMood, DEFAULT_MOOD } from './palette.js';

const STORAGE_KEY = 'dnd_display_settings';

// APPEARANCE (WO-0037 §5). Three values, and the middle one is the default.
//
//   'campaign+moods' — the campaign's colours, and moods that arrive from the session are applied.
//                      In phase 1 the only such source is a mood restored on reload; phase 2 adds
//                      the DM's SetSceneMood tool. This is the tier §5 says a first-run player has
//                      consented to nothing about, so it is opt-in.
//   'campaign'       — the campaign's colours, static. Nothing changes unless the player changes
//                      it from the switcher. DEFAULT: §5 puts tier 1 ON (a campaign having its own
//                      colour is no more consentable than it having a map or a title) and tier 2
//                      OFF until opted in.
//   'classic'        — the one shipped family in index.css. The feature is entirely inert.
//
// The player's own click on the mood switcher is honoured under 'campaign' as well as under
// 'campaign+moods'. It is not an unattended change; it is the player.
export const APPEARANCE_MODES = Object.freeze(['campaign+moods', 'campaign', 'classic']);
export const DEFAULT_APPEARANCE = 'campaign';

const DEFAULTS = {
  collapseThreshold: 20,
  appearance: DEFAULT_APPEARANCE,
  // The player's Freeze (§5). Client-local and it SURVIVES RELOAD, because a person who froze the
  // lighting did not consent to it coming back.
  freezeLighting: false,
  // The mood the player last chose, per campaign, so a reload restores the room. Kept here rather
  // than on the session because §6.3 is load-bearing: everything about this feature that belongs
  // to the player stays in localStorage and never reaches the server, which means no route, no
  // per-player file, no personal-data implication, and NO PATH by which it could reach a prompt.
  // (`session.sceneMood` in the design §3.3 step 5 is phase 2's server-side persistence of a mood
  // the DM set. It is not this.)
  sceneMoods: {},
};

// Anything unrecognised in localStorage is replaced by the default rather than trusted. The store
// is the player's own browser so this is not a security boundary — it is what stops a stale or
// hand-edited value from putting the renderer into a state no code expects.
function sanitize(raw) {
  const out = { ...DEFAULTS, ...raw };

  // collapseThreshold is deliberately NOT touched. It predates this file's WO-0037 changes,
  // Settings.jsx already clamps it at the input, and silently rewriting a stored value would be
  // an unrelated behaviour change inside a work order that is not about it.

  if (!APPEARANCE_MODES.includes(out.appearance)) out.appearance = DEFAULT_APPEARANCE;
  out.freezeLighting = out.freezeLighting === true;

  const moods = {};
  if (out.sceneMoods && typeof out.sceneMoods === 'object' && !Array.isArray(out.sceneMoods)) {
    for (const [campaignId, mood] of Object.entries(out.sceneMoods)) {
      if (typeof campaignId === 'string' && campaignId && isSceneMood(mood)) moods[campaignId] = mood;
    }
  }
  out.sceneMoods = moods;

  return out;
}

export function getDisplaySettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return sanitize(raw ? JSON.parse(raw) : {});
  } catch {
    return sanitize({});
  }
}

// Fired after every save, in THIS tab. The browser's own `storage` event only reaches OTHER
// tabs, so without this the Appearance radio in Settings would change localStorage and the
// palette on screen would not move until a reload — the setting would look broken while being
// correct. Any consumer that holds display settings in React state should listen for it.
export const DISPLAY_SETTINGS_EVENT = 'dnd-display-settings-changed';

export function saveDisplaySettings(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitize(settings)));
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(DISPLAY_SETTINGS_EVENT));
  } catch { /* no window (tests, SSR): the save itself already happened */ }
}

export function getCollapseThreshold() {
  return getDisplaySettings().collapseThreshold;
}

export function getSceneMood(campaignId) {
  if (!campaignId) return DEFAULT_MOOD;
  return getDisplaySettings().sceneMoods[campaignId] || DEFAULT_MOOD;
}
