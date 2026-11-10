import type { QualityTier } from './render/quality';

/** Player preferences (device-local, not part of a save game). */
export interface Settings {
  /** 'auto' lets the governor pick and lower the tier. */
  quality: 'auto' | QualityTier;
  /** Battery saver: 30 fps while interacting, 20 fps at rest. */
  eco: boolean;
}

const KEY = 'epoch.settings';
const DEFAULTS: Settings = { quality: 'auto', eco: false };

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    return {
      quality: raw.quality === 'low' || raw.quality === 'medium' || raw.quality === 'high' ? raw.quality : 'auto',
      eco: raw.eco === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function storeSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch { /* storage unavailable */ }
}
