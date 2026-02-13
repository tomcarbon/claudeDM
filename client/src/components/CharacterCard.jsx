import { Link } from 'react-router-dom';

function CharacterCard({ character, basePath = '/characters' }) {
  const { id, name, race, subrace, class: cls, level, hitPoints, armorClass } = character;
  const hpPct = hitPoints ? Math.round((hitPoints.current / hitPoints.max) * 100) : 100;

  return (
    <Link to={`${basePath}/${id}`} className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
      <h3 style={{ marginBottom: '0.3rem' }}>{name}</h3>
      <div className="detail-meta">
        Level {level} {subrace ? `${subrace} ` : ''}{race} {cls}
      </div>
      <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem', fontSize: '0.85em' }}>
        <span>AC: <strong>{armorClass}</strong></span>
        <span>HP: <strong>{hitPoints?.current ?? '?'}/{hitPoints?.max ?? '?'}</strong></span>
      </div>
      <div className="hp-bar">
        <div className="hp-bar-fill" style={{ width: `${hpPct}%` }} />
      </div>
    </Link>
  );
}

export default CharacterCard;
