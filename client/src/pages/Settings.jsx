import { useState } from 'react';
import { api } from '../api/client';

function Settings() {
  const [restoring, setRestoring] = useState(false);
  const [restored, setRestored] = useState(false);

  const handleRestore = async () => {
    if (!window.confirm('Are you sure you want to restore all data to defaults? This will overwrite any changes made during gameplay.')) {
      return;
    }

    setRestoring(true);
    try {
      await api.restoreDefaults();
      setRestored(true);
      setTimeout(() => setRestored(false), 3000);
    } catch (err) {
      alert('Failed to restore defaults: ' + err.message);
    }
    setRestoring(false);
  };

  return (
    <div>
      <h2>Settings</h2>
      <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 1.5rem' }}>
        Manage your game data and preferences.
      </p>

      <div className="detail-section">
        <h3>Restore to Defaults</h3>
        <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 1rem' }}>
          Reset game data to its original state. This will overwrite any changes made during gameplay.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <button onClick={handleRestore} disabled={restoring}>
            {restoring ? 'Restoring...' : 'Restore All to Defaults'}
          </button>
          {restored && <span style={{ color: '#27ae60' }}>Defaults restored!</span>}
        </div>
      </div>
    </div>
  );
}

export default Settings;
