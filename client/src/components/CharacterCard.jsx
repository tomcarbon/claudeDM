import { Link } from 'react-router-dom';

function CharacterCard({ character, basePath = '/characters' }) {
  const { id, name, race, subrace, class: cls, level, hitPoints, armorClass, profilePic, status } = character;
  const isDead = status === 'dead';
  const hpPct = isDead ? 0 : (hitPoints ? Math.round((hitPoints.current / hitPoints.max) * 100) : 100);

  return (
    <Link
      to={`${basePath}/${id}`}
      className="card"
      style={{ textDecoration: 'none', color: 'inherit', opacity: isDead ? 0.55 : 1 }}
    >
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
        {profilePic ? (
          <img src={profilePic} alt={name} className="profile-pic-thumb" style={isDead ? { filter: 'grayscale(100%)' } : {}} />
        ) : (
          <div className="profile-pic-thumb profile-pic-placeholder">{isDead ? '\u{1F480}' : '?'}</div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ marginBottom: '0.3rem' }}>
            {isDead && '\u{1F480} '}{name}
          </h3>
          <div className="detail-meta">
            {isDead ? 'Deceased \u2014 ' : ''}Level {level} {subrace ? (subrace.toLowerCase().includes(race.toLowerCase()) ? subrace : `${subrace} ${race}`) : race} {cls}
          </div>
          <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem', fontSize: '0.85em' }}>
            <span>AC: <strong>{armorClass}</strong></span>
            <span>HP: <strong>{isDead ? '0' : (hitPoints?.current ?? '?')}/{hitPoints?.max ?? '?'}</strong></span>
          </div>
        </div>
      </div>
      <div className="hp-bar">
        <div className="hp-bar-fill" style={{ width: `${hpPct}%` }} />
      </div>
    </Link>
  );
}

export default CharacterCard;
