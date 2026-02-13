const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

module.exports = function (dataDir) {
  const router = express.Router();
  const charDir = path.join(dataDir, 'characters');

  function readAllCharacters() {
    const files = fs.readdirSync(charDir).filter(f => f.endsWith('.json'));
    return files.map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(charDir, f), 'utf-8'));
      data._filename = f;
      return data;
    });
  }

  // GET all characters
  router.get('/', (req, res) => {
    try {
      const characters = readAllCharacters();
      res.json(characters);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET single character by id
  router.get('/:id', (req, res) => {
    try {
      const characters = readAllCharacters();
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
      const characters = readAllCharacters();
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
      const characters = readAllCharacters();
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
