import { useEffect, useState } from 'react';
import { api } from '../api/client';

function Settings() {
  const [restoring, setRestoring] = useState(false);
  const [restored, setRestored] = useState(false);
  const [loadingShuffle, setLoadingShuffle] = useState(true);
  const [savingShuffle, setSavingShuffle] = useState(false);
  const [shuffleEnabled, setShuffleEnabled] = useState(false);
  const [shuffleSaved, setShuffleSaved] = useState(false);

  useEffect(() => {
    api.getDmSettings()
      .then((settings) => setShuffleEnabled(!!settings?.aiDailyShuffle))
      .catch(() => setShuffleEnabled(false))
      .finally(() => setLoadingShuffle(false));
  }, []);

  const handleShuffleToggle = async (e) => {
    const nextValue = e.target.checked;
    setSavingShuffle(true);
    setShuffleSaved(false);
    try {
      await api.updateDmSettings({ aiDailyShuffle: nextValue });
      setShuffleEnabled(nextValue);
      setShuffleSaved(true);
      setTimeout(() => setShuffleSaved(false), 3000);
    } catch (err) {
      alert('Failed to update AI shuffle setting: ' + err.message);
    }
    setSavingShuffle(false);
  };

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
        <h3>DM Personality Automation</h3>
        <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 1rem' }}>
          Enable AI shuffle to rotate DM Personality at midnight Pacific time (PDT/PST) every day.
          When enabled, manual edits on the DM Personality page are locked.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="checkbox"
              checked={shuffleEnabled}
              onChange={handleShuffleToggle}
              disabled={loadingShuffle || savingShuffle}
            />
            AI shuffle of DM Personality on 24 hour basis
          </label>
          {loadingShuffle && <span style={{ color: 'var(--text-muted)' }}>Loading...</span>}
          {savingShuffle && <span style={{ color: 'var(--text-muted)' }}>Saving...</span>}
          {!savingShuffle && shuffleSaved && <span style={{ color: '#27ae60' }}>Saved!</span>}
        </div>
      </div>

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
