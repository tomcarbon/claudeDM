const { WebSocketServer } = require('ws');
const { DmEngine } = require('./dm-engine');

// Module-level chat rooms: chatKey -> Set<wsEntry>
// Each wsEntry: { ws, playerEmail, playerName, isAdmin }
const chatRooms = new Map();
let nextConnectionId = 1;

function getRoomParticipants(chatKey) {
  if (!chatRooms.has(chatKey)) return [];
  return Array.from(chatRooms.get(chatKey))
    .filter(entry => entry.ws.readyState === entry.ws.OPEN)
    .map(entry => ({
      playerEmail: entry.playerEmail || 'guest',
      playerName: entry.playerName || 'Guest',
      isAdmin: !!entry.isAdmin,
      connectionId: entry.connectionId,
    }));
}

function shouldBroadcastJoinMessage(playerName, isAdmin) {
  if (isAdmin) return false;
  const normalizedName = (playerName || '').trim().toLowerCase();
  return normalizedName !== 'guest' && normalizedName !== 'admin';
}

function attachWebSocket(server, dataDir, { appendChatMessage } = {}) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  function broadcastSystemMessage(chatKey, text) {
    const systemMsg = {
      type: 'chat_system',
      text,
      timestamp: new Date().toISOString(),
    };
    if (chatRooms.has(chatKey)) {
      for (const entry of chatRooms.get(chatKey)) {
        if (entry.ws.readyState === entry.ws.OPEN) {
          entry.ws.send(JSON.stringify(systemMsg));
        }
      }
    }
    if (chatKey === 'global' && appendChatMessage) {
      try { appendChatMessage({ isSystem: true, text, timestamp: systemMsg.timestamp }); } catch (e) { console.error('[WS] Chat persist error:', e); }
    }
  }

  function broadcastChatParticipants(chatKey) {
    const participants = getRoomParticipants(chatKey);
    if (!chatRooms.has(chatKey)) return;
    for (const entry of chatRooms.get(chatKey)) {
      if (entry.ws.readyState === entry.ws.OPEN) {
        entry.ws.send(JSON.stringify({
          type: 'chat_participants',
          chatKey,
          participants,
          selfConnectionId: entry.connectionId,
        }));
      }
    }
  }

  wss.on('connection', (ws) => {
    console.log('[WS] Client connected');

    const engine = new DmEngine(dataDir);
    let characterId = null;
    let scenarioId = null;
    let processing = false;
    let messageHistory = []; // Track conversation for resume fallback
    let currentChatKey = null;

    // This connection's chat entry
    const wsEntry = {
      ws,
      playerEmail: null,
      playerName: null,
      isAdmin: false,
      connectionId: nextConnectionId++,
    };

    // Pending permission requests: toolUseID -> { resolve }
    const pendingPermissions = new Map();

    function send(type, payload = {}) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type, ...payload }));
      }
    }

    function leaveCurrentChatRoom() {
      if (currentChatKey && chatRooms.has(currentChatKey)) {
        const room = chatRooms.get(currentChatKey);
        room.delete(wsEntry);
        if (wsEntry.playerName) {
          broadcastSystemMessage(currentChatKey, `player ${wsEntry.playerName} has left.`);
        }
        if (room.size === 0) {
          chatRooms.delete(currentChatKey);
        } else {
          broadcastChatParticipants(currentChatKey);
        }
      }
      currentChatKey = null;
    }

    function joinChatRoom(chatKey, playerEmail, playerName, isAdmin) {
      leaveCurrentChatRoom();
      currentChatKey = chatKey;
      wsEntry.playerEmail = playerEmail;
      wsEntry.playerName = playerName;
      wsEntry.isAdmin = !!isAdmin;
      if (!chatRooms.has(chatKey)) chatRooms.set(chatKey, new Set());
      chatRooms.get(chatKey).add(wsEntry);
      if (shouldBroadcastJoinMessage(playerName, wsEntry.isAdmin)) {
        broadcastSystemMessage(chatKey, `player ${playerName} has joined.`);
      }
      broadcastChatParticipants(chatKey);
      console.log(`[WS] Chat joined — key: ${chatKey}, player: ${playerEmail}, room size: ${chatRooms.get(chatKey).size}`);
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
        case 'session_start': {
          characterId = msg.characterId || null;
          scenarioId = msg.scenarioId || null;
          send('session_status', { status: 'idle' });
          console.log(`[WS] Session started — character: ${characterId}, scenario: ${scenarioId}`);
          break;
        }

        case 'session_resume': {
          characterId = msg.characterId || null;
          scenarioId = msg.scenarioId || null;
          engine.sessionId = msg.claudeSessionId || null;
          // Store message history for resume fallback
          if (msg.messages && Array.isArray(msg.messages)) {
            messageHistory = msg.messages;
          }
          send('session_status', { status: 'idle' });
          console.log(`[WS] Session resumed — claude: ${engine.sessionId}, character: ${characterId}, scenario: ${scenarioId}, history: ${messageHistory.length} messages`);
          break;
        }

        case 'chat_join': {
          const { chatKey, playerEmail, playerName, isAdmin } = msg;
          if (chatKey && playerEmail) {
            joinChatRoom(chatKey, playerEmail, playerName || playerEmail, isAdmin || false);
          }
          break;
        }

        case 'chat_message': {
          const { text, playerEmail, playerName, isAdmin } = msg;
          if (!text || !text.trim()) break;
          const chatMsg = {
            playerEmail: playerEmail || wsEntry.playerEmail || 'guest',
            playerName: playerName || wsEntry.playerName || 'Guest',
            isAdmin: isAdmin || wsEntry.isAdmin || false,
            text: text.trim(),
            timestamp: new Date().toISOString(),
          };
          // Broadcast to all in same chat room
          if (currentChatKey && chatRooms.has(currentChatKey)) {
            for (const entry of chatRooms.get(currentChatKey)) {
              if (entry.ws.readyState === entry.ws.OPEN) {
                entry.ws.send(JSON.stringify({ type: 'chat_message', ...chatMsg }));
              }
            }
          } else {
            // Echo back to sender only if no room
            send('chat_message', chatMsg);
          }
          // Persist global chat messages to daily file
          if (currentChatKey === 'global' && appendChatMessage) {
            try { appendChatMessage(chatMsg); } catch (e) { console.error('[WS] Chat persist error:', e); }
          }
          break;
        }

        case 'user_message': {
          if (processing) {
            send('error', { error: 'Already processing a message. Please wait.' });
            return;
          }
          if (!msg.text || !msg.text.trim()) {
            send('error', { error: 'Empty message.' });
            return;
          }

          processing = true;
          send('session_status', { status: 'thinking' });

          try {
            messageHistory.push({ type: 'player', text: msg.text.trim() });
            const stream = engine.run(msg.text.trim(), {
              characterId,
              scenarioId,
              messageHistory,
              onPermissionRequest: (toolName, input, toolUseID) => {
                return new Promise((resolve) => {
                  const description = describeToolUse(toolName, input);
                  pendingPermissions.set(toolUseID, { resolve });
                  send('permission_request', { toolUseID, toolName, description, input });
                  send('session_status', { status: 'awaiting_permission' });
                });
              },
            });

            for await (const event of stream) {
              switch (event.type) {
                case 'dm_partial':
                  send('dm_partial', { text: event.text });
                  break;
                case 'dm_response':
                  messageHistory.push({ type: 'dm', text: event.text });
                  send('dm_response', { text: event.text });
                  break;
                case 'dm_complete':
                  send('dm_complete', { sessionId: event.sessionId });
                  break;
                case 'session_id':
                  send('session_id', { sessionId: event.sessionId });
                  break;
                case 'error':
                  send('error', { error: event.error });
                  break;
              }
            }
          } catch (err) {
            console.error('[WS] Engine error:', err);
            send('error', { error: err.message || 'DM engine error' });
          } finally {
            processing = false;
            send('session_status', { status: 'idle' });
          }
          break;
        }

        case 'permission_response': {
          const pending = pendingPermissions.get(msg.toolUseID);
          if (pending) {
            pendingPermissions.delete(msg.toolUseID);
            pending.resolve(msg.allowed === true);
            send('session_status', { status: 'thinking' });
          }
          break;
        }

        default:
          send('error', { error: `Unknown message type: ${msg.type}` });
      }
    });

    ws.on('close', () => {
      console.log('[WS] Client disconnected');
      leaveCurrentChatRoom();
      engine.abort();
      // Reject any pending permissions
      for (const [, pending] of pendingPermissions) {
        pending.resolve(false);
      }
      pendingPermissions.clear();
    });

    ws.on('error', (err) => {
      console.error('[WS] Error:', err.message);
    });
  });

  console.log('[WS] WebSocket server attached at /ws');
  return wss;
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

module.exports = { attachWebSocket };
