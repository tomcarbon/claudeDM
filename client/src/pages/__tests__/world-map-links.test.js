/**
 * WO-0050 revision 4, Part D: the World Map's scenario links are hidden with SHOW_SCENARIO_LINKS.
 *
 * With the flag false, clicking a pin does not navigate to /scenarios/…, and the page does not say
 * "Click a location to view its scenario" (or "… on the Scenarios page"). With the flag true, both
 * come back exactly as before. Covered for the data-drawn map (SchematicMap) and every painted map
 * WorldMapPage renders.
 *
 * No DOM and no new dependency. A "pin click" here is the pin element's own onClick prop, taken
 * from the real map component's output and called: the real WorldMapPage is called as a function
 * (its hooks, useNavigate and useCampaign, are mocked), each map element it returns is expanded by
 * calling the real map component, and every element with an onClick is clicked. `useState` is
 * replaced by a stateless stand-in so the painted maps can be expanded outside a renderer. The text
 * is checked on the real server-rendered markup. What this does not reach: a browser click or the
 * hover cursor (`.map-links-off .map-marker` in App.css is read, not rendered).
 *
 * ZERO network, ZERO agent.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

let FLAG = false;
let CAMPAIGN_ID = 'demo';
let CAMPAIGN = null;
const navigate = vi.fn();

vi.mock('../../utils/features', () => ({
  get SHOW_SCENARIO_LINKS() { return FLAG; },
}));

vi.mock('../../context/CampaignContext', () => ({
  useCampaign: () => ({ campaignId: CAMPAIGN_ID, campaign: CAMPAIGN }),
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useNavigate: () => navigate };
});

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useState: (v) => [typeof v === 'function' ? v() : v, () => {}] };
});

let React;
let renderToStaticMarkup;
let WorldMapPage;

beforeAll(async () => {
  React = await import('react');
  ({ renderToStaticMarkup } = await import('react-dom/server'));
  WorldMapPage = (await import('../WorldMapPage.jsx')).default;
});

beforeEach(() => { navigate.mockClear(); });

const SCHEMATIC = {
  id: 'coldwar', title: 'Cold War', subtitle: 'Berlin, 1961', category: 'scifi',
  mapLocations: [
    { id: 'p1', name: 'Checkpoint', subtitle: 'The wall', scenarioId: 'scen-1', x: 10, y: 10 },
    { id: 'p2', name: 'Safehouse', subtitle: 'Kreuzberg', scenarioId: 'scen-2', x: 40, y: 40 },
    { id: 'p3', name: 'Unlinked', x: 70, y: 70 },
  ],
  linkedScenarios: ['scen-1', 'scen-2'],
};

// [label, campaignId, campaign, how many linked pins the map draws (0 = none)]
const CASES = [
  ['data-drawn map (SchematicMap)', 'coldwar', SCHEMATIC, 2],
  ['Underdark (campaign1)', 'campaign1', { id: 'campaign1', title: 'U' }, 1],
  ['Giants (campaign3)', 'campaign3', { id: 'campaign3', title: 'G' }, 1],
  ['Wonderland', 'wonderland', { id: 'wonderland', title: 'W' }, 1],
  ['Crimson Throne (campaign2)', 'campaign2', { id: 'campaign2', title: 'C' }, 1],
  ['Astral Sea (campaign4)', 'campaign4', { id: 'campaign4', title: 'A' }, 1],
  ['Plane of Fire (campaign5)', 'campaign5', { id: 'campaign5', title: 'F' }, 1],
  ['Shattered Coast (demo, WorldMap)', 'demo', { id: 'demo', title: 'D' }, 1],
];
const NO_PIN_CASES = [
  ['Hinomoto (nihon)', 'nihon', { id: 'nihon', title: 'N' }],
  ['a non-fantasy campaign with no map', 'blackcrane', { id: 'blackcrane', title: 'B', category: 'noir' }],
];

const SCENARIO_WORDING = /view its scenario|Scenarios page/i;

function children(el) {
  if (!el || typeof el !== 'object') return [];
  const c = el.props?.children;
  return (Array.isArray(c) ? c.flat(Infinity) : [c]).filter(x => x && typeof x === 'object');
}

/** Expand function components (the map components), keep host elements, return all elements. */
function flatten(el, out = []) {
  if (!el || typeof el !== 'object') return out;
  if (Array.isArray(el)) { for (const x of el) flatten(x, out); return out; }
  out.push(el);
  if (typeof el.type === 'function') flatten(el.type(el.props), out);
  for (const c of children(el)) flatten(c, out);
  return out;
}

