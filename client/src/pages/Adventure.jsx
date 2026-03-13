import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { api } from '../api/client';
import { usePlayer } from '../context/PlayerContext';
import RichText from '../components/RichText';
import { getCollapseThreshold } from '../utils/displaySettings';

const STATUS_CONFIG = {
  idle: { label: 'Ready', className: 'status-idle' },
  thinking: { label: 'DM is thinking...', className: 'status-thinking' },
  awaiting_permission: { label: 'Awaiting approval', className: 'status-permission' },
  disconnected: { label: 'Disconnected', className: 'status-disconnected' },
  error: { label: 'Error', className: 'status-error' },
};

function normalizeSavedMessages(rawMessages) {
  if (!Array.isArray(rawMessages)) return [];

  return rawMessages.map((entry) => {
    if (typeof entry === 'string') {
      return { type: 'system', text: entry };
    }
    if (!entry || typeof entry !== 'object') return null;

    const inferredType = entry.type
      || (entry.role === 'user' || entry.role === 'player' ? 'player'
        : entry.role === 'assistant' || entry.role === 'dm' ? 'dm'
          : entry.role === 'system' ? 'system'
            : null);

    const text = typeof entry.text === 'string'
      ? entry.text
      : (typeof entry.content === 'string'
        ? entry.content
        : (typeof entry.message === 'string' ? entry.message : ''));

    if (!text) return null;

    return {
      type: ['system', 'player', 'companion', 'dm', 'dm_partial', 'dice_roll'].includes(inferredType) ? inferredType : 'system',
      text,
    };
  }).filter(Boolean);
}

