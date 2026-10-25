const WebSocket = require('ws');
const EventEmitter = require('events');

/**
 * How long a permission request may go unanswered before this client declines it.
 *
 * The engine's onPermissionRequest (ws-handler.js `:1566`) returns a promise that only settles
 * when a `permission_response` arrives, so a client that never answers hangs the turn forever.
 * That deadlock is the reason the original code blanket-approved every request. The deadlock
 * protection is kept; the answer it gives is reversed. Twenty seconds is long enough for a
 * deliberate policy — including a future one that asks a model — and short enough that a stuck
 * agent frees the table on the same order as a human losing patience.
 */
const DEFAULT_PERMISSION_TIMEOUT_MS = 20_000;

/**
 * WebSocket client for a single bot player.
 * Speaks the same JSON protocol as the browser client.
 *
 * ## Permission policy: absent means no
 *
 * `onPermissionRequest` is injected, and when it is omitted every request is **declined**.
 * This is deliberate and is not caution for its own sake. The tool this surface guards is
 * `mcp__dnd-tools__OverrideMechanicalState` — the DM asking to set a hit-point total, a status
 * or a death save outside the rules (ADR 0005). Its consent path has never run in production,
 * and neither has its deny branch. A simulated player wired to click Allow would produce a
 * green transcript that proves only that the approve path does not crash, while leaving the
 * one behaviour the prompt exists for — somebody stopping and reading and being able to say no
 * — untested. So the default is no, a policy must be supplied on purpose to say yes, and a
 * policy that fails to answer in time also says no.
 *
 * @param {object}   opts
 * @param {string}   opts.email
 * @param {string}   opts.name
 * @param {number}  [opts.port=3001]
 * @param {(msg: object) => boolean|Promise<boolean>} [opts.onPermissionRequest]
 *        Decides one request. Anything other than a resolved `true` is treated as a decline,
 *        including a throw, a rejection and a non-boolean.
 * @param {number}  [opts.permissionTimeoutMs=20000]
 */
class BotWebSocketClient extends EventEmitter {
  constructor({
    email,
    name,
    port = 3001,
    onPermissionRequest = null,
    permissionTimeoutMs = DEFAULT_PERMISSION_TIMEOUT_MS,
  }) {
    super();
    this.email = email;
    this.name = name;
    this.port = port;
    this.url = `ws://localhost:${port}/ws`;
    this.ws = null;
    this.connected = false;
    this._reconnectTimer = null;
    this._closed = false;
    this.onPermissionRequest = onPermissionRequest;
    this.permissionTimeoutMs = permissionTimeoutMs;
    this._permissionTimers = new Set();

    // Registered HERE, not in connect(). `_scheduleReconnect` calls connect() again on every
    // drop, so a listener added there accumulated one copy per reconnect — an EventEmitter leak
    // that was invisible only because ws-handler deletes the pending entry on the first
    // response (`:1751`), making the duplicate answers no-ops. One connection object per client
    // may come and go; the policy belongs to the client.
    this.on('permission_request', (msg) => this._handlePermissionRequest(msg));
  }

  /**
   * Answer exactly one `permission_request`. Exactly one response is ever sent: whichever of
   * the policy and the timeout gets there first wins, and the loser is discarded.
   */
  _handlePermissionRequest(msg) {
    let answered = false;
    const answer = (allowed) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      this._permissionTimers.delete(timer);
      this.send({ type: 'permission_response', toolUseID: msg && msg.toolUseID, allowed: allowed === true });
    };

    const timer = setTimeout(() => {
      console.warn(
        `[BotWS:${this.name}] Permission request unanswered after ${this.permissionTimeoutMs}ms `
        + `— declining ${(msg && msg.toolName) || 'tool'}`
      );
      answer(false);
    }, this.permissionTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    this._permissionTimers.add(timer);

    if (typeof this.onPermissionRequest !== 'function') {
      // No policy was injected. Decline — see the class comment.
      answer(false);
      return;
    }

    Promise.resolve()
      .then(() => this.onPermissionRequest(msg))
      .then((allowed) => answer(allowed === true))
      .catch((err) => {
        console.error(`[BotWS:${this.name}] Permission policy threw — declining:`, err && err.message);
        answer(false);
      });
  }

