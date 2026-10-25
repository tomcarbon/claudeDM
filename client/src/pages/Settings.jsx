import { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';
import { usePlayer } from '../context/PlayerContext';
import { useCampaign } from '../context/CampaignContext';
import { getAudioSettings, saveAudioSettings, previewSound, SOUND_OPTIONS } from '../utils/audio';
import { getDisplaySettings, saveDisplaySettings } from '../utils/displaySettings';
import { paletteForCampaign } from '../data/campaignPalettes';

// The GM models an admin can choose (updated 2026-10-21, WO-0044). Blank sends no model, so the
// Claude Agent SDK uses Claude Code's own default — which depends on the install, not on this app.
const GM_MODELS = [
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 — Fast, lightweight' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 — Balanced' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5 — Most capable' },
];

function Settings() {
  const { player } = usePlayer();
  const { campaignId } = useCampaign();
  const isAdmin = player?.role === 'admin';
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
  const [dmModel, setDmModel] = useState('');
  const [savingModel, setSavingModel] = useState(false);
  const [modelSaved, setModelSaved] = useState(false);

  useEffect(() => {
    if (isAdmin) {
      api.getGlobalDmSettings()
        .then((settings) => {
          setDmModel(settings?.model || '');
        })
        .catch(() => {});
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
          Reset all characters to their original defaults for the <strong>{campaignId}</strong> campaign.
          This undoes any XP, equipment, or stat changes from gameplay. Session history is preserved.
          To reset a different campaign, select it from the Home page first.
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
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
          Long GM messages are collapsed by default. Set the line threshold, or 0 to disable collapsing.
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

        {/* Appearance (WO-0037 §5). This setting is stored in localStorage by
            utils/displaySettings.js and is NEVER SENT TO THE SERVER. That is not laziness: it
            means no route, no per-player file, nothing added to the open personal-data gate, and
            no path by which an appearance choice could ever reach the GM's prompt. Keep it that
            way. */}
        <h4 style={{ fontSize: '0.95rem', margin: '1.5rem 0 0.25rem' }}>Appearance</h4>
        <p style={{ color: 'var(--text-muted)', margin: '0.25rem 0 0.75rem', fontSize: '0.9rem' }}>
          Some campaigns have their own colours, and eight scene moods you can switch between from
          the game screen. Changing the colour never changes a rule, a dice roll, or anything the
          Game Master knows &mdash; and it never moves the colours that mean something, like
          damage, healing or spell schools.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          {[
            ['campaign+moods', 'Campaign colours + scene shifts', 'The campaign\u2019s colours, and the page may change colour when the scene changes.'],
            ['campaign', 'Campaign colours only', 'The campaign\u2019s colours, held still. You can still change the scene yourself from the game screen.'],
            ['classic', 'Classic (one palette)', 'The single colour scheme the app ships with, for every campaign.'],
          ].map(([value, label, help]) => (
            <label key={value} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
              <input
                type="radio"
                name="appearance"
                value={value}
                checked={display.appearance === value}
                onChange={() => {
                  const next = { ...display, appearance: value };
                  setDisplay(next);
                  saveDisplaySettings(next);
                }}
                style={{ marginTop: '0.25rem' }}
              />
              <span>
                {label}
                <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: '0.85rem' }}>{help}</span>
              </span>
            </label>
          ))}
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.9rem' }}>
          <input
            type="checkbox"
            checked={display.freezeLighting}
            onChange={e => {
              const next = { ...display, freezeLighting: e.target.checked };
              setDisplay(next);
              saveDisplaySettings(next);
            }}
          />
          Freeze lighting (this device only)
        </label>
        <p style={{ color: 'var(--text-muted)', margin: '0.35rem 0 0', fontSize: '0.85rem' }}>
          The same switch as the one in the game header, which is where you will want it during
          play. Freezing affects only your own screen &mdash; nobody else at the table is changed
          by it &mdash; and it survives a reload.
          {!paletteForCampaign(campaignId) && (
            <>{' '}This campaign does not have its own colours, so these settings will not change
            anything until you play one that does.</>
          )}
        </p>
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
          Play a sound in multiplayer when the GM responds, a companion acts, or a player joins.
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
            <h3>GM Model</h3>
            <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 1rem' }}>
              Choose the Claude model that powers the Game Master. Higher tiers are more creative and capable but slower and more expensive.
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
              <select
                value={dmModel}
                onChange={async (e) => {
                  const val = e.target.value;
                  setDmModel(val);
                  setSavingModel(true);
                  setModelSaved(false);
                  try {
                    await api.updateGlobalDmSettings({ model: val });
                    setModelSaved(true);
                    setTimeout(() => setModelSaved(false), 3000);
                  } catch (err) {
                    alert('Failed to update model: ' + err.message);
                  }
                  setSavingModel(false);
                }}
                disabled={savingModel}
                style={{ padding: '0.5rem 0.7rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-dark)', color: 'var(--text)', fontSize: '1rem' }}
              >
                <option value="">Default — Claude Code's default model</option>
                {GM_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                {/* A model saved before this list changed still shows, rather than reading as Default. */}
                {dmModel && !GM_MODELS.some(m => m.id === dmModel) && (
                  <option value={dmModel}>{dmModel} (no longer listed)</option>
                )}
              </select>
              {savingModel && <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Saving...</span>}
              {!savingModel && modelSaved && <span style={{ color: '#27ae60', fontSize: '0.85rem' }}>Saved!</span>}
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '0.5rem' }}>
              Takes effect on the next GM turn. Active sessions will use the new model on their next response.
            </p>
          </div>

        </>
      )}

      <BotFarmPanel isAdmin={isAdmin} />
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

