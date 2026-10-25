/**
 * The process-wide concurrency limit on Claude Agent SDK `query()` calls.
 *
 * WHY THIS FILE EXISTS (WO-0033). This class and its one shared instance used to live inside
 * `dm-engine.js`. A second caller now needs it — the model-driven bot brain
 * (`bot/bot-brain-model.js`) — and the bot subsystem must not `require('./dm-engine')` to get
 * it: that would pull PROJECT_ROOT, the MCP tool servers and the DM's 14-entry `allowedTools`
 * array into the bot's module graph for the sake of one counter.
 *
 * It is extracted rather than duplicated, and the distinction is the whole point. The app has
 * **no rate-limit handling** (tech debt TD-19): a 429 from the provider fails for every player
 * at once. If bot brain calls queued separately from DM turns, a running bot farm could trip
 * that limit and take down a human's table. One queue to the provider, shared by everybody.
 *
 * Ordering note for anyone adding a third caller: the bot orchestrator's own
 * `maxConcurrentApiCalls` semaphore (`bot-orchestrator.js`, bots only) is always acquired
 * OUTSIDE this one. Keep that order — outer bot slot, then inner query slot — or two nested
 * semaphores acquired in opposite orders will deadlock.
 *
 * `MAX_CONCURRENT_QUERIES` and the class body are unchanged from the dm-engine original.
 */

const MAX_CONCURRENT_QUERIES = 3;

class QuerySemaphore {
  constructor(max) {
    this._max = max;
    this._active = 0;
    this._queue = [];
  }
  acquire() {
    if (this._active < this._max) {
      this._active++;
      return Promise.resolve();
    }
    return new Promise(resolve => this._queue.push(resolve));
  }
  release() {
    this._active--;
    if (this._queue.length > 0) {
      this._active++;
      this._queue.shift()();
    }
  }
}

/**
 * The one instance. Node's module cache makes this a singleton per process, which is the
 * mechanism by which the DM and the bot brain share a queue; there is no registry and no
 * second `new QuerySemaphore(MAX_CONCURRENT_QUERIES)` anywhere in the tree.
 */
const querySemaphore = new QuerySemaphore(MAX_CONCURRENT_QUERIES);

module.exports = { QuerySemaphore, querySemaphore, MAX_CONCURRENT_QUERIES };
