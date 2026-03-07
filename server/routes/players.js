const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { provisionAllCampaignDefaults } = require('../player-data');

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

module.exports = function (dataDir) {
  const router = express.Router();
  const playersFile = path.join(dataDir, 'players.json');

  function readPlayers() {
    if (!fs.existsSync(playersFile)) return {};
    return JSON.parse(fs.readFileSync(playersFile, 'utf-8'));
  }

  function writePlayers(data) {
    fs.writeFileSync(playersFile, JSON.stringify(data, null, 2));
  }

  function safePlayer(p) {
    return { email: p.email, name: p.name, role: p.role };
  }

  // GET /api/players/lookup?emails=a@b.com,c@d.com — resolve emails to names
  router.get('/lookup', (req, res) => {
    const emails = String(req.query.emails || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    if (emails.length === 0) return res.json({});
    const players = readPlayers();
    const result = {};
    for (const email of emails) {
      if (players[email]) result[email] = players[email].name;
    }
    res.json(result);
  });

  // POST /api/players/login
  router.post('/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    const players = readPlayers();
    const player = players[email.toLowerCase()];
    if (!player || player.passwordHash !== hashPassword(password)) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    res.json(safePlayer(player));
  });

  // POST /api/players/register
  router.post('/register', (req, res) => {
    const { email, name, password } = req.body;
    if (!email || !name || !password) {
      return res.status(400).json({ error: 'Email, name, and password are required.' });
    }
    if (password.length < 3) {
      return res.status(400).json({ error: 'Password must be at least 3 characters.' });
    }
    const players = readPlayers();
    const key = email.toLowerCase();
    if (players[key]) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }
    players[key] = {
      email: key,
      name: name.trim(),
      passwordHash: hashPassword(password),
      role: 'player',
      createdAt: new Date().toISOString(),
    };
    writePlayers(players);
    // Provision per-player character/NPC data from defaults
    try { provisionAllCampaignDefaults(dataDir, key); } catch (e) { console.error('[Players] Provision error:', e); }
    res.status(201).json(safePlayer(players[key]));
  });

  // PUT /api/players/password
  router.put('/password', (req, res) => {
    const { email, currentPassword, newPassword } = req.body;
    if (!email || !currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Email, current password, and new password are required.' });
    }
    if (newPassword.length < 3) {
      return res.status(400).json({ error: 'New password must be at least 3 characters.' });
    }
    const players = readPlayers();
    const player = players[email.toLowerCase()];
    if (!player || player.passwordHash !== hashPassword(currentPassword)) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }
    player.passwordHash = hashPassword(newPassword);
    writePlayers(players);
    res.json({ success: true });
  });

  return router;
};
