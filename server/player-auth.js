const fs = require('fs');
const path = require('path');

// Premium access (WO-0050). Whether a player may START a new adventure in a Premium campaign —
// see server/premium-gate.js for which campaigns those are and where the gate is enforced.
//
// The flag is `premiumAccess` on the player's record in data/players.json. It follows the
// `maxSessions` idiom below: an absent field means "use the default", so existing records need no
// migration and nothing rewrites players.json to add it. Register writes the default explicitly so
// an admin can find the field to change. No route lets a player set it.
//
// To withhold Premium from a player, edit their record on the server: `"premiumAccess": false`.
// That withholds it from that RECORD only. Identity is self-asserted (decision 0005) and a missing
// record means the default, so while the default is `true` any unregistered or self-registered
// identity still passes (see server/premium-gate.js, "WHAT THIS IS NOT"). Since WO-0050 revision 4 an
// unregistered identity cannot START a game at all (`isRegisteredEmail` below); a self-registered
// one still can, with the default.
const DEFAULT_PREMIUM_ACCESS = true;

/**
 * The one reader of the flag. `undefined` (or a missing record — guests, unregistered emails)
 * means the default. `true` means yes. Anything else, including `false`, the string "false", null
 * or 0, means no: a hand-edited value that is not exactly `true` fails closed.
 */
function resolvePremiumAccess(player) {
  if (!player || player.premiumAccess === undefined) return DEFAULT_PREMIUM_ACCESS;
  return player.premiumAccess === true;
}

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
    maxSessions: player.maxSessions, // undefined = use default
    premiumAccess: player.premiumAccess, // undefined = use default (resolvePremiumAccess)
  };
}

/**
 * Premium access for an email, read from players.json. For callers that have an email but no
 * authenticated-player object (the WebSocket handler). Guests and unknown emails get the default.
 */
function getPremiumAccessForEmail(dataDir, email) {
  const key = String(email || '').trim().toLowerCase();
  if (!key || key === 'guest') return resolvePremiumAccess(null);
  return resolvePremiumAccess(readPlayers(dataDir)[key]);
}

/**
 * Is this email "logged in" — does it name a registered record in players.json? (WO-0050
 * revision 4, Part C.) The same test `getAuthenticatedPlayer` applies to REST callers: the email is
 * trimmed and lower-cased, `guest` and empty are never registered, and the record must exist. For
 * callers that have an email but no request (the WebSocket handler, which uses this to refuse a new
 * game to guests and unregistered emails).
 *
 * One deliberate difference: the record must be an OWN property holding an object, so an email of
 * `constructor` or `__proto__` (which inherit from Object.prototype) does not count. That only ever
 * refuses more than `getAuthenticatedPlayer` does, never less.
 *
 * Identity is still self-asserted (decision 0005): this checks that an email is registered, not
 * that the caller is its owner, and self-registration is open.
 */
function isRegisteredEmail(dataDir, email) {
  const key = String(email || '').trim().toLowerCase();
  if (!key || key === 'guest') return false;
  const players = readPlayers(dataDir);
  if (!players || typeof players !== 'object') return false;
  if (!Object.prototype.hasOwnProperty.call(players, key)) return false;
  const rec = players[key];
  return !!rec && typeof rec === 'object';
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
  DEFAULT_PREMIUM_ACCESS,
  resolvePremiumAccess,
  getPremiumAccessForEmail,
  isRegisteredEmail,
};
