import { useState, useEffect, useRef } from 'react';
import { api } from '../api/client';
import CharacterCard from '../components/CharacterCard';

function CharacterList() {
  const [characters, setCharacters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  const loadCharacters = () => {
    api.getCharacters()
      .then(setCharacters)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadCharacters(); }, []);

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

  if (loading) return <div className="loading">Loading characters...</div>;
  if (error) return <div className="error">Error: {error}</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>Player Characters</h2>
        <div>
          <input
            type="file"
            accept=".json"
            ref={fileInputRef}
            onChange={handleImport}
            style={{ display: 'none' }}
          />
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
