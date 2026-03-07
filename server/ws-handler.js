const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const { DmEngine } = require('./dm-engine');

// Module-level chat rooms: chatKey -> Set<wsEntry>
// Each wsEntry: { ws, playerEmail, playerName, isAdmin }
const chatRooms = new Map();
// Session watch rooms: sessionDbId -> Set<wsEntry>
const sessionRooms = new Map();
// Pending companion turns: sessionDbId -> Map<playerEmail, { playerEmail, playerName, npcId, text }>
const sessionTurns = new Map();
// Pending host turns for ready-golf: sessionDbId -> { text, wsEntry }
const hostTurns = new Map();
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

function getCompanionNpcId(session, email) {
  if (!email) return null;
  // companionPlayers is a top-level field on the session (set by POST /:id/join)
  const players = session.companionPlayers;
  if (!players) return null;
  for (const [npcId, info] of Object.entries(players)) {
    if (info?.email?.toLowerCase() === email.toLowerCase()) return npcId;
  }
  return null;
}

function broadcastSessionTurns(sessionDbId) {
  if (!sessionRooms.has(sessionDbId)) return;
  const turns = sessionTurns.has(sessionDbId)
    ? Array.from(sessionTurns.get(sessionDbId).values())
    : [];
  for (const entry of sessionRooms.get(sessionDbId)) {
    if (entry.ws.readyState === entry.ws.OPEN) {
      entry.ws.send(JSON.stringify({ type: 'companion_turns_update', sessionDbId, turns }));
    }
  }
}

function getSessionTurnMode(sessionDbId) {
  // Check if any entry in the session room has a cached turnMode
  if (!sessionRooms.has(sessionDbId)) return 'host-decides';
  for (const entry of sessionRooms.get(sessionDbId)) {
    if (entry.sessionTurnMode) return entry.sessionTurnMode;
  }
  return 'host-decides';
}

