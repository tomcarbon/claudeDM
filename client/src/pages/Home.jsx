function Home() {
  return (
    <div>
      <h2>Welcome, Adventurer</h2>
      <p style={{ marginTop: '1rem', color: 'var(--text-muted)' }}>
        Your D&D 5th Edition companion awaits. Choose your path:
      </p>
      <div className="card-grid" style={{ marginTop: '1.5rem' }}>
        <a href="/adventure" className="card card-adventure">
          <h3>Start Adventure</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9em' }}>
            Begin a text adventure with the AI Dungeon Master. Choose your character, pick a scenario, and step into the story.
          </p>
        </a>
        <a href="/whats-new" className="card">
          <h3>What&apos;s New</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9em' }}>
            See release notes, version history, and recent feature updates.
          </p>
        </a>
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
        <a href="/scenarios" className="card">
          <h3>Scenarios</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9em' }}>
            Browse adventure modules — dungeon crawls, mysteries, wilderness survival, and more.
          </p>
        </a>
        <a href="/world-map" className="card">
          <h3>World Map</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9em' }}>
            Explore The Shattered Coast — view scenario locations across the realm.
          </p>
        </a>
        <a href="/rules" className="card">
          <h3>Rules Reference</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9em' }}>
            Browse the D&D 5e rules database — races, classes, spells, combat, and more.
          </p>
        </a>
        <a href="/dm-settings" className="card">
          <h3>DM Personality</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9em' }}>
            Tune your AI Dungeon Master — humor, drama, verbosity, tone, and style.
          </p>
        </a>
      </div>
    </div>
  );
}

export default Home;
