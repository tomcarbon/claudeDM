// The cards under each campaign on Home (client/src/pages/Home.jsx), and what a click on one does.
import { SHOW_SCENARIO_LINKS } from './features';

// `hidden` cards are not rendered. The Scenarios card is hidden behind SHOW_SCENARIO_LINKS
// (client/src/utils/features.js) — hidden, not deleted, so it comes back by flipping that flag.
// `isStart` marks the card the Premium gate applies to (WO-0050).
export const CAMPAIGN_CARDS = [
  { label: 'Start Adventure', desc: 'Begin a text adventure with your Game Master.', path: '/adventure', className: 'card-adventure', isStart: true },
  { label: 'Characters', desc: 'View, edit, and manage your player characters.', path: '/characters' },
  { label: 'NPC Companions', desc: 'Meet the AI-narrated companions who will join your quest.', path: '/npcs' },
  { label: 'Scenarios (spoilers!)', desc: 'Browse adventure modules for this campaign.', path: '/scenarios', hidden: !SHOW_SCENARIO_LINKS },
  { label: 'World Map', desc: 'Explore the campaign world map.', path: '/world-map' },
];

/**
 * What a card does when clicked: `null` for nothing (the whole box is locked, or this is the
 * Start card and the player cannot start here), else `{ path, state }` for navigate(). Kept outside
 * Home.jsx so the inert-when-unavailable behaviour is tested directly, not inferred from markup.
 */
export function cardClickTarget(card, { locked = false, startLocked = false } = {}) {
  if (locked) return null;
  if (card.isStart && startLocked) return null;
  return { path: card.path, state: card.path === '/adventure' ? { resetSession: true } : undefined };
}
