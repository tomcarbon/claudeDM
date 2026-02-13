const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function (dataDir) {
  const router = express.Router();
  const scenarioDir = path.join(dataDir, 'scenarios');

  // GET all scenarios (summary view)
  router.get('/', (req, res) => {
    try {
      const files = fs.readdirSync(scenarioDir).filter(f => f.endsWith('.json'));
      const scenarios = files.map(f => {
        const data = JSON.parse(fs.readFileSync(path.join(scenarioDir, f), 'utf-8'));
        return {
          id: data.id,
          title: data.title,
          subtitle: data.subtitle,
          levelRange: data.levelRange,
          estimatedSessions: data.estimatedSessions,
          synopsis: data.synopsis,
          hook: data.hook,
        };
      });
      res.json(scenarios);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET full scenario by id
  router.get('/:id', (req, res) => {
    try {
      const files = fs.readdirSync(scenarioDir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        const data = JSON.parse(fs.readFileSync(path.join(scenarioDir, f), 'utf-8'));
        if (data.id === req.params.id) {
          return res.json(data);
        }
      }
      res.status(404).json({ error: 'Scenario not found' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
