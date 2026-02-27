import { useState, useEffect, useRef } from 'react';
import { api } from '../api/client';
import { usePlayer } from '../context/PlayerContext';
import CharacterCard from '../components/CharacterCard';

function CharacterList() {
  const { player } = usePlayer();
  const [characters, setCharacters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  const loadCharacters = () => {
    if (!player) {
      setLoading(false);
      return;
    }
    api.getCharacters()
      .then(setCharacters)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadCharacters(); }, [player]);

  const handleImport = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      await api.importCharacter(data);
      loadCharacters();
    } catch (err) {
      if (err.errors) {
        alert('Validation errors:\n' + err.errors.join('\n'));
      } else {
        alert('Import failed: ' + err.message);
      }
    }
    e.target.value = '';
  };

  const handleExportEmpty = () => {
    const template = {
      name: "",
      race: "",
      subrace: "",
      class: "",
      level: 1,
      background: "",
      alignment: "",
      experience: 0,
      abilities: {
        strength:     { score: 10, modifier: 0 },
        dexterity:    { score: 10, modifier: 0 },
        constitution: { score: 10, modifier: 0 },
        intelligence: { score: 10, modifier: 0 },
        wisdom:       { score: 10, modifier: 0 },
        charisma:     { score: 10, modifier: 0 }
      },
      hitPoints: { max: 10, current: 10 },
      armorClass: 10,
      speed: 30,
      proficiencyBonus: 2,
      savingThrows: [],
      skills: [],
      languages: ["Common"],
      equipment: [],
      weapons: [],
      armor: { name: "", type: "none" },
      features: [],
      traits: [],
      spells: null,
      personality: {
        traits: "",
        ideals: "",
        bonds: "",
        flaws: ""
      },
      appearance: "",
      backstory: ""
    };
    const blob = new Blob([JSON.stringify(template, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'empty-character.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!player) return <div style={{ padding: '2rem' }}><h2>Player Characters</h2><p style={{ color: 'var(--text-muted)' }}>Please log in to view your characters.</p></div>;
  if (loading) return <div className="loading">Loading characters...</div>;
  if (error) return <div className="error">Error: {error}</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>Player Characters</h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            type="file"
            accept=".json"
            ref={fileInputRef}
            onChange={handleImport}
            style={{ display: 'none' }}
          />
          <button onClick={handleExportEmpty}>Export Empty Character</button>
          <button onClick={() => fileInputRef.current.click()}>Import Character</button>
        </div>
      </div>
      <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 1.5rem' }}>
        {characters.length} characters available. Click to view details or edit.
      </p>
      <div className="card-grid">
        {characters.map(c => (
          <CharacterCard key={c.id} character={c} />
        ))}
      </div>
    </div>
  );
}

export default CharacterList;
