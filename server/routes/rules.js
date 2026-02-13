const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function (dataDir) {
  const router = express.Router();
  const rulesDir = path.join(dataDir, 'rules');

  // GET list of available rule categories
  router.get('/', (req, res) => {
    try {
      const files = fs.readdirSync(rulesDir).filter(f => f.endsWith('.json'));
      const categories = files.map(f => f.replace('.json', ''));
      res.json(categories);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET specific rules category
  router.get('/:category', (req, res) => {
    try {
      const filePath = path.join(rulesDir, `${req.params.category}.json`);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: `Rule category '${req.params.category}' not found` });
      }
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
