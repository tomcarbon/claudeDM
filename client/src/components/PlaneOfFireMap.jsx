import { useState } from 'react';
import mapImage from '../assets/plane-of-fire-map.png';

// Clickable regions of the Elemental Plane of Fire, wired to campaign5's four scenarios.
// Positions are percentages over the map image, aligned to its four glowing landmarks.
const LOCATIONS = [
  {
    id: 'burning-dust',
    name: 'Plains of Burning Dust',
    subtitle: 'Emberscar Landing',
    scenarioId: 'fp-scenario-001',
    scenario: 'Gate of Ash',
    x: 17,
    y: 26,
    color: '#e8a33d',
  },
  {
    id: 'sea-of-fire',
    name: 'The Sea of Fire',
    subtitle: 'An Ocean That Burns',
    scenarioId: 'fp-scenario-002',
    scenario: 'The Sea of Fire',
    x: 34,
    y: 72,
    color: '#ff5722',
  },
  {
    id: 'city-of-brass',
    name: 'The City of Brass',
    subtitle: 'Throne of the Efreet',
    scenarioId: 'fp-scenario-003',
    scenario: 'The City of Brass',
    x: 74,
    y: 38,
    color: '#e6b422',
  },
  {
    id: 'charred-reach',
    name: 'The Charred Reach',
    subtitle: 'Tomb of the Primordial',
    scenarioId: 'fp-scenario-004',
    scenario: "The Sultan's Flame",
    x: 83,
    y: 78,
    color: '#c0392b',
  },
];

const WILDERNESS_STARTS = [
  { x: 40, y: 30, label: 'Emberscar Landing' },
  { x: 55, y: 40, label: 'Obsidian Mesas' },
  { x: 45, y: 55, label: 'Shore of the Sea of Fire' },
  { x: 62, y: 60, label: 'Approach to the City of Brass' },
  { x: 72, y: 78, label: 'The Charred Reach' },
];

function PlaneOfFireMap({ onLocationClick, interactive = true, partyLocation, compact = false }) {
  const [hoveredId, setHoveredId] = useState(null);

  return (
    <div className={`world-map-container${compact ? ' compact' : ''}`}>
      <div className="world-map-wrapper">
        <img
          src={mapImage}
          alt="The Elemental Plane of Fire — a blazing plane of ash wastes, molten seas, and the City of Brass"
          className="world-map-image"
          draggable={false}
        />

        {/* Region markers (reuse the app's shared map-marker styling) */}
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

        {partyLocation && (
          <div
            className="map-party-marker"
            style={{ left: `${partyLocation.x}%`, top: `${partyLocation.y}%` }}
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
export default PlaneOfFireMap;
