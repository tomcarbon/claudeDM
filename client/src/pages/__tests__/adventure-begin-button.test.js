/**
 * WO-0050 revision 2 (SDET note 1): the Adventure page's Begin Adventure button for a player
 * without Premium access. Rendered with `react-dom/server`, no DOM and no new dependency.
 *
 * What this reaches: the real `Adventure` setup screen (sessionActive false), for a named player
 * and campaign. Effects do not run under a server render, so nothing is fetched and no socket is
 * opened; the `ws` prop is a stub.
 *
 * What it cannot attribute: `disabled` on the button. Under a server render the internal
 * `selectedCampaign` state is still null, which also disables it, so `disabled` alone proves
 * nothing here. The button's LABEL and `title` depend only on `startBlocked`, and those are what
 * this file asserts.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

let PLAYER = null;
let CAMPAIGN = null;

vi.mock('../../context/PlayerContext', () => ({
  PlayerProvider: ({ children }) => children,
  usePlayer: () => ({ player: PLAYER, login: () => {}, logout: () => {} }),
}));
vi.mock('../../context/CampaignContext', () => ({
  CampaignProvider: ({ children }) => children,
  useCampaign: () => ({ campaign: CAMPAIGN, campaigns: CAMPAIGN ? [CAMPAIGN] : [], campaignId: CAMPAIGN?.id || 'demo' }),
}));

let React;
let renderToStaticMarkup;
let Adventure;

beforeAll(async () => {
  globalThis.window = globalThis.window || { location: { hostname: 'localhost' }, history: { replaceState: () => {} } };
  globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  React = await import('react');
  ({ renderToStaticMarkup } = await import('react-dom/server'));
  Adventure = (await import('../Adventure.jsx')).default;
});

const noop = () => {};
const ws = {
  messages: [], setMessages: noop, status: 'idle', sessionId: null, permissionRequest: null,
  sendMessage: noop, sendMessageRaw: noop, startSession: noop, sendPermission: noop, resumeSession: noop,
  watchSession: noop, sessionAccess: { sessionDbId: null, canWrite: true, readOnly: false },
  sessionParticipants: [], companionTurns: [], turnStatus: null, autoFireRef: { current: false },
  retractedText: null, clearRetractedText: noop, submitHostTurn: noop, retractHostTurn: noop,
  continueWithoutAll: noop, setCompanionCharacter: noop, submitCompanionTurn: noop,
  retractCompanionTurn: noop, skipCompanion: noop, sendTypingStatus: noop, typingPlayers: [],
  sessionsChanged: 0, partyChanged: 0, arcSummaries: [], setArcSummaries: noop, archiveSeq: 0,
  setArchiveSeq: noop, setActiveSessionId: noop,
};

function beginButton({ player, campaign }) {
  PLAYER = player;
  CAMPAIGN = campaign;
  const html = renderToStaticMarkup(React.createElement(Adventure, {
    ws, sessionActive: false, setSessionActive: noop, selectedCharacter: 'a', setSelectedCharacter: noop,
    selectedScenario: '', setSelectedScenario: noop, savedSessionDbId: null, setSavedSessionDbId: noop,
    campaignId: campaign.id, selectCampaign: noop, crossCampaignLoadRef: { current: false },
    pendingLoadSessionId: null, setPendingLoadSessionId: noop, activeSessionLabel: '', setActiveSessionLabel: noop,
  }));
  const m = html.match(/<button[^>]*class="btn-primary begin-btn"[^>]*>.*?<\/button>/s);
  return m ? m[0] : '';
}

const paid = { id: 'campaign1', title: 'Paid', premium: true };
const demo = { id: 'demo', title: 'Demo', premium: false };

describe('Adventure — Begin Adventure for a player without Premium access', () => {
  it('reads "Not available on your account", with that title, and is disabled, on a Premium campaign', () => {
    const btn = beginButton({ player: { email: 'x@test.com', premiumAccess: false }, campaign: paid });
    expect(btn).toContain('>Not available on your account</button>');
    expect(btn).toContain('title="Not available on your account"');
    expect(btn).toContain('disabled');
  });

  it('reads "Begin Adventure" with no title on the free demo for the same player, and for players with access', () => {
    for (const [player, campaign] of [
      [{ email: 'x@test.com', premiumAccess: false }, demo],
      [{ email: 'y@test.com', premiumAccess: true }, paid],
      [{ email: 'z@test.com' }, paid],
    ]) {
      const btn = beginButton({ player, campaign });
      expect(btn, JSON.stringify(player) + campaign.id).toContain('>Begin Adventure</button>');
      expect(btn).not.toContain('title=');
    }
  });
});
