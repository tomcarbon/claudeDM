const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const { DmEngine } = require('./dm-engine');

// Module-level chat rooms: chatKey -> Set<wsEntry>
// Each wsEntry: { ws, playerEmail, playerName, isAdmin }
const chatRooms = new Map();
// Session watch rooms: sessionDbId -> Set<wsEntry>
const sessionRooms = new Map();
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

function getSessionOwnerEmail(session) {
  const ownerPlayer = (session.players || []).find(p => p.role === 'owner') || (session.players || [])[0] || {};
  const value = session.ownerEmail || session.playerEmail || ownerPlayer.email || null;
  return value ? String(value).trim().toLowerCase() : null;
}

function attachWebSocket(server, dataDir, { appendChatMessage } = {}) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const sessionsDir = path.join(dataDir, 'sessions');

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

  function readSessionByDbId(sessionDbId) {
    if (!sessionDbId) return null;
    const filePath = path.join(sessionsDir, `${sessionDbId}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return null;
    }
  }

  function broadcastSessionMessage(sessionDbId, type, payload = {}, excludedEntry = null) {
    if (!sessionDbId || !sessionRooms.has(sessionDbId)) return;
    for (const entry of sessionRooms.get(sessionDbId)) {
      if (entry === excludedEntry) continue;
      if (entry.ws.readyState === entry.ws.OPEN) {
        entry.ws.send(JSON.stringify({ type, sessionDbId, ...payload }));
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
    let currentSessionDbId = null;
    let currentSessionCanWrite = false;

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
        if (room.size === 0) {
          chatRooms.delete(currentChatKey);
        } else {
          broadcastChatParticipants(currentChatKey);
        }
      }
      currentChatKey = null;
    }

    function leaveCurrentSessionRoom() {
      if (currentSessionDbId && sessionRooms.has(currentSessionDbId)) {
        const room = sessionRooms.get(currentSessionDbId);
        room.delete(wsEntry);
        if (room.size === 0) {
          sessionRooms.delete(currentSessionDbId);
        }
      }
      currentSessionDbId = null;
      currentSessionCanWrite = false;
    }

    function joinSessionRoom(sessionDbId, canWrite) {
      leaveCurrentSessionRoom();
      currentSessionDbId = sessionDbId;
      currentSessionCanWrite = !!canWrite;
      if (!sessionRooms.has(sessionDbId)) sessionRooms.set(sessionDbId, new Set());
      sessionRooms.get(sessionDbId).add(wsEntry);
    }

    function broadcastToSessionWatchers(type, payload = {}) {
      if (!currentSessionDbId) return;
      broadcastSessionMessage(currentSessionDbId, type, payload, wsEntry);
    }

    function joinChatRoom(chatKey, playerEmail, playerName, isAdmin) {
      leaveCurrentChatRoom();
      currentChatKey = chatKey;
      wsEntry.playerEmail = playerEmail;
      wsEntry.playerName = playerName;
      wsEntry.isAdmin = !!isAdmin;
      if (!chatRooms.has(chatKey)) chatRooms.set(chatKey, new Set());
      chatRooms.get(chatKey).add(wsEntry);
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
          leaveCurrentSessionRoom();
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

        case 'session_watch': {
          const requestedSessionId = String(msg.sessionDbId || '').trim();
          if (!requestedSessionId) {
            leaveCurrentSessionRoom();
            send('session_access', { sessionDbId: null, canWrite: false, readOnly: true });
            break;
          }

          const session = readSessionByDbId(requestedSessionId);
          if (!session) {
            send('error', { error: 'Session not found for live watch.' });
            break;
          }

          const msgEmail = String(msg.playerEmail || '').trim().toLowerCase();
          if (msgEmail) {
            wsEntry.playerEmail = msgEmail;
            if (!wsEntry.playerName && msg.playerName) {
              wsEntry.playerName = msg.playerName;
            }
          }

          const ownerEmail = getSessionOwnerEmail(session);
          const requesterEmail = String(wsEntry.playerEmail || '').trim().toLowerCase();
          const canWrite = !!ownerEmail && !!requesterEmail && ownerEmail === requesterEmail;

          joinSessionRoom(requestedSessionId, canWrite);
          send('session_access', {
            sessionDbId: requestedSessionId,
            ownerEmail,
            canWrite,
            readOnly: !canWrite,
          });
          break;
        }

        case 'session_unwatch': {
          leaveCurrentSessionRoom();
          send('session_access', { sessionDbId: null, canWrite: false, readOnly: true });
          break;
        }

        case 'user_message': {
          if (currentSessionDbId && !currentSessionCanWrite) {
            send('error', { error: 'This session is read-only. Only the creator can send messages.' });
            return;
          }
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
          broadcastToSessionWatchers('session_status', { status: 'thinking' });

          try {
            const playerText = msg.text.trim();
            messageHistory.push({ type: 'player', text: playerText });
            broadcastToSessionWatchers('session_player_message', {
              text: playerText,
              timestamp: new Date().toISOString(),
            });
            const stream = engine.run(msg.text.trim(), {
              characterId,
              scenarioId,
              messageHistory,
              playerEmail: wsEntry.playerEmail,
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
                  broadcastToSessionWatchers('dm_partial', { text: event.text });
                  break;
                case 'dm_response':
                  messageHistory.push({ type: 'dm', text: event.text });
                  send('dm_response', { text: event.text });
                  broadcastToSessionWatchers('dm_response', { text: event.text });
                  break;
                case 'dm_complete':
                  send('dm_complete', { sessionId: event.sessionId });
                  broadcastToSessionWatchers('dm_complete', { sessionId: event.sessionId });
                  break;
                case 'session_id':
                  send('session_id', { sessionId: event.sessionId });
                  broadcastToSessionWatchers('session_id', { sessionId: event.sessionId });
                  break;
                case 'error':
                  send('error', { error: event.error });
                  broadcastToSessionWatchers('error', { error: event.error });
                  break;
              }
            }
          } catch (err) {
            console.error('[WS] Engine error:', err);
            send('error', { error: err.message || 'DM engine error' });
            broadcastToSessionWatchers('error', { error: err.message || 'DM engine error' });
          } finally {
            processing = false;
            send('session_status', { status: 'idle' });
            broadcastToSessionWatchers('session_status', { status: 'idle' });
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
      leaveCurrentSessionRoom();
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
