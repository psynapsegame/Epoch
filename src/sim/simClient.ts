import type { Chronicle } from './chronicle';
import type { DivineAct, DivineResult } from './divine';
import type { ToWorker } from './sim.worker';
import type { FamilyTree } from './types';
import type { EconomyView, FoundingBuilding, PersonView, RosterEntry, SearchHit, SimBuilding, SimSite, SimState, Snapshot, WorldView } from './types';

/** The simulation state as serialised text, with its time. */
export interface StateText { json: string; time: number }

/** Main-thread handle on the simulation worker. */
export class SimClient {
  private worker: Worker;
  private pending = new Map<number, (s: StateText) => void>();
  private nextRequest = 1;
  snapshot: Snapshot | null = null;
  /** performance.now() when the last snapshot arrived. */
  snapshotAt = 0;
  lagging = false;
  roster: RosterEntry[] = [];
  rosterById = new Map<number, RosterEntry>();
  /** Most recent full state published by the worker (at most ~10 s old): used by autosave. */
  lastState: StateText | null = null;
  /** Fast-forward in progress (0..1), or null. */
  skipping: number | null = null;
  onSkipDone: ((time: number) => void) | null = null;
  /** Cost of the simulation: milliseconds per step, current coarseness. */
  load = { stepMs: 0, stride: 1, people: 0 };
  buildings: SimBuilding[] = [];
  economy: EconomyView | null = null;
  /** Civilisations, religions and recent history. */
  world: WorldView | null = null;
  onWorld: (() => void) | null = null;
  private searches = new Map<number, (h: SearchHit[]) => void>();
  private divines = new Map<number, (r: DivineResult) => void>();
  private replies = new Map<number, (v: unknown) => void>();
  onRoster: (() => void) | null = null;
  onBuildings: (() => void) | null = null;
  onDetail: ((id: number, view: PersonView | null) => void) | null = null;

  constructor() {
    this.worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev) => {
      const m = ev.data;
      switch (m.type) {
        case 'snapshot':
          this.snapshot = m.snapshot as Snapshot;
          this.snapshotAt = performance.now();
          this.lagging = m.lagging;
          break;
        case 'roster':
          this.roster = m.roster as RosterEntry[];
          this.rosterById = new Map(this.roster.map((r) => [r.id, r]));
          this.onRoster?.();
          break;
        case 'buildings':
          this.buildings = m.buildings as SimBuilding[];
          this.onBuildings?.();
          break;
        case 'economy':
          this.economy = m.economy as EconomyView;
          break;
        case 'world':
          this.world = m.world as WorldView;
          this.onWorld?.();
          break;
        case 'skip':
          this.skipping = m.done ? null : (m.progress as number);
          if (m.done) this.onSkipDone?.(m.time as number);
          break;
        case 'load':
          this.load = { stepMs: m.stepMs, stride: m.stride, people: m.people };
          break;
        case 'reply':
          this.replies.get(m.request)?.(m.value);
          this.replies.delete(m.request);
          break;
        case 'divine':
          this.divines.get(m.request)?.(m.result);
          this.divines.delete(m.request);
          break;
        case 'search':
          this.searches.get(m.request)?.(m.hits);
          this.searches.delete(m.request);
          break;
        case 'detail':
          this.onDetail?.(m.id, m.view);
          break;
        case 'state':
          this.lastState = { json: m.json as string, time: m.time as number };
          if (m.request) {
            this.pending.get(m.request)?.(this.lastState);
            this.pending.delete(m.request);
          }
          break;
      }
    };
  }

  private send(m: ToWorker): void {
    this.worker.postMessage(m);
  }

  init(seed: string, sites: SimSite[], founding: FoundingBuilding[], population: number, time: number, state?: SimState): void {
    this.buildings = [];
    this.economy = null;
    this.world = null;
    this.snapshot = null;
    this.lastState = null;
    this.skipping = null;
    this.roster = [];
    this.rosterById.clear();
    this.send({ type: 'init', seed, sites, founding, population, time, state });
  }

  /**
   * Sets the speed. At very high speeds ticks are merged (coarser, aggregated
   * simulation) so thousands of inhabitants remain affordable on a phone.
   */
  setRate(rate: number): void {
    const stride = rate >= 400000 ? 20 : rate >= 40000 ? 6 : rate >= 4000 ? 2 : 1;
    this.send({ type: 'rate', rate, stride });
  }

  /** Subscribes to live details of one person (0 = none). */
  watch(id: number): void {
    this.send({ type: 'watch', id });
  }

  private ask<T>(message: (request: number) => ToWorker): Promise<T> {
    return new Promise((resolve) => {
      const request = this.nextRequest++;
      this.replies.set(request, resolve as (v: unknown) => void);
      this.send(message(request));
    });
  }

  /** The written history of the world (0) or of a people, composed in the simulation thread. */
  chronicle(scope: number): Promise<Chronicle | null> {
    return this.ask((request) => ({ type: 'chronicle', request, scope }));
  }

  /** Family tree of a living or dead person. */
  tree(id: number): Promise<FamilyTree | null> {
    return this.ask((request) => ({ type: 'tree', request, id }));
  }

  /** Carries out a divine intervention in the simulation and reports what it did. */
  divine(act: DivineAct): Promise<DivineResult> {
    return new Promise((resolve) => {
      const request = this.nextRequest++;
      this.divines.set(request, resolve);
      this.send({ type: 'divine', request, act });
    });
  }

  /** Sends the reshaped land around a settlement (after a divine terrain edit). */
  replaceSite(site: SimSite): void {
    this.send({ type: 'site', site });
  }

  /** Looks up people by name among the living and the dead (archives). */
  search(query: string): Promise<SearchHit[]> {
    return new Promise((resolve) => {
      const request = this.nextRequest++;
      this.searches.set(request, resolve);
      this.send({ type: 'search', request, query });
    });
  }

  /** Fetches an exact copy of the current state (for manual saves). */
  /** Leaps forward in time as fast as the device allows (coarse, aggregated simulation). */
  skip(seconds: number): void {
    this.skipping = 0;
    this.send({ type: 'skip', seconds });
  }

  /** Development builds only: opens a wall project in a settlement. */
  devWall(settlement: number): void {
    this.send({ type: 'devWall', settlement });
  }

  cancelSkip(): void {
    this.send({ type: 'cancelSkip' });
  }

  requestState(): Promise<StateText> {
    return new Promise((resolve) => {
      const request = this.nextRequest++;
      this.pending.set(request, resolve);
      this.send({ type: 'state', request });
    });
  }
}
