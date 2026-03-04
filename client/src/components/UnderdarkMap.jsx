import { useState } from 'react';

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

function UnderdarkMap({ onLocationClick, interactive = true }) {
  const [hoveredId, setHoveredId] = useState(null);

  return (
    <div className="world-map-container">
      <div className="world-map-wrapper" style={{ background: '#0a0a1a', borderRadius: '12px', position: 'relative', minHeight: '500px' }}>
        {/* SVG background depicting underground caverns */}
        <svg viewBox="0 0 800 500" style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0 }}>
          {/* Cavern walls */}
          <defs>
            <radialGradient id="glow-green" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#22c55e" stopOpacity="0.3" />
              <stop offset="100%" stopColor="#22c55e" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="glow-purple" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.3" />
              <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="glow-blue" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.3" />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="glow-red" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#ef4444" stopOpacity="0.3" />
              <stop offset="100%" stopColor="#ef4444" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* Cave texture - rough walls */}
          <path d="M0 0 L800 0 L800 500 L0 500 Z" fill="#0a0a1a" />
          <path d="M50 30 Q200 10, 350 40 Q500 70, 650 30 Q750 10, 800 50 L800 0 L0 0 Z" fill="#141428" opacity="0.8" />
          <path d="M0 450 Q150 480, 300 460 Q450 440, 600 470 Q700 490, 800 460 L800 500 L0 500 Z" fill="#141428" opacity="0.8" />

          {/* Connecting tunnels */}
          <path d="M240 125 Q350 180, 520 175" stroke="#1e1e3a" strokeWidth="20" fill="none" strokeLinecap="round" opacity="0.6" />
          <path d="M240 125 Q280 230, 320 300" stroke="#1e1e3a" strokeWidth="20" fill="none" strokeLinecap="round" opacity="0.6" />
          <path d="M520 175 Q540 280, 560 375" stroke="#1e1e3a" strokeWidth="20" fill="none" strokeLinecap="round" opacity="0.6" />
          <path d="M320 300 Q420 340, 560 375" stroke="#1e1e3a" strokeWidth="20" fill="none" strokeLinecap="round" opacity="0.6" />

          {/* Bioluminescent glow areas */}
          <circle cx="240" cy="125" r="80" fill="url(#glow-green)" />
          <circle cx="520" cy="175" r="80" fill="url(#glow-purple)" />
          <circle cx="320" cy="300" r="80" fill="url(#glow-blue)" />
          <circle cx="560" cy="375" r="80" fill="url(#glow-red)" />

          {/* Small fungi dots */}
          {[...Array(30)].map((_, i) => (
            <circle
              key={i}
              cx={50 + Math.random() * 700}
              cy={30 + Math.random() * 440}
              r={1 + Math.random() * 2}
              fill={['#22c55e', '#8b5cf6', '#3b82f6', '#06b6d4'][i % 4]}
              opacity={0.2 + Math.random() * 0.3}
            />
          ))}

          {/* Stalactites */}
          {[80, 200, 380, 500, 670, 750].map((x, i) => (
            <polygon
              key={`stal-${i}`}
              points={`${x-4},0 ${x+4},0 ${x},${15 + (i%3)*8}`}
              fill="#1e1e3a"
              opacity="0.7"
            />
          ))}

          {/* Underground water */}
          <ellipse cx="320" cy="310" rx="60" ry="25" fill="#1e3a5a" opacity="0.4" />
        </svg>

        {/* Location markers */}
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

        {/* Title overlay */}
        <div style={{
          position: 'absolute', top: '10px', left: '50%', transform: 'translateX(-50%)',
          color: '#8b5cf6', fontFamily: 'serif', fontSize: '1.2rem', fontWeight: 'bold',
          textShadow: '0 0 10px rgba(139, 92, 246, 0.5)', letterSpacing: '0.1em',
          whiteSpace: 'nowrap',
        }}>
          THE UNDERDARK
        </div>

        {/* Depth indicator */}
        <div style={{
          position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px',
          color: '#666', fontSize: '0.7rem',
        }}>
          <span>Surface</span>
          <div style={{ width: '2px', height: '80px', background: 'linear-gradient(to bottom, #444, #222)' }} />
          <span>Deep</span>
        </div>
      </div>

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
    </div>
  );
}

export default UnderdarkMap;
