function Eli5() {
  return (
    <div>
      <h2>🎲 ELI5 — What Is This?</h2>
      <p style={{ marginTop: '1rem', color: 'var(--text-muted)', fontSize: '1.05em' }}>
        This is <strong>adventurefrog</strong> — a web app that lets you play tabletop roleplaying
        games with a <strong>Game Master</strong>. The AI narrates the story,
        controls your NPC companions, rolls dice, and adjudicates the rules. You just pick a character,
        choose a scenario, and start playing.
      </p>

      <div className="eli5-section">
        <h3>🧙 What Is a Tabletop RPG?</h3>
        <p>
          A tabletop roleplaying game is collaborative storytelling with dice. You create a character —
          a warrior or a wizard, a spy or a medic — and go on adventures. A <em>Game Master</em> (GM)
          tells the story, describes what you see, and controls the monsters and NPCs. You say what your
          character does, roll dice to see if it works, and the story unfolds from there.
        </p>
        <p>
          In this app, the GM is an AI (Claude). It knows the rules, tracks your stats, rolls dice
          fairly, and adapts the story to your choices.
        </p>
        <p>
          Campaigns come in five categories. <strong>🐉 Fantasy</strong> — swords and spells, played
          with the fifth-edition SRD rules. <strong>🚀 Sci-Fi</strong> — guns, technology and no magic,
          from a 1983 spy thriller to a far-future heist, with its own gunplay rules (ammunition, burst
          and full-auto fire, cover that depends on what it's made of). <strong>🌃 Noir</strong> —
          private eyes, crooked cops and rain on the window, 1938 to 1952, with rules for working a
          case: clues you can't miss, interrogations, tails and the Heat that follows you.{' '}
          <strong>🤠 Western</strong> — six-guns, horses and long rides, 1874 to 1886, with showdowns,
          a Reputation in every town and a trail that can kill you before anyone else does.{' '}
          <strong>🕯️ Horror</strong> — ordinary people against things in the dark, 1893 to 1974, with
          fear checks, a Dread track that rises as you see too much, and monsters that follow rules you
          can learn. If anything is too much, say "skip that" and the GM cuts away. All five
          use the same d20 core, so if you can play one you can play the others. Switch between them
          on the <strong>Home</strong> page and the <strong>Rules</strong> page.
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
            a campaign world to enter. The <em>Level One Demo</em> is the free starter campaign and
            a great place to learn. Then browse <strong>Scenarios</strong> to pick your adventure module.
          </li>
          <li>
            <strong>Give your game a label.</strong> Name your session so you (and your friends) can find it later —
            something like <em>"Tuesday Night Dungeon Crawl"</em> or <em>"Goblin Trouble Round 2"</em>.
            Friends can join your session once it's started.
          </li>
          <li>
            <strong>Begin the game!</strong> Hit <strong>Play</strong>, and your Game Master takes
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
            <tr><td><strong>Play</strong></td><td>The main game screen. This is where you talk to your Game Master and play.</td></tr>
            <tr><td><strong>Current Party</strong></td><td>See who's in your active adventuring party right now.</td></tr>
            <tr><td><strong>Characters</strong></td><td>View and edit your player characters — stats, equipment, spells, backstory.</td></tr>
            <tr><td><strong>Companions</strong></td><td>Browse the NPC companions the GM controls. Read their personalities and gear.</td></tr>
            <tr><td><strong>World Map</strong></td><td>Explore the campaign world map.</td></tr>
            <tr><td><strong>Rules</strong></td><td>Rules reference for each category — Fantasy (classes, races, spells, combat, equipment) Sci-Fi (classes, origins, weapons, gunplay, adversaries) Noir (classes, origins, period weapons, brawling, investigation, adversaries) Western (classes, origins, six-guns, showdowns, horses and the trail, adversaries) and Horror (classes, origins, Dread and fear, creature rules and rites, adversaries).</td></tr>
            <tr><td><strong>Scenarios</strong></td><td>Adventure modules you can play. Pick one when starting a session.</td></tr>
            <tr><td><strong>What's New</strong></td><td>Release notes and version history for the app.</td></tr>
            <tr><td><strong>GM Personality</strong></td><td>Tune your Game Master's style — response length, humor, drama, difficulty, and more.</td></tr>
            <tr><td><strong>Settings</strong></td><td>Account settings, character resets, and data management.</td></tr>
          </tbody>
        </table>
      </div>

      <div className="eli5-section">
        <h3>🎯 Tips for New Players</h3>
        <ul className="eli5-tips">
          <li><strong>Just type naturally.</strong> Tell the GM what your character does in plain English: <em>"I search the room for traps"</em> or <em>"I attack the goblin with my sword."</em></li>
          <li><strong>The GM rolls dice for you.</strong> You don't need to know the rules — the AI handles ability checks, attack rolls, damage, and saving throws.</li>
          <li><strong>Your choices matter.</strong> The story adapts to what you do. There's no single "right" path.</li>
          <li><strong>Check your character sheet.</strong> After combat, your XP, HP, and inventory are updated automatically. Visit <strong>Characters</strong> to see your current stats.</li>
          <li><strong>Adjust the GM.</strong> If you want more humor, less difficulty, or shorter responses, visit <strong>GM Personality</strong> and move the sliders. Changes save automatically.</li>
          <li><strong>Save and resume.</strong> Your session is saved automatically. You can stop playing and pick up where you left off next time.</li>
          <li><strong>Use the party chat.</strong> The chat panel on the right side lets you talk to other human players who are online — coordinate strategy, crack jokes, or plan your next move outside the game narrative.</li>
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
          <dt>Do I need to know the rules?</dt>
          <dd>Nope. Your Game Master knows the rules and will handle everything. Just describe what you want to do.</dd>

          <dt>Is this multiplayer?</dt>
          <dd>Yes! You can play solo with all AI-controlled companions, or open up slots in your game for other players to join. You can make a slot available to any player, or invite a specific player. The joining player takes control of a companion character while your Game Master continues to run the story and the remaining NPCs. Many combinations are possible — one host with one friend, a full party of humans, or anything in between.</dd>

          <dt>Can I create my own character?</dt>
          <dd>Yes! Each campaign comes with pre-built characters you can use right away, but you can also ask your Game Master to roll a brand new character. You can edit any character's stats, equipment, and backstory from the Characters page.</dd>

          <dt>What happens if my character dies?</dt>
          <dd>Dead characters are marked in your data but can be reset to defaults from the Settings page. The GM follows the standard death save rules.</dd>

          <dt>How do I switch campaigns?</dt>
          <dd>Go to the Home page and click on a different campaign. Your progress in each campaign is saved separately.</dd>
        </dl>
      </div>
    </div>
  );
}

export default Eli5;
