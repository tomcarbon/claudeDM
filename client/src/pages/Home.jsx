import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCampaign } from '../context/CampaignContext';
import { usePlayer } from '../context/PlayerContext';
import { badgeClassName, boxClassName, cardBadge, cardBlurb, cardTitle, sortCampaigns, findCampaign } from '../utils/campaignListing';
import { CATEGORIES, categoryOf } from '../utils/gameCategories';
import { APP_NAME } from '../utils/brand';
import { CAMPAIGN_CARDS, cardClickTarget } from '../utils/homeCards';
import { START_UNAVAILABLE_REASON, startUnavailable } from '../utils/premiumAccess';

// Which category tab Home shows. Remembered per browser; a convenience, so every failure to read
// or write it falls back to the category of the campaign the player last chose.
const CATEGORY_KEY = 'gm_home_category';

function readStoredCategory() {
  try {
    const v = localStorage.getItem(CATEGORY_KEY);
    return CATEGORIES.some(c => c.id === v) ? v : null;
  } catch {
    return null;
  }
}

function CategoryTabs({ active, counts, onSelect }) {
  return (
    <div className="category-tabs" role="tablist" aria-label="Game category">
      {CATEGORIES.map(cat => (
        <button
          key={cat.id}
          role="tab"
          aria-selected={active === cat.id}
          className={`category-tab${active === cat.id ? ' active' : ''}`}
          onClick={() => onSelect(cat.id)}
        >
          <span className="category-tab-icon" aria-hidden="true">{cat.icon}</span>
          <span className="category-tab-label">{cat.label}</span>
          <span className="category-tab-count">{counts[cat.id] || 0}</span>
        </button>
      ))}
    </div>
  );
}

function CampaignCards({ campaignId, locked, startLocked = false }) {
  const navigate = useNavigate();
  const { selectCampaign } = useCampaign();

  function handleClick(card) {
    const target = cardClickTarget(card, { locked, startLocked });
    if (!target) return;
    selectCampaign(campaignId);
    navigate(target.path, target.state ? { state: target.state } : undefined);
  }

  return (
    <div className="card-grid">
      {CAMPAIGN_CARDS.filter(card => !card.hidden).map(card => (
        card.isStart && startLocked && !locked ? (
          // Grayed out and inert: a <div>, not a link, so there is nothing to click or tab to.
          // The server refuses the start regardless (WO-0050); this only avoids offering it.
          <div
            key={card.label}
            className="card card-locked card-start-unavailable"
            aria-disabled="true"
            title={START_UNAVAILABLE_REASON}
          >
            <h3>{card.label}</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9em' }}>{START_UNAVAILABLE_REASON}</p>
          </div>
        ) : locked ? (
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

function CampaignTier({ campaign }) {
  const { player } = usePlayer();
  const badge = cardBadge(campaign);
  const blurb = cardBlurb(campaign);
  return (
    <div className={boxClassName(campaign)}>
      <div className="tier-header">
        {badge && <span className={badgeClassName(campaign)}>{badge}</span>}
        <h3 className="tier-title">{cardTitle(campaign)}</h3>
        {blurb && <p className="tier-subtitle">{blurb}</p>}
      </div>
      <CampaignCards campaignId={campaign.id} locked={false} startLocked={startUnavailable(player, campaign)} />
    </div>
  );
}

function Home() {
  const { campaigns, campaignId, campaignsLoading, campaignsError, campaignsStale, reloadCampaigns } = useCampaign();
  const ordered = useMemo(() => sortCampaigns(campaigns), [campaigns]);
  const [chosenCategory, setChosenCategory] = useState(readStoredCategory);
  const activeCategory = chosenCategory || categoryOf(findCampaign(campaigns, campaignId));
  const counts = useMemo(() => {
    const c = {};
    for (const campaign of ordered) c[categoryOf(campaign)] = (c[categoryOf(campaign)] || 0) + 1;
    return c;
  }, [ordered]);
  const shown = useMemo(() => ordered.filter(c => categoryOf(c) === activeCategory), [ordered, activeCategory]);
  const activeMeta = CATEGORIES.find(c => c.id === activeCategory) || CATEGORIES[0];

  function chooseCategory(id) {
    setChosenCategory(id);
    try { localStorage.setItem(CATEGORY_KEY, id); } catch { /* a convenience only */ }
  }

  // Three ways this page can have nothing to show, and each says something different:
  //  - first load, nothing cached      -> "Loading campaigns..."
  //  - the fetch failed, nothing cached -> the error, and a way to retry
  //  - the fetch worked and returned [] -> the server genuinely has no campaigns
  // If there is anything to show at all — cached or fresh — it is shown, with a warning when it
  // is not fresh. A stale list beats a blank page: every route into the app is behind these cards.
  const nothingToShow = ordered.length === 0;

  return (
    <div>
      <h2>Welcome, Adventurer</h2>
      <p style={{ marginTop: '1rem', color: 'var(--text-muted)' }}>
        {APP_NAME} runs tabletop roleplaying campaigns with an AI narrator. Pick a genre, then a campaign:
      </p>

      {campaignsError && !campaignsStale && (
        <div className="error" role="alert">
          <p>Could not load the campaign list: {campaignsError}</p>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9em' }}>
            The game server may be down. Nothing has been lost — your characters and saved games are
            on the server and will be here when it answers.
          </p>
          <button onClick={reloadCampaigns} disabled={campaignsLoading}>
            {campaignsLoading ? 'Trying...' : 'Try again'}
          </button>
        </div>
      )}

      {campaignsStale && (
        <div className="tier-notice" role="status">
          <span>
            Showing the campaign list from your last visit — the server did not answer
            ({campaignsError}). Anything added since will be missing.
          </span>
          <button onClick={reloadCampaigns} disabled={campaignsLoading}>
            {campaignsLoading ? 'Trying...' : 'Retry'}
          </button>
        </div>
      )}

      {campaignsLoading && nothingToShow && !campaignsError && (
        <div className="loading">Loading campaigns...</div>
      )}

      {!campaignsLoading && !campaignsError && nothingToShow && (
        <div className="loading">No campaigns found. Check data/campaigns on the server.</div>
      )}

      {!nothingToShow && (
        <>
          <CategoryTabs active={activeCategory} counts={counts} onSelect={chooseCategory} />
          <p className="category-tagline">{activeMeta.tagline}</p>
        </>
      )}

      {!nothingToShow && shown.length === 0 && (
        <div className="loading">No {activeMeta.label} campaigns yet.</div>
      )}

      {shown.map(campaign => (
        <CampaignTier key={campaign.id} campaign={campaign} />
      ))}
    </div>
  );
}

export default Home;
