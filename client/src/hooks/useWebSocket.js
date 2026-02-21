import { useState, useEffect, useRef, useCallback } from 'react';

const WS_URL = `ws://${window.location.hostname}:3001/ws`;
const RECONNECT_DELAY = 2000;

export default function useWebSocket() {
  const [messages, setMessages] = useState([]);
  const [chatMessages, setChatMessages] = useState([]);
  const [onlinePlayers, setOnlinePlayers] = useState([]);
  const [selfChatConnectionId, setSelfChatConnectionId] = useState(null);
  const [status, setStatus] = useState('disconnected');
  const [permissionRequest, setPermissionRequest] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const partialTextRef = useRef('');
  const currentChatKeyRef = useRef(null);

  const connect = useCallback(function connectWebSocket() {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('idle');
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

        case 'chat_message':
          setChatMessages(prev => [...prev, {
            playerEmail: msg.playerEmail,
            playerName: msg.playerName,
            isAdmin: msg.isAdmin,
            text: msg.text,
            timestamp: msg.timestamp,
          }]);
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
      reconnectTimer.current = setTimeout(connectWebSocket, RECONNECT_DELAY);
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

  const sendMessage = useCallback((text) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      setMessages(prev => [...prev, { type: 'player', text }]);
      wsRef.current.send(JSON.stringify({ type: 'user_message', text }));
    }
  }, []);

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
    startSession,
    sendPermission,
    resumeSession,
    joinChat,
    sendChat,
  };
}
