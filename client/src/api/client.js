const API_BASE = 'http://localhost:3001/api';

async function fetchJson(url, options = {}) {
  const res = await fetch(`${API_BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
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

  // NPCs
  getNpcs: () => fetchJson('/npcs'),
  getNpc: (id) => fetchJson(`/npcs/${id}`),

  // Rules
  getRuleCategories: () => fetchJson('/rules'),
  getRule: (category) => fetchJson(`/rules/${category}`),

  // Scenarios
  getScenarios: () => fetchJson('/scenarios'),
  getScenario: (id) => fetchJson(`/scenarios/${id}`),

  // DM Settings
  getDmSettings: () => fetchJson('/dm-settings'),
  updateDmSettings: (data) => fetchJson('/dm-settings', { method: 'PUT', body: JSON.stringify(data) }),

  // Sessions (multiplayer-ready)
  getSessions: () => fetchJson('/sessions'),
  getSession: (id) => fetchJson(`/sessions/${id}`),
  createSession: (data) => fetchJson('/sessions', { method: 'POST', body: JSON.stringify(data) }),
  updateSession: (id, data) => fetchJson(`/sessions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  addPlayerToSession: (id, data) => fetchJson(`/sessions/${id}/players`, { method: 'POST', body: JSON.stringify(data) }),
};
