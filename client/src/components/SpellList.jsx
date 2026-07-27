import SpellTag from './SpellTag';

export const ORDINALS = ['Cantrip', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'];

// Normalize a single spell entry (string or { name }) to a display string.
export function spellName(s) {
  return typeof s === 'string' ? s : (s && s.name) || '';
}

// Return a character/NPC's leveled spells as [{ level, slots, list: string[] }] for levels 1..9.
// Tolerates every shape the data has used over time:
//   - { level3: { slots, prepared: [...] } }   (current)
//   - { level3: { slots, known: [...] } }       (older schema)
//   - { level3: [...] }                          (bare array)
//   - { knownSpells: [...], spellSlots: { '1st': n } }  (legacy flat, level 1 only)
export function getLeveledSpells(spells) {
  if (!spells || typeof spells !== 'object') return [];
  const out = [];
  for (let lvl = 1; lvl <= 9; lvl++) {
    const node = spells[`level${lvl}`];
    let list = null;
    let slots;
    if (node) {
      list = Array.isArray(node) ? node : (node.prepared || node.known || []);
      slots = Array.isArray(node) ? undefined : node.slots;
    } else if (lvl === 1 && Array.isArray(spells.knownSpells) && spells.knownSpells.length > 0) {
      list = spells.knownSpells;
      slots = spells.spellSlots?.['1st'];
    }
    const names = (list || []).map(spellName).filter(Boolean);
    if (names.length > 0) out.push({ level: lvl, slots, list: names });
  }
  return out;
}

export function hasAnySpells(spells) {
  if (!spells) return false;
  const cantrips = (spells.cantrips || []).map(spellName).filter(Boolean);
  return cantrips.length > 0 || getLeveledSpells(spells).length > 0;
}

// Full spell block for character/NPC detail sheets: cantrips + every prepared/known level (1–9).
export default function SpellList({ spells }) {
  if (!hasAnySpells(spells)) return null;
  const cantrips = (spells.cantrips || []).map(spellName).filter(Boolean);
  const levels = getLeveledSpells(spells);
  return (
    <div className="detail-section">
      <h3>Spells</h3>
      {spells.spellcastingAbility && (
        <div style={{ marginBottom: '0.5rem', fontSize: '0.9em', color: 'var(--text-muted)' }}>
          Spellcasting: {spells.spellcastingAbility} | Save DC {spells.spellSaveDC} | Attack +{spells.spellAttackBonus}
        </div>
      )}
      {cantrips.length > 0 && (
        <div><strong>Cantrips:</strong> {cantrips.map(s => <SpellTag key={s} name={s} />)}</div>
      )}
      {levels.map(({ level, slots, list }) => (
        <div key={level} style={{ marginTop: '0.3rem' }}>
          <strong>{ORDINALS[level]} Level{slots != null ? ` (${slots} slots)` : ''}:</strong>{' '}
          {list.map(s => <SpellTag key={s} name={s} />)}
        </div>
      ))}
    </div>
  );
}
