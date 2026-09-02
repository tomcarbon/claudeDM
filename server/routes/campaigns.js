const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getAuthenticatedPlayer } = require('../player-auth');
const { findReadyAsset, resolveAssetFile, contentTypeFor } = require('../asset-manifest');

function readCampaignEntries(campaignDir) {
  if (!fs.existsSync(campaignDir)) return [];
  const entries = [];
  // Scan subdirectories for campaign.json files (new structure)
  const subdirs = fs.readdirSync(campaignDir).filter(d => {
    try { return fs.statSync(path.join(campaignDir, d)).isDirectory(); } catch { return false; }
  });
  for (const dir of subdirs) {
    const campaignFile = path.join(campaignDir, dir, 'campaign.json');
    if (fs.existsSync(campaignFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(campaignFile, 'utf-8'));
        entries.push({ filePath: campaignFile, data });
      } catch (err) {
        console.error(`[Campaigns] Failed to parse ${dir}/campaign.json:`, err.message);
      }
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

  // GET/HEAD one campaign asset by ID.
  //
  // Scene imagery — docs/adr/0002-scene-imagery.md §5. This route resolves an **id** to bytes by
  // looking it up in that campaign's assets.json. It never treats the id as a path, and it never
  // falls back to doing so. It is deliberately NOT express.static over data/: that tree holds
  // players.json, every player library and every session transcript.
  //
  // The campaign id is in the path rather than the X-Campaign-Id header the rest of the client
  // sends, because an <img src> cannot carry a custom header.
  //
  // Authorisation matches GET /api/campaigns/:id, which already serves unauthenticated callers.
  // Campaign art is the same class of content as the campaign synopsis. (ADR §5, §10.5 — VP Cyber
  // Security has not yet ruled; if they want requirePlayer here it is one middleware.)
  //
  // Unknown campaign and unknown asset are indistinguishable: same status, same body, so the route
  // does not enumerate what exists.
  function assetNotFound(res) {
    return res.status(404).json({ error: 'Unknown asset' });
  }

  router.get('/:campaignId/assets/:assetId', (req, res) => {
    try {
      const cid = sanitizeCampaignId(req.params.campaignId);
      if (!cid) return assetNotFound(res);

      // Exact string equality against the manifest. Unknown, `specified` and malformed entries
      // are all equally not-found.
      const entry = findReadyAsset(dataDir, cid, req.params.assetId);
      if (!entry) return assetNotFound(res);

      // entry.file has already been validated as a bare filename with an allowed extension;
      // resolveAssetFile re-asserts containment (and symlink containment) before returning a path.
      const resolved = resolveAssetFile(dataDir, cid, entry);
      if (!resolved) return assetNotFound(res);

      const contentType = contentTypeFor(resolved.filename);
      if (!contentType) return assetNotFound(res);

      res.set('Content-Type', contentType);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cache-Control', 'public, max-age=3600');
      // Explicit root: sendFile resolves the (relative) filename against it and refuses to escape.
      res.sendFile(resolved.filename, { root: resolved.root, dotfiles: 'deny' }, (err) => {
        if (err && !res.headersSent) assetNotFound(res);
      });
    } catch (err) {
      console.error('[Assets] Failed to serve asset:', err.message);
      if (!res.headersSent) assetNotFound(res);
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
