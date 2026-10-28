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
import SchematicMap from '../components/SchematicMap';
import { categoryOf } from '../utils/gameCategories';
import { SHOW_SCENARIO_LINKS } from '../utils/features';

// WO-0050 revision 4, Part D. The map pins used to navigate to /scenarios/:id, and the page text
// said "Click a location to view its scenario". Both are hidden with the other scenario links while
// SHOW_SCENARIO_LINKS (utils/features.js) is false: no handler is passed to any map, so a pin click
// does nothing, and the wording that points at the scenario pages is left out. The routes and pages
// are kept. Set the flag to true and every line below behaves exactly as it did before.
// (Previous wording, kept for history: each description ended "Click a location/region/district to
// view its scenario."; the non-fantasy fallback and Hinomoto said "Browse … on the Scenarios page.")
function scenarioHint(text) {
  return SHOW_SCENARIO_LINKS ? text : '';
}

function WorldMapPage() {
  const navigate = useNavigate();
  const { campaignId, campaign } = useCampaign();

  function navigateToScenario(scenarioId) {
    navigate(`/scenarios/${scenarioId}`);
  }
  const handleLocationClick = SHOW_SCENARIO_LINKS ? navigateToScenario : undefined;
  const mapClass = SHOW_SCENARIO_LINKS ? undefined : 'map-links-off';

  // Data-drawn map for any campaign that lists its places (WO-0040). Checked first so a campaign
  // never falls through to another campaign's painted map below.
  if (campaign && Array.isArray(campaign.mapLocations) && campaign.mapLocations.length > 0) {
    return (
      <div className={mapClass}>
        <h2>{campaign.title}</h2>
        <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem', marginBottom: '1rem' }}>
          {campaign.subtitle ? `${campaign.subtitle}.` : ''}{scenarioHint(`${campaign.subtitle ? ' ' : ''}Click a location to view its scenario.`)}
        </p>
        <SchematicMap locations={campaign.mapLocations} linkedScenarios={campaign.linkedScenarios || []} onLocationClick={handleLocationClick} />
      </div>
    );
  }

  if (campaign && categoryOf(campaign) !== 'fantasy') {
    return (
      <div className={mapClass}>
        <h2>{campaign.title}</h2>
        <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem' }}>
          This campaign has no map yet.{scenarioHint(' Browse its adventures on the Scenarios page.')}
        </p>
      </div>
    );
  }

  if (campaignId === 'campaign1') {
    return (
      <div className={mapClass}>
        <h2>The Underdark</h2>
        <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem', marginBottom: '1rem' }}>
          A vast subterranean realm of darkness, danger, and alien beauty.{scenarioHint(' Click a location to view its scenario.')}
        </p>
        <UnderdarkMap onLocationClick={handleLocationClick} />
      </div>
    );
  }

  if (campaignId === 'campaign3') {
    return (
      <div className={mapClass}>
        <h2>The Shattered Vaunt</h2>
        <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem', marginBottom: '1rem' }}>
          The Cormorant Coast trembles as the Vaunting shatters and giantkind wages war.{scenarioHint(' Click a region to view its scenario.')}
        </p>
        <GiantsMap onLocationClick={handleLocationClick} />
      </div>
    );
  }

  if (campaignId === 'wonderland') {
    return (
      <div className={mapClass}>
        <h2>Wonderland</h2>
        <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem', marginBottom: '1rem' }}>
          A Feywild demiplane of impossible geography, where logic bends and madness wears a crown.{scenarioHint(' Click a location to view its scenario.')}
        </p>
        <WonderlandMap onLocationClick={handleLocationClick} />
      </div>
    );
  }

  if (campaignId === 'campaign2') {
    return (
      <div className={mapClass}>
        <h2>Vermeil — Seat of the Crimson Throne</h2>
        <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem', marginBottom: '1rem' }}>
          A crumbling imperial capital where scheming houses and a blood-cult fight over an heirless throne.{scenarioHint(' Click a district to view its scenario.')}
        </p>
        <CrimsonThroneMap onLocationClick={handleLocationClick} />
      </div>
    );
  }

  if (campaignId === 'campaign4') {
    return (
      <div className={mapClass}>
        <h2>The Astral Sea</h2>
        <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem', marginBottom: '1rem' }}>
          Beyond the material plane: silver voids, dead gods, and the gathering Convergence.{scenarioHint(' Click a region to view its scenario.')}
        </p>
        <AstralMap onLocationClick={handleLocationClick} />
      </div>
    );
  }

  if (campaignId === 'nihon') {
    return (
      <div className={mapClass}>
        <h2>Hinomoto — The Floating World</h2>
        <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem', marginBottom: '1rem' }}>
          The mythic Land of the Rising Sun, drawn true to the real geography of Japan — from Itsukushima on the Inland Sea to Edo in the east.{scenarioHint(' Browse adventures on the Scenarios page.')} ⛩️
        </p>
        <NihonMap />
      </div>
    );
  }

  if (campaignId === 'campaign5') {
    return (
      <div className={mapClass}>
        <h2>The Elemental Plane of Fire 🔥</h2>
        <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem', marginBottom: '1rem' }}>
          A blazing plane of ash wastes and molten seas, crowned by the City of Brass.{scenarioHint(' Click a region to view its scenario.')}
        </p>
        <PlaneOfFireMap onLocationClick={handleLocationClick} />
      </div>
    );
  }

  return (
    <div className={mapClass}>
      <h2>The Shattered Coast</h2>
      {SHOW_SCENARIO_LINKS && (
        <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem', marginBottom: '1rem' }}>
          Click a location to view its scenario details.
        </p>
      )}
      <WorldMap onLocationClick={handleLocationClick} />
    </div>
  );
}

export default WorldMapPage;
