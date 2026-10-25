// A campaign map drawn from data rather than painted (WO-0040). Sci-Fi and Noir campaigns list their places
// in campaign.json `mapLocations` ({ id, name, subtitle, scenarioId, x, y, color }, x/y in percent);
// the server allowlists those fields before they reach here. Pins linked to a scenario are buttons;
// the rest are labels. A dashed route joins the scenario pins in campaign order.
const FALLBACK_COLORS = ['#38bdf8', '#f97316', '#a3e635', '#e879f9', '#facc15', '#f87171'];

function SchematicMap({ locations, linkedScenarios = [], onLocationClick }) {
  const pins = (locations || []).map((loc, i) => ({ ...loc, color: loc.color || FALLBACK_COLORS[i % FALLBACK_COLORS.length] }));
  const order = (id) => {
    const i = linkedScenarios.indexOf(id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const route = pins.filter(p => p.scenarioId).sort((a, b) => order(a.scenarioId) - order(b.scenarioId));

  return (
    <div>
      <div className="schematic-map">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {route.slice(1).map((p, i) => (
            <line
              key={p.id}
              x1={route[i].x} y1={route[i].y} x2={p.x} y2={p.y}
              stroke="currentColor" strokeOpacity="0.45" strokeWidth="0.4" strokeDasharray="1.5 1.2"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        {pins.map(pin => {
          const clickable = !!(pin.scenarioId && onLocationClick);
          const Tag = clickable ? 'button' : 'div';
          return (
            <Tag
              key={pin.id}
              className={`schematic-pin${clickable ? ' clickable' : ''}`}
              style={{ left: `${pin.x}%`, top: `${pin.y}%` }}
              onClick={clickable ? () => onLocationClick(pin.scenarioId) : undefined}
              title={pin.subtitle || pin.name}
            >
              <span className="schematic-pin-dot" style={{ background: pin.color }} />
              <span className="schematic-pin-name">{pin.name}</span>
              {pin.subtitle && <span className="schematic-pin-sub">{pin.subtitle}</span>}
            </Tag>
          );
        })}
      </div>
      <div className="schematic-legend">
        {route.map((pin, i) => (
          <button key={pin.id} className="card" style={{ textAlign: 'left', cursor: onLocationClick ? 'pointer' : 'default' }}
            onClick={onLocationClick ? () => onLocationClick(pin.scenarioId) : undefined}>
            <strong style={{ color: pin.color }}>{i + 1}. {pin.name}</strong>
            {pin.subtitle && <div style={{ fontSize: '0.85em', color: 'var(--text-muted)' }}>{pin.subtitle}</div>}
          </button>
        ))}
      </div>
    </div>
  );
}

export default SchematicMap;
