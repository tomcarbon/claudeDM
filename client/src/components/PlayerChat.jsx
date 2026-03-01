import { useState, useLayoutEffect, useRef } from 'react';
import { usePlayer } from '../context/PlayerContext';
import { api } from '../api/client';
import RichText from './RichText';

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function formatTime(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function isGuestName(name) {
  const normalized = (name || '').trim().toLowerCase();
  return !normalized || normalized === 'guest';
}

function isPresenceSystemMessage(text) {
  const normalized = String(text || '').trim().toLowerCase();
  return /^player .+ has (joined|left)\.$/.test(normalized);
}

function formatOnlinePlayers(onlinePlayers, selfChatConnectionId) {
  const participants = Array.isArray(onlinePlayers) ? onlinePlayers : [];
  const guestTotal = participants.reduce((count, participant) =>
    count + (isGuestName(participant?.playerName) ? 1 : 0), 0
  );
  let guestIndex = 0;

  return participants.map((participant) => {
    const name = (participant?.playerName || '').trim();
    const isYou = participant?.connectionId === selfChatConnectionId;
    if (isGuestName(name)) {
      guestIndex += 1;
      return {
        name: guestTotal > 1 ? `Guest ${guestIndex}` : 'Guest',
        isYou,
      };
    }
    return {
      name,
      isYou,
    };
  });
}

export default function PlayerChat({ chatMessages, onlinePlayers, selfChatConnectionId, onSend }) {
  const { player } = usePlayer();
  const [input, setInput] = useState('');
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveDates, setArchiveDates] = useState([]);
  const [selectedDate, setSelectedDate] = useState(null); // null = live today
  const [archivedMessages, setArchivedMessages] = useState([]);
  const [loadingArchive, setLoadingArchive] = useState(false);
  const messagesContainerRef = useRef(null);

  const rawMessages = selectedDate ? archivedMessages : chatMessages;
  const displayMessages = rawMessages.filter(msg =>
    !(msg?.isSystem && isPresenceSystemMessage(msg.text))
  );
  const onlineDisplayNames = formatOnlinePlayers(onlinePlayers, selfChatConnectionId);
  const today = todayStr();

  // Only auto-scroll if the user is already near the bottom;
  // if they've scrolled up to read earlier messages, leave them alone.
  const isNearBottomRef = useRef(true);

  useLayoutEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      const threshold = 150;
      isNearBottomRef.current =
        container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  useLayoutEffect(() => {
    if (selectedDate) return;
    if (!isNearBottomRef.current) return;
    const container = messagesContainerRef.current;
    if (!container) return;
    const frame = requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [chatMessages, selectedDate]);

  function handleOpenArchive() {
    setArchiveOpen(true);
    api.getChatDates().then(setArchiveDates).catch(() => setArchiveDates([]));
  }

  function handleSelectDate(date) {
    setArchiveOpen(false);
    if (date === today) {
      setSelectedDate(null);
      setArchivedMessages([]);
      return;
    }
    setSelectedDate(date);
    setLoadingArchive(true);
    api.getChatMessages(date)
      .then(data => setArchivedMessages(data.messages || []))
      .catch(() => setArchivedMessages([]))
      .finally(() => setLoadingArchive(false));
  }

  function handleBackToToday() {
    setSelectedDate(null);
    setArchivedMessages([]);
    setArchiveOpen(false);
  }

  function handleSend() {
    const text = input.trim();
    if (!text || !player) return;
    onSend(text);
    setInput('');
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="chat-panel">
      <div className="chat-panel-header">
        <span>Party Chat</span>
        <div className="chat-header-actions">
          {selectedDate ? (
            <button className="chat-archive-btn" onClick={handleBackToToday}>← Today</button>
          ) : archiveOpen ? (
            <button className="chat-archive-btn" onClick={() => setArchiveOpen(false)}>Cancel</button>
          ) : (
            <button className="chat-archive-btn" onClick={handleOpenArchive}>Archive</button>
          )}
        </div>
      </div>

      {archiveOpen ? (
        <div className="chat-archive-list">
          <div className="chat-archive-title">Select a day</div>
          {archiveDates.length === 0 ? (
            <div className="chat-empty">No past chats yet.</div>
          ) : (
            archiveDates.map(date => (
              <button
                key={date}
                className={`chat-archive-date-btn${date === today ? ' chat-archive-today' : ''}`}
                onClick={() => handleSelectDate(date)}
              >
                {formatDate(date)}{date === today ? ' — today' : ''}
              </button>
            ))
          )}
        </div>
      ) : (
        <>
          {selectedDate && (
            <div className="chat-date-banner">{formatDate(selectedDate)} — read only</div>
          )}
          <div className="chat-online-box">
            <div className="chat-online-title">Players Online ({onlineDisplayNames.length})</div>
            {onlineDisplayNames.length === 0 ? (
              <div className="chat-online-empty">No players online.</div>
            ) : (
              <div className="chat-online-list">
                {onlineDisplayNames.map((name, index) => (
                  <span key={`${name.name}-${index}`} className="chat-online-player">
                    {name.name}{name.isYou ? ' (You)' : ''}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="chat-messages" ref={messagesContainerRef}>
            {loadingArchive ? (
              <div className="chat-empty">Loading...</div>
            ) : displayMessages.length === 0 ? (
              <div className="chat-empty">
                {selectedDate
                  ? 'No messages on this day.'
                  : player ? 'No messages yet. Say hello!' : 'Log in to chat with your party.'}
              </div>
            ) : (
              displayMessages.map((msg, i) => (
                msg.isSystem ? (
                  <div key={i} className="chat-msg chat-msg-system">
                    <RichText as="span" className="chat-msg-system-text" text={msg.text} />
                  </div>
                ) : (
                  <div key={i} className={`chat-msg${msg.isAdmin ? ' chat-msg-admin' : ''}`}>
                    <span className="chat-msg-sender">
                      {msg.playerName}
                      {msg.timestamp && (
                        <span className="chat-msg-time">{formatTime(msg.timestamp)}</span>
                      )}
                    </span>
                    <RichText as="div" className="chat-msg-text" text={msg.text} />
                  </div>
                )
              ))
            )}
            {!selectedDate && <div className="chat-scroll-spacer" aria-hidden="true" />}
          </div>
          {!selectedDate && (
            <div className="chat-input-bar">
              <input
                type="text"
                className="chat-input"
                placeholder={player ? 'Message party...' : 'Login to chat'}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={!player}
              />
              <button
                className="chat-send-btn"
                onClick={handleSend}
                disabled={!input.trim() || !player}
              >
                Send
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
