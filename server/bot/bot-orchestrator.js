const fs = require('fs');
const path = require('path');
const { setDesiredBotCount, listBotAccounts, deleteAllBotAccounts } = require('./bot-accounts');
const { BotApiClient } = require('./bot-api-client');
const { BotWebSocketClient } = require('./bot-ws-client');
const { decideBotAction, generateTurnText } = require('./bot-brain');
const { getAvailableCampaigns } = require('../player-data');

// Canned chat responses when a player mentions a bot by name
const BOT_CHAT_RESPONSES = [
  'Hey! What\'s up?',
  'You called?',
  'At your service!',
  'Did someone say my name?',
  'Present and accounted for!',
  'What can I do for you?',
  'I\'m here! Just between adventures.',
  'Reporting in!',
  'Oh hey! I was just about to head into a dungeon.',
  'What\'s the word?',
  'Hail, adventurer!',
  'I\'m listening...',
  'That\'s me! Need something?',
  'Always happy to chat between sessions.',
  'You rang?',
];

const CONFIG_FILE = 'bot-config.json';
const DEFAULT_CONFIG = {
  enabled: false,
  count: 0,
  turnDelayMs: 60000,
  maxConcurrentApiCalls: 3,
  maxSessionsPerBot: 1,
};

/**
 * A single session slot — one WS connection, one game.
 */
function createSessionSlot(sessionId, opts) {
  return {
    sessionId,
    sessionLabel: opts.label || null,
    campaignId: opts.campaignId,
    characterId: opts.characterId || null,
    scenarioId: opts.scenarioId || null,
    character: opts.character || null,
    role: opts.role || 'host', // 'host' | 'companion'
    companionNpcId: opts.companionNpcId || null,
    state: 'idle', // idle | waiting_for_dm | playing | thinking
    ws: null,      // dedicated BotWebSocketClient for this session
    recentMessages: [],      // last 20 messages for LLM context
    allMessages: [],         // full history for persistence
    claudeSessionId: null,
    tickTimer: null,
  };
}

class BotOrchestrator {
  constructor(dataDir, port = 3001) {
    this.dataDir = dataDir;
    this.port = port;
    this.bots = new Map(); // email -> BotInstance
    this.config = { ...DEFAULT_CONFIG };
    this._activeApiCalls = 0;
    this._apiQueue = [];
    this._lookupTimers = new Map(); // email -> timer for session-finding ticks
    this._running = false;
  }

  // -- Config persistence --

  _configPath() {
    return path.join(this.dataDir, CONFIG_FILE);
  }

  loadConfig() {
    try {
      if (fs.existsSync(this._configPath())) {
        const data = JSON.parse(fs.readFileSync(this._configPath(), 'utf-8'));
        this.config = { ...DEFAULT_CONFIG, ...data };
      }
    } catch (err) {
      console.error('[BotOrchestrator] Config load error:', err.message);
    }
    return this.config;
  }

  saveConfig() {
    fs.writeFileSync(this._configPath(), JSON.stringify(this.config, null, 2));
  }

  // -- API call rate limiting --

  async _acquireApiSlot() {
    if (this._activeApiCalls < this.config.maxConcurrentApiCalls) {
      this._activeApiCalls++;
      return;
    }
    return new Promise(resolve => {
      this._apiQueue.push(resolve);
    });
  }

  _releaseApiSlot() {
    this._activeApiCalls--;
    if (this._apiQueue.length > 0) {
      this._activeApiCalls++;
      const next = this._apiQueue.shift();
      next();
    }
  }

  async _withApiSlot(fn) {
    await this._acquireApiSlot();
    try {
      return await fn();
    } finally {
      this._releaseApiSlot();
    }
  }

  // -- Bot lifecycle --

  async start() {
    this.loadConfig();
    if (!this.config.enabled) {
      console.log('[BotOrchestrator] Bot farm is disabled.');
      return;
    }
    console.log(`[BotOrchestrator] Starting bot farm — ${this.config.count} bots, ${this.config.turnDelayMs}ms delay, max ${this.config.maxSessionsPerBot} sessions/bot`);
    this._running = true;

    setDesiredBotCount(this.dataDir, this.config.count);
    const accounts = listBotAccounts(this.dataDir);

    for (const account of accounts) {
      this._startBot(account);
    }
  }