function pageTree(campaignId, campaign) {
  CAMPAIGN_ID = campaignId;
  CAMPAIGN = campaign;
  return flatten(WorldMapPage());
}

function clickEverything(tree) {
  const clickable = tree.filter(e => typeof e.type === 'string' && typeof e.props?.onClick === 'function');
  for (const e of clickable) e.props.onClick({ preventDefault() {}, stopPropagation() {} });
  return clickable.length;
}

function pageHtml(campaignId, campaign) {
  CAMPAIGN_ID = campaignId;
  CAMPAIGN = campaign;
  return renderToStaticMarkup(React.createElement(WorldMapPage));
}

describe('World Map with SHOW_SCENARIO_LINKS false (the shipped value)', () => {
  beforeEach(() => { FLAG = false; });

  it('the shipped flag is false', async () => {
    const real = await vi.importActual('../../utils/features.js');
    expect(real.SHOW_SCENARIO_LINKS).toBe(false);
  });

  for (const [label, cid, campaign, linked] of CASES) {
    it(`${label}: clicking every pin navigates nowhere, no handler reaches the map, no scenario wording`, () => {
      const tree = pageTree(cid, campaign);
      const map = tree.find(e => typeof e.type === 'function');
      expect(map, label).toBeTruthy();
      expect(map.props.onLocationClick, label).toBeUndefined();
      clickEverything(tree);
      expect(navigate).not.toHaveBeenCalled();
      const html = pageHtml(cid, campaign);
      expect(html).not.toMatch(SCENARIO_WORDING);
      expect(html).not.toContain('/scenarios');
      expect(html).toContain('class="map-links-off"');
      expect(linked).toBeGreaterThan(0);
    });
  }

  it('the data-drawn map draws its pins as plain labels, not buttons, and still shows their names', () => {
    const html = pageHtml('coldwar', SCHEMATIC);
    expect(html).not.toMatch(/<button[^>]*schematic-pin/);
    expect(html).toContain('Checkpoint');
    expect(html).toContain('Berlin, 1961.');
  });

  for (const [label, cid, campaign] of NO_PIN_CASES) {
    it(`${label}: no wording that points at the Scenarios page`, () => {
      expect(pageHtml(cid, campaign)).not.toMatch(SCENARIO_WORDING);
    });
  }
});

describe('World Map with SHOW_SCENARIO_LINKS true (the flag restores the old behaviour)', () => {
  beforeEach(() => { FLAG = true; });

  for (const [label, cid, campaign, linked] of CASES) {
    it(`${label}: a pin click navigates to /scenarios/:id and the wording is back`, () => {
      const tree = pageTree(cid, campaign);
      const map = tree.find(e => typeof e.type === 'function');
      expect(typeof map.props.onLocationClick).toBe('function');
      expect(clickEverything(tree)).toBeGreaterThanOrEqual(linked);
      expect(navigate).toHaveBeenCalled();
      for (const [to] of navigate.mock.calls) expect(to).toMatch(/^\/scenarios\/[^/]+$/);
      const html = pageHtml(cid, campaign);
      expect(html).toMatch(/view its scenario/);
      expect(html).not.toContain('map-links-off');
    });
  }

  it('the data-drawn map navigates to exactly its linked scenarios and keeps its old sentence', () => {
    clickEverything(pageTree('coldwar', SCHEMATIC));
    const targets = new Set(navigate.mock.calls.map(([to]) => to));
    expect([...targets].sort()).toEqual(['/scenarios/scen-1', '/scenarios/scen-2']);
    expect(pageHtml('coldwar', SCHEMATIC)).toContain('Berlin, 1961. Click a location to view its scenario.');
  });

  for (const [label, cid, campaign] of NO_PIN_CASES) {
    it(`${label}: the Scenarios-page wording is back`, () => {
      expect(pageHtml(cid, campaign)).toMatch(/Scenarios page/);
    });
  }
});
