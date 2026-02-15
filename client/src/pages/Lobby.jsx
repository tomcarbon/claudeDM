import { useState, useEffect } from 'react';
import { api } from '../api/client';

function Lobby({ ws, onStartSolo }) {
  const {
    status, gameCode, players, isHost, gamePhase,
    createGame, joinGame, startGame, leaveGame,
  } = ws;

  const [characters, setCharacters] = useState([]);
  const [scenarios, setScenarios] = useState([]);
  const [selectedCharacter, setSelectedCharacter] = useState('');
  const [selectedScenario, setSelectedScenario] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [tab, setTab] = useState('host'); // 'host' | 'join'
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.getCharacters().then(setCharacters).catch(() => {});
    api.getScenarios().then(setScenarios).catch(() => {});
  }, []);

  // Auto-fill playerName from selected character
  useEffect(() => {
    if (!playerName && selectedCharacter) {
      const char = characters.find(c => c.id === selectedCharacter);
      if (char) setPlayerName(char.name.split(' ')[0]);
    }
  }, [selectedCharacter, characters]);

  function handleCreate() {
    if (!playerName.trim() || !selectedCharacter || !selectedScenario) return;
    createGame(playerName.trim(), selectedCharacter, selectedScenario);
  }

  function handleJoin() {
    if (!playerName.trim() || !joinCode.trim() || !selectedCharacter) return;
    joinGame(joinCode.trim().toUpperCase(), playerName.trim(), selectedCharacter);
  }

  function handleCopyCode() {
    navigator.clipboard.writeText(gameCode).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function handleStart() {
    startGame();
  }

  const isDisconnected = status === 'disconnected';

  // In lobby phase: show waiting room
  if (gamePhase === 'lobby') {
    return (
      <div className="adventure-setup">
        <h2>Game Lobby</h2>

        <div className="game-code-display">
          <span className="game-code-label">Game Code</span>
          <div className="game-code-value" onClick={handleCopyCode} title="Click to copy">
            {gameCode}
            <span className="game-code-copy">{copied ? 'Copied!' : 'Copy'}</span>
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85em', marginTop: '0.5rem' }}>
            Share this code with other players so they can join.
          </p>
        </div>

        <div className="setup-group" style={{ marginTop: '1.5rem' }}>
          <label>Players ({players.length}/8)</label>
          <div className="player-list">
            {players.map(p => (
              <div key={p.playerId} className={`player-list-item${!p.connected ? ' disconnected' : ''}`}>
                <span className="player-name">
                  {p.playerName}
                  {p.isHost && <span className="host-badge">Host</span>}
                </span>
                <span className="player-character">{p.characterName}</span>
                {!p.connected && <span className="player-status-badge">Disconnected</span>}
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.5rem' }}>
          {isHost && (
            <button
              className="btn-primary begin-btn"
              onClick={handleStart}
              disabled={players.length === 0 || isDisconnected}
            >
              Start Adventure
            </button>
          )}
          <button
            className="btn-save"
            onClick={leaveGame}
            style={{ alignSelf: 'center' }}
          >
            Leave Game
          </button>
        </div>

        {!isHost && (
          <p style={{ color: 'var(--text-muted)', marginTop: '1rem', fontStyle: 'italic' }}>
            Waiting for the host to start the adventure...
          </p>
        )}
      </div>
    );
  }

  // Setup phase: create or join
  return (
    <div className="adventure-setup">
      <h2>Multiplayer Adventure</h2>
      <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem' }}>
        Host a new game or join an existing one.
      </p>

      <div className="lobby-tabs">
        <button
          className={`lobby-tab${tab === 'host' ? ' active' : ''}`}
          onClick={() => setTab('host')}
        >
          Host a Game
        </button>
        <button
          className={`lobby-tab${tab === 'join' ? ' active' : ''}`}
          onClick={() => setTab('join')}
        >
          Join a Game
        </button>
      </div>

      {tab === 'host' && (
        <div className="lobby-panel">
          <div className="setup-group">
            <label>Your Name</label>
            <input
              type="text"
              className="lobby-input"
              value={playerName}
              onChange={e => setPlayerName(e.target.value)}
              placeholder="Enter your display name"
              maxLength={20}
            />
          </div>

          <div className="setup-group">
            <label>Your Character</label>
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

          <button
            className="btn-primary begin-btn"
            onClick={handleCreate}
            disabled={!playerName.trim() || !selectedCharacter || !selectedScenario || isDisconnected}
          >
            {isDisconnected ? 'Connecting...' : 'Create Game'}
          </button>
        </div>
      )}

      {tab === 'join' && (
        <div className="lobby-panel">
          <div className="setup-group">
            <label>Game Code</label>
            <input
              type="text"
              className="lobby-input game-code-input"
              value={joinCode}
              onChange={e => setJoinCode(e.target.value.toUpperCase().slice(0, 4))}
              placeholder="XXXX"
              maxLength={4}
              style={{ letterSpacing: '0.3em', fontSize: '1.2em', textAlign: 'center', maxWidth: '160px' }}
            />
          </div>

          <div className="setup-group">
            <label>Your Name</label>
            <input
              type="text"
              className="lobby-input"
              value={playerName}
              onChange={e => setPlayerName(e.target.value)}
              placeholder="Enter your display name"
              maxLength={20}
            />
          </div>

          <div className="setup-group">
            <label>Your Character</label>
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

          <button
            className="btn-primary begin-btn"
            onClick={handleJoin}
            disabled={!playerName.trim() || joinCode.length !== 4 || !selectedCharacter || isDisconnected}
          >
            {isDisconnected ? 'Connecting...' : 'Join Game'}
          </button>
        </div>
      )}

      {onStartSolo && (
        <div style={{ marginTop: '2rem', textAlign: 'center' }}>
          <button
            className="btn-save"
            onClick={onStartSolo}
            style={{ fontSize: '0.9em' }}
          >
            Play Solo Instead
          </button>
        </div>
      )}
    </div>
  );
}

export default Lobby;
