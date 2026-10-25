import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// WO-0040 / SDET F1: the transfer audit learned Sci-Fi money ($40, 250 cr, 30 credits) and gunfire.
// Both categories start a reconcile check when they match, so what matches is pinned here —
// including the named false positives, so that widening the patterns has to go red to happen.

const { auditDmTurn, auditPlayerTurn } = require('../dm-audit');

const cats = (text) => auditDmTurn(text, [], [], [], {}).map(w => w.category);

beforeAll(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterAll(() => { vi.restoreAllMocks(); });

describe('Sci-Fi money in DM narration', () => {
  it.each([
    'You pay the fence $40 for the pistol.',
    'She counts out $1,250 in twenties.',
    'The fence slides you a chit: 250 credits.',
    'That is 300 cr, take it or leave it.',
    'He wants 50 bucks for the radio.',
  ])('flags %s', (text) => {
    expect(cats(text)).toContain('currency');
  });

  it.each([
    'The Stilt is CR 4.',              // a challenge rating is not money
    'Your 9mm rounds (45) are in the bag.',
    'Credits roll on the old TV.',      // no number, no money
  ])('does not flag %s', (text) => {
    expect(cats(text)).not.toContain('currency');
  });

  // Named false positive: a quoted price is flagged though nothing changed hands. Same as "costs
  // 2 gp" in Fantasy; the reconcile check finds no transfer and costs one cheap call.
  it('flags a quoted price (accepted false positive)', () => {
    expect(cats('The diner coffee costs $2.')).toContain('currency');
  });

  it('flags a player paying in dollars', () => {
    expect(auditPlayerTurn('I pay him $20', [], [], {}).map(w => w.category)).toContain('currency');
  });

  it('stays fast on a hostile line', () => {
    const t = Date.now();
    cats(`${'1,'.repeat(50000)}x credits`);
    expect(Date.now() - t).toBeLessThan(500);
  });
});

describe('gunfire in DM narration', () => {
  it.each([
    'You fire 3 rounds into the door.',
    'She empties her mag at the car.',
    'Dana squeezes off two shots.',
    'He unloads the magazine into the hallway.',
    'You fire a burst down the corridor.',
  ])('flags %s', (text) => {
    expect(cats(text)).toContain('ammunition');
  });

  it.each([
    'The rounds are stacked on the shelf.',
    'You fire the boiler back up.',
  ])('does not flag %s', (text) => {
    expect(cats(text)).not.toContain('ammunition');
  });

  // Named false positive: enemy fire is flagged though no party ammo was spent — the same as an
  // enemy who "fires an arrow" in Fantasy.
  it('flags enemy fire (accepted false positive)', () => {
    expect(cats('The guard fires a burst at you.')).toContain('ammunition');
  });
});
