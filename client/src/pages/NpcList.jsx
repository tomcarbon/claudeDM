import { useState, useEffect } from 'react';
import { api, hasActiveSession } from '../api/client';
import { usePlayer } from '../context/PlayerContext';
import CharacterCard from '../components/CharacterCard';

function NpcList() {
  const { player } = usePlayer();
  const [npcs, setNpcs] = useState([]);
  const [partyNpcs, setPartyNpcs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const sessionActive = hasActiveSession();

  useEffect(() => {
    if (!player) {
      setLoading(false);
      return;
    }
    if (sessionActive) {
      Promise.all([
        api.getNpcs().catch(() => []),
        api.getMyNpcs().catch(() => []),
      ]).then(([party, personal]) => {
        setPartyNpcs(party);
        setNpcs(personal);
      }).catch(e => setError(e.message))
        .finally(() => setLoading(false));
    } else {
      api.getNpcs()
        .then(loaded => { setNpcs(loaded); setPartyNpcs([]); })
        .catch(e => setError(e.message))
        .finally(() => setLoading(false));
    }
  }, [player]);

  if (!player) return <div style={{ padding: '2rem' }}><h2>NPC Companions</h2><p style={{ color: 'var(--text-muted)' }}>Please log in to view your companions.</p></div>;
  if (loading) return <div className="loading">Loading companions...</div>;
  if (error) return <div className="error">Error: {error}</div>;

  return (
    <div>
      {sessionActive && partyNpcs.length > 0 && (
        <>
          <h2>Current Party NPCs</h2>
          <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 1.5rem' }}>
            Live session state — reflects the latest changes from gameplay.
          </p>
          <div className="card-grid">
            {partyNpcs.map(n => (
              <CharacterCard key={`party-${n.id}`} character={n} basePath="/npcs" />
            ))}
          </div>
          <div style={{ borderTop: '1px solid var(--border)', margin: '2rem 0' }} />
        </>
      )}
      <h2>{sessionActive ? 'My Companions' : 'NPC Companions'}</h2>
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
