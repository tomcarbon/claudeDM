import { BrowserRouter, Routes, Route, NavLink, useLocation } from 'react-router-dom';
import { useState } from 'react';
import CharacterList from './pages/CharacterList';
import CharacterDetail from './pages/CharacterDetail';
import CharacterEdit from './pages/CharacterEdit';
import NpcList from './pages/NpcList';
import NpcDetail from './pages/NpcDetail';
import RulesPage from './pages/RulesPage';
import ScenarioList from './pages/ScenarioList';
import ScenarioDetail from './pages/ScenarioDetail';
import DmSettings from './pages/DmSettings';
import Settings from './pages/Settings';
import Adventure from './pages/Adventure';
import Home from './pages/Home';
import WorldMapPage from './pages/WorldMapPage';
import useWebSocket from './hooks/useWebSocket';
import './App.css';

function AppContent() {
  const location = useLocation();
  const ws = useWebSocket();
  const [sessionActive, setSessionActive] = useState(false);
  const [selectedCharacter, setSelectedCharacter] = useState('');
  const [selectedScenario, setSelectedScenario] = useState('');
  const [savedSessionDbId, setSavedSessionDbId] = useState(null);

  const onAdventure = location.pathname === '/adventure';

  return (
    <div className="app">
      <nav className="sidebar">
        <h1 className="logo">D&D Companion</h1>
        <ul>
          <li><NavLink to="/adventure" className="nav-play">Play</NavLink></li>
          <li><NavLink to="/">Home</NavLink></li>
          <li><NavLink to="/characters">Characters</NavLink></li>
          <li><NavLink to="/npcs">Companions</NavLink></li>
          <li><NavLink to="/scenarios">Scenarios</NavLink></li>
          <li><NavLink to="/world-map">World Map</NavLink></li>
          <li><NavLink to="/rules">Rules</NavLink></li>
        </ul>
        <div className="sidebar-divider" />
        <ul>
          <li><NavLink to="/dm-settings">DM Personality</NavLink></li>
          <li><NavLink to="/settings">Settings</NavLink></li>
        </ul>
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
          <Route path="/" element={<Home />} />
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
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}

export default App;
