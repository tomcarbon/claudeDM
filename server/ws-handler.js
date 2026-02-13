const { WebSocketServer } = require('ws');
const { DmEngine } = require('./dm-engine');

function attachWebSocket(server, dataDir) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    console.log('[WS] Client connected');

    const engine = new DmEngine(dataDir);
    let characterId = null;
    let scenarioId = null;
    let processing = false;

    // Pending permission requests: toolUseID -> { resolve }
    const pendingPermissions = new Map();

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
          if (msg.claudeSessionId) {
            engine.sessionId = msg.claudeSessionId;
          }
          send('session_status', { status: 'idle' });
          console.log(`[WS] Session resumed — claude: ${engine.sessionId}, character: ${characterId}, scenario: ${scenarioId}`);
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
            const stream = engine.run(msg.text.trim(), {
              characterId,
              scenarioId,
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
