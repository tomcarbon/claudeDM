import mapImage from '../assets/nihon-map.png';

// Hinomoto is drawn geographically accurate to real Japan, with all place labels
// rendered in the artwork itself — there are no clickable scenario hotspots on this
// map (scenarios are browsed from the Scenarios page instead).
//
// Wilderness starting points (percentage positions on the map image). Only the
// labels are consumed elsewhere today, but the coordinates track the drawn art.
const WILDERNESS_STARTS = [
  { x: 44, y: 52, label: 'The Torii Road into Heian-kyō' },
  { x: 47, y: 55, label: 'Kasuga Deer Park' },
  { x: 62, y: 42, label: 'The Gates of Edo' },
  { x: 58, y: 45, label: 'Hakone Hot-Spring Vale' },
  { x: 30, y: 60, label: 'The Floating Torii of Itsukushima' },
];

function NihonMap({ partyLocation, compact = false }) {
  return (
    <div className={`world-map-container${compact ? ' compact' : ''}`}>
      <div className="world-map-wrapper">
        <img
          src={mapImage}
          alt="Hinomoto — The Floating World"
          className="world-map-image"
          draggable={false}
        />

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
    </div>
  );
}

export { WILDERNESS_STARTS };
export default NihonMap;
