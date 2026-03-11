// Notification sound utility using Web Audio API
// No audio files needed — sounds are synthesized in real-time

const STORAGE_KEY = 'dnd_audio_settings';

const DEFAULTS = {
  enabled: false,
  sound: 'bell',
  volume: 70,
};

let audioCtx = null;

function getContext() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

// --- Sound synthesizers ---

function playBell(ctx, volume) {
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  gain.gain.setValueAtTime(volume * 0.4, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.2);

  // Two layered tones for a richer bell
  [880, 1320].forEach(freq => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    osc.connect(gain);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 1.2);
  });
}

function playGong(ctx, volume) {
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  gain.gain.setValueAtTime(volume * 0.5, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 2.5);

  // Low fundamental + inharmonic overtone for gong character
  [110, 163, 247].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    osc.type = i === 0 ? 'sine' : 'triangle';
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.97, ctx.currentTime + 2.5);
    osc.connect(gain);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 2.5);
  });
}

function playBark(ctx, volume) {
  // Short percussive burst — two quick "yips"
  [0, 0.15].forEach(offset => {
    const t = ctx.currentTime + offset;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(volume * 0.5, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(600, t);
    osc.frequency.exponentialRampToValueAtTime(200, t + 0.08);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(800, t);
    filter.Q.setValueAtTime(2, t);

    osc.connect(filter);
    filter.connect(gain);
    osc.start(t);
    osc.stop(t + 0.12);
  });
}

const SOUNDS = { bell: playBell, gong: playGong, bark: playBark };

// --- Public API ---

export function getAudioSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveAudioSettings(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function playNotification(settingsOverride) {
  const settings = settingsOverride || getAudioSettings();
  if (!settings.enabled) return;

  try {
    const ctx = getContext();
    // Resume context if suspended (browsers require user gesture)
    if (ctx.state === 'suspended') ctx.resume();
    const volume = Math.max(0, Math.min(1, settings.volume / 100));
    const fn = SOUNDS[settings.sound] || SOUNDS.bell;
    fn(ctx, volume);
  } catch {
    // Silently fail — audio is non-critical
  }
}

export function previewSound(sound, volume) {
  try {
    const ctx = getContext();
    if (ctx.state === 'suspended') ctx.resume();
    const vol = Math.max(0, Math.min(1, (volume ?? 70) / 100));
    const fn = SOUNDS[sound] || SOUNDS.bell;
    fn(ctx, vol);
  } catch {
    // Silently fail
  }
}

export const SOUND_OPTIONS = [
  { value: 'bell', label: 'Bell' },
  { value: 'gong', label: 'Gong' },
  { value: 'bark', label: 'Dog Bark' },
];
