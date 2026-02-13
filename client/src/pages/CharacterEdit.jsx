import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api/client';

const ABILITIES = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
const SHORT = { strength: 'STR', dexterity: 'DEX', constitution: 'CON', intelligence: 'INT', wisdom: 'WIS', charisma: 'CHA' };

function CharacterEdit() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [char, setChar] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getCharacter(id)
      .then(setChar)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  const updateField = (path, value) => {
    setChar(prev => {
      const copy = JSON.parse(JSON.stringify(prev));
      const keys = path.split('.');
      let obj = copy;
      for (let i = 0; i < keys.length - 1; i++) {
        obj = obj[keys[i]];
      }
      obj[keys[keys.length - 1]] = value;
      return copy;
    });
  };

  const updateAbilityScore = (ability, newScore) => {
    const score = parseInt(newScore) || 0;
    const modifier = Math.floor((score - 10) / 2);
    setChar(prev => ({
      ...prev,
      abilities: {
        ...prev.abilities,
        [ability]: { score, modifier }
      }
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const { _filename, ...data } = char;
      await api.updateCharacter(id, data);
      navigate(`/characters/${id}`);
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };

  if (loading) return <div className="loading">Loading...</div>;
  if (error) return <div className="error">Error: {error}</div>;
  if (!char) return <div className="error">Character not found</div>;

  return (
    <div>
      <h2>Edit: {char.name}</h2>

      <div className="form-row" style={{ marginTop: '1rem' }}>
        <div className="form-group">
          <label>Name</label>
          <input value={char.name} onChange={e => updateField('name', e.target.value)} />
        </div>
        <div className="form-group">
          <label>Race</label>
          <input value={char.race} onChange={e => updateField('race', e.target.value)} />
        </div>
        <div className="form-group">
          <label>Class</label>
          <input value={char.class} onChange={e => updateField('class', e.target.value)} />
        </div>
        <div className="form-group">
          <label>Level</label>
          <input type="number" min="1" max="20" value={char.level} onChange={e => updateField('level', parseInt(e.target.value) || 1)} />
        </div>
      </div>

      <div className="form-row">
        <div className="form-group">
          <label>Background</label>
          <input value={char.background || ''} onChange={e => updateField('background', e.target.value)} />
        </div>
        <div className="form-group">
          <label>Alignment</label>
          <input value={char.alignment || ''} onChange={e => updateField('alignment', e.target.value)} />
        </div>
        <div className="form-group">
          <label>Experience</label>
          <input type="number" min="0" value={char.experience} onChange={e => updateField('experience', parseInt(e.target.value) || 0)} />
        </div>
      </div>

      <h3 style={{ margin: '1rem 0 0.5rem' }}>Ability Scores</h3>
      <div className="form-row" style={{ gridTemplateColumns: 'repeat(6, 1fr)' }}>
        {ABILITIES.map(ab => (
          <div key={ab} className="form-group" style={{ textAlign: 'center' }}>
            <label>{SHORT[ab]}</label>
            <input
              type="number" min="1" max="30"
              style={{ textAlign: 'center' }}
              value={char.abilities?.[ab]?.score ?? 10}
              onChange={e => updateAbilityScore(ab, e.target.value)}
            />
            <div style={{ fontSize: '0.8em', color: 'var(--text-muted)' }}>
              Mod: {(char.abilities?.[ab]?.modifier ?? 0) >= 0 ? '+' : ''}{char.abilities?.[ab]?.modifier ?? 0}
            </div>
          </div>
        ))}
      </div>

      <div className="form-row" style={{ marginTop: '1rem' }}>
        <div className="form-group">
          <label>Max HP</label>
          <input type="number" min="1" value={char.hitPoints?.max ?? 1} onChange={e => {
            const v = parseInt(e.target.value) || 1;
            updateField('hitPoints.max', v);
          }} />
        </div>
        <div className="form-group">
          <label>Current HP</label>
          <input type="number" min="0" value={char.hitPoints?.current ?? 1} onChange={e => {
            updateField('hitPoints.current', parseInt(e.target.value) || 0);
          }} />
        </div>
        <div className="form-group">
          <label>Armor Class</label>
          <input type="number" min="0" value={char.armorClass} onChange={e => updateField('armorClass', parseInt(e.target.value) || 10)} />
        </div>
        <div className="form-group">
          <label>Speed</label>
          <input type="number" min="0" value={char.speed} onChange={e => updateField('speed', parseInt(e.target.value) || 30)} />
        </div>
      </div>

      <div className="form-group" style={{ marginTop: '1rem' }}>
        <label>Backstory</label>
        <textarea rows="3" value={char.backstory || ''} onChange={e => updateField('backstory', e.target.value)} />
      </div>

      <div className="form-row">
        <div className="form-group">
          <label>Personality Traits</label>
          <textarea rows="2" value={char.personality?.traits || ''} onChange={e => updateField('personality.traits', e.target.value)} />
        </div>
        <div className="form-group">
          <label>Ideals</label>
          <textarea rows="2" value={char.personality?.ideals || ''} onChange={e => updateField('personality.ideals', e.target.value)} />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label>Bonds</label>
          <textarea rows="2" value={char.personality?.bonds || ''} onChange={e => updateField('personality.bonds', e.target.value)} />
        </div>
        <div className="form-group">
          <label>Flaws</label>
          <textarea rows="2" value={char.personality?.flaws || ''} onChange={e => updateField('personality.flaws', e.target.value)} />
        </div>
      </div>

      <div className="actions" style={{ marginTop: '1.5rem' }}>
        <button onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
        <Link to={`/characters/${id}`}><button type="button">Cancel</button></Link>
      </div>
    </div>
  );
}

export default CharacterEdit;
