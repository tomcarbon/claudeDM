import { createContext, useContext, useState } from 'react';

const PlayerContext = createContext(null);

export function PlayerProvider({ children }) {
  const [player, setPlayer] = useState(() => {
    try {
      const stored = localStorage.getItem('dnd_player');
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });

  function login(playerData) {
    setPlayer(playerData);
    localStorage.setItem('dnd_player', JSON.stringify(playerData));
  }

  function logout() {
    setPlayer(null);
    localStorage.removeItem('dnd_player');
  }

  return (
    <PlayerContext.Provider value={{ player, login, logout }}>
      {children}
    </PlayerContext.Provider>
  );
}

export function usePlayer() {
  return useContext(PlayerContext);
}
