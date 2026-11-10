import { Engine } from './render/engine';
import { SimClock, SECONDS_PER_DAY, SPEEDS, dateOf, seasonPhase } from './sim/clock';
import { layoutHamlet, type Building, type Settlement } from './sim/settlements';
import { SimClient } from './sim/simClient';
import { buildSimSite, foundingBuildings, siteFrame } from './sim/sites';
import { SIM_STATE_VERSION, type SimState } from './sim/types';
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
/** Size of the founding population (phase 2). */
const FOUNDING_POPULATION = 100;
/** Up to this speed the sun follows simulated time exactly (a day lasts at least 20 s). */
const MAX_SYNCED_RATE = 4320;
/** Beyond it, the sky drifts at one cosmetic day per this many real seconds. */
const FAST_VISUAL_DAY_SECONDS = 30;

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
  /** The living society, in its own thread. */
  readonly sim = new SimClient();
  /** Selected inhabitant (0 = none) and whether the camera follows them. */
  selected = 0;
  following = false;
  /** True when the last loaded save predates the current society rules and was re-founded. */
  refounded = false;
  onTick: (() => void) | null = null;
  /** Fired when buildings were added or progressed. */
  onBuildings: (() => void) | null = null;
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
    this.sim.onBuildings = () => this.onSimBuildings();

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
    const sim = this.sim;
    const snap = sim.snapshot;
    const rate = this.running ? this.clock.rate : 0;
    if (snap) {
      // The simulation thread owns time; between its snapshots we extrapolate briefly for smooth light.
      const ahead = Math.min(0.3, (performance.now() - sim.snapshotAt) / 1000) * (sim.lagging ? 0 : rate);
      this.clock.time = Math.max(this.clock.time, snap.time + ahead);
      if (rate <= MAX_SYNCED_RATE) this.visualDay = this.clock.time / SECONDS_PER_DAY;
      else this.visualDay += dt / FAST_VISUAL_DAY_SECONDS; // at blurring speeds the sky only drifts
    }
    if (this.running && performance.now() - this.lastAutosave > 30000) void this.autosave();

    const e = this.engine;
    if (this.world) e.people.update(this.world, snap, sim.rosterById, e.camera.position, dt, rate);
    if (this.following && e.people.selectedKnown) e.controls.goalDir.copy(e.people.selectedPos).normalize();
    e.frame(dt, this.clock.time, this.visualDay);
    this.onTick?.();
  }

  /** Generates a brand new world from a seed, and founds its first population. */
  async createWorld(seed: string, onProgress: (stage: string, stageIndex: number, p: number) => void, saved?: SimState, startTime?: number): Promise<void> {
    this.sim.setRate(0);
    const data = await generateWorldAsync({ seed, width: DEFAULT_WORLD_WIDTH }, onProgress);
    this.worldSum = worldChecksum(data);
    this.world = this.engine.setWorld(data);
    this.governor.hold(performance.now(), 6000);
    this.clock.speedIndex = 1;
    this.foundHamlets();
    this.select(0);

    const sites = this.settlements.map((s) => buildSimSite(this.world!, s, this.settlements));
    const founding = foundingBuildings(this.world, this.settlements, this.buildings);
    // Dawn of year 1: early morning over the first hamlet.
    const first = this.settlements[0]?.dir ?? { x: 1, y: 0.3, z: 0.2 };
    const lon = Math.atan2(first.z, first.x);
    const start = saved ? saved.time : startTime !== undefined ? startTime : ((((7.2 - 12) / 24 - lon / (2 * Math.PI)) % 1) + 1) % 1 * SECONDS_PER_DAY;
    this.clock.time = start;
    this.visualDay = start / SECONDS_PER_DAY;
    this.engine.people.setSettlements(this.settlements);
    this.sim.init(seed, sites, founding, FOUNDING_POPULATION, start, saved);
    this.engine.controls.setState({ dir: [first.x, first.y, first.z], distance: 9800, heading: 0, tilt: 0 });
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
    this.engine.syncBuildings(this.buildings);
  }

  /** The simulation raised, advanced or finished buildings: mirror them into the scene. */
  private onSimBuildings(): void {
    if (!this.world || !this.sim.buildings.length) return;
    const frames = new Map(this.settlements.map((s) => [s.id, siteFrame(s)]));
    const R = this.world.R;
    const list: Building[] = [];
    const a = { x: 0, y: 0, z: 0 }, b = { x: 0, y: 0, z: 0 };
    for (const sb of this.sim.buildings) {
      const f = frames.get(sb.settlement);
      if (!f) continue;
      f.toDir(sb.e, sb.n, R, a);
      f.toDir(sb.e + sb.fe * 3, sb.n + sb.fn * 3, R, b);
      const fx = b.x - a.x, fy = b.y - a.y, fz = b.z - a.z;
      const l = Math.hypot(fx, fy, fz) || 1;
      list.push({
        id: sb.id, kind: sb.kind as Building['kind'], settlement: sb.settlement, dir: { ...a }, facing: { x: fx / l, y: fy / l, z: fz / l },
        radius: sb.radius, progress: sb.progress,
      });
    }
    this.buildings = list;
    this.engine.syncBuildings(list);
    this.onBuildings?.();
  }

  /** Starts or stops the flow of time (the title screen and cinematics keep the world frozen). */
  setRunning(running: boolean): void {
    this.running = running;
    this.sim.setRate(running ? this.clock.rate : 0);
  }

  get summary(): WorldSummary {
    const s = this.sim.snapshot?.summary;
    return { population: s?.alive ?? 0, civilizations: 0, settlements: s?.inhabitedSettlements ?? 0, conflicts: 0 };
  }

  setSpeed(index: number): void {
    this.clock.speedIndex = Math.max(0, Math.min(SPEEDS.length - 1, index));
    this.sim.setRate(this.running ? this.clock.rate : 0);
  }

  /** Selects an inhabitant (0 = none): highlights them and streams their live details. */
  select(id: number, follow = false): void {
    this.selected = id;
    this.following = follow && id !== 0;
    this.engine.people.selected = id;
    this.sim.watch(id);
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
  /** Builds a save from a simulation state (the state carries the authoritative time). */
  snapshot(slot: string, state: SimState | null = this.sim.lastState): SaveData {
    if (!this.world) throw new Error('Aucun monde à sauvegarder');
    const time = state?.time ?? this.clock.time;
    return {
      version: SAVE_VERSION,
      slot,
      name: `${this.world.data.seed} — an ${dateOf(time).year}`,
      savedAt: Date.now(),
      seed: this.world.data.seed,
      worldWidth: this.world.W,
      worldChecksum: this.worldSum,
      simTime: time,
      speedIndex: this.clock.speedIndex,
      camera: this.engine.controls.getState(),
      sim: state,
    };
  }

  /** Manual save: asks the simulation thread for its exact current state. */
  async save(slot: string): Promise<SaveData> {
    const s = this.snapshot(slot, await this.sim.requestState());
    await saveStore.put(s);
    return s;
  }

  /** Background save from the latest state published by the simulation (never blocks, safe at app exit). */
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
    // A save from an earlier phase keeps its world and date; its society is founded anew with the current rules.
    const sim = save.sim && save.sim.version === SIM_STATE_VERSION ? save.sim : undefined;
    await this.createWorld(save.seed, onProgress, sim, sim ? undefined : save.simTime);
    this.refounded = !!save.sim && !sim;
    this.clock.speedIndex = Math.max(0, Math.min(SPEEDS.length - 1, save.speedIndex));
    this.engine.controls.setState(save.camera);
    return { checksumOk: !save.worldChecksum || save.worldChecksum === this.worldSum };
  }
}
