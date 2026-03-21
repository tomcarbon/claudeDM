/**
 * REST API client for bot players.
 * Calls the same endpoints as real players using HTTP to localhost.
 */

class BotApiClient {
  constructor({ email, port = 3001 }) {
    this.email = email;
    this.baseUrl = `http://localhost:${port}/api`;
  }

  async _fetch(path, opts = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'X-Player-Email': this.email,
      ...(opts.campaignId ? { 'X-Campaign-Id': opts.campaignId } : {}),
      ...opts.headers,
    };
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Bot API ${opts.method || 'GET'} ${path} failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  async getCampaigns() {
    return this._fetch('/campaigns');
  }

  async getScenarios(campaignId) {
    return this._fetch('/scenarios', { campaignId });
  }

  async getCharacters(campaignId) {
    return this._fetch('/characters', { campaignId });
  }

  async getSessions(campaignId) {
    return this._fetch('/sessions', { campaignId });
  }

  async getMyGames() {
    return this._fetch('/sessions/my-games');
  }

  async createSession(campaignId, data) {
    return this._fetch('/sessions', {
      method: 'POST',
      campaignId,
      body: data,
    });
  }

  async updateSession(campaignId, sessionId, data) {
    return this._fetch(`/sessions/${sessionId}`, {
      method: 'PUT',
      campaignId,
      body: data,
    });
  }

  async joinSession(campaignId, sessionId, npcId) {
    return this._fetch(`/sessions/${sessionId}/join`, {
      method: 'POST',
      campaignId,
      body: { npcId },
    });
  }

  async unjoinSession(campaignId, sessionId, npcId) {
    return this._fetch(`/sessions/${sessionId}/unjoin`, {
      method: 'POST',
      campaignId,
      body: { npcId },
    });
  }
}

module.exports = { BotApiClient };
