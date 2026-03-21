const WebSocket = require('ws');
const EventEmitter = require('events');

/**
 * WebSocket client for a single bot player.
 * Speaks the same JSON protocol as the browser client.
 */
class BotWebSocketClient extends EventEmitter {
  constructor({ email, name, port = 3001 }) {
    super();
    this.email = email;
    this.name = name;
    this.port = port;
    this.url = `ws://localhost:${port}/ws`;
    this.ws = null;
    this.connected = false;
    this._reconnectTimer = null;
    this._closed = false;
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

    // Auto-approve all DM tool permission requests so the engine doesn't hang
    this.on('permission_request', (msg) => {
      this.send({ type: 'permission_response', toolUseID: msg.toolUseID, allow: true });
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

  resumeSession(claudeSessionId, characterId, scenarioId, campaignId, messages, sessionDbId, companionConfig) {
    this.send({
      type: 'session_resume',
      playerEmail: this.email,
      playerName: this.name,
      claudeSessionId,
      characterId,
      scenarioId,
      campaignId,
      messages,
      sessionDbId,
      companionConfig,
    });
  }

  sendUserMessage(text) {
    this.send({ type: 'user_message', text });
  }

  submitHostTurn(text) {
    this.send({ type: 'host_turn_submit', text });
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

  sendChat(text) {
    this.send({
      type: 'chat_message',
      chatKey: 'global',
      text,
      playerEmail: this.email,
      playerName: this.name,
    });
  }

  close() {
    this._closed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}

module.exports = { BotWebSocketClient };
