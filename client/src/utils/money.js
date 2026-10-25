// Money on a sheet is prose inside equipment[] (ADR 0006 keeps it there). Fantasy writes coins as
// "Belt pouch containing 10 gp"; Sci-Fi campaigns declare a currency and write
// "Wallet containing $40" or "Credit chit: 250 cr" (WO-0040).
import { parseGold } from './gold';

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Total money in an equipment list, in the campaign's currency. */
export function parseMoney(equipment, currency) {
  if (!currency || !currency.abbrev || currency.abbrev === 'gp') return parseGold(equipment);
  if (!Array.isArray(equipment)) return 0;
  const patterns = [];
  // Bounded digit runs, anchored on the left: an unbounded `[\\d,]+` backtracks quadratically on a
  // long "1,1,1,…" line, and equipment is player-writable and rendered for the whole party.
  if (currency.symbol) patterns.push(new RegExp(`${escapeRe(currency.symbol)}\\s?(\\d[\\d,]{0,15})`));
  patterns.push(new RegExp(`(?<![\\d,])(\\d[\\d,]{0,15})\\s*${escapeRe(currency.abbrev)}\\b`, 'i'));
  if (currency.name) patterns.push(new RegExp(`(?<![\\d,])(\\d[\\d,]{0,15})\\s*${escapeRe(currency.name)}\\b`, 'i'));
  let total = 0;
  for (const item of equipment) {
    const text = String(item).slice(0, 500);
    for (const re of patterns) {
      const m = text.match(re);
      if (m) { total += parseInt(m[1].replace(/,/g, ''), 10); break; }
    }
  }
  return total;
}

/** "$40", "250 cr", "12 gp". */
export function formatMoney(amount, currency) {
  if (!currency || !currency.abbrev || currency.abbrev === 'gp') return `${amount} gp`;
  if (currency.symbol === '$') return `$${amount}`;
  return `${amount} ${currency.abbrev}`;
}

/** The label for the money field: "Gold", "Cash", "Credits". */
export function moneyLabel(currency) {
  if (!currency || !currency.abbrev || currency.abbrev === 'gp') return 'Gold';
  return currency.abbrev === 'cr' ? 'Credits' : 'Cash';
}
