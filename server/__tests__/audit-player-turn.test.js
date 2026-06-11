import { describe, it, expect } from 'vitest';

const { auditPlayerTurn } = require('../dm-audit');

const EDIT_CALL = { name: 'Edit', input: {} };

describe('auditPlayerTurn', () => {
  it('flags a player-declared gold gift with no backing Edit', () => {
    const warnings = auditPlayerTurn('I give everyone 1 gp.', []);
    const currency = warnings.find(w => w.category === 'currency');
    expect(currency).toBeDefined();
    expect(currency.trigger).toBe('1 gp');
    expect(currency.source).toBe('player');
  });

  it('does NOT flag the gift when a backing Edit call happened this turn', () => {
    const warnings = auditPlayerTurn('I give everyone 1 gp.', [EDIT_CALL]);
    expect(warnings).toEqual([]);
  });

  it('flags a player handing over an item (first-person verb the DM-narration patterns miss)', () => {
    const warnings = auditPlayerTurn('I give Pip my hat.', []);
    expect(warnings.some(w => w.category === 'item_lost_or_consumed')).toBe(true);
  });

  it('flags a player taking/looting an item', () => {
    const warnings = auditPlayerTurn('I grab the gilded dagger off the table.', []);
    expect(warnings.some(w => w.category === 'item_gained')).toBe(true);
  });

  it('does not flag ordinary narration with no transaction', () => {
    const warnings = auditPlayerTurn('I look around the tavern and listen carefully.', []);
    expect(warnings).toEqual([]);
  });

  it('handles empty / non-string input safely', () => {
    expect(auditPlayerTurn('', [])).toEqual([]);
    expect(auditPlayerTurn(undefined, [])).toEqual([]);
    expect(auditPlayerTurn(null, undefined)).toEqual([]);
  });

  it('matches currency amounts regardless of coin type', () => {
    expect(auditPlayerTurn('I pay the innkeeper 5 sp.', []).some(w => w.category === 'currency')).toBe(true);
    expect(auditPlayerTurn('Hand him 50 gold pieces.', []).some(w => w.category === 'currency')).toBe(true);
  });
});