function formatSavedSessionDate(timestamp) {
  if (!timestamp) return 'Unknown date';
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return 'Unknown date';
  return parsed.toLocaleDateString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatSavedSessionTime(timestamp) {
  if (!timestamp) return '';
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function Adventure({
  ws,
  sessionActive,
  setSessionActive,
  selectedCharacter,
  setSelectedCharacter,
  selectedScenario,
  setSelectedScenario,
  savedSessionDbId,
  setSavedSessionDbId,
  campaignId,
}) {
  const {
    messages,
    setMessages,
    status,
    sessionId,
    permissionRequest,
    sendMessage,
    sendMessageRaw,
    startSession,
    sendPermission,
    resumeSession,
    watchSession,
    sessionAccess,
    sessionParticipants,
    companionTurns,
    readyGolfStatus,
    readyGolfFireRef,
    submitHostTurnReady,
    retractHostTurn,
    forceHostTurn,
    setCompanionCharacter,
    submitCompanionTurn,
    retractCompanionTurn,
    skipCompanion,
    sendTypingStatus,
    typingPlayers,
    sessionsChanged,
  } = ws;
  const { player } = usePlayer();
  const [input, setInput] = useState('');
  const [characters, setCharacters] = useState([]);
  const [npcs, setNpcs] = useState([]);
  const [companionStates, setCompanionStates] = useState({}); // npcId -> 'selected' | 'removed' | 'player' | 'reserved'
  const [companionReservations, setCompanionReservations] = useState({}); // npcId -> friend email
  const [friends, setFriends] = useState([]);
  const [friendNames, setFriendNames] = useState({}); // email -> display name
  const [reserveDropdownNpc, setReserveDropdownNpc] = useState(null); // npcId currently showing dropdown
  const [scenarios, setScenarios] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [mode, setMode] = useState('campaigns'); // 'campaigns' | 'scenarios'
  const [sessionLabel, setSessionLabel] = useState('');
  const [selectedCampaign, setSelectedCampaign] = useState(null);
  const [savedSessions, setSavedSessions] = useState([]);
  const [saveStatus, setSaveStatus] = useState(null); // null | 'saving' | 'saved'
  const [autoSave, setAutoSave] = useState(true);
  const [sessionReadOnly, setSessionReadOnly] = useState(false);
  const [sessionSettings, setSessionSettings] = useState({ visibility: 'public', turnMode: 'initiative' });
  const [showSettings, setShowSettings] = useState(false);
  const [companionInput, setCompanionInput] = useState('');
  const [companionCharacterId, setCompanionCharacterId] = useState(null);
  const [selectedStatusEntry, setSelectedStatusEntry] = useState(null); // npcId or 'host' for detail panel
  const [pendingOpeningPrompt, setPendingOpeningPrompt] = useState(null); // held until host clicks "Start Adventure"
  const [loadingSessionId, setLoadingSessionId] = useState(null);
  const storyRef = useRef(null);
  const inputRef = useRef(null);
  const prevMessageCountRef = useRef(0);
  const isNearBottomRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const isGuest = !player?.email;
  const isCompanion = !!sessionAccess.companionNpcId;
  const companionNpc = isCompanion ? npcs.find(n => n.id === sessionAccess.companionNpcId) : null;
  const companionCharacter = companionCharacterId ? characters.find(c => c.id === companionCharacterId) : null;
  const isHost = sessionAccess.canWrite;
  const isObserver = sessionReadOnly && !isCompanion;
  // Derive companion turn submitted from server state (no race conditions)
  const companionTurnSubmitted = isCompanion && companionTurns.some(t => t.playerEmail === player?.email);

  // --- Message gate system ---
  // Instead of collapsing individual long messages, we "gate" the message list:
  // messages up to the gate render normally; everything after is hidden behind "Show more".
  // When clicked, we advance the gate to the next long message (or end).
  const [gateRevealedUpTo, setGateRevealedUpTo] = useState(-1); // index up to which the user has explicitly revealed
  const collapseThreshold = useMemo(() => getCollapseThreshold(), []);

  // Find the next gate point: first long message after gateRevealedUpTo
  const gateInfo = useMemo(() => {
    if (!collapseThreshold) return { renderUpTo: messages.length, gatedAt: -1 }; // disabled
    for (let i = Math.max(0, gateRevealedUpTo + 1); i < messages.length; i++) {
      const msg = messages[i];
      if (msg.type === 'dm' || msg.type === 'system') {
        const lineCount = typeof msg.text === 'string' ? msg.text.split('\n').length : 0;
        if (lineCount >= collapseThreshold) {
          // Gate starts here — show up to and including this message's preview
          return { renderUpTo: i + 1, gatedAt: i };
        }
      }
    }
    // No long message found after revealed point — show everything
    return { renderUpTo: messages.length, gatedAt: -1 };
  }, [messages, gateRevealedUpTo, collapseThreshold]);

  const isGated = gateInfo.gatedAt >= 0 && gateInfo.renderUpTo < messages.length;
  const hiddenCount = isGated ? messages.length - gateInfo.renderUpTo : 0;

  const handleShowMore = useCallback(() => {
    // Advance the revealed point past the current gate
    setGateRevealedUpTo(gateInfo.gatedAt);
  }, [gateInfo.gatedAt]);

  // Restore companion character from session_access (persisted across reconnects)
  useEffect(() => {
    if (sessionAccess.companionCharacterId && !companionCharacterId) {
      setCompanionCharacterId(sessionAccess.companionCharacterId);
    }
  }, [sessionAccess.companionCharacterId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear companion input when turn is consumed by host
  const prevCompanionSubmitted = useRef(false);
  useEffect(() => {
    if (prevCompanionSubmitted.current && !companionTurnSubmitted) {
      setCompanionInput('');
    }
    prevCompanionSubmitted.current = companionTurnSubmitted;
  }, [companionTurnSubmitted]);

  // Broadcast typing status with debounce (clear after 3s of no typing)
  const typingTimerRef = useRef(null);
  const isTypingRef = useRef(false);
  const handleTypingInput = useCallback((value) => {
    if (value.trim() && !isTypingRef.current) {
      isTypingRef.current = true;
      sendTypingStatus(true);
    }
    clearTimeout(typingTimerRef.current);
    if (value.trim()) {
      typingTimerRef.current = setTimeout(() => {
        isTypingRef.current = false;
        sendTypingStatus(false);
      }, 3000);
    } else {
      isTypingRef.current = false;
      sendTypingStatus(false);
    }
  }, [sendTypingStatus]);
  // Clear typing on unmount
  useEffect(() => () => { clearTimeout(typingTimerRef.current); }, []);

  // Wire up ready-golf auto-fire callback
  useEffect(() => {
    readyGolfFireRef.current = (text) => {
      isNearBottomRef.current = true;
      setShowScrollBtn(false);
      // Use sendMessageRaw (no optimistic add) — server echoes back after companion actions
      sendMessageRaw(text, sessionSettings.turnMode || 'host-decides');
    };
    return () => { readyGolfFireRef.current = null; };
  }, [readyGolfFireRef, sendMessageRaw, sessionSettings.turnMode]);

  const scrollToBottom = useCallback(() => {
    const container = storyRef.current;
    if (!container) return;
    isNearBottomRef.current = true;
    setShowScrollBtn(false);
    container.scrollTop = container.scrollHeight;
  }, []);

  useEffect(() => {
    api.getCharacters().then(setCharacters).catch(() => {});
    api.getNpcs().then(loaded => {
      setNpcs(loaded);
      // Default all living NPCs to 'selected'
      const initial = {};
      loaded.filter(n => n.status !== 'dead').forEach(n => { initial[n.id] = 'selected'; });
      setCompanionStates(initial);
    }).catch(() => {});
    api.getScenarios().then(setScenarios).catch(() => {});
    api.getCampaigns().then(setCampaigns).catch(() => {});
    api.getDmSettings().then(s => {
      if (Array.isArray(s?.friends) && s.friends.length > 0) {
        setFriends(s.friends);
        api.lookupPlayers(s.friends).then(setFriendNames).catch(() => {});
      }
    }).catch(() => {});
    // Reset selections when campaign changes so stale picks from another campaign don't persist
    setSelectedCharacter('');
    setSelectedScenario('');
    setSelectedCampaign(null);
    setSessionLabel('');
    setCompanionReservations({});
    setReserveDropdownNpc(null);
    setSavedSessions([]);
  }, [campaignId, setSelectedCharacter, setSelectedScenario]);

  // Track whether the user has scrolled away from the bottom.
  // Listen for wheel/touchstart events in addition to scroll events so that
  // user intent is captured immediately — before the next useLayoutEffect can
  // fire and override the user's scroll-up with an auto-scroll to bottom.
  useLayoutEffect(() => {
    const container = storyRef.current;
    if (!container) return;
    const threshold = 150;

    const handleScroll = () => {
      const nearBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
      isNearBottomRef.current = nearBottom;
      setShowScrollBtn(!nearBottom);
    };

    // Wheel-up immediately signals the user wants to read earlier messages.
    // This fires before the browser updates scrollTop, closing the race window
    // where rapid streaming updates could override a scroll-up attempt.
    const handleWheel = (e) => {
      if (e.deltaY < 0) {
        isNearBottomRef.current = false;
        setShowScrollBtn(true);
      }
    };

    // On touch devices, any touch on the story area means manual control.
    const handleTouchStart = () => {
      const gap = container.scrollHeight - container.scrollTop - container.clientHeight;
      if (gap > threshold) {
        isNearBottomRef.current = false;
        setShowScrollBtn(true);
      }
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    container.addEventListener('wheel', handleWheel, { passive: true });
    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
      container.removeEventListener('wheel', handleWheel);
      container.removeEventListener('touchstart', handleTouchStart);
    };
  }, []);

  // Only auto-scroll when the user is already near the bottom.
  // Deferred via requestAnimationFrame so the browser can process any pending
  // user scroll/wheel events first (prevents the streaming race condition).
  useLayoutEffect(() => {
    if (!isNearBottomRef.current) return;
    if (isGated) return; // Don't auto-scroll when messages are hidden behind a gate
    const container = storyRef.current;
    if (!container) return;
    const frame = requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, isGated]);

  // Logout during active session: unwatch and return to setup screen
  useEffect(() => {
    if (isGuest && sessionActive) {
      watchSession(null);
      setSessionActive(false);
      setSavedSessionDbId(null);
      setSessionReadOnly(false);
      setMessages([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGuest]);

  // Load saved sessions for setup screen (re-fetch when campaign changes or another player creates/deletes)
  useEffect(() => {
    if (!sessionActive) {
      api.getSessions().then(setSavedSessions).catch(() => {});
    }
  }, [sessionActive, campaignId, sessionsChanged, player]);

  useEffect(() => {
    if (!savedSessionDbId || !sessionAccess.sessionDbId) return;
    if (sessionAccess.sessionDbId === savedSessionDbId) {
      setSessionReadOnly(sessionAccess.readOnly === true);
    }
  }, [savedSessionDbId, sessionAccess]);

  // Auto-save when messages change
  useEffect(() => {
    const completedMessages = messages.filter(m => m.type !== 'dm_partial');
    const count = completedMessages.length;
    if (!sessionReadOnly && !isCompanion && autoSave && count > 0 && count !== prevMessageCountRef.current) {
      prevMessageCountRef.current = count;
      handleSave();
    } else if (!autoSave) {
      prevMessageCountRef.current = count;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, autoSave, sessionReadOnly]);

  // Focus input when session starts
  useEffect(() => {
    if (sessionActive && inputRef.current) {
      inputRef.current.focus();
    }
  }, [sessionActive]);

  function cycleCompanionState(npcId) {
    const current = companionStates[npcId] || 'selected';
    setReserveDropdownNpc(null);
    if (current === 'selected') {
      setCompanionStates(prev => ({ ...prev, [npcId]: 'removed' }));
    } else if (current === 'removed') {
      setCompanionStates(prev => ({ ...prev, [npcId]: 'player' }));
    } else if (current === 'player') {
      if (friends.length > 0) {
        // Auto-reserve for first friend, player can change via dropdown
        setCompanionStates(prev => ({ ...prev, [npcId]: 'reserved' }));
        setCompanionReservations(prev => ({ ...prev, [npcId]: friends[0] }));
      } else {
        setCompanionStates(prev => ({ ...prev, [npcId]: 'selected' }));
      }
    } else if (current === 'reserved') {
      setCompanionStates(prev => ({ ...prev, [npcId]: 'selected' }));
      setCompanionReservations(prev => { const next = { ...prev }; delete next[npcId]; return next; });
    }
  }

  function handleReserveFor(npcId, friendEmail) {
    setCompanionReservations(prev => ({ ...prev, [npcId]: friendEmail }));
    setReserveDropdownNpc(null);
  }

  function toggleReserveDropdown(e, npcId) {
    e.stopPropagation();
    setReserveDropdownNpc(prev => prev === npcId ? null : npcId);
  }

  function buildCompanionRoster() {
    const activeCompanions = npcs.filter(n => companionStates[n.id] === 'selected');
    const openSlots = npcs.filter(n => companionStates[n.id] === 'player');
    const reservedSlots = npcs.filter(n => companionStates[n.id] === 'reserved');
    const removedCompanions = npcs.filter(n => companionStates[n.id] === 'removed');
    const lines = [];
    if (activeCompanions.length > 0) {
      lines.push(`Active NPC companions: ${activeCompanions.map(n => n.name).join(', ')}.`);
    }
    if (removedCompanions.length > 0) {
      lines.push(`These NPCs are NOT in the party and should not appear: ${removedCompanions.map(n => n.name).join(', ')}.`);
    }
    if (openSlots.length > 0) {
      lines.push(`${openSlots.length} open player slot(s) (${openSlots.map(n => n.name).join(', ')}). Until a player joins, the DM controls these as NPCs.`);
    }
    if (reservedSlots.length > 0) {
      const details = reservedSlots.map(n => `${n.name} (reserved for ${companionReservations[n.id]})`).join(', ');
      lines.push(`Reserved player slot(s): ${details}. Until the reserved player joins, the DM controls these as NPCs.`);
    }
    if (activeCompanions.length === 0 && openSlots.length === 0 && reservedSlots.length === 0) {
      lines.push('The player is adventuring solo — no NPC companions in the party.');
    }
    return lines.join('\n');
  }

  function handleStartSession() {
    if (isGuest) {
      alert('Please log in to start a new session.');
      return;
    }
    const character = characters.find(c => c.id === selectedCharacter);
    setSessionReadOnly(false);
    setSessionSettings({ visibility: 'public', turnMode: 'initiative' });
    setGateRevealedUpTo(-1); // Reset gate for new session

    const hasPlayerSlots = npcs.some(n => companionStates[n.id] === 'player' || companionStates[n.id] === 'reserved');

    if (mode === 'campaigns') {
      if (!selectedCharacter || !selectedCampaign) return;
      // Use campaign ID as the scenario ID for session save/load compatibility
      setSavedSessionDbId(null);
      setSelectedScenario(selectedCampaign);
      startSession(selectedCharacter, selectedCampaign, player, campaignId);
      setSessionActive(true);

      const campaign = campaigns.find(c => c.id === selectedCampaign);
      const settingName = campaign?.setting?.name || campaign?.title || 'Unknown';
      const startLocations = campaign?.wildernessStarts?.map(s => s.label).join(', ') || 'a random location';
      const companionRoster = buildCompanionRoster();
      const openingPrompt = `⚠️ NEW SESSION — CLEAN SLATE. Disregard any prior campaign context, characters, or story. This is a brand-new adventure starting from scratch.

You are running an open-world campaign: "${campaign?.title || 'Unknown'}". My character is ${character?.name || 'Unknown'}.

Party composition:
${companionRoster}

This is a free-exploration campaign, not a linear scenario. Here's how to run it:
- Drop the party at a random starting location in ${settingName} (choose from: ${startLocations})
- Describe the surrounding terrain, what the party can see, and any immediate points of interest
- The party can travel freely in any direction — there is no set quest or path
- Scattered across the region are adventure locations linked to this campaign's scenarios that the party may discover through travel
- When the party approaches a scenario location, run its associated storyline organically
- Between locations, improvise events: random encounters, environmental hazards, foraging, ruins, travelers, wildlife, and environmental storytelling
- Use the exploration rules: ${campaign?.explorationRules || 'each day of travel, consider encounters and discoveries'}
- Let the player drive the direction — be a sandbox DM

Set the opening scene now. Describe where the party wakes up, what they see, and what choices lie before them.`;

      if (hasPlayerSlots) {
        setPendingOpeningPrompt(openingPrompt);
        setTimeout(() => sendMessageRaw(`This is a multiplayer session. I'm waiting for companion players to join and select their characters. Please respond with a brief greeting and let me know you're ready — I'll tell you when to begin the adventure.`), 500);
      } else {
        setTimeout(() => sendMessageRaw(openingPrompt), 500);
      }
    } else {
      if (!selectedCharacter || !selectedScenario) return;
      setSavedSessionDbId(null);
      startSession(selectedCharacter, selectedScenario, player, campaignId);
      setSessionActive(true);

      const scenario = scenarios.find(s => s.id === selectedScenario);
      const companionRoster = buildCompanionRoster();
      const openingPrompt = `⚠️ NEW SESSION — CLEAN SLATE. Disregard any prior campaign context, characters, or story. This is a brand-new adventure starting from scratch.

Begin the adventure "${scenario?.title || 'Unknown'}". My character is ${character?.name || 'Unknown'}.

Party composition:
${companionRoster}

Set the scene and begin the story.`;

      if (hasPlayerSlots) {
        setPendingOpeningPrompt(openingPrompt);
        setTimeout(() => sendMessageRaw(`This is a multiplayer session. I'm waiting for companion players to join and select their characters. Please respond with a brief greeting and let me know you're ready — I'll tell you when to begin the adventure.`), 500);
      } else {
        setTimeout(() => sendMessageRaw(openingPrompt), 500);
      }
    }
  }

  async function handleSave() {
    if (isGuest) {
      alert('Please log in to save sessions.');
      return;
    }
    if (sessionReadOnly || isCompanion) {
      return;
    }
    setSaveStatus('saving');
    try {
      const scenario = scenarios.find(s => s.id === selectedScenario);
      const campaign = campaigns.find(c => c.id === selectedScenario);
      const name = `${campaign?.title || scenario?.title || 'Adventure'} — ${new Date().toLocaleDateString()}`;
      const payload = {
        name,
        claudeSessionId: sessionId,
        characterId: selectedCharacter,
        scenarioId: selectedScenario,
        messages: messages.filter(m => m.type !== 'dm_partial'),
        playerEmail: player?.email || null,
        playerName: player?.name || null,
        companionConfig: {
          states: companionStates,
          reservations: companionReservations,
        },
      };

      console.log(`[Save] Payload — messages: ${payload.messages.length}, claudeSessionId: ${payload.claudeSessionId ? 'yes' : 'no'}`);
      let result;
      if (savedSessionDbId) {
        result = await api.updateSession(savedSessionDbId, payload);
      } else {
        result = await api.createSession(payload);
        setSavedSessionDbId(result.id);
        if (sessionLabel.trim()) {
          api.renameSession(result.id, sessionLabel.trim()).catch(() => {});
        }
      }
      watchSession(result.id, player);
      setSessionReadOnly(result.readOnly === true);
      console.log(`[Save] Success — session ${result.id}, messages in response: ${(result.messages || []).length}`);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 2000);
    } catch (err) {
      console.error('Save failed:', err);
      if (err?.message) alert(`Save failed: ${err.message}`);
      setSaveStatus(null);
    }
  }

  async function handleRenameSession(e, id) {
    e.stopPropagation();
    const session = savedSessions.find(s => s.id === id);
    const current = session?.label || '';
    const label = window.prompt('Enter a label for this session (or clear to remove):', current);
    if (label === null) return; // cancelled
    try {
      await api.renameSession(id, label || null);
      setSavedSessions(prev => prev.map(s => s.id === id ? { ...s, label: label || null } : s));
    } catch (err) {
      console.error('Rename failed:', err);
      alert('Rename failed: ' + err.message);
    }
  }

  async function handleJoinSession(e, sessionId, npcId) {
    e.stopPropagation();
    if (isGuest) { alert('Please log in to join a session.'); return; }
    try {
      await api.joinSession(sessionId, npcId);
      // Reload the session as a participant
      handleLoadSession(sessionId);
    } catch (err) {
      alert('Join failed: ' + (err.message || 'Unknown error'));
    }
  }

  async function handleUnjoinSession(e, sessionId, npcId) {
    e.stopPropagation();
    try {
      const result = await api.unjoinSession(sessionId, npcId);
      // Update the session card's slot data in place
      setSavedSessions(prev => prev.map(s =>
        s.id === sessionId ? { ...s, companionSlots: result.companionSlots } : s
      ));
    } catch (err) {
      alert('Unjoin failed: ' + (err.message || 'Unknown error'));
    }
  }

  async function handleDeleteSession(e, id) {
    e.stopPropagation();
    if (!window.confirm('Delete this saved session? This cannot be undone.')) return;
    try {
      await api.deleteSession(id);
      setSavedSessions(prev => prev.filter(s => s.id !== id));
    } catch (err) {
      console.error('Delete failed:', err);
    }
  }

  async function handleLoadSession(id) {
    setLoadingSessionId(id);
    try {
      const session = await api.getSession(id);
      console.log(`[Load] Session ${id} — messages: ${(session.messages || []).length}, claudeSessionId: ${session.claudeSessionId ? 'yes' : 'no'}`);
      setSelectedCharacter(session.characterId);
      setSelectedScenario(session.scenarioId);
      setSavedSessionDbId(session.id);
      const readOnly = session.readOnly === true || session.canWrite === false;
      setSessionReadOnly(readOnly);
      setSessionSettings(session.settings || { visibility: 'public' });
      if (session.companionConfig) {
        setCompanionStates(session.companionConfig.states || {});
        setCompanionReservations(session.companionConfig.reservations || {});
      }
      const loadedMessages = normalizeSavedMessages(session.messages);
      setMessages(loadedMessages);
      setGateRevealedUpTo(loadedMessages.length); // Show all loaded history — gate only new messages
      if (loadedMessages.length === 0) {
        console.warn('[Load] No messages found in saved session — session may not have been saved properly');
      }
      watchSession(session.id, player);
      if (!readOnly) {
        resumeSession(session.claudeSessionId, session.characterId, session.scenarioId, loadedMessages, player, campaignId);
      }
      setSessionActive(true);
    } catch (err) {
      console.error('Load failed:', err);
      alert(`Load failed: ${err.message}`);
    } finally {
      setLoadingSessionId(null);
    }
  }

  function handleExportStory() {
    const storyMessages = messages.filter(m => m.type !== 'dm_partial' && m.type !== 'system');
    if (storyMessages.length === 0) return;
    const text = storyMessages.map(m => m.text).join('\n\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeCampaign?.title || activeScenario?.title || 'Adventure'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleExportSession() {
    const payload = {
      name: `${scenarios.find(s => s.id === selectedScenario)?.title || 'Adventure'} — ${new Date().toLocaleDateString()}`,
      characterId: selectedCharacter,
      scenarioId: selectedScenario,
      messages: messages.filter(m => m.type !== 'dm_partial'),
      playerEmail: player?.email || null,
      playerName: player?.name || null,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${payload.name.replace(/[^a-z0-9]+/gi, '-')}.session.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleImportSession(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (isGuest) {
      alert('Please log in to import sessions.');
      e.target.value = '';
      return;
    }
    try {
      if (!file.name.endsWith('.json')) {
        alert('Please select a .session.json file exported via "Export Session". Plain text story exports (.txt) cannot be imported.');
        return;
      }
      const text = await file.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        alert('This file is not valid JSON. Please use a .session.json file exported via "Export Session" (not "Export Story").');
        return;
      }
      if (!data.messages || !Array.isArray(data.messages)) {
        alert('Invalid session file: missing messages array. Please use a file exported via "Export Session".');
        return;
      }
      const normalizedMessages = normalizeSavedMessages(data.messages);
      if (normalizedMessages.length === 0) {
        alert('Invalid session file: no usable messages found.');
        return;
      }
      const result = await api.createSession({
        name: data.name || file.name,
        characterId: data.characterId || null,
        scenarioId: data.scenarioId || null,
        messages: normalizedMessages,
        playerEmail: player?.email || data.playerEmail || null,
        playerName: player?.name || data.playerName || null,
      });
      setSavedSessions(prev => [result, ...prev]);
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    }
    // Reset file input so same file can be re-imported
    e.target.value = '';
  }

  async function handleUpdateSetting(key, value) {
    if (!savedSessionDbId || sessionReadOnly) return;
    const updated = { ...sessionSettings, [key]: value };
    setSessionSettings(updated);
    try {
      await api.updateSessionSettings(savedSessionDbId, { [key]: value });
    } catch (err) {
      console.error('Settings update failed:', err);
      setSessionSettings(sessionSettings); // revert on failure
    }
  }

  function handleSend() {
    const text = input.trim();
    if (!text || status === 'thinking' || sessionReadOnly) return;
    const turnMode = sessionSettings.turnMode || 'host-decides';
    const hasCompanions = sessionParticipants.some(p => p.companionNpcId);

    // Clear typing indicator
    isTypingRef.current = false;
    clearTimeout(typingTimerRef.current);
    sendTypingStatus(false);

    // When companions are present, always queue the host's turn and wait
    if (hasCompanions) {
      isNearBottomRef.current = true;
      setShowScrollBtn(false);
      submitHostTurnReady(text);
      setInput('');
      return;
    }

    // No companions: send immediately
    isNearBottomRef.current = true;
    setShowScrollBtn(false);
    sendMessageRaw(text, turnMode);
    setInput('');
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const statusInfo = STATUS_CONFIG[status] || STATUS_CONFIG.disconnected;

  // Setup screen
  if (!sessionActive) {
    return (
      <div className="adventure-setup">
        <h2>Begin Your Adventure</h2>
        <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem' }}>
          Choose your character and a scenario or campaign, then step into the story.
        </p>

        <div className="setup-selections">
          <div className="setup-group">
            <label>Character</label>
            <div className="setup-options">
              {characters.filter(c => c.status !== 'dead').map(c => (
                <button
                  key={c.id}
                  className={`option-card${selectedCharacter === c.id ? ' selected' : ''}`}
                  onClick={() => setSelectedCharacter(c.id)}
                >
                  <strong>{c.name}</strong>
                  <span>Level {c.level} {c.subrace ? (c.subrace.toLowerCase().includes(c.race.toLowerCase()) ? c.subrace : `${c.subrace} ${c.race}`) : c.race} {c.class}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="setup-group">
            <label>Companions</label>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: '0 0 0.5rem' }}>
              Click to cycle: <strong>In Party</strong> &rarr; <strong>Removed</strong> &rarr; <strong>Player Slot</strong>{friends.length > 0 ? <> &rarr; <strong>Reserved For</strong></> : ''}
            </p>
            <div className="setup-options">
              {npcs.filter(n => n.status !== 'dead').map(n => {
                const state = companionStates[n.id] || 'selected';
                const reservedEmail = companionReservations[n.id];
                return (
                  <div key={n.id} className={`option-card companion-card companion-${state}`} style={{ position: 'relative' }}>
                    <button
                      className="companion-card-btn"
                      onClick={() => cycleCompanionState(n.id)}
                    >
                      <strong>{n.name}</strong>
                      <span>Level {n.level} {n.subrace ? (n.subrace.toLowerCase().includes(n.race.toLowerCase()) ? n.subrace : `${n.subrace} ${n.race}`) : n.race} {n.class}</span>
                      <span className="companion-state-label">
                        {state === 'selected' ? 'In Party'
                          : state === 'removed' ? 'Removed'
                          : state === 'player' ? 'Player Slot'
                          : `Reserved: ${friendNames[reservedEmail] || reservedEmail}`}
                      </span>
                    </button>
                    {state === 'reserved' && friends.length > 1 && (
                      <button
                        className="btn-session-action reserve-change-btn"
                        onClick={(e) => toggleReserveDropdown(e, n.id)}
                        title="Change reserved player"
                      >
                        &#x25BE;
                      </button>
                    )}
                    {reserveDropdownNpc === n.id && (
                      <div className="reserve-dropdown">
                        <div className="reserve-dropdown-header">Reserve for:</div>
                        {friends.map(email => (
                          <button
                            key={email}
                            className={`reserve-dropdown-item${email === reservedEmail ? ' reserve-dropdown-active' : ''}`}
                            onClick={() => handleReserveFor(n.id, email)}
                          >
                            {friendNames[email] || email}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="setup-group">
            <div className="mode-toggle">
              <button
                className={`mode-toggle-btn${mode === 'campaigns' ? ' active' : ''}`}
                onClick={() => { setMode('campaigns'); setSelectedScenario(null); }}
              >
                Campaigns
              </button>
              <button
                className={`mode-toggle-btn${mode === 'scenarios' ? ' active' : ''}`}
                onClick={() => { setMode('scenarios'); setSelectedCampaign(null); }}
              >
                Scenarios
              </button>
            </div>

            {mode === 'scenarios' ? (
              <div className="setup-options">
                {scenarios.map(s => (
                  <button
                    key={s.id}
                    className={`option-card${selectedScenario === s.id ? ' selected' : ''}`}
                    onClick={() => setSelectedScenario(s.id)}
                  >
                    <strong>{s.title}</strong>
                    <span>{s.synopsis ? s.synopsis.substring(0, 80) + '...' : ''}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="setup-options">
                {campaigns.filter(c => c.id === campaignId).map(c => (
                  <button
                    key={c.id}
                    className={`option-card campaign-card${selectedCampaign === c.id ? ' selected' : ''}`}
                    onClick={() => setSelectedCampaign(c.id)}
                  >
                    <strong>{c.title}</strong>
                    <span className="campaign-subtitle">{c.subtitle}</span>
                    <span className="campaign-meta">Levels {c.levelRange} &middot; {c.estimatedSessions} sessions</span>
                    <span>{c.synopsis ? c.synopsis.substring(0, 100) + '...' : ''}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="session-label-input-row">
          <input
            type="text"
            className="session-label-input"
            placeholder="Session label (optional)"
            value={sessionLabel}
            onChange={e => setSessionLabel(e.target.value)}
            maxLength={60}
          />
        </div>

        <button
          className="btn-primary begin-btn"
          disabled={isGuest || !selectedCharacter || (mode === 'scenarios' ? !selectedScenario : !selectedCampaign) || status === 'disconnected'}
          onClick={handleStartSession}
        >
          {status === 'disconnected' ? 'Connecting...' : (isGuest ? 'Login Required to Begin' : 'Begin Adventure')}
        </button>
        {isGuest && (
          <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem' }}>
            Guests can browse and view saved sessions, but cannot create new sessions or campaigns.
          </p>
        )}

        <div className="setup-group" style={{ marginTop: '2rem' }}>
          <label>Load Saved Session</label>
          <div className="setup-options setup-options-sessions">
            {savedSessions.map((s, i) => {
              const isRecent = s.updatedAt && (Date.now() - new Date(s.updatedAt).getTime()) < 5 * 60 * 1000;
              return (
              <div key={`${s.id}-${i}`} className="option-card saved-session-card" style={{ position: 'relative' }}>
                <span
                  className="session-activity-dot"
                  title={isRecent ? 'Active in the last 5 minutes' : 'No recent activity'}
                  style={{
                    position: 'absolute',
                    top: '0.55rem',
                    left: '0.55rem',
                    width: '0.55rem',
                    height: '0.55rem',
                    borderRadius: '50%',
                    background: isRecent ? '#2ecc71' : '#e74c3c',
                    boxShadow: isRecent ? '0 0 4px #2ecc71' : 'none',
                    flexShrink: 0,
                    zIndex: 1,
                  }}
                />
                <button
                  className="option-card-inner"
                  onClick={() => handleLoadSession(s.id)}
                  disabled={loadingSessionId === s.id}
                  style={{
                    all: 'unset',
                    cursor: loadingSessionId === s.id ? 'wait' : 'pointer',
                    opacity: loadingSessionId === s.id ? 0.7 : 1,
                    display: 'flex',
                    flexDirection: 'column',
                    width: '100%',
                    paddingLeft: '0.8rem',
                  }}
                >
                  <strong>{s.name}</strong>
                  {s.label && <span className="session-label">&ldquo;{s.label}&rdquo;</span>}
                  <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                    <span>Player: {s.playerName || s.playerEmail || 'Unknown'}</span>
                    <span className="session-short-id">#{s.id.slice(-8)}</span>
                  </span>
                  <span>
                    {s.canWrite === false ? 'Read only' : 'Editable'}
                    {s.settings?.visibility === 'public' ? ' · Public' : ''}
                    {s.companionSlots && (s.companionSlots.open > 0 || s.companionSlots.reserved > 0) ? ` · ${s.companionSlots.open + s.companionSlots.reserved} slot(s) available` : ''}
                  </span>
                  <span>
                    {loadingSessionId === s.id ? 'Loading...' : `${s.messageCount} messages — ${formatSavedSessionDate(s.updatedAt)}`}
                  </span>
                  {loadingSessionId !== s.id && (
                    <span className="saved-session-time">{formatSavedSessionTime(s.updatedAt)}</span>
                  )}
                  {s.lastPlayerName && (
                    <span style={{ fontSize: '0.8em', color: 'var(--text-muted)', opacity: 0.85 }}>
                      Last played: {s.lastPlayerName}{s.updatedAt ? ` · ${formatSavedSessionDate(s.updatedAt)} ${formatSavedSessionTime(s.updatedAt)}` : ''}
                    </span>
                  )}
                </button>
                {s.companionSlots && s.companionSlots.slots.length > 0 && (
                  <div className="session-slots">
                    {s.companionSlots.slots.map(sl => {
                      const npc = npcs.find(n => n.id === sl.npcId);
                      const isClaimed = !!sl.claimedBy;
                      const isMySlot = isClaimed && sl.claimedBy?.email === player?.email;
                      const canJoin = !isClaimed && (sl.type === 'player' || (sl.type === 'reserved' && sl.reservedFor === player?.email));
                      const canUnjoin = isClaimed && (isMySlot || s.canWrite);
                      return (
                        <div key={sl.npcId} className={`session-slot ${isClaimed ? 'session-slot-claimed' : canJoin ? 'session-slot-joinable' : 'session-slot-reserved'}`}>
                          <span className="session-slot-name">{npc?.name || sl.npcId}</span>
                          <span className="session-slot-type">
                            {isClaimed
                              ? `${sl.claimedBy.name}${sl.claimedBy.characterName ? ` as ${sl.claimedBy.characterName}` : ''}`
                              : sl.type === 'reserved' ? `Reserved: ${sl.reservedFor}` : 'Open'}
                          </span>
                          {canJoin && !isGuest && (
                            <button className="btn-join-slot" onClick={(e) => handleJoinSession(e, s.id, sl.npcId)}>
                              Join
                            </button>
                          )}
                          {canUnjoin && (
                            <button className="btn-unjoin-slot" onClick={(e) => handleUnjoinSession(e, s.id, sl.npcId)}>
                              Unjoin
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {s.canWrite !== false && (
                  <div style={{ position: 'absolute', top: '0.4rem', right: '0.4rem', display: 'flex', gap: '0.2rem' }}>
                    <button
                      className="btn-session-action"
                      onClick={(e) => handleRenameSession(e, s.id)}
                      title="Rename session"
                    >
                      &#x270E;
                    </button>
                    <button
                      className="btn-session-action btn-session-delete"
                      onClick={(e) => handleDeleteSession(e, s.id)}
                      title="Delete session"
                    >
                      &times;
                    </button>
                  </div>
                )}
              </div>
              );
            })}
          </div>
          <label
            className="btn-primary"
            style={{
              display: 'inline-block', marginTop: '0.75rem', cursor: isGuest ? 'not-allowed' : 'pointer',
              fontSize: '0.9rem', padding: '0.5rem 1.2rem', opacity: isGuest ? 0.6 : 1,
            }}
          >
            Import Session File
            <input
              type="file"
              accept=".json,.session.json"
              onChange={handleImportSession}
              disabled={isGuest}
              style={{ display: 'none' }}
            />
          </label>
        </div>
      </div>
    );
  }

  // Active adventure screen
  const activeCharacter = characters.find(c => c.id === selectedCharacter);
  const activeScenario = scenarios.find(s => s.id === selectedScenario);
  const activeCampaign = campaigns.find(c => c.id === selectedScenario);

  return (
    <div className="adventure-container">
        {/* Session info bar */}
        <div className="adventure-header">
          <div className="adventure-info">
            <span className="adventure-scenario">{activeCampaign?.title || activeScenario?.title}</span>
            {isCompanion
              ? <span className="adventure-character">Playing as {companionCharacter?.name || companionNpc?.name || 'Companion'}</span>
              : <span className="adventure-character">{activeCharacter?.name}</span>
            }
            {isObserver && <span className="adventure-character">👻 Observing{sessionAccess.ownerName ? ` ${sessionAccess.ownerName}'s game` : ''}</span>}
          </div>
          <button
            className="btn-save"
            onClick={handleSave}
            disabled={sessionReadOnly || saveStatus === 'saving' || status === 'disconnected'}
          >
            {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved!' : 'Save'}
          </button>
          <button
            className="btn-save"
            onClick={handleExportStory}
            disabled={messages.filter(m => m.type !== 'dm_partial' && m.type !== 'system').length === 0}
          >
            Export Story
          </button>
          <button
            className="btn-save"
            onClick={handleExportSession}
            disabled={messages.filter(m => m.type !== 'dm_partial').length === 0}
          >
            Export Session
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.85rem', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={autoSave}
              disabled={sessionReadOnly}
              onChange={e => setAutoSave(e.target.checked)}
            />
            Auto-save
          </label>
          <button
            className="btn-save"
            onClick={() => setShowSettings(s => !s)}
            title="Session Settings"
          >
            Settings
          </button>
          <div className={`status-indicator ${statusInfo.className}`}>
            <span className="status-dot" />
            <span className="status-label">{statusInfo.label}</span>
          </div>
        </div>

        {/* Session settings panel */}
        {showSettings && (
          <div className="session-settings-panel">
            <div className="session-settings-row">
              <span className="session-settings-label">Visibility</span>
              <div className="mode-toggle" style={{ marginBottom: 0 }}>
                <button
                  className={`mode-toggle-btn${sessionSettings.visibility === 'private' ? ' active' : ''}`}
                  onClick={() => handleUpdateSetting('visibility', 'private')}
                  disabled={sessionReadOnly || !savedSessionDbId}
                >
                  Private
                </button>
                <button
                  className={`mode-toggle-btn${sessionSettings.visibility === 'public' ? ' active' : ''}`}
                  onClick={() => handleUpdateSetting('visibility', 'public')}
                  disabled={sessionReadOnly || !savedSessionDbId}
                >
                  Public
                </button>
              </div>
              <span className="session-settings-hint">
                {sessionSettings.visibility === 'public'
                  ? 'Other players can see and load this session (read-only).'
                  : 'Only you can see this session.'}
              </span>
            </div>
            <div className="session-settings-row">
              <span className="session-settings-label">Turn Mode</span>
              <div className="mode-toggle" style={{ marginBottom: 0 }}>
                <button
                  className={`mode-toggle-btn${sessionSettings.turnMode === 'initiative' ? ' active' : ''}`}
                  onClick={() => handleUpdateSetting('turnMode', 'initiative')}
                  disabled={sessionReadOnly || !savedSessionDbId}
                  title="Classic D&D initiative order — roll for turn order each combat"
                >
                  Initiative
                </button>
                <button
                  className={`mode-toggle-btn${sessionSettings.turnMode === 'ready-golf' ? ' active' : ''}`}
                  onClick={() => handleUpdateSetting('turnMode', 'ready-golf')}
                  disabled={sessionReadOnly || !savedSessionDbId}
                  title="Players submit when ready — first come, first served"
                >
                  Ready Golf
                </button>
                <button
                  className={`mode-toggle-btn${sessionSettings.turnMode === 'host-decides' ? ' active' : ''}`}
                  onClick={() => handleUpdateSetting('turnMode', 'host-decides')}
                  disabled={sessionReadOnly || !savedSessionDbId}
                  title="Host picks who goes next each round"
                >
                  Host Decides
                </button>
              </div>
              <span className="session-settings-hint">
                {sessionSettings.turnMode === 'initiative'
                  ? 'Classic initiative — roll for turn order each combat.'
                  : sessionSettings.turnMode === 'ready-golf'
                  ? 'Players submit actions when ready — first come, first served.'
                  : 'The host picks who goes next each round.'}
              </span>
            </div>
            {!savedSessionDbId && (
              <p className="session-settings-hint" style={{ marginTop: '0.5rem' }}>
                Save the session first to change settings.
              </p>
            )}
          </div>
        )}

        {/* Party status board */}
        <div className="party-status-board">
          {/* Host */}
          {(() => {
            const hostOnline = sessionParticipants.some(p => p.isHost);
            const hostName = isHost ? (player?.name || 'Host') : (sessionAccess.ownerName || 'Host');
            return (
              <button
                className={`party-status-entry party-status-host ${selectedStatusEntry === 'host' ? 'party-status-selected' : ''}`}
                onClick={() => setSelectedStatusEntry(selectedStatusEntry === 'host' ? null : 'host')}
              >
                <span className={`party-status-dot ${isHost || hostOnline ? 'online' : 'offline'}`} />
                <span className="party-status-name">{activeCharacter?.name || 'Host'}</span>
                <span className="party-status-role">
                  {hostName} (Host){!isHost && !hostOnline ? ' · Offline' : ''}
                  {Object.values(typingPlayers).some(t => t.isHost) ? ' · Typing...' : ''}
                </span>
              </button>
            );
          })()}
          {/* Companion NPCs — player-controlled or AI */}
          {npcs.filter(n => {
            const state = companionStates[n.id];
            return state !== 'removed' && n.status !== 'dead';
          }).map(n => {
            const state = companionStates[n.id] || 'selected';
            const participant = sessionParticipants.find(p => p.companionNpcId === n.id);
            const isOnline = !!participant;
            const turn = companionTurns.find(t => t.npcId === n.id);
            const isPlayerControlled = state === 'player' || state === 'reserved';
            // Use companion's chosen character name: from server broadcast, or local state if this is our own slot
            const isMySlot = isCompanion && n.id === sessionAccess.companionNpcId;
            const displayName = (isMySlot && companionCharacter?.name)
              || (isOnline && participant.companionCharacterName)
              || n.name;
            return (
              <button
                key={n.id}
                className={`party-status-entry ${isPlayerControlled ? 'party-status-companion' : 'party-status-npc'} ${selectedStatusEntry === n.id ? 'party-status-selected' : ''}`}
                onClick={() => setSelectedStatusEntry(selectedStatusEntry === n.id ? null : n.id)}
              >
                <span className={`party-status-dot ${isPlayerControlled ? (isOnline ? 'online' : 'offline') : 'ai'}`} />
                <span className="party-status-name">{displayName}</span>
                {isPlayerControlled ? (
                  <span className="party-status-role">
                    {isOnline ? participant.playerName : (companionReservations[n.id] ? friendNames[companionReservations[n.id]] || companionReservations[n.id] : 'Unjoined')}
                    {turn ? ' · Ready' : isOnline && typingPlayers[participant?.playerEmail] ? ' · Typing...' : isOnline ? ' · Your turn' : ' · Not in session'}
                  </span>
                ) : (
                  <span className="party-status-role">NPC</span>
                )}
              </button>
            );
          })}
        </div>
        {/* Character/NPC detail panel */}
        {selectedStatusEntry && (() => {
          const entry = selectedStatusEntry === 'host'
            ? activeCharacter
            : npcs.find(n => n.id === selectedStatusEntry);
          if (!entry) return null;
          return (
            <div className="party-detail-panel">
              <div className="party-detail-header">
                <strong>{entry.name}</strong>
                <button className="party-detail-close" onClick={() => setSelectedStatusEntry(null)}>✕</button>
              </div>
              <div className="party-detail-stats">
                <span>Level {entry.level} {entry.subrace ? (entry.subrace.toLowerCase().includes(entry.race.toLowerCase()) ? entry.subrace : `${entry.subrace} ${entry.race}`) : entry.race} {entry.class}</span>
                <span>HP: {entry.hitPoints?.current ?? '?'}/{entry.hitPoints?.max ?? '?'} · AC: {entry.armorClass ?? '?'}</span>
                {entry.abilities && (
                  <span className="party-detail-abilities">
                    STR {entry.abilities.strength?.score} · DEX {entry.abilities.dexterity?.score} · CON {entry.abilities.constitution?.score} · INT {entry.abilities.intelligence?.score} · WIS {entry.abilities.wisdom?.score} · CHA {entry.abilities.charisma?.score}
                  </span>
                )}
              </div>
            </div>
          );
        })()}

        {/* Story area */}
        <div className="story-area" ref={storyRef}>
          {messages.slice(0, gateInfo.renderUpTo).map((msg, i) => (
            <div key={i} className={`story-message story-${msg.type}`}>
              {msg.type === 'player' && (
                <div className="message-player">
                  <span className="message-sender">{activeCharacter?.name || 'You'}</span>
                  <p>{msg.text}</p>
                </div>
              )}
              {msg.type === 'companion' && (
                <div className="message-companion">
                  <span className="message-sender">{msg.characterName || 'Companion'}</span>
                  <p>{msg.text}</p>
                </div>
              )}
              {msg.type === 'dice_roll' && (
                <div className="message-dice">
                  <span className="message-sender">Dice</span>
                  <p className="dice-result">{msg.text}</p>
                </div>
              )}
              {(msg.type === 'dm' || msg.type === 'dm_partial') && (
                <div className="message-dm">
                  <span className="message-sender">Dungeon Master</span>
                  <RichText as="div" className="dm-narration" text={msg.text} />
                  {msg.type === 'dm_partial' && <span className="typing-cursor" />}
                </div>
              )}
              {msg.type === 'system' && (
                <div className="message-system">
                  {msg.companionNpcId
                    ? msg.text.includes('left')
                      ? `${msg.playerName} has left the session. ${npcs.find(n => n.id === msg.companionNpcId)?.name || msg.companionNpcId} returns to NPC companion control.`
                      : `${msg.text} (controlling ${npcs.find(n => n.id === msg.companionNpcId)?.name || msg.companionNpcId})`
                    : msg.text}
                </div>
              )}
            </div>
          ))}
          {isGated && (
            <div className="message-gate">
              <button className="message-gate-btn" onClick={handleShowMore}>
                Show more ({hiddenCount} message{hiddenCount !== 1 ? 's' : ''}) &#x25BC;
              </button>
            </div>
          )}
        </div>
        {showScrollBtn && (
          <button className="scroll-to-bottom-btn" onClick={scrollToBottom} title="Scroll to latest">
            &#x25BC;
          </button>
        )}

        {/* Companion turn actions — visible to all players when turns are pending */}
        {companionTurns.length > 0 && (
          <div className="companion-turns-panel">
            <div className="companion-turns-header">Companion Actions Submitted</div>
            {companionTurns.map(t => {
              const npc = npcs.find(n => n.id === t.npcId);
              return (
                <div key={t.playerEmail} className="companion-turn-entry turn-ready">
                  <span className="companion-turn-status-dot ready" />
                  <span className="companion-turn-npc">{t.characterName || npc?.name || t.npcId}</span>
                  <span className="companion-turn-player">({t.playerName})</span>
                  <span className="companion-turn-text">{t.text}</span>
                  {isHost && (
                    <button
                      className="companion-turn-skip"
                      onClick={() => skipCompanion(t.playerEmail)}
                      title="Remove this turn"
                    >
                      ✕
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Input area */}
        {isCompanion ? (
          !companionCharacterId ? (
            <div className="companion-character-picker">
              <label>Choose your character for this session:</label>
              <div className="setup-options">
                {characters.filter(c => {
                  if (c.status === 'dead') return false;
                  // Exclude characters whose name matches the host's character, another companion's character, or an active NPC
                  const takenNames = new Set();
                  // Host's character name (from participants broadcast)
                  for (const p of sessionParticipants) {
                    if (p.isHost && p.characterName) {
                      takenNames.add(p.characterName.toLowerCase());
                    }
                    // Other companions' chosen characters
                    if (!p.isHost && p.companionCharacterName && p.playerEmail !== player?.email) {
                      takenNames.add(p.companionCharacterName.toLowerCase());
                    }
                  }
                  // Active NPC names (companion replaces one NPC, but shouldn't share a name with others)
                  for (const n of npcs) {
                    if (n.id !== companionNpc?.id && n.status !== 'dead') {
                      takenNames.add(n.name.toLowerCase());
                    }
                  }
                  return !takenNames.has(c.name.toLowerCase());
                }).map(c => (
                  <button
                    key={c.id}
                    className="option-card"
                    onClick={() => {
                      setCompanionCharacterId(c.id);
                      setCompanionCharacter(c.id, c.name, companionNpc?.name, c);
                      // Auto-announce arrival
                      setTimeout(() => submitCompanionTurn("I'm here.", {
                        npcName: companionNpc?.name,
                        characterName: c.name,
                        characterId: c.id,
                      }), 300);
                    }}
                  >
                    <strong>{c.name}</strong>
                    <span>Level {c.level} {c.subrace ? (c.subrace.toLowerCase().includes(c.race.toLowerCase()) ? c.subrace : `${c.subrace} ${c.race}`) : c.race} {c.class}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="adventure-input-bar companion-input-bar">
              {companionTurnSubmitted ? (
                <div className="companion-waiting">
                  Turn submitted — waiting for host to advance.
                  <button className="btn-retract" onClick={() => retractCompanionTurn()}>
                    Retract
                  </button>
                </div>
              ) : (
                <>
                  <textarea
                    className="adventure-input"
                    value={companionInput}
                    onChange={e => { setCompanionInput(e.target.value); handleTypingInput(e.target.value); }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        if (companionInput.trim() && status !== 'thinking') {
                          isTypingRef.current = false; clearTimeout(typingTimerRef.current); sendTypingStatus(false);
                          submitCompanionTurn(companionInput.trim(), {
                            npcName: companionNpc?.name,
                            characterName: companionCharacter?.name,
                            characterId: companionCharacterId,
                          });
                        }
                      }
                    }}
                    placeholder={status === 'thinking' ? 'The DM is narrating...' : `What does ${companionCharacter?.name || companionNpc?.name || 'your character'} do?`}
                    disabled={status === 'thinking'}
                    rows={1}
                  />
                  <button
                    className="btn-send"
                    onClick={() => {
                      if (companionInput.trim()) {
                        isTypingRef.current = false; clearTimeout(typingTimerRef.current); sendTypingStatus(false);
                        submitCompanionTurn(companionInput.trim(), {
                          npcName: companionNpc?.name,
                          characterName: companionCharacter?.name,
                          characterId: companionCharacterId,
                        });
                      }
                    }}
                    disabled={!companionInput.trim() || status === 'thinking'}
                  >
                    Submit
                  </button>
                </>
              )}
            </div>
          )
        ) : pendingOpeningPrompt ? (
          <div className="adventure-input-bar multiplayer-lobby-bar">
            <div className="multiplayer-lobby-status">
              Waiting for players to join...
              <span className="multiplayer-lobby-count">
                {sessionParticipants.filter(p => p.companionNpcId).length} companion{sessionParticipants.filter(p => p.companionNpcId).length !== 1 ? 's' : ''} connected
              </span>
            </div>
            <button
              className="btn-send btn-start-adventure"
              onClick={() => {
                const prompt = pendingOpeningPrompt;
                setPendingOpeningPrompt(null);
                sendMessageRaw(prompt);
              }}
              disabled={status === 'thinking'}
            >
              Start Adventure
            </button>
          </div>
        ) : readyGolfStatus?.hostReady ? (
          <div className={`adventure-input-bar ready-golf-bar${readyGolfStatus.allReady ? ' all-ready' : ''}`}>
            <div className="companion-waiting">
              {readyGolfStatus.allReady
                ? `All players ready! (${readyGolfStatus.companionsReady}/${readyGolfStatus.companionsTotal} companions)`
                : `Turn queued — waiting for companions (${readyGolfStatus.companionsReady}/${readyGolfStatus.companionsTotal} ready)`
              }
              <button className="btn-retract" onClick={() => retractHostTurn()}>
                Retract
              </button>
              <button className={`btn-continue${readyGolfStatus.allReady ? ' btn-continue-ready' : ''}`} onClick={() => forceHostTurn()}>
                Continue
              </button>
            </div>
          </div>
        ) : (
          <div className="adventure-input-bar">
            <textarea
              ref={inputRef}
              className="adventure-input"
              value={input}
              onChange={e => { setInput(e.target.value); handleTypingInput(e.target.value); }}
              onKeyDown={handleKeyDown}
              placeholder={sessionReadOnly ? 'Viewing live session (read-only)' : (status === 'thinking' ? 'The DM is narrating...' : 'What do you do?')}
              disabled={sessionReadOnly || status === 'thinking' || status === 'awaiting_permission'}
              rows={1}
            />
            <button
              className="btn-send"
              onClick={handleSend}
              disabled={sessionReadOnly || !input.trim() || status === 'thinking'}
            >
              {sessionParticipants.some(p => p.companionNpcId) ? 'Ready' : 'Send'}
            </button>
          </div>
        )}

        {/* Permission modal */}
        {permissionRequest && (
          <div className="permission-overlay">
            <div className="permission-modal">
              <h3>The DM Requests Permission</h3>
              <p className="permission-description">{permissionRequest.description}</p>
              <p className="permission-tool">Tool: <code>{permissionRequest.toolName}</code></p>
              {permissionRequest.input?.file_path && (
                <p className="permission-detail">File: <code>{permissionRequest.input.file_path}</code></p>
              )}
              {permissionRequest.input?.command && (
                <p className="permission-detail">Command: <code>{permissionRequest.input.command}</code></p>
              )}
              <div className="permission-actions">
                <button
                  className="btn-allow"
                  onClick={() => sendPermission(permissionRequest.toolUseID, true)}
                >
                  Allow
                </button>
                <button
                  className="btn-deny"
                  onClick={() => sendPermission(permissionRequest.toolUseID, false)}
                >
                  Deny
                </button>
              </div>
            </div>
          </div>
        )}
    </div>
  );
}

export default Adventure;
