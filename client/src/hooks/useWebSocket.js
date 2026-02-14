import { useState, useEffect, useRef, useCallback } from 'react';

const WS_URL = 'ws://localhost:3001/ws';
const RECONNECT_DELAY = 2000;

export default function useWebSocket() {
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState('disconnected');
  const [permissionRequest, setPermissionRequest] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const partialTextRef = useRef('');

  const connect = useCallback(() => {
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

  const sendMessage = useCallback((text) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      setMessages(prev => [...prev, { type: 'player', text }]);
      wsRef.current.send(JSON.stringify({ type: 'user_message', text }));
    }
  }, []);

  const startSession = useCallback((characterId, scenarioId) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'session_start', characterId, scenarioId }));
      setMessages([{ type: 'system', text: 'Session started. The DM awaits your first move...' }]);
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

  return {
    messages,
    setMessages,
    status,
    sessionId,
    permissionRequest,
    sendMessage,
    startSession,
    sendPermission,
    resumeSession,
  };
}