  _startBot(account) {
    if (this.bots.has(account.email)) return;

    const bot = {
      email: account.email,
      name: account.name,
      api: new BotApiClient({ email: account.email, port: this.port }),
      // Chat-only WS connection (not used for game sessions)
      chatWs: new BotWebSocketClient({ email: account.email, name: account.name, port: this.port }),
      sessions: new Map(), // sessionId -> SessionSlot
      lastActionTime: null,
    };

    // Wire up chat WS — only for chat and presence
    bot.chatWs.on('connected', () => {
      console.log(`[Bot:${bot.name}] Chat WS connected`);
      bot.chatWs.joinChat('global');
    });

    bot.chatWs.on('error', (msg) => {
      console.error(`[Bot:${bot.name}] Chat WS error:`, msg.error);
    });

    // Respond in chat when someone mentions this bot's name
    bot.chatWs.on('chat_message', (msg) => {
      if (!msg.text || msg.playerEmail === bot.email) return;
      if (msg.playerEmail?.endsWith('@bot.local')) return;
      const text = msg.text.toLowerCase();
      const botNameLower = bot.name.toLowerCase();
      const shortName = botNameLower.replace('bot_', '');
      if (text.includes(botNameLower) || text.includes(shortName)) {
        const delay = 1000 + Math.random() * 2000;
        setTimeout(() => {
          if (bot.chatWs.connected) {
            const response = BOT_CHAT_RESPONSES[Math.floor(Math.random() * BOT_CHAT_RESPONSES.length)];
            bot.chatWs.sendChat(response);
          }
        }, delay);
      }
    });

    bot.chatWs.connect();
    this.bots.set(account.email, bot);

    // Start the lookup loop — first tick fires quickly (3-8s), then normal cadence
    this._scheduleLookup(bot, true);
    console.log(`[BotOrchestrator] Started bot: ${bot.name}`);
  }

  // -- Session slot management --

  _wireSessionSlot(bot, slot) {
    const ws = new BotWebSocketClient({ email: bot.email, name: bot.name, port: this.port });
    slot.ws = ws;

    ws.on('connected', () => {
      console.log(`[Bot:${bot.name}] Session WS connected for ${slot.sessionId}`);
    });

    ws.on('dm_complete', (msg) => {
      if (slot.state === 'waiting_for_dm') {
        slot.state = 'playing';
      }
      // Save session to disk
      bot.api.updateSession(slot.campaignId, slot.sessionId, {
        messages: slot.allMessages,
        claudeSessionId: slot.claudeSessionId || msg.sessionId || null,
      }).catch(err => {
        console.error(`[Bot:${bot.name}] Session save error (${slot.sessionId}):`, err.message);
      });
    });

    ws.on('session_id', (msg) => {
      if (msg.sessionId) slot.claudeSessionId = msg.sessionId;
    });

    ws.on('dm_response', (msg) => {
      if (msg.text) {
        slot.recentMessages.push({ type: 'dm', text: msg.text });
        slot.allMessages.push({ type: 'dm', text: msg.text, timestamp: new Date().toISOString() });
        if (slot.recentMessages.length > 20) {
          slot.recentMessages = slot.recentMessages.slice(-20);
        }
      }
    });

    ws.on('dice_roll', (msg) => {
      const roll = { type: 'dice_roll', notation: msg.notation, total: msg.total, label: msg.label };
      slot.recentMessages.push(roll);
      slot.allMessages.push({ ...roll, timestamp: new Date().toISOString() });
    });

    ws.on('session_status', (msg) => {
      if (msg.status === 'thinking') {
        slot.state = 'waiting_for_dm';
      }
    });

    ws.on('error', (msg) => {
      console.error(`[Bot:${bot.name}] Session WS error (${slot.sessionId}):`, msg.error);
    });

    ws.connect();
  }

  _startSessionTick(bot, slot) {
    if (!this._running) return;
    const jitter = this.config.turnDelayMs * (0.1 + Math.random() * 0.2);
    const delay = this.config.turnDelayMs + jitter;
    slot.tickTimer = setTimeout(() => {
      this._sessionTick(bot, slot).catch(err => {
        console.error(`[Bot:${bot.name}] Session tick error (${slot.sessionId}):`, err.message);
      }).finally(() => {
        if (bot.sessions.has(slot.sessionId)) {
          this._startSessionTick(bot, slot);
        }
      });
    }, delay);
  }

  _closeSessionSlot(bot, slot) {
    if (slot.tickTimer) {
      clearTimeout(slot.tickTimer);
      slot.tickTimer = null;
    }
    if (slot.ws) {
      slot.ws.close();
      slot.ws = null;
    }
    bot.sessions.delete(slot.sessionId);
  }

  // -- Tick logic --

  _scheduleLookup(bot, initial = false) {
    if (!this._running) return;
    // First tick fires fast (3-8s), subsequent ticks at 2-3x turn delay
    const delay = initial
      ? 3000 + Math.random() * 5000
      : this.config.turnDelayMs * 2 + Math.random() * this.config.turnDelayMs;
    const timer = setTimeout(() => {
      this._lookupTick(bot).catch(err => {
        console.error(`[Bot:${bot.name}] Lookup tick error:`, err.message);
      }).finally(() => {
        this._scheduleLookup(bot);
      });
    }, delay);
    this._lookupTimers.set(bot.email, timer);
  }

