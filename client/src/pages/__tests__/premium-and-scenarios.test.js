/**
 * WO-0050, client half: the Home "Start Adventure" card for a player without Premium access, and
 * the hidden "Scenarios (spoilers!)" links. Rendered with `react-dom/server`, no DOM and no new
 * dependency — the same approach as `bot-farm-panel.test.js`.
 *
 * What this reaches: the real `Home` and the real `App` sidebar, rendered for a named player and
 * campaign list; and `cardClickTarget`, which is the whole of what a Home card click does.
 * What it cannot reach: a real click event in a browser, and the Adventure page's Begin button
 * (Adventure is stubbed out of the App render; its disabled state is not exercised here).
 *
 * ZERO network, ZERO agent. Contexts and hooks that would fetch or open a socket are replaced.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let PLAYER = null;
let CAMPAIGNS = [];
let CAMPAIGN_ID = 'demo';

vi.mock('../../context/PlayerContext', () => ({
  PlayerProvider: ({ children }) => children,
  usePlayer: () => ({ player: PLAYER, login: () => {}, logout: () => {} }),
}));

vi.mock('../../context/CampaignContext', () => ({
  CampaignProvider: ({ children }) => children,
  useCampaign: () => ({
    campaigns: CAMPAIGNS,
    campaignId: CAMPAIGN_ID,
    campaign: CAMPAIGNS.find(c => c.id === CAMPAIGN_ID) || null,
    selectCampaign: () => {},
    campaignsLoading: false,
    campaignsError: null,
    campaignsStale: false,
    reloadCampaigns: () => {},
  }),
}));

// App-only collaborators: no socket, no lighting controller, no Adventure page, no chat.
vi.mock('../../hooks/useWebSocket', () => ({
  default: () => ({ status: 'disconnected', chatMessages: [], onlinePlayers: [], joinChat: () => {}, setChatMessages: () => {} }),
}));
vi.mock('../../hooks/useSceneLighting', () => ({ default: () => ({}) }));
vi.mock('../Adventure', () => ({ default: () => null }));
vi.mock('../../components/PlayerChat', () => ({ default: () => null }));
vi.mock('../../components/PlayerLogin', () => ({ default: () => null }));

// BrowserRouter needs a browser; MemoryRouter is the same router with an in-memory history.
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, BrowserRouter: ({ children }) => actual.MemoryRouter({ children, initialEntries: ['/'] }) };
});

let React;
let renderToStaticMarkup;
let MemoryRouter;
let Home;
let CAMPAIGN_CARDS;
let cardClickTarget;
let App;
let SHOW_SCENARIO_LINKS;

beforeAll(async () => {
  globalThis.window = globalThis.window || { location: { hostname: 'localhost' }, history: { replaceState: () => {} } };
  React = await import('react');
  ({ renderToStaticMarkup } = await import('react-dom/server'));
  ({ MemoryRouter } = await import('react-router-dom'));
  Home = (await import('../Home.jsx')).default;
  ({ CAMPAIGN_CARDS, cardClickTarget } = await import('../../utils/homeCards.js'));
  App = (await import('../../App.jsx')).default;
  ({ SHOW_SCENARIO_LINKS } = await import('../../utils/features.js'));
});

const demo = { id: 'demo', title: 'Demo', category: 'fantasy', premium: false, listing: { badge: 'Free', order: 1 } };
const paid = { id: 'campaign1', title: 'Paid One', category: 'fantasy', premium: true, listing: { badge: 'Premium', order: 2 } };

function renderHome({ player, campaigns = [demo, paid] }) {
  PLAYER = player;
  CAMPAIGNS = campaigns;
  CAMPAIGN_ID = 'demo';
  return renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(Home)));
}

/** The markup of one campaign's box, split on the tier header so each campaign is asserted alone. */
function boxFor(html, title) {
  const parts = html.split('<div class="tier-box');
  return parts.find(p => p.includes(`>${title}</h3>`)) || '';
}

/** The Start Adventure card's markup inside a box. */
function startCard(box) {
  const h3 = box.indexOf('<h3>Start Adventure</h3>');
  if (h3 < 0) return '';
  // The card's opening tag is the last element opened before its heading.
  const open = Math.max(box.lastIndexOf('<a ', h3), box.lastIndexOf('<div ', h3));
  const end = box.indexOf('</p>', h3);
  return box.slice(open, end + '</p>'.length + 6);
}