  connect() {
    if (this._closed) return;
    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      console.error(`[BotWS:${this.name}] Connection error:`, err.message);
      this._scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.connected = true;
      this.emit('connected');
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.emit('message', msg);
        // Emit typed events for convenience
        if (msg.type) {
          this.emit(msg.type, msg);
        }
      } catch (err) {
        console.error(`[BotWS:${this.name}] Parse error:`, err.message);
      }
    });

    this.ws.on('close', () => {
      this.connected = false;
      this.emit('disconnected');
      if (!this._closed) this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error(`[BotWS:${this.name}] WS error:`, err.message);
    });
  }

  _scheduleReconnect() {
    if (this._closed || this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._closed) this.connect();
    }, 3000);
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // -- Game protocol methods --

  startSession(characterId, scenarioId, campaignId, companionConfig) {
    this.send({
      type: 'session_start',
      playerEmail: this.email,
      playerName: this.name,
      characterId,
      scenarioId,
      campaignId,
      companionConfig,
    });
  }

  // `resumeSession` was here. Deleted, not disabled — see the note above `sendUserMessage`.

  // ── THE FREE-TEXT EMITTERS ARE A CLOSED SET OF TWO (WO-0036 J2, S-2) ──────────────────────
  //
  // These two methods — and only these two — put words from a bot onto a socket. The chair's
  // instruction was *"I don't want to see them any more"* about canned bot text, and J2's
  // guarantee is that a bot which has nothing to say says nothing. That guarantee is held in
  // `_playTurn`, which returns before either call when the brain yielded null.
  //
  // **Three more emitters used to live on this class and are deleted rather than disabled.** They
  // had no caller anywhere in the project, and an uncalled emitter is not harmless — it is a
  // one-line route around the only guarantee the chair will notice being broken:
  //
  //   - `submitHostTurn(text)`  →  `{type:'host_turn_submit'}`.  Never called. It would have put
  //     canned text into the GAME TRANSCRIPT, which is worse than chat, because the DM reads the
  //     transcript and would have answered it.
  //   - `sendChat(text)`  →  `{type:'chat_message', chatKey:'global'}`.  Never called, and
  //     reachable on an ALREADY-OPEN socket: `bot-orchestrator.js:396` joins `bot.chatWs` to
  //     global chat for presence, so a single added line would have broadcast a phrase to every
  //     watcher. `sdet`'s mutation VP8 planted exactly that line in the `turnText === null`
  //     branch — canned text on precisely the failure the chair banned — and killed 0 of 114
  //     tests. The capability is gone; `joinChat` stays, because presence sends no words.
  //   - `resumeSession(...)`  →  `{type:'session_resume', messages, ...}`.  Never called; the CEO
  //     ruled on it in WO-0036 revision 3 after `security-reviewer` planted it in
  //     `_wireSessionSlot` for 0 of 943 kills. **It is worse than either sibling.** The others
  //     added text; this one hands over `messages` WHOLESALE, and `ws-handler.js:1345-1347`
  //     assigns `messageHistory = msg.messages` with no validation and then persists it through
  //     the compaction that runs immediately below. An uncalled emitter that can forge the entire
  //     transcript is the strongest case there is for the rule that an uncalled emitter is not
  //     harmless. Reconnect does NOT need it: `_scheduleReconnect` calls `this.connect()`.
  //
  //     **Scope, because it is easy to over-read:** this removes a BOT-CLIENT CAPABILITY, not a
  //     protocol message. The server-side `session_resume` handler (`ws-handler.js:1284`) stays,
  //     and the human client at `client/src/hooks/useWebSocket.js:461` legitimately sends the
  //     type. Do not "finish the job" by deleting the handler.
  //
  // Three things now hold this closed, and they are deliberately of different kinds, because a
  // source assertion and a behavioural one fail for different edits:
  //   1. the capability does not exist on this class (here);
  //   2. `_playTurn` calls NOTHING on the socket when the brain had nothing — asserted at
  //      runtime over a recording proxy, so an emitter nobody anticipated is caught too
  //      (`bot-brain-seam.test.js`, `the socket is not touched AT ALL`);
  //   3. the set of emitter names in `bot-orchestrator.js` and on this class is pinned at the
  //      source, so re-adding one fails by name.
  // Do not add a third sender here without reading all three.
  sendUserMessage(text) {
    this.send({ type: 'user_message', text });
  }

  submitCompanionTurn(text, npcId, npcName, characterId, characterName) {
    this.send({
      type: 'companion_turn_submit',
      text,
      npcId,
      npcName,
      characterId,
      characterName,
    });
  }

  setCompanionCharacter(characterId, characterName, npcName, characterData) {
    this.send({
      type: 'companion_set_character',
      characterId,
      characterName,
      npcName,
      characterData,
    });
  }

  watchSession(sessionDbId) {
    this.send({
      type: 'session_watch',
      sessionDbId,
      playerEmail: this.email,
      playerName: this.name,
    });
  }

  unwatchSession(sessionDbId) {
    this.send({ type: 'session_unwatch', sessionDbId });
  }

  joinChat(chatKey) {
    this.send({
      type: 'chat_join',
      chatKey,
      playerEmail: this.email,
      playerName: this.name,
    });
  }

  // `sendChat` was here. Deleted, not disabled — see the note above `sendUserMessage`.

  close() {
    this._closed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    for (const timer of this._permissionTimers) clearTimeout(timer);
    this._permissionTimers.clear();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}

module.exports = { BotWebSocketClient, DEFAULT_PERMISSION_TIMEOUT_MS };