  async _lookupTick(bot) {
    if (!this._running) return;
    bot.lastActionTime = new Date().toISOString();

    // If we have room for more sessions, try to find/create one
    if (bot.sessions.size < this.config.maxSessionsPerBot) {
      await this._findOrCreateSession(bot);
    }
  }

  async _sessionTick(bot, slot) {
    if (!this._running || !slot.ws?.connected) return;
    bot.lastActionTime = new Date().toISOString();

    if (slot.state === 'playing') {
      await this._playTurn(bot, slot);
    }
    // If waiting_for_dm or idle, skip — next tick will check again
  }

  async _playTurn(bot, slot) {
    slot.state = 'thinking';
    try {
      const turnText = await this._withApiSlot(() =>
        generateTurnText({
          recentMessages: slot.recentMessages,
          character: slot.character,
          scenarioName: slot.scenarioId,
        })
      );

      if (slot.role === 'host') {
        slot.ws.sendUserMessage(turnText);
      } else {
        slot.ws.submitCompanionTurn(turnText, slot.companionNpcId);
      }
      slot.recentMessages.push({ type: 'player', text: turnText });
      slot.allMessages.push({ type: 'player', text: turnText, timestamp: new Date().toISOString() });
      slot.state = 'waiting_for_dm';
      console.log(`[Bot:${bot.name}] Sent turn (${slot.role}, ${slot.sessionId.slice(0, 8)}): "${turnText.slice(0, 60)}..."`);
    } catch (err) {
      console.error(`[Bot:${bot.name}] Turn error (${slot.sessionId}):`, err.message);
      slot.state = 'playing'; // Retry next tick
    }
  }

  async _findOrCreateSession(bot) {
    try {
      const campaigns = getAvailableCampaigns(this.dataDir);
      const campaignId = campaigns[Math.floor(Math.random() * campaigns.length)] || 'demo';
      const hasNoSessions = bot.sessions.size === 0;

      // 30% chance to idle this tick (but always act if bot has no sessions yet)
      if (!hasNoSessions && Math.random() < 0.3) return;

      // Check for joinable public sessions
      const sessions = await bot.api.getSessions(campaignId);
      const alreadyIn = new Set(Array.from(bot.sessions.values()).map(s => s.sessionId));
      const joinable = (sessions || []).filter(s =>
        s.settings?.visibility === 'public' &&
        s.companionSlots?.open > 0 &&
        s.ownerEmail !== bot.email &&
        !alreadyIn.has(s.id)
      );

      if (joinable.length > 0) {
        const session = joinable[Math.floor(Math.random() * joinable.length)];
        const openSlot = session.companionSlots.slots.find(s => s.type === 'player' && !s.claimedBy);
        if (openSlot) {
          await bot.api.joinSession(campaignId, session.id, openSlot.npcId);
          const slot = createSessionSlot(session.id, {
            label: session.label || session.name,
            campaignId,
            role: 'companion',
            companionNpcId: openSlot.npcId,
          });
          slot.state = 'waiting_for_dm';
          bot.sessions.set(session.id, slot);
          this._wireSessionSlot(bot, slot);
          // Watch the session once connected
          slot.ws.on('connected', () => {
            slot.ws.watchSession(session.id);
          });
          this._startSessionTick(bot, slot);
          console.log(`[Bot:${bot.name}] Joined session "${session.label || session.id}" as companion (${bot.sessions.size}/${this.config.maxSessionsPerBot})`);
          return;
        }
      }

      // 50% idle, 50% create own (but always create if bot has no sessions)
      if (!hasNoSessions && Math.random() < 0.5) return;

      const scenarios = await bot.api.getScenarios(campaignId);
      const characters = await bot.api.getCharacters(campaignId);
      const aliveChars = (characters || []).filter(c => c.status === 'alive');

      if (!scenarios?.length || !aliveChars?.length) return;

      const scenario = scenarios[Math.floor(Math.random() * scenarios.length)];
      const character = aliveChars[Math.floor(Math.random() * aliveChars.length)];

      const created = await bot.api.createSession(campaignId, {
        characterId: character.id,
        scenarioId: scenario.id,
        campaignId,
        settings: { visibility: 'public' },
      });

      const slot = createSessionSlot(created.id, {
        label: created.label || created.name,
        campaignId,
        characterId: character.id,
        scenarioId: scenario.name || scenario.id,
        character,
        role: 'host',
      });
      slot.state = 'waiting_for_dm';
      bot.sessions.set(created.id, slot);
      this._wireSessionSlot(bot, slot);

      // Start the game once WS connects
      slot.ws.on('connected', () => {
        slot.ws.startSession(character.id, scenario.id, campaignId, null);
        // Send opening message after brief delay
        setTimeout(() => {
          if (slot.state === 'playing' || slot.state === 'waiting_for_dm') {
            const openingMsg = 'I look around and take in my surroundings.';
            slot.ws.sendUserMessage(openingMsg);
            slot.recentMessages.push({ type: 'player', text: openingMsg });
            slot.allMessages.push({ type: 'player', text: openingMsg, timestamp: new Date().toISOString() });
          }
        }, 2000);
      });

      this._startSessionTick(bot, slot);
      console.log(`[Bot:${bot.name}] Created session — ${campaignId}/${scenario.name || scenario.id} (${bot.sessions.size}/${this.config.maxSessionsPerBot})`);
    } catch (err) {
      console.error(`[Bot:${bot.name}] Session find/create error:`, err.message);
    }
  }

