import { useState, useEffect } from 'react';
import { api } from '../api/client';
import CharacterCard from '../components/CharacterCard';

function CharacterList() {
  const [characters, setCharacters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getCharacters()
      .then(setCharacters)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading">Loading characters...</div>;
  if (error) return <div className="error">Error: {error}</div>;

  return (
    <div>
      <h2>Player Characters</h2>
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
