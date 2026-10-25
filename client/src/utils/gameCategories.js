// Client mirror of server/game-categories.js (WO-0040, WO-0042, WO-0043, WO-0045). A campaign with no `category` is Fantasy —
// the server already normalises this in the campaign list, and this fallback covers a cached list
// written before it did.
export const CATEGORIES = [
  { id: 'fantasy', label: 'Fantasy', icon: '🐉', tagline: 'Swords, spells and the SRD 5.1 rules.' },
  { id: 'scifi', label: 'Sci-Fi', icon: '🚀', tagline: 'Guns, tech and no magic — from 1983 to the far future.' },
  { id: 'noir', label: 'Noir', icon: '🌃', tagline: 'Rain, neon and a client who lies — detective stories from 1938 to 1952.' },
  { id: 'western', label: 'Western', icon: '🤠', tagline: 'Six-guns, long rides and a town that remembers — the frontier, 1874 to 1886.' },
  { id: 'horror', label: 'Horror', icon: '🕯️', tagline: 'Ordinary people, a lantern and something in the dark — haunted America, 1893 to 1974.' },
];

export const DEFAULT_CATEGORY = 'fantasy';

export function categoryOf(campaign) {
  const id = campaign && typeof campaign.category === 'string' ? campaign.category : '';
  return CATEGORIES.some(c => c.id === id) ? id : DEFAULT_CATEGORY;
}

export function categoryLabel(id) {
  return (CATEGORIES.find(c => c.id === id) || CATEGORIES[0]).label;
}

/** Words that differ between rulesets: Fantasy has races and monsters; the others don't. */
export function termsFor(campaign) {
  return categoryOf(campaign) === 'fantasy'
    ? { race: 'Race', monsters: 'Monsters' }
    : { race: 'Origin', monsters: 'Adversaries' };
}
