const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function (dataDir) {
  const router = express.Router();
  const campaignDir = path.join(dataDir, 'campaigns');

  // GET all campaigns (summary view)
  router.get('/', (req, res) => {
    try {
      if (!fs.existsSync(campaignDir)) return res.json([]);
      const files = fs.readdirSync(campaignDir).filter(f => f.endsWith('.json'));
      const campaigns = files.map(f => {
        const data = JSON.parse(fs.readFileSync(path.join(campaignDir, f), 'utf-8'));
        return {
          id: data.id,
          title: data.title,
          subtitle: data.subtitle,
          type: data.type,
          levelRange: data.levelRange,
          estimatedSessions: data.estimatedSessions,
          synopsis: data.synopsis,
          hook: data.hook,
        };
      });
      res.json(campaigns);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET full campaign by id
  router.get('/:id', (req, res) => {
    try {
      if (!fs.existsSync(campaignDir)) return res.status(404).json({ error: 'Campaign not found' });
      const files = fs.readdirSync(campaignDir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        const data = JSON.parse(fs.readFileSync(path.join(campaignDir, f), 'utf-8'));
        if (data.id === req.params.id) {
          return res.json(data);
        }
      }
      res.status(404).json({ error: 'Campaign not found' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
