const fs = require('fs');
const path = require('path');

function emailToSlug(email) {
  return String(email).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function getPlayerDataDir(dataDir, email) {
  return path.join(dataDir, 'players', emailToSlug(email));
}

function getPlayerCharactersDir(dataDir, email) {
  return path.join(getPlayerDataDir(dataDir, email), 'characters');
}

function getPlayerNpcsDir(dataDir, email) {
  return path.join(getPlayerDataDir(dataDir, email), 'npcs');
}

function ensurePlayerDataExists(dataDir, email) {
  const charDir = getPlayerCharactersDir(dataDir, email);
  const npcDir = getPlayerNpcsDir(dataDir, email);
  fs.mkdirSync(charDir, { recursive: true });
  fs.mkdirSync(npcDir, { recursive: true });
}

function addStatusAlive(data) {
  if (!data.status) {
    data.status = 'alive';
  }
  return data;
}

function copyDefaultsToDir(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return;
  const files = fs.readdirSync(sourceDir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(sourceDir, file), 'utf-8'));
    addStatusAlive(data);
    fs.writeFileSync(path.join(targetDir, file), JSON.stringify(data, null, 2));
  }
}

function provisionPlayerDefaults(dataDir, email) {
  ensurePlayerDataExists(dataDir, email);
  const charDir = getPlayerCharactersDir(dataDir, email);
  const npcDir = getPlayerNpcsDir(dataDir, email);
  const defaultChars = path.join(dataDir, 'defaults', 'characters');
  const defaultNpcs = path.join(dataDir, 'defaults', 'npcs');
  copyDefaultsToDir(defaultChars, charDir);
  copyDefaultsToDir(defaultNpcs, npcDir);
}

function resetPlayerData(dataDir, email, scope) {
  const charDir = getPlayerCharactersDir(dataDir, email);
  const npcDir = getPlayerNpcsDir(dataDir, email);
  const defaultChars = path.join(dataDir, 'defaults', 'characters');
  const defaultNpcs = path.join(dataDir, 'defaults', 'npcs');

  if (scope === 'all' || scope === 'characters') {
    // Remove existing character files
    if (fs.existsSync(charDir)) {
      for (const f of fs.readdirSync(charDir).filter(f => f.endsWith('.json'))) {
        fs.unlinkSync(path.join(charDir, f));
      }
    }
    if (scope === 'all' || scope === 'characters') {
      ensurePlayerDataExists(dataDir, email);
      copyDefaultsToDir(defaultChars, charDir);
    }
  }

  if (scope === 'all' || scope === 'npcs') {
    if (fs.existsSync(npcDir)) {
      for (const f of fs.readdirSync(npcDir).filter(f => f.endsWith('.json'))) {
        fs.unlinkSync(path.join(npcDir, f));
      }
    }
    if (scope === 'all' || scope === 'npcs') {
      ensurePlayerDataExists(dataDir, email);
      copyDefaultsToDir(defaultNpcs, npcDir);
    }
  }
}

function resetSingleEntity(dataDir, email, entityType, entityId) {
  const playerDir = entityType === 'character'
    ? getPlayerCharactersDir(dataDir, email)
    : getPlayerNpcsDir(dataDir, email);
  const defaultDir = entityType === 'character'
    ? path.join(dataDir, 'defaults', 'characters')
    : path.join(dataDir, 'defaults', 'npcs');

  if (!fs.existsSync(defaultDir)) {
    throw new Error(`Default ${entityType} directory not found`);
  }

  // Find the default file matching this entity ID
  const defaultFiles = fs.readdirSync(defaultDir).filter(f => f.endsWith('.json'));
  let matchedFile = null;
  for (const file of defaultFiles) {
    const data = JSON.parse(fs.readFileSync(path.join(defaultDir, file), 'utf-8'));
    if (data.id === entityId) {
      matchedFile = file;
      break;
    }
  }

  if (!matchedFile) {
    throw new Error(`No default found for ${entityType} with id ${entityId}`);
  }

  // Also check if the player has a file with this entity (could be under a different filename)
  ensurePlayerDataExists(dataDir, email);
  const playerFiles = fs.readdirSync(playerDir).filter(f => f.endsWith('.json'));
  for (const file of playerFiles) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(playerDir, file), 'utf-8'));
      if (data.id === entityId) {
        fs.unlinkSync(path.join(playerDir, file));
        break;
      }
    } catch {
      // skip malformed files
    }
  }

  // Copy default back
  const data = JSON.parse(fs.readFileSync(path.join(defaultDir, matchedFile), 'utf-8'));
  addStatusAlive(data);
  fs.writeFileSync(path.join(playerDir, matchedFile), JSON.stringify(data, null, 2));
}

module.exports = {
  emailToSlug,
  getPlayerDataDir,
  getPlayerCharactersDir,
  getPlayerNpcsDir,
  ensurePlayerDataExists,
  provisionPlayerDefaults,
  resetPlayerData,
  resetSingleEntity,
};
