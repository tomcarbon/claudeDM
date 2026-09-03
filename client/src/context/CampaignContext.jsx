import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { findCampaign } from '../utils/campaignListing';

const STORAGE_KEY = 'dnd_campaign';
const DEFAULT_CAMPAIGN = 'demo';

// Last successful GET /api/campaigns. Home renders this when the server cannot be reached, so a
// dead API costs the player a stale list and a warning rather than an empty page (WO-0009).
const LIST_CACHE_KEY = 'dnd_campaigns_cache';

const CampaignContext = createContext(null);

function getStoredCampaign() {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_CAMPAIGN;
  } catch {
    return DEFAULT_CAMPAIGN;
  }
}

function readCachedCampaigns() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LIST_CACHE_KEY) || 'null');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeCachedCampaigns(campaigns) {
  try {
    localStorage.setItem(LIST_CACHE_KEY, JSON.stringify(campaigns));
  } catch { /* quota or private mode — the cache is an optimisation, not a requirement */ }
}

export function CampaignProvider({ children }) {
  const [campaignId, setCampaignIdState] = useState(getStoredCampaign);

  // Seeded from the cache so a returning player sees the list on the first paint, then replaced
  // by whatever the server says. On a first-ever visit this starts empty and `loading` covers it.
  const [campaigns, setCampaigns] = useState(readCachedCampaigns);
  const [campaignsLoading, setCampaignsLoading] = useState(true);
  const [campaignsError, setCampaignsError] = useState(null);

  const fetchCampaigns = useCallback(() => api.getCampaigns()
    .then(list => {
      const fetched = Array.isArray(list) ? list : [];
      setCampaigns(fetched);
      setCampaignsError(null);
      writeCachedCampaigns(fetched);
    })
    .catch(err => {
      // Keep whatever is already on screen (cache, or an earlier good fetch) and say so.
      setCampaignsError(err?.message || 'Could not reach the server');
    })
    .finally(() => setCampaignsLoading(false)), []);

  // No setState in the effect body: campaignsLoading already starts true, and every state change
  // below happens in a promise callback (react-hooks/set-state-in-effect).
  useEffect(() => { fetchCampaigns(); }, [fetchCampaigns]);

  // What the retry button calls. Same fetch, but it puts the UI back into its loading state first.
  const reloadCampaigns = useCallback(() => {
    setCampaignsLoading(true);
    return fetchCampaigns();
  }, [fetchCampaigns]);

  const selectCampaign = useCallback((id) => {
    const cid = id || DEFAULT_CAMPAIGN;
    setCampaignIdState(cid);
    try { localStorage.setItem(STORAGE_KEY, cid); } catch { /* ignore */ }
  }, []);

  const campaign = useMemo(() => findCampaign(campaigns, campaignId), [campaigns, campaignId]);

  const value = useMemo(() => ({
    campaignId,
    selectCampaign,
    // The campaign the player is in, once the list has arrived. Null while loading, and null for
    // an id the server does not know about — callers must have a fallback.
    campaign,
    campaigns,
    campaignsLoading,
    campaignsError,
    // True when the list on screen is the last known good one rather than a fresh answer.
    campaignsStale: !!campaignsError && campaigns.length > 0,
    reloadCampaigns,
  }), [campaignId, selectCampaign, campaign, campaigns, campaignsLoading, campaignsError, reloadCampaigns]);

  return (
    <CampaignContext.Provider value={value}>
      {children}
    </CampaignContext.Provider>
  );
}

export function useCampaign() {
  const ctx = useContext(CampaignContext);
  if (!ctx) throw new Error('useCampaign must be inside CampaignProvider');
  return ctx;
}
