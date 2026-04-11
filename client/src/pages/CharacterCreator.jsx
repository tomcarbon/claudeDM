import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { usePlayer } from '../context/PlayerContext';

const SHORT = { strength: 'STR', dexterity: 'DEX', constitution: 'CON', intelligence: 'INT', wisdom: 'WIS', charisma: 'CHA' };
const ABILITIES = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];

function CharacterCreator() {
  const navigate = useNavigate();
  const { player } = usePlayer();
  const [options, setOptions] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Form state
  const [race, setRace] = useState('');
  const [subrace, setSubrace] = useState('');
  const [charClass, setCharClass] = useState('');
  const [background, setBackground] = useState('');
  const [alignment, setAlignment] = useState('');
  const [name, setName] = useState('');

  // Preview state
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    api.getCharacterOptions()
      .then(setOptions)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const selectedRace = options?.races?.find(r => r.name === race);
  const subraces = selectedRace?.subraces || [];

  // Reset subrace when race changes
  const handleRaceChange = (val) => {
    setRace(val);
    setSubrace('');
    setPreview(null);
  };

  const buildOptions = () => {
    const opts = {};
    if (race) opts.race = race;
    if (subrace) opts.subrace = subrace;
    if (charClass) opts.class = charClass;
    if (background) opts.background = background;
    if (alignment) opts.alignment = alignment;
    if (name.trim()) opts.name = name.trim();
    return opts;
  };

  const handleGenerate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const result = await api.previewCharacter(buildOptions());
      setPreview(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  };

  const handleRandomizeAll = async () => {
    setRace('');
    setSubrace('');
    setCharClass('');
    setBackground('');
    setAlignment('');
    setName('');
    setGenerating(true);
    setError(null);
    try {
      const result = await api.previewCharacter({});
      // Fill dropdowns with what was generated
      setRace(result.race || '');
      setSubrace(result.subrace || '');
      setCharClass(result.class || '');
      setBackground(result.background || '');
      setAlignment(result.alignment || '');
      setName(result.name || '');
      setPreview(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.createCharacter(preview);
      navigate('/characters');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (!player?.email) {
    return (
      <div style={{ padding: '2rem' }}>
        <h2>Create Character</h2>
        <p style={{ color: 'var(--text-muted)' }}>Please log in to create characters.</p>
      </div>
    );
  }

  if (loading) return <div className="loading">Loading options...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>Create Character</h2>
        <button onClick={handleRandomizeAll} disabled={generating}>
          {generating ? 'Rolling...' : '🎲 Randomize All'}
        </button>
      </div>
      <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 1.5rem' }}>
        Choose your character's traits below, or hit Randomize All for a fully random character.
      </p>

      {error && <div className="error" style={{ marginBottom: '1rem' }}>Error: {error}</div>}

      {/* Form */}
      <div className="form-row" style={{ marginTop: '1rem' }}>
        <div className="form-group">
          <label>Race</label>
          <select value={race} onChange={e => handleRaceChange(e.target.value)}>
            <option value="">— Random —</option>
            {options?.races?.map(r => (
              <option key={r.name} value={r.name}>{r.name}</option>
            ))}
          </select>
        </div>
        {subraces.length > 0 && (
          <div className="form-group">
            <label>Subrace</label>
            <select value={subrace} onChange={e => { setSubrace(e.target.value); setPreview(null); }}>
              <option value="">— Random —</option>
              {subraces.map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        )}
        <div className="form-group">
          <label>Class</label>
          <select value={charClass} onChange={e => { setCharClass(e.target.value); setPreview(null); }}>
            <option value="">— Random —</option>
            {options?.classes?.map(c => (
              <option key={c.name} value={c.name}>{c.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="form-row">
        <div className="form-group">
          <label>Background</label>
          <select value={background} onChange={e => { setBackground(e.target.value); setPreview(null); }}>
            <option value="">— Random —</option>
            {options?.backgrounds?.map(b => (
              <option key={b.name} value={b.name}>{b.name}</option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label>Alignment</label>
          <select value={alignment} onChange={e => { setAlignment(e.target.value); setPreview(null); }}>
            <option value="">— Random —</option>
            {options?.alignments?.map(a => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label>Name</label>
          <input
            value={name}
            onChange={e => { setName(e.target.value); setPreview(null); }}
            placeholder="Leave blank for random"
          />
        </div>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', margin: '1.5rem 0' }}>
        <button onClick={handleGenerate} disabled={generating}>
          {generating ? 'Generating...' : 'Generate Character'}
        </button>
      </div>

      {/* Preview */}
      {preview && (
        <div className="detail-section" style={{ marginTop: '1rem' }}>
          <h3 style={{ margin: '0 0 1rem' }}>{preview.name}</h3>
          <p style={{ color: 'var(--text-muted)', margin: '0 0 1rem' }}>
            Level {preview.level} {preview.subrace ? (preview.subrace.toLowerCase().includes(preview.race.toLowerCase()) ? preview.subrace : `${preview.subrace} ${preview.race}`) : preview.race} {preview.class} ({preview.background}) — {preview.alignment}
          </p>

          <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
            <span>❤️ HP: {preview.hitPoints?.max}</span>
            <span>🛡️ AC: {preview.armorClass}</span>
            <span>👟 Speed: {preview.speed}ft</span>
          </div>

          <h4 style={{ margin: '0.5rem 0' }}>Ability Scores</h4>
          <div className="form-row" style={{ gridTemplateColumns: 'repeat(6, 1fr)', marginBottom: '1rem' }}>
            {ABILITIES.map(ab => (
              <div key={ab} style={{ textAlign: 'center', padding: '0.5rem', background: 'var(--bg-dark)', borderRadius: '6px' }}>
                <div style={{ fontSize: '0.8em', color: 'var(--text-muted)' }}>{SHORT[ab]}</div>
                <div style={{ fontSize: '1.2em', fontWeight: 'bold' }}>{preview.abilities?.[ab]?.score}</div>
                <div style={{ fontSize: '0.8em', color: 'var(--gold)' }}>
                  {(preview.abilities?.[ab]?.modifier ?? 0) >= 0 ? '+' : ''}{preview.abilities?.[ab]?.modifier}
                </div>
              </div>
            ))}
          </div>

          {preview.skills?.length > 0 && (
            <p><strong>Skills:</strong> {preview.skills.join(', ')}</p>
          )}
          {preview.languages?.length > 0 && (
            <p><strong>Languages:</strong> {preview.languages.join(', ')}</p>
          )}
          {preview.equipment?.length > 0 && (
            <p><strong>Equipment:</strong> {preview.equipment.join(', ')}</p>
          )}
          {preview.weapons?.length > 0 && (
            <p><strong>Weapons:</strong> {preview.weapons.map(w => `${w.name} (+${w.attackBonus} ${w.damage})`).join(', ')}</p>
          )}
          {preview.spells && (
            <>
              {preview.spells.cantrips?.length > 0 && (
                <p><strong>Cantrips:</strong> {preview.spells.cantrips.join(', ')}</p>
              )}
              {preview.spells.knownSpells?.length > 0 && (
                <p><strong>Spells:</strong> {preview.spells.knownSpells.join(', ')}</p>
              )}
            </>
          )}
          {preview.personality && (
            <div style={{ marginTop: '1rem' }}>
              <p><strong>Trait:</strong> {preview.personality.traits}</p>
              <p><strong>Ideal:</strong> {preview.personality.ideals}</p>
              <p><strong>Bond:</strong> {preview.personality.bonds}</p>
              <p><strong>Flaw:</strong> {preview.personality.flaws}</p>
            </div>
          )}
          {preview.backstory && (
            <p style={{ marginTop: '0.5rem', fontStyle: 'italic', color: 'var(--text-muted)' }}>{preview.backstory}</p>
          )}

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1.5rem' }}>
            <button onClick={handleGenerate} disabled={generating}>
              {generating ? 'Rolling...' : 'Re-roll'}
            </button>
            <button onClick={handleSave} disabled={saving} style={{ background: 'var(--gold)', color: '#000' }}>
              {saving ? 'Saving...' : 'Save Character'}
            </button>
            <button onClick={() => navigate('/characters')} style={{ background: 'transparent', border: '1px solid var(--border)' }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default CharacterCreator;
