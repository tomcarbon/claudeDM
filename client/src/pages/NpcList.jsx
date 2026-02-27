import { useState, useEffect } from 'react';
import { api } from '../api/client';
import { usePlayer } from '../context/PlayerContext';
import CharacterCard from '../components/CharacterCard';

function NpcList() {
  const { player } = usePlayer();
  const [npcs, setNpcs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!player) {
      setLoading(false);
      return;
    }
    api.getNpcs()
      .then(setNpcs)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [player]);

  if (!player) return <div style={{ padding: '2rem' }}><h2>NPC Companions</h2><p style={{ color: 'var(--text-muted)' }}>Please log in to view your companions.</p></div>;
  if (loading) return <div className="loading">Loading companions...</div>;
  if (error) return <div className="error">Error: {error}</div>;

  return (
    <div>
      <h2>NPC Companions</h2>
      <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 1.5rem' }}>
        These companions are narrated by your AI Dungeon Master. Click to view their stats.
      </p>
      <div className="card-grid">
        {npcs.map(n => (
          <CharacterCard key={n.id} character={n} basePath="/npcs" />
        ))}
      </div>
    </div>
  );
}

export default NpcList;
