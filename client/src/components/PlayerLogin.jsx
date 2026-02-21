import { useState } from 'react';
import { usePlayer } from '../context/PlayerContext';
import { api } from '../api/client';

export default function PlayerLogin() {
  const { player, login, logout } = usePlayer();
  const [mode, setMode] = useState('login'); // 'login' | 'register' | 'changePassword'
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  function resetForm() {
    setEmail('');
    setName('');
    setPassword('');
    setNewPassword('');
    setError('');
    setSuccess('');
  }

  async function handleLogin(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const playerData = await api.playerLogin(email.trim(), password);
      login(playerData);
      resetForm();
      setMode('login');
    } catch (err) {
      setError(err.message || 'Login failed.');
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const playerData = await api.playerRegister(email.trim(), name.trim(), password);
      login(playerData);
      resetForm();
      setMode('login');
    } catch (err) {
      setError(err.message || 'Registration failed.');
    } finally {
      setLoading(false);
    }
  }

  async function handleChangePassword(e) {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);
    try {
      await api.playerChangePassword(player.email, password, newPassword);
      setSuccess('Password updated!');
      setPassword('');
      setNewPassword('');
      setTimeout(() => { setSuccess(''); setMode('loggedIn'); }, 2000);
    } catch (err) {
      setError(err.message || 'Failed to change password.');
    } finally {
      setLoading(false);
    }
  }

  function handleLogout() {
    logout();
    resetForm();
    setMode('login');
  }

  // Logged in view
  if (player) {
    return (
      <div className="player-login-box">
        <div className="player-login-title">Logged In</div>
        <div className="player-info">
          {player.role === 'admin' && <span className="player-admin-badge">ADMIN</span>}
          <div className="player-name">{player.name}</div>
          <div className="player-email">{player.email}</div>
        </div>
        <div className="player-login-actions">
          <button className="player-btn" onClick={handleLogout}>Logout</button>
          <button
            className="player-btn player-btn-ghost"
            onClick={() => { setMode(mode === 'changePassword' ? 'loggedIn' : 'changePassword'); setError(''); setSuccess(''); setPassword(''); setNewPassword(''); }}
          >
            {mode === 'changePassword' ? 'Cancel' : 'Change Password'}
          </button>
        </div>
        {mode === 'changePassword' && (
          <form onSubmit={handleChangePassword} className="player-form">
            <input
              type="password"
              placeholder="Current password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="player-input"
              required
            />
            <input
              type="password"
              placeholder="New password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              className="player-input"
              required
            />
            {error && <div className="player-error">{error}</div>}
            {success && <div className="player-success">{success}</div>}
            <button type="submit" className="player-btn" disabled={loading}>
              {loading ? 'Updating...' : 'Update Password'}
            </button>
          </form>
        )}
      </div>
    );
  }

  // Register view
  if (mode === 'register') {
    return (
      <div className="player-login-box">
        <div className="player-login-title">Create Account</div>
        <form onSubmit={handleRegister} className="player-form">
          <input
            type="text"
            placeholder="Your name"
            value={name}
            onChange={e => setName(e.target.value)}
            className="player-input"
            required
          />
          <input
            type="text"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            className="player-input"
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="player-input"
            required
          />
          {error && <div className="player-error">{error}</div>}
          <button type="submit" className="player-btn" disabled={loading}>
            {loading ? 'Registering...' : 'Register'}
          </button>
          <button type="button" className="player-btn player-btn-ghost" onClick={() => { setMode('login'); setError(''); }}>
            Back to Login
          </button>
        </form>
      </div>
    );
  }

  // Login view (default)
  return (
    <div className="player-login-box">
      <div className="player-login-title">Player Login</div>
      <form onSubmit={handleLogin} className="player-form">
        <input
          type="text"
          placeholder="Your Name"
          value={email}
          onChange={e => setEmail(e.target.value)}
          className="player-input"
          required
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          className="player-input"
          required
        />
        {error && <div className="player-error">{error}</div>}
        <button type="submit" className="player-btn" disabled={loading}>
          {loading ? 'Logging in...' : 'Login'}
        </button>
        <button type="button" className="player-btn player-btn-ghost" onClick={() => { setMode('register'); setError(''); }}>
          Register
        </button>
      </form>
    </div>
  );
}