function attachWebSocket(server, dataDir, { appendChatMessage } = {}) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const playersDir = path.join(dataDir, 'players');

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
    const filename = `${sessionDbId}.json`;
    // Search across all player/campaign session dirs
    try {
      const playerSlugs = fs.existsSync(playersDir) ? fs.readdirSync(playersDir) : [];
      for (const slug of playerSlugs) {
        const playerDir = path.join(playersDir, slug);
        let campaigns;
        try { campaigns = fs.readdirSync(playerDir).filter(d => fs.statSync(path.join(playerDir, d)).isDirectory()); } catch { continue; }
        for (const cid of campaigns) {
          const sessPath = path.join(playerDir, cid, 'sessions', filename);
          if (fs.existsSync(sessPath)) {
            return JSON.parse(fs.readFileSync(sessPath, 'utf-8'));
          }
        }
      }
    } catch { /* ignore */ }
    // Fallback: check legacy global sessions dir
    const legacyPath = path.join(dataDir, 'sessions', filename);
    if (fs.existsSync(legacyPath)) {
      try { return JSON.parse(fs.readFileSync(legacyPath, 'utf-8')); } catch { /* ignore */ }
    }
    return null;
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
    let campaignId = null;
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
        const prevSessionId = currentSessionDbId;
        const leaveName = wsEntry.playerName || wsEntry.playerEmail || 'Someone';
        const leaveNpcId = wsEntry.companionNpcId || null;
        const wasHost = wsEntry.isHost;
        const room = sessionRooms.get(currentSessionDbId);
        room.delete(wsEntry);
        if (room.size === 0) {
          sessionRooms.delete(currentSessionDbId);
        } else {
          // Only broadcast leave for non-host players
          if (!wasHost) {
            broadcastSessionMessage(prevSessionId, 'session_player_left', {
              playerEmail: wsEntry.playerEmail,
              playerName: leaveName,
              companionNpcId: leaveNpcId,
            });
          }
          broadcastSessionParticipants(prevSessionId);
        }
      }
      currentSessionDbId = null;
      currentSessionCanWrite = false;
    }

    function getSessionParticipants(sessionDbId) {
      if (!sessionRooms.has(sessionDbId)) return [];
      return Array.from(sessionRooms.get(sessionDbId))
        .filter(e => e.ws.readyState === e.ws.OPEN)
        .map(e => ({
          playerEmail: e.playerEmail || 'guest',
          playerName: e.playerName || 'Guest',
          isHost: !!e.isHost,
          companionNpcId: e.companionNpcId || null,
        }));
    }

    function broadcastSessionParticipants(sessionDbId) {
      if (!sessionRooms.has(sessionDbId)) return;
      const participants = getSessionParticipants(sessionDbId);
      for (const entry of sessionRooms.get(sessionDbId)) {
        if (entry.ws.readyState === entry.ws.OPEN) {
          entry.ws.send(JSON.stringify({
            type: 'session_participants',
            sessionDbId,
            participants,
          }));
        }
      }
    }

    function broadcastReadyGolfStatus(sessionDbId) {
      if (!sessionRooms.has(sessionDbId)) return;
      const companions = Array.from(sessionRooms.get(sessionDbId))
        .filter(e => e.companionNpcId && e.ws.readyState === e.ws.OPEN);
      const companionCount = companions.length;
      const submittedCount = sessionTurns.has(sessionDbId)
        ? Array.from(sessionTurns.get(sessionDbId).keys())
            .filter(email => companions.some(c => c.playerEmail === email)).length
        : 0;
      const hostReady = hostTurns.has(sessionDbId);
      for (const entry of sessionRooms.get(sessionDbId)) {
        if (entry.ws.readyState === entry.ws.OPEN) {
          entry.ws.send(JSON.stringify({
            type: 'ready_golf_status',
            sessionDbId,
            hostReady,
            companionsReady: submittedCount,
            companionsTotal: companionCount,
            allReady: hostReady && submittedCount >= companionCount,
          }));
        }
      }
    }

    function checkReadyGolfAutoFire(sessionDbId) {
      if (!hostTurns.has(sessionDbId)) return; // host hasn't submitted yet
      if (!sessionRooms.has(sessionDbId)) return;
      const companions = Array.from(sessionRooms.get(sessionDbId))
        .filter(e => e.companionNpcId && e.ws.readyState === e.ws.OPEN);
      const companionEmails = companions.map(c => c.playerEmail);
      const submittedEmails = sessionTurns.has(sessionDbId)
        ? Array.from(sessionTurns.get(sessionDbId).keys())
        : [];
      const allReady = companionEmails.every(email => submittedEmails.includes(email));
      if (!allReady) return;

      // Everyone is ready — tell the host to fire
      const hostEntry = Array.from(sessionRooms.get(sessionDbId)).find(e => e.isHost);
      if (hostEntry && hostEntry.ws.readyState === hostEntry.ws.OPEN) {
        const hostTurn = hostTurns.get(sessionDbId);
        hostEntry.ws.send(JSON.stringify({
          type: 'ready_golf_fire',
          text: hostTurn.text,
        }));
        hostTurns.delete(sessionDbId);
      }
    }

    function joinSessionRoom(sessionDbId, canWrite) {
      // Skip re-join if already in this room (e.g. host re-watches on save)
      if (currentSessionDbId === sessionDbId) {
        currentSessionCanWrite = !!canWrite;
        wsEntry.isHost = !!canWrite;
        return;
      }
      leaveCurrentSessionRoom();
      currentSessionDbId = sessionDbId;
      currentSessionCanWrite = !!canWrite;
      wsEntry.isHost = !!canWrite;
      if (!sessionRooms.has(sessionDbId)) sessionRooms.set(sessionDbId, new Set());
      sessionRooms.get(sessionDbId).add(wsEntry);
      // Only broadcast join for non-host players (host joining is implicit)
      if (!canWrite) {
        const joinName = wsEntry.playerName || wsEntry.playerEmail || 'Someone';
        broadcastSessionMessage(sessionDbId, 'session_player_joined', {
          playerEmail: wsEntry.playerEmail,
          playerName: joinName,
          isHost: false,
          companionNpcId: wsEntry.companionNpcId || null,
        }, wsEntry);
      }
      broadcastSessionParticipants(sessionDbId);
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
          if (!msg.playerEmail) {
            send('error', { error: 'playerEmail is required to start a session.' });
            break;
          }
          leaveCurrentSessionRoom();
          characterId = msg.characterId || null;
          scenarioId = msg.scenarioId || null;
          campaignId = msg.campaignId || null;
          wsEntry.playerEmail = msg.playerEmail;
          if (msg.playerName) wsEntry.playerName = msg.playerName;
          send('session_status', { status: 'idle' });
          console.log(`[WS] Session started — character: ${characterId}, scenario: ${scenarioId}, campaign: ${campaignId}, player: ${wsEntry.playerEmail}`);
          break;
        }

        case 'session_resume': {
          if (!msg.playerEmail) {
            send('error', { error: 'playerEmail is required to resume a session.' });
            break;
          }
          characterId = msg.characterId || null;
          scenarioId = msg.scenarioId || null;
          campaignId = msg.campaignId || null;
          engine.sessionId = msg.claudeSessionId || null;
          wsEntry.playerEmail = msg.playerEmail;
          if (msg.playerName) wsEntry.playerName = msg.playerName;
          // Store message history for resume fallback
          if (msg.messages && Array.isArray(msg.messages)) {
            messageHistory = msg.messages;
          }
          send('session_status', { status: 'idle' });
          console.log(`[WS] Session resumed — claude: ${engine.sessionId}, character: ${characterId}, scenario: ${scenarioId}, campaign: ${campaignId}, player: ${wsEntry.playerEmail}, history: ${messageHistory.length} messages`);
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
          const companionNpcId = !canWrite ? getCompanionNpcId(session, requesterEmail) : null;

          joinSessionRoom(requestedSessionId, canWrite);
          const accessPayload = {
            sessionDbId: requestedSessionId,
            ownerEmail,
            canWrite,
            readOnly: !canWrite,
          };
          if (companionNpcId) {
            accessPayload.companionNpcId = companionNpcId;
            wsEntry.companionNpcId = companionNpcId;
          }
          send('session_access', accessPayload);
          // Send current pending turns to the newly joined watcher
          if (sessionTurns.has(requestedSessionId)) {
            const turns = Array.from(sessionTurns.get(requestedSessionId).values());
            send('companion_turns_update', { sessionDbId: requestedSessionId, turns });
          }
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

          const turnMode = msg.turnMode || 'host-decides';

          processing = true;
          send('session_status', { status: 'thinking' });
          broadcastToSessionWatchers('session_status', { status: 'thinking' });

          try {
            let playerText = msg.text.trim();

            // Bundle pending companion turns into the host's message
            if (currentSessionDbId && sessionTurns.has(currentSessionDbId)) {
              const turns = Array.from(sessionTurns.get(currentSessionDbId).values());
              if (turns.length > 0) {
                const companionActions = turns.map(t =>
                  `[Companion player ${t.playerName} controlling ${t.npcName || t.npcId}]: ${t.text}`
                ).join('\n');
                const modeNote = turnMode === 'initiative'
                  ? '\n(Initiative mode: resolve these actions in initiative order, rolling initiative if not yet established.)'
                  : '';
                playerText += `\n\n--- Companion Actions ---\n${companionActions}${modeNote}`;
                // Clear pending turns
                sessionTurns.delete(currentSessionDbId);
                broadcastSessionTurns(currentSessionDbId);
              }
            }

            // If companion actions were bundled, update the host's message
            if (playerText !== msg.text.trim()) {
              send('player_message_updated', { text: playerText });
            }

            // Clear host turn if ready-golf
            if (currentSessionDbId) hostTurns.delete(currentSessionDbId);

            messageHistory.push({ type: 'player', text: playerText });
            broadcastToSessionWatchers('session_player_message', {
              text: playerText,
              timestamp: new Date().toISOString(),
            });
            const stream = engine.run(playerText, {
              characterId,
              scenarioId,
              campaignId,
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
                case 'dice_roll':
                  send('dice_roll', {
                    notation: event.notation,
                    rolls: event.rolls,
                    modifier: event.modifier,
                    total: event.total,
                    label: event.label,
                  });
                  broadcastToSessionWatchers('dice_roll', {
                    notation: event.notation,
                    rolls: event.rolls,
                    modifier: event.modifier,
                    total: event.total,
                    label: event.label,
                  });
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

        case 'companion_turn_submit': {
          if (!currentSessionDbId) {
            send('error', { error: 'Not in a session.' });
            break;
          }
          if (!wsEntry.companionNpcId) {
            send('error', { error: 'You are not a companion player in this session.' });
            break;
          }
          const turnText = String(msg.text || '').trim();
          if (!turnText) {
            send('error', { error: 'Empty turn.' });
            break;
          }
          if (!sessionTurns.has(currentSessionDbId)) sessionTurns.set(currentSessionDbId, new Map());
          const npcName = msg.npcName || wsEntry.companionNpcId;
          sessionTurns.get(currentSessionDbId).set(wsEntry.playerEmail, {
            playerEmail: wsEntry.playerEmail,
            playerName: wsEntry.playerName || wsEntry.playerEmail,
            npcId: wsEntry.companionNpcId,
            npcName,
            text: turnText,
          });
          console.log(`[WS] Companion turn submitted — session: ${currentSessionDbId}, player: ${wsEntry.playerEmail}, npc: ${wsEntry.companionNpcId}`);
          broadcastSessionTurns(currentSessionDbId);
          // Check if ready-golf auto-fire should trigger
          checkReadyGolfAutoFire(currentSessionDbId);
          break;
        }

        case 'companion_turn_retract': {
          if (!currentSessionDbId) break;
          if (sessionTurns.has(currentSessionDbId)) {
            sessionTurns.get(currentSessionDbId).delete(wsEntry.playerEmail);
            broadcastSessionTurns(currentSessionDbId);
          }
          // Broadcast updated ready-golf status
          broadcastReadyGolfStatus(currentSessionDbId);
          break;
        }

        case 'host_skip_companion': {
          if (!currentSessionDbId || !currentSessionCanWrite) {
            send('error', { error: 'Only the host can skip companions.' });
            break;
          }
          const skipEmail = String(msg.playerEmail || '').trim().toLowerCase();
          if (skipEmail && sessionTurns.has(currentSessionDbId)) {
            sessionTurns.get(currentSessionDbId).delete(skipEmail);
            broadcastSessionTurns(currentSessionDbId);
          }
          // Re-check auto-fire after skipping
          checkReadyGolfAutoFire(currentSessionDbId);
          break;
        }

        case 'host_turn_ready': {
          // Ready Golf: host queues their turn text, waits for all companions
          if (!currentSessionDbId || !currentSessionCanWrite) {
            send('error', { error: 'Only the host can submit a turn.' });
            break;
          }
          const hostText = String(msg.text || '').trim();
          if (!hostText) {
            send('error', { error: 'Empty turn.' });
            break;
          }
          hostTurns.set(currentSessionDbId, { text: hostText, wsEntry });
          console.log(`[WS] Host turn queued (ready-golf) — session: ${currentSessionDbId}`);
          broadcastReadyGolfStatus(currentSessionDbId);
          checkReadyGolfAutoFire(currentSessionDbId);
          break;
        }

        case 'host_turn_retract': {
          if (!currentSessionDbId) break;
          hostTurns.delete(currentSessionDbId);
          broadcastReadyGolfStatus(currentSessionDbId);
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
