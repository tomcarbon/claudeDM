import { useState, useEffect } from 'react';
import { api, hasActiveSession } from '../api/client';
import { usePlayer } from '../context/PlayerContext';
import { useCampaign } from '../context/CampaignContext';
import CharacterCard from '../components/CharacterCard';

function CurrentParty() {
  const { player } = usePlayer();
  const { campaignId } = useCampaign();
  const [partyCharacters, setPartyCharacters] = useState([]);
  const [partyNpcs, setPartyNpcs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const sessionActive = hasActiveSession();

  const loadParty = () => {
    if (!player || !sessionActive) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const sessionId = localStorage.getItem('dnd_active_session_id');
    if (!sessionId) {
      setLoading(false);
      return;
    }
    api.getSessionParty(sessionId)
      .then(({ characters, npcs }) => {
        setPartyCharacters(characters || []);
        setPartyNpcs(npcs || []);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadParty(); }, [player, sessionActive, campaignId]);

  if (!player) return <div style={{ padding: '2rem' }}><h2>Current Party</h2><p style={{ color: 'var(--text-muted)' }}>Please log in to view your party.</p></div>;
  if (loading) return <div className="loading">Loading party...</div>;
  if (error) return <div className="error">Error: {error}</div>;

  if (!sessionActive) {
    return (
      <div style={{ padding: '2rem' }}>
        <h2>Current Party</h2>
        <p style={{ color: 'var(--text-muted)' }}>No active session. Start an adventure to see your current party here.</p>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
        <h2 style={{ margin: 0 }}>Current Party</h2>
        <button onClick={loadParty} disabled={loading}>
          {loading ? 'Refreshing...' : '🔄 Refresh'}
        </button>
      </div>
      {partyCharacters.length > 0 && (
        <>
          <h3>Party Characters</h3>
          <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 1.5rem' }}>
            Live session state — reflects the latest changes from gameplay.
          </p>
          <div className="card-grid">
            {partyCharacters.map(c => (
              <CharacterCard key={`party-${c.id}`} character={c} />
            ))}
          </div>
        </>
      )}
      {partyCharacters.length > 0 && partyNpcs.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border)', margin: '2rem 0' }} />
      )}
      {partyNpcs.length > 0 && (
        <>
          <h3>Party Companions</h3>
          <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 1.5rem' }}>
            Live session state — reflects the latest changes from gameplay.
          </p>
          <div className="card-grid">
            {partyNpcs.map(n => (
              <CharacterCard key={`party-${n.id}`} character={n} basePath="/npcs" />
            ))}
          </div>
        </>
      )}
      {partyCharacters.length === 0 && partyNpcs.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>No party members found for this session.</p>
      )}
    </div>
  );
}

export default CurrentParty;
