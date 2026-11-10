import * as THREE from 'three';
import { Engine } from './render/engine';
import { SimClock, SECONDS_PER_DAY, SPEEDS, dateOf, seasonPhase } from './sim/clock';
import { layoutHamlet, type Building, type Settlement } from './sim/settlements';
import { Rng, hashString } from './core/rng';
import { placeName } from './world/names';
import { generateWorldAsync } from './world/generateAsync';
import { worldChecksum } from './world/generator';
import { DEFAULT_WORLD_WIDTH } from './world/types';
import type { World } from './world/world';
import { SAVE_VERSION, saveStore, type SaveData } from './persistence/saveStore';
import { deviceInfo, initNativeShell, isNative, requestPersistentStorage } from './platform/platform';
import { PROFILES, QUALITY_TIERS, QualityGovernor, defaultTier, targetFrameRate, type QualityTier } from './render/quality';
import { loadSettings, storeSettings, type Settings } from './settings';

/** Number of founding hamlets raised on the best sites in Phase 1. */
const FOUNDING_HAMLETS = 6;
/** Fastest the sun may visibly travel: one day per this many real seconds. */
const MIN_VISUAL_DAY_SECONDS = 24;

export interface WorldSummary {
  population: number;
  civilizations: number;
  settlements: number;
  conflicts: number;
}

/**
 * Game orchestrator: owns the clock, the world, the (still embryonic)
 * simulation state and the renderer, and keeps them strictly layered:
 * simulation never reads from the renderer.
 */
