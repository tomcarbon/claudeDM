const fs = require('fs');
const path = require('path');

const DEFAULT_CAMPAIGN = 'demo';

function emailToSlug(email) {
  return String(email).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function getPlayerDataDir(dataDir, email) {
  return path.join(dataDir, 'players', emailToSlug(email));
}

function getPlayerCampaignDir(dataDir, email, campaignId) {
  return path.join(getPlayerDataDir(dataDir, email), campaignId || DEFAULT_CAMPAIGN);
}

function getPlayerCharactersDir(dataDir, email, campaignId) {
  return path.join(getPlayerCampaignDir(dataDir, email, campaignId), 'characters');
}

function getPlayerNpcsDir(dataDir, email, campaignId) {
  return path.join(getPlayerCampaignDir(dataDir, email, campaignId), 'npcs');
}

function getPlayerSessionsDir(dataDir, email, campaignId) {
  return path.join(getPlayerCampaignDir(dataDir, email, campaignId), 'sessions');
}

function ensurePlayerDataExists(dataDir, email, campaignId) {
  const charDir = getPlayerCharactersDir(dataDir, email, campaignId);
  const npcDir = getPlayerNpcsDir(dataDir, email, campaignId);
  const sessDir = getPlayerSessionsDir(dataDir, email, campaignId);
  fs.mkdirSync(charDir, { recursive: true });
  fs.mkdirSync(npcDir, { recursive: true });
  fs.mkdirSync(sessDir, { recursive: true });
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

function getAvailableCampaigns(dataDir) {
  const campaignsDir = path.join(dataDir, 'campaigns');
  if (!fs.existsSync(campaignsDir)) return [DEFAULT_CAMPAIGN];
  return fs.readdirSync(campaignsDir).filter(d => {
    const stat = fs.statSync(path.join(campaignsDir, d));
    return stat.isDirectory();
  });
}

function provisionPlayerDefaults(dataDir, email, campaignId) {
  const cid = campaignId || DEFAULT_CAMPAIGN;
  ensurePlayerDataExists(dataDir, email, cid);
  const charDir = getPlayerCharactersDir(dataDir, email, cid);
  const npcDir = getPlayerNpcsDir(dataDir, email, cid);
  const defaultChars = path.join(dataDir, 'defaults', cid, 'characters');
  const defaultNpcs = path.join(dataDir, 'defaults', cid, 'npcs');
  copyDefaultsToDir(defaultChars, charDir);
  copyDefaultsToDir(defaultNpcs, npcDir);
}

function provisionAllCampaignDefaults(dataDir, email) {
  const campaigns = getAvailableCampaigns(dataDir);
  for (const cid of campaigns) {
    provisionPlayerDefaults(dataDir, email, cid);
  }
}

function resetPlayerData(dataDir, email, scope, campaignId) {
  const cid = campaignId || DEFAULT_CAMPAIGN;
  const charDir = getPlayerCharactersDir(dataDir, email, cid);
  const npcDir = getPlayerNpcsDir(dataDir, email, cid);
  const defaultChars = path.join(dataDir, 'defaults', cid, 'characters');
  const defaultNpcs = path.join(dataDir, 'defaults', cid, 'npcs');

  if (scope === 'all' || scope === 'characters') {
    if (fs.existsSync(charDir)) {
      for (const f of fs.readdirSync(charDir).filter(f => f.endsWith('.json'))) {
        fs.unlinkSync(path.join(charDir, f));
      }
    }
    ensurePlayerDataExists(dataDir, email, cid);
    copyDefaultsToDir(defaultChars, charDir);
  }

  if (scope === 'all' || scope === 'npcs') {
    if (fs.existsSync(npcDir)) {
      for (const f of fs.readdirSync(npcDir).filter(f => f.endsWith('.json'))) {
        fs.unlinkSync(path.join(npcDir, f));
      }
    }
    ensurePlayerDataExists(dataDir, email, cid);
    copyDefaultsToDir(defaultNpcs, npcDir);
  }
}

function resetSingleEntity(dataDir, email, entityType, entityId, campaignId) {
  const cid = campaignId || DEFAULT_CAMPAIGN;
  const playerDir = entityType === 'character'
    ? getPlayerCharactersDir(dataDir, email, cid)
    : getPlayerNpcsDir(dataDir, email, cid);
  const defaultDir = entityType === 'character'
    ? path.join(dataDir, 'defaults', cid, 'characters')
    : path.join(dataDir, 'defaults', cid, 'npcs');

  if (!fs.existsSync(defaultDir)) {
    throw new Error(`Default ${entityType} directory not found`);
  }

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

  ensurePlayerDataExists(dataDir, email, cid);
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

  const data = JSON.parse(fs.readFileSync(path.join(defaultDir, matchedFile), 'utf-8'));
  addStatusAlive(data);
  fs.writeFileSync(path.join(playerDir, matchedFile), JSON.stringify(data, null, 2));
}

module.exports = {
  DEFAULT_CAMPAIGN,
  emailToSlug,
  getPlayerDataDir,
  getPlayerCampaignDir,
  getPlayerCharactersDir,
  getPlayerNpcsDir,
  getPlayerSessionsDir,
  ensurePlayerDataExists,
  getAvailableCampaigns,
  provisionPlayerDefaults,
  provisionAllCampaignDefaults,
  resetPlayerData,
  resetSingleEntity,
};
