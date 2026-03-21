import { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';
import { usePlayer } from '../context/PlayerContext';
import { useCampaign } from '../context/CampaignContext';
import { getAudioSettings, saveAudioSettings, previewSound, SOUND_OPTIONS } from '../utils/audio';
import { getDisplaySettings, saveDisplaySettings } from '../utils/displaySettings';

function Settings() {
  const { player } = usePlayer();
  const { campaignId } = useCampaign();
  const isAdmin = player?.role === 'admin';
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
  const [audio, setAudio] = useState(getAudioSettings);
  const [display, setDisplay] = useState(getDisplaySettings);

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
        <h3>Reset My Data — <em style={{ color: 'var(--gold)' }}>{campaignId}</em> campaign</h3>
        <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 1rem' }}>
          Reset your personal character and NPC data to defaults for the <strong>{campaignId}</strong> campaign.
          This will undo any XP, equipment, or stat changes from gameplay. Session history is preserved.
          To reset a different campaign, select it from the Home page first.
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
        <h3>Display</h3>
        <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 1rem' }}>
          Long DM messages are collapsed by default. Set the line threshold, or 0 to disable collapsing.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            Collapse after
            <input
              type="number"
              min="0"
              max="200"
              value={display.collapseThreshold}
              onChange={e => {
                const val = Math.max(0, Math.min(200, Number(e.target.value) || 0));
                const next = { ...display, collapseThreshold: val };
                setDisplay(next);
                saveDisplaySettings(next);
              }}
              style={{ width: '4rem', padding: '0.3rem 0.5rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-dark)', color: 'var(--text)', textAlign: 'center' }}
            />
            lines
          </label>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            {display.collapseThreshold === 0 ? '(collapsing disabled)' : ''}
          </span>
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

      <div className="detail-section">
        <h3>Audio Notifications</h3>
        <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 1rem' }}>
          Play a sound in multiplayer when the DM responds, a companion acts, or a player joins.
        </p>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="checkbox"
              checked={audio.enabled}
              onChange={e => {
                const next = { ...audio, enabled: e.target.checked };
                setAudio(next);
                saveAudioSettings(next);
                if (e.target.checked) previewSound(next.sound, next.volume);
              }}
            />
            Enable notification sounds
          </label>
        </div>

        {audio.enabled && (
          <>
            <div style={{ marginBottom: '1rem' }}>
              <h4 style={{ fontSize: '0.95rem', marginBottom: '0.5rem' }}>Sound</h4>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {SOUND_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    className={audio.sound === opt.value ? 'active' : ''}
                    style={{
                      padding: '0.4rem 0.8rem',
                      borderRadius: '6px',
                      border: audio.sound === opt.value ? '2px solid var(--accent)' : '1px solid var(--border)',
                      background: audio.sound === opt.value ? 'var(--accent-dim, rgba(99,102,241,0.15))' : 'var(--bg-dark)',
                      color: 'var(--text)',
                      cursor: 'pointer',
                    }}
                    onClick={() => {
                      const next = { ...audio, sound: opt.value };
                      setAudio(next);
                      saveAudioSettings(next);
                      previewSound(opt.value, next.volume);
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="slider-grid">
              <div className="slider-row">
                <div className="slider-label">
                  <span>Volume</span>
                  <span className="slider-value">{audio.volume}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={audio.volume}
                  onChange={e => {
                    const next = { ...audio, volume: Number(e.target.value) };
                    setAudio(next);
                    saveAudioSettings(next);
                  }}
                  onMouseUp={() => previewSound(audio.sound, audio.volume)}
                  onTouchEnd={() => previewSound(audio.sound, audio.volume)}
                />
              </div>
            </div>
          </>
        )}
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

          <BotFarmPanel />
        </>
      )}
    </div>
  );
}

const DELAY_OPTIONS = [
  { value: 30000, label: '30 seconds' },
  { value: 60000, label: '1 minute' },
  { value: 120000, label: '2 minutes' },
  { value: 300000, label: '5 minutes' },
  { value: 900000, label: '15 minutes' },
  { value: 1800000, label: '30 minutes' },
  { value: 3600000, label: '1 hour' },
];

function BotFarmPanel() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [count, setCount] = useState(0);
  const [delay, setDelay] = useState(60000);
  const [maxSessions, setMaxSessions] = useState(1);
  const [cleaning, setCleaning] = useState(false);

  const refreshStatus = useCallback(() => {
    api.getBotStatus()
      .then(data => setStatus(data))
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    // Initial load — seed inputs from server config
    api.getBotStatus()
      .then(data => {
        setStatus(data);
        setCount(data.count);
        setDelay(data.turnDelayMs);
        setMaxSessions(data.maxSessionsPerBot || 1);
      })
      .catch(() => setStatus(null))
      .finally(() => setLoading(false));
    const interval = setInterval(refreshStatus, 10000);
    return () => clearInterval(interval);
  }, [refreshStatus]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const data = await api.updateBotConfig({
        enabled: true,
        count,
        turnDelayMs: delay,
        maxSessionsPerBot: maxSessions,
      });
      setStatus(data);
    } catch (err) {
      alert('Failed to update bot config: ' + err.message);
    }
    setSaving(false);
  };

  const handleStop = async () => {
    setSaving(true);
    try {
      const data = await api.stopBots();
      setStatus(data);
    } catch (err) {
      alert('Failed to stop bots: ' + err.message);
    }
    setSaving(false);
  };

  const handleCleanup = async () => {
    if (!window.confirm('Stop all bots and delete all bot accounts and their data?')) return;
    setCleaning(true);
    try {
      await api.cleanupBots();
      setCount(0);
      setMaxSessions(1);
      refreshStatus();
    } catch (err) {
      alert('Cleanup failed: ' + err.message);
    }
    setCleaning(false);
  };

  if (loading) return <div className="detail-section"><h3>AI Bot Farm</h3><p style={{ color: 'var(--text-muted)' }}>Loading...</p></div>;

  return (
    <div className="detail-section">
      <h3>AI Bot Farm</h3>
      <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 1rem' }}>
        Spawn autonomous AI players that create sessions, join games, and play through the same API as real users.
        Each bot uses Claude Haiku to make in-character decisions. Useful for stress testing and simulating activity.
      </p>

      <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Number of bots</span>
          <input
            type="number"
            min="0"
            max="20"
            value={count}
            onChange={e => setCount(Math.max(0, Math.min(20, Number(e.target.value) || 0)))}
            style={{ width: '5.5rem', padding: '0.5rem 0.7rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-dark)', color: 'var(--text)', textAlign: 'center', fontSize: '1.1rem' }}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Turn delay</span>
          <select
            value={delay}
            onChange={e => setDelay(Number(e.target.value))}
            style={{ padding: '0.4rem 0.6rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-dark)', color: 'var(--text)' }}
          >
            {DELAY_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Max sessions per bot</span>
          <input
            type="number"
            min="1"
            max="5"
            value={maxSessions}
            onChange={e => setMaxSessions(Math.max(1, Math.min(5, Number(e.target.value) || 1)))}
            style={{ width: '5.5rem', padding: '0.5rem 0.7rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-dark)', color: 'var(--text)', textAlign: 'center', fontSize: '1.1rem' }}
          />
        </label>
      </div>

      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '1.5rem' }}>
        <button onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : status?.running ? 'Update & Restart' : 'Start Bots'}
        </button>
        {status?.running && (
          <button onClick={handleStop} disabled={saving} style={{ background: 'var(--bg-tertiary, #555)' }}>
            Stop All
          </button>
        )}
        <button onClick={handleCleanup} disabled={cleaning} className="danger">
          {cleaning ? 'Cleaning...' : 'Cleanup All'}
        </button>
        {status?.running && <span style={{ color: '#27ae60', fontSize: '0.85rem' }}>Running: {status.activeBots} bot{status.activeBots !== 1 ? 's' : ''}</span>}
        {status && !status.running && <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Stopped</span>}
      </div>

      {status?.bots?.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                <th style={{ textAlign: 'left', padding: '0.4rem 0.6rem' }}>Bot</th>
                <th style={{ textAlign: 'left', padding: '0.4rem 0.6rem' }}>Chat</th>
                <th style={{ textAlign: 'left', padding: '0.4rem 0.6rem' }}>Role</th>
                <th style={{ textAlign: 'left', padding: '0.4rem 0.6rem' }}>State</th>
                <th style={{ textAlign: 'left', padding: '0.4rem 0.6rem' }}>Campaign</th>
                <th style={{ textAlign: 'left', padding: '0.4rem 0.6rem' }}>Session</th>
                <th style={{ textAlign: 'left', padding: '0.4rem 0.6rem' }}>Messages</th>
              </tr>
            </thead>
            <tbody>
              {status.bots.map(bot => {
                const sessions = bot.sessions || [];
                if (sessions.length === 0) {
                  return (
                    <tr key={bot.email} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '0.4rem 0.6rem' }}>{bot.name}</td>
                      <td style={{ padding: '0.4rem 0.6rem' }}>{bot.connected ? 'Yes' : 'No'}</td>
                      <td style={{ padding: '0.4rem 0.6rem', color: 'var(--text-muted)' }}>-</td>
                      <td style={{ padding: '0.4rem 0.6rem', color: 'var(--text-muted)' }}>looking</td>
                      <td style={{ padding: '0.4rem 0.6rem', color: 'var(--text-muted)' }}>-</td>
                      <td style={{ padding: '0.4rem 0.6rem', color: 'var(--text-muted)' }}>-</td>
                      <td style={{ padding: '0.4rem 0.6rem' }}>0</td>
                    </tr>
                  );
                }
                return sessions.map((sess, i) => (
                  <tr key={`${bot.email}-${sess.sessionId}`} style={{ borderBottom: '1px solid var(--border)' }}>
                    {i === 0 ? (
                      <td style={{ padding: '0.4rem 0.6rem', verticalAlign: 'top' }} rowSpan={sessions.length}>{bot.name}</td>
                    ) : null}
                    {i === 0 ? (
                      <td style={{ padding: '0.4rem 0.6rem', verticalAlign: 'top' }} rowSpan={sessions.length}>{bot.connected ? 'Yes' : 'No'}</td>
                    ) : null}
                    <td style={{ padding: '0.4rem 0.6rem', color: 'var(--text-muted)', fontSize: '0.8rem' }}>{sess.role}</td>
                    <td style={{ padding: '0.4rem 0.6rem' }}>
                      <span style={{
                        padding: '0.1rem 0.4rem',
                        borderRadius: '4px',
                        fontSize: '0.8rem',
                        background: sess.state === 'playing' ? 'rgba(39,174,96,0.2)' : sess.state === 'waiting_for_dm' ? 'rgba(52,152,219,0.2)' : sess.state === 'thinking' ? 'rgba(241,196,15,0.2)' : 'rgba(127,127,127,0.2)',
                        color: sess.state === 'playing' ? '#27ae60' : sess.state === 'waiting_for_dm' ? '#3498db' : sess.state === 'thinking' ? '#f1c40f' : 'var(--text-muted)',
                      }}>
                        {sess.state}
                      </span>
                    </td>
                    <td style={{ padding: '0.4rem 0.6rem', color: 'var(--text-muted)' }}>{sess.campaignId || '-'}</td>
                    <td style={{ padding: '0.4rem 0.6rem', color: 'var(--text-muted)' }}>{sess.sessionLabel || sess.sessionId?.slice(0, 8) + '...'}</td>
                    <td style={{ padding: '0.4rem 0.6rem' }}>{sess.messageCount || 0}</td>
                  </tr>
                ));
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default Settings;