export class Game {
  readonly engine: Engine;
  readonly clock = new SimClock();
  world: World | null = null;
  settlements: Settlement[] = [];
  buildings: Building[] = [];
  /** Continuous day counter driving the sun; decoupled from sim time at very high speeds. */
  private visualDay = 0;
  private worldSum = 0;
  private lastAutosave = 0;
  running = false;
  onTick: (() => void) | null = null;
  /** Fired when the governor lowers the quality tier on its own. */
  onQualityChange: ((tier: QualityTier, automatic: boolean) => void) | null = null;
  readonly device = deviceInfo();
  readonly settings: Settings = loadSettings();
  readonly governor = new QualityGovernor(60);
  tier: QualityTier;
  /** Frames per second currently aimed for (pacing), for diagnostics. */
  pacedFps = 60;

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas);
    this.tier = this.settings.quality === 'auto' ? defaultTier(this.device) : this.settings.quality;
    this.engine.applyQuality(PROFILES[this.tier]);

    let lastRender = performance.now();
    const loop = (now: number) => {
      requestAnimationFrame(loop);
      // Nothing is drawn or simulated while the app is in the background.
      if (document.hidden) {
        lastRender = now;
        return;
      }
      // Frame pacing: full rate while the player acts or the camera travels, reduced at rest.
      const c = this.engine.controls;
      const active = c.moving || now - c.lastInput < 2500 || this.engine.busy;
      const fps = targetFrameRate({ active, eco: this.settings.eco });
      this.pacedFps = fps;
      const elapsed = now - lastRender;
      if (elapsed < 1000 / fps - 3) return;
      lastRender = now;
      if (active) this.govern(now, elapsed, fps);
      this.frame(Math.min(0.1, elapsed / 1000));
    };
    requestAnimationFrame(loop);

    const persist = () => void this.autosave();
    const resume = () => this.governor.hold(performance.now(), 3000);
    window.addEventListener('beforeunload', persist);
    window.addEventListener('pagehide', persist);
    document.addEventListener('visibilitychange', () => (document.visibilityState === 'hidden' ? persist() : resume()));
    void initNativeShell(persist, resume);
    void requestPersistentStorage();
    if (isNative) void saveStore.recoverFromMirror().catch(() => 0);
  }

  /** Adaptive quality: lower the resolution, then the tier, when frames take too long. */
  private govern(now: number, frameMs: number, fps: number): void {
    const g = this.governor;
    if (g.targetFps !== fps) {
      g.targetFps = fps;
      g.hold(now, 500);
    }
    const auto = this.settings.quality === 'auto';
    const index = QUALITY_TIERS.indexOf(this.tier);
    const action = g.sample(now, frameMs, this.engine.busy || !this.world, auto && index > 0);
    if (action === 'none') return;
    if (action === 'tier-down') {
      this.tier = QUALITY_TIERS[index - 1];
      this.engine.applyQuality(PROFILES[this.tier]);
      g.hold(now, 4000);
      this.onQualityChange?.(this.tier, true);
    }
    this.engine.setResolutionScale(g.scale);
  }

  /** Player choice of graphics quality ('auto' = adaptive). */
  setQuality(q: Settings['quality']): void {
    this.settings.quality = q;
    storeSettings(this.settings);
    this.tier = q === 'auto' ? defaultTier(this.device) : q;
    this.governor.reset();
    this.governor.hold(performance.now(), 4000);
    this.engine.applyQuality(PROFILES[this.tier]);
    this.engine.setResolutionScale(1);
    this.onQualityChange?.(this.tier, false);
  }

  setEco(eco: boolean): void {
    this.settings.eco = eco;
    storeSettings(this.settings);
  }

  private frame(dt: number): void {
    if (this.running) {
      const simDt = this.clock.advance(dt);
      const maxDayRate = dt / MIN_VISUAL_DAY_SECONDS;
      this.visualDay += Math.min(simDt / SECONDS_PER_DAY, maxDayRate);
      if (performance.now() - this.lastAutosave > 30000) void this.autosave();
    }
    this.engine.frame(dt, this.clock.time, this.visualDay);
    this.onTick?.();
  }

  /** Generates a brand new world from a seed. */
  async createWorld(seed: string, onProgress: (stage: string, stageIndex: number, p: number) => void): Promise<void> {
    const data = await generateWorldAsync({ seed, width: DEFAULT_WORLD_WIDTH }, onProgress);
    this.worldSum = worldChecksum(data);
    this.world = this.engine.setWorld(data);
    this.governor.hold(performance.now(), 6000);
    this.clock.time = 7 * 3600;
    this.clock.speedIndex = 1;
    this.foundHamlets();
    // start with morning light over the best site
    const site = this.settlements[0]?.dir ?? { x: 1, y: 0.3, z: 0.2 };
    this.alignSunTo(new THREE.Vector3(site.x, site.y, site.z), 9.5);
    this.engine.controls.setState({ dir: [site.x, site.y, site.z], distance: 9800, heading: 0, tilt: 0 });
  }

  /** Sets the visual day so that the local solar time at `dir` is `hour`. */
  alignSunTo(dir: THREE.Vector3, hour: number): void {
    const lon = Math.atan2(dir.z, dir.x);
    // sun longitude = -visualDay * 2π ; local hour = (lon - lonSun)/2π*24 + 12
    const lonSun = lon - ((hour - 12) / 24) * 2 * Math.PI;
    const frac = (((-lonSun / (2 * Math.PI)) % 1) + 1) % 1;
    this.visualDay = Math.floor(this.visualDay) + frac;
  }

  private foundHamlets(): void {
    if (!this.world) return;
    const rng = new Rng(hashString(this.world.data.seed) ^ 0x5e77);
    this.settlements = [];
    this.buildings = [];
    const count = Math.min(FOUNDING_HAMLETS, this.world.data.sites.length);
    for (let i = 0; i < count; i++) {
      const { settlement, buildings } = layoutHamlet(this.world, i, i + 1, placeName(rng), this.buildings.length + 1);
      if (buildings.length < 4) continue;
      this.settlements.push(settlement);
      this.buildings.push(...buildings);
    }
    this.engine.syncBuildings(
      this.buildings,
      this.settlements.map((s) => ({ dir: new THREE.Vector3(s.dir.x, s.dir.y, s.dir.z), radius: s.radius + 6 })),
    );
  }

  get summary(): WorldSummary {
    return { population: 0, civilizations: 0, settlements: this.settlements.length, conflicts: 0 };
  }

  setSpeed(index: number): void {
    this.clock.speedIndex = Math.max(0, Math.min(SPEEDS.length - 1, index));
  }

  /** Temperature (°C) right now at the camera focus, including the season. */
  focusTemperature(): number | null {
    if (!this.world) return null;
    const d = this.engine.controls.dir;
    return this.world.seasonalTemperature(this.world.cellAt(d.x, d.y, d.z), seasonPhase(this.clock.time));
  }

  get date() {
    return dateOf(this.clock.time);
  }

  // ------------------------------------------------------------ persistence
  snapshot(slot: string, name?: string): SaveData {
    if (!this.world) throw new Error('Aucun monde à sauvegarder');
    return {
      version: SAVE_VERSION,
      slot,
      name: name ?? `${this.world.data.seed} — an ${this.date.year}`,
      savedAt: Date.now(),
      seed: this.world.data.seed,
      worldWidth: this.world.W,
      worldChecksum: this.worldSum,
      simTime: this.clock.time,
      speedIndex: this.clock.speedIndex,
      camera: this.engine.controls.getState(),
    };
  }

  async save(slot: string): Promise<SaveData> {
    const s = this.snapshot(slot);
    await saveStore.put(s);
    return s;
  }

  async autosave(): Promise<void> {
    if (!this.world || !this.running) return;
    this.lastAutosave = performance.now();
    try {
      await saveStore.put(this.snapshot('auto'));
    } catch (e) {
      console.warn('Autosave failed', e);
    }
  }

  /** Restores a save: regenerates the world from its seed, then reapplies the evolved state. */
  async load(save: SaveData, onProgress: (stage: string, stageIndex: number, p: number) => void): Promise<{ checksumOk: boolean }> {
    await this.createWorld(save.seed, onProgress);
    this.clock.time = save.simTime;
    this.clock.speedIndex = save.speedIndex;
    this.visualDay = save.simTime / SECONDS_PER_DAY;
    this.engine.controls.setState(save.camera);
    return { checksumOk: !save.worldChecksum || save.worldChecksum === this.worldSum };
  }
}
