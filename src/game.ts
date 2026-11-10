import * as THREE from 'three';
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
import { CIV_COLORS_HEX, FAITH_COLORS_HEX } from './render/palette';
import { POLITICAL_MODES, type AtlasMode, type PoliticalMark } from './render/worldTextures';
import { POWERS, type DivinePower, type DivineResult } from './sim/divine';
import { applyEdits, type WorldEdit } from './world/edits';
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
  /** Divine edits of the planet since its creation (saved, replayed at load). */
  worldEdits: WorldEdit[] = [];
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
    this.sim.onWorld = () => this.onSimWorld();

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
  async createWorld(seed: string, onProgress: (stage: string, stageIndex: number, p: number) => void, saved?: SimState, startTime?: number, edits: WorldEdit[] = []): Promise<void> {
    this.sim.setRate(0);
    const data = await generateWorldAsync({ seed, width: DEFAULT_WORLD_WIDTH }, onProgress);
    this.worldSum = worldChecksum(data);
    // divine changes to the planet are replayed on the freshly generated world
    applyEdits(data, edits);
    this.worldEdits = [...edits];
    this.world = this.engine.setWorld(data);
    this.governor.hold(performance.now(), 6000);
    this.clock.speedIndex = 1;
    this.foundHamlets();
    this.select(0);
    this.atlasMode = 'none';
    this.civKey = '';

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
    // Every promising site of the world is a place a people may one day settle;
    // the best ones already hold a founders' hamlet.
    const sites = this.world.data.sites;
    for (let i = 0; i < sites.length; i++) {
      const name = placeName(rng);
      if (i < FOUNDING_HAMLETS) {
        const { settlement, buildings } = layoutHamlet(this.world, i, i + 1, name, this.buildings.length + 1);
        this.settlements.push(settlement);
        if (buildings.length >= 4) this.buildings.push(...buildings);
        else settlement.buildings = [];
      } else {
        const dir = { x: 0, y: 0, z: 0 };
        this.world.cellDir(sites[i].x, sites[i].y, dir);
        this.settlements.push({ id: i + 1, name, dir, radius: 40, siteIndex: i, buildings: [] });
      }
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
    const tints = new Map<number, number>();
    const w = this.sim.world;
    if (w) for (const c of w.civs) for (const sid of c.settlements) tints.set(sid, CIV_COLORS_HEX[c.color % CIV_COLORS_HEX.length]);
    for (const sb of this.sim.buildings) {
      const f = frames.get(sb.settlement);
      if (!f) continue;
      f.toDir(sb.e, sb.n, R, a);
      f.toDir(sb.e + sb.fe * 3, sb.n + sb.fn * 3, R, b);
      const fx = b.x - a.x, fy = b.y - a.y, fz = b.z - a.z;
      const l = Math.hypot(fx, fy, fz) || 1;
      list.push({
        id: sb.id, kind: sb.kind as Building['kind'], settlement: sb.settlement, dir: { ...a }, facing: { x: fx / l, y: fy / l, z: fz / l },
        radius: sb.radius, progress: sb.progress, tint: tints.get(sb.settlement),
      });
    }
    this.buildings = list;
    this.engine.syncBuildings(list);
    this.onBuildings?.();
  }

  /** Civilisations changed: refresh banners on roofs and the political maps. */
  private onSimWorld(): void {
    const key = this.sim.world?.civs.map((c) => `${c.id}:${c.settlements.join('.')}`).join('|') ?? '';
    if (key !== this.civKey) {
      this.civKey = key;
      this.onSimBuildings();
    }
    if (this.atlasMode !== 'none' && POLITICAL_MODES.includes(this.atlasMode)) this.paintPolitical();
    this.onWorldView?.();
  }
  private civKey = '';
  atlasMode: AtlasMode = 'none';
  onWorldView: (() => void) | null = null;

  /** Atlas: natural maps come from the world grid, political ones from the living simulation. */
  setAtlas(mode: AtlasMode): void {
    this.atlasMode = mode;
    if (POLITICAL_MODES.includes(mode)) this.paintPolitical();
    else this.engine.setAtlasMode(mode);
  }

  private paintPolitical(): void {
    const w = this.sim.world;
    if (!w || !this.world) return;
    const marks: PoliticalMark[] = [];
    let maxPop = 1;
    for (const s of this.settlements) maxPop = Math.max(maxPop, w.settlements[s.id]?.[1] ?? 0);
    for (const s of this.settlements) {
      const [civId, pop] = w.settlements[s.id] ?? [0, 0];
      const civ = w.civs.find((c) => c.id === civId);
      if (!civ || pop === 0) continue;
      // a settlement's influence grows with its people
      const radius = 160 + Math.sqrt(pop) * 38;
      let color = CIV_COLORS_HEX[civ.color % CIV_COLORS_HEX.length];
      let strength = 0.85;
      if (this.atlasMode === 'population') {
        color = 0xffb347;
        strength = 0.35 + 0.65 * (pop / maxPop);
      } else if (this.atlasMode === 'wars') {
        const st = this.sim.economy?.settlements.find((x) => x.id === s.id);
        const fighting = w.relations.some((r) => r.status === 'war' && (r.a === civ.id || r.b === civ.id));
        color = st?.besieged ? 0xf1c40f : st && st.origin && st.origin !== civ.id ? 0xe67e22 : fighting ? 0xc0392b : 0x4a6f8a;
      } else if (this.atlasMode === 'religions') {
        let top = 0, n = 0;
        for (const [f, c] of Object.entries(civ.followers)) if (c > n) { n = c; top = Number(f); }
        if (!top) continue;
        color = FAITH_COLORS_HEX[(top - 1) % FAITH_COLORS_HEX.length];
      }
      marks.push({ dir: s.dir, radius, color, strength });
    }
    this.engine.setPoliticalOverlay(this.atlasMode, marks);
  }

  /** Settlement nearest to a point of the planet, with the point's local coordinates there. */
  private nearestSettlement(dir: { x: number; y: number; z: number }, inhabitedOnly: boolean, reach: number): { id: number; e: number; n: number; distance: number } | null {
    if (!this.world) return null;
    let best: { id: number; e: number; n: number; distance: number } | null = null;
    for (const s of this.settlements) {
      if (inhabitedOnly && !(this.sim.world?.settlements[s.id]?.[1] ?? 0)) continue;
      const d = Math.acos(Math.max(-1, Math.min(1, s.dir.x * dir.x + s.dir.y * dir.y + s.dir.z * dir.z))) * this.world.R;
      if (d > reach || (best && d >= best.distance)) continue;
      const local = siteFrame(s).toLocal(dir, this.world.R);
      best = { id: s.id, e: local.e, n: local.n, distance: d };
    }
    return best;
  }

  /**
   * A divine intervention at a point of the world. The simulation applies its
   * consequences on the peoples; powers that reshape the land also edit the
   * planet itself, lastingly.
   */
  async divine(power: DivinePower, point: { x: number; y: number; z: number }): Promise<DivineResult> {
    const world = this.world;
    if (!world) return { ok: false, reason: 'Aucun monde', deaths: 0, destroyed: 0 };
    const def = POWERS[power];
    const len = Math.hypot(point.x, point.y, point.z);
    const dir = { x: point.x / len, y: point.y / len, z: point.z / len };
    const near = this.nearestSettlement(dir, def.target === 'people', def.target === 'people' ? 450 : 1200);
    const cell = world.cellAt(dir.x, dir.y, dir.z);
    if (def.target === 'land' && world.data.water[cell] === 1) return { ok: false, reason: 'Ce pouvoir s’exerce sur la terre ferme', deaths: 0, destroyed: 0 };
    const result = await this.sim.divine({ power, settlement: near?.id ?? 0, e: near?.e ?? 0, n: near?.n ?? 0 });
    if (!result.ok) return result;
    void this.sim.requestState(); // so the next autosave already holds the consequences

    const x = cell % world.W, y = (cell / world.W) | 0;
    const edits: WorldEdit[] =
      power === 'mountain' ? [{ kind: 'mountain', x, y, radius: def.radius, amount: 170 }]
      : power === 'valley' ? [{ kind: 'valley', x, y, radius: def.radius, amount: 60 }]
      : power === 'forest' ? [{ kind: 'forest', x, y, radius: def.radius, amount: 0 }]
      : power === 'deposit' ? [{ kind: 'deposit', x, y, radius: def.radius, amount: 1 }]
      : power === 'meteor' ? [{ kind: 'burn', x, y, radius: def.radius * 1.8, amount: 0 }, { kind: 'crater', x, y, radius: def.radius, amount: 12 }]
      : power === 'fire' ? [{ kind: 'burn', x, y, radius: def.radius, amount: 0 }]
      : [];
    const ground = new THREE.Vector3(dir.x, dir.y, dir.z).multiplyScalar(world.surfaceRadius(dir.x, dir.y, dir.z));
    const centre = near && def.target === 'people' ? this.settlements.find((s) => s.id === near.id)!.dir : dir;
    const at = def.target === 'people' ? new THREE.Vector3(centre.x, centre.y, centre.z).multiplyScalar(world.surfaceRadius(centre.x, centre.y, centre.z)) : ground;
    this.engine.fx.spawn(
      power === 'meteor' ? 'impact' : power === 'fire' ? 'flames' : edits.length ? 'earth' : def.benevolent ? 'light' : 'gloom',
      at, def.target === 'people' ? 90 : def.radius,
    );
    if (power === 'storm') this.engine.storm(30);
    if (edits.length) {
      // let the meteor fall before the ground gives way
      window.setTimeout(() => {
        if (this.world !== world) return;
        let reach = 0;
        for (const e of edits) {
          this.engine.applyWorldEdit(e);
          this.worldEdits.push(e);
          reach = Math.max(reach, e.radius);
        }
        // the peoples nearby live on a changed land: send them its new map
        for (const s of this.settlements) {
          const d = Math.acos(Math.max(-1, Math.min(1, s.dir.x * dir.x + s.dir.y * dir.y + s.dir.z * dir.z))) * world.R;
          if (d < reach + 330) this.sim.replaceSite(buildSimSite(world, s, this.settlements));
        }
        this.onSimBuildings();
      }, power === 'meteor' ? 750 : 150);
    }
    return result;
  }

  /** Starts or stops the flow of time (the title screen and cinematics keep the world frozen). */
  setRunning(running: boolean): void {
    this.running = running;
    this.sim.setRate(running ? this.clock.rate : 0);
  }

  get summary(): WorldSummary {
    const s = this.sim.snapshot?.summary;
    return { population: s?.alive ?? 0, civilizations: s?.civilizations ?? 0, settlements: s?.inhabitedSettlements ?? 0, conflicts: s?.wars ?? 0 };
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
      worldEdits: this.worldEdits,
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
    await this.createWorld(save.seed, onProgress, sim, sim ? undefined : save.simTime, save.worldEdits);
    this.refounded = !!save.sim && !sim;
    this.clock.speedIndex = Math.max(0, Math.min(SPEEDS.length - 1, save.speedIndex));
    this.engine.controls.setState(save.camera);
    return { checksumOk: !save.worldChecksum || save.worldChecksum === this.worldSum };
  }
}
