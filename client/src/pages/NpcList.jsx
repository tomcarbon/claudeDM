import { useState, useEffect } from 'react';
import { api, hasActiveSession } from '../api/client';
import { usePlayer } from '../context/PlayerContext';
import { useCampaign } from '../context/CampaignContext';
import CharacterCard from '../components/CharacterCard';

function NpcList() {
  const { player } = usePlayer();
  const { campaignId } = useCampaign();
  const [npcs, setNpcs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const sessionActive = hasActiveSession();

  useEffect(() => {
    if (!player) {
      setLoading(false);
      return;
    }
    const fetcher = api.getNpcs();
    fetcher
      .then(loaded => setNpcs(loaded))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [player, campaignId]);

  if (!player) return <div style={{ padding: '2rem' }}><h2>NPC Companions</h2><p style={{ color: 'var(--text-muted)' }}>Please log in to view your companions.</p></div>;
  if (loading) return <div className="loading">Loading companions...</div>;
  if (error) return <div className="error">Error: {error}</div>;

  return (
    <div>
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