  // -- Control methods --

  async stop() {
    console.log('[BotOrchestrator] Stopping all bots...');
    this._running = false;

    for (const [email, timer] of this._lookupTimers) {
      clearTimeout(timer);
    }
    this._lookupTimers.clear();

    for (const [email, bot] of this.bots) {
      // Close all session slots
      for (const [sid, slot] of bot.sessions) {
        this._closeSessionSlot(bot, slot);
      }
      bot.chatWs.close();
    }
    this.bots.clear();

    this._activeApiCalls = 0;
    this._apiQueue = [];

    console.log('[BotOrchestrator] All bots stopped.');
  }

  async reconfigure(newConfig) {
    const wasRunning = this._running;

    if (newConfig.count !== undefined) this.config.count = Math.max(0, Math.min(20, newConfig.count));
    if (newConfig.turnDelayMs !== undefined) this.config.turnDelayMs = Math.max(30000, Math.min(3600000, newConfig.turnDelayMs));
    if (newConfig.maxConcurrentApiCalls !== undefined) this.config.maxConcurrentApiCalls = Math.max(1, Math.min(10, newConfig.maxConcurrentApiCalls));
    if (newConfig.maxSessionsPerBot !== undefined) this.config.maxSessionsPerBot = Math.max(1, Math.min(5, newConfig.maxSessionsPerBot));
    if (newConfig.enabled !== undefined) this.config.enabled = !!newConfig.enabled;

    this.saveConfig();

    if (this.config.enabled && !wasRunning) {
      await this.start();
    } else if (!this.config.enabled && wasRunning) {
      await this.stop();
    } else if (this.config.enabled && wasRunning) {
      setDesiredBotCount(this.dataDir, this.config.count);
      const accounts = listBotAccounts(this.dataDir);
      const currentEmails = new Set(this.bots.keys());
      const desiredEmails = new Set(accounts.map(a => a.email));

      for (const account of accounts) {
        if (!currentEmails.has(account.email)) {
          this._startBot(account);
        }
      }

      for (const email of currentEmails) {
        if (!desiredEmails.has(email)) {
          const bot = this.bots.get(email);
          if (bot) {
            const timer = this._lookupTimers.get(email);
            if (timer) clearTimeout(timer);
            this._lookupTimers.delete(email);
            for (const [sid, slot] of bot.sessions) {
              this._closeSessionSlot(bot, slot);
            }
            bot.chatWs.close();
            this.bots.delete(email);
            console.log(`[BotOrchestrator] Stopped bot: ${bot.name}`);
          }
        }
      }
    }
  }

  async cleanup() {
    await this.stop();
    const count = deleteAllBotAccounts(this.dataDir);
    this.config.count = 0;
    this.config.enabled = false;
    this.saveConfig();
    return count;
  }

  getStatus() {
    const bots = [];
    for (const [email, bot] of this.bots) {
      const sessionList = [];
      for (const [sid, slot] of bot.sessions) {
        sessionList.push({
          sessionId: slot.sessionId,
          sessionLabel: slot.sessionLabel,
          campaignId: slot.campaignId,
          role: slot.role,
          state: slot.state,
          connected: !!slot.ws?.connected,
          messageCount: slot.allMessages.length,
        });
      }
      bots.push({
        email: bot.email,
        name: bot.name,
        connected: bot.chatWs.connected,
        sessionCount: bot.sessions.size,
        sessions: sessionList,
        lastActionTime: bot.lastActionTime,
      });
    }
    return {
      enabled: this.config.enabled,
      running: this._running,
      count: this.config.count,
      turnDelayMs: this.config.turnDelayMs,
      maxConcurrentApiCalls: this.config.maxConcurrentApiCalls,
      maxSessionsPerBot: this.config.maxSessionsPerBot,
      activeBots: this.bots.size,
      bots,
    };
  }
}

module.exports = { BotOrchestrator };
