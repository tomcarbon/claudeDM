const express = require('express');
const cors = require('cors');
const path = require('path');
const charactersRouter = require('./routes/characters');
const npcsRouter = require('./routes/npcs');
const rulesRouter = require('./routes/rules');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const DATA_DIR = path.join(__dirname, '..', 'data');

app.use('/api/characters', charactersRouter(DATA_DIR));
app.use('/api/npcs', npcsRouter(DATA_DIR));
app.use('/api/rules', rulesRouter(DATA_DIR));

// Serve static build in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'client', 'dist', 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`D&D Companion server running on http://localhost:${PORT}`);
});
