import { useState, useEffect } from 'react';
import { api } from '../api/client';

function RulesPage() {
  const [categories, setCategories] = useState([]);
  const [selected, setSelected] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingRule, setLoadingRule] = useState(false);

  useEffect(() => {
    api.getRuleCategories()
      .then(cats => {
        setCategories(cats);
        if (cats.length > 0) selectCategory(cats[0]);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const selectCategory = (cat) => {
    setSelected(cat);
    setLoadingRule(true);
    api.getRule(cat)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoadingRule(false));
  };

  const formatLabel = (s) => s.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  if (loading) return <div className="loading">Loading rules...</div>;

  return (
    <div>
      <h2>Rules Reference</h2>
      <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 1rem' }}>
        D&D 5th Edition rules database. Select a category below.
      </p>

      <div className="rules-nav">
        {categories.map(cat => (
          <button
            key={cat}
            className={selected === cat ? 'active' : ''}
            onClick={() => selectCategory(cat)}
          >
            {formatLabel(cat)}
          </button>
        ))}
      </div>

      <div className="rules-content">
        {loadingRule ? (
          <div className="loading">Loading...</div>
        ) : data ? (
          <RuleViewer data={data} />
        ) : (
          <div className="error">No data available</div>
        )}
      </div>
    </div>
  );
}

function RuleViewer({ data }) {
  if (Array.isArray(data)) {
    return (
      <div>
        {data.map((item, i) => (
          <RuleItem key={i} item={item} />
        ))}
      </div>
    );
  }
  if (typeof data === 'object') {
    return (
      <div>
        {Object.entries(data).map(([key, value]) => (
          <div key={key} className="card" style={{ marginBottom: '0.75rem' }}>
            <h3 style={{ fontSize: '1em', marginBottom: '0.5rem' }}>
              {key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
            </h3>
            {typeof value === 'string' ? (
              <p style={{ fontSize: '0.9em' }}>{value}</p>
            ) : Array.isArray(value) ? (
              <div>
                {value.map((item, i) => (
                  <RuleItem key={i} item={item} />
                ))}
              </div>
            ) : (
              <pre>{JSON.stringify(value, null, 2)}</pre>
            )}
          </div>
        ))}
      </div>
    );
  }
  return <pre>{JSON.stringify(data, null, 2)}</pre>;
}

function RuleItem({ item }) {
  const [expanded, setExpanded] = useState(false);

  if (typeof item === 'string') {
    return <span className="tag">{item}</span>;
  }

  const name = item.name || item.title || Object.values(item).find(v => typeof v === 'string') || 'Item';

  return (
    <div className="card" style={{ padding: '0.75rem', marginBottom: '0.5rem' }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <strong>{name}</strong>
        <span style={{ color: 'var(--text-muted)' }}>{expanded ? '▼' : '▶'}</span>
      </div>
      {expanded && (
        <pre style={{ marginTop: '0.5rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {JSON.stringify(item, null, 2)}
        </pre>
      )}
    </div>
  );
}

export default RulesPage;
