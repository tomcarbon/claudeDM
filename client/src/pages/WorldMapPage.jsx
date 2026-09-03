import { useNavigate } from 'react-router-dom';
import { useCampaign } from '../context/CampaignContext';
import WorldMap from '../components/WorldMap';
import UnderdarkMap from '../components/UnderdarkMap';
import WonderlandMap from '../components/WonderlandMap';
import GiantsMap from '../components/GiantsMap';
import CrimsonThroneMap from '../components/CrimsonThroneMap';
import AstralMap from '../components/AstralMap';
import NihonMap from '../components/NihonMap';
import PlaneOfFireMap from '../components/PlaneOfFireMap';

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

  if (campaignId === 'campaign3') {
    return (
      <div>
        <h2>The Shattered Vaunt</h2>
        <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem', marginBottom: '1rem' }}>
          The Cormorant Coast trembles as the Vaunting shatters and giantkind wages war. Click a region to view its scenario.
        </p>
        <GiantsMap onLocationClick={handleLocationClick} />
      </div>
    );
  }

  if (campaignId === 'wonderland') {
    return (
      <div>
        <h2>Wonderland</h2>
        <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem', marginBottom: '1rem' }}>
          A Feywild demiplane of impossible geography, where logic bends and madness wears a crown. Click a location to view its scenario.
        </p>
        <WonderlandMap onLocationClick={handleLocationClick} />
      </div>
    );
  }

  if (campaignId === 'campaign2') {
    return (
      <div>
        <h2>Vermeil — Seat of the Crimson Throne</h2>
        <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem', marginBottom: '1rem' }}>
          A crumbling imperial capital where scheming houses and a blood-cult fight over an heirless throne. Click a district to view its scenario.
        </p>
        <CrimsonThroneMap onLocationClick={handleLocationClick} />
      </div>
    );
  }

  if (campaignId === 'campaign4') {
    return (
      <div>
        <h2>The Astral Sea</h2>
        <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem', marginBottom: '1rem' }}>
          Beyond the material plane: silver voids, dead gods, and the gathering Convergence. Click a region to view its scenario.
        </p>
        <AstralMap onLocationClick={handleLocationClick} />
      </div>
    );
  }

  if (campaignId === 'nihon') {
    return (
      <div>
        <h2>Hinomoto — The Floating World</h2>
        <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem', marginBottom: '1rem' }}>
          The mythic Land of the Rising Sun, drawn true to the real geography of Japan — from Itsukushima on the Inland Sea to Edo in the east. Browse adventures on the Scenarios page. ⛩️
        </p>
        <NihonMap />
      </div>
    );
  }

  if (campaignId === 'campaign5') {
    return (
      <div>
        <h2>The Elemental Plane of Fire 🔥</h2>
        <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem', marginBottom: '1rem' }}>
          A blazing plane of ash wastes and molten seas, crowned by the City of Brass. Click a region to view its scenario.
        </p>
        <PlaneOfFireMap onLocationClick={handleLocationClick} />
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
