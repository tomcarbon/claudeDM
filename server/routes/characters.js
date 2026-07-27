const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { awardXp } = require('../xp-utils');
const { requirePlayer } = require('../player-auth');
const { getPlayerCharactersDir, getSessionCharactersDir, ensurePlayerDataExists, provisionPlayerDefaults } = require('../player-data');
const { generateRandomCharacter, getCharacterOptions } = require('../character-generator');
const { readJsonDirWithRecovery, writeJsonAtomic } = require('../json-recovery');
const { slugify } = require('../entity-resolver');

const MAX_CHARACTERS = 100;

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
    // If an active session is specified, read from session-scoped directory
    const sessionId = req.get('x-session-id');
    if (sessionId) {
      const sessDir = getSessionCharactersDir(dataDir, sessionId);
      if (fs.existsSync(sessDir)) return sessDir;
      // Fall through to player library if session dir doesn't exist
    }
    provisionPlayerDefaults(dataDir, req.player.email, req.campaignId);
    return getPlayerCharactersDir(dataDir, req.player.email, req.campaignId);
  }

  // Always returns the player's main character directory (ignores session context).
  // Used for creating/importing/rolling characters — these are canonical, not session-scoped.
  function getPlayerCharDir(req) {
    provisionPlayerDefaults(dataDir, req.player.email, req.campaignId);
    return getPlayerCharactersDir(dataDir, req.player.email, req.campaignId);
  }

  function getRecoveryDirs(req) {
    const cid = req.campaignId || 'demo';
    const defaultChars = path.join(dataDir, 'defaults', cid, 'characters');
    const sessionId = req.get('x-session-id');
    if (sessionId) {
      // Session context: recover from player library, then defaults
      const playerChars = getPlayerCharactersDir(dataDir, req.player.email, cid);
      return [playerChars, defaultChars];
    }
    // Player library context: recover from defaults only
    return [defaultChars];
  }

  function readAllCharacters(req) {
    const charDir = getCharDir(req);
    const recoveryDirs = getRecoveryDirs(req);
    return readJsonDirWithRecovery(charDir, recoveryDirs);
  }

  // GET all characters
  router.get('/', (req, res) => {
    try {
      const { items: characters, warnings } = readAllCharacters(req);
      if (warnings.length > 0) {
        res.json({ characters, warnings });
      } else {
        res.json(characters);
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST import character (must be before /:id)
  router.post('/import', (req, res) => {
    try {
      const charDir = getPlayerCharDir(req);
      const { items: characters } = readAllCharacters(req);
      if (characters.length >= MAX_CHARACTERS) {
        return res.status(400).json({ error: `Maximum of ${MAX_CHARACTERS} characters reached. Delete a character to make room.` });
      }
      const data = { ...req.body };
      const result = validateCharacter(data);
      if (!result.valid) {
        return res.status(400).json({ error: 'Validation failed', errors: result.errors });
      }
      delete data.id;
      delete data._filename;
      data.id = uuidv4();
      const slug = slugify(data.name);
      const filename = `${slug}.json`;
      const destPath = path.join(charDir, filename);

      // Check for filename collision (same character name already exists)
      if (fs.existsSync(destPath) && !req.query.overwrite) {
        const existing = JSON.parse(fs.readFileSync(destPath, 'utf-8'));
        return res.status(409).json({
          error: 'conflict',
          message: `A character named "${existing.name}" already exists. Overwrite it?`,
          existingName: existing.name,
          existingLevel: existing.level,
        });
      }

      writeJsonAtomic(destPath, data);
      res.status(201).json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET character creation options (races, classes, backgrounds, alignments)
  router.get('/options', (req, res) => {
    try {
      res.json(getCharacterOptions(dataDir));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST preview a character (generate without saving)
  router.post('/preview', (req, res) => {
    try {
      const options = { ...req.body, campaignId: req.campaignId };
      const character = generateRandomCharacter(dataDir, options);
      res.json(character);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST roll/create a character (generate and save)
  router.post('/roll', (req, res) => {
    try {
      const charDir = getPlayerCharDir(req);
      const { items: characters } = readAllCharacters(req);
      if (characters.length >= MAX_CHARACTERS) {
        return res.status(400).json({ error: `Maximum of ${MAX_CHARACTERS} characters reached. Delete a character to make room.` });
      }
      const options = { ...req.body, campaignId: req.campaignId };
      const character = generateRandomCharacter(dataDir, options);
      const slug = slugify(character.name);
      let filename = `${slug}.json`;
      // Avoid filename collisions
      if (fs.existsSync(path.join(charDir, filename))) {
        filename = `${slug}-${Date.now()}.json`;
      }
      writeJsonAtomic(path.join(charDir, filename), character);
      res.status(201).json(character);
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
      const sessionId = req.get('x-session-id') || undefined;
      const result = awardXp(dataDir, req.params.id, xp, req.player.email, req.campaignId, sessionId);
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
      const { items: characters } = readAllCharacters(req);
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
      const charDir = getPlayerCharDir(req);
      const { items: characters } = readAllCharacters(req);
      if (characters.length >= MAX_CHARACTERS) {
        return res.status(400).json({ error: `Maximum of ${MAX_CHARACTERS} characters reached. Delete a character to make room.` });
      }
      const char = { ...req.body, id: uuidv4() };
      const slug = slugify(char.name);
      const filename = `${slug}.json`;
      writeJsonAtomic(path.join(charDir, filename), char);
      res.status(201).json(char);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT update character
  router.put('/:id', (req, res) => {
    try {
      const charDir = getCharDir(req);
      const { items: characters } = readAllCharacters(req);
      const char = characters.find(c => c.id === req.params.id);
      if (!char) return res.status(404).json({ error: 'Character not found' });

      const updated = { ...req.body, id: char.id };
      const filename = char._filename;
      delete updated._filename;
      writeJsonAtomic(path.join(charDir, filename), updated);
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE character
  router.delete('/:id', (req, res) => {
    try {
      const charDir = getCharDir(req);
      const { items: characters } = readAllCharacters(req);
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
