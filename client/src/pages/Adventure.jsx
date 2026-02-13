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
  const storyRef = useRef(null);
  const inputRef = useRef(null);

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
      resumeSession(session.claudeSessionId, session.characterId, session.scenarioId);
      setSessionActive(true);
    } catch (err) {
      console.error('Load failed:', err);
    }
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

        {savedSessions.length > 0 && (
          <div className="setup-group" style={{ marginTop: '2rem' }}>
            <label>Load Saved Session</label>
            <div className="setup-options">
              {savedSessions.map(s => (
                <button
                  key={s.id}
                  className="option-card"
                  onClick={() => handleLoadSession(s.id)}
                  disabled={status === 'disconnected'}
                >
                  <strong>{s.name}</strong>
                  <span>{s.messageCount} messages — {new Date(s.updatedAt).toLocaleDateString()}</span>
                </button>
              ))}
            </div>
          </div>
        )}
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