function formatDelay(ms) {
  if (ms >= 3600000) return `${ms / 3600000}h`;
  if (ms >= 60000) return `${ms / 60000}m`;
  return `${ms / 1000}s`;
}

/**
 * The bot farm panel (WO-0019, WO-0036 item 9 / J6).
 *
 * Three things this component has to get right, all of them lessons from the chair losing an
 * evening:
 *
 *   1. **When the subsystem is not mounted, say so and say the remedy.** `botsAllowed()`
 *      (`server/index.js:180`) requires `CLAUDEDM_BOTS=1`, and without it `/api/bots` does not
 *      exist. This panel renders for every player regardless, so the Add button used to POST to
 *      a route that was not there and report a bare `"Not Found"`. The chair hit that twice and
 *      asked the CEO both times. The 404 on `GET /api/bots/status` is the signal; no new
 *      endpoint is needed. **The panel is not hidden** — an admin who was told the feature
 *      exists and finds nothing is no better off than one who gets "Not Found".
 *   2. **Name the brain that is actually live, read back from the server.** Every brain field
 *      here comes from `GET /api/bots/status`, which serves `bot.brainName` — what the registry
 *      *built*, not what anything requested. The chair's second lost hour was a silent
 *      wrong-brain: both environment switches set correctly and canned text on screen anyway,
 *      with no log line. A panel that echoed the request would have shown the same lie.
 *   3. **Never claim the bots are free.** The sentence here used to read *"Bots use randomized
 *      canned actions — no AI calls per turn"*. That was true of every configuration reachable
 *      before 2026-10-02 and is false now: the default brain is a model. Ethics condition B5
 *      binds that rewrite to the change that makes it false, and asks that the replacement say
 *      what makes the new sentence true. It is rewritten below, in this change.
 */
