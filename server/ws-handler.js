const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const { DmEngine } = require('./dm-engine');
const { emailToSlug, getPlayerCharactersDir, snapshotToSession } = require('./player-data');

// Module-level chat rooms: chatKey -> Set<wsEntry>
// Each wsEntry: { ws, playerEmail, playerName, isAdmin }
const chatRooms = new Map();
// Session watch rooms: sessionDbId -> Set<wsEntry>
const sessionRooms = new Map();
// Pending companion turns: sessionDbId -> Map<playerEmail, { playerEmail, playerName, npcId, text }>
const sessionTurns = new Map();
// Track which companion characters have had their sheet sent to the DM: sessionDbId -> Set<characterId>
const companionSheetsSent = new Map();
// Session-level DM engines: sessionDbId -> { engine, characterId, scenarioId, campaignId, ownerEmail, messageHistory }
const sessionEngines = new Map();
// Grace period timers for engine cleanup: sessionDbId -> timeout
const engineCleanupTimers = new Map();
const sessionFirstFireTimers = new Map(); // sessionDbId -> setTimeout handle for first-turn grace period
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

function getSessionOwnerName(session) {
  const ownerPlayer = (session.players || []).find(p => p.role === 'owner') || (session.players || [])[0] || {};
  return session.ownerName || session.playerName || ownerPlayer.name || null;
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

function getOrCreateSessionEngine(sessionDbId, dataDir, opts) {
  // Cancel any pending cleanup timer
  if (engineCleanupTimers.has(sessionDbId)) {
    clearTimeout(engineCleanupTimers.get(sessionDbId));
    engineCleanupTimers.delete(sessionDbId);
  }
  if (sessionEngines.has(sessionDbId)) {
    const ctx = sessionEngines.get(sessionDbId);
    // Update mutable fields if provided
    if (opts.characterId) ctx.characterId = opts.characterId;
    if (opts.scenarioId) ctx.scenarioId = opts.scenarioId;
    if (opts.campaignId) ctx.campaignId = opts.campaignId;
    if (opts.dmPersonality) ctx.dmPersonality = opts.dmPersonality;
    if (opts.ownerEmail) ctx.ownerEmail = opts.ownerEmail;
    if (opts.claudeSessionId && !ctx.engine.sessionId) ctx.engine.sessionId = opts.claudeSessionId;
    if (opts.messageHistory && opts.messageHistory.length > ctx.messageHistory.length) ctx.messageHistory = opts.messageHistory;
    if (opts.companionConfig) ctx.companionConfig = opts.companionConfig;
    return ctx;
  }
  const engine = new DmEngine(dataDir);
  engine.sessionId = opts.claudeSessionId || null;
  const ctx = {
    engine,
    characterId: opts.characterId || null,
    scenarioId: opts.scenarioId || null,
    campaignId: opts.campaignId || null,
    ownerEmail: opts.ownerEmail || null,
    sessionDbId,
    messageHistory: opts.messageHistory || [],
    companionConfig: opts.companionConfig || null,
    dmPersonality: opts.dmPersonality || null,
  };
  sessionEngines.set(sessionDbId, ctx);
  return ctx;
}

function scheduleEngineCleanup(sessionDbId) {
  // Clean up session engine after 5 minutes of no connections
  if (engineCleanupTimers.has(sessionDbId)) return;
  const timer = setTimeout(() => {
    engineCleanupTimers.delete(sessionDbId);
    // Only clean up if room is still empty
    if (!sessionRooms.has(sessionDbId) || sessionRooms.get(sessionDbId).size === 0) {
      const ctx = sessionEngines.get(sessionDbId);
      if (ctx) {
        ctx.engine.abort();
        sessionEngines.delete(sessionDbId);
        console.log(`[WS] Cleaned up session engine for ${sessionDbId} (5 min grace period expired)`);
      }
    }
  }, 5 * 60 * 1000);
  engineCleanupTimers.set(sessionDbId, timer);
}

function isMultiplayerSession(sessionDbId) {
  const session = _findAndReadSession(sessionDbId);
  if (!session) return false;
  return session.companionPlayers && Object.keys(session.companionPlayers).length > 0;
}

// Module-level session read helper (set inside attachWebSocket)
let _findAndReadSession = () => null;

function persistTurnToSession(sessionDbId, turnData) {
  const session = _findAndReadSession(sessionDbId);
  if (!session) return;
  if (!session.pendingTurns) session.pendingTurns = {};
  session.pendingTurns[turnData.playerEmail] = turnData;
  session.updatedAt = new Date().toISOString();
  const fp = _findSessionFilePath(sessionDbId);
  if (fp) fs.writeFileSync(fp, JSON.stringify(session, null, 2));
}

function removeTurnFromSession(sessionDbId, playerEmail) {
  const session = _findAndReadSession(sessionDbId);
  if (!session || !session.pendingTurns) return null;
  const turn = session.pendingTurns[playerEmail];
  if (!turn) return null;
  delete session.pendingTurns[playerEmail];
  session.updatedAt = new Date().toISOString();
  const fp = _findSessionFilePath(sessionDbId);
  if (fp) fs.writeFileSync(fp, JSON.stringify(session, null, 2));
  return turn.text || null;
}

function clearPendingTurns(sessionDbId) {
  const session = _findAndReadSession(sessionDbId);
  if (!session) return;
  session.pendingTurns = {};
  session.updatedAt = new Date().toISOString();
  const fp = _findSessionFilePath(sessionDbId);
  if (fp) fs.writeFileSync(fp, JSON.stringify(session, null, 2));
}

// Module-level file path helper (set inside attachWebSocket)
let _findSessionFilePath = () => null;

function attachWebSocket(server, dataDir, { appendChatMessage } = {}) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  _wss = wss;
  const playersDir = path.join(dataDir, 'players');

  // Wire module-level helpers to closure functions (defined below)
  _findSessionFilePath = (id) => findSessionFilePath(id);
  _findAndReadSession = (id) => readSessionByDbId(id);

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

  function findSessionFilePath(sessionDbId) {
    if (!sessionDbId) return null;
    const filename = `${sessionDbId}.json`;
    try {
      const playerSlugs = fs.existsSync(playersDir) ? fs.readdirSync(playersDir) : [];
      for (const slug of playerSlugs) {
        const playerDir = path.join(playersDir, slug);
        let campaigns;
        try { campaigns = fs.readdirSync(playerDir).filter(d => fs.statSync(path.join(playerDir, d)).isDirectory()); } catch { continue; }
        for (const cid of campaigns) {
          const sessPath = path.join(playerDir, cid, 'sessions', filename);
          if (fs.existsSync(sessPath)) return sessPath;
        }
      }
    } catch { /* ignore */ }
    const legacyPath = path.join(dataDir, 'sessions', filename);
    if (fs.existsSync(legacyPath)) return legacyPath;
    return null;
  }

  function readSessionByDbId(sessionDbId) {
    const fp = findSessionFilePath(sessionDbId);
    if (!fp) return null;
    try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { return null; }
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
    let companionConfig = null; // Host's NPC slot assignments (removed, open, reserved)
    let dmPersonality = null; // Session-scoped DM personality settings
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
        const leaveCharacterName = wsEntry.companionCharacterName || null;
        const wasHost = wsEntry.isHost;
        const room = sessionRooms.get(currentSessionDbId);
        room.delete(wsEntry);
        if (room.size === 0) {
          sessionRooms.delete(currentSessionDbId);
          sessionTurns.delete(currentSessionDbId);
          companionSheetsSent.delete(currentSessionDbId);
          // Don't clear pendingTurns from session JSON — they persist
          // Schedule engine cleanup after grace period
          scheduleEngineCleanup(currentSessionDbId);
        } else {
          // Only broadcast leave for companion players (not host, not observers)
          if (!wasHost && leaveNpcId) {
            broadcastSessionMessage(prevSessionId, 'session_player_left', {
              playerEmail: wsEntry.playerEmail,
              playerName: leaveName,
              companionNpcId: leaveNpcId,
              companionCharacterName: leaveCharacterName,
            });
          }
          broadcastSessionParticipants(prevSessionId);
        }
      }
      currentSessionDbId = null;
      currentSessionCanWrite = false;
    }

    function getSessionParticipants(sessionDbId) {
      const live = sessionRooms.has(sessionDbId)
        ? Array.from(sessionRooms.get(sessionDbId))
            .filter(e => e.ws.readyState === e.ws.OPEN)
            .map(e => {
              const isObserver = !e.isHost && !e.companionNpcId;
              return {
                playerEmail: e.playerEmail || 'guest',
                playerName: e.playerName || 'Guest',
                isHost: !!e.isHost,
                isObserver,
                isAway: false,
                characterName: e.characterName || null,
                companionNpcId: e.companionNpcId || null,
                companionCharacterName: e.companionCharacterName || null,
                companionCharacterId: e.companionCharacterId || null,
              };
            })
        : [];

      // Include disconnected companion players as "away" from persisted session data
      const session = readSessionByDbId(sessionDbId);
      if (session && session.companionPlayers) {
        const liveNpcIds = new Set(live.filter(p => p.companionNpcId).map(p => p.companionNpcId));
        for (const [npcId, cp] of Object.entries(session.companionPlayers)) {
          if (!liveNpcIds.has(npcId) && cp.email) {
            live.push({
              playerEmail: cp.email,
              playerName: cp.name || cp.email,
              isHost: false,
              isObserver: false,
              isAway: true,
              characterName: null,
              companionNpcId: npcId,
              companionCharacterName: cp.characterName || null,
              companionCharacterId: cp.characterId || null,
            });
          }
        }
      }

      return live;
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

    // Get all joined companion emails from the session file (not just connected ones)
    function getJoinedCompanionEmails(sessionDbId) {
      const session = readSessionByDbId(sessionDbId);
      if (!session || !session.companionPlayers) return [];
      return Object.values(session.companionPlayers)
        .filter(cp => cp && cp.email)
        .map(cp => cp.email);
    }

    function broadcastTurnStatus(sessionDbId) {
      if (!sessionRooms.has(sessionDbId)) return;
      // Count ALL joined companions (from session file), not just connected ones
      const joinedEmails = getJoinedCompanionEmails(sessionDbId);
      const joinedCompanionCount = joinedEmails.length;
      // Check host turn from in-memory sessionTurns (host stores turn with npcId=null)
      const allTurns = sessionTurns.has(sessionDbId)
        ? Array.from(sessionTurns.get(sessionDbId).values())
        : [];
      const hostSubmitted = allTurns.some(t => t.isHost);
      const submittedEmails = allTurns.filter(t => !t.isHost).map(t => t.playerEmail);
      const companionSubmittedCount = joinedEmails.filter(email => submittedEmails.includes(email)).length;
      const submittedCount = (hostSubmitted ? 1 : 0) + companionSubmittedCount;
      const allReady = hostSubmitted && (joinedCompanionCount === 0 || companionSubmittedCount >= joinedCompanionCount);
      const pendingTurns = allTurns.map(t => ({
        playerEmail: t.playerEmail,
        playerName: t.playerName,
        npcId: t.npcId,
        npcName: t.npcName || null,
        characterName: t.characterName || null,
        text: t.text,
        isHost: !!t.isHost,
      }));
      for (const entry of sessionRooms.get(sessionDbId)) {
        if (entry.ws.readyState === entry.ws.OPEN) {
          entry.ws.send(JSON.stringify({
            type: 'turn_status',
            sessionDbId,
            hostSubmitted,
            pendingTurns,
            joinedCompanionCount,
            submittedCount,
            allReady,
          }));
        }
      }
    }

    function checkAutoFire(sessionDbId) {
      broadcastTurnStatus(sessionDbId);
      if (!sessionRooms.has(sessionDbId)) return;
      const allTurns = sessionTurns.has(sessionDbId)
        ? Array.from(sessionTurns.get(sessionDbId).values())
        : [];
      const hostTurn = allTurns.find(t => t.isHost);
      if (!hostTurn) return;
      // Check against ALL joined companions (from session file), not just connected ones
      const joinedEmails = getJoinedCompanionEmails(sessionDbId);
      if (joinedEmails.length === 0) {
        // No companions joined yet — on first turn, wait 30s for companions to arrive
        if (!sessionFirstFireTimers.has(sessionDbId)) {
          console.log(`[WS] First turn with no companions — waiting 30s for joins (session: ${sessionDbId})`);
          const timer = setTimeout(() => {
            sessionFirstFireTimers.delete(sessionDbId);
            // Re-check: if companions joined during the wait, let normal flow handle it
            const nowJoined = getJoinedCompanionEmails(sessionDbId);
            if (nowJoined.length > 0) {
              checkAutoFire(sessionDbId);
            } else {
              fireDmForSession(sessionDbId);
            }
          }, 30_000);
          sessionFirstFireTimers.set(sessionDbId, timer);
        }
        return;
      }
      // If companions joined during the grace period, cancel the timer
      if (sessionFirstFireTimers.has(sessionDbId)) {
        clearTimeout(sessionFirstFireTimers.get(sessionDbId));
        sessionFirstFireTimers.delete(sessionDbId);
      }
      const submittedEmails = allTurns.filter(t => !t.isHost).map(t => t.playerEmail);
      const allReady = joinedEmails.every(email => submittedEmails.includes(email));
      if (!allReady) return;

      // Everyone is ready — fire DM
      fireDmForSession(sessionDbId);
    }

    async function fireDmForSession(sessionDbId) {
      if (!sessionRooms.has(sessionDbId)) return;
      const allTurns = sessionTurns.has(sessionDbId)
        ? Array.from(sessionTurns.get(sessionDbId).values())
        : [];
      const hostTurn = allTurns.find(t => t.isHost);
      if (!hostTurn) return;
      const companionTurnsArr = allTurns.filter(t => !t.isHost);

      // Get or create session engine
      const session = readSessionByDbId(sessionDbId);
      if (!session) return;
      const ownerEmail = getSessionOwnerEmail(session);
      const existingCtx = sessionEngines.get(sessionDbId);
      const engineCtx = getOrCreateSessionEngine(sessionDbId, dataDir, {
        characterId: session.characterId,
        scenarioId: session.scenarioId,
        campaignId: session.campaignId || 'demo',
        ownerEmail,
        claudeSessionId: session.claudeSessionId,
        messageHistory: existingCtx?.messageHistory || [],
        companionConfig: session.companionConfig || null,
        dmPersonality: session.dmPersonality || null,
      });

      // Build the combined player text (host + companion actions)
      let playerText = hostTurn.text;
      if (companionTurnsArr.length > 0) {
        const companionActions = companionTurnsArr.map(t => {
          const charLabel = t.characterName || t.npcName || t.npcId;
          const swapNote = t.characterName && t.npcName
            ? ` (playing their own character ${t.characterName}, who has replaced ${t.npcName} in the party)`
            : '';
          let line = `[Companion player ${t.playerName} as ${charLabel}${swapNote}]: ${t.text}`;
          // Include character sheet only on first turn with this character
          const sheetKey = t.characterId || t.characterName;
          if (!companionSheetsSent.has(sessionDbId)) companionSheetsSent.set(sessionDbId, new Set());
          const sentSheets = companionSheetsSent.get(sessionDbId);
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
        playerText += `\n\n--- Companion Actions ---\n${companionActions}`;
      }

      // Broadcast companion actions as separate messages
      // Exclude the submitter (they already added the message locally on submit)
      for (const t of companionTurnsArr) {
        const charLabel = t.characterName || t.npcName || t.npcId;
        const submitterEntry = Array.from(sessionRooms.get(sessionDbId) || [])
          .find(e => e.playerEmail === t.playerEmail);
        broadcastSessionMessage(sessionDbId, 'companion_action', {
          characterName: charLabel,
          playerName: t.playerName,
          playerEmail: t.playerEmail,
          text: t.text,
          timestamp: new Date().toISOString(),
        }, submitterEntry);
      }

      // Host's player message was already broadcast when queued — no duplicate needed

      // Clear pending turns
      sessionTurns.delete(sessionDbId);
      broadcastSessionTurns(sessionDbId);
      clearPendingTurns(sessionDbId);
      broadcastTurnStatus(sessionDbId);

      // Broadcast sessions_changed so widgets refresh
      broadcastToAll('sessions_changed');

      // Fire DM engine
      const { engine } = engineCtx;
      engineCtx.messageHistory.push({ type: 'player', text: playerText });

      // Gather active companion players for system prompt
      const activeCompanions = sessionRooms.has(sessionDbId)
        ? Array.from(sessionRooms.get(sessionDbId))
            .filter(e => e.companionNpcId && e.ws.readyState === e.ws.OPEN)
            .map(e => ({
              playerEmail: e.playerEmail,
              playerName: e.playerName,
              companionNpcId: e.companionNpcId,
              companionCharacterName: e.companionCharacterName || null,
              companionCharacterId: e.companionCharacterId || null,
            }))
        : [];

      // Set status to thinking for all watchers (broadcastSessionMessage with no excludedEntry sends to ALL)
      for (const entry of (sessionRooms.get(sessionDbId) || [])) {
        if (entry.ws.readyState === entry.ws.OPEN) {
          entry.ws.send(JSON.stringify({ type: 'session_status', status: 'thinking' }));
        }
      }

      try {
        // Snapshot session data dir if needed
        const cid = engineCtx.campaignId || 'demo';
        try { snapshotToSession(dataDir, ownerEmail, cid, sessionDbId); } catch (e) { console.error('[WS] Snapshot error:', e); }

        const stream = engine.run(playerText, {
          characterId: engineCtx.characterId,
          scenarioId: engineCtx.scenarioId,
          campaignId: engineCtx.campaignId,
          messageHistory: engineCtx.messageHistory,
          playerEmail: ownerEmail,
          companionPlayers: activeCompanions.length > 0 ? activeCompanions : undefined,
          sessionDbId,
          companionConfig: engineCtx.companionConfig || undefined,
          dmPersonality: engineCtx.dmPersonality || undefined,
        });

        for await (const event of stream) {
          switch (event.type) {
            case 'dm_partial':
              broadcastSessionMessage(sessionDbId, 'dm_partial', { text: event.text });
              break;
            case 'dice_roll':
              broadcastSessionMessage(sessionDbId, 'dice_roll', {
                notation: event.notation, rolls: event.rolls,
                modifier: event.modifier, total: event.total, label: event.label,
              });
              break;
            case 'dm_response':
              engineCtx.messageHistory.push({ type: 'dm', text: event.text });
              broadcastSessionMessage(sessionDbId, 'dm_response', { text: event.text });
              break;
            case 'dm_complete':
              broadcastSessionMessage(sessionDbId, 'dm_complete', { sessionId: event.sessionId });
              // Persist turn messages + DM response to session JSON
              try {
                const sess = readSessionByDbId(sessionDbId);
                if (sess) {
                  if (event.sessionId) sess.claudeSessionId = event.sessionId;
                  if (!Array.isArray(sess.messages)) sess.messages = [];
                  // Append host's player message
                  sess.messages.push({ type: 'player', text: hostTurn.text, timestamp: new Date().toISOString() });
                  // Append companion actions
                  for (const ct of companionTurnsArr) {
                    sess.messages.push({
                      type: 'companion',
                      characterName: ct.characterName || ct.npcName || ct.npcId,
                      playerName: ct.playerName,
                      text: ct.text,
                      timestamp: new Date().toISOString(),
                    });
                  }
                  // Append DM response (last dm text from messageHistory)
                  const lastDm = engineCtx.messageHistory.filter(m => m.type === 'dm').pop();
                  if (lastDm) {
                    sess.messages.push({ type: 'dm', text: lastDm.text, timestamp: new Date().toISOString() });
                  }
                  sess.updatedAt = new Date().toISOString();
                  const fp = findSessionFilePath(sessionDbId);
                  if (fp) fs.writeFileSync(fp, JSON.stringify(sess, null, 2));
                }
              } catch (e) { console.error('[WS] Failed to persist multiplayer turn:', e); }
              break;
            case 'session_id':
              broadcastSessionMessage(sessionDbId, 'session_id', { sessionId: event.sessionId });
              break;
            case 'error':
              broadcastSessionMessage(sessionDbId, 'error', { error: event.error });
              break;
          }
        }
      } catch (err) {
        console.error('[WS] DM engine error (multiplayer fire):', err);
        broadcastSessionMessage(sessionDbId, 'error', { error: err.message || 'DM engine error' });
      } finally {
        // Set status to idle for all
        for (const entry of (sessionRooms.get(sessionDbId) || [])) {
          if (entry.ws.readyState === entry.ws.OPEN) {
            entry.ws.send(JSON.stringify({ type: 'session_status', status: 'idle' }));
          }
        }
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
      // Only broadcast join for companion players (not host, not observers)
      if (!canWrite && wsEntry.companionNpcId) {
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
          companionConfig = msg.companionConfig || null;
          dmPersonality = msg.dmPersonality || null;
          wsEntry.playerEmail = msg.playerEmail;
          wsEntry.campaignId = campaignId;
          wsEntry.characterId = characterId;
          // Clear companion state from previous session
          wsEntry.companionNpcId = null;
          wsEntry.companionCharacterId = null;
          wsEntry.companionCharacterName = null;
          wsEntry.companionCharacterData = null;
          wsEntry.isHost = true;
          // Clear stale participants on the client
          send('session_participants', { sessionDbId: null, participants: [] });
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
          // Prevent non-owners from resuming a session they're watching/companion in
          if (currentSessionDbId && !currentSessionCanWrite) {
            send('error', { error: 'Only the session host can resume this session.' });
            break;
          }
          // Detect session or campaign switch and force a fresh Claude conversation
          // to prevent cross-contamination (e.g. Shattered Coast context bleeding
          // into a Wonderland session).
          const prevClaudeId = engine.sessionId;
          const newClaudeId = msg.claudeSessionId || null;
          const prevCampaignId = campaignId;
          const newCampaignId = msg.campaignId || null;
          const isSameClaudeSession = prevClaudeId && newClaudeId && prevClaudeId === newClaudeId;
          const isCampaignSwitch = prevCampaignId && newCampaignId && prevCampaignId !== newCampaignId;

          if (isCampaignSwitch) {
            console.log(`[WS] Campaign switch detected — forcing fresh Claude session (${prevCampaignId} → ${newCampaignId})`);
          } else if (prevClaudeId && !isSameClaudeSession) {
            console.log(`[WS] Session switch detected — forcing fresh Claude session (was: ${prevClaudeId}, switching to: ${newClaudeId || 'new'})`);
          }

          characterId = msg.characterId || null;
          scenarioId = msg.scenarioId || null;
          campaignId = newCampaignId;
          companionConfig = msg.companionConfig || null;
          dmPersonality = msg.dmPersonality || null;
          // Use the new session's Claude ID, UNLESS switching campaigns —
          // in which case force null to start a fresh conversation with the
          // correct system prompt. Claude's old conversation context would
          // have the wrong campaign's characters, NPCs, and scenario.
          engine.sessionId = isCampaignSwitch ? null : newClaudeId;
          wsEntry.playerEmail = msg.playerEmail;
          wsEntry.campaignId = campaignId;
          wsEntry.characterId = characterId;
          wsEntry.characterName = null;
          // Clear companion state from previous session (host resuming their own game)
          wsEntry.companionNpcId = null;
          wsEntry.companionCharacterId = null;
          wsEntry.companionCharacterName = null;
          wsEntry.companionCharacterData = null;
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

        case 'chat_typing': {
          if (currentChatKey && chatRooms.has(currentChatKey)) {
            for (const entry of chatRooms.get(currentChatKey)) {
              if (entry !== wsEntry && entry.ws.readyState === entry.ws.OPEN) {
                entry.ws.send(JSON.stringify({
                  type: 'chat_typing',
                  playerEmail: wsEntry.playerEmail,
                  playerName: wsEntry.playerName,
                  typing: !!msg.typing,
                }));
              }
            }
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
          // Also restore persisted character choice from session JSON
          let companionCharacterId = null;
          let companionCharacterName = null;
          if (companionNpcId) {
            wsEntry.companionNpcId = companionNpcId;
            const cp = (session.companionPlayers || {})[companionNpcId];
            if (cp?.characterId) {
              companionCharacterId = cp.characterId;
              companionCharacterName = cp.characterName || null;
              wsEntry.companionCharacterId = companionCharacterId;
              wsEntry.companionCharacterName = companionCharacterName;
            }
          }
          joinSessionRoom(requestedSessionId, canWrite);
          const ownerName = getSessionOwnerName(session);
          const accessPayload = {
            sessionDbId: requestedSessionId,
            ownerEmail,
            ownerName,
            canWrite,
            readOnly: !canWrite,
          };
          if (companionNpcId) {
            accessPayload.companionNpcId = companionNpcId;
            if (companionCharacterId) {
              accessPayload.companionCharacterId = companionCharacterId;
              accessPayload.companionCharacterName = companionCharacterName;
            }
          }
          send('session_access', accessPayload);

          // Snapshot character/NPC files to session-scoped directory (creates if not exists, skips existing)
          if (canWrite && ownerEmail) {
            try { snapshotToSession(dataDir, ownerEmail, session.campaignId || campaignId || 'demo', requestedSessionId); } catch (e) { console.error('[WS] Snapshot error:', e); }
          }

          // Restore pending turns from session JSON into in-memory map (reconnect support)
          if (session.pendingTurns && Object.keys(session.pendingTurns).length > 0) {
            if (!sessionTurns.has(requestedSessionId)) sessionTurns.set(requestedSessionId, new Map());
            const turnsMap = sessionTurns.get(requestedSessionId);
            for (const [email, turnData] of Object.entries(session.pendingTurns)) {
              if (!turnsMap.has(email)) {
                turnsMap.set(email, turnData);
              }
            }
          }

          // Always send current pending turns (empty array clears stale client state)
          const watchTurns = sessionTurns.has(requestedSessionId)
            ? Array.from(sessionTurns.get(requestedSessionId).values())
            : [];
          send('companion_turns_update', { sessionDbId: requestedSessionId, turns: watchTurns });

          // Send unified turn status
          broadcastTurnStatus(requestedSessionId);

          // Initialize session engine if this is a multiplayer session
          if (canWrite && session.companionPlayers && Object.keys(session.companionPlayers).length > 0) {
            getOrCreateSessionEngine(requestedSessionId, dataDir, {
              characterId: session.characterId,
              scenarioId: session.scenarioId,
              campaignId: session.campaignId || campaignId || 'demo',
              ownerEmail,
              claudeSessionId: session.claudeSessionId,
              companionConfig: session.companionConfig || null,
              dmPersonality: session.dmPersonality || null,
            });
          }

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

          // Multiplayer: queue the host's turn instead of firing immediately
          if (currentSessionDbId && isMultiplayerSession(currentSessionDbId)) {
            const turnText = msg.text.trim();
            if (!sessionTurns.has(currentSessionDbId)) sessionTurns.set(currentSessionDbId, new Map());
            sessionTurns.get(currentSessionDbId).set(wsEntry.playerEmail, {
              playerEmail: wsEntry.playerEmail,
              playerName: wsEntry.playerName || wsEntry.playerEmail,
              npcId: null,
              npcName: null,
              characterName: wsEntry.characterName || null,
              characterId: characterId || null,
              text: turnText,
              isHost: true,
            });
            persistTurnToSession(currentSessionDbId, {
              playerEmail: wsEntry.playerEmail,
              playerName: wsEntry.playerName || wsEntry.playerEmail,
              npcId: null,
              text: turnText,
              isHost: true,
              submittedAt: new Date().toISOString(),
            });
            console.log(`[WS] Host turn queued — session: ${currentSessionDbId}, player: ${wsEntry.playerEmail}`);
            // Broadcast host's message to all session watchers immediately
            broadcastSessionMessage(currentSessionDbId, 'session_player_message', {
              text: turnText,
              timestamp: new Date().toISOString(),
            }, wsEntry);
            // Also echo back to the host
            send('session_player_message', { text: turnText, timestamp: new Date().toISOString() });
            broadcastToAll('sessions_changed');
            checkAutoFire(currentSessionDbId);
            break;
          }

          // Single player: fire DM engine immediately
          processing = true;
          send('session_status', { status: 'thinking' });
          broadcastToSessionWatchers('session_status', { status: 'thinking' });

          try {
            const playerText = msg.text.trim();

            // Send host's player message back to them
            send('session_player_message', { text: playerText });

            messageHistory.push({ type: 'player', text: playerText });
            broadcastToSessionWatchers('session_player_message', {
              text: playerText,
              timestamp: new Date().toISOString(),
            });

            // Snapshot session data if we have a saved session
            if (currentSessionDbId && wsEntry.playerEmail) {
              try { snapshotToSession(dataDir, wsEntry.playerEmail, campaignId || 'demo', currentSessionDbId); } catch (e) { console.error('[WS] Snapshot error:', e); }
            }

            const stream = engine.run(playerText, {
              characterId,
              scenarioId,
              campaignId,
              messageHistory,
              playerEmail: wsEntry.playerEmail,
              sessionDbId: currentSessionDbId || undefined,
              companionConfig: companionConfig || undefined,
              dmPersonality: dmPersonality || undefined,
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
          // Persist character choice to session JSON
          try {
            const sessionFile = readSessionByDbId(currentSessionDbId);
            if (sessionFile && sessionFile.companionPlayers && sessionFile.companionPlayers[wsEntry.companionNpcId]) {
              sessionFile.companionPlayers[wsEntry.companionNpcId].characterId = msg.characterId || null;
              sessionFile.companionPlayers[wsEntry.companionNpcId].characterName = msg.characterName || null;
              sessionFile.updatedAt = new Date().toISOString();
              const fp = findSessionFilePath(currentSessionDbId);
              if (fp) fs.writeFileSync(fp, JSON.stringify(sessionFile, null, 2));
            }
          } catch (err) {
            console.error('[WS] Failed to persist companion character choice:', err);
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
                  const charDataToWrite = { ...msg.characterData, _companionOwner: wsEntry.playerEmail, _filename: `${charSlug}.json` };
                  if (!fs.existsSync(destPath)) {
                    fs.mkdirSync(hostCharDir, { recursive: true });
                    fs.writeFileSync(destPath, JSON.stringify(charDataToWrite, null, 2));
                    console.log(`[WS] Copied companion character "${msg.characterData.name}" to host's roster: ${destPath}`);
                  } else {
                    // Only overwrite if the existing file is a companion-owned character.
                    // Never overwrite the host's own character files.
                    try {
                      const existing = JSON.parse(fs.readFileSync(destPath, 'utf-8'));
                      if (existing._companionOwner) {
                        fs.writeFileSync(destPath, JSON.stringify(charDataToWrite, null, 2));
                        console.log(`[WS] Updated companion character "${msg.characterData.name}" in host's roster: ${destPath}`);
                      } else {
                        console.log(`[WS] Skipping overwrite of host character "${existing.name || charSlug}" — companion "${msg.characterData.name}" has same slug`);
                      }
                    } catch (readErr) {
                      console.warn(`[WS] Could not read existing character file at ${destPath}, skipping overwrite:`, readErr.message);
                    }
                  }
                  // Also copy to session-scoped directory if a session snapshot exists
                  const sessCharDir = getSessionCharactersDir(dataDir, hostEntry.playerEmail, hostCampaignId, currentSessionDbId);
                  if (fs.existsSync(sessCharDir)) {
                    const sessDestPath = path.join(sessCharDir, `${charSlug}.json`);
                    const charDataToWrite2 = { ...msg.characterData, _companionOwner: wsEntry.playerEmail, _filename: `${charSlug}.json` };
                    if (!fs.existsSync(sessDestPath)) {
                      fs.writeFileSync(sessDestPath, JSON.stringify(charDataToWrite2, null, 2));
                      console.log(`[WS] Copied companion character "${msg.characterData.name}" to session dir: ${sessDestPath}`);
                    } else {
                      try {
                        const existing = JSON.parse(fs.readFileSync(sessDestPath, 'utf-8'));
                        if (existing._companionOwner) {
                          fs.writeFileSync(sessDestPath, JSON.stringify(charDataToWrite2, null, 2));
                          console.log(`[WS] Updated companion character "${msg.characterData.name}" in session dir: ${sessDestPath}`);
                        }
                      } catch { /* skip */ }
                    }
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
            isHost: false,
          });
          persistTurnToSession(currentSessionDbId, {
            playerEmail: wsEntry.playerEmail,
            playerName: wsEntry.playerName || wsEntry.playerEmail,
            npcId: wsEntry.companionNpcId,
            npcName,
            characterName: msg.characterName || wsEntry.companionCharacterName || null,
            text: turnText,
            isHost: false,
            submittedAt: new Date().toISOString(),
          });
          console.log(`[WS] Companion turn submitted — session: ${currentSessionDbId}, player: ${wsEntry.playerEmail}, npc: ${wsEntry.companionNpcId}`);
          broadcastSessionTurns(currentSessionDbId);
          broadcastToAll('sessions_changed');
          checkAutoFire(currentSessionDbId);
          break;
        }

        case 'companion_turn_retract': {
          if (!currentSessionDbId) break;
          let retractedCompText = null;
          if (sessionTurns.has(currentSessionDbId)) {
            const turn = sessionTurns.get(currentSessionDbId).get(wsEntry.playerEmail);
            retractedCompText = turn?.text || null;
            sessionTurns.get(currentSessionDbId).delete(wsEntry.playerEmail);
            broadcastSessionTurns(currentSessionDbId);
          }
          removeTurnFromSession(currentSessionDbId, wsEntry.playerEmail);
          // Send retracted text back for input restoration
          send('companion_turn_retracted', { text: retractedCompText });
          broadcastTurnStatus(currentSessionDbId);
          broadcastToAll('sessions_changed');
          break;
        }

        case 'typing_status': {
          if (!currentSessionDbId) break;
          broadcastSessionMessage(currentSessionDbId, 'typing_status', {
            playerEmail: wsEntry.playerEmail,
            playerName: wsEntry.playerName,
            isHost: !!wsEntry.isHost,
            companionNpcId: wsEntry.companionNpcId || null,
            typing: !!msg.typing,
          }, wsEntry); // exclude sender
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
          removeTurnFromSession(currentSessionDbId, skipEmail);
          checkAutoFire(currentSessionDbId);
          break;
        }

        case 'host_turn_submit': {
          // Unified multiplayer: host queues their turn, waits for companions
          if (!currentSessionDbId || !currentSessionCanWrite) {
            send('error', { error: 'Only the host can submit a turn.' });
            break;
          }
          const hostText = String(msg.text || '').trim();
          if (!hostText) {
            send('error', { error: 'Empty turn.' });
            break;
          }
          if (!sessionTurns.has(currentSessionDbId)) sessionTurns.set(currentSessionDbId, new Map());
          sessionTurns.get(currentSessionDbId).set(wsEntry.playerEmail, {
            playerEmail: wsEntry.playerEmail,
            playerName: wsEntry.playerName || wsEntry.playerEmail,
            npcId: null,
            npcName: null,
            characterName: wsEntry.characterName || null,
            characterId: characterId || null,
            text: hostText,
            isHost: true,
          });
          persistTurnToSession(currentSessionDbId, {
            playerEmail: wsEntry.playerEmail,
            playerName: wsEntry.playerName || wsEntry.playerEmail,
            npcId: null,
            text: hostText,
            isHost: true,
            submittedAt: new Date().toISOString(),
          });
          console.log(`[WS] Host turn queued — session: ${currentSessionDbId}, player: ${wsEntry.playerEmail}`);
          // Broadcast host's message to all session watchers (excluding host)
          broadcastSessionMessage(currentSessionDbId, 'session_player_message', {
            text: hostText,
            timestamp: new Date().toISOString(),
          }, wsEntry);
          // Echo back to the host so their message appears in the adventure box
          send('session_player_message', { text: hostText, timestamp: new Date().toISOString() });
          broadcastToAll('sessions_changed');
          checkAutoFire(currentSessionDbId);
          break;
        }

        case 'host_turn_retract': {
          if (!currentSessionDbId) break;
          let retractedHostText = null;
          if (sessionTurns.has(currentSessionDbId)) {
            const turn = sessionTurns.get(currentSessionDbId).get(wsEntry.playerEmail);
            retractedHostText = turn?.text || null;
            sessionTurns.get(currentSessionDbId).delete(wsEntry.playerEmail);
          }
          removeTurnFromSession(currentSessionDbId, wsEntry.playerEmail);
          // Send retracted text back for input restoration
          send('host_turn_retracted', { text: retractedHostText });
          broadcastTurnStatus(currentSessionDbId);
          broadcastToAll('sessions_changed');
          break;
        }

        case 'host_turn_continue': {
          // Fire DM without waiting for all companions
          if (!currentSessionDbId || !currentSessionCanWrite) break;
          // Check there's a host turn queued
          const hasTurn = sessionTurns.has(currentSessionDbId) &&
            Array.from(sessionTurns.get(currentSessionDbId).values()).some(t => t.isHost);
          if (!hasTurn) break;
          fireDmForSession(currentSessionDbId);
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
