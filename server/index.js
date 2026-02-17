// Allow the Claude Agent SDK to spawn Claude Code subprocesses
// even when this server is launched from within a Claude Code session
delete process.env.CLAUDECODE;

const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const charactersRouter = require('./routes/characters');
const npcsRouter = require('./routes/npcs');
const rulesRouter = require('./routes/rules');
const scenariosRouter = require('./routes/scenarios');
const campaignsRouter = require('./routes/campaigns');
const dmSettingsRouter = require('./routes/dm-settings');
const sessionsRouter = require('./routes/sessions');
const settingsRouter = require('./routes/settings');
const { attachWebSocket } = require('./ws-handler');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const DATA_DIR = path.join(__dirname, '..', 'data');

app.use('/api/characters', charactersRouter(DATA_DIR));
app.use('/api/npcs', npcsRouter(DATA_DIR));
app.use('/api/rules', rulesRouter(DATA_DIR));
app.use('/api/scenarios', scenariosRouter(DATA_DIR));
app.use('/api/campaigns', campaignsRouter(DATA_DIR));
app.use('/api/dm-settings', dmSettingsRouter(DATA_DIR));
app.use('/api/sessions', sessionsRouter(DATA_DIR));
app.use('/api/settings', settingsRouter(DATA_DIR));

// Serve static build in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'client', 'dist', 'index.html'));
  });
}

const server = http.createServer(app);
attachWebSocket(server, DATA_DIR);

server.listen(PORT, () => {
  console.log(`D&D Companion server running on http://localhost:${PORT}`);
});
