import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api/client';
import StatBlock from '../components/StatBlock';

function NpcDetail() {
  const { id } = useParams();
  const [npc, setNpc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api.getNpc(id)
      .then(setNpc)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  // Refetch when the page regains focus (e.g. navigating back from adventure)
  useEffect(() => {
    const handleFocus = () => {
      api.getNpc(id).then(setNpc).catch(() => {});
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [id]);

  if (loading) return <div className="loading">Loading...</div>;
  if (error) return <div className="error">Error: {error}</div>;
  if (!npc) return <div className="error">NPC not found</div>;

  return (
    <div>
      <div className="detail-header">
        <div>
          <h2>{npc.name}</h2>
          <div className="detail-meta">
            Level {npc.level} {npc.subrace ? `${npc.subrace} ` : ''}{npc.race} {npc.class}
            {npc.background && ` | ${npc.background}`}
            {npc.alignment && ` | ${npc.alignment}`}
          </div>
        </div>
      </div>

      <StatBlock abilities={npc.abilities} />

      <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', margin: '1rem 0' }}>
        <div><strong>AC:</strong> {npc.armorClass}</div>
        <div><strong>HP:</strong> {npc.hitPoints?.current}/{npc.hitPoints?.max}</div>
        <div><strong>Speed:</strong> {npc.speed} ft</div>
        <div><strong>Prof. Bonus:</strong> +{npc.proficiencyBonus}</div>
      </div>

      {npc.skills?.length > 0 && (
        <div className="detail-section">
          <h3>Skills</h3>
          <div>{npc.skills.map(s => <span key={s} className="tag">{s}</span>)}</div>
        </div>
      )}

      {npc.weapons?.length > 0 && (
        <div className="detail-section">
          <h3>Weapons</h3>
          {npc.weapons.map((w, i) => (
            <div key={i} style={{ marginBottom: '0.3rem' }}>
              <strong>{w.name}</strong> — +{w.attackBonus} to hit, {w.damage} {w.damageType}
            </div>
          ))}
        </div>
      )}

      {npc.equipment?.length > 0 && (
        <div className="detail-section">
          <h3>Equipment</h3>
          <div>{npc.equipment.map(e => <span key={e} className="tag">{e}</span>)}</div>
        </div>
      )}

      {npc.features?.length > 0 && (
        <div className="detail-section">
          <h3>Features</h3>
          {npc.features.map((f, i) => <div key={i} className="tag">{f}</div>)}
        </div>
      )}

      {npc.spells && npc.spells.cantrips?.length > 0 && (
        <div className="detail-section">
          <h3>Spells</h3>
          {npc.spells.cantrips?.length > 0 && (
            <div><strong>Cantrips:</strong> {npc.spells.cantrips.map(s => <span key={s} className="tag">{s}</span>)}</div>
          )}
          {npc.spells.level1?.known?.length > 0 && (
            <div style={{ marginTop: '0.3rem' }}>
              <strong>1st Level ({npc.spells.level1.slots} slots):</strong>{' '}
              {npc.spells.level1.known.map(s => <span key={s} className="tag">{s}</span>)}
            </div>
          )}
        </div>
      )}

      {npc.backstory && (
        <div className="detail-section">
          <h3>Backstory</h3>
          <p style={{ fontSize: '0.9em' }}>{npc.backstory}</p>
        </div>
      )}

      {npc.appearance && (
        <div className="detail-section">
          <h3>Appearance</h3>
          <p style={{ fontSize: '0.9em' }}>{npc.appearance}</p>
        </div>
      )}

      <div style={{ marginTop: '2rem' }}>
        <Link to="/npcs">&larr; Back to Companions</Link>
      </div>
    </div>
  );
}

export default NpcDetail;
