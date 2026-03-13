import { useState } from 'react';
import mapImage from '../assets/underdark-map.png';

const UNDERDARK_LOCATIONS = [
  {
    id: 'fungal-caverns',
    name: 'The Fungal Caverns',
    subtitle: 'Bioluminescent Depths',
    scenarioId: 'ud-scenario-001',
    scenario: 'The Fungal Caverns',
    x: 30,
    y: 25,
    color: '#22c55e',
  },
  {
    id: 'drow-outpost',
    name: 'Drow Territories',
    subtitle: 'House Despana Outpost',
    scenarioId: 'ud-scenario-002',
    scenario: 'The Drow Outpost',
    x: 65,
    y: 35,
    color: '#8b5cf6',
  },
  {
    id: 'sunless-sea',
    name: 'The Sunless Sea',
    subtitle: 'Underground Ocean',
    scenarioId: 'ud-scenario-003',
    scenario: 'The Sunless Sea',
    x: 40,
    y: 60,
    color: '#3b82f6',
  },
  {
    id: 'illithid-enclave',
    name: "The Elder Brain's Domain",
    subtitle: 'Illithid Enclave',
    scenarioId: 'ud-scenario-004',
    scenario: "The Elder Brain's Domain",
    x: 70,
    y: 75,
    color: '#ef4444',
  },
];

const WILDERNESS_STARTS = [
  { x: 45, y: 15, label: 'Upper Cavern Entrance' },
  { x: 25, y: 45, label: 'Fungal Passage' },
  { x: 55, y: 50, label: 'Dark Crossroads' },
  { x: 50, y: 85, label: 'Deep Tunnels' },
];

function UnderdarkMap({ onLocationClick, interactive = true, partyLocation, compact = false }) {
  const [hoveredId, setHoveredId] = useState(null);

  return (
    <div className={`world-map-container${compact ? ' compact' : ''}`}>
      <div className="world-map-wrapper">
        <img
          src={mapImage}
          alt="The Underdark — Depths of Darkness"
          className="world-map-image"
          draggable={false}
        />

        {UNDERDARK_LOCATIONS.map(loc => (
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
            {UNDERDARK_LOCATIONS.map(loc => (
              <li key={`legend-${loc.id}`}>
                <span className="map-legend-swatch" style={{ '--marker-color': loc.color }} />
                <div className="map-legend-text">
                  <strong>{loc.scenario}</strong>
                  <span>{loc.name} - {loc.subtitle}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export { UNDERDARK_LOCATIONS, WILDERNESS_STARTS };
export default UnderdarkMap;
