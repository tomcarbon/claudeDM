import { CHANGELOG, CURRENT_VERSION } from '../data/changelog';

function WhatsNew() {
  return (
    <div>
      <h2>What&apos;s New</h2>
      <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 1.5rem' }}>
        Current version: <strong>v{CURRENT_VERSION}</strong>
      </p>

      {CHANGELOG.map((entry) => (
        <div key={entry.version} className="detail-section">
          <h3>
            v{entry.version} - {entry.title}
          </h3>
          <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 1rem' }}>
            {entry.date}
            {entry.compareFrom ? ` · changes since v${entry.compareFrom}` : ''}
            {entry.compareRef ? ` · ${entry.compareRef}` : ''}
          </p>
          <ul style={{ marginLeft: '1.25rem' }}>
            {entry.highlights.map((item) => (
              <li key={item} style={{ marginBottom: '0.4rem' }}>{item}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export default WhatsNew;
