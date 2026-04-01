import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import { useState, useEffect, useRef } from 'react';
import CharacterList from './pages/CharacterList';
import CharacterDetail from './pages/CharacterDetail';
import CharacterEdit from './pages/CharacterEdit';
import CharacterCreator from './pages/CharacterCreator';
import NpcList from './pages/NpcList';
import CurrentParty from './pages/CurrentParty';
import NpcDetail from './pages/NpcDetail';
import RulesPage from './pages/RulesPage';
import WhatsNew from './pages/WhatsNew';
import ScenarioList from './pages/ScenarioList';
import ScenarioDetail from './pages/ScenarioDetail';
import DmSettings from './pages/DmSettings';
import Settings from './pages/Settings';
import Adventure from './pages/Adventure';
import Home from './pages/Home';
import Eli5 from './pages/Eli5';
import WorldMapPage from './pages/WorldMapPage';
import MyGames from './pages/MyGames';
import useWebSocket from './hooks/useWebSocket';
import { PlayerProvider, usePlayer } from './context/PlayerContext';
import { CampaignProvider, useCampaign } from './context/CampaignContext';
import PlayerLogin from './components/PlayerLogin';
import PlayerChat from './components/PlayerChat';
import { api } from './api/client';
import { CURRENT_VERSION } from './data/changelog';
import './App.css';

function AppContent() {
  const location = useLocation();
  const ws = useWebSocket();
  const { player } = usePlayer();
  const { campaignId, selectCampaign } = useCampaign();
  const [sessionActive, setSessionActive] = useState(false);
  const globalChatJoinedRef = useRef(null);
  const [selectedCharacter, setSelectedCharacter] = useState('');
  const [selectedScenario, setSelectedScenario] = useState('');
  const [savedSessionDbId, setSavedSessionDbId] = useState(null);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const crossCampaignLoadRef = useRef(false);
  const [pendingLoadSessionId, setPendingLoadSessionId] = useState(null);
  const [activeSessionLabel, setActiveSessionLabel] = useState('');

  const onAdventure = location.pathname === '/adventure';
  const isAdmin = player?.role === 'admin';

  // Reset adventure session when campaign changes (skip if a cross-campaign load is in progress)
  useEffect(() => {
    if (crossCampaignLoadRef.current) {
      crossCampaignLoadRef.current = false;
      return;
    }
    setSessionActive(false);
    setSavedSessionDbId(null);
  }, [campaignId]);

  // Reset adventure session when navigating from Home's "Start Adventure"
  // Handle loadSessionId from My Games page
  useEffect(() => {
    if (location.pathname === '/adventure' && location.state?.resetSession) {
      setSessionActive(false);
      setSavedSessionDbId(null);
      window.history.replaceState({}, '');
    }
    if (location.pathname === '/adventure' && location.state?.loadSessionId) {
      setPendingLoadSessionId(location.state.loadSessionId);
      window.history.replaceState({}, '');
    }
  }, [location.pathname, location.state]);

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
    api.getRecentChatMessages(3).then(data => {
      if (data?.messages) ws.setChatMessages(data.messages);
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, player?.email]);

  return (
    <div className="app">
      <nav className="sidebar">
        <img src="/coat-of-arms.png" alt="Coat of Arms" className="sidebar-crest" />
        <h1 className="logo">D&D Companion<span className="logo-sub">{campaignId === 'campaign1' ? 'Depths of the Underdark' : campaignId === 'wonderland' ? 'Madness in Wonderland' : campaignId === 'campaign3' ? 'Storm of the Giants' : campaignId === 'campaign4' ? 'The Astral Convergence' : 'Single Player Demo'}</span></h1>
        <div className="currently-playing">Playing: {sessionActive && activeSessionLabel ? activeSessionLabel : 'None'}</div>
        <div className="sidebar-divider" />
        <ul>
          <li><NavLink to="/">Home</NavLink></li>
          <li><NavLink to="/eli5">ELI5</NavLink></li>
          <li><NavLink to="/whats-new">What&apos;s New</NavLink></li>
        </ul>
        <PlayerLogin />
        <div className="sidebar-divider" />
        <ul>
          {player && <li><NavLink to="/my-games">My Games</NavLink></li>}
          <li><NavLink to="/adventure" className="nav-play">Play</NavLink></li>
          {player && campaignId && <>
            <li><NavLink to="/current-party" className="nav-sub">Current Party</NavLink></li>
            <li><NavLink to="/characters" className="nav-sub">Characters</NavLink></li>
            <li><NavLink to="/npcs" className="nav-sub">Companions</NavLink></li>
            <li><NavLink to="/world-map" className="nav-sub">World Map</NavLink></li>
            <li><NavLink to="/scenarios" className="nav-sub">Scenarios (spoilers!)</NavLink></li>
          </>}
          <li><NavLink to="/dm-settings">DM Personality</NavLink></li>
        </ul>
        <div className="sidebar-divider" />
        <ul>
          <li><a href="/distraction/index.html" target="_blank" rel="noopener noreferrer">Distraction</a></li>
          {player && <li><NavLink to="/settings">Settings</NavLink></li>}
          <li><NavLink to="/rules">Rules</NavLink></li>
        </ul>
        <div className="sidebar-divider" />
        <div className="app-version">v{CURRENT_VERSION}</div>
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
            campaignId={campaignId}
            selectCampaign={selectCampaign}
            crossCampaignLoadRef={crossCampaignLoadRef}
            pendingLoadSessionId={pendingLoadSessionId}
            setPendingLoadSessionId={setPendingLoadSessionId}
            activeSessionLabel={activeSessionLabel}
            setActiveSessionLabel={setActiveSessionLabel}
          />
        </div>
        <Routes>
          <Route path="/adventure" element={null} />
          <Route path="/" element={<Home />} />
          <Route path="/eli5" element={<Eli5 />} />
          <Route path="/whats-new" element={<WhatsNew />} />
          <Route path="/current-party" element={<CurrentParty />} />
          <Route path="/characters" element={<CharacterList />} />
          <Route path="/create-character" element={<CharacterCreator />} />
          <Route path="/characters/:id" element={<CharacterDetail />} />
          <Route path="/characters/:id/edit" element={<CharacterEdit />} />
          <Route path="/npcs" element={<NpcList />} />
          <Route path="/npcs/:id" element={<NpcDetail />} />
          <Route path="/scenarios" element={<ScenarioList />} />
          <Route path="/scenarios/:id" element={<ScenarioDetail />} />
          <Route path="/world-map" element={<WorldMapPage />} />
          <Route path="/rules" element={<RulesPage />} />
          <Route path="/dm-settings" element={<DmSettings />} />
          <Route path="/my-games" element={player ? <MyGames /> : <Navigate to="/" replace />} />
          <Route path="/settings" element={player ? <Settings /> : <Navigate to="/" replace />} />
        </Routes>
      </main>
      <div className="chat-sidebar">
        <PlayerChat
          chatMessages={ws.chatMessages}
          onlinePlayers={ws.onlinePlayers}
          selfChatConnectionId={ws.selfChatConnectionId}
          onSend={(text) => ws.sendChat(text, player)}
          chatTypingPlayers={ws.chatTypingPlayers}
          sendChatTypingStatus={ws.sendChatTypingStatus}
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
        <CampaignProvider>
          <AppContent />
        </CampaignProvider>
      </PlayerProvider>
    </BrowserRouter>
  );
}

export default App;
