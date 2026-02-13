import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import CharacterList from './pages/CharacterList';
import CharacterDetail from './pages/CharacterDetail';
import CharacterEdit from './pages/CharacterEdit';
import NpcList from './pages/NpcList';
import NpcDetail from './pages/NpcDetail';
import RulesPage from './pages/RulesPage';
import ScenarioList from './pages/ScenarioList';
import ScenarioDetail from './pages/ScenarioDetail';
import DmSettings from './pages/DmSettings';
import Home from './pages/Home';
import './App.css';

function App() {
  return (
    <BrowserRouter>
      <div className="app">
        <nav className="sidebar">
          <h1 className="logo">D&D Companion</h1>
          <ul>
            <li><NavLink to="/">Home</NavLink></li>
            <li><NavLink to="/characters">Characters</NavLink></li>
            <li><NavLink to="/npcs">Companions</NavLink></li>
            <li><NavLink to="/scenarios">Scenarios</NavLink></li>
            <li><NavLink to="/rules">Rules</NavLink></li>
          </ul>
          <div className="sidebar-divider" />
          <ul>
            <li><NavLink to="/dm-settings">DM Personality</NavLink></li>
          </ul>
        </nav>
        <main className="content">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/characters" element={<CharacterList />} />
            <Route path="/characters/:id" element={<CharacterDetail />} />
            <Route path="/characters/:id/edit" element={<CharacterEdit />} />
            <Route path="/npcs" element={<NpcList />} />
            <Route path="/npcs/:id" element={<NpcDetail />} />
            <Route path="/scenarios" element={<ScenarioList />} />
            <Route path="/scenarios/:id" element={<ScenarioDetail />} />
            <Route path="/rules" element={<RulesPage />} />
            <Route path="/dm-settings" element={<DmSettings />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

export default App;
