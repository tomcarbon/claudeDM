import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api/client';
import StatBlock from '../components/StatBlock';

function CharacterDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [char, setChar] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getCharacter(id)
      .then(setChar)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  const handleDelete = async () => {
    if (!window.confirm(`Delete ${char.name}? This cannot be undone.`)) return;
    try {
      await api.deleteCharacter(id);
      navigate('/characters');
    } catch (e) {
      setError(e.message);
    }
  };

  if (loading) return <div className="loading">Loading...</div>;
  if (error) return <div className="error">Error: {error}</div>;
  if (!char) return <div className="error">Character not found</div>;

  return (
    <div>
      <div className="detail-header">
        <div>
          <h2>{char.name}</h2>
          <div className="detail-meta">
            Level {char.level} {char.subrace ? `${char.subrace} ` : ''}{char.race} {char.class}
            {char.background && ` | ${char.background}`}
            {char.alignment && ` | ${char.alignment}`}
          </div>
        </div>
        <div className="actions">
          <Link to={`/characters/${id}/edit`}><button>Edit</button></Link>
          <button className="danger" onClick={handleDelete}>Delete</button>
        </div>
      </div>

      <StatBlock abilities={char.abilities} />

      <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', margin: '1rem 0' }}>
        <div><strong>AC:</strong> {char.armorClass}</div>
        <div><strong>HP:</strong> {char.hitPoints?.current}/{char.hitPoints?.max}</div>
        <div><strong>Speed:</strong> {char.speed} ft</div>
        <div><strong>Prof. Bonus:</strong> +{char.proficiencyBonus}</div>
        <div><strong>XP:</strong> {char.experience}</div>
      </div>

      {char.savingThrows?.length > 0 && (
        <div className="detail-section">
          <h3>Saving Throws</h3>
          <div>{char.savingThrows.map(s => <span key={s} className="tag">{s}</span>)}</div>
        </div>
      )}

      {char.skills?.length > 0 && (
        <div className="detail-section">
          <h3>Skills</h3>
          <div>{char.skills.map(s => <span key={s} className="tag">{s}</span>)}</div>
        </div>
      )}

      {char.languages?.length > 0 && (
        <div className="detail-section">
          <h3>Languages</h3>
          <div>{char.languages.map(l => <span key={l} className="tag">{l}</span>)}</div>
        </div>
      )}

      {char.weapons?.length > 0 && (
        <div className="detail-section">
          <h3>Weapons</h3>
          {char.weapons.map((w, i) => (
            <div key={i} style={{ marginBottom: '0.3rem' }}>
              <strong>{w.name}</strong> — +{w.attackBonus} to hit, {w.damage} {w.damageType}
            </div>
          ))}
        </div>
      )}

      {char.armor?.name && (
        <div className="detail-section">
          <h3>Armor</h3>
          <div>{char.armor.name} ({char.armor.type})</div>
        </div>
      )}

      {char.equipment?.length > 0 && (
        <div className="detail-section">
          <h3>Equipment</h3>
          <div>{char.equipment.map(e => <span key={e} className="tag">{e}</span>)}</div>
        </div>
      )}

      {char.features?.length > 0 && (
        <div className="detail-section">
          <h3>Features & Traits</h3>
          {char.features.map((f, i) => <div key={i} className="tag">{f}</div>)}
        </div>
      )}

      {char.spells && char.spells.cantrips?.length > 0 && (
        <div className="detail-section">
          <h3>Spells</h3>
          {char.spells.spellcastingAbility && (
            <div style={{ marginBottom: '0.5rem', fontSize: '0.9em', color: 'var(--text-muted)' }}>
              Spellcasting: {char.spells.spellcastingAbility} | Save DC {char.spells.spellSaveDC} | Attack +{char.spells.spellAttackBonus}
            </div>
          )}
          {char.spells.cantrips?.length > 0 && (
            <div><strong>Cantrips:</strong> {char.spells.cantrips.map(s => <span key={s} className="tag">{s}</span>)}</div>
          )}
          {char.spells.level1?.known?.length > 0 && (
            <div style={{ marginTop: '0.3rem' }}>
              <strong>1st Level ({char.spells.level1.slots} slots):</strong>{' '}
              {char.spells.level1.known.map(s => <span key={s} className="tag">{s}</span>)}
            </div>
          )}
        </div>
      )}

      {char.personality && (
        <div className="detail-section">
          <h3>Personality</h3>
          <div style={{ fontSize: '0.9em' }}>
            {char.personality.traits && <p><strong>Traits:</strong> {char.personality.traits}</p>}
            {char.personality.ideals && <p><strong>Ideals:</strong> {char.personality.ideals}</p>}
            {char.personality.bonds && <p><strong>Bonds:</strong> {char.personality.bonds}</p>}
            {char.personality.flaws && <p><strong>Flaws:</strong> {char.personality.flaws}</p>}
          </div>
        </div>
      )}

      {char.backstory && (
        <div className="detail-section">
          <h3>Backstory</h3>
          <p style={{ fontSize: '0.9em' }}>{char.backstory}</p>
        </div>
      )}

      <div style={{ marginTop: '2rem' }}>
        <Link to="/characters">&larr; Back to Characters</Link>
      </div>
    </div>
  );
}

export default CharacterDetail;
