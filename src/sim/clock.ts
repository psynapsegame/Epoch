/**
 * Historical clock. Time is stored as a number of simulated seconds since the
 * dawn of year 1. A year has 360 days (4 seasons of 90 days), a day 24 hours.
 */
export const SECONDS_PER_DAY = 86400;
export const DAYS_PER_YEAR = 360;
export const SECONDS_PER_YEAR = SECONDS_PER_DAY * DAYS_PER_YEAR;

export const SEASONS = ['Printemps', 'Été', 'Automne', 'Hiver'] as const;

/**
 * Simulated seconds per real second for each speed step.
 * At ×1 a day lasts 8 minutes: slow enough to watch inhabitants walk and work.
 */
export const SPEEDS = [
  { label: 'Pause', rate: 0 },
  { label: '×1', rate: 180 }, // a day in 8 minutes
  { label: '×4', rate: 720 }, // a day in 2 minutes
  { label: '×24', rate: 4320 }, // a day in 20 seconds
  { label: '×240', rate: 43200 }, // a day in 2 seconds
  { label: '×2400', rate: 432000 }, // a year in 72 seconds
] as const;

/** Fixed simulation step (simulated seconds). Results never depend on the speed setting. */
export const TICK_SECONDS = 60;

/**
 * Local solar hour (0..24) at a longitude (radians) for a simulated time.
 * Single source of truth shared by the simulation (sleep, daylight) and the renderer (sun).
 */
export function localHour(time: number, longitude: number): number {
  const dayFrac = time / SECONDS_PER_DAY;
  return ((((longitude / (2 * Math.PI) + dayFrac) * 24 + 12) % 24) + 24) % 24;
}

export interface CalendarDate {
  year: number;
  dayOfYear: number; // 0..359
  season: number; // 0..3
  hour: number; // 0..24 (fractional)
}

export class SimClock {
  /** Simulated seconds since epoch. */
  time: number;
  speedIndex = 1;

  constructor(time = 8 * 3600) {
    this.time = time;
  }

  get rate(): number {
    return SPEEDS[this.speedIndex].rate;
  }

  /** Advance by a real-time delta (seconds). Returns simulated seconds elapsed. */
  advance(realDt: number): number {
    const dt = realDt * this.rate;
    this.time += dt;
    return dt;
  }

  get date(): CalendarDate {
    return dateOf(this.time);
  }
}

export function dateOf(time: number): CalendarDate {
  const days = time / SECONDS_PER_DAY;
  const wholeDays = Math.floor(days);
  const dayOfYear = ((wholeDays % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR;
  return {
    year: Math.floor(wholeDays / DAYS_PER_YEAR) + 1,
    dayOfYear,
    season: Math.floor(dayOfYear / 90),
    hour: (days - wholeDays) * 24,
  };
}

/**
 * Seasonal phase in [-1, 1]: +1 at the northern summer solstice, -1 at the
 * northern winter solstice. Spring starts on day 0 (equinox).
 */
export function seasonPhase(time: number): number {
  const yearFrac = (time / SECONDS_PER_YEAR) % 1;
  return Math.sin(yearFrac * 2 * Math.PI);
}
