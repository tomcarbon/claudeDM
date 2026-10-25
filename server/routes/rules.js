const express = require('express');
const fs = require('fs');
const path = require('path');
const { listCategories, getCategory, isKnownCategory } = require('../game-categories');

// Rule-file names are a closed vocabulary: lowercase words and dashes. The name used to be joined
// into a path unchecked, and Express decodes %2F inside a route parameter, so
// GET /api/rules/..%2Fplayers read data/players.json — every account record (WO-0040).
const SAFE_RULE_NAME = /^[a-z0-9][a-z0-9-]*$/;

module.exports = function (dataDir) {
  const router = express.Router();

  // Which ruleset a request means: `?set=<category id>`, else Fantasy. An unknown set is a 404
  // rather than a silent fallback, so a typo in the client cannot show the wrong rules.
  function resolveSet(req, res) {
    const requested = req.query.set;
    if (requested === undefined || requested === '') return getCategory(null);
    if (typeof requested !== 'string' || !isKnownCategory(requested)) {
      res.status(404).json({ error: `Unknown ruleset '${String(requested)}'` });
      return null;
    }
    return getCategory(requested);
  }

  function rulesDirOf(category) {
    return path.join(dataDir, category.rulesDir);
  }

  // GET the rulesets: [{ id, label }]. Declared before '/:category' so it is not read as a file name.
  router.get('/sets', (req, res) => {
    res.json(listCategories());
  });

  // GET list of available rule categories (file names) in one ruleset
  router.get('/', (req, res) => {
    try {
      const category = resolveSet(req, res);
      if (!category) return;
      const files = fs.readdirSync(rulesDirOf(category)).filter(f => f.endsWith('.json'));
      const categories = files.map(f => f.replace('.json', ''));
      res.json(categories);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET specific rules category
  router.get('/:category', (req, res) => {
    try {
      const category = resolveSet(req, res);
      if (!category) return;
      const name = req.params.category;
      if (!SAFE_RULE_NAME.test(name)) {
        return res.status(404).json({ error: `Rule category '${name}' not found` });
      }
      const filePath = path.join(rulesDirOf(category), `${name}.json`);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: `Rule category '${name}' not found` });
      }
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
