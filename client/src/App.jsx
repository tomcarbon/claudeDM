import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import { useState, useEffect, useRef } from 'react';
import CharacterList from './pages/CharacterList';
import CharacterDetail from './pages/CharacterDetail';
import CharacterEdit from './pages/CharacterEdit';
import NpcList from './pages/NpcList';
import NpcDetail from './pages/NpcDetail';
import RulesPage from './pages/RulesPage';
import WhatsNew from './pages/WhatsNew';
import ScenarioList from './pages/ScenarioList';
import ScenarioDetail from './pages/ScenarioDetail';
import DmSettings from './pages/DmSettings';
import Settings from './pages/Settings';
import Adventure from './pages/Adventure';
import Home from './pages/Home';
import WorldMapPage from './pages/WorldMapPage';
import useWebSocket from './hooks/useWebSocket';
import { PlayerProvider, usePlayer } from './context/PlayerContext';
import PlayerLogin from './components/PlayerLogin';
import PlayerChat from './components/PlayerChat';
import { api } from './api/client';
import { CURRENT_VERSION } from './data/changelog';
import './App.css';

function AppContent() {
  const location = useLocation();
  const ws = useWebSocket();
  const { player } = usePlayer();
  const [sessionActive, setSessionActive] = useState(false);
  const globalChatJoinedRef = useRef(null);
  const [selectedCharacter, setSelectedCharacter] = useState('');
  const [selectedScenario, setSelectedScenario] = useState('');
  const [savedSessionDbId, setSavedSessionDbId] = useState(null);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);

  const onAdventure = location.pathname === '/adventure';
  const isAdmin = player?.role === 'admin';

  // Auto-join global chat room and load today's history on connect or player change
  const isConnected = ws.status !== 'disconnected' && ws.status !== 'error';
  useEffect(() => {
    const joinKey = `${isConnected}-${player?.email || 'guest'}`;
    if (!isConnected || globalChatJoinedRef.current === joinKey) return;
    globalChatJoinedRef.current = joinKey;
    ws.joinChat('global', {
      email: player?.email || 'guest',
      name: player?.name || 'Guest',
      role: player?.role || 'guest',
    });
    api.getChatMessages().then(data => {
      if (data?.messages) ws.setChatMessages(data.messages);
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, player?.email]);

  return (
    <div className="app">
      <nav className="sidebar">
        <h1 className="logo">D&D Companion<span className="logo-sub">Single Player Demo</span></h1>
        <ul>
          <li><NavLink to="/">Home</NavLink></li>
          <li><NavLink to="/adventure" className="nav-play">Play</NavLink></li>
          <li><NavLink to="/characters">Characters</NavLink></li>
          <li><NavLink to="/npcs">Companions</NavLink></li>
          <li><NavLink to="/world-map">World Map</NavLink></li>
          <li><NavLink to="/rules">Rules</NavLink></li>
        </ul>
        <div className="sidebar-divider" />
        <div className="sidebar-section-label">
          Scenarios <span className="sidebar-section-sub">spoilers</span>
        </div>
        <ul>
          <li><NavLink to="/scenarios">Scenarios</NavLink></li>
        </ul>
        <div className="sidebar-divider" />
        <ul>
          <li><NavLink to="/whats-new">What&apos;s New</NavLink></li>
          <li><NavLink to="/dm-settings">DM Personality</NavLink></li>
          {player && <li><NavLink to="/settings">Settings</NavLink></li>}
        </ul>
        <div className="sidebar-divider" />
        <div className="app-version">v{CURRENT_VERSION}</div>
        <div className="sidebar-divider" />
        <PlayerLogin />
      </nav>
      <main className="content">
        <div style={{ display: onAdventure ? 'block' : 'none', height: '100%' }}>
          <Adventure
            ws={ws}
            sessionActive={sessionActive}
            setSessionActive={setSessionActive}
            selectedCharacter={selectedCharacter}
            setSelectedCharacter={setSelectedCharacter}
            selectedScenario={selectedScenario}
            setSelectedScenario={setSelectedScenario}
            savedSessionDbId={savedSessionDbId}
            setSavedSessionDbId={setSavedSessionDbId}
          />
        </div>
        <Routes>
          <Route path="/adventure" element={null} />
          <Route path="/" element={<Home />} />
          <Route path="/whats-new" element={<WhatsNew />} />
          <Route path="/characters" element={<CharacterList />} />
          <Route path="/characters/:id" element={<CharacterDetail />} />
          <Route path="/characters/:id/edit" element={<CharacterEdit />} />
          <Route path="/npcs" element={<NpcList />} />
          <Route path="/npcs/:id" element={<NpcDetail />} />
          <Route path="/scenarios" element={<ScenarioList />} />
          <Route path="/scenarios/:id" element={<ScenarioDetail />} />
          <Route path="/world-map" element={<WorldMapPage />} />
          <Route path="/rules" element={<RulesPage />} />
          <Route path="/dm-settings" element={<DmSettings />} />
          <Route path="/settings" element={player ? <Settings /> : <Navigate to="/" replace />} />
        </Routes>
      </main>
      <div className="chat-sidebar">
        <PlayerChat
          chatMessages={ws.chatMessages}
          onlinePlayers={ws.onlinePlayers}
          selfChatConnectionId={ws.selfChatConnectionId}
          onSend={(text) => ws.sendChat(text, player)}
        />
      </div>
      {mobileChatOpen && (
        <div className="mobile-chat-overlay" onClick={(e) => { if (e.target === e.currentTarget) setMobileChatOpen(false); }}>
          <div className="mobile-chat-panel">
            <button className="mobile-chat-close" onClick={() => setMobileChatOpen(false)}>✕</button>
            <PlayerChat
              chatMessages={ws.chatMessages}
              onlinePlayers={ws.onlinePlayers}
              selfChatConnectionId={ws.selfChatConnectionId}
              onSend={(text) => ws.sendChat(text, player)}
            />
          </div>
        </div>
      )}
      <button className="mobile-chat-fab" onClick={() => setMobileChatOpen(true)} title="Party Chat">
        💬
      </button>
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <PlayerProvider>
        <AppContent />
      </PlayerProvider>
    </BrowserRouter>
  );
}

export default App;
