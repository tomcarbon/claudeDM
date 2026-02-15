const { WebSocketServer } = require('ws');

function attachWebSocket(server, dataDir, manager) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    console.log('[WS] Client connected');
    let playerId = null;

    function send(type, payload = {}) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type, ...payload }));
      }
    }

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send('error', { error: 'Invalid JSON' });
        return;
      }

      switch (msg.type) {
        // --- Multiplayer: create a new game ---
        case 'create_game': {
          const { playerName, characterId, scenarioId } = msg;
          if (!playerName || !characterId || !scenarioId) {
            send('error', { error: 'Missing playerName, characterId, or scenarioId.' });
            return;
          }
          try {
            const room = manager.createRoom(dataDir, scenarioId);
            playerId = room.addPlayer(ws, playerName, characterId, true);
            manager.registerPlayer(playerId, room.gameCode);
            send('game_created', { gameCode: room.gameCode, playerId });
            send('session_status', { status: 'idle' });
            console.log(`[WS] Game created — code: ${room.gameCode}, host: ${playerName}`);
          } catch (err) {
            send('error', { error: err.message });
          }
          break;
        }

        // --- Multiplayer: join an existing game ---
        case 'join_game': {
          const { gameCode, playerName, characterId } = msg;
          if (!gameCode || !playerName || !characterId) {
            send('error', { error: 'Missing gameCode, playerName, or characterId.' });
            return;
          }
          const room = manager.getRoom(gameCode);
          if (!room) {
            send('error', { error: `No game found with code: ${gameCode.toUpperCase()}` });
            return;
          }
          try {
            playerId = room.addPlayer(ws, playerName, characterId, false);
            manager.registerPlayer(playerId, room.gameCode);
            send('game_joined', { gameCode: room.gameCode, playerId });
            send('session_status', { status: 'idle' });
            // Send existing message history to the joining player
            if (room.messageHistory.length > 0) {
              send('message_history', { messages: room.messageHistory });
            }
            console.log(`[WS] Player joined — code: ${room.gameCode}, player: ${playerName}`);
          } catch (err) {
            send('error', { error: err.message });
          }
          break;
        }

        // --- Multiplayer: rejoin after disconnect ---
        case 'rejoin_game': {
          const { gameCode, playerName } = msg;
          const room = manager.getRoom(gameCode);
          if (!room) {
            send('error', { error: `No active game with code: ${(gameCode || '').toUpperCase()}` });
            return;
          }
          const existing = room.findPlayerByName(playerName);
          if (existing) {
            playerId = existing.playerId;
            room.reconnectPlayer(playerId, ws);
            send('game_joined', { gameCode: room.gameCode, playerId, rejoined: true });
            send('session_status', { status: room.processing ? 'thinking' : 'idle' });
            console.log(`[WS] Player rejoined — code: ${room.gameCode}, player: ${playerName}`);
          } else {
            send('error', { error: `No player named "${playerName}" in game ${gameCode.toUpperCase()}` });
          }
          break;
        }

        // --- Multiplayer: leave game ---
        case 'leave_game': {
          if (playerId) {
            const room = manager.getRoomForPlayer(playerId);
            if (room) {
              const empty = room.removePlayer(playerId);
              manager.unregisterPlayer(playerId);
              if (empty) {
                manager.scheduleDestroy(room.gameCode);
              }
            }
            playerId = null;
          }
          break;
        }

        // --- Multiplayer: host starts the adventure ---
        case 'start_game': {
          const room = playerId ? manager.getRoomForPlayer(playerId) : null;
          if (!room) {
            send('error', { error: 'Not in a game.' });
            return;
          }
          const player = room.players.get(playerId);
          if (!player || !player.isHost) {
            send('error', { error: 'Only the host can start the game.' });
            return;
          }
          room.broadcast('game_started', {});
          // Auto-send the opening prompt
          const { scenarioId } = room;
          const playerList = room.getPlayerList();
          const charNames = playerList.map(p => p.characterName).join(', ');
          const openingText = msg.openingPrompt || `Begin the adventure. The party consists of: ${charNames}. Set the scene and begin the story.`;
          await room.handleMessage(playerId, { type: 'user_message', text: openingText });
          break;
        }

        // --- Player message (works for both solo and multiplayer) ---
        case 'user_message': {
          const room = playerId ? manager.getRoomForPlayer(playerId) : null;
          if (!room) {
            send('error', { error: 'Not in a game. Create or join one first.' });
            return;
          }
          await room.handleMessage(playerId, msg);
          break;
        }

        // --- Permission response (host only) ---
        case 'permission_response': {
          const room = playerId ? manager.getRoomForPlayer(playerId) : null;
          if (room) {
            room.handlePermissionResponse(playerId, msg.toolUseID, msg.allowed);
          }
          break;
        }

        // --- Solo backward compat: session_start auto-creates a game ---
        case 'session_start': {
          const characterId = msg.characterId || null;
          const scenarioId = msg.scenarioId || null;
          if (!characterId || !scenarioId) {
            send('error', { error: 'Missing characterId or scenarioId.' });
            return;
          }
          try {
            const room = manager.createRoom(dataDir, scenarioId);
            playerId = room.addPlayer(ws, 'Player', characterId, true);
            manager.registerPlayer(playerId, room.gameCode);
            send('game_created', { gameCode: room.gameCode, playerId });
            send('session_status', { status: 'idle' });
            console.log(`[WS] Solo session started — code: ${room.gameCode}, character: ${characterId}`);
          } catch (err) {
            send('error', { error: err.message });
          }
          break;
        }

        // --- Solo backward compat: session_resume ---
        case 'session_resume': {
          const { characterId, scenarioId, claudeSessionId, messages } = msg;
          try {
            const room = manager.createRoom(dataDir, scenarioId);
            if (claudeSessionId) {
              room.engine.sessionId = claudeSessionId;
            }
            if (messages && Array.isArray(messages)) {
              room.messageHistory = messages;
            }
            playerId = room.addPlayer(ws, 'Player', characterId, true);
            manager.registerPlayer(playerId, room.gameCode);
            send('game_created', { gameCode: room.gameCode, playerId });
            send('session_status', { status: 'idle' });
            console.log(`[WS] Solo session resumed — code: ${room.gameCode}, claude: ${claudeSessionId}`);
          } catch (err) {
            send('error', { error: err.message });
          }
          break;
        }

        default:
          send('error', { error: `Unknown message type: ${msg.type}` });
      }
    });

    ws.on('close', () => {
      console.log('[WS] Client disconnected');
      if (playerId) {
        const room = manager.getRoomForPlayer(playerId);
        if (room) {
          const allDisconnected = room.disconnectPlayer(playerId);
          if (allDisconnected) {
            manager.scheduleDestroy(room.gameCode);
          }
        }
      }
    });

    ws.on('error', (err) => {
      console.error('[WS] Error:', err.message);
    });
  });

  console.log('[WS] WebSocket server attached at /ws');
  return wss;
}

module.exports = { attachWebSocket };
