const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { generateBotIdentity, isBotEmail } = require('./bot-names');
const { provisionAllCampaignDefaults, getPlayerDataDir } = require('../player-data');

const BOT_PASSWORD_HASH = crypto.createHash('sha256').update('bot-internal-only').digest('hex');

function readPlayers(dataDir) {
  const file = path.join(dataDir, 'players.json');
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function writePlayers(dataDir, data) {
  fs.writeFileSync(path.join(dataDir, 'players.json'), JSON.stringify(data, null, 2));
}

/**
 * List all bot accounts.
 */
function listBotAccounts(dataDir) {
  const players = readPlayers(dataDir);
  return Object.values(players).filter(p => p.isBot);
}

/**
 * Create a single bot account with provisioned campaign defaults.
 * @returns {{ email: string, name: string }}
 */
function createBotAccount(dataDir) {
  const players = readPlayers(dataDir);
  const existingEmails = new Set(
    Object.values(players).filter(p => p.isBot).map(p => p.email)
  );
  const { name, email } = generateBotIdentity(existingEmails);

  players[email] = {
    email,
    name,
    passwordHash: BOT_PASSWORD_HASH,
    role: 'bot',
    isBot: true,
    createdAt: new Date().toISOString(),
  };
  writePlayers(dataDir, players);

  try {
    provisionAllCampaignDefaults(dataDir, email);
  } catch (e) {
    console.error(`[BotAccounts] Provision error for ${email}:`, e);
  }

  console.log(`[BotAccounts] Created bot account: ${name} (${email})`);
  return { email, name };
}

/**
 * Delete a single bot account and all its data.
 */
function deleteBotAccount(dataDir, email) {
  const players = readPlayers(dataDir);
  if (!players[email]?.isBot) return false;

  delete players[email];
  writePlayers(dataDir, players);

  // Remove player data directory
  const playerDir = getPlayerDataDir(dataDir, email);
  if (fs.existsSync(playerDir)) {
    fs.rmSync(playerDir, { recursive: true, force: true });
  }

  console.log(`[BotAccounts] Deleted bot account: ${email}`);
  return true;
}

/**
 * Adjust bot account count to match desired number.
 * Creates or deletes accounts as needed.
 * @returns {Array<{ email: string, name: string }>} current list of bot accounts
 */
function setDesiredBotCount(dataDir, desiredCount) {
  const bots = listBotAccounts(dataDir);
  const currentCount = bots.length;

  if (desiredCount > currentCount) {
    for (let i = 0; i < desiredCount - currentCount; i++) {
      createBotAccount(dataDir);
    }
  } else if (desiredCount < currentCount) {
    // Delete excess bots (from the end of the list)
    const toDelete = bots.slice(desiredCount);
    for (const bot of toDelete) {
      deleteBotAccount(dataDir, bot.email);
    }
  }

  return listBotAccounts(dataDir);
}

/**
 * Delete ALL bot accounts and their data.
 */
function deleteAllBotAccounts(dataDir) {
  const bots = listBotAccounts(dataDir);
  for (const bot of bots) {
    deleteBotAccount(dataDir, bot.email);
  }
  console.log(`[BotAccounts] Cleaned up ${bots.length} bot accounts.`);
  return bots.length;
}

module.exports = {
  listBotAccounts,
  createBotAccount,
  deleteBotAccount,
  setDesiredBotCount,
  deleteAllBotAccounts,
  isBotEmail,
};
