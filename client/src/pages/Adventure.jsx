import { useState, useEffect, useRef } from 'react';
import { api } from '../api/client';
import { usePlayer } from '../context/PlayerContext';
import RichText from '../components/RichText';

const STATUS_CONFIG = {
  idle: { label: 'Ready', className: 'status-idle' },
  thinking: { label: 'DM is thinking...', className: 'status-thinking' },
  awaiting_permission: { label: 'Awaiting approval', className: 'status-permission' },
  disconnected: { label: 'Disconnected', className: 'status-disconnected' },
  error: { label: 'Error', className: 'status-error' },
};

function normalizeSavedMessages(rawMessages) {
  if (!Array.isArray(rawMessages)) return [];

  return rawMessages.map((entry) => {
    if (typeof entry === 'string') {
      return { type: 'system', text: entry };
    }
    if (!entry || typeof entry !== 'object') return null;

    const inferredType = entry.type
      || (entry.role === 'user' || entry.role === 'player' ? 'player'
        : entry.role === 'assistant' || entry.role === 'dm' ? 'dm'
          : entry.role === 'system' ? 'system'
            : null);

    const text = typeof entry.text === 'string'
      ? entry.text
      : (typeof entry.content === 'string'
        ? entry.content
        : (typeof entry.message === 'string' ? entry.message : ''));

    if (!text) return null;

    return {
      type: ['system', 'player', 'dm', 'dm_partial'].includes(inferredType) ? inferredType : 'system',
      text,
    };
  }).filter(Boolean);
}

