import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';

function ScenarioList() {
  const [scenarios, setScenarios] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getScenarios()
      .then(setScenarios)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading">Loading scenarios...</div>;
  if (error) return <div className="error">Error: {error}</div>;

  return (
    <div>
      <h2>Scenarios</h2>
      <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 1.5rem' }}>
        Choose an adventure for your party. Each scenario is designed for {scenarios[0]?.levelRange || '1-2'} level characters.
      </p>
      <div className="card-grid">
        {scenarios.map(s => (
          <Link key={s.id} to={`/scenarios/${s.id}`} className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
            <h3 style={{ marginBottom: '0.3rem' }}>{s.title}</h3>
            {s.subtitle && <div style={{ color: 'var(--accent)', fontSize: '0.85em', fontStyle: 'italic', marginBottom: '0.5rem' }}>{s.subtitle}</div>}
            <div style={{ display: 'flex', gap: '0.75rem', fontSize: '0.8em', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
              <span>Levels {s.levelRange}</span>
              <span>{s.estimatedSessions} sessions</span>
            </div>
            <p style={{ fontSize: '0.9em', lineHeight: 1.5 }}>{s.synopsis}</p>
          </Link>
        ))}
      </div>
      {scenarios.length === 0 && (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
          No scenarios available yet.
        </div>
      )}
    </div>
  );
}

export default ScenarioList;
