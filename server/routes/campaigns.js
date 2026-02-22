const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getAuthenticatedPlayer } = require('../player-auth');

function readCampaignEntries(campaignDir) {
  if (!fs.existsSync(campaignDir)) return [];
  const files = fs.readdirSync(campaignDir).filter(f => f.endsWith('.json'));
  const entries = [];
  for (const file of files) {
    const filePath = path.join(campaignDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      entries.push({ filePath, data });
    } catch (err) {
      console.error(`[Campaigns] Failed to parse ${file}:`, err.message);
    }
  }
  return entries;
}

function findCampaignById(campaignDir, campaignId) {
  const entries = readCampaignEntries(campaignDir);
  return entries.find(entry => entry.data.id === campaignId) || null;
}

function getOwnerEmail(campaign) {
  const value = campaign.ownerEmail || campaign.playerEmail || null;
  return value ? String(value).trim().toLowerCase() : null;
}

function canWriteCampaign(campaign, requester) {
  if (!requester) return false;
  const ownerEmail = getOwnerEmail(campaign);
  return !!ownerEmail && requester.email === ownerEmail;
}

function withCampaignAccess(campaign, requester) {
  const ownerEmail = getOwnerEmail(campaign);
  const ownerName = campaign.ownerName || campaign.playerName || null;
  const canWrite = canWriteCampaign(campaign, requester);
  return {
    ...campaign,
    ownerEmail,
    ownerName,
    canWrite,
    readOnly: !canWrite,
  };
}

function summarizeCampaign(campaign, requester) {
  const ownerEmail = getOwnerEmail(campaign);
  const ownerName = campaign.ownerName || campaign.playerName || null;
  const canWrite = canWriteCampaign(campaign, requester);
  return {
    id: campaign.id,
    title: campaign.title,
    subtitle: campaign.subtitle,
    type: campaign.type,
    levelRange: campaign.levelRange,
    estimatedSessions: campaign.estimatedSessions,
    synopsis: campaign.synopsis,
    hook: campaign.hook,
    ownerEmail,
    ownerName,
    canWrite,
    readOnly: !canWrite,
  };
}

function sanitizeCampaignId(value) {
  const cleaned = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned || null;
}

module.exports = function (dataDir) {
  const router = express.Router();
  const campaignDir = path.join(dataDir, 'campaigns');

  // GET all campaigns (summary view)
  router.get('/', (req, res) => {
    try {
      const requester = getAuthenticatedPlayer(dataDir, req);
      const campaigns = readCampaignEntries(campaignDir)
        .map(entry => summarizeCampaign(entry.data, requester));
      res.json(campaigns);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET full campaign by id
  router.get('/:id', (req, res) => {
    try {
      const requester = getAuthenticatedPlayer(dataDir, req);
      const campaign = findCampaignById(campaignDir, req.params.id);
      if (campaign) {
        return res.json(withCampaignAccess(campaign.data, requester));
      }
      res.status(404).json({ error: 'Campaign not found' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST create campaign
  router.post('/', (req, res) => {
    try {
      const requester = getAuthenticatedPlayer(dataDir, req);
      if (!requester) {
        return res.status(403).json({ error: 'Login required. Guests cannot create campaigns.' });
      }
      if (!fs.existsSync(campaignDir)) {
        fs.mkdirSync(campaignDir, { recursive: true });
      }

      const requestedId = sanitizeCampaignId(req.body?.id);
      const id = requestedId || uuidv4();
      if (findCampaignById(campaignDir, id)) {
        return res.status(409).json({ error: 'Campaign id already exists.' });
      }

      const now = new Date().toISOString();
      const campaign = {
        ...req.body,
        id,
        ownerEmail: requester.email,
        ownerName: requester.name,
        createdAt: now,
        updatedAt: now,
      };
      fs.writeFileSync(path.join(campaignDir, `${id}.json`), JSON.stringify(campaign, null, 2));
      res.status(201).json(withCampaignAccess(campaign, requester));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT update campaign
  router.put('/:id', (req, res) => {
    try {
      const requester = getAuthenticatedPlayer(dataDir, req);
      if (!requester) {
        return res.status(403).json({ error: 'Login required. Guests cannot modify campaigns.' });
      }

      const entry = findCampaignById(campaignDir, req.params.id);
      if (!entry) {
        return res.status(404).json({ error: 'Campaign not found' });
      }
      if (!canWriteCampaign(entry.data, requester)) {
        return res.status(403).json({ error: 'Only the campaign creator can modify this campaign.' });
      }

      const payload = { ...req.body };
      delete payload.id;
      delete payload.ownerEmail;
      delete payload.ownerName;
      delete payload.createdAt;
      delete payload.updatedAt;

      const updated = {
        ...entry.data,
        ...payload,
        id: entry.data.id,
        ownerEmail: getOwnerEmail(entry.data) || requester.email,
        ownerName: entry.data.ownerName || requester.name,
        createdAt: entry.data.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(entry.filePath, JSON.stringify(updated, null, 2));
      res.json(withCampaignAccess(updated, requester));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE campaign
  router.delete('/:id', (req, res) => {
    try {
      const requester = getAuthenticatedPlayer(dataDir, req);
      if (!requester) {
        return res.status(403).json({ error: 'Login required. Guests cannot delete campaigns.' });
      }

      const entry = findCampaignById(campaignDir, req.params.id);
      if (!entry) {
        return res.status(404).json({ error: 'Campaign not found' });
      }
      if (!canWriteCampaign(entry.data, requester)) {
        return res.status(403).json({ error: 'Only the campaign creator can delete this campaign.' });
      }

      fs.unlinkSync(entry.filePath);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
