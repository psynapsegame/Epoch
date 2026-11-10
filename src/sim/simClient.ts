import type { DivineAct, DivineResult } from './divine';
import type { ToWorker } from './sim.worker';
import type { EconomyView, FoundingBuilding, PersonView, RosterEntry, SearchHit, SimBuilding, SimSite, SimState, Snapshot, WorldView } from './types';

/** Main-thread handle on the simulation worker. */
export class SimClient {
  private worker: Worker;
  private pending = new Map<number, (s: SimState) => void>();
  private nextRequest = 1;
  snapshot: Snapshot | null = null;
  /** performance.now() when the last snapshot arrived. */
  snapshotAt = 0;
  lagging = false;
  roster: RosterEntry[] = [];
  rosterById = new Map<number, RosterEntry>();
  /** Most recent full state published by the worker (at most ~10 s old): used by autosave. */
  lastState: SimState | null = null;
  buildings: SimBuilding[] = [];
  economy: EconomyView | null = null;
  /** Civilisations, religions and recent history. */
  world: WorldView | null = null;
  onWorld: (() => void) | null = null;
  private searches = new Map<number, (h: SearchHit[]) => void>();
  private divines = new Map<number, (r: DivineResult) => void>();
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
          this.lastState = m.state as SimState;
          if (m.request) {
            this.pending.get(m.request)?.(m.state);
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
  requestState(): Promise<SimState> {
    return new Promise((resolve) => {
      const request = this.nextRequest++;
      this.pending.set(request, resolve);
      this.send({ type: 'state', request });
    });
  }
}
