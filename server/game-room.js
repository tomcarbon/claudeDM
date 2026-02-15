const { v4: uuidv4 } = require('uuid');
const { DmEngine } = require('./dm-engine');
const fs = require('fs');
const path = require('path');

const MAX_PLAYERS = 8;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 for readability
const CODE_LENGTH = 4;

function loadCharacterName(dataDir, characterId) {
  const dir = path.join(dataDir, 'characters');
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
      if (data && data.id === characterId) return data.name;
    }
  } catch {}
  return 'Unknown';
}

class GameRoom {
  constructor(gameCode, dataDir, scenarioId) {
    this.gameCode = gameCode;
    this.dataDir = dataDir;
    this.scenarioId = scenarioId;
    this.players = new Map(); // playerId -> { ws, playerName, characterId, characterName, isHost }
    this.engine = new DmEngine(dataDir);
    this.messageHistory = [];
    this.pendingPermissions = new Map();
    this.processing = false;
    this.combatState = null; // { inCombat, turnOrder: [{playerId, playerName, characterId, initiative}], activeIndex }
    this.destroyTimer = null;

    // Combat controller passed to MCP tools
    this.combatController = {
      startCombat: (turnOrder) => this.startCombat(turnOrder),
      endCombat: () => this.endCombat(),
      nextTurn: () => this.nextTurn(),
    };
  }

  addPlayer(ws, playerName, characterId, isHost) {
    if (this.players.size >= MAX_PLAYERS) {
      throw new Error('Game is full (max 8 players)');
    }
    const playerId = uuidv4();
    const characterName = loadCharacterName(this.dataDir, characterId);
    this.players.set(playerId, { ws, playerName, characterId, characterName, isHost });

    // Cancel any pending destroy timer
    if (this.destroyTimer) {
      clearTimeout(this.destroyTimer);
      this.destroyTimer = null;
    }

    // Broadcast to existing players
    this.broadcast('player_joined', { playerId, playerName, characterId, characterName, isHost });
    this.broadcastPlayerList();
    return playerId;
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    this.players.delete(playerId);

    this.broadcast('player_left', { playerId, playerName: player.playerName });
    this.broadcastPlayerList();

    // If host left, promote next player
    if (player.isHost && this.players.size > 0) {
      const [nextId, nextPlayer] = this.players.entries().next().value;
      nextPlayer.isHost = true;
      this.sendToPlayer(nextId, 'host_promoted', { playerId: nextId });
      this.broadcastPlayerList();
    }

    return this.players.size === 0;
  }

  disconnectPlayer(playerId) {
    const player = this.players.get(playerId);
    if (player) {
      player.ws = null; // Mark as disconnected but keep in roster
      this.broadcast('player_disconnected', { playerId, playerName: player.playerName });
      this.broadcastPlayerList();
    }
    // Check if all players are disconnected
    const allDisconnected = [...this.players.values()].every(p => !p.ws);
    return allDisconnected;
  }

  reconnectPlayer(playerId, ws) {
    const player = this.players.get(playerId);
    if (player) {
      player.ws = ws;
      this.broadcast('player_reconnected', { playerId, playerName: player.playerName });
      this.broadcastPlayerList();
      // Send message history to reconnected player
      this.sendToPlayer(playerId, 'message_history', { messages: this.messageHistory });
    }
  }

  findPlayerByName(playerName) {
    for (const [id, p] of this.players) {
      if (p.playerName === playerName) return { playerId: id, ...p };
    }
    return null;
  }

  getHostId() {
    for (const [id, p] of this.players) {
      if (p.isHost) return id;
    }
    return null;
  }

  broadcast(type, payload = {}) {
    const msg = JSON.stringify({ type, ...payload });
    for (const player of this.players.values()) {
      if (player.ws && player.ws.readyState === 1) { // WebSocket.OPEN
        player.ws.send(msg);
      }
    }
  }

  sendToPlayer(playerId, type, payload = {}) {
    const player = this.players.get(playerId);
    if (player && player.ws && player.ws.readyState === 1) {
      player.ws.send(JSON.stringify({ type, ...payload }));
    }
  }

