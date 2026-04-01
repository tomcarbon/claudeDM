const express = require('express');
const fs = require('fs');
const path = require('path');

function getDateString(date = new Date()) {
  return date.toISOString().split('T')[0];
}

function loadChatFile(chatDir, dateStr) {
  const filePath = path.join(chatDir, `${dateStr}.json`);
  if (!fs.existsSync(filePath)) return { date: dateStr, messages: [] };
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { date: dateStr, messages: [] };
  }
}

function appendChatMessage(chatDir, message) {
  if (!fs.existsSync(chatDir)) fs.mkdirSync(chatDir, { recursive: true });
  const dateStr = getDateString(new Date(message.timestamp || Date.now()));
  const filePath = path.join(chatDir, `${dateStr}.json`);
  const data = loadChatFile(chatDir, dateStr);
  data.messages.push(message);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

module.exports = function createChatRouter(dataDir) {
  const chatDir = path.join(dataDir, 'chat');
  const router = express.Router();

  // GET /api/chat/dates — list available days, newest first
  router.get('/dates', (req, res) => {
    if (!fs.existsSync(chatDir)) return res.json([]);
    try {
      const files = fs.readdirSync(chatDir)
        .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .map(f => f.replace('.json', ''))
        .sort()
        .reverse();
      res.json(files);
    } catch {
      res.json([]);
    }
  });

  // GET /api/chat/recent?days=3 — get messages from the last N days (default 3), merged and sorted
  router.get('/recent', (req, res) => {
    const days = Math.max(1, Math.min(30, parseInt(req.query.days, 10) || 3));
    const allMessages = [];
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const data = loadChatFile(chatDir, getDateString(d));
      if (data.messages && data.messages.length > 0) {
        allMessages.push(...data.messages);
      }
    }
    // Sort by timestamp ascending
    allMessages.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
    res.json({ messages: allMessages });
  });

  // GET /api/chat?date=YYYY-MM-DD — get messages for a day (defaults to today)
  router.get('/', (req, res) => {
    const dateStr = req.query.date || getDateString();
    const data = loadChatFile(chatDir, dateStr);
    res.json(data);
  });

  return {
    router,
    appendMessage: (message) => appendChatMessage(chatDir, message),
  };
};
