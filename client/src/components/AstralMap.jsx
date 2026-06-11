import { useState } from 'react';
import mapImage from '../assets/astral-map.png';

const LOCATIONS = [
  {
    id: 'threshold-citadel',
    name: 'Threshold Citadel',
    subtitle: 'Fortress at the Torn Veil',
    scenarioId: 'ac-scenario-001',
    scenario: 'The Shattered Veil',
    // Percentage positions on the map image
    x: 50,
    y: 20,
    color: '#60a5fa',
  },
  {
    id: 'dead-gods-cradle',
    name: "The Dead God's Cradle",
    subtitle: 'A Colossus Adrift',
    scenarioId: 'ac-scenario-002',
    scenario: "The Dead God's Dream",
    x: 60,
    y: 50,
    color: '#f1c40f',
  },
  {
    id: 'planar-crucible',
    name: 'The Planar Crucible',
    subtitle: 'Where the Planes Collide',
    scenarioId: 'ac-scenario-003',
    scenario: 'The Planar Crucible',
    x: 40,
    y: 65,
    color: '#e74c3c',
  },
  {
    id: 'spire-of-echoes',
    name: 'The Spire of Echoes',
    subtitle: 'Needle of the Convergence',
    scenarioId: 'ac-scenario-004',
    scenario: 'The Confluence Ascending',
    x: 50,
    y: 85,
    color: '#8b5cf6',
  },
];

// Random wilderness starting points (percentage positions — drifts of the Astral Sea)
const WILDERNESS_STARTS = [
  { x: 50, y: 20, label: 'Threshold Citadel' },
  { x: 30, y: 40, label: 'Silver Wastes Drift' },
  { x: 60, y: 50, label: "Dead God's Cradle" },
  { x: 40, y: 65, label: 'Planar Crucible Edge' },
  { x: 50, y: 85, label: 'Spire of Echoes Approach' },
];

function AstralMap({ onLocationClick, interactive = true, partyLocation, compact = false }) {
  const [hoveredId, setHoveredId] = useState(null);

  return (
    <div className={`world-map-container${compact ? ' compact' : ''}`}>
      <div className="world-map-wrapper">
        <img
          src={mapImage}
          alt="The Astral Sea — Charts of the Convergence"
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
          <p>Scenario to region mapping:</p>
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
export default AstralMap;
