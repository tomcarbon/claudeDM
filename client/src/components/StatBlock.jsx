const ABILITIES = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
const SHORT = { strength: 'STR', dexterity: 'DEX', constitution: 'CON', intelligence: 'INT', wisdom: 'WIS', charisma: 'CHA' };

function formatMod(mod) {
  return mod >= 0 ? `+${mod}` : `${mod}`;
}

function StatBlock({ abilities }) {
  if (!abilities) return null;
  return (
    <div className="stat-block">
      {ABILITIES.map(ab => (
        <div key={ab} className="stat-item">
          <div className="label">{SHORT[ab]}</div>
          <div className="score">{abilities[ab]?.score ?? '—'}</div>
          <div className="modifier">{formatMod(abilities[ab]?.modifier ?? 0)}</div>
        </div>
      ))}
    </div>
  );
}

export default StatBlock;
