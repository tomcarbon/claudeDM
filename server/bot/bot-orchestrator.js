const fs = require('fs');
const path = require('path');
const { listBotAccounts, createBotAccount, deleteBotAccount, deleteAllBotAccounts } = require('./bot-accounts');
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
  maxConcurrentApiCalls: 3,
  bots: [], // [{ email, role, turnDelayMs, maxSessionsPerBot }]
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
    companionNpcName: opts.companionNpcName || null,
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
    this.config = { ...DEFAULT_CONFIG, bots: [] };
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

        // Backward compat: migrate old global-count format to per-bot array
        if (data.bots === undefined) {
          const oldHostCount = data.hostCount || 0;
          const oldCompanionCount = data.companionCount || 0;
          const oldEitherCount = data.count !== undefined ? data.count : (data.eitherCount || 0);
          const oldDelay = data.turnDelayMs || 60000;
          const oldMaxSessions = data.maxSessionsPerBot || 1;

          // Build per-bot entries from existing bot accounts
          const accounts = listBotAccounts(this.dataDir);
          const totalNeeded = oldHostCount + oldCompanionCount + oldEitherCount;
          const bots = [];
          for (let i = 0; i < Math.min(accounts.length, totalNeeded); i++) {
            let role;
            if (i < oldHostCount) role = 'host';
            else if (i < oldHostCount + oldCompanionCount) role = 'companion';
            else role = 'either';
            bots.push({
              email: accounts[i].email,
              role,
              turnDelayMs: oldDelay,
              maxSessionsPerBot: oldMaxSessions,
            });
          }

          this.config = {
            enabled: !!data.enabled,
            maxConcurrentApiCalls: data.maxConcurrentApiCalls || 3,
            bots,
          };
          console.log(`[BotOrchestrator] Migrated old config format → ${bots.length} per-bot entries`);
          this.saveConfig();
          return this.config;
        }

        this.config = { ...DEFAULT_CONFIG, ...data, bots: data.bots || [] };
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
    const botConfigs = this.config.bots || [];
    console.log(`[BotOrchestrator] Starting bot farm — ${botConfigs.length} bots`);
    this._running = true;

    for (const bc of botConfigs) {
      const accounts = listBotAccounts(this.dataDir);
      const account = accounts.find(a => a.email === bc.email);
      if (account) {
        this._startBot(account, bc.role, bc.turnDelayMs, bc.maxSessionsPerBot);
      } else {
        console.warn(`[BotOrchestrator] Bot account not found for ${bc.email}, skipping`);
      }
    }
  }

  _startBot(account, role = 'either', turnDelayMs = 60000, maxSessionsPerBot = 1) {
    if (this.bots.has(account.email)) return;

    const bot = {
      email: account.email,
      name: account.name,
      role, // 'host' | 'companion' | 'either'
      turnDelayMs: Math.max(30000, Math.min(3600000, turnDelayMs || 60000)),
      maxSessionsPerBot: Math.max(1, Math.min(5, maxSessionsPerBot || 1)),
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
    console.log(`[BotOrchestrator] Started bot: ${bot.name} (${role}, delay=${bot.turnDelayMs}ms, maxSessions=${bot.maxSessionsPerBot})`);
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
      // Only the host bot owns the session file — companions can't save to it
      if (slot.role === 'host') {
        bot.api.updateSession(slot.campaignId, slot.sessionId, {
          messages: slot.allMessages,
          claudeSessionId: slot.claudeSessionId || msg.sessionId || null,
        }).catch(err => {
          console.error(`[Bot:${bot.name}] Session save error (${slot.sessionId}):`, err.message);
        });
      }
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

    // Companion bots: when turn_status shows host has submitted and we're waiting,
    // transition to 'playing' so we submit our turn (prevents first-round deadlock)
    ws.on('turn_status', (msg) => {
      if (slot.role === 'companion' && slot.state === 'waiting_for_dm' && msg.hostSubmitted) {
        slot.state = 'playing';
      }
    });

    ws.on('error', (msg) => {
      console.error(`[Bot:${bot.name}] Session WS error (${slot.sessionId}):`, msg.error);
    });

    ws.connect();
  }

  _startSessionTick(bot, slot) {
    if (!this._running) return;
    const jitter = bot.turnDelayMs * (0.1 + Math.random() * 0.2);
    const delay = bot.turnDelayMs + jitter;
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

  _hasHumanCompanions(bot, slot) {
    try {
      const slug = String(bot.email).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const sessionFile = path.join(this.dataDir, 'players', slug, slot.campaignId || 'demo', 'sessions', `${slot.sessionId}.json`);
      if (!fs.existsSync(sessionFile)) return false;
      const session = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
      const companions = session.companionPlayers || {};
      return Object.values(companions).some(cp => cp.email && !cp.email.endsWith('@bot.local'));
    } catch {
      return false;
    }
  }

  _closeSessionSlot(bot, slot, { force = false } = {}) {
    // Protect sessions with human companions unless forced
    if (!force && slot.role === 'host' && this._hasHumanCompanions(bot, slot)) {
      console.log(`[Bot:${bot.name}] Skipping close for session ${slot.sessionId.slice(0, 8)} — human companion present`);
      // Stop the bot from taking turns, but keep connection alive
      if (slot.tickTimer) {
        clearTimeout(slot.tickTimer);
        slot.tickTimer = null;
      }
      return false;
    }

    if (slot.tickTimer) {
      clearTimeout(slot.tickTimer);
      slot.tickTimer = null;
    }
    if (slot.ws) {
      slot.ws.close();
      slot.ws = null;
    }
    bot.sessions.delete(slot.sessionId);
    return true;
  }

  // -- Tick logic --

  _scheduleLookup(bot, initial = false) {
    if (!this._running) return;
    // First tick fires fast (3-8s)
    // Companion bots check more frequently (30-60s) since they're just scanning for games to join
    // Host/either bots use 2-3x turn delay
    const isCompanionRole = bot.role === 'companion';
    const delay = initial
      ? 3000 + Math.random() * 5000
      : isCompanionRole
        ? 30000 + Math.random() * 30000
        : bot.turnDelayMs * 2 + Math.random() * bot.turnDelayMs;
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
    if (bot.sessions.size < bot.maxSessionsPerBot) {
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
        slot.ws.submitCompanionTurn(turnText, slot.companionNpcId, slot.companionNpcName, slot.character?.id, slot.character?.name);
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

  async _joinSession(bot, campaignId) {
    const sessions = await bot.api.getSessions(campaignId);
    const alreadyIn = new Set(Array.from(bot.sessions.values()).map(s => s.sessionId));
    const publicSessions = (sessions || []).filter(s => s.settings?.visibility === 'public' && s.ownerEmail !== bot.email && !alreadyIn.has(s.id));
    const joinable = publicSessions.filter(s =>
      s.settings?.allowBots === true &&
      s.companionSlots?.open > 0 &&
      (s.botCount || 0) < (s.settings?.maxBots ?? 2)
    );

    if (joinable.length === 0) {
      if (bot.role === 'companion' && publicSessions.length > 0) {
        const reasons = publicSessions.map(s => {
          const parts = [];
          if (s.settings?.allowBots !== true) parts.push('bots_off');
          if (!s.companionSlots?.open) parts.push('no_slots');
          if ((s.botCount || 0) >= (s.settings?.maxBots ?? 2)) parts.push('max_bots');
          return `${s.label || s.id.slice(0, 8)}(${parts.join(',')})`;
        });
        console.log(`[Bot:${bot.name}] Scanned ${campaignId}: ${publicSessions.length} public, 0 joinable — ${reasons.join(', ')}`);
      }
      return false;
    }

    const session = joinable[Math.floor(Math.random() * joinable.length)];
    const openSlot = session.companionSlots.slots.find(s => s.type === 'player' && !s.claimedBy);
    if (!openSlot) return false;

    try {
      await bot.api.joinSession(campaignId, session.id, openSlot.npcId);
    } catch (err) {
      // 409 = already joined this slot — treat as success
      if (err.message.includes('(409)')) {
        console.log(`[Bot:${bot.name}] Already joined session "${session.label || session.id}", re-attaching.`);
      } else {
        throw err;
      }
    }
    // Fetch NPC name and bot's character roster
    let companionNpcName = openSlot.npcId;
    let chosenCharacter = null;
    try {
      const [npcs, characters] = await Promise.all([
        bot.api.getNpcs(campaignId),
        bot.api.getCharacters(campaignId),
      ]);
      const npc = (npcs || []).find(n => n.id === openSlot.npcId);
      if (npc?.name) companionNpcName = npc.name;

      // Pick a random player character, avoiding duplicates within this session
      const aliveChars = (characters || []).filter(c => c.status === 'alive');
      if (aliveChars.length > 0) {
        // Collect character names already taken in this session (by host or other companions)
        const takenNames = new Set();
        // Host's character
        if (session.characterId) {
          const hostChar = aliveChars.find(c => c.id === session.characterId);
          if (hostChar?.name) takenNames.add(hostChar.name.toLowerCase());
        }
        // Other companions already claimed in this session
        for (const s of session.companionSlots.slots) {
          if (s.claimedBy?.characterName) takenNames.add(s.claimedBy.characterName.toLowerCase());
        }
        // Other bots in this orchestrator that already picked a character for this session
        for (const [, otherBot] of this.bots) {
          const otherSlot = otherBot.sessions.get(session.id);
          if (otherSlot && otherSlot.character?.name) {
            takenNames.add(otherSlot.character.name.toLowerCase());
          }
        }
        // Also exclude active NPC names to avoid name collisions
        for (const n of (npcs || [])) {
          if (n.id !== openSlot.npcId && n.status !== 'dead') {
            takenNames.add(n.name.toLowerCase());
          }
        }
        const available = aliveChars.filter(c => !takenNames.has(c.name.toLowerCase()));
        const pool = available.length > 0 ? available : aliveChars;
        chosenCharacter = pool[Math.floor(Math.random() * pool.length)];
      }
    } catch {}
    const slot = createSessionSlot(session.id, {
      label: session.label || session.name,
      campaignId,
      role: 'companion',
      companionNpcId: openSlot.npcId,
      companionNpcName,
      character: chosenCharacter,
    });
    slot.state = 'waiting_for_dm';
    bot.sessions.set(session.id, slot);
    this._wireSessionSlot(bot, slot);
    slot.ws.on('connected', () => {
      slot.ws.watchSession(session.id);
      // Set the companion's chosen character after watching
      if (chosenCharacter) {
        slot.ws.setCompanionCharacter(chosenCharacter.id, chosenCharacter.name, companionNpcName, chosenCharacter);
        console.log(`[Bot:${bot.name}] Selected character "${chosenCharacter.name}" for companion slot ${companionNpcName}`);
      }
    });
    this._startSessionTick(bot, slot);
    console.log(`[Bot:${bot.name}] Joined session "${session.label || session.id}" as companion (${bot.sessions.size}/${bot.maxSessionsPerBot})`);
    return true;
  }

  async _createSession(bot, campaignId) {
    const [scenarios, characters, npcs] = await Promise.all([
      bot.api.getScenarios(campaignId),
      bot.api.getCharacters(campaignId),
      bot.api.getNpcs(campaignId),
    ]);
    const aliveChars = (characters || []).filter(c => c.status === 'alive');

    if (!scenarios?.length || !aliveChars?.length) return;

    const scenario = scenarios[Math.floor(Math.random() * scenarios.length)];
    const character = aliveChars[Math.floor(Math.random() * aliveChars.length)];

    // Build companion config: guarantee at least 2 open player slots (or all if fewer NPCs)
    const companionConfig = { states: {}, reservations: {} };
    const aliveNpcs = (npcs || []).filter(n => n.status === 'alive');
    // Shuffle NPCs so the guaranteed slots are random, not always the first ones
    const shuffled = [...aliveNpcs].sort(() => Math.random() - 0.5);
    const minOpen = Math.min(2, shuffled.length);
    for (let i = 0; i < shuffled.length; i++) {
      companionConfig.states[shuffled[i].id] = i < minOpen ? 'player' : (Math.random() < 0.5 ? 'player' : 'removed');
    }

    const created = await bot.api.createSession(campaignId, {
      characterId: character.id,
      scenarioId: scenario.id,
      campaignId,
      companionConfig,
      settings: { visibility: 'public', allowBots: true, maxBots: 5 },
    });

    const label = `Adventure with ${character.name}`;
    await bot.api.setSessionLabel(campaignId, created.id, label).catch(err => {
      console.error(`[Bot:${bot.name}] Label set error:`, err.message);
    });

    const slot = createSessionSlot(created.id, {
      label: label,
      campaignId,
      characterId: character.id,
      scenarioId: scenario.name || scenario.id,
      character,
      role: 'host',
    });
    slot.state = 'waiting_for_dm';
    bot.sessions.set(created.id, slot);
    this._wireSessionSlot(bot, slot);

    slot.ws.on('connected', () => {
      slot.ws.startSession(character.id, scenario.id, campaignId, companionConfig);
      slot.ws.watchSession(created.id);
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
    console.log(`[Bot:${bot.name}] Created session — ${campaignId}/${scenario.name || scenario.id} (${bot.sessions.size}/${bot.maxSessionsPerBot})`);
  }

  async _findOrCreateSession(bot) {
    try {
      const campaigns = getAvailableCampaigns(this.dataDir);
      const hasNoSessions = bot.sessions.size === 0;

      // 30% chance to idle this tick (but always act if bot has no sessions yet)
      if (!hasNoSessions && Math.random() < 0.3) return;

      if (bot.role === 'host') {
        // Host bots always create sessions — pick a random campaign
        const campaignId = campaigns[Math.floor(Math.random() * campaigns.length)] || 'demo';
        await this._createSession(bot, campaignId);
      } else if (bot.role === 'companion') {
        // Companion bots scan ALL campaigns for joinable sessions
        for (const cid of campaigns) {
          const joined = await this._joinSession(bot, cid);
          if (joined) return;
        }
      } else {
        // 'either' — try to join across all campaigns first, then maybe create
        for (const cid of campaigns) {
          const joined = await this._joinSession(bot, cid);
          if (joined) return;
        }
        const campaignId = campaigns[Math.floor(Math.random() * campaigns.length)] || 'demo';
        if (!hasNoSessions && Math.random() < 0.5) return;
        await this._createSession(bot, campaignId);
      }
    } catch (err) {
      console.error(`[Bot:${bot.name}] Session find/create error:`, err.message);
    }
  }

  // -- Control methods --

  /**
   * Add new bots with individual configuration.
   * Creates accounts, persists config, and starts each bot.
   */
  async addBots({ role = 'either', count = 1, turnDelayMs = 60000, maxSessionsPerBot = 1 } = {}) {
    const added = [];
    for (let i = 0; i < count; i++) {
      const account = createBotAccount(this.dataDir);
      const botConfig = {
        email: account.email,
        role,
        turnDelayMs: Math.max(30000, Math.min(3600000, turnDelayMs)),
        maxSessionsPerBot: Math.max(1, Math.min(5, maxSessionsPerBot)),
      };
      this.config.bots.push(botConfig);
      added.push(account);

      // Start immediately if farm is running
      if (this._running) {
        this._startBot(account, botConfig.role, botConfig.turnDelayMs, botConfig.maxSessionsPerBot);
      }
    }

    this.config.enabled = true;
    this._running = true;
    this.saveConfig();

    // If farm wasn't running, start any bots that were in config but not yet started
    for (const bc of this.config.bots) {
      if (!this.bots.has(bc.email)) {
        const accounts = listBotAccounts(this.dataDir);
        const account = accounts.find(a => a.email === bc.email);
        if (account) {
          this._startBot(account, bc.role, bc.turnDelayMs, bc.maxSessionsPerBot);
        }
      }
    }

    console.log(`[BotOrchestrator] Added ${added.length} ${role} bot(s) (delay=${turnDelayMs}ms, maxSessions=${maxSessionsPerBot})`);
    return added;
  }

  /**
   * Remove a specific bot entirely — force-disconnect all sessions, delete account.
   * If the bot is a host, cascade-disconnect companion bots from its sessions.
   */
  async removeBot(botEmail) {
    const bot = this.bots.get(botEmail);
    if (!bot) throw new Error(`Bot not found: ${botEmail}`);

    // For each session this bot hosts, disconnect companion bots first
    for (const [sid, slot] of bot.sessions) {
      if (slot.role === 'host') {
        for (const [email, otherBot] of this.bots) {
          if (email === botEmail) continue;
          const companionSlot = otherBot.sessions.get(sid);
          if (companionSlot && companionSlot.role === 'companion') {
            try {
              await otherBot.api.unjoinSession(companionSlot.campaignId, sid, companionSlot.companionNpcId);
            } catch (err) {
              console.error(`[BotOrchestrator] Unjoin failed for companion ${otherBot.name}:`, err.message);
            }
            this._closeSessionSlot(otherBot, companionSlot, { force: true });
            console.log(`[BotOrchestrator] Cascade-disconnected companion ${otherBot.name} from session ${sid.slice(0, 8)}`);
          }
        }
      }

      // If this bot is a companion, unjoin from the session API
      if (slot.role === 'companion' && slot.companionNpcId) {
        try {
          await bot.api.unjoinSession(slot.campaignId, sid, slot.companionNpcId);
        } catch (err) {
          console.error(`[BotOrchestrator] Unjoin failed for ${bot.name}:`, err.message);
        }
      }

      this._closeSessionSlot(bot, slot, { force: true });
    }

    // Stop lookup timer
    const timer = this._lookupTimers.get(botEmail);
    if (timer) {
      clearTimeout(timer);
      this._lookupTimers.delete(botEmail);
    }

    // Close chat WS
    bot.chatWs.close();
    this.bots.delete(botEmail);

    // Remove from config and delete account
    this.config.bots = this.config.bots.filter(bc => bc.email !== botEmail);
    this.saveConfig();
    deleteBotAccount(this.dataDir, botEmail);

    console.log(`[BotOrchestrator] Removed bot: ${bot.name} (${botEmail})`);
    return { removed: true, botName: bot.name, email: botEmail };
  }

  /**
   * Disconnect a specific bot from a specific session (without deleting the bot).
   * If the bot is the host, also disconnect any companion bots in that session.
   */
  async disconnectBotSession(botEmail, sessionId) {
    const bot = this.bots.get(botEmail);
    if (!bot) throw new Error(`Bot not found: ${botEmail}`);
    const slot = bot.sessions.get(sessionId);
    if (!slot) throw new Error(`Session not found for bot: ${sessionId}`);

    // If host, disconnect all companion bots in this session first
    if (slot.role === 'host') {
      for (const [email, otherBot] of this.bots) {
        if (email === botEmail) continue;
        const companionSlot = otherBot.sessions.get(sessionId);
        if (companionSlot && companionSlot.role === 'companion') {
          try {
            await otherBot.api.unjoinSession(companionSlot.campaignId, sessionId, companionSlot.companionNpcId);
          } catch (err) {
            console.error(`[BotOrchestrator] Unjoin failed for companion ${otherBot.name}:`, err.message);
          }
          this._closeSessionSlot(otherBot, companionSlot, { force: true });
          console.log(`[BotOrchestrator] Disconnected companion ${otherBot.name} from session ${sessionId.slice(0, 8)}`);
        }
      }
    }

    // If this bot is a companion, unjoin from session API
    if (slot.role === 'companion' && slot.companionNpcId) {
      try {
        await bot.api.unjoinSession(slot.campaignId, sessionId, slot.companionNpcId);
      } catch (err) {
        console.error(`[BotOrchestrator] Unjoin failed for ${bot.name}:`, err.message);
      }
    }

    // Force-close the slot (admin override — bypass human companion protection)
    this._closeSessionSlot(bot, slot, { force: true });
    console.log(`[BotOrchestrator] Disconnected ${bot.name} from session ${sessionId.slice(0, 8)}`);

    return { disconnected: true, botName: bot.name, sessionId };
  }

  async stop() {
    console.log('[BotOrchestrator] Stopping all bots...');
    this._running = false;

    for (const [email, timer] of this._lookupTimers) {
      clearTimeout(timer);
    }
    this._lookupTimers.clear();

    for (const [email, bot] of this.bots) {
      // Close session slots — skip any with human companions
      for (const [sid, slot] of bot.sessions) {
        this._closeSessionSlot(bot, slot);
      }
      // Only fully disconnect bot if all its sessions were closed
      if (bot.sessions.size === 0) {
        bot.chatWs.close();
        this.bots.delete(email);
      } else {
        console.log(`[BotOrchestrator] Bot ${bot.name} kept alive — ${bot.sessions.size} session(s) with human companions`);
      }
    }

    this._activeApiCalls = 0;
    this._apiQueue = [];

    const remaining = this.bots.size;
    console.log(`[BotOrchestrator] All bots stopped.${remaining ? ` ${remaining} bot(s) kept alive for human companions.` : ''}`);
  }

  async cleanup() {
    // Force-close everything including sessions with human companions
    console.log('[BotOrchestrator] Cleanup — force-stopping all bots...');
    this._running = false;
    for (const [email, timer] of this._lookupTimers) {
      clearTimeout(timer);
    }
    this._lookupTimers.clear();
    for (const [email, bot] of this.bots) {
      for (const [sid, slot] of bot.sessions) {
        this._closeSessionSlot(bot, slot, { force: true });
      }
      bot.chatWs.close();
    }
    this.bots.clear();
    this._activeApiCalls = 0;
    this._apiQueue = [];

    const count = deleteAllBotAccounts(this.dataDir);
    this.config.bots = [];
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
        botRole: bot.role,
        turnDelayMs: bot.turnDelayMs,
        maxSessionsPerBot: bot.maxSessionsPerBot,
        connected: bot.chatWs.connected,
        sessionCount: bot.sessions.size,
        sessions: sessionList,
        lastActionTime: bot.lastActionTime,
      });
    }
    return {
      enabled: this.config.enabled,
      running: this._running,
      maxConcurrentApiCalls: this.config.maxConcurrentApiCalls,
      activeBots: this.bots.size,
      bots,
    };
  }
}

module.exports = { BotOrchestrator };
