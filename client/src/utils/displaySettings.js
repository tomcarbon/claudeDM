const STORAGE_KEY = 'dnd_display_settings';

const DEFAULTS = {
  collapseThreshold: 20,
};

export function getDisplaySettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveDisplaySettings(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function getCollapseThreshold() {
  return getDisplaySettings().collapseThreshold;
}