  sendToHost(type, payload = {}) {
    const hostId = this.getHostId();
    if (hostId) {
      this.sendToPlayer(hostId, type, payload);
    }
  }

  broadcastPlayerList() {
    const players = this.getPlayerList();
    this.broadcast('player_list', { players });
  }

  getPlayerList() {
    return [...this.players.entries()].map(([id, p]) => ({
      playerId: id,
      playerName: p.playerName,
      characterId: p.characterId,
      characterName: p.characterName,
      isHost: p.isHost,
      connected: p.ws !== null,
    }));
  }

  getCharacterIds() {
    return [...this.players.values()].map(p => ({
      characterId: p.characterId,
      playerName: p.playerName,
    }));
  }

  // Combat management
  startCombat(turnOrder) {
    // turnOrder: [{characterId, playerName, initiative}]
    // Map characterIds to playerIds
    const order = turnOrder.map(entry => {
      const player = [...this.players.entries()].find(
        ([, p]) => p.characterId === entry.characterId
      );
      return {
        playerId: player ? player[0] : null,
        playerName: entry.playerName,
        characterId: entry.characterId,
        initiative: entry.initiative,
      };
    });
    this.combatState = { inCombat: true, turnOrder: order, activeIndex: 0 };
    const active = order[0];
    this.broadcast('combat_started', {
      turnOrder: order,
      activePlayerId: active?.playerId,
      activePlayerName: active?.playerName,
    });
    return `Combat started. Turn order: ${order.map(e => `${e.playerName} (${e.initiative})`).join(', ')}. ${active?.playerName}'s turn.`;
  }

  endCombat() {
    this.combatState = null;
    this.broadcast('combat_ended', {});
    return 'Combat ended. Returning to free-form exploration.';
  }

  nextTurn() {
    if (!this.combatState) return 'Not in combat.';
    const { turnOrder } = this.combatState;
    this.combatState.activeIndex = (this.combatState.activeIndex + 1) % turnOrder.length;
    const active = turnOrder[this.combatState.activeIndex];
    this.broadcast('turn_changed', {
      activePlayerId: active?.playerId,
      activePlayerName: active?.playerName,
      activeIndex: this.combatState.activeIndex,
    });
    return `Next turn: ${active?.playerName}.`;
  }

  isPlayersTurn(playerId) {
    if (!this.combatState || !this.combatState.inCombat) return true;
    const active = this.combatState.turnOrder[this.combatState.activeIndex];
    // Allow if it's this player's turn, or if the active entry has no playerId (NPC turn handled by DM)
    return active?.playerId === playerId || !active?.playerId;
  }

  async handleMessage(playerId, msg) {
    if (msg.type !== 'user_message') return;

    const player = this.players.get(playerId);
    if (!player) return;

    if (this.processing) {
      this.sendToPlayer(playerId, 'error', { error: 'The DM is busy. Please wait.' });
      return;
    }

    if (!msg.text || !msg.text.trim()) {
      this.sendToPlayer(playerId, 'error', { error: 'Empty message.' });
      return;
    }

    // Combat turn check
    if (!this.isPlayersTurn(playerId)) {
      const active = this.combatState.turnOrder[this.combatState.activeIndex];
      this.sendToPlayer(playerId, 'error', {
        error: `It's not your turn. Waiting for ${active?.playerName}.`,
      });
      return;
    }

    this.processing = true;
    this.broadcast('session_status', { status: 'thinking' });

    const text = msg.text.trim();
    // Tag message with player/character name for the DM
    const taggedText = this.players.size > 1
      ? `[${player.playerName} / ${player.characterName}]: ${text}`
      : text;

    // Broadcast the player's message to all players
    const playerMsg = {
      type: 'player',
      text,
      playerId,
      playerName: player.playerName,
      characterName: player.characterName,
    };
    this.messageHistory.push(playerMsg);
    this.broadcast('player_message', playerMsg);

    try {
      const players = this.getCharacterIds();
      const stream = this.engine.run(taggedText, {
        players,
        scenarioId: this.scenarioId,
        messageHistory: this.messageHistory,
        combatController: this.combatController,
        onPermissionRequest: (toolName, input, toolUseID) => {
          return new Promise((resolve) => {
            const description = describeToolUse(toolName, input);
            this.pendingPermissions.set(toolUseID, { resolve });
            this.sendToHost('permission_request', { toolUseID, toolName, description, input });
            this.broadcast('session_status', { status: 'awaiting_permission' });
          });
        },
      });

      for await (const event of stream) {
        switch (event.type) {
          case 'dm_partial':
            this.broadcast('dm_partial', { text: event.text });
            break;
          case 'dm_response':
            this.messageHistory.push({ type: 'dm', text: event.text });
            this.broadcast('dm_response', { text: event.text });
            break;
          case 'dm_complete':
            this.broadcast('dm_complete', { sessionId: event.sessionId });
            break;
          case 'session_id':
            this.broadcast('session_id', { sessionId: event.sessionId });
            break;
          case 'error':
            this.broadcast('error', { error: event.error });
            break;
        }
      }
    } catch (err) {
      console.error(`[Room ${this.gameCode}] Engine error:`, err);
      this.broadcast('error', { error: err.message || 'DM engine error' });
    } finally {
      this.processing = false;
      this.broadcast('session_status', { status: 'idle' });
    }
  }

