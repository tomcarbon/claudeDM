import { useNavigate } from 'react-router-dom';
import WorldMap from '../components/WorldMap';

function WorldMapPage() {
  const navigate = useNavigate();

  function handleLocationClick(scenarioId) {
    navigate(`/scenarios/${scenarioId}`);
  }

  return (
    <div>
      <h2>The Shattered Coast</h2>
      <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem', marginBottom: '1rem' }}>
        Click a location to view its scenario details.
      </p>
      <WorldMap onLocationClick={handleLocationClick} />
    </div>
  );
}

export default WorldMapPage;
