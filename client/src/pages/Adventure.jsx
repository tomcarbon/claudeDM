import { useState, useEffect, useRef } from 'react';
import { api } from '../api/client';

const STATUS_CONFIG = {
  idle: { label: 'Ready', className: 'status-idle' },
  thinking: { label: 'DM is thinking...', className: 'status-thinking' },
  awaiting_permission: { label: 'Awaiting approval', className: 'status-permission' },
  disconnected: { label: 'Disconnected', className: 'status-disconnected' },
  error: { label: 'Error', className: 'status-error' },
};

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
  const { messages, setMessages, status, sessionId, permissionRequest, sendMessage, startSession, sendPermission, resumeSession } = ws;
  const [input, setInput] = useState('');
  const [characters, setCharacters] = useState([]);
  const [scenarios, setScenarios] = useState([]);
  const [savedSessions, setSavedSessions] = useState([]);
  const [saveStatus, setSaveStatus] = useState(null); // null | 'saving' | 'saved'
  const [autoSave, setAutoSave] = useState(true);
  const storyRef = useRef(null);
  const inputRef = useRef(null);
  const prevMessageCountRef = useRef(0);

  useEffect(() => {
    api.getCharacters().then(setCharacters).catch(() => {});
    api.getScenarios().then(setScenarios).catch(() => {});
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

  // Auto-save when messages change
  useEffect(() => {
    const completedMessages = messages.filter(m => m.type !== 'dm_partial');
    const count = completedMessages.length;
    if (autoSave && count > 0 && count !== prevMessageCountRef.current) {
      prevMessageCountRef.current = count;
      handleSave();
    } else if (!autoSave) {
      prevMessageCountRef.current = count;
    }
  }, [messages, autoSave]);

  // Focus input when session starts
  useEffect(() => {
    if (sessionActive && inputRef.current) {
      inputRef.current.focus();
    }
  }, [sessionActive]);

  function handleStartSession() {
    if (!selectedCharacter || !selectedScenario) return;
    setSavedSessionDbId(null);
    startSession(selectedCharacter, selectedScenario);
    setSessionActive(true);

    // Auto-send the opening prompt
    const scenario = scenarios.find(s => s.id === selectedScenario);
    const character = characters.find(c => c.id === selectedCharacter);
    const openingPrompt = `Begin the adventure "${scenario?.title || 'Unknown'}". My character is ${character?.name || 'Unknown'}. Set the scene and begin the story.`;
    setTimeout(() => sendMessage(openingPrompt), 500);
  }

  async function handleSave() {
    setSaveStatus('saving');
    try {
      const scenario = scenarios.find(s => s.id === selectedScenario);
      const name = `${scenario?.title || 'Adventure'} — ${new Date().toLocaleDateString()}`;
      const payload = {
        name,
        claudeSessionId: sessionId,
        characterId: selectedCharacter,
        scenarioId: selectedScenario,
        messages: messages.filter(m => m.type !== 'dm_partial'),
      };

      console.log(`[Save] Payload — messages: ${payload.messages.length}, claudeSessionId: ${payload.claudeSessionId ? 'yes' : 'no'}`);
      let result;
      if (savedSessionDbId) {
        result = await api.updateSession(savedSessionDbId, payload);
      } else {
        result = await api.createSession(payload);
        setSavedSessionDbId(result.id);
      }
      console.log(`[Save] Success — session ${result.id}, messages in response: ${(result.messages || []).length}`);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 2000);
    } catch (err) {
      console.error('Save failed:', err);
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
    try {
      const session = await api.getSession(id);
      console.log(`[Load] Session ${id} — messages: ${(session.messages || []).length}, claudeSessionId: ${session.claudeSessionId ? 'yes' : 'no'}`);
      setSelectedCharacter(session.characterId);
      setSelectedScenario(session.scenarioId);
      setSavedSessionDbId(session.id);
      const loadedMessages = session.messages || [];
      setMessages(loadedMessages);
      if (loadedMessages.length === 0) {
        console.warn('[Load] No messages found in saved session — session may not have been saved properly');
      }
      resumeSession(session.claudeSessionId, session.characterId, session.scenarioId, loadedMessages);
      setSessionActive(true);
    } catch (err) {
      console.error('Load failed:', err);
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
    a.download = `${activeScenario?.title || 'Adventure'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleExportSession() {
    const payload = {
      name: `${scenarios.find(s => s.id === selectedScenario)?.title || 'Adventure'} — ${new Date().toLocaleDateString()}`,
      characterId: selectedCharacter,
      scenarioId: selectedScenario,
      messages: messages.filter(m => m.type !== 'dm_partial'),
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
      const result = await api.createSession({
        name: data.name || file.name,
        characterId: data.characterId || null,
        scenarioId: data.scenarioId || null,
        messages: data.messages,
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
    if (!text || status === 'thinking') return;
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
          Choose your character and scenario, then step into the story.
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
            <label>Scenario</label>
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
          </div>
        </div>

        <button
          className="btn-primary begin-btn"
          disabled={!selectedCharacter || !selectedScenario || status === 'disconnected'}
          onClick={handleStartSession}
        >
          {status === 'disconnected' ? 'Connecting...' : 'Begin Adventure'}
        </button>

        <div className="setup-group" style={{ marginTop: '2rem' }}>
          <label>Load Saved Session</label>
          <div className="setup-options">
            {savedSessions.map((s, i) => (
              <div key={`${s.id}-${i}`} className="option-card" style={{ position: 'relative' }}>
                <button
                  className="option-card-inner"
                  onClick={() => handleLoadSession(s.id)}
                  disabled={status === 'disconnected'}
                  style={{ all: 'unset', cursor: 'pointer', display: 'flex', flexDirection: 'column', width: '100%' }}
                >
                  <strong>{s.name}</strong>
                  <span>{s.messageCount} messages — {new Date(s.updatedAt).toLocaleDateString()}</span>
                </button>
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
              </div>
            ))}
          </div>
          <label
            className="btn-primary"
            style={{
              display: 'inline-block', marginTop: '0.75rem', cursor: 'pointer',
              fontSize: '0.9rem', padding: '0.5rem 1.2rem',
            }}
          >
            Import Session File
            <input
              type="file"
              accept=".json,.session.json"
              onChange={handleImportSession}
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

  return (
    <div className="adventure-container">
      {/* Session info bar */}
      <div className="adventure-header">
        <div className="adventure-info">
          <span className="adventure-scenario">{activeScenario?.title}</span>
          <span className="adventure-character">{activeCharacter?.name}</span>
        </div>
        <button
          className="btn-save"
          onClick={handleSave}
          disabled={saveStatus === 'saving' || status === 'disconnected'}
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
                <div className="dm-narration">{msg.text}</div>
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
          placeholder={status === 'thinking' ? 'The DM is narrating...' : 'What do you do?'}
          disabled={status === 'thinking' || status === 'awaiting_permission'}
          rows={1}
        />
        <button
          className="btn-send"
          onClick={handleSend}
          disabled={!input.trim() || status === 'thinking'}
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
