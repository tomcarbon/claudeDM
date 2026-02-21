const fs = require('fs');
const path = require('path');

function hasAdminAccess(dataDir, req) {
  const email = String(req.get('x-player-email') || '').trim().toLowerCase();
  if (!email) return false;

  const playersFile = path.join(dataDir, 'players.json');
  if (!fs.existsSync(playersFile)) return false;

  try {
    const players = JSON.parse(fs.readFileSync(playersFile, 'utf-8'));
    return players[email]?.role === 'admin';
  } catch {
    return false;
  }
}

function requireAdmin(dataDir) {
  return function adminOnly(req, res, next) {
    if (!hasAdminAccess(dataDir, req)) {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    next();
  };
}

module.exports = {
  hasAdminAccess,
  requireAdmin,
};
