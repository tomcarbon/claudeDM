import { useState } from 'react';
import mapImage from '../assets/giants-map.png';

const GIANTS_LOCATIONS = [
  {
    id: 'ravaged-lowlands',
    name: 'The Ravaged Lowlands',
    subtitle: 'Cobbleheap',
    scenarioId: 'sg-scenario-001',
    scenario: 'The Hill Giant Gluttony',
    x: 30,
    y: 45,
    color: '#22c55e',
  },
  {
    id: 'frozen-reaches',
    name: 'The Frozen Reaches',
    subtitle: 'Drifthold',
    scenarioId: 'sg-scenario-002',
    scenario: 'The Ice Jarl',
    x: 55,
    y: 25,
    color: '#3b82f6',
  },
  {
    id: 'ironslag-depths',
    name: 'The Cinderworks Depths',
    subtitle: "Duke Vharkul's Forge",
    scenarioId: 'sg-scenario-003',
    scenario: 'The Gravenmark Rises',
    x: 70,
    y: 65,
    color: '#ef4444',
  },
  {
    id: 'stormreach-above',
    name: 'The Stormreach Above',
    subtitle: 'The Skyfast',
    scenarioId: 'sg-scenario-004',
    scenario: 'The Skyfast',
    x: 45,
    y: 80,
    color: '#a855f7',
  },
];

const WILDERNESS_STARTS = [
  { x: 40, y: 30, label: 'Wainscross' },
  { x: 30, y: 45, label: 'Ravaged Lowlands' },
  { x: 55, y: 25, label: 'Frozen Coast' },
  { x: 50, y: 55, label: 'Cinderworks Approach' },
  { x: 45, y: 75, label: 'Stormreach Tower' },
];

function GiantsMap({ onLocationClick, interactive = true, partyLocation, compact = false }) {
  const [hoveredId, setHoveredId] = useState(null);

  return (
    <div className={`world-map-container${compact ? ' compact' : ''}`}>
      <div className="world-map-wrapper">
        <img
          src={mapImage}
          alt="The Shattered Vaunt — The Cormorant Coast & Far Frontier"
          className="world-map-image"
          draggable={false}
        />

        {GIANTS_LOCATIONS.map(loc => (
          <div
            key={loc.id}
            className={`map-marker${hoveredId === loc.id ? ' hovered' : ''}`}
            style={{
              left: `${loc.x}%`,
              top: `${loc.y}%`,
              '--marker-color': loc.color,
            }}
            onMouseEnter={() => setHoveredId(loc.id)}
            onMouseLeave={() => setHoveredId(null)}
            onClick={() => interactive && onLocationClick?.(loc.scenarioId, loc)}
          >
            <span className="map-marker-dot" />
            <div className="map-marker-label">
              <strong>{loc.name}</strong>
              <span>{loc.subtitle}</span>
              <span className="map-marker-scenario">{loc.scenario}</span>
            </div>
          </div>
        ))}

        {partyLocation && (
          <div
            className="map-party-marker"
            style={{
              left: `${partyLocation.x}%`,
              top: `${partyLocation.y}%`,
            }}
          >
            <span className="map-party-dot" />
            <span className="map-party-label">You are here</span>
          </div>
        )}
      </div>

      {!compact && (
        <div className="map-legend-panel" aria-label="Map key">
          <h3>Key</h3>
          <p>Scenario to region mapping:</p>
          <ul className="map-legend-list">
            {GIANTS_LOCATIONS.map(loc => (
              <li key={`legend-${loc.id}`}>
                <span className="map-legend-swatch" style={{ '--marker-color': loc.color }} />
                <div className="map-legend-text">
                  <strong>{loc.scenario}</strong>
                  <span>
                    {loc.name} - {loc.subtitle}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export { GIANTS_LOCATIONS, WILDERNESS_STARTS };
export default GiantsMap;
