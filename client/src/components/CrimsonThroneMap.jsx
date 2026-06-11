import { useState } from 'react';
import mapImage from '../assets/crimson-throne-map.png';

const LOCATIONS = [
  {
    id: 'old-quarter',
    name: 'The Old Quarter',
    subtitle: 'The Shamble — Ash and Ruin',
    scenarioId: 'ct-scenario-001',
    scenario: 'Ashes of the Old Quarter',
    // Percentage positions on the map image
    x: 38,
    y: 70,
    color: '#e67e22',
  },
  {
    id: 'gilded-reach',
    name: 'The Gilded Reach',
    subtitle: 'District of the Noble Houses',
    scenarioId: 'ct-scenario-002',
    scenario: 'The Masque of Knives',
    x: 30,
    y: 40,
    color: '#f1c40f',
  },
  {
    id: 'sanguine-cathedral',
    name: 'The Sanguine Cathedral',
    subtitle: 'Seat of the Blood-Cult',
    scenarioId: 'ct-scenario-003',
    scenario: 'The Crimson Communion',
    x: 68,
    y: 45,
    color: '#e74c3c',
  },
  {
    id: 'vermeil-keep',
    name: 'Vermeil Keep',
    subtitle: 'The Heirless Throne',
    scenarioId: 'ct-scenario-004',
    scenario: 'The Throne of Thorns',
    x: 50,
    y: 22,
    color: '#8b5cf6',
  },
];

// Random wilderness starting points (percentage positions — city districts)
const WILDERNESS_STARTS = [
  { x: 38, y: 70, label: 'The Shamble — Drowned Cat Tavern' },
  { x: 52, y: 58, label: "The Thieves' Market" },
  { x: 30, y: 40, label: 'The Gilded Reach' },
  { x: 68, y: 45, label: 'Steps of the Sanguine Cathedral' },
  { x: 50, y: 22, label: 'Gates of Vermeil Keep' },
];

function CrimsonThroneMap({ onLocationClick, interactive = true, partyLocation, compact = false }) {
  const [hoveredId, setHoveredId] = useState(null);

  return (
    <div className={`world-map-container${compact ? ' compact' : ''}`}>
      <div className="world-map-wrapper">
        <img
          src={mapImage}
          alt="Vermeil — Seat of the Crimson Throne"
          className="world-map-image"
          draggable={false}
        />

        {/* Location markers */}
        {LOCATIONS.map(loc => (
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

        {/* Party location indicator */}
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
          <p>Scenario to district mapping:</p>
          <ul className="map-legend-list">
            {LOCATIONS.map(loc => (
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

export { LOCATIONS, WILDERNESS_STARTS };
export default CrimsonThroneMap;