function BotFarmPanel({ isAdmin = false }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  // null = fine; 404 = the router is not mounted; anything else = a real failure we should not
  // dress up as a configuration problem.
  const [statusCode, setStatusCode] = useState(null);
  const [adding, setAdding] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [removing, setRemoving] = useState(null); // botEmail while in flight
  const [actionError, setActionError] = useState(null);
  const [actionNote, setActionNote] = useState(null);
  // Add-bot form state. Defaults are the shape the chair asked for: one host, then companions.
  const [addRole, setAddRole] = useState('host');
  const [addCount, setAddCount] = useState(1);
  const [addDelay, setAddDelay] = useState(60000);

  const refreshStatus = useCallback(() => {
    api.getBotStatus()
      .then(data => { setStatus(data); setStatusCode(null); })
      .catch(err => { setStatus(null); setStatusCode(err?.status || 0); });
  }, []);

  useEffect(() => {
    api.getBotStatus()
      .then(data => { setStatus(data); setStatusCode(null); })
      .catch(err => { setStatus(null); setStatusCode(err?.status || 0); })
      .finally(() => setLoading(false));
    const interval = setInterval(refreshStatus, 10000);
    return () => clearInterval(interval);
  }, [refreshStatus]);

  const shape = status?.shape;
  // The remaining room for the selected role, so the Count input cannot offer a number the
  // server is about to refuse. The server refuses anyway — this is courtesy, not the control.
  const roomForRole = shape
    ? (addRole === 'host'
      ? Math.max(0, (shape.maxHostBots ?? 1) - (shape.hostBots ?? 0))
      : Math.max(0, (shape.maxCompanionBots ?? 6) - (shape.companionBots ?? 0)))
    : 1;

  const handleAdd = async () => {
    setAdding(true);
    setActionError(null);
    setActionNote(null);
    try {
      const data = await api.addBots({
        role: addRole,
        count: addCount,
        turnDelayMs: addDelay,
        maxSessionsPerBot: 1,
      });
      setStatus(data);
      setStatusCode(null);
    } catch (err) {
      // Inline and specific, not an alert() saying "Not Found". A 404 here means the router is
      // not mounted after all, which is the one case where the remedy is a server restart.
      setActionError(err?.status === 404
        ? 'The bot endpoints are not mounted on this server. Restart it with CLAUDEDM_BOTS=1.'
        : (err?.message || 'Failed to add bots.'));
    }
    setAdding(false);
  };

  const handleRemoveBot = async (botEmail, botName) => {
    if (!window.confirm(`Delete bot "${botName}" and all its data? Active sessions hosted by this bot will end, companion bots in those sessions will be disconnected, and the session directories this bot owned will be deleted — unless a human is in one, in which case it is kept.`)) return;
    setRemoving(botEmail);
    setActionError(null);
    setActionNote(null);
    try {
      const data = await api.removeBot(botEmail);
      setStatus(data);
      // J5: print what was deleted AND what was not, where the person who clicked can read it.
      //
      // ── THE FALSE SENTENCE, AND WHY IT WAS FALSE (S-3 / qc-tester item 7) ─────────────────
      //
      // `removeBot` used to return only the sessions kept *because a human was in them*, so a
      // session kept for `no readable session.json`, `symlink`, a path refusal or — the one that
      // matters most — `delete failed: <errno>` produced an empty `keptSessions`, and this code
      // then printed **"No session directories were owned by that bot."** about a directory that
      // was owned by that bot and was still on disk. `qc-tester` reproduced that exact string.
      //
      // The route now returns every kept session with its reason, and `keptHumanSessions` as its
      // own field. So the two sentences are separated: the reassuring one ("kept, a human is in
      // it") and the one an operator has to act on ("kept, and here is why").
      const gone = data?.deletedSessions || [];
      const kept = data?.keptSessions || [];
      const keptHuman = data?.keptHumanSessions || [];
      const keptOther = kept.filter(k => !keptHuman.some(h => h.sessionId === k.sessionId));
      const parts = [];
      if (gone.length) parts.push(`Deleted ${gone.length} session director${gone.length === 1 ? 'y' : 'ies'}: ${gone.join(', ')}.`);
      if (keptHuman.length) parts.push(`Kept ${keptHuman.length} with a human in it.`);
      if (keptOther.length) {
        parts.push(`Kept ${keptOther.length} that could NOT be removed: `
          + keptOther.map(k => `${k.sessionId} (${k.reason})`).join('; ') + '.');
      }
      if (!gone.length && !kept.length) parts.push('No session directories were owned by that bot.');
      setActionNote(parts.join(' '));
    } catch (err) {
      setActionError(err?.message || 'Remove failed.');
      refreshStatus();
    }
    setRemoving(null);
  };

  const handleStop = async () => {
    setStopping(true);
    setActionError(null);
    try {
      const data = await api.stopBots();
      setStatus(data);
    } catch (err) {
      setActionError(err?.message || 'Failed to stop bots.');
    }
    setStopping(false);
  };

  const handleCleanup = async () => {
    if (!window.confirm('Stop all bots, delete all bot accounts and their data, and delete the session directories those bots owned? Sessions with a human participant are kept.')) return;
    setCleaning(true);
    setActionError(null);
    setActionNote(null);
    try {
      const result = await api.cleanupBots();
      const gone = result?.deletedSessions || [];
      const allKept = result?.keptSessions || [];
      const keptHuman = allKept.filter(k => k.reason === 'a human is in this session');
      // SR-36-2. Orphans — bot-owned sessions whose owning account is already gone — are kept by
      // condition 3, which is correct and is not being widened. But the chair has two of them
      // and was told, wrongly, that `Cleanup All` would remove them. Naming them here is the
      // listing half of the adopt-orphans action that was deliberately NOT built: the chair gets
      // the list and the deletion stays theirs to make.
      const keptOrphans = allKept.filter(k => /^ORPHAN:/.test(k.reason || ''));
      const parts = [`Deleted ${result?.deletedAccounts ?? 0} bot account(s).`];
      parts.push(gone.length
        ? `Deleted ${gone.length} session director${gone.length === 1 ? 'y' : 'ies'}: ${gone.join(', ')}.`
        : 'Deleted no session directories.');
      if (keptHuman.length) parts.push(`Kept ${keptHuman.length} with a human in it.`);
      if (keptOrphans.length) {
        parts.push(`${keptOrphans.length} orphaned bot session${keptOrphans.length === 1 ? '' : 's'} `
          + `${keptOrphans.length === 1 ? 'is' : 'are'} out of reach of cleanup — its owning bot `
          + 'account no longer exists, so nothing authorises deleting it: '
          + keptOrphans.map(k => k.sessionId).join(', ') + '. Delete these yourself if you want them gone.');
      }
      setActionNote(parts.join(' '));
      refreshStatus();
    } catch (err) {
      setActionError(err?.message || 'Cleanup failed.');
    }
    setCleaning(false);
  };

  if (loading) return <div className="detail-section"><h3>AI Bot Farm</h3><p style={{ color: 'var(--text-muted)' }}>Loading...</p></div>;

  const inputStyle = { padding: '0.5rem 0.7rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-dark)', color: 'var(--text)' };
  const noteStyle = { color: 'var(--text-muted)', fontSize: '0.85rem', margin: '0.4rem 0 0' };

  // ── 1. the subsystem is not mounted (item 9 / J6) ─────────────────────────────────────────
  //
  // A 404 on the status endpoint means `botsAllowed()` was false when the app was built, so the
  // router was never mounted. The controls are replaced by the actual remedy — for an admin,
  // including the command; a non-admin does not need to be told how to change the chair's
  // startup line, only that the feature is off and who can turn it on.
  if (statusCode === 404) {
    return (
      <div className="detail-section">
        <h3>AI Bot Farm</h3>
        {isAdmin ? (
          <>
            <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0' }}>
              <strong style={{ color: '#f1c40f' }}>Not enabled on this server.</strong> The bot
              endpoints are not mounted, so there is nothing here to control. This is the gate
              working, not a fault.
            </p>
            <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0' }}>
              To turn it on, start the server with:
            </p>
            <pre style={{ background: 'var(--bg-dark)', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.6rem 0.8rem', overflowX: 'auto', fontSize: '0.9rem' }}>
              CLAUDEDM_BOTS=1 npm run dev
            </pre>
            <p style={noteStyle}>
              <strong>It takes a restart.</strong> The gate is evaluated once, when the app is
              built, so setting the variable in a running server has no effect. Bots are also
              refused outright when <code>NODE_ENV=production</code>.
            </p>
            <p style={noteStyle}>
              That one variable is all that is needed. Player agents think with a model by
              default (Haiku), so there is no second switch and no file to hand-edit — which
              was the trap this panel used to leave you in.
            </p>
          </>
        ) : (
          <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0' }}>
            Bot players are not enabled on this server. An administrator can turn them on, and it
            takes a server restart.
          </p>
        )}
      </div>
    );
  }

  // ── 2. the status endpoint failed for some other reason ──────────────────────────────────
  if (statusCode !== null) {
    return (
      <div className="detail-section">
        <h3>AI Bot Farm</h3>
        <p style={{ color: '#e74c3c', margin: '0.5rem 0' }}>
          Could not read bot status{statusCode ? ` (HTTP ${statusCode})` : ''}. This is not the
          "not enabled" case — the endpoint answered, or the request never arrived.
        </p>
      </div>
    );
  }

  // ── 3. mounted. Name the live brain, the ceilings and the meter ──────────────────────────
  //
  // `liveBrains` is the distinct set of brains actually built across the farm, straight from
  // the server. Empty means no bots exist yet, in which case the panel states the default the
  // next bot will get instead of implying something is running.
  const liveBrains = status?.brain || [];
  const thinking = liveBrains.includes('model');
  const canned = liveBrains.includes('rules');
  // `ceilingHit` means THE FARM STOPPED, and only the farm-wide brain-call ceiling can set it.
  // The one-hour limit is PER SESSION and reports separately — see `expiredSessions` below and
  // `_recordSessionExpiry` in bot-orchestrator.js for why they are not the same flag.
  const ceiling = status?.ceilingHit;
  const expiredSessions = status?.expiredSessions || 0;
  const minutes = (ms) => Math.round((ms || 0) / 60000);

  return (
    <div className="detail-section">
      <h3>AI Bot Farm</h3>

      {/* Ethics B5: the replacement for "no AI calls per turn", and it says what makes it true. */}
      <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 1rem' }}>
        Autonomous player agents that create sessions, join games and submit turns through the
        same API as real users. <strong>Each turn is a real model call and costs money</strong> —
        one call per bot per turn, billed to this server's account. The Game Master is
        unaffected and keeps whatever model you selected above; only the players run on the
        model named below.
      </p>

      {/* Which brain is live — read back from the server, never from what was requested. */}
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '0.75rem' }}>
        {status?.running && <span style={{ color: '#27ae60', fontSize: '0.85rem' }}>Running: {status.activeBots} bot{status.activeBots !== 1 ? 's' : ''}</span>}
        {status && !status.running && status.activeBots === 0 && <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No bots</span>}
        {status && !status.running && status.activeBots > 0 && <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Stopped ({status.activeBots} bot{status.activeBots !== 1 ? 's' : ''} idle)</span>}

        {liveBrains.length === 0 && (
          <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            Brain: none running — the next bot will think with <code>{status?.brainModel || 'the default model'}</code>
          </span>
        )}
        {thinking && (
          <span style={{ fontSize: '0.85rem', color: '#27ae60' }}>
            Brain: model (live) — <code>{status?.brainModel}</code>
          </span>
        )}
        {canned && (
          <span style={{ fontSize: '0.85rem', color: '#f1c40f' }}>
            Brain: <strong>rules</strong> — these bots emit canned text, not model output. That
            is the test fixture, and you should not normally see it. It is reachable only by an
            explicit <code>"brain": "rules"</code> entry in <code>data/bot-config.json</code>, or
            by the <code>CLAUDEDM_BOT_BRAIN</code> environment variable being set to the value
            <em>rules</em>. Remove whichever is set and restart to get model-driven players.
          </span>
        )}
      </div>

      {/* The shape and the ceilings, stated as numbers — DoD 1, DoD 4, item 10. */}
      {shape && (
        <p style={noteStyle}>
          Shape: {shape.hostBots}/{shape.maxHostBots} host, {shape.companionBots}/{shape.maxCompanionBots} companions,
          {' '}{shape.games}/{shape.maxConcurrentGames} game. Ceilings: {status.brainCalls}/{status.maxBrainCalls} bot-brain
          calls this run, {minutes(status.sessionMaxDurationMs)} min per session.
          {status.brainSkips > 0 && (
            <> {' '}<span style={{ color: '#f1c40f' }}>
              {status.brainSkips} turn{status.brainSkips === 1 ? '' : 's'} skipped
              {status.lastSkipReason ? ` (last: ${status.lastSkipReason})` : ''} — a brain that
              could not answer says nothing rather than something canned.
            </span></>
          )}
        </p>
      )}

      {/* The farm-wide ceiling. The remedy names the key that governs the ceiling that actually
          tripped, rather than always `maxBrainCalls` — which was right for the only value
          `ceilingHit` could hold and wrong the moment anything else could hold it
          (`qc-tester` item 8). */}
      {ceiling && (
        <p style={{ color: '#e74c3c', fontSize: '0.85rem', margin: '0.5rem 0' }}>
          <strong>Ceiling reached: {ceiling}.</strong> The bots will take no further turns. Raise
          the limit in <code>data/bot-config.json</code>
          {' '}(<code>{ceiling === 'brain-call ceiling' ? 'maxBrainCalls' : 'sessionMaxDurationMs'}</code>)
          {' '}and restart to continue.
        </p>
      )}

      {/* The per-session duration ceiling — the chair's "default session time 1 hour".
          `qc-tester` measured that revision 1 had no banner for this at all, because the
          duration branch never set `ceilingHit`. It still does not, on purpose: `ceilingHit`
          stops the WHOLE farm, and one session ageing out must not end a game that started five
          minutes ago. This is its own line instead, of the same loudness. */}
      {expiredSessions > 0 && (
        <p style={{ color: '#e74c3c', fontSize: '0.85rem', margin: '0.5rem 0' }}>
          <strong>
            Session duration ceiling reached: {expiredSessions} session{expiredSessions === 1 ? '' : 's'}
            {' '}past {minutes(status.sessionMaxDurationMs)} min.
          </strong>
          {' '}Those sessions are parked and their bots take no further turns in them; the rest of
          the farm is unaffected. Raise <code>sessionMaxDurationMs</code> in
          {' '}<code>data/bot-config.json</code> and restart, or remove the bot with
          {' '}<code>×</code> and add a fresh one.
        </p>
      )}

      {actionError && (
        <p style={{ color: '#e74c3c', fontSize: '0.85rem', margin: '0.5rem 0' }}>{actionError}</p>
      )}
      {actionNote && (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: '0.5rem 0' }}>{actionNote}</p>
      )}

      {isAdmin && (
        <>
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end', margin: '1rem 0' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Type</span>
              <select
                value={addRole}
                onChange={e => { setAddRole(e.target.value); setAddCount(1); }}
                style={{ ...inputStyle, minWidth: '7rem' }}
              >
                {/* No "Either": a bot that may decide to host is how six companions become six
                    separate games, which is the economic argument this whole feature rests on. */}
                <option value="host">Host</option>
                <option value="companion">Companion</option>
              </select>
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Count</span>
              <input
                type="number"
                min="1"
                max={Math.max(1, roomForRole)}
                value={addCount}
                onChange={e => setAddCount(Math.max(1, Math.min(Math.max(1, roomForRole), Number(e.target.value) || 1)))}
                style={{ ...inputStyle, width: '4.5rem', textAlign: 'center', fontSize: '1.1rem' }}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Turn delay</span>
              <select
                value={addDelay}
                onChange={e => setAddDelay(Number(e.target.value))}
                style={inputStyle}
              >
                {DELAY_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </label>

            <button onClick={handleAdd} disabled={adding || roomForRole <= 0} style={{ alignSelf: 'flex-end' }}>
              {adding ? 'Adding...' : 'Add'}
            </button>
            {roomForRole <= 0 && (
              <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', alignSelf: 'flex-end', paddingBottom: '0.5rem' }}>
                {addRole === 'host' ? 'A host already exists — one host runs one game.' : 'Six companions is the limit.'}
              </span>
            )}
          </div>

          <p style={noteStyle}>
            One session per bot, one game at a time. Start with one host and one or two
            companions and watch the call count above.
          </p>

          {status?.activeBots > 0 && (
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center', margin: '1rem 0 1.5rem' }}>
              {status?.running && (
                <button onClick={handleStop} disabled={stopping} style={{ background: 'var(--bg-tertiary, #555)' }}>
                  {stopping ? 'Stopping...' : 'Stop All'}
                </button>
              )}
              <button onClick={handleCleanup} disabled={cleaning} className="danger">
                {cleaning ? 'Cleaning...' : 'Cleanup All'}
              </button>
            </div>
          )}
        </>
      )}

      {/* `Array.isArray`, not `?.length > 0` — found by the panel's own render test on revision
          2. A `bots` that is a non-array with a truthy `length` (a string, for instance) passed
          the old guard and then threw `status.bots.map is not a function`, which is the
          **broken Settings page** §9.1 of revision 1 was worried about. The server cannot
          currently produce that payload; a panel that throws on a payload the server cannot
          produce is a latent crash, not a non-issue, because the thing that changes is the
          server. Same reasoning for `sessions` below. */}
      {Array.isArray(status?.bots) && status.bots.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                <th style={{ textAlign: 'left', padding: '0.4rem 0.6rem' }}>Bot</th>
                <th style={{ textAlign: 'left', padding: '0.4rem 0.6rem' }}>Type</th>
                <th style={{ textAlign: 'left', padding: '0.4rem 0.6rem' }}>Brain</th>
                <th style={{ textAlign: 'left', padding: '0.4rem 0.6rem' }}>Calls</th>
                <th style={{ textAlign: 'left', padding: '0.4rem 0.6rem' }}>Skips</th>
                <th style={{ textAlign: 'left', padding: '0.4rem 0.6rem' }}>Delay</th>
                <th style={{ textAlign: 'left', padding: '0.4rem 0.6rem' }}>Role</th>
                <th style={{ textAlign: 'left', padding: '0.4rem 0.6rem' }}>State</th>
                <th style={{ textAlign: 'left', padding: '0.4rem 0.6rem' }}>Campaign</th>
                <th style={{ textAlign: 'left', padding: '0.4rem 0.6rem' }}>Session</th>
                <th style={{ textAlign: 'left', padding: '0.4rem 0.6rem' }}>Msgs</th>
                {isAdmin && <th style={{ padding: '0.4rem 0.3rem', width: '1.5rem' }}></th>}
              </tr>
            </thead>
            <tbody>
              {status.bots.map(bot => {
                const sessions = Array.isArray(bot.sessions) ? bot.sessions : [];
                const rowCount = Math.max(sessions.length, 1);
                const isRemoving = removing === bot.email;
                const mutedCell = { padding: '0.4rem 0.6rem', color: 'var(--text-muted)', fontSize: '0.8rem' };
                const topCell = { ...mutedCell, verticalAlign: 'top' };

                // The brain cell is the per-bot half of J6, and it is read from `bot.brain`,
                // which the server sets from what it built. `rules` is called out in amber
                // because that bot is emitting canned text and the chair asked never to see it.
                const brainCell = (
                  <span style={{ color: bot.brain === 'model' ? '#27ae60' : '#f1c40f' }}>
                    {bot.brain === 'model' ? (bot.brainModel || 'model') : bot.brain}
                  </span>
                );

                const xButton = isAdmin ? (
                  <td
                    style={{ padding: '0.2rem 0.3rem', verticalAlign: 'top', textAlign: 'center' }}
                    rowSpan={rowCount}
                  >
                    <button
                      onClick={() => handleRemoveBot(bot.email, bot.name)}
                      disabled={isRemoving}
                      title={`Delete ${bot.name}`}
                      style={{
                        padding: '0',
                        width: '1.4rem',
                        height: '1.4rem',
                        lineHeight: '1.4rem',
                        fontSize: '0.9rem',
                        background: 'transparent',
                        border: 'none',
                        color: isRemoving ? 'var(--text-muted)' : '#e74c3c',
                        cursor: isRemoving ? 'default' : 'pointer',
                        borderRadius: '3px',
                        opacity: isRemoving ? 0.4 : 0.6,
                      }}
                      onMouseEnter={e => { if (!isRemoving) e.target.style.opacity = '1'; }}
                      onMouseLeave={e => { if (!isRemoving) e.target.style.opacity = '0.6'; }}
                    >
                      {isRemoving ? '...' : '×'}
                    </button>
                  </td>
                ) : null;

                if (sessions.length === 0) {
                  return (
                    <tr key={bot.email} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '0.4rem 0.6rem' }}>{bot.name}</td>
                      <td style={mutedCell}>{bot.botRole || 'companion'}</td>
                      <td style={{ padding: '0.4rem 0.6rem', fontSize: '0.8rem' }}>{brainCell}</td>
                      <td style={mutedCell}>{bot.brainCalls || 0}</td>
                      <td style={mutedCell}>{bot.brainSkips || 0}</td>
                      <td style={mutedCell}>{formatDelay(bot.turnDelayMs)}</td>
                      <td style={{ padding: '0.4rem 0.6rem', color: 'var(--text-muted)' }}>-</td>
                      <td style={{ padding: '0.4rem 0.6rem', color: 'var(--text-muted)' }}>looking</td>
                      <td style={{ padding: '0.4rem 0.6rem', color: 'var(--text-muted)' }}>-</td>
                      <td style={{ padding: '0.4rem 0.6rem', color: 'var(--text-muted)' }}>-</td>
                      <td style={{ padding: '0.4rem 0.6rem' }}>0</td>
                      {xButton}
                    </tr>
                  );
                }
                return sessions.map((sess, i) => (
                  <tr key={`${bot.email}-${sess.sessionId}`} style={{ borderBottom: '1px solid var(--border)' }}>
                    {i === 0 && <td style={{ padding: '0.4rem 0.6rem', verticalAlign: 'top' }} rowSpan={rowCount}>{bot.name}</td>}
                    {i === 0 && <td style={topCell} rowSpan={rowCount}>{bot.botRole || 'companion'}</td>}
                    {i === 0 && <td style={{ padding: '0.4rem 0.6rem', verticalAlign: 'top', fontSize: '0.8rem' }} rowSpan={rowCount}>{brainCell}</td>}
                    {i === 0 && <td style={topCell} rowSpan={rowCount}>{bot.brainCalls || 0}</td>}
                    {i === 0 && <td style={topCell} rowSpan={rowCount}>{bot.brainSkips || 0}</td>}
                    {i === 0 && <td style={topCell} rowSpan={rowCount}>{formatDelay(bot.turnDelayMs)}</td>}
                    <td style={mutedCell}>{sess.role}</td>
                    <td style={{ padding: '0.4rem 0.6rem' }}>
                      <span style={{
                        padding: '0.1rem 0.4rem',
                        borderRadius: '4px',
                        fontSize: '0.8rem',
                        background: sess.state === 'playing' ? 'rgba(39,174,96,0.2)' : sess.state === 'waiting_for_dm' ? 'rgba(52,152,219,0.2)' : sess.state === 'thinking' ? 'rgba(241,196,15,0.2)' : sess.state === 'expired' ? 'rgba(231,76,60,0.2)' : 'rgba(127,127,127,0.2)',
                        color: sess.state === 'playing' ? '#27ae60' : sess.state === 'waiting_for_dm' ? '#3498db' : sess.state === 'thinking' ? '#f1c40f' : sess.state === 'expired' ? '#e74c3c' : 'var(--text-muted)',
                      }}>
                        {sess.state}
                      </span>
                    </td>
                    <td style={{ padding: '0.4rem 0.6rem', color: 'var(--text-muted)' }}>{sess.campaignId || '-'}</td>
                    <td style={{ padding: '0.4rem 0.6rem', color: 'var(--text-muted)' }}>
                      {sess.sessionLabel || sess.sessionId?.slice(0, 8) + '...'}
                      {sess.ageMs !== undefined && <span style={{ fontSize: '0.75rem' }}> ({minutes(sess.ageMs)}m)</span>}
                    </td>
                    <td style={{ padding: '0.4rem 0.6rem' }}>{sess.messageCount || 0}</td>
                    {i === 0 && xButton}
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

// ── WHY THIS IS EXPORTED (WO-0036 revision 2) ────────────────────────────────────────────────
//
// `BotFarmPanel` is 458 lines and was the largest untested surface in this stream. Revision 1 of
// the deliverable said it *"has no automated test and cannot have one in this repo — no jsdom
// environment"*, the Security Reviewer's §5 repeated it, and `sdet` escalated a jsdom dependency
// request to VP Technology on the strength of it.
//
// **All three of us were wrong, and `qc-tester` proved it by doing the thing.** You do not need a
// DOM to render React; you need `react-dom/server`, which is already here (React 19.2.4).
// `renderToStaticMarkup` renders with no DOM at all. The only real obstacle is that this
// component's state arrives through `useEffect`, which the server renderer skips — and that is
// solved by supplying the hooks, not the DOM. `qc-tester` rendered these exact 458 lines in 22
// states with zero throws. `sdet` has retracted the dependency request in writing.
//
// The ONE thing that stood between that exercise and a real test in the suite was that this
// component was not exported. So it is exported, named, and the panel is now covered by
// `__tests__/bot-farm-panel.test.js` with **zero new dependencies**. `Settings` remains the
// default export and nothing about its rendering changes.
//
// The limit, stated so the next person does not over-read the coverage: a server render cannot
// reach INTERACTION — `window.confirm` on the `×`, the Add form clamping as you type, the 10s
// poll, the disabled-while-in-flight transitions, and the message assembly in `handleRemoveBot`
// and `handleCleanup`. Those need a DOM, they are where the next defect will be, and the honest
// request for `jsdom` + `@testing-library/react` is a list of those behaviours — not the
// observation that two packages are missing.
export { BotFarmPanel };