  handlePermissionResponse(playerId, toolUseID, allowed) {
    // Only host can respond to permission requests
    const player = this.players.get(playerId);
    if (!player || !player.isHost) return;

    const pending = this.pendingPermissions.get(toolUseID);
    if (pending) {
      this.pendingPermissions.delete(toolUseID);
      pending.resolve(allowed === true);
      this.broadcast('session_status', { status: 'thinking' });
    }
  }

  destroy() {
    if (this.destroyTimer) {
      clearTimeout(this.destroyTimer);
      this.destroyTimer = null;
    }
    this.engine.abort();
    for (const [, pending] of this.pendingPermissions) {
      pending.resolve(false);
    }
    this.pendingPermissions.clear();
  }
}

class GameRoomManager {
  constructor() {
    this.rooms = new Map(); // gameCode -> GameRoom
    this.playerToRoom = new Map(); // playerId -> gameCode
  }

  generateCode() {
    for (let attempt = 0; attempt < 100; attempt++) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('Failed to generate unique game code');
  }

  createRoom(dataDir, scenarioId) {
    const code = this.generateCode();
    const room = new GameRoom(code, dataDir, scenarioId);
    this.rooms.set(code, room);
    console.log(`[Rooms] Created room ${code} (scenario: ${scenarioId})`);
    return room;
  }

  getRoom(gameCode) {
    return this.rooms.get(gameCode?.toUpperCase()) || null;
  }

  registerPlayer(playerId, gameCode) {
    this.playerToRoom.set(playerId, gameCode);
  }

  unregisterPlayer(playerId) {
    this.playerToRoom.delete(playerId);
  }

  getRoomForPlayer(playerId) {
    const code = this.playerToRoom.get(playerId);
    return code ? this.rooms.get(code) : null;
  }

  destroyRoom(gameCode) {
    const room = this.rooms.get(gameCode);
    if (room) {
      room.destroy();
      // Unregister all players
      for (const [playerId] of room.players) {
        this.playerToRoom.delete(playerId);
      }
      this.rooms.delete(gameCode);
      console.log(`[Rooms] Destroyed room ${gameCode}`);
    }
  }

  scheduleDestroy(gameCode, delayMs = 30000) {
    const room = this.rooms.get(gameCode);
    if (!room) return;
    room.destroyTimer = setTimeout(() => {
      // Double-check it's still empty
      const allDisconnected = [...room.players.values()].every(p => !p.ws);
      if (allDisconnected) {
        this.destroyRoom(gameCode);
      }
    }, delayMs);
  }
}

function describeToolUse(toolName, input) {
  switch (toolName) {
    case 'Edit':
      return `Edit file: ${input.file_path || 'unknown'}`;
    case 'Write':
      return `Write file: ${input.file_path || 'unknown'}`;
    case 'Bash':
      return `Run command: ${(input.command || '').substring(0, 100)}`;
    default:
      return `Use tool: ${toolName}`;
  }
}

module.exports = { GameRoom, GameRoomManager };
