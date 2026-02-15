import { useState, useEffect, useRef, useCallback } from 'react';

const WS_URL = 'ws://localhost:3001/ws';
const RECONNECT_DELAY = 2000;

export default function useWebSocket() {
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState('disconnected');
  const [permissionRequest, setPermissionRequest] = useState(null);
  const [sessionId, setSessionId] = useState(null);

  // Multiplayer state
  const [gameCode, setGameCode] = useState(null);
  const [players, setPlayers] = useState([]);
  const [isHost, setIsHost] = useState(false);
  const [myPlayerId, setMyPlayerId] = useState(null);
  const [gamePhase, setGamePhase] = useState('none'); // 'none' | 'lobby' | 'playing'
  const [combatState, setCombatState] = useState(null); // null | { inCombat, turnOrder, activePlayerId, activePlayerName }

  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const partialTextRef = useRef('');
  // Store game info for auto-rejoin on disconnect
  const rejoinInfoRef = useRef(null); // { gameCode, playerName }

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('idle');
      // Auto-rejoin if we have stored game info
      if (rejoinInfoRef.current) {
        const { gameCode: code, playerName } = rejoinInfoRef.current;
        ws.send(JSON.stringify({ type: 'rejoin_game', gameCode: code, playerName }));
      }
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case 'session_status':
          setStatus(msg.status);
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

        // --- Multiplayer messages ---
        case 'game_created':
          setGameCode(msg.gameCode);
          setMyPlayerId(msg.playerId);
          setIsHost(true);
          setGamePhase('lobby');
          break;

        case 'game_joined':
          setGameCode(msg.gameCode);
          setMyPlayerId(msg.playerId);
          if (!msg.rejoined) {
            setIsHost(false);
            setGamePhase('lobby');
          }
          break;

        case 'game_started':
          setGamePhase('playing');
          break;

        case 'player_list':
          setPlayers(msg.players || []);
          break;

        case 'player_joined':
          setMessages(prev => [...prev, {
            type: 'system',
            text: `${msg.playerName} (${msg.characterName}) joined the game.`,
          }]);
          break;

        case 'player_left':
          setMessages(prev => [...prev, {
            type: 'system',
            text: `${msg.playerName} left the game.`,
          }]);
          break;

        case 'player_disconnected':
          setMessages(prev => [...prev, {
            type: 'system',
            text: `${msg.playerName} disconnected.`,
          }]);
          break;

        case 'player_reconnected':
          setMessages(prev => [...prev, {
            type: 'system',
            text: `${msg.playerName} reconnected.`,
          }]);
          break;

        case 'host_promoted':
          setIsHost(true);
          setMessages(prev => [...prev, {
            type: 'system',
            text: 'You are now the host.',
          }]);
          break;

        // Player message from another player (or self, broadcast back)
        case 'player_message':
          setMessages(prev => [...prev, {
            type: 'player',
            text: msg.text,
            playerId: msg.playerId,
            playerName: msg.playerName,
            characterName: msg.characterName,
          }]);
          break;

        case 'message_history':
          // Received when joining a game in progress or reconnecting
          if (msg.messages && msg.messages.length > 0) {
            setMessages(msg.messages);
          }
          break;

        // --- Combat ---
        case 'combat_started':
          setCombatState({
            inCombat: true,
            turnOrder: msg.turnOrder,
            activePlayerId: msg.activePlayerId,
            activePlayerName: msg.activePlayerName,
          });
          setMessages(prev => [...prev, {
            type: 'system',
            text: `Combat started! Initiative order: ${msg.turnOrder.map(t => t.playerName).join(' → ')}`,
          }]);
          break;

        case 'combat_ended':
          setCombatState(null);
          setMessages(prev => [...prev, {
            type: 'system',
            text: 'Combat ended. Returning to free-form exploration.',
          }]);
          break;

        case 'turn_changed':
          setCombatState(prev => prev ? {
            ...prev,
            activePlayerId: msg.activePlayerId,
            activePlayerName: msg.activePlayerName,
          } : null);
          break;

        case 'error':
          setMessages(prev => [...prev, { type: 'system', text: `Error: ${msg.error}` }]);
          break;
      }
    };

    ws.onclose = () => {
      setStatus('disconnected');
      reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY);
    };

    ws.onerror = () => {
      setStatus('error');
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  // --- Solo (backward compat) ---
  const sendMessage = useCallback((text) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      // In multiplayer, don't add to local messages — server broadcasts player_message
      if (!gameCode) {
        setMessages(prev => [...prev, { type: 'player', text }]);
      }
      wsRef.current.send(JSON.stringify({ type: 'user_message', text }));
    }
  }, [gameCode]);

  const startSession = useCallback((characterId, scenarioId) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'session_start', characterId, scenarioId }));
      setMessages([{ type: 'system', text: 'Session started. Please wait while the DM prepares the story.' }]);
    }
  }, []);

  const sendPermission = useCallback((toolUseID, allowed) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'permission_response', toolUseID, allowed }));
      setPermissionRequest(null);
    }
  }, []);

  const resumeSession = useCallback((claudeSessionId, characterId, scenarioId, savedMessages) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'session_resume',
        claudeSessionId,
        characterId,
        scenarioId,
        messages: savedMessages || [],
      }));
    }
  }, []);

  // --- Multiplayer ---
  const createGame = useCallback((playerName, characterId, scenarioId) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      rejoinInfoRef.current = { gameCode: null, playerName }; // Will update gameCode on game_created
      wsRef.current.send(JSON.stringify({ type: 'create_game', playerName, characterId, scenarioId }));
    }
  }, []);

  const joinGame = useCallback((code, playerName, characterId) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      rejoinInfoRef.current = { gameCode: code, playerName };
      wsRef.current.send(JSON.stringify({ type: 'join_game', gameCode: code, playerName, characterId }));
    }
  }, []);

  const startGame = useCallback((openingPrompt) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'start_game', openingPrompt }));
    }
  }, []);

  const leaveGame = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'leave_game' }));
    }
    rejoinInfoRef.current = null;
    setGameCode(null);
    setPlayers([]);
    setIsHost(false);
    setMyPlayerId(null);
    setGamePhase('none');
    setCombatState(null);
    setMessages([]);
  }, []);

  // Update rejoinInfo when gameCode is set (after create_game)
  useEffect(() => {
    if (gameCode && rejoinInfoRef.current) {
      rejoinInfoRef.current.gameCode = gameCode;
    }
  }, [gameCode]);

  return {
    // Existing
    messages,
    setMessages,
    status,
    sessionId,
    permissionRequest,
    sendMessage,
    startSession,
    sendPermission,
    resumeSession,
    // Multiplayer
    gameCode,
    players,
    isHost,
    myPlayerId,
    gamePhase,
    combatState,
    createGame,
    joinGame,
    startGame,
    leaveGame,
  };
}
