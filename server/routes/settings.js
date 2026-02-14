const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function (dataDir) {
  const router = express.Router();
  const defaultsDir = path.join(dataDir, 'defaults');

  const SCOPES = ['characters', 'npcs', 'scenarios', 'dm-settings'];

  function copyDir(src, dest) {
    const files = fs.readdirSync(src);
    for (const file of files) {
      fs.copyFileSync(path.join(src, file), path.join(dest, file));
    }
  }

  // POST /api/settings/restore-defaults
  router.post('/restore-defaults', (req, res) => {
    try {
      const scopeParam = req.query.scope;
      const scopes = scopeParam
        ? scopeParam.split(',').filter(s => SCOPES.includes(s))
        : SCOPES;

      const restored = [];

      for (const scope of scopes) {
        if (scope === 'dm-settings') {
          fs.copyFileSync(
            path.join(defaultsDir, 'dm-settings.json'),
            path.join(dataDir, 'dm-settings.json')
          );
        } else {
          copyDir(
            path.join(defaultsDir, scope),
            path.join(dataDir, scope)
          );
        }
        restored.push(scope);
      }

      res.json({ restored });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
