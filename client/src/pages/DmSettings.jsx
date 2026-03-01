import { useState, useEffect } from 'react';
import { api } from '../api/client';
import { usePlayer } from '../context/PlayerContext';

const SLIDERS = [
  { key: 'humor', label: 'Humor', left: 'Serious', right: 'Comedic', icon: '🎭' },
  { key: 'drama', label: 'Drama', left: 'Relaxed', right: 'Intense', icon: '⚡' },
  { key: 'verbosity', label: 'Verbosity', left: 'Concise', right: 'Verbose', icon: '📜' },
  { key: 'difficulty', label: 'Difficulty', left: 'Forgiving', right: 'Brutal', icon: '💀' },
  { key: 'horror', label: 'Darkness', left: 'None', right: 'Dark', icon: '🕯️' },
  { key: 'puzzleFocus', label: 'Puzzles vs Combat', left: 'Combat Heavy', right: 'Puzzle Heavy', icon: '🧩' },
];

const AGENCY_TO_AUTONOMY = {
  railroaded: 0,
  guided: 25,
  collaborative: 50,
  freeform: 75,
  sandbox: 100,
};

const TONE_OPTIONS = [
  { value: 'heroic', label: 'Heroic', desc: 'Epic quests, noble deeds, triumph over evil' },
  { value: 'gritty', label: 'Gritty', desc: 'Harsh world, moral ambiguity, survival' },
  { value: 'whimsical', label: 'Whimsical', desc: 'Lighthearted, playful, fairy-tale vibes' },
  { value: 'balanced', label: 'Balanced', desc: 'Mix of light and dark, adapts to the moment' },
  { value: 'noir', label: 'Noir', desc: 'Mystery, shadows, everyone has secrets' },
];

const NARRATION_OPTIONS = [
  { value: 'descriptive', label: 'Descriptive', desc: 'Rich sensory details, paints vivid pictures' },
  { value: 'action', label: 'Action-Focused', desc: 'Punchy, fast-paced, emphasizes what happens' },
  { value: 'dialogue', label: 'Dialogue-Heavy', desc: 'NPCs talk a lot, distinct voices and personalities' },
  { value: 'atmospheric', label: 'Atmospheric', desc: 'Mood and tension first, slow-burn dread or wonder' },
];

const AGENCY_OPTIONS = [
  { value: 'railroaded', label: 'On Rails', desc: 'Tight narrative, less deviation, cinematic experience' },
  { value: 'guided', label: 'Guided', desc: 'Clear objectives and plot hooks, gentle steering' },
  { value: 'collaborative', label: 'Collaborative', desc: 'DM and players shape the story together' },
  { value: 'freeform', label: 'Freeform', desc: 'Player leads the story, DM enriches and responds' },
  { value: 'sandbox', label: 'Sandbox', desc: 'Total freedom — the world reacts to your choices' },
];

const QUICK_PRESETS = {
  classic: {
    label: 'Classic Fantasy',
    values: {
      humor: 30, drama: 60, verbosity: 60, difficulty: 50, horror: 20,
      puzzleFocus: 50, playerAutonomy: 25, tone: 'heroic', narrationStyle: 'descriptive', playerAgency: 'guided',
    },
  },
  comedic: {
    label: 'Comedic Romp',
    values: {
      humor: 90, drama: 30, verbosity: 70, difficulty: 30, horror: 5,
      puzzleFocus: 40, playerAutonomy: 50, tone: 'whimsical', narrationStyle: 'dialogue', playerAgency: 'collaborative',
    },
  },
  darkSouls: {
    label: 'Dark & Brutal',
    values: {
      humor: 10, drama: 90, verbosity: 40, difficulty: 90, horror: 80,
      puzzleFocus: 50, playerAutonomy: 100, tone: 'gritty', narrationStyle: 'atmospheric', playerAgency: 'sandbox',
    },
  },
  mystery: {
    label: 'Mystery & Noir',
    values: {
      humor: 30, drama: 70, verbosity: 70, difficulty: 50, horror: 40,
      puzzleFocus: 80, playerAutonomy: 50, tone: 'noir', narrationStyle: 'dialogue', playerAgency: 'collaborative',
    },
  },
};

