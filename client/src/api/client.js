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

async function fetchJson(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...getPlayerHeaders(),
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

export const api = {
  // Characters
  getCharacters: () => fetchJson('/characters'),
  getCharacter: (id) => fetchJson(`/characters/${id}`),
  createCharacter: (data) => fetchJson('/characters', { method: 'POST', body: JSON.stringify(data) }),
  updateCharacter: (id, data) => fetchJson(`/characters/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteCharacter: (id) => fetchJson(`/characters/${id}`, { method: 'DELETE' }),
  importCharacter: (data) => fetchJson('/characters/import', { method: 'POST', body: JSON.stringify(data) }),

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
  restoreDefaults: (scope) => fetchJson(`/settings/restore-defaults${scope ? `?scope=${scope}` : ''}`, { method: 'POST' }),

  // Players / Auth
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
  addPlayerToSession: (id, data) => fetchJson(`/sessions/${id}/players`, { method: 'POST', body: JSON.stringify(data) }),
};
