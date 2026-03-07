import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { usePlayer } from '../context/PlayerContext';

function Settings() {
  const { player } = usePlayer();
  const isAdmin = player?.role === 'admin';
  const [restoring, setRestoring] = useState(false);
  const [restored, setRestored] = useState(false);
  const [loadingShuffle, setLoadingShuffle] = useState(true);
  const [savingShuffle, setSavingShuffle] = useState(false);
  const [shuffleEnabled, setShuffleEnabled] = useState(false);
  const [shuffleSaved, setShuffleSaved] = useState(false);
  const [realisticDice, setRealisticDice] = useState(true);
  const [loadingDice, setLoadingDice] = useState(true);
  const [savingDice, setSavingDice] = useState(false);
  const [diceSaved, setDiceSaved] = useState(false);
  const [resetting, setResetting] = useState(null); // 'characters' | 'npcs' | 'all' | null
  const [resetDone, setResetDone] = useState(null);
  const [friends, setFriends] = useState([]);
  const [blocked, setBlocked] = useState([]);
  const [friendInput, setFriendInput] = useState('');
  const [blockedInput, setBlockedInput] = useState('');
  const [savingMultiplayer, setSavingMultiplayer] = useState(false);
  const [multiplayerSaved, setMultiplayerSaved] = useState(false);

  useEffect(() => {
    if (!isAdmin) {
      setLoadingShuffle(false);
    } else {
      api.getGlobalDmSettings()
        .then((settings) => {
          setShuffleEnabled(!!settings?.aiDailyShuffle);
        })
        .catch(() => {
          setShuffleEnabled(false);
        })
        .finally(() => {
          setLoadingShuffle(false);
        });
    }
    // Load per-user settings for all players
    api.getDmSettings()
      .then((settings) => {
        setRealisticDice(settings?.realisticDice !== false);
        if (Array.isArray(settings?.friends)) setFriends(settings.friends);
        if (Array.isArray(settings?.blocked)) setBlocked(settings.blocked);
      })
      .catch(() => {
        setRealisticDice(true);
      })
      .finally(() => {
        setLoadingDice(false);
      });
  }, [isAdmin]);

  const handleShuffleToggle = async (e) => {
    const nextValue = e.target.checked;
    setSavingShuffle(true);
    setShuffleSaved(false);
    try {
      await api.updateGlobalDmSettings({ aiDailyShuffle: nextValue });
      setShuffleEnabled(nextValue);
      setShuffleSaved(true);
      setTimeout(() => setShuffleSaved(false), 3000);
    } catch (err) {
      alert('Failed to update AI shuffle setting: ' + err.message);
    }
    setSavingShuffle(false);
  };

  const handleDiceToggle = async (e) => {
    const nextValue = e.target.checked;
    setSavingDice(true);
    setDiceSaved(false);
    try {
      await api.updateDmSettings({ realisticDice: nextValue });
      setRealisticDice(nextValue);
      setDiceSaved(true);
      setTimeout(() => setDiceSaved(false), 3000);
    } catch (err) {
      alert('Failed to update dice mode: ' + err.message);
    }
    setSavingDice(false);
  };

  const handleRestore = async () => {
    if (!window.confirm('Are you sure you want to restore all data to defaults? This will overwrite any changes made during gameplay.')) {
      return;
    }

    setRestoring(true);
    try {
      await api.restoreDefaults();
      setRestored(true);
      setTimeout(() => setRestored(false), 3000);
    } catch (err) {
      alert('Failed to restore defaults: ' + err.message);
    }
    setRestoring(false);
  };

  const handleResetMyData = async (scope) => {
    const labels = { all: 'all characters and NPCs', characters: 'all characters', npcs: 'all NPCs' };
    if (!window.confirm(`Reset ${labels[scope]} to defaults? Your current game progress for these will be lost.`)) {
      return;
    }
    setResetting(scope);
    setResetDone(null);
    try {
      await api.resetMyData(scope);
      setResetDone(scope);
      setTimeout(() => setResetDone(null), 3000);
    } catch (err) {
      alert('Reset failed: ' + err.message);
    }
    setResetting(null);
  };

  async function saveMultiplayerList(key, list) {
    setSavingMultiplayer(true);
    setMultiplayerSaved(false);
    try {
      await api.updateDmSettings({ [key]: list });
      setMultiplayerSaved(true);
      setTimeout(() => setMultiplayerSaved(false), 3000);
    } catch (err) {
      alert('Failed to save: ' + err.message);
    }
    setSavingMultiplayer(false);
  }

  function handleAddFriend() {
    const email = friendInput.trim().toLowerCase();
    if (!email || friends.includes(email)) { setFriendInput(''); return; }
    const updated = [...friends, email];
    setFriends(updated);
    setFriendInput('');
    saveMultiplayerList('friends', updated);
  }

  function handleRemoveFriend(email) {
    const updated = friends.filter(f => f !== email);
    setFriends(updated);
    saveMultiplayerList('friends', updated);
  }

  function handleAddBlocked() {
    const name = blockedInput.trim();
    if (!name || blocked.includes(name)) { setBlockedInput(''); return; }
    const updated = [...blocked, name];
    setBlocked(updated);
    setBlockedInput('');
    saveMultiplayerList('blocked', updated);
  }

  function handleRemoveBlocked(name) {
    const updated = blocked.filter(b => b !== name);
    setBlocked(updated);
    saveMultiplayerList('blocked', updated);
  }

  return (
    <div>
      <h2>Settings</h2>
      <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 1.5rem' }}>
        Manage your game data and preferences.
      </p>

      <div className="detail-section">
        <h3>Reset My Data</h3>
        <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 1rem' }}>
          Reset your personal character and NPC data to defaults. This will undo any XP, equipment, or stat changes from gameplay. Session history is preserved.
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            onClick={() => handleResetMyData('characters')}
            disabled={resetting !== null}
          >
            {resetting === 'characters' ? 'Resetting...' : 'Reset All Characters'}
          </button>
          <button
            onClick={() => handleResetMyData('npcs')}
            disabled={resetting !== null}
          >
            {resetting === 'npcs' ? 'Resetting...' : 'Reset All NPCs'}
          </button>
          <button
            className="danger"
            onClick={() => handleResetMyData('all')}
            disabled={resetting !== null}
          >
            {resetting === 'all' ? 'Resetting...' : 'Reset Everything'}
          </button>
          {resetDone && <span style={{ color: '#27ae60' }}>Reset complete!</span>}
        </div>
      </div>

      <div className="detail-section">
        <h3>Dice Rolling Mode</h3>
        <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 1rem' }}>
          Realistic mode uses cryptographic randomness for all dice rolls — true uniform distribution including nat 1s and nat 20s.
          When off, the AI generates dice values naturally (tends toward average results, fewer extremes). In other words, uncheck the box for EASY MODE.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="checkbox"
              checked={realisticDice}
              onChange={handleDiceToggle}
              disabled={loadingDice || savingDice}
            />
            Realistic dice (cryptographic RNG)
          </label>
          {loadingDice && <span style={{ color: 'var(--text-muted)' }}>Loading...</span>}
          {savingDice && <span style={{ color: 'var(--text-muted)' }}>Saving...</span>}
          {!savingDice && diceSaved && <span style={{ color: '#27ae60' }}>Saved!</span>}
        </div>
      </div>

      <div className="detail-section">
        <h3>Multiplayer</h3>
        <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 1rem' }}>
          Manage who can join your public sessions. Friends can view and join your public sessions. Blocked players are excluded.
        </p>

        <div style={{ marginBottom: '1.5rem' }}>
          <h4 style={{ fontSize: '0.95rem', marginBottom: '0.5rem' }}>Friends (by email)</h4>
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
            <input
              type="email"
              placeholder="player@example.com"
              value={friendInput}
              onChange={e => setFriendInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAddFriend()}
              style={{ flex: '1 1 200px', minWidth: '200px', padding: '0.4rem 0.6rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-dark)', color: 'var(--text)' }}
            />
            <button onClick={handleAddFriend} disabled={savingMultiplayer}>Add</button>
          </div>
          {friends.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No friends added yet.</p>
          ) : (
            <ul className="multiplayer-list">
              {friends.map(email => (
                <li key={email} className="multiplayer-list-item">
                  <span>{email}</span>
                  <button
                    className="multiplayer-remove-btn"
                    onClick={() => handleRemoveFriend(email)}
                    disabled={savingMultiplayer}
                    title="Remove"
                  >&times;</button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h4 style={{ fontSize: '0.95rem', marginBottom: '0.5rem' }}>Blocked (by player name)</h4>
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
            <input
              type="text"
              placeholder="Player name"
              value={blockedInput}
              onChange={e => setBlockedInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAddBlocked()}
              style={{ flex: '1 1 200px', minWidth: '200px', padding: '0.4rem 0.6rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-dark)', color: 'var(--text)' }}
            />
            <button onClick={handleAddBlocked} disabled={savingMultiplayer}>Add</button>
          </div>
          {blocked.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No players blocked.</p>
          ) : (
            <ul className="multiplayer-list">
              {blocked.map(name => (
                <li key={name} className="multiplayer-list-item">
                  <span>{name}</span>
                  <button
                    className="multiplayer-remove-btn"
                    onClick={() => handleRemoveBlocked(name)}
                    disabled={savingMultiplayer}
                    title="Remove"
                  >&times;</button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div style={{ marginTop: '0.5rem' }}>
          {savingMultiplayer && <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Saving...</span>}
          {!savingMultiplayer && multiplayerSaved && <span style={{ color: '#27ae60', fontSize: '0.85rem' }}>Saved!</span>}
        </div>
      </div>

      {isAdmin && (
        <>
          <div className="detail-section">
            <h3>DM Personality Automation</h3>
            <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 1rem' }}>
              Enable AI shuffle to rotate DM Personality at midnight Pacific time (PDT/PST) every day.
              When enabled, manual edits on the DM Personality page are locked.
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input
                  type="checkbox"
                  checked={shuffleEnabled}
                  onChange={handleShuffleToggle}
                  disabled={loadingShuffle || savingShuffle}
                />
                AI shuffle of DM Personality on 24 hour basis
              </label>
              {loadingShuffle && <span style={{ color: 'var(--text-muted)' }}>Loading...</span>}
              {savingShuffle && <span style={{ color: 'var(--text-muted)' }}>Saving...</span>}
              {!savingShuffle && shuffleSaved && <span style={{ color: '#27ae60' }}>Saved!</span>}
            </div>
          </div>

          <div className="detail-section">
            <h3>Admin: Restore Global Defaults</h3>
            <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 1rem' }}>
              Reset global game data to its original state. This affects the default templates, not individual player data.
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <button onClick={handleRestore} disabled={restoring}>
                {restoring ? 'Restoring...' : 'Restore All to Defaults'}
              </button>
              {restored && <span style={{ color: '#27ae60' }}>Defaults restored!</span>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default Settings;
