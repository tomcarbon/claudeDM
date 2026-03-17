function Eli5() {
  return (
    <div>
      <h2>🎲 ELI5 — What Is This?</h2>
      <p style={{ marginTop: '1rem', color: 'var(--text-muted)', fontSize: '1.05em' }}>
        This is a <strong>D&D 5th Edition Companion App</strong> — a web app that lets you play
        Dungeons & Dragons with an <strong>AI Dungeon Master</strong>. The AI narrates the story,
        controls your NPC companions, rolls dice, and adjudicates the rules. You just pick a character,
        choose a scenario, and start playing.
      </p>

      <div className="eli5-section">
        <h3>🧙 What Is D&D?</h3>
        <p>
          Dungeons & Dragons is a tabletop roleplaying game. You create a character — a warrior, wizard,
          rogue, or cleric — and go on adventures in a fantasy world. A <em>Dungeon Master</em> (DM)
          tells the story, describes what you see, and controls the monsters and NPCs. You say what your
          character does, roll dice to see if it works, and the story unfolds from there.
        </p>
        <p>
          In this app, the DM is an AI (Claude). It knows the D&D 5e rules, tracks your stats, rolls
          dice fairly, and adapts the story to your choices.
        </p>
      </div>

      <div className="eli5-section">
        <h3>🚀 Quick Start — 5 Steps</h3>
        <ol className="eli5-steps">
          <li>
            <strong>Get a login.</strong> Click the <strong>Register</strong> button in the sidebar
            to create your account. You'll get a set of default characters and companions to start with.
          </li>
          <li>
            <strong>Choose a character.</strong> Visit <strong>Characters</strong> to browse the
            available heroes. Each one has a unique class, backstory, and playstyle — pick the one
            that speaks to you.
          </li>
          <li>
            <strong>Pick a campaign or scenario.</strong> From the <strong>Home</strong> page, choose
            a campaign world to enter. The <em>Level One Demo</em> is free and a great place to start.
            Then browse <strong>Scenarios</strong> to pick your adventure module.
          </li>
          <li>
            <strong>Give your game a label.</strong> Name your session so your friends can find it —
            something like <em>"Tuesday Night Dungeon Crawl"</em> or <em>"Goblin Trouble Round 2"</em>.
          </li>
          <li>
            <strong>Begin the game!</strong> Hit <strong>Play</strong>, and the AI Dungeon Master takes
            it from there. Type what your character does in plain English, and the story unfolds.
          </li>
        </ol>
      </div>

      <div className="eli5-section">
        <h3>🗺️ What's on Each Page?</h3>
        <table className="eli5-table">
          <thead>
            <tr><th>Page</th><th>What It Does</th></tr>
          </thead>
          <tbody>
            <tr><td><strong>Home</strong></td><td>Campaign selection — pick which adventure world to enter.</td></tr>
            <tr><td><strong>Play</strong></td><td>The main game screen. This is where you talk to the AI DM and play D&D.</td></tr>
            <tr><td><strong>Current Party</strong></td><td>See who's in your active adventuring party right now.</td></tr>
            <tr><td><strong>Characters</strong></td><td>View and edit your player characters — stats, equipment, spells, backstory.</td></tr>
            <tr><td><strong>Companions</strong></td><td>Browse the NPC companions the DM controls. Read their personalities and gear.</td></tr>
            <tr><td><strong>World Map</strong></td><td>Explore the campaign world map.</td></tr>
            <tr><td><strong>Rules</strong></td><td>D&D 5e rules reference — classes, races, spells, combat, equipment.</td></tr>
            <tr><td><strong>Scenarios</strong></td><td>Adventure modules you can play. Pick one when starting a session.</td></tr>
            <tr><td><strong>What's New</strong></td><td>Release notes and version history for the app.</td></tr>
            <tr><td><strong>DM Personality</strong></td><td>Tune the AI DM's style — verbosity, humor, drama, difficulty, and more.</td></tr>
            <tr><td><strong>Settings</strong></td><td>Account settings, character resets, and data management.</td></tr>
          </tbody>
        </table>
      </div>

      <div className="eli5-section">
        <h3>🎯 Tips for New Players</h3>
        <ul className="eli5-tips">
          <li><strong>Just type naturally.</strong> Tell the DM what your character does in plain English: <em>"I search the room for traps"</em> or <em>"I attack the goblin with my sword."</em></li>
          <li><strong>The DM rolls dice for you.</strong> You don't need to know the rules — the AI handles ability checks, attack rolls, damage, and saving throws.</li>
          <li><strong>Your choices matter.</strong> The story adapts to what you do. There's no single "right" path.</li>
          <li><strong>Check your character sheet.</strong> After combat, your XP, HP, and inventory are updated automatically. Visit <strong>Characters</strong> to see your current stats.</li>
          <li><strong>Adjust the DM.</strong> If you want more humor, less difficulty, or shorter responses, visit <strong>DM Personality</strong> and move the sliders. Changes save automatically.</li>
          <li><strong>Save and resume.</strong> Your session is saved automatically. You can stop playing and pick up where you left off next time.</li>
          <li><strong>Use the party chat.</strong> The chat panel on the right side lets you talk to other players who are online.</li>
        </ul>
      </div>

      <div className="eli5-section">
        <h3>🔑 Getting a Login Account</h3>
        <p>
          Click the <strong>Register</strong> button in the bottom-left sidebar to create your account.
          You'll need to provide your name and email address. Once registered, you'll be set up with
          default characters and companions for each campaign, and you're ready to play.
        </p>
        <p style={{ marginTop: '0.75rem', color: 'var(--text-muted)' }}>
          Already have an account? Click <strong>Login</strong> instead and enter your email.
          You can explore the app without logging in, but you need an account to play adventures
          and have your progress saved.
        </p>
      </div>

      <div className="eli5-section">
        <h3>❓ FAQ</h3>
        <dl className="eli5-faq">
          <dt>Do I need to know D&D rules?</dt>
          <dd>Nope. The AI DM knows the rules and will handle everything. Just describe what you want to do.</dd>

          <dt>Is this multiplayer?</dt>
          <dd>Yes! You can play solo with all AI-controlled companions, or open up slots in your game for other players to join. You can make a slot available to any player, or invite a specific player. The joining player takes control of a companion character while the AI DM continues to run the story and the remaining NPCs. Many combinations are possible — one host with one friend, a full party of humans, or anything in between.</dd>

          <dt>Can I create my own character?</dt>
          <dd>Each campaign comes with pre-built characters. You can edit your character's stats, equipment, and backstory from the Characters page.</dd>

          <dt>What happens if my character dies?</dt>
          <dd>Dead characters are marked in your data but can be reset to defaults from the Settings page. The DM follows standard D&D death save rules.</dd>

          <dt>How do I switch campaigns?</dt>
          <dd>Go to the Home page and click on a different campaign. Your progress in each campaign is saved separately.</dd>
        </dl>
      </div>
    </div>
  );
}

export default Eli5;
