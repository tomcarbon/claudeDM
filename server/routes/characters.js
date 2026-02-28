const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { awardXp } = require('../xp-utils');
const { requirePlayer } = require('../player-auth');
const { getPlayerCharactersDir, ensurePlayerDataExists } = require('../player-data');

function validateCharacter(data) {
  const errors = [];

  for (const field of ['name', 'race', 'class']) {
    if (typeof data[field] !== 'string' || !data[field].trim()) {
      errors.push(`${field} is required and must be a non-empty string`);
    }
  }

  if (typeof data.level !== 'number' || data.level < 1 || data.level > 20) {
    errors.push('level is required and must be a number between 1 and 20');
  }

  const abilityNames = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
  if (typeof data.abilities !== 'object' || data.abilities === null) {
    errors.push('abilities is required and must be an object');
  } else {
    for (const stat of abilityNames) {
      const a = data.abilities[stat];
      if (!a || typeof a !== 'object') {
        errors.push(`abilities.${stat} is required and must be an object`);
      } else {
        if (typeof a.score !== 'number') errors.push(`abilities.${stat}.score must be a number`);
        if (typeof a.modifier !== 'number') errors.push(`abilities.${stat}.modifier must be a number`);
      }
    }
  }

  if (typeof data.hitPoints !== 'object' || data.hitPoints === null) {
    errors.push('hitPoints is required and must be an object');
  } else {
    if (typeof data.hitPoints.max !== 'number') errors.push('hitPoints.max must be a number');
    if (typeof data.hitPoints.current !== 'number') errors.push('hitPoints.current must be a number');
  }

  if (typeof data.armorClass !== 'number') {
    errors.push('armorClass is required and must be a number');
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

module.exports = function (dataDir) {
  const router = express.Router();
  const playerAuth = requirePlayer(dataDir);

  // Apply auth to all routes
  router.use(playerAuth);

  function getCharDir(req) {
    const dir = getPlayerCharactersDir(dataDir, req.player.email);
    ensurePlayerDataExists(dataDir, req.player.email);
    return dir;
  }

  function readAllCharacters(req) {
    const charDir = getCharDir(req);
    const files = fs.readdirSync(charDir).filter(f => f.endsWith('.json'));
    return files.reduce((chars, f) => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(charDir, f), 'utf-8'));
        data._filename = f;
        chars.push(data);
      } catch (err) {
        console.error(`Skipping ${f}: invalid JSON — ${err.message}`);
      }
      return chars;
    }, []);
  }

  // GET all characters
  router.get('/', (req, res) => {
    try {
      const characters = readAllCharacters(req);
      res.json(characters);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST import character (must be before /:id)
  router.post('/import', (req, res) => {
    try {
      const charDir = getCharDir(req);
      const data = { ...req.body };
      const result = validateCharacter(data);
      if (!result.valid) {
        return res.status(400).json({ error: 'Validation failed', errors: result.errors });
      }
      delete data.id;
      delete data._filename;
      data.id = uuidv4();
      const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const filename = `${slug}.json`;
      fs.writeFileSync(path.join(charDir, filename), JSON.stringify(data, null, 2));
      res.status(201).json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST award XP to a character (must be before /:id)
  router.post('/:id/award-xp', (req, res) => {
    try {
      const { xp } = req.body;
      if (typeof xp !== 'number' || xp <= 0) {
        return res.status(400).json({ error: 'xp must be a positive number' });
      }
      const result = awardXp(dataDir, req.params.id, xp, req.player.email);
      res.json(result);
    } catch (err) {
      if (err.message.startsWith('Character not found')) {
        return res.status(404).json({ error: err.message });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // GET single character by id
  router.get('/:id', (req, res) => {
    try {
      const characters = readAllCharacters(req);
      const char = characters.find(c => c.id === req.params.id);
      if (!char) return res.status(404).json({ error: 'Character not found' });
      res.json(char);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST create new character
  router.post('/', (req, res) => {
    try {
      const charDir = getCharDir(req);
      const char = { ...req.body, id: uuidv4() };
      const slug = char.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const filename = `${slug}.json`;
      fs.writeFileSync(path.join(charDir, filename), JSON.stringify(char, null, 2));
      res.status(201).json(char);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT update character
  router.put('/:id', (req, res) => {
    try {
      const charDir = getCharDir(req);
      const characters = readAllCharacters(req);
      const char = characters.find(c => c.id === req.params.id);
      if (!char) return res.status(404).json({ error: 'Character not found' });

      const updated = { ...req.body, id: char.id };
      const filename = char._filename;
      delete updated._filename;
      fs.writeFileSync(path.join(charDir, filename), JSON.stringify(updated, null, 2));
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE character
  router.delete('/:id', (req, res) => {
    try {
      const charDir = getCharDir(req);
      const characters = readAllCharacters(req);
      const char = characters.find(c => c.id === req.params.id);
      if (!char) return res.status(404).json({ error: 'Character not found' });

      fs.unlinkSync(path.join(charDir, char._filename));
      res.json({ message: 'Character deleted' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