function formatSavedSessionDate(timestamp) {
  if (!timestamp) return 'Unknown date';
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return 'Unknown date';
  return parsed.toLocaleDateString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatSavedSessionTime(timestamp) {
  if (!timestamp) return '';
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function Adventure({
  ws,
  sessionActive,
  setSessionActive,
  selectedCharacter,
  setSelectedCharacter,
  selectedScenario,
  setSelectedScenario,
  savedSessionDbId,
  setSavedSessionDbId,
}) {
  const {
    messages,
    setMessages,
    status,
    sessionId,
    permissionRequest,
    sendMessage,
    startSession,
    sendPermission,
    resumeSession,
    watchSession,
    sessionAccess,
  } = ws;
  const { player } = usePlayer();
  const [input, setInput] = useState('');
  const [characters, setCharacters] = useState([]);
  const [scenarios, setScenarios] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [mode, setMode] = useState('scenarios'); // 'scenarios' | 'campaigns'
  const [selectedCampaign, setSelectedCampaign] = useState(null);
  const [savedSessions, setSavedSessions] = useState([]);
  const [saveStatus, setSaveStatus] = useState(null); // null | 'saving' | 'saved'
  const [autoSave, setAutoSave] = useState(true);
  const [sessionReadOnly, setSessionReadOnly] = useState(false);
  const [loadingSessionId, setLoadingSessionId] = useState(null);
  const storyRef = useRef(null);
  const inputRef = useRef(null);
  const prevMessageCountRef = useRef(0);
  const isGuest = !player?.email;

  useEffect(() => {
    api.getCharacters().then(setCharacters).catch(() => {});
    api.getScenarios().then(setScenarios).catch(() => {});
    api.getCampaigns().then(setCampaigns).catch(() => {});
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    if (storyRef.current) {
      storyRef.current.scrollTop = storyRef.current.scrollHeight;
    }
  }, [messages]);

  // Load saved sessions for setup screen
  useEffect(() => {
    if (!sessionActive) {
      api.getSessions().then(setSavedSessions).catch(() => {});
    }
  }, [sessionActive]);

  useEffect(() => {
    if (!savedSessionDbId || !sessionAccess.sessionDbId) return;
    if (sessionAccess.sessionDbId === savedSessionDbId) {
      setSessionReadOnly(sessionAccess.readOnly === true);
    }
  }, [savedSessionDbId, sessionAccess]);

  // Auto-save when messages change
  useEffect(() => {
    const completedMessages = messages.filter(m => m.type !== 'dm_partial');
    const count = completedMessages.length;
    if (!sessionReadOnly && autoSave && count > 0 && count !== prevMessageCountRef.current) {
      prevMessageCountRef.current = count;
      handleSave();
    } else if (!autoSave) {
      prevMessageCountRef.current = count;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, autoSave, sessionReadOnly]);

  // Focus input when session starts
  useEffect(() => {
    if (sessionActive && inputRef.current) {
      inputRef.current.focus();
    }
  }, [sessionActive]);

  function handleStartSession() {
    if (isGuest) {
      alert('Please log in to start a new session.');
      return;
    }
    const character = characters.find(c => c.id === selectedCharacter);
    setSessionReadOnly(false);

    if (mode === 'campaigns') {
      if (!selectedCharacter || !selectedCampaign) return;
      // Use campaign ID as the scenario ID for session save/load compatibility
      setSavedSessionDbId(null);
      setSelectedScenario(selectedCampaign);
      startSession(selectedCharacter, selectedCampaign);
      setSessionActive(true);

      const campaign = campaigns.find(c => c.id === selectedCampaign);
      const openingPrompt = `You are running an open-world campaign: "${campaign?.title || 'The Shattered Coast'}". My character is ${character?.name || 'Unknown'}.

This is a free-exploration campaign, not a linear scenario. Here's how to run it:
- Drop the party at a random wilderness location on the Shattered Coast (choose from: Central Grasslands, Southern Plains, Northern Foothills, Western Crossroads, or Eastern Trail)
- Describe the surrounding terrain, what the party can see on the horizon, and any immediate points of interest
- The party can travel freely in any direction — there is no set quest or path
- Scattered across the region are settlements and adventure locations (Saltmere, Thornfield, Whisperhollow, Brinewatch) that the party may discover through travel
- When the party approaches a settlement, run its associated scenario storyline organically
- Between settlements, improvise wilderness events: random encounters, weather, foraging, ruins, travelers, wildlife, and environmental storytelling
- Use the exploration rules: each day of travel, consider weather, encounters, and discoveries
- Let the player drive the direction — be a sandbox DM

Set the opening scene now. Describe where the party wakes up, what they see, and what choices lie before them.`;
      setTimeout(() => sendMessage(openingPrompt), 500);
    } else {
      if (!selectedCharacter || !selectedScenario) return;
      setSavedSessionDbId(null);
      startSession(selectedCharacter, selectedScenario);
      setSessionActive(true);

      const scenario = scenarios.find(s => s.id === selectedScenario);
      const openingPrompt = `Begin the adventure "${scenario?.title || 'Unknown'}". My character is ${character?.name || 'Unknown'}. Set the scene and begin the story.`;
      setTimeout(() => sendMessage(openingPrompt), 500);
    }
  }

  async function handleSave() {
    if (isGuest) {
      alert('Please log in to save sessions.');
      return;
    }
    if (sessionReadOnly) {
      alert('This session is read-only. Only the original creator can save changes.');
      return;
    }
    setSaveStatus('saving');
    try {
      const scenario = scenarios.find(s => s.id === selectedScenario);
      const campaign = campaigns.find(c => c.id === selectedScenario);
      const name = `${campaign?.title || scenario?.title || 'Adventure'} — ${new Date().toLocaleDateString()}`;
      const payload = {
        name,
        claudeSessionId: sessionId,
        characterId: selectedCharacter,
        scenarioId: selectedScenario,
        messages: messages.filter(m => m.type !== 'dm_partial'),
        playerEmail: player?.email || null,
        playerName: player?.name || null,
      };

      console.log(`[Save] Payload — messages: ${payload.messages.length}, claudeSessionId: ${payload.claudeSessionId ? 'yes' : 'no'}`);
      let result;
      if (savedSessionDbId) {
        result = await api.updateSession(savedSessionDbId, payload);
      } else {
        result = await api.createSession(payload);
        setSavedSessionDbId(result.id);
      }
      watchSession(result.id, player);
      setSessionReadOnly(result.readOnly === true);
      console.log(`[Save] Success — session ${result.id}, messages in response: ${(result.messages || []).length}`);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 2000);
    } catch (err) {
      console.error('Save failed:', err);
      if (err?.message) alert(`Save failed: ${err.message}`);
      setSaveStatus(null);
    }
  }

  async function handleDeleteSession(e, id) {
    e.stopPropagation();
    if (!window.confirm('Delete this saved session? This cannot be undone.')) return;
    try {
      await api.deleteSession(id);
      setSavedSessions(prev => prev.filter(s => s.id !== id));
    } catch (err) {
      console.error('Delete failed:', err);
    }
  }

  async function handleLoadSession(id) {
    setLoadingSessionId(id);
    try {
      const session = await api.getSession(id);
      console.log(`[Load] Session ${id} — messages: ${(session.messages || []).length}, claudeSessionId: ${session.claudeSessionId ? 'yes' : 'no'}`);
      setSelectedCharacter(session.characterId);
      setSelectedScenario(session.scenarioId);
      setSavedSessionDbId(session.id);
      const readOnly = session.readOnly === true || session.canWrite === false;
      setSessionReadOnly(readOnly);
      const loadedMessages = normalizeSavedMessages(session.messages);
      setMessages(loadedMessages);
      if (loadedMessages.length === 0) {
        console.warn('[Load] No messages found in saved session — session may not have been saved properly');
      }
      watchSession(session.id, player);
      if (!readOnly) {
        resumeSession(session.claudeSessionId, session.characterId, session.scenarioId, loadedMessages);
      }
      setSessionActive(true);
    } catch (err) {
      console.error('Load failed:', err);
      alert(`Load failed: ${err.message}`);
    } finally {
      setLoadingSessionId(null);
    }
  }

  function handleExportStory() {
    const storyMessages = messages.filter(m => m.type !== 'dm_partial' && m.type !== 'system');
    if (storyMessages.length === 0) return;
    const text = storyMessages.map(m => m.text).join('\n\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeCampaign?.title || activeScenario?.title || 'Adventure'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleExportSession() {
    const payload = {
      name: `${scenarios.find(s => s.id === selectedScenario)?.title || 'Adventure'} — ${new Date().toLocaleDateString()}`,
      characterId: selectedCharacter,
      scenarioId: selectedScenario,
      messages: messages.filter(m => m.type !== 'dm_partial'),
      playerEmail: player?.email || null,
      playerName: player?.name || null,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${payload.name.replace(/[^a-z0-9]+/gi, '-')}.session.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleImportSession(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (isGuest) {
      alert('Please log in to import sessions.');
      e.target.value = '';
      return;
    }
    try {
      if (!file.name.endsWith('.json')) {
        alert('Please select a .session.json file exported via "Export Session". Plain text story exports (.txt) cannot be imported.');
        return;
      }
      const text = await file.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        alert('This file is not valid JSON. Please use a .session.json file exported via "Export Session" (not "Export Story").');
        return;
      }
      if (!data.messages || !Array.isArray(data.messages)) {
        alert('Invalid session file: missing messages array. Please use a file exported via "Export Session".');
        return;
      }
      const normalizedMessages = normalizeSavedMessages(data.messages);
      if (normalizedMessages.length === 0) {
        alert('Invalid session file: no usable messages found.');
        return;
      }
      const result = await api.createSession({
        name: data.name || file.name,
        characterId: data.characterId || null,
        scenarioId: data.scenarioId || null,
        messages: normalizedMessages,
        playerEmail: player?.email || data.playerEmail || null,
        playerName: player?.name || data.playerName || null,
      });
      setSavedSessions(prev => [result, ...prev]);
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    }
    // Reset file input so same file can be re-imported
    e.target.value = '';
  }

  function handleSend() {
    const text = input.trim();
    if (!text || status === 'thinking' || sessionReadOnly) return;
    sendMessage(text);
    setInput('');
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const statusInfo = STATUS_CONFIG[status] || STATUS_CONFIG.disconnected;

  // Setup screen
  if (!sessionActive) {
    return (
      <div className="adventure-setup">
        <h2>Begin Your Adventure</h2>
        <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem' }}>
          Choose your character and a scenario or campaign, then step into the story.
        </p>

        <div className="setup-selections">
          <div className="setup-group">
            <label>Character</label>
            <div className="setup-options">
              {characters.map(c => (
                <button
                  key={c.id}
                  className={`option-card${selectedCharacter === c.id ? ' selected' : ''}`}
                  onClick={() => setSelectedCharacter(c.id)}
                >
                  <strong>{c.name}</strong>
                  <span>Level {c.level} {c.race} {c.class}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="setup-group">
            <div className="mode-toggle">
              <button
                className={`mode-toggle-btn${mode === 'scenarios' ? ' active' : ''}`}
                onClick={() => { setMode('scenarios'); setSelectedCampaign(null); }}
              >
                Scenarios
              </button>
              <button
                className={`mode-toggle-btn${mode === 'campaigns' ? ' active' : ''}`}
                onClick={() => { setMode('campaigns'); setSelectedScenario(null); }}
              >
                Campaigns
              </button>
            </div>

            {mode === 'scenarios' ? (
              <div className="setup-options">
                {scenarios.map(s => (
                  <button
                    key={s.id}
                    className={`option-card${selectedScenario === s.id ? ' selected' : ''}`}
                    onClick={() => setSelectedScenario(s.id)}
                  >
                    <strong>{s.title}</strong>
                    <span>{s.synopsis ? s.synopsis.substring(0, 80) + '...' : ''}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="setup-options">
                {campaigns.map(c => (
                  <button
                    key={c.id}
                    className={`option-card campaign-card${selectedCampaign === c.id ? ' selected' : ''}`}
                    onClick={() => setSelectedCampaign(c.id)}
                  >
                    <strong>{c.title}</strong>
                    <span className="campaign-subtitle">{c.subtitle}</span>
                    <span className="campaign-meta">Levels {c.levelRange} &middot; {c.estimatedSessions} sessions</span>
                    <span>{c.synopsis ? c.synopsis.substring(0, 100) + '...' : ''}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <button
          className="btn-primary begin-btn"
          disabled={isGuest || !selectedCharacter || (mode === 'scenarios' ? !selectedScenario : !selectedCampaign) || status === 'disconnected'}
          onClick={handleStartSession}
        >
          {status === 'disconnected' ? 'Connecting...' : (isGuest ? 'Login Required to Begin' : 'Begin Adventure')}
        </button>
        {isGuest && (
          <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem' }}>
            Guests can browse and view saved sessions, but cannot create new sessions or campaigns.
          </p>
        )}

        <div className="setup-group" style={{ marginTop: '2rem' }}>
          <label>Load Saved Session</label>
          <div className="setup-options">
            {savedSessions.map((s, i) => (
              <div key={`${s.id}-${i}`} className="option-card" style={{ position: 'relative' }}>
                <button
                  className="option-card-inner"
                  onClick={() => handleLoadSession(s.id)}
                  disabled={loadingSessionId === s.id}
                  style={{
                    all: 'unset',
                    cursor: loadingSessionId === s.id ? 'wait' : 'pointer',
                    opacity: loadingSessionId === s.id ? 0.7 : 1,
                    display: 'flex',
                    flexDirection: 'column',
                    width: '100%',
                  }}
                >
                  <strong>{s.name}</strong>
                  <span>Player: {s.playerName || s.playerEmail || 'Unknown'}</span>
                  <span>{s.canWrite === false ? 'Read only' : 'Editable'}</span>
                  <span>
                    {loadingSessionId === s.id ? 'Loading...' : `${s.messageCount} messages — ${formatSavedSessionDate(s.updatedAt)}`}
                  </span>
                  {loadingSessionId !== s.id && (
                    <span className="saved-session-time">{formatSavedSessionTime(s.updatedAt)}</span>
                  )}
                </button>
                {s.canWrite !== false && (
                  <button
                    className="btn-delete-session"
                    onClick={(e) => handleDeleteSession(e, s.id)}
                    title="Delete session"
                    style={{
                      position: 'absolute', top: '0.4rem', right: '0.4rem',
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--text-muted)', fontSize: '1rem', padding: '0.2rem 0.4rem',
                      borderRadius: '4px', lineHeight: 1,
                    }}
                    onMouseEnter={e => e.currentTarget.style.color = '#e74c3c'}
                    onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}
                  >
                    &times;
                  </button>
                )}
              </div>
            ))}
          </div>
          <label
            className="btn-primary"
            style={{
              display: 'inline-block', marginTop: '0.75rem', cursor: isGuest ? 'not-allowed' : 'pointer',
              fontSize: '0.9rem', padding: '0.5rem 1.2rem', opacity: isGuest ? 0.6 : 1,
            }}
          >
            Import Session File
            <input
              type="file"
              accept=".json,.session.json"
              onChange={handleImportSession}
              disabled={isGuest}
              style={{ display: 'none' }}
            />
          </label>
        </div>
      </div>
    );
  }

  // Active adventure screen
  const activeCharacter = characters.find(c => c.id === selectedCharacter);
  const activeScenario = scenarios.find(s => s.id === selectedScenario);
  const activeCampaign = campaigns.find(c => c.id === selectedScenario);

  return (
    <div className="adventure-container">
        {/* Session info bar */}
        <div className="adventure-header">
          <div className="adventure-info">
            <span className="adventure-scenario">{activeCampaign?.title || activeScenario?.title}</span>
            <span className="adventure-character">{activeCharacter?.name}</span>
            {sessionReadOnly && <span className="adventure-character">Read only</span>}
          </div>
          <button
            className="btn-save"
            onClick={handleSave}
            disabled={sessionReadOnly || saveStatus === 'saving' || status === 'disconnected'}
          >
            {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved!' : 'Save'}
          </button>
          <button
            className="btn-save"
            onClick={handleExportStory}
            disabled={messages.filter(m => m.type !== 'dm_partial' && m.type !== 'system').length === 0}
          >
            Export Story
          </button>
          <button
            className="btn-save"
            onClick={handleExportSession}
            disabled={messages.filter(m => m.type !== 'dm_partial').length === 0}
          >
            Export Session
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.85rem', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={autoSave}
              disabled={sessionReadOnly}
              onChange={e => setAutoSave(e.target.checked)}
            />
            Auto-save
          </label>
          <div className={`status-indicator ${statusInfo.className}`}>
            <span className="status-dot" />
            <span className="status-label">{statusInfo.label}</span>
          </div>
        </div>

        {/* Story area */}
        <div className="story-area" ref={storyRef}>
          {messages.map((msg, i) => (
            <div key={i} className={`story-message story-${msg.type}`}>
              {msg.type === 'player' && (
                <div className="message-player">
                  <span className="message-sender">{activeCharacter?.name || 'You'}</span>
                  <p>{msg.text}</p>
                </div>
              )}
              {(msg.type === 'dm' || msg.type === 'dm_partial') && (
                <div className="message-dm">
                  <span className="message-sender">Dungeon Master</span>
                  <RichText as="div" className="dm-narration" text={msg.text} />
                  {msg.type === 'dm_partial' && <span className="typing-cursor" />}
                </div>
              )}
              {msg.type === 'system' && (
                <div className="message-system">{msg.text}</div>
              )}
            </div>
          ))}
        </div>

        {/* Input area */}
        <div className="adventure-input-bar">
          <textarea
            ref={inputRef}
            className="adventure-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={sessionReadOnly ? 'Viewing live session (read-only)' : (status === 'thinking' ? 'The DM is narrating...' : 'What do you do?')}
            disabled={sessionReadOnly || status === 'thinking' || status === 'awaiting_permission'}
            rows={1}
          />
          <button
            className="btn-send"
            onClick={handleSend}
            disabled={sessionReadOnly || !input.trim() || status === 'thinking'}
          >
            Send
          </button>
        </div>

        {/* Permission modal */}
        {permissionRequest && (
          <div className="permission-overlay">
            <div className="permission-modal">
              <h3>The DM Requests Permission</h3>
              <p className="permission-description">{permissionRequest.description}</p>
              <p className="permission-tool">Tool: <code>{permissionRequest.toolName}</code></p>
              {permissionRequest.input?.file_path && (
                <p className="permission-detail">File: <code>{permissionRequest.input.file_path}</code></p>
              )}
              {permissionRequest.input?.command && (
                <p className="permission-detail">Command: <code>{permissionRequest.input.command}</code></p>
              )}
              <div className="permission-actions">
                <button
                  className="btn-allow"
                  onClick={() => sendPermission(permissionRequest.toolUseID, true)}
                >
                  Allow
                </button>
                <button
                  className="btn-deny"
                  onClick={() => sendPermission(permissionRequest.toolUseID, false)}
                >
                  Deny
                </button>
              </div>
            </div>
          </div>
        )}
    </div>
  );
}

export default Adventure;
