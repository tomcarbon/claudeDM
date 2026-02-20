import { useState, useEffect, useRef } from 'react';
import { usePlayer } from '../context/PlayerContext';
import { api } from '../api/client';

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

export default function PlayerChat({ chatMessages, onSend }) {
  const { player } = usePlayer();
  const [input, setInput] = useState('');
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveDates, setArchiveDates] = useState([]);
  const [selectedDate, setSelectedDate] = useState(null); // null = live today
  const [archivedMessages, setArchivedMessages] = useState([]);
  const [loadingArchive, setLoadingArchive] = useState(false);
  const messagesEndRef = useRef(null);

  const displayMessages = selectedDate ? archivedMessages : chatMessages;
  const today = todayStr();

  // Auto-scroll to bottom in live view
  useEffect(() => {
    if (!selectedDate && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
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
          <div className="chat-messages">
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
                <div key={i} className={`chat-msg${msg.isAdmin ? ' chat-msg-admin' : ''}`}>
                  <span className="chat-msg-sender">
                    {msg.playerName}
                    {msg.timestamp && (
                      <span className="chat-msg-time">{formatTime(msg.timestamp)}</span>
                    )}
                  </span>
                  <span className="chat-msg-text">{msg.text}</span>
                </div>
              ))
            )}
            {!selectedDate && <div ref={messagesEndRef} />}
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
