const API_BASE = `http://${window.location.hostname}:3001/api`;

function getPlayerHeaders() {
  try {
    const raw = localStorage.getItem('dnd_player');
    if (!raw) return {};
    const player = JSON.parse(raw);
    const headers = {};
    if (player?.email) headers['X-Player-Email'] = player.email;
    if (player?.role) headers['X-Player-Role'] = player.role;
    return headers;
  } catch {
    return {};
  }
}

function getCampaignHeader() {
  try {
    const cid = localStorage.getItem('dnd_campaign');
    return cid ? { 'X-Campaign-Id': cid } : {};
  } catch {
    return {};
  }
}

function getSessionHeaders() {
  try {
    const sessionId = localStorage.getItem('dnd_active_session_id');
    const sessionOwner = localStorage.getItem('dnd_active_session_owner');
    const headers = {};
    if (sessionId) headers['X-Session-Id'] = sessionId;
    if (sessionOwner) headers['X-Session-Owner'] = sessionOwner;
    return headers;
  } catch {
    return {};
  }
}

async function fetchJson(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...getPlayerHeaders(),
    ...getCampaignHeader(),
    ...getSessionHeaders(),
    ...(options.headers || {}),
  };

  const res = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const error = new Error(err.error || res.statusText);
    if (err.errors) error.errors = err.errors;
    throw error;
  }
  return res.json();
}

// Fetch without session headers (for personal roster when session is active)
async function fetchJsonNoSession(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...getPlayerHeaders(),
    ...getCampaignHeader(),
    ...(options.headers || {}),
  };
  const res = await fetch(`${API_BASE}${url}`, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const error = new Error(err.error || res.statusText);
    if (err.errors) error.errors = err.errors;
    throw error;
  }
  return res.json();
}

export function hasActiveSession() {
  return !!localStorage.getItem('dnd_active_session_id');
}

export const api = {
  // Characters
  getCharacters: () => fetchJson('/characters'),
  getCharacter: (id) => fetchJson(`/characters/${id}`),
  // Personal roster (bypasses session headers — always reads global player dir)
  getMyCharacters: () => fetchJsonNoSession('/characters'),
  getMyNpcs: () => fetchJsonNoSession('/npcs'),
  createCharacter: (data) => fetchJson('/characters', { method: 'POST', body: JSON.stringify(data) }),
  updateCharacter: (id, data) => fetchJson(`/characters/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteCharacter: (id) => fetchJson(`/characters/${id}`, { method: 'DELETE' }),
  importCharacter: (data) => fetchJson('/characters/import', { method: 'POST', body: JSON.stringify(data) }),
  rollCharacter: () => fetchJson('/characters/roll', { method: 'POST' }),

  // NPCs
  getNpcs: () => fetchJson('/npcs'),
  getNpc: (id) => fetchJson(`/npcs/${id}`),

  // Rules
  getRuleCategories: () => fetchJson('/rules'),
  getRule: (category) => fetchJson(`/rules/${category}`),

  // Scenarios
  getScenarios: () => fetchJson('/scenarios'),
  getScenario: (id) => fetchJson(`/scenarios/${id}`),

  // Campaigns
  getCampaigns: () => fetchJson('/campaigns'),
  getCampaign: (id) => fetchJson(`/campaigns/${id}`),
  createCampaign: (data) => fetchJson('/campaigns', { method: 'POST', body: JSON.stringify(data) }),
  updateCampaign: (id, data) => fetchJson(`/campaigns/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteCampaign: (id) => fetchJson(`/campaigns/${id}`, { method: 'DELETE' }),

  // DM Settings
  getDmSettings: () => fetchJson('/dm-settings'),
  updateDmSettings: (data) => fetchJson('/dm-settings', { method: 'PUT', body: JSON.stringify(data) }),
  resetDmSettings: () => fetchJson('/dm-settings/mine', { method: 'DELETE' }),
  getGlobalDmSettings: () => fetchJson('/dm-settings/global'),
  updateGlobalDmSettings: (data) => fetchJson('/dm-settings/global', { method: 'PUT', body: JSON.stringify(data) }),

  // Settings
  resetMyData: (scope, id) => fetchJson(`/settings/reset-my-data?scope=${scope}${id ? `&id=${id}` : ''}`, { method: 'POST' }),

  // Players / Auth
  lookupPlayers: (emails) => fetchJson(`/players/lookup?emails=${encodeURIComponent(emails.join(','))}`),
  playerLogin: (email, password) => fetchJson('/players/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  playerRegister: (email, name, password) => fetchJson('/players/register', { method: 'POST', body: JSON.stringify({ email, name, password }) }),
  playerChangePassword: (email, currentPassword, newPassword) => fetchJson('/players/password', { method: 'PUT', body: JSON.stringify({ email, currentPassword, newPassword }) }),

  // Chat (persistent, day-based)
  getChatMessages: (date) => fetchJson(`/chat${date ? `?date=${encodeURIComponent(date)}` : ''}`),
  getChatDates: () => fetchJson('/chat/dates'),

  // Sessions (multiplayer-ready)
  getSessions: () => fetchJson('/sessions'),
  getSession: (id) => fetchJson(`/sessions/${id}`),
  createSession: (data) => fetchJson('/sessions', { method: 'POST', body: JSON.stringify(data) }),
  updateSession: (id, data) => fetchJson(`/sessions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteSession: (id) => fetchJson(`/sessions/${id}`, { method: 'DELETE' }),
  updateSessionSettings: (id, settings) => fetchJson(`/sessions/${id}/settings`, { method: 'PUT', body: JSON.stringify(settings) }),
  renameSession: (id, label) => fetchJson(`/sessions/${id}/label`, { method: 'PUT', body: JSON.stringify({ label }) }),
  joinSession: (id, npcId) => fetchJson(`/sessions/${id}/join`, { method: 'POST', body: JSON.stringify({ npcId }) }),
  unjoinSession: (id, npcId) => fetchJson(`/sessions/${id}/unjoin`, { method: 'POST', body: JSON.stringify({ npcId }) }),
  addPlayerToSession: (id, data) => fetchJson(`/sessions/${id}/players`, { method: 'POST', body: JSON.stringify(data) }),
  getSessionParty: (id) => fetchJson(`/sessions/${id}/party`),
};
