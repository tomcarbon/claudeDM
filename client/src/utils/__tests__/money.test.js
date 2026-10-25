import { describe, it, expect } from 'vitest';
import { parseMoney, formatMoney, moneyLabel } from '../money';

// WO-0040: money on a sheet is prose in equipment[]; Sci-Fi campaigns write dollars or credits.
const USD = { name: 'dollars', symbol: '$', abbrev: 'USD' };
const CR = { name: 'credits', symbol: '₡', abbrev: 'cr' };

describe('parseMoney', () => {
  it('falls back to gold pieces for Fantasy (no currency, or gp)', () => {
    expect(parseMoney(['Belt pouch containing 12 gp', 'Rope'], null)).toBe(12);
    expect(parseMoney(['15 gp'], { abbrev: 'gp' })).toBe(15);
  });

  it('reads dollars and credits in the authored forms', () => {
    expect(parseMoney(['Wallet containing $40', '9mm rounds (45)', 'Cash: $1,250'], USD)).toBe(1290);
    expect(parseMoney(['Credit chit: 250 cr', 'Laser pistol cells (40)', '30 credits in a sock'], CR)).toBe(280);
  });

  it('does not count ammo, counts or CR ratings as money', () => {
    expect(parseMoney(['9mm rounds (45)', 'CR 5 statblock'], CR)).toBe(0);
  });

  it('stays fast on a hostile line (player-writable, rendered for the party)', () => {
    const t = Date.now();
    parseMoney(['1,'.repeat(50000) + 'x'], CR);
    parseMoney(['1,'.repeat(50000) + 'x'], USD);
    expect(Date.now() - t).toBeLessThan(200);
  });
});

describe('formatMoney / moneyLabel', () => {
  it('formats per currency', () => {
    expect(formatMoney(40, USD)).toBe('$40');
    expect(formatMoney(250, CR)).toBe('250 cr');
    expect(formatMoney(12, null)).toBe('12 gp');
    expect(moneyLabel(USD)).toBe('Cash');
    expect(moneyLabel(CR)).toBe('Credits');
    expect(moneyLabel(null)).toBe('Gold');
  });
});
