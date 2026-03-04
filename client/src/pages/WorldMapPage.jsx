import { useNavigate } from 'react-router-dom';
import { useCampaign } from '../context/CampaignContext';
import WorldMap from '../components/WorldMap';
import UnderdarkMap from '../components/UnderdarkMap';

function WorldMapPage() {
  const navigate = useNavigate();
  const { campaignId } = useCampaign();

  function handleLocationClick(scenarioId) {
    navigate(`/scenarios/${scenarioId}`);
  }

  if (campaignId === 'campaign1') {
    return (
      <div>
        <h2>The Underdark</h2>
        <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem', marginBottom: '1rem' }}>
          A vast subterranean realm of darkness, danger, and alien beauty. Click a location to view its scenario.
        </p>
        <UnderdarkMap onLocationClick={handleLocationClick} />
      </div>
    );
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
