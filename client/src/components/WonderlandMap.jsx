import { useState } from 'react';
import mapImage from '../assets/wonderland-map.png';

const WONDERLAND_LOCATIONS = [
  {
    id: 'rabbit-warren',
    name: 'The Rabbit Warren',
    subtitle: 'Pool of Tears',
    scenarioId: 'wl-scenario-001',
    scenario: 'Down the Rabbit Hole',
    x: 30,
    y: 20,
    color: '#a855f7',
  },
  {
    id: 'tulgey-wood',
    name: 'The Tulgey Wood',
    subtitle: 'Cheshire Reaches',
    scenarioId: 'wl-scenario-002',
    scenario: 'The Tulgey Wood',
    x: 22,
    y: 52,
    color: '#22c55e',
  },
  {
    id: 'tea-quarter',
    name: 'The Mad Tea Quarter',
    subtitle: 'Broken Clock Tower',
    scenarioId: 'wl-scenario-003',
    scenario: 'A Mad Tea Party',
    x: 70,
    y: 40,
    color: '#f59e0b',
  },
  {
    id: 'queens-domain',
    name: "The Queen's Domain",
    subtitle: 'Palace of Hearts',
    scenarioId: 'wl-scenario-004',
    scenario: "The Queen's Croquet Ground",
    x: 55,
    y: 80,
    color: '#ef4444',
  },
];

const WILDERNESS_STARTS = [
  { x: 50, y: 10, label: 'The Rabbit Hole Entrance' },
  { x: 20, y: 30, label: 'Pool of Tears Shore' },
  { x: 30, y: 42, label: 'Tulgey Wood Edge' },
  { x: 58, y: 50, label: 'Mad Tea Quarter Gates' },
  { x: 50, y: 70, label: "Queen's Garden Walls" },
];

function WonderlandMap({ onLocationClick, interactive = true, partyLocation, compact = false }) {
  const [hoveredId, setHoveredId] = useState(null);

  return (
    <div className={`world-map-container${compact ? ' compact' : ''}`}>
      <div className="world-map-wrapper">
        <img
          src={mapImage}
          alt="Wonderland — Madness in Wonderland"
          className="world-map-image"
          draggable={false}
        />

        {WONDERLAND_LOCATIONS.map(loc => (
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
          <p>Scenario to area mapping:</p>
          <ul className="map-legend-list">
            {WONDERLAND_LOCATIONS.map(loc => (
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

export { WONDERLAND_LOCATIONS, WILDERNESS_STARTS };
export default WonderlandMap;
