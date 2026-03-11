const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const { DmEngine } = require('./dm-engine');
const { emailToSlug, getPlayerCharactersDir } = require('./player-data');

// Module-level chat rooms: chatKey -> Set<wsEntry>
// Each wsEntry: { ws, playerEmail, playerName, isAdmin }
const chatRooms = new Map();
// Session watch rooms: sessionDbId -> Set<wsEntry>
const sessionRooms = new Map();
// Pending companion turns: sessionDbId -> Map<playerEmail, { playerEmail, playerName, npcId, text }>
const sessionTurns = new Map();
// Track which companion characters have had their sheet sent to the DM: sessionDbId -> Set<characterId>
const companionSheetsSent = new Map();
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
  _wss = wss;
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
      // Called by companion handlers to force fresh DM context on next turn
      invalidateSession(contextMessage) {
        engine.sessionId = null;
        if (contextMessage) messageHistory.push({ type: 'player', text: contextMessage });
      },
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
          sessionTurns.delete(currentSessionDbId);
          companionSheetsSent.delete(currentSessionDbId);
          hostTurns.delete(currentSessionDbId);
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
          characterName: e.characterName || null,
          companionNpcId: e.companionNpcId || null,
          companionCharacterName: e.companionCharacterName || null,
          companionCharacterId: e.companionCharacterId || null,
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
      broadcastReadyGolfStatus(sessionDbId);
      // Auto-fire only when BOTH host and ALL companions have submitted
      if (!hostTurns.has(sessionDbId)) return;
      if (!sessionRooms.has(sessionDbId)) return;
      const companions = Array.from(sessionRooms.get(sessionDbId))
        .filter(e => e.companionNpcId && e.ws.readyState === e.ws.OPEN);
      if (companions.length === 0) return; // no companions connected — don't auto-fire
      const companionEmails = companions.map(c => c.playerEmail);
      const submittedEmails = sessionTurns.has(sessionDbId)
        ? Array.from(sessionTurns.get(sessionDbId).keys())
        : [];
      const allReady = companionEmails.every(email => submittedEmails.includes(email));
      if (!allReady) return;

      // Everyone is ready — fire
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
          // Reset engine and history for a clean slate
          engine.sessionId = null;
          messageHistory = [];
          characterId = msg.characterId || null;
          scenarioId = msg.scenarioId || null;
          campaignId = msg.campaignId || null;
          wsEntry.playerEmail = msg.playerEmail;
          wsEntry.campaignId = campaignId;
          wsEntry.characterId = characterId;
          // Look up character name for participants broadcast
          wsEntry.characterName = null;
          if (characterId && msg.playerEmail) {
            try {
              const charDir = getPlayerCharactersDir(dataDir, msg.playerEmail, campaignId || 'demo');
              for (const f of fs.readdirSync(charDir).filter(f => f.endsWith('.json'))) {
                const d = JSON.parse(fs.readFileSync(path.join(charDir, f), 'utf-8'));
                if (d.id === characterId) { wsEntry.characterName = d.name; break; }
              }
            } catch { /* ignore */ }
          }
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
          wsEntry.campaignId = campaignId;
          wsEntry.characterId = characterId;
          wsEntry.characterName = null;
          if (characterId && msg.playerEmail) {
            try {
              const charDir = getPlayerCharactersDir(dataDir, msg.playerEmail, campaignId || 'demo');
              for (const f of fs.readdirSync(charDir).filter(f => f.endsWith('.json'))) {
                const d = JSON.parse(fs.readFileSync(path.join(charDir, f), 'utf-8'));
                if (d.id === characterId) { wsEntry.characterName = d.name; break; }
              }
            } catch { /* ignore */ }
          }
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

          // Set companionNpcId BEFORE joining room so participants broadcast includes it
          if (companionNpcId) {
            wsEntry.companionNpcId = companionNpcId;
          }
          joinSessionRoom(requestedSessionId, canWrite);
          const accessPayload = {
            sessionDbId: requestedSessionId,
            ownerEmail,
            canWrite,
            readOnly: !canWrite,
          };
          if (companionNpcId) {
            accessPayload.companionNpcId = companionNpcId;
          }
          send('session_access', accessPayload);
          // Always send current pending turns (empty array clears stale client state)
          const watchTurns = sessionTurns.has(requestedSessionId)
            ? Array.from(sessionTurns.get(requestedSessionId).values())
            : [];
          send('companion_turns_update', { sessionDbId: requestedSessionId, turns: watchTurns });
          break;
        }

        case 'session_unwatch': {
          leaveCurrentSessionRoom();
          send('session_access', { sessionDbId: null, canWrite: false, readOnly: true });
          send('companion_turns_update', { sessionDbId: null, turns: [] });
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
                const companionActions = turns.map(t => {
                  const charLabel = t.characterName || t.npcName || t.npcId;
                  const swapNote = t.characterName && t.npcName
                    ? ` (playing their own character ${t.characterName}, who has replaced ${t.npcName} in the party)`
                    : '';
                  let line = `[Companion player ${t.playerName} as ${charLabel}${swapNote}]: ${t.text}`;
                  // Include character sheet only on first turn with this character
                  const sheetKey = t.characterId || t.characterName;
                  if (!companionSheetsSent.has(currentSessionDbId)) companionSheetsSent.set(currentSessionDbId, new Set());
                  const sentSheets = companionSheetsSent.get(currentSessionDbId);
                  if (t.characterData && t.characterName && sheetKey && !sentSheets.has(sheetKey)) {
                    sentSheets.add(sheetKey);
                    try {
                      const cd = t.characterData;
                      const fmtArr = (val) => Array.isArray(val) ? val.map(v => typeof v === 'string' ? v : v.name || JSON.stringify(v)).join(', ') : '';
                      const abilities = cd.abilities ? Object.entries(cd.abilities).map(([k,v]) => `${k.toUpperCase()}:${v.score}(${v.modifier >= 0 ? '+' : ''}${v.modifier})`).join(' ') : '';
                      const hp = cd.hitPoints ? `HP:${cd.hitPoints.current}/${cd.hitPoints.max}` : '';
                      const spellsL1 = cd.spells?.level1 ? (Array.isArray(cd.spells.level1) ? cd.spells.level1 : cd.spells.level1.known || []) : [];
                      const sheet = [
                        `${cd.name} — Level ${cd.level} ${cd.subrace || ''} ${cd.race} ${cd.class}`,
                        `${hp} AC:${cd.armorClass || '?'} Speed:${cd.speed || '?'} Prof:+${cd.proficiencyBonus || 2}`,
                        abilities,
                        cd.equipment ? `Equipment: ${fmtArr(cd.equipment)}` : '',
                        cd.weapons ? `Weapons: ${fmtArr(cd.weapons)}` : '',
                        cd.spells?.cantrips ? `Cantrips: ${fmtArr(cd.spells.cantrips)}` : '',
                        spellsL1.length > 0 ? `Level 1 spells (${cd.spells.level1.slots || '?'} slots): ${fmtArr(spellsL1)}` : '',
                        cd.features ? `Features: ${fmtArr(cd.features)}` : '',
                      ].filter(Boolean).join('\n  ');
                      line += `\n  [Character Sheet: ${sheet}]`;
                    } catch (sheetErr) {
                      console.error('[WS] Error formatting companion character sheet:', sheetErr);
                      line += `\n  [Character Sheet: ${t.characterName} — see character file for details]`;
                    }
                  }
                  return line;
                }).join('\n');
                const modeNote = turnMode === 'initiative'
                  ? '\n(Initiative mode: resolve these actions in initiative order, rolling initiative if not yet established.)'
                  : '';
                playerText += `\n\n--- Companion Actions ---\n${companionActions}${modeNote}`;
                // Broadcast each companion action as a persistent message for all players (including host)
                for (const t of turns) {
                  const charLabel = t.characterName || t.npcName || t.npcId;
                  const actionPayload = {
                    characterName: charLabel,
                    playerName: t.playerName,
                    playerEmail: t.playerEmail,
                    text: t.text,
                    timestamp: new Date().toISOString(),
                  };
                  // broadcastSessionMessage sends to all room members including host
                  broadcastSessionMessage(currentSessionDbId, 'companion_action', actionPayload);
                }
                // Clear pending turns
                sessionTurns.delete(currentSessionDbId);
                broadcastSessionTurns(currentSessionDbId);
              }
            }

            // Clear host turn if ready-golf
            if (currentSessionDbId) hostTurns.delete(currentSessionDbId);

            // Send host's player message back to them (after companion actions for correct ordering)
            send('session_player_message', { text: msg.text.trim() });

            messageHistory.push({ type: 'player', text: playerText });
            broadcastToSessionWatchers('session_player_message', {
              text: playerText,
              timestamp: new Date().toISOString(),
            });
            // Gather active companion players for system prompt
            const activeCompanions = currentSessionDbId && sessionRooms.has(currentSessionDbId)
              ? Array.from(sessionRooms.get(currentSessionDbId))
                  .filter(e => e.companionNpcId && e.ws.readyState === e.ws.OPEN)
                  .map(e => ({
                    playerEmail: e.playerEmail,
                    playerName: e.playerName,
                    companionNpcId: e.companionNpcId,
                    companionCharacterName: e.companionCharacterName || null,
                    companionCharacterId: e.companionCharacterId || null,
                  }))
              : [];

            const stream = engine.run(playerText, {
              characterId,
              scenarioId,
              campaignId,
              messageHistory,
              playerEmail: wsEntry.playerEmail,
              companionPlayers: activeCompanions.length > 0 ? activeCompanions : undefined,
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

        case 'companion_set_character': {
          if (!currentSessionDbId || !wsEntry.companionNpcId) break;
          const prevCharName = wsEntry.companionCharacterName;
          wsEntry.companionCharacterName = msg.characterName || null;
          wsEntry.companionCharacterId = msg.characterId || null;
          wsEntry.companionCharacterData = msg.characterData || null;
          // Reset sheet-sent tracking if character changed so sheet is sent on next turn
          if (msg.characterName !== prevCharName && companionSheetsSent.has(currentSessionDbId)) {
            companionSheetsSent.get(currentSessionDbId).delete(msg.characterId || msg.characterName);
          }
          broadcastSessionParticipants(currentSessionDbId);

          // Copy companion's character file to host's characters directory
          if (msg.characterData && msg.characterId) {
            try {
              // Find the host entry to get their email and campaignId
              const hostEntry = sessionRooms.has(currentSessionDbId)
                ? Array.from(sessionRooms.get(currentSessionDbId)).find(e => e.isHost)
                : null;
              if (hostEntry && hostEntry.playerEmail) {
                const hostCampaignId = hostEntry.campaignId || 'demo';
                const hostCharDir = getPlayerCharactersDir(dataDir, hostEntry.playerEmail, hostCampaignId);
                // Check character count limit (50)
                let charCount = 0;
                try { charCount = fs.readdirSync(hostCharDir).filter(f => f.endsWith('.json')).length; } catch { /* dir may not exist */ }
                if (charCount < 50) {
                  // Generate filename from character name
                  const charSlug = String(msg.characterData.name || msg.characterId)
                    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
                  const destPath = path.join(hostCharDir, `${charSlug}.json`);
                  // Only copy if file doesn't already exist (avoid overwriting host's own characters)
                  if (!fs.existsSync(destPath)) {
                    fs.mkdirSync(hostCharDir, { recursive: true });
                    // Mark as companion-owned so cleanup is possible later
                    const charDataToWrite = { ...msg.characterData, _companionOwner: wsEntry.playerEmail, _filename: `${charSlug}.json` };
                    fs.writeFileSync(destPath, JSON.stringify(charDataToWrite, null, 2));
                    console.log(`[WS] Copied companion character "${msg.characterData.name}" to host's roster: ${destPath}`);
                  } else {
                    // File exists — update it with latest companion character data
                    const charDataToWrite = { ...msg.characterData, _companionOwner: wsEntry.playerEmail, _filename: `${charSlug}.json` };
                    fs.writeFileSync(destPath, JSON.stringify(charDataToWrite, null, 2));
                    console.log(`[WS] Updated companion character "${msg.characterData.name}" in host's roster: ${destPath}`);
                  }
                } else {
                  console.warn(`[WS] Host has ${charCount} characters, skipping companion character copy (limit: 50)`);
                }
              }
            } catch (err) {
              console.error(`[WS] Failed to copy companion character to host's roster:`, err);
            }
          }

          // Notify the session about the character swap
          if (msg.characterName && msg.characterName !== prevCharName) {
            const npcLabel = msg.npcName || wsEntry.companionNpcId;
            broadcastSessionMessage(currentSessionDbId, 'session_player_message', {
              text: `[System: Companion player ${wsEntry.playerName} is playing as ${msg.characterName}, replacing ${npcLabel} in the party.]`,
              timestamp: new Date().toISOString(),
            });
            // Invalidate the host's Claude session so the next turn starts fresh
            // with the updated system prompt (new party composition)
            const hostEntry = sessionRooms.has(currentSessionDbId)
              ? Array.from(sessionRooms.get(currentSessionDbId)).find(e => e.isHost)
              : null;
            if (hostEntry && hostEntry.invalidateSession) {
              const swapMsg = `[System: Companion player ${wsEntry.playerName} is playing as ${msg.characterName}, replacing ${npcLabel} in the party. The companion's character file has been copied to the host's characters directory. Treat ${msg.characterName} as a full party member — read their character file for stats, track HP, award XP, and manage inventory just like any other character.]`;
              hostEntry.invalidateSession(swapMsg);
              console.log(`[WS] Invalidated host's Claude session for party composition change`);
            }
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
            characterName: msg.characterName || wsEntry.companionCharacterName || null,
            characterId: msg.characterId || wsEntry.companionCharacterId || null,
            characterData: wsEntry.companionCharacterData || null,
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

        case 'host_turn_force': {
          // Force-fire the host's queued turn without waiting for all companions
          if (!currentSessionDbId || !currentSessionCanWrite) break;
          if (!hostTurns.has(currentSessionDbId)) break;
          const hostTurn = hostTurns.get(currentSessionDbId);
          hostTurns.delete(currentSessionDbId);
          broadcastReadyGolfStatus(currentSessionDbId);
          // Fire via the same path as auto-fire
          send('ready_golf_fire', { text: hostTurn.text });
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

// Broadcast a message to ALL connected WebSocket clients
let _wss = null;
function broadcastToAll(type, payload = {}) {
  if (!_wss) return;
  const msg = JSON.stringify({ type, ...payload });
  for (const client of _wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(msg);
    }
  }
}

module.exports = { attachWebSocket, broadcastToAll };
