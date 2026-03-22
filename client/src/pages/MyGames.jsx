import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePlayer } from '../context/PlayerContext';
import { api } from '../api/client';
import { playNotification, getAudioSettings } from '../utils/audio';

const POLL_INTERVAL = 5000; // 5 seconds

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function MyGames() {
  const { player } = usePlayer();
  const navigate = useNavigate();
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showAll, setShowAll] = useState(() => localStorage.getItem('dnd_mygames_showall') === 'true');
  const prevPurpleIdsRef = useRef(new Set());
  const initialLoadRef = useRef(true);

  const fetchGames = useCallback(async () => {
    try {
      const data = await api.getAllGames(showAll);
      setGames(data);
      setError(null);

      // Check for new purple lights (your turn) — skip on initial load
      if (!initialLoadRef.current) {
        const newPurpleIds = new Set(data.filter(g => g.turnExpectedFromYou).map(g => g.id));
        const prevIds = prevPurpleIdsRef.current;
        let hasNewPurple = false;
        for (const id of newPurpleIds) {
          if (!prevIds.has(id)) {
            hasNewPurple = true;
            break;
          }
        }
        if (hasNewPurple) {
          playNotification(getAudioSettings());
        }
        prevPurpleIdsRef.current = newPurpleIds;
      } else {
        // First load — seed the set without playing sound
        prevPurpleIdsRef.current = new Set(data.filter(g => g.turnExpectedFromYou).map(g => g.id));
        initialLoadRef.current = false;
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [showAll]);

  useEffect(() => {
    if (!player) return;
    fetchGames();
    const interval = setInterval(fetchGames, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [player, fetchGames]);

  function handleRowClick(game) {
    navigate('/adventure', { state: { loadSessionId: game.id } });
  }

  if (!player) {
    return (
      <div className="my-games-page">
        <h2>My Games</h2>
        <p style={{ color: 'var(--text-muted)', marginTop: '1rem' }}>
          Log in to see your games across all campaigns.
        </p>
      </div>
    );
  }

  return (
    <div className="my-games-page">
      <h2>My Games</h2>
      <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 1rem' }}>
        All your sessions across every campaign.
      </p>
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={showAll}
          onChange={e => { setShowAll(e.target.checked); localStorage.setItem('dnd_mygames_showall', e.target.checked); }}
        />
        <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Show all players</span>
      </label>

      {loading && <p style={{ color: 'var(--text-muted)' }}>Loading...</p>}
      {error && <p style={{ color: '#e74c3c' }}>Error: {error}</p>}

      {!loading && games.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>No saved games yet. Start an adventure!</p>
      )}

      {games.length > 0 && (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
          {games.length} game{games.length !== 1 ? 's' : ''} · {games.reduce((sum, g) => sum + (g.messageCount || 0), 0)} total messages
        </p>
      )}

      {games.length > 0 && (
        <div className="my-games-table-wrap">
          <table className="my-games-table">
            <thead>
              <tr>
                <th className="my-games-th-status"></th>
                <th>Game</th>
                <th>Campaign</th>
                <th className="my-games-th-players">Players</th>
                <th>Msgs</th>
                <th>Last Turn</th>
                <th>Updated</th>
                <th className="my-games-th-created">Created</th>
              </tr>
            </thead>
            <tbody>
              {games.map(g => {
                const isRecent = g.updatedAt && (Date.now() - new Date(g.updatedAt).getTime()) < 5 * 60 * 1000;
                const dotColor = g.dmThinking ? '#f0a030' : g.turnExpectedFromYou ? '#9b59b6' : isRecent ? '#2ecc71' : '#e74c3c';
                const dotGlow = g.dmThinking ? '0 0 8px #f0a030' : g.turnExpectedFromYou ? '0 0 8px #9b59b6' : isRecent ? '0 0 6px #2ecc71' : 'none';
                const dotTitle = g.dmThinking ? 'DM is thinking...' : g.turnExpectedFromYou ? 'Your turn!' : isRecent ? 'Active recently' : 'Inactive';
                const rowClass = g.dmThinking ? ' my-games-row-thinking' : g.turnExpectedFromYou ? ' my-games-row-purple' : '';
                const isOwner = g.canWrite !== false;

                return (
                  <tr
                    key={g.id}
                    className={`my-games-row${rowClass}`}
                    onClick={() => handleRowClick(g)}
                    title={`Click to load session #${g.id.slice(-8)}`}
                  >
                    <td className="my-games-td-status">
                      <span
                        className="my-games-dot"
                        style={{ background: dotColor, boxShadow: dotGlow }}
                        title={dotTitle}
                      />
                    </td>
                    <td className="my-games-td-name">
                      <span className="my-games-name">{g.name}</span>
                      {g.label && <span className="my-games-label">&ldquo;{g.label}&rdquo;</span>}
                      <span className="my-games-meta">
                        {isOwner ? 'Owner' : 'Companion'}
                        {g.settings?.visibility === 'public' ? ' · Public' : ' · Private'}
                        <span className="my-games-id"> #{g.id.slice(-8)}</span>
                      </span>
                    </td>
                    <td className="my-games-td-campaign">
                      <span className="my-games-campaign">{g.campaignTitle || g.campaignId}</span>
                    </td>
                    <td className="my-games-td-players">
                      <span className="my-games-player-count">{g.playerCount || 1}</span>
                    </td>
                    <td className="my-games-td-msgs">
                      <span style={{ color: 'var(--text-muted)' }}>{g.messageCount || 0}</span>
                    </td>
                    <td className="my-games-td-turn">
                      {g.lastPlayerName || '—'}
                    </td>
                    <td className="my-games-td-updated">
                      <span className="my-games-time-relative">{formatDate(g.updatedAt)}</span>
                      <span className="my-games-time-abs">{formatTimestamp(g.updatedAt)}</span>
                    </td>
                    <td className="my-games-td-created">
                      <span className="my-games-time-abs">{formatTimestamp(g.createdAt)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default MyGames;