function getMatchingPreset(settings) {
  if (!settings) return null;
  const match = Object.entries(QUICK_PRESETS).find(([, preset]) =>
    Object.entries(preset.values).every(([key, value]) => settings[key] === value)
  );
  return match ? match[0] : null;
}

function DmSettings() {
  const { player } = usePlayer();
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [isPersonalized, setIsPersonalized] = useState(false);
  const isLoggedIn = !!player?.email && player.email !== 'guest';
  const isShuffleEnabled = !!settings?.aiDailyShuffle;
  const canEdit = isLoggedIn && !isShuffleEnabled;
  const activePreset = getMatchingPreset(settings);

  useEffect(() => {
    api.getDmSettings()
      .then((data) => {
        setIsPersonalized(!!data._isPersonalized);
        setSettings(data);
      })
      .catch(() => setSettings({
        humor: 50, drama: 50, verbosity: 50, difficulty: 50,
        horror: 20, puzzleFocus: 50, playerAutonomy: 50, tone: 'balanced',
        narrationStyle: 'descriptive', playerAgency: 'collaborative', aiDailyShuffle: false,
      }))
      .finally(() => setLoading(false));
  }, []);

  const updateSlider = (key, value) => {
    if (!canEdit) return;
    setSettings(prev => ({ ...prev, [key]: parseInt(value) }));
    setSaved(false);
  };

  const updateOption = (key, value) => {
    if (!canEdit) return;
    const updates = { [key]: value };
    if (key === 'playerAgency' && AGENCY_TO_AUTONOMY[value] !== undefined) {
      updates.playerAutonomy = AGENCY_TO_AUTONOMY[value];
    }
    setSettings(prev => ({ ...prev, ...updates }));
    setSaved(false);
  };

  const handleSave = async () => {
    if (!canEdit) return;
    setSaving(true);
    try {
      const result = await api.updateDmSettings(settings);
      setIsPersonalized(!!result._isPersonalized);
      setSettings(result);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error('Failed to save DM settings:', err);
    }
    setSaving(false);
  };

  const handleReset = async () => {
    if (!isLoggedIn) return;
    setResetting(true);
    try {
      const result = await api.resetDmSettings();
      setIsPersonalized(false);
      setSettings(result);
      setSaved(false);
    } catch (err) {
      console.error('Failed to reset DM settings:', err);
    }
    setResetting(false);
  };

  const handlePreset = (preset) => {
    if (!canEdit) return;
    const selected = QUICK_PRESETS[preset];
    if (!selected) return;
    setSettings(prev => ({ ...prev, ...selected.values }));
    setSaved(false);
  };

  if (loading) return <div className="loading">Loading DM settings...</div>;

  return (
    <div>
      <h2>DM Personality</h2>
      <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 1.5rem' }}>
        Customize how your AI Dungeon Master narrates, reacts, and runs the game.
      </p>
      {!isLoggedIn && (
        <p style={{ color: 'var(--text-muted)', margin: '0 0 1.5rem' }}>
          Log in to customize your DM Personality settings.
          {isShuffleEnabled ? ' AI shuffle is currently enabled and rotates personality daily at midnight Pacific time.' : ''}
        </p>
      )}
      {isLoggedIn && isShuffleEnabled && (
        <p style={{ color: 'var(--text-muted)', margin: '0 0 1.5rem' }}>
          AI shuffle is enabled, so manual edits are locked until shuffle is turned off.
        </p>
      )}
      {isLoggedIn && !isShuffleEnabled && (
        <p style={{ color: isPersonalized ? '#27ae60' : 'var(--text-muted)', margin: '0 0 1.5rem' }}>
          {isPersonalized ? '🎨 Your personal DM settings' : '🌐 Using global defaults'}
        </p>
      )}

      {/* Presets */}
      <div className="detail-section">
        <h3>Quick Presets</h3>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
          {Object.entries(QUICK_PRESETS).map(([presetKey, preset]) => (
            <button
              key={presetKey}
              className={`quick-preset-btn ${activePreset === presetKey ? 'active' : ''}`}
              onClick={() => handlePreset(presetKey)}
              disabled={!canEdit}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* Sliders */}
      <div className="detail-section" style={{ marginTop: '1.5rem' }}>
        <h3>Personality Sliders</h3>
        <div className="slider-grid">
          {SLIDERS.map(s => (
            <div key={s.key} className="slider-row">
              <div className="slider-label">
                <span>{s.icon} {s.label}</span>
                <span className="slider-value">{settings[s.key]}%</span>
              </div>
              <div className="slider-track-container">
                <span className="slider-end-label">{s.left}</span>
                <input
                  type="range" min="0" max="100" step="5"
                  value={settings[s.key]}
                  onChange={e => updateSlider(s.key, e.target.value)}
                  className="dm-slider"
                  disabled={!canEdit}
                />
                <span className="slider-end-label">{s.right}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Tone Selector */}
      <div className="detail-section" style={{ marginTop: '1.5rem' }}>
        <h3>Campaign Tone</h3>
        <div className="option-grid">
          {TONE_OPTIONS.map(opt => (
            <button
              key={opt.value}
              className={`option-card ${settings.tone === opt.value ? 'selected' : ''}`}
              onClick={() => updateOption('tone', opt.value)}
              disabled={!canEdit}
            >
              <strong>{opt.label}</strong>
              <span>{opt.desc}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Narration Style */}
      <div className="detail-section" style={{ marginTop: '1.5rem' }}>
        <h3>Narration Style</h3>
        <div className="option-grid">
          {NARRATION_OPTIONS.map(opt => (
            <button
              key={opt.value}
              className={`option-card ${settings.narrationStyle === opt.value ? 'selected' : ''}`}
              onClick={() => updateOption('narrationStyle', opt.value)}
              disabled={!canEdit}
            >
              <strong>{opt.label}</strong>
              <span>{opt.desc}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Player Agency + Autonomy */}
      <div className="detail-section" style={{ marginTop: '1.5rem' }}>
        <h3>Player Agency</h3>
        <div className="option-grid">
          {AGENCY_OPTIONS.map(opt => (
            <button
              key={opt.value}
              className={`option-card ${settings.playerAgency === opt.value ? 'selected' : ''}`}
              onClick={() => updateOption('playerAgency', opt.value)}
              disabled={!canEdit}
            >
              <strong>{opt.label}</strong>
              <span>{opt.desc}</span>
            </button>
          ))}
        </div>
        <div className="slider-grid" style={{ marginTop: '1rem' }}>
          <div className="slider-row read-only">
            <div className="slider-label">
              <span>🧭 Player Autonomy</span>
              <span className="slider-value">{settings.playerAutonomy}%</span>
            </div>
            <div className="slider-track-container">
              <span className="slider-end-label">DM Drives Story</span>
              <input
                type="range" min="0" max="100" step="5"
                value={settings.playerAutonomy}
                className="dm-slider"
                disabled
              />
              <span className="slider-end-label">Player Drives Story</span>
            </div>
          </div>
        </div>
      </div>

      {/* Save / Reset */}
      <div style={{ marginTop: '2rem', display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <button onClick={handleSave} disabled={saving || !canEdit}>
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
        {isPersonalized && isLoggedIn && (
          <button onClick={handleReset} disabled={resetting} style={{ background: 'var(--bg-tertiary, #555)' }}>
            {resetting ? 'Resetting...' : 'Reset to Defaults'}
          </button>
        )}
        {saved && <span style={{ color: '#27ae60' }}>Settings saved!</span>}
      </div>
    </div>
  );
}

export default DmSettings;
