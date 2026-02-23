const fs = require('fs');
const path = require('path');

function getPlayerEmailFromRequest(req) {
  return String(req.get('x-player-email') || '').trim().toLowerCase();
}

function readPlayers(dataDir) {
  const playersFile = path.join(dataDir, 'players.json');
  if (!fs.existsSync(playersFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(playersFile, 'utf-8'));
  } catch {
    return {};
  }
}

function getAuthenticatedPlayer(dataDir, req) {
  const email = getPlayerEmailFromRequest(req);
  if (!email || email === 'guest') return null;

  const players = readPlayers(dataDir);
  const player = players[email];
  if (!player) return null;

  return {
    email: player.email,
    name: player.name,
    role: player.role,
  };
}

function requirePlayer(dataDir) {
  return (req, res, next) => {
    const player = getAuthenticatedPlayer(dataDir, req);
    if (!player) return res.status(401).json({ error: 'Login required.' });
    req.player = player;
    next();
  };
}

module.exports = {
  getPlayerEmailFromRequest,
  readPlayers,
  getAuthenticatedPlayer,
  requirePlayer,
};
