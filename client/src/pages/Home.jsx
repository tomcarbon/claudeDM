function Home() {
  return (
    <div>
      <h2>Welcome, Adventurer</h2>
      <p style={{ marginTop: '1rem', color: 'var(--text-muted)' }}>
        Your D&D 5th Edition companion awaits. Choose your path:
      </p>
      <div className="card-grid" style={{ marginTop: '1.5rem' }}>
        <a href="/characters" className="card">
          <h3>Characters</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9em' }}>
            View, edit, and manage your player characters.
          </p>
        </a>
        <a href="/npcs" className="card">
          <h3>NPC Companions</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9em' }}>
            Meet the AI-narrated companions who will join your quest.
          </p>
        </a>
        <a href="/rules" className="card">
          <h3>Rules Reference</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9em' }}>
            Browse the D&D 5e rules database — races, classes, spells, combat, and more.
          </p>
        </a>
      </div>
    </div>
  );
}

export default Home;
