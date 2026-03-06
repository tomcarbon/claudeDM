import { useNavigate } from 'react-router-dom';
import { useCampaign } from '../context/CampaignContext';

const CAMPAIGN_CARDS = [
  { label: 'Start Adventure', desc: 'Begin a text adventure with the AI Dungeon Master.', path: '/adventure', className: 'card-adventure' },
  { label: 'Characters', desc: 'View, edit, and manage your player characters.', path: '/characters' },
  { label: 'NPC Companions', desc: 'Meet the AI-narrated companions who will join your quest.', path: '/npcs' },
  { label: 'Scenarios (spoilers!)', desc: 'Browse adventure modules for this campaign.', path: '/scenarios' },
  { label: 'World Map', desc: 'Explore the campaign world map.', path: '/world-map' },
  { label: 'Rules Reference', desc: 'Browse the D&D 5e rules database.', path: '/rules' },
  { label: 'DM Personality', desc: 'Tune your AI Dungeon Master — humor, drama, verbosity, tone, and style.', path: '/dm-settings' },
  { label: "What's New", desc: 'See release notes, version history, and recent feature updates.', path: '/whats-new' },
];

function CampaignCards({ campaignId, locked }) {
  const navigate = useNavigate();
  const { selectCampaign } = useCampaign();

  function handleClick(card) {
    if (locked) return;
    selectCampaign(campaignId);
    navigate(card.path, card.path === '/adventure' ? { state: { resetSession: true } } : undefined);
  }

  return (
    <div className="card-grid">
      {CAMPAIGN_CARDS.map(card => (
        locked ? (
          <div key={card.label} className="card card-locked">
            <h3>{card.label}</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9em' }}>{card.desc}</p>
          </div>
        ) : (
          <a
            key={card.label}
            href={card.path}
            className={`card${card.className ? ' ' + card.className : ''}`}
            onClick={(e) => { e.preventDefault(); handleClick(card); }}
          >
            <h3>{card.label}</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9em' }}>{card.desc}</p>
          </a>
        )
      ))}
    </div>
  );
}

function Home() {
  return (
    <div>
      <h2>Welcome, Adventurer</h2>
      <p style={{ marginTop: '1rem', color: 'var(--text-muted)' }}>
        Your D&D 5th Edition companion awaits. Choose your path:
      </p>

      {/* ── Level One Demo (Free Tier) ── */}
      <div className="tier-box tier-demo">
        <div className="tier-header">
          <span className="tier-badge tier-badge-demo">Free</span>
          <h3 className="tier-title">Level One Demo</h3>
          <p className="tier-subtitle">The Shattered Coast — 4 scenarios, full party, AI Dungeon Master</p>
        </div>
        <CampaignCards campaignId="demo" locked={false} />
      </div>

      {/* ── Depths of the Underdark (Active Campaign) ── */}
      <div className="tier-box tier-premium">
        <div className="tier-header">
          <span className="tier-badge tier-badge-premium">Premium</span>
          <h3 className="tier-title">Depths of the Underdark</h3>
          <p className="tier-subtitle">Descend into the subterranean world of drow, fungi forests, and ancient evils. Levels 3–12.</p>
        </div>
        <CampaignCards campaignId="campaign1" locked={false} />
      </div>

      {/* ── Madness in Wonderland (Active Campaign) ── */}
      <div className="tier-box tier-premium">
        <div className="tier-header">
          <span className="tier-badge tier-badge-premium">Premium</span>
          <h3 className="tier-title">Madness in Wonderland</h3>
          <p className="tier-subtitle">Through the Looking Glass into an Alice-inspired Feywild demiplane of riddles, madness, and tyranny. Levels 5–15.</p>
        </div>
        <CampaignCards campaignId="wonderland" locked={false} />
      </div>

      {/* ── Premium Campaigns (Locked) ── */}
      <div className="tier-box tier-premium tier-locked">
        <div className="tier-header">
          <span className="tier-badge tier-badge-premium">Premium</span>
          <h3 className="tier-title">The Crimson Throne</h3>
          <span className="locked-label">Coming Soon</span>
          <p className="tier-subtitle">A political intrigue campaign set in a crumbling empire. Levels 1–10.</p>
        </div>
        <CampaignCards campaignId="campaign2" locked={true} />
      </div>

      <div className="tier-box tier-premium tier-locked">
        <div className="tier-header">
          <span className="tier-badge tier-badge-premium">Premium</span>
          <h3 className="tier-title">Storm of the Giants</h3>
          <span className="locked-label">Coming Soon</span>
          <p className="tier-subtitle">An epic war between giant-kind and the small folk. Levels 5–15.</p>
        </div>
        <CampaignCards campaignId="campaign3" locked={true} />
      </div>

      <div className="tier-box tier-premium tier-locked">
        <div className="tier-header">
          <span className="tier-badge tier-badge-premium">Premium</span>
          <h3 className="tier-title">The Astral Convergence</h3>
          <span className="locked-label">Coming Soon</span>
          <p className="tier-subtitle">Journey beyond the material plane into the Astral Sea. Levels 8–20.</p>
        </div>
        <CampaignCards campaignId="campaign4" locked={true} />
      </div>
    </div>
  );
}

export default Home;