describe('Home — Start Adventure for a player without Premium access', () => {
  it('is grayed out, inert and explains why on a Premium campaign', () => {
    const html = renderHome({ player: { email: 'x@test.com', name: 'X', role: 'player', premiumAccess: false } });
    const card = startCard(boxFor(html, 'Paid One'));
    expect(card).toMatch(/^<div /);                    // not a link: nothing to click or follow
    expect(card).toContain('card-locked');
    expect(card).toContain('card-start-unavailable');
    expect(card).toContain('aria-disabled="true"');
    expect(card).toContain('title="Not available on your account"');
    expect(card).toContain('Not available on your account</p>');
    expect(card).not.toContain('href=');
  });

  it('is a normal, working card on the free demo for the same player', () => {
    const html = renderHome({ player: { email: 'x@test.com', premiumAccess: false } });
    const card = startCard(boxFor(html, 'Demo'));
    expect(card).toMatch(/^<a /);
    expect(card).toContain('href="/adventure"');
    expect(card).toContain('card-adventure');
    expect(card).not.toContain('card-locked');
  });

  it('leaves the other cards on a Premium campaign usable', () => {
    const box = boxFor(renderHome({ player: { email: 'x@test.com', premiumAccess: false } }), 'Paid One');
    for (const p of ['/characters', '/npcs', '/world-map']) expect(box, p).toContain(`href="${p}"`);
  });

  it('is normal for premiumAccess true, for a cached player with no field, and for a guest', () => {
    for (const player of [{ email: 'y@test.com', premiumAccess: true }, { email: 'z@test.com' }, null]) {
      const card = startCard(boxFor(renderHome({ player }), 'Paid One'));
      expect(card, JSON.stringify(player)).toMatch(/^<a /);
      expect(card).not.toContain('card-locked');
    }
  });

  it('treats a campaign the server did not mark free as Premium (an old cached list has no field)', () => {
    const legacy = { ...demo, premium: undefined };
    const card = startCard(boxFor(renderHome({ player: { email: 'x@test.com', premiumAccess: false }, campaigns: [legacy] }), 'Demo'));
    expect(card).toContain('card-start-unavailable');
  });

  it('a click on the unavailable Start card does nothing; the same card on a free campaign navigates', () => {
    const start = CAMPAIGN_CARDS.find(c => c.isStart);
    expect(cardClickTarget(start, { startLocked: true })).toBeNull();
    expect(cardClickTarget(start, { startLocked: false })).toEqual({ path: '/adventure', state: { resetSession: true } });
    const chars = CAMPAIGN_CARDS.find(c => c.path === '/characters');
    expect(cardClickTarget(chars, { startLocked: true })).toEqual({ path: '/characters', state: undefined });
  });
});

describe('"Scenarios (spoilers!)" is hidden, not deleted', () => {
  it('the switch is off', () => {
    expect(SHOW_SCENARIO_LINKS).toBe(false);
  });

  it('appears nowhere on the rendered Home', () => {
    const html = renderHome({ player: { email: 'y@test.com', premiumAccess: true } });
    expect(html).not.toContain('Scenarios (spoilers!)');
    expect(html).not.toContain('href="/scenarios"');
  });

  it('appears nowhere in the rendered sidebar, for a logged-in player in a campaign', () => {
    PLAYER = { email: 'y@test.com', name: 'Y', role: 'player', premiumAccess: true };
    CAMPAIGNS = [demo];
    CAMPAIGN_ID = 'demo';
    const html = renderToStaticMarkup(React.createElement(App));
    expect(html).toContain('href="/characters"');      // the sidebar block the link lived in did render
    expect(html).not.toContain('Scenarios (spoilers!)');
    expect(html).not.toContain('href="/scenarios"');
  });

  it('the /scenarios routes and pages are kept', () => {
    const src = fs.readFileSync(path.join(HERE, '..', '..', 'App.jsx'), 'utf-8');
    expect(src).toContain('<Route path="/scenarios" element={<ScenarioList />} />');
    expect(src).toContain('<Route path="/scenarios/:id" element={<ScenarioDetail />} />');
    expect(fs.existsSync(path.join(HERE, '..', 'ScenarioList.jsx'))).toBe(true);
    expect(fs.existsSync(path.join(HERE, '..', 'ScenarioDetail.jsx'))).toBe(true);
  });
});
