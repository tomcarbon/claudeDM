import { useState, useEffect, useRef, useCallback } from 'react';
import { playNotification } from '../utils/audio';

const WS_URL = `ws://${window.location.hostname}:3001/ws`;
const RECONNECT_DELAY = 2000;

function formatDiceRoll(msg) {
  const { notation, rolls, modifier, total, label } = msg;
  const rollsStr = rolls.length > 1 ? `[${rolls.join(', ')}]` : `${rolls[0]}`;
  const modStr = modifier > 0 ? ` + ${modifier}` : modifier < 0 ? ` - ${Math.abs(modifier)}` : '';
  const prefix = label ? `${label} — ` : '';
  return `${prefix}${notation}: ${rollsStr}${modStr} = ${total}`;
}

export default function useWebSocket() {
  const [messages, setMessages] = useState([]);
  const [chatMessages, setChatMessages] = useState([]);
  const [onlinePlayers, setOnlinePlayers] = useState([]);
  const [selfChatConnectionId, setSelfChatConnectionId] = useState(null);
  const [sessionAccess, setSessionAccess] = useState({ sessionDbId: null, canWrite: false, readOnly: true });
  const [sessionParticipants, setSessionParticipants] = useState([]);
  const [companionTurns, setCompanionTurns] = useState([]);
  const [turnStatus, setTurnStatus] = useState(null);
  const [retractedText, setRetractedText] = useState(null);
  const [typingPlayers, setTypingPlayers] = useState({}); // { playerEmail: { playerName, isHost, companionNpcId, ts } }
  const [chatTypingPlayers, setChatTypingPlayers] = useState({}); // { playerEmail: { playerName, ts } }
  const autoFireRef = useRef(null); // callback for auto-fire when all players ready
  const [status, setStatus] = useState('disconnected');
  const [permissionRequest, setPermissionRequest] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [sessionsChanged, setSessionsChanged] = useState(0);
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const partialTextRef = useRef('');
  const currentChatKeyRef = useRef(null);
  const pendingResumeRef = useRef(null);
  const pendingWatchRef = useRef(null);

  const connect = useCallback(function connectWebSocket() {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('idle');
      if (pendingResumeRef.current) {
        ws.send(JSON.stringify(pendingResumeRef.current));
        pendingResumeRef.current = null;
      }
      if (pendingWatchRef.current) {
        ws.send(JSON.stringify(pendingWatchRef.current));
      }
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case 'session_status':
          setStatus(msg.status);
          break;

        case 'dice_roll':
          setMessages(prev => [...prev, { type: 'dice_roll', text: formatDiceRoll(msg) }]);
          break;

        case 'dm_partial':
          partialTextRef.current = msg.text;
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last && last.type === 'dm_partial') {
              return [...prev.slice(0, -1), { type: 'dm_partial', text: msg.text }];
            }
            return [...prev, { type: 'dm_partial', text: msg.text }];
          });
          break;

        case 'dm_response':
          partialTextRef.current = '';
          setMessages(prev => {
            // Replace any trailing partial with the final response
            const filtered = prev.filter((m, i) =>
              !(m.type === 'dm_partial' && i === prev.length - 1)
            );
            return [...filtered, { type: 'dm', text: msg.text }];
          });
          playNotification();
          break;

        case 'dm_complete':
          // Finalize: replace any remaining partial with dm message
          partialTextRef.current = '';
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last && last.type === 'dm_partial') {
              return [...prev.slice(0, -1), { type: 'dm', text: last.text }];
            }
            return prev;
          });
          break;

        case 'session_id':
          setSessionId(msg.sessionId);
          break;

        case 'permission_request':
          setPermissionRequest({
            toolUseID: msg.toolUseID,
            toolName: msg.toolName,
            description: msg.description,
            input: msg.input,
          });
          break;

        case 'session_player_message':
          setMessages(prev => [...prev, { type: 'player', text: msg.text }]);
          break;

        case 'sessions_changed':
          setSessionsChanged(prev => prev + 1);
          break;

        case 'player_message_updated':
          break;

        case 'companion_action':
          setMessages(prev => [...prev, {
            type: 'companion',
            characterName: msg.characterName,
            playerName: msg.playerName,
            text: msg.text,
          }]);
          playNotification();
          break;

        case 'session_access':
          setSessionAccess({
            sessionDbId: msg.sessionDbId || null,
            ownerEmail: msg.ownerEmail || null,
            ownerName: msg.ownerName || null,
            canWrite: msg.canWrite === true,
            readOnly: msg.readOnly !== false,
            companionNpcId: msg.companionNpcId || null,
            companionCharacterId: msg.companionCharacterId || null,
            companionCharacterName: msg.companionCharacterName || null,
          });
          break;

        case 'companion_turns_update':
          setCompanionTurns(Array.isArray(msg.turns) ? msg.turns : []);
          break;

        case 'session_participants':
          setSessionParticipants(Array.isArray(msg.participants) ? msg.participants : []);
          break;

        case 'turn_status':
          setTurnStatus({
            hostSubmitted: msg.hostSubmitted,
            pendingTurns: msg.pendingTurns || [],
            joinedCompanionCount: msg.joinedCompanionCount,
            submittedCount: msg.submittedCount,
            allReady: msg.allReady,
          });
          break;

        case 'auto_fire':
          // Server says everyone is ready — auto-fire the DM
          setTurnStatus(null);
          if (autoFireRef.current) {
            autoFireRef.current(msg.text);
          }
          break;

        case 'host_turn_retracted':
          // Host retracted their turn — restore text to input
          setRetractedText(msg.text || '');
          setTurnStatus(null);
          break;

        case 'companion_turn_retracted':
          // Companion retracted their turn — restore text to input
          setRetractedText(msg.text || '');
          break;

        case 'typing_status':
          if (msg.typing) {
            setTypingPlayers(prev => ({
              ...prev,
              [msg.playerEmail]: {
                playerName: msg.playerName,
                isHost: msg.isHost,
                companionNpcId: msg.companionNpcId,
                ts: Date.now(),
              },
            }));
          } else {
            setTypingPlayers(prev => {
              const next = { ...prev };
              delete next[msg.playerEmail];
              return next;
            });
          }
          break;

        case 'session_player_joined':
          setMessages(prev => [...prev, {
            type: 'system',
            text: `${msg.playerName} has joined the session${msg.companionNpcId ? ` as a companion player` : ''}.`,
            companionNpcId: msg.companionNpcId || null,
          }]);
          playNotification();
          break;

        case 'session_player_left': {
          const charNote = msg.companionCharacterName
            ? ` The DM now controls ${msg.companionCharacterName} as an NPC companion.`
            : '';
          setMessages(prev => [...prev, {
            type: 'system',
            text: `${msg.playerName} has left the session.${charNote}`,
            playerName: msg.playerName,
            companionNpcId: msg.companionNpcId || null,
          }]);
          break;
        }

        case 'chat_message':
          setChatMessages(prev => [...prev, {
            playerEmail: msg.playerEmail,
            playerName: msg.playerName,
            isAdmin: msg.isAdmin,
            text: msg.text,
            timestamp: msg.timestamp,
          }]);
          // Clear typing indicator when we receive their message
          setChatTypingPlayers(prev => {
            if (!prev[msg.playerEmail]) return prev;
            const next = { ...prev };
            delete next[msg.playerEmail];
            return next;
          });
          break;

        case 'chat_typing':
          if (msg.typing) {
            setChatTypingPlayers(prev => ({
              ...prev,
              [msg.playerEmail]: {
                playerName: msg.playerName,
                ts: Date.now(),
              },
            }));
          } else {
            setChatTypingPlayers(prev => {
              if (!prev[msg.playerEmail]) return prev;
              const next = { ...prev };
              delete next[msg.playerEmail];
              return next;
            });
          }
          break;

        case 'chat_system':
          setChatMessages(prev => [...prev, {
            isSystem: true,
            text: msg.text,
            timestamp: msg.timestamp,
          }]);
          break;

        case 'chat_participants':
          if (!currentChatKeyRef.current || msg.chatKey === currentChatKeyRef.current) {
            setOnlinePlayers(Array.isArray(msg.participants) ? msg.participants : []);
            setSelfChatConnectionId(msg.selfConnectionId ?? null);
          }
          break;

        case 'error':
          setMessages(prev => [...prev, { type: 'system', text: `Error: ${msg.error}` }]);
          break;
      }
    };

    ws.onclose = () => {
      setStatus('disconnected');
      setOnlinePlayers([]);
      setSelfChatConnectionId(null);
      setSessionAccess(prev => ({ ...prev, canWrite: false, readOnly: true }));
      reconnectTimer.current = setTimeout(connectWebSocket, RECONNECT_DELAY);
    };

    ws.onerror = () => {
      setStatus('error');
    };
  }, []);

  useEffect(() => {
    connect();
    // Expire stale typing indicators every 4 seconds
    const typingCleanup = setInterval(() => {
      setTypingPlayers(prev => {
        const now = Date.now();
        const next = {};
        let changed = false;
        for (const [email, entry] of Object.entries(prev)) {
          if (now - entry.ts < 5000) {
            next[email] = entry;
          } else {
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 4000);
    const chatTypingCleanup = setInterval(() => {
      setChatTypingPlayers(prev => {
        const now = Date.now();
        const next = {};
        let changed = false;
        for (const [email, entry] of Object.entries(prev)) {
          if (now - entry.ts < 5000) {
            next[email] = entry;
          } else {
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 4000);
    return () => {
      clearTimeout(reconnectTimer.current);
      clearInterval(typingCleanup);
      clearInterval(chatTypingCleanup);
      wsRef.current?.close();
    };
  }, [connect]);

  const sendMessage = useCallback((text) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      setMessages(prev => [...prev, { type: 'player', text }]);
      wsRef.current.send(JSON.stringify({ type: 'user_message', text }));
    }
  }, []);

  // Send message without adding to local messages — server echoes it back for correct ordering
  const sendMessageRaw = useCallback((text) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'user_message', text }));
    }
  }, []);

  const startSession = useCallback((characterId, scenarioId, player, campaignId, companionConfig) => {
    pendingResumeRef.current = null;
    pendingWatchRef.current = null;
    setSessionAccess({ sessionDbId: null, canWrite: true, readOnly: false });
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'session_start',
        characterId,
        scenarioId,
        campaignId: campaignId || null,
        playerEmail: player?.email || null,
        playerName: player?.name || null,
        companionConfig: companionConfig || null,
      }));
      setMessages([{ type: 'system', text: 'Session started. Please wait while the DM prepares the story.' }]);
    }
  }, []);

  const watchSession = useCallback((sessionDbId, player) => {
    if (!sessionDbId) {
      pendingWatchRef.current = null;
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'session_unwatch' }));
      }
      setSessionAccess({ sessionDbId: null, canWrite: false, readOnly: true });
      return;
    }
    const payload = {
      type: 'session_watch',
      sessionDbId,
      playerEmail: player?.email || null,
      playerName: player?.name || null,
    };
    pendingWatchRef.current = payload;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  const sendPermission = useCallback((toolUseID, allowed) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'permission_response', toolUseID, allowed }));
      setPermissionRequest(null);
    }
  }, []);

  const resumeSession = useCallback((claudeSessionId, characterId, scenarioId, savedMessages, player, campaignId, companionConfig) => {
    const payload = {
      type: 'session_resume',
      claudeSessionId,
      characterId,
      scenarioId,
      campaignId: campaignId || null,
      messages: savedMessages || [],
      playerEmail: player?.email || null,
      playerName: player?.name || null,
      companionConfig: companionConfig || null,
    };
    pendingResumeRef.current = payload;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
      pendingResumeRef.current = null;
    }
  }, []);

  const joinChat = useCallback((chatKey, player) => {
    currentChatKeyRef.current = chatKey || null;
    if (wsRef.current?.readyState === WebSocket.OPEN && chatKey && player) {
      wsRef.current.send(JSON.stringify({
        type: 'chat_join',
        chatKey,
        playerEmail: player.email,
        playerName: player.name,
        isAdmin: player.role === 'admin',
      }));
    }
  }, []);

  const submitHostTurn = useCallback((text) => {
    if (wsRef.current?.readyState === WebSocket.OPEN && text) {
      wsRef.current.send(JSON.stringify({ type: 'host_turn_submit', text }));
    }
  }, []);

  const retractHostTurn = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'host_turn_retract' }));
    }
  }, []);

  const continueWithoutAll = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'host_turn_continue' }));
    }
  }, []);

  const clearRetractedText = useCallback(() => {
    setRetractedText(null);
  }, []);

  const setCompanionCharacter = useCallback((characterId, characterName, npcName, characterData) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'companion_set_character', characterId, characterName, npcName: npcName || null, characterData: characterData || null }));
    }
  }, []);

  const submitCompanionTurn = useCallback((text, { npcName, characterName, characterId } = {}) => {
    if (wsRef.current?.readyState === WebSocket.OPEN && text) {
      wsRef.current.send(JSON.stringify({
        type: 'companion_turn_submit',
        text,
        npcName: npcName || null,
        characterName: characterName || null,
        characterId: characterId || null,
      }));
    }
  }, []);

  const retractCompanionTurn = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'companion_turn_retract' }));
    }
  }, []);

  const skipCompanion = useCallback((playerEmail) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'host_skip_companion', playerEmail }));
    }
  }, []);

  const sendTypingStatus = useCallback((typing) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'typing_status', typing }));
    }
  }, []);

  const sendChatTypingStatus = useCallback((typing) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'chat_typing', typing }));
    }
  }, []);

  const sendChat = useCallback((text, player) => {
    if (wsRef.current?.readyState === WebSocket.OPEN && text && player) {
      wsRef.current.send(JSON.stringify({
        type: 'chat_message',
        text,
        playerEmail: player.email,
        playerName: player.name,
        isAdmin: player.role === 'admin',
      }));
    }
  }, []);

  return {
    messages,
    setMessages,
    chatMessages,
    setChatMessages,
    onlinePlayers,
    selfChatConnectionId,
    status,
    sessionId,
    permissionRequest,
    sendMessage,
    sendMessageRaw,
    startSession,
    sendPermission,
    resumeSession,
    watchSession,
    sessionAccess,
    sessionParticipants,
    companionTurns,
    turnStatus,
    autoFireRef,
    retractedText,
    clearRetractedText,
    submitHostTurn,
    retractHostTurn,
    continueWithoutAll,
    setCompanionCharacter,
    submitCompanionTurn,
    retractCompanionTurn,
    skipCompanion,
    joinChat,
    sendChat,
    sendTypingStatus,
    typingPlayers,
    sendChatTypingStatus,
    chatTypingPlayers,
    sessionsChanged,
  };
}
