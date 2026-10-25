/**
 * How long any single bot API call may take before it is aborted.
 *
 * SR-5. `fetch` has no default timeout, so a request that connects and then never gets a reply
 * hangs forever. That became a shutdown hazard when `BotOrchestrator.stop()` started issuing
 * unjoins over HTTP and `SIGINT` started awaiting `stop()` before `process.exit`: one
 * unanswered request and Ctrl-C never returns. The bound belongs here rather than at the one
 * call site, because every method on this class has the same shape and the same exposure.
 */
const DEFAULT_API_TIMEOUT_MS = 15_000;

/**
 * REST API client for bot players.
 * Calls the same endpoints as real players using HTTP to localhost.
 *
 * @param {object}  opts
 * @param {string}  opts.email
 * @param {number} [opts.port=3001]
 * @param {number} [opts.timeoutMs=15000] per-request abort deadline
 */
class BotApiClient {
  constructor({ email, port = 3001, timeoutMs = DEFAULT_API_TIMEOUT_MS }) {
    this.email = email;
    this.baseUrl = `http://localhost:${port}/api`;
    this.timeoutMs = timeoutMs;
  }

  async _fetch(path, opts = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'X-Player-Email': this.email,
      ...(opts.campaignId ? { 'X-Campaign-Id': opts.campaignId } : {}),
      ...opts.headers,
    };
    const url = `${this.baseUrl}${path}`;
    // The tightest deadline wins. A per-call `timeoutMs` (the shutdown path asks for a short
    // one) can only shorten the client's own bound, never lengthen it — so a client configured
    // to be impatient stays impatient, and no call site can opt out of having a deadline.
    const timeoutMs = Math.min(this.timeoutMs, opts.timeoutMs ?? Infinity);
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
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

  async getNpcs(campaignId) {
    return this._fetch('/npcs', { campaignId });
  }

  async setSessionLabel(campaignId, sessionId, label) {
    return this._fetch(`/sessions/${sessionId}/label`, {
      method: 'PUT',
      campaignId,
      body: { label },
    });
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

  async unjoinSession(campaignId, sessionId, npcId, opts = {}) {
    return this._fetch(`/sessions/${sessionId}/unjoin`, {
      method: 'POST',
      campaignId,
      body: { npcId },
      timeoutMs: opts.timeoutMs,
    });
  }
}

module.exports = { BotApiClient, DEFAULT_API_TIMEOUT_MS };
