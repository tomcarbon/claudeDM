import { useState } from 'react';

// Clickable regions of the Elemental Plane of Fire, wired to campaign5's four scenarios.
// Positions are percentages over the inline-SVG backdrop below.
const LOCATIONS = [
  {
    id: 'burning-dust',
    name: 'Plains of Burning Dust',
    subtitle: 'Emberscar Landing',
    scenarioId: 'fp-scenario-001',
    scenario: 'Gate of Ash',
    x: 20,
    y: 30,
    color: '#e8a33d',
  },
  {
    id: 'sea-of-fire',
    name: 'The Sea of Fire',
    subtitle: 'An Ocean That Burns',
    scenarioId: 'fp-scenario-002',
    scenario: 'The Sea of Fire',
    x: 43,
    y: 63,
    color: '#ff5722',
  },
  {
    id: 'city-of-brass',
    name: 'The City of Brass',
    subtitle: 'Throne of the Efreet',
    scenarioId: 'fp-scenario-003',
    scenario: 'The City of Brass',
    x: 68,
    y: 44,
    color: '#e6b422',
  },
  {
    id: 'charred-reach',
    name: 'The Charred Reach',
    subtitle: 'Tomb of the Primordial',
    scenarioId: 'fp-scenario-004',
    scenario: "The Sultan's Flame",
    x: 85,
    y: 76,
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
        {/* Inline SVG backdrop — no external asset, renders in light and dark alike */}
        <svg
          className="world-map-image"
          viewBox="0 0 1000 640"
          preserveAspectRatio="xMidYMid slice"
          role="img"
          aria-label="The Elemental Plane of Fire — a blazing plane of ash wastes, molten seas, and the City of Brass"
          style={{ width: '100%', height: 'auto', display: 'block' }}
        >
          <defs>
            <linearGradient id="fp-sky" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2b0900" />
              <stop offset="45%" stopColor="#7a1500" />
              <stop offset="100%" stopColor="#c0330a" />
            </linearGradient>
            <linearGradient id="fp-ash" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3a281f" />
              <stop offset="100%" stopColor="#5c3a24" />
            </linearGradient>
            <radialGradient id="fp-lava" cx="50%" cy="50%" r="65%">
              <stop offset="0%" stopColor="#ffd23f" />
              <stop offset="40%" stopColor="#ff7a18" />
              <stop offset="100%" stopColor="#8a1c00" />
            </radialGradient>
            <radialGradient id="fp-sun" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#ffe9a8" />
              <stop offset="55%" stopColor="#ff9d3c" stopOpacity="0.8" />
              <stop offset="100%" stopColor="#ff9d3c" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="fp-brass" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#f6d67a" />
              <stop offset="50%" stopColor="#d4a017" />
              <stop offset="100%" stopColor="#8a6a10" />
            </linearGradient>
            <radialGradient id="fp-caldera" cx="50%" cy="45%" r="60%">
              <stop offset="0%" stopColor="#ff6a2b" />
              <stop offset="35%" stopColor="#7a2e2e" />
              <stop offset="100%" stopColor="#1a0a0a" />
            </radialGradient>
          </defs>

          {/* Burning sky */}
          <rect x="0" y="0" width="1000" height="640" fill="url(#fp-sky)" />
          <circle cx="500" cy="120" r="260" fill="url(#fp-sun)" />

          {/* Ash plains sweeping across the middle-lower plane */}
          <path
            d="M0,300 C220,250 430,330 640,300 C800,278 920,320 1000,300 L1000,640 L0,640 Z"
            fill="url(#fp-ash)"
          />

          {/* Obsidian mesas on the plains */}
          <polygon points="150,300 200,235 250,300" fill="#241a15" opacity="0.85" />
          <polygon points="250,315 300,255 355,315" fill="#1c1310" opacity="0.85" />

          {/* The Sea of Fire — a molten ocean pooling lower-center */}
          <path
            d="M120,470 C260,415 470,430 560,500 C640,560 470,620 320,615 C190,611 70,560 120,470 Z"
            fill="url(#fp-lava)"
          />
          <path
            d="M200,500 C300,478 430,486 500,520"
            fill="none"
            stroke="#fff2c2"
            strokeWidth="4"
            opacity="0.55"
            strokeLinecap="round"
          />

          {/* The City of Brass — a brass disc riding above the fire */}
          <ellipse cx="690" cy="300" rx="150" ry="46" fill="#000" opacity="0.25" />
          <ellipse cx="680" cy="282" rx="150" ry="52" fill="url(#fp-brass)" stroke="#5c4708" strokeWidth="3" />
          {/* brass spires */}
          <polygon points="620,282 634,205 648,282" fill="url(#fp-brass)" stroke="#5c4708" strokeWidth="1.5" />
          <polygon points="668,282 686,182 704,282" fill="url(#fp-brass)" stroke="#5c4708" strokeWidth="1.5" />
          <polygon points="718,282 732,222 746,282" fill="url(#fp-brass)" stroke="#5c4708" strokeWidth="1.5" />

          {/* The Charred Reach — a primordial's caldera in the deep fire */}
          <ellipse cx="855" cy="500" rx="130" ry="96" fill="url(#fp-caldera)" stroke="#2a0f0f" strokeWidth="4" />
          <ellipse cx="855" cy="492" rx="52" ry="34" fill="#ffbf47" opacity="0.9" />

          {/* Drifting embers */}
          {[
            [120, 180], [300, 140], [470, 200], [640, 150], [820, 120], [910, 210],
            [180, 400], [560, 380], [760, 430], [400, 300],
          ].map(([cx, cy], i) => (
            <circle key={i} cx={cx} cy={cy} r={i % 3 === 0 ? 3 : 2} fill="#ffcf6b" opacity="0.75" />
          ))}
        </svg>

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
