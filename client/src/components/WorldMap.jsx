import { useState } from 'react';
import mapImage from '../assets/shattered-coast.png';

const LOCATIONS = [
  {
    id: 'saltmere',
    name: 'Saltmere',
    subtitle: 'City of Tides',
    scenarioId: 'b7d4f2a1-8c3e-4f9b-a1d5-2e6f8b0c3d7a',
    scenario: 'The Festival of Masks',
    // Percentage positions on the map image
    x: 18,
    y: 73,
    color: '#e74c3c',
  },
  {
    id: 'thornfield',
    name: 'Thornfield',
    subtitle: 'The Whisperwood',
    scenarioId: 'c9e5a3b2-1d7f-4a6c-b8e2-3f9d0c4e6a1b',
    scenario: 'Wolves of the Wyldwood',
    x: 19,
    y: 38,
    color: '#f1c40f',
  },
  {
    id: 'whisperhollow',
    name: 'Whisperhollow',
    subtitle: 'Silver Mine',
    scenarioId: 'a3c7e1f0-4b2d-4e8a-9f6c-1d3e5a7b9c0e',
    scenario: 'The Lost Mine of Whisperhollow',
    x: 64,
    y: 24,
    color: '#27ae60',
  },
  {
    id: 'brinewatch',
    name: 'Brinewatch',
    subtitle: "Talonspire's Deep",
    scenarioId: 'd1f6b4c3-2e8a-4d7b-c9f3-4a0e1b5d7c2f',
    scenario: 'The Sunken Temple of Tidecaller',
    x: 77,
    y: 72,
    color: '#2980b9',
  },
];

// Random wilderness starting points (percentage positions — between settlements)
const WILDERNESS_STARTS = [
  { x: 40, y: 45, label: 'Central Grasslands' },
  { x: 35, y: 60, label: 'Southern Plains' },
  { x: 50, y: 35, label: 'Northern Foothills' },
  { x: 30, y: 50, label: 'Western Crossroads' },
  { x: 55, y: 55, label: 'Eastern Trail' },
];

function WorldMap({ onLocationClick, interactive = true, partyLocation, compact = false }) {
  const [hoveredId, setHoveredId] = useState(null);

  return (
    <div className={`world-map-container${compact ? ' compact' : ''}`}>
      <div className="world-map-wrapper">
        <img
          src={mapImage}
          alt="The Shattered Coast — Realms of Adventure"
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

        <div className="map-crossroads-label" style={{ left: '49%', top: '49%' }}>
          <strong>Crossroads</strong>
          <span>Central Junction</span>
        </div>
      </div>

      {!compact && (
        <div className="map-legend-panel" aria-label="Updated map key">
          <h3>Updated Key</h3>
          <p>Scenario to area mapping:</p>
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
export default WorldMap;
