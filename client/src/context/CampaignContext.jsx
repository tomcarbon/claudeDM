import { createContext, useContext, useState, useCallback } from 'react';

const STORAGE_KEY = 'dnd_campaign';
const DEFAULT_CAMPAIGN = 'demo';

const CampaignContext = createContext(null);

function getStoredCampaign() {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_CAMPAIGN;
  } catch {
    return DEFAULT_CAMPAIGN;
  }
}

export function CampaignProvider({ children }) {
  const [campaignId, setCampaignIdState] = useState(getStoredCampaign);

  const selectCampaign = useCallback((id) => {
    const cid = id || DEFAULT_CAMPAIGN;
    setCampaignIdState(cid);
    try { localStorage.setItem(STORAGE_KEY, cid); } catch { /* ignore */ }
  }, []);

  return (
    <CampaignContext.Provider value={{ campaignId, selectCampaign }}>
      {children}
    </CampaignContext.Provider>
  );
}

export function useCampaign() {
  const ctx = useContext(CampaignContext);
  if (!ctx) throw new Error('useCampaign must be inside CampaignProvider');
  return ctx;
}
