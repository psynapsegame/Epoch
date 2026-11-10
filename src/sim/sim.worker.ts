/// <reference lib="webworker" />
import { TICK_SECONDS } from './clock';
import { Simulation } from './simulation';
import { planWall } from './infrastructure';
import { applyDivine, type DivineAct } from './divine';
import type { FoundingBuilding, SimSite, SimState } from './types';

/**
 * Simulation thread. The society lives here, independent of rendering: the
 * frame rate, resolution or a busy main thread never change its history.
 * It advances in fixed ticks paced by the requested speed and publishes
 * compact snapshots for the renderer and the interface.
 */
export type ToWorker =
  | { type: 'init'; seed: string; sites: SimSite[]; founding: FoundingBuilding[]; population: number; time: number; state?: SimState }
  | { type: 'rate'; rate: number; stride: number }
  | { type: 'watch'; id: number }
  | { type: 'state'; request: number }
  | { type: 'skip'; seconds: number }
  | { type: 'cancelSkip' }
  | { type: 'devWall'; settlement: number }
  | { type: 'search'; request: number; query: string }
  | { type: 'divine'; request: number; act: DivineAct }
  | { type: 'chronicle'; request: number; scope: number }
  | { type: 'tree'; request: number; id: number }
  | { type: 'site'; site: SimSite }
  | { type: 'stop' };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let sim: Simulation | null = null;
let rate = 0;
let budget = 0;
let last = performance.now();
let watch = 0;
let lastSnapshot = 0, lastDetail = 0, lastState = 0, lastRoster = 0, lastBuildings = 0;
let rosterVersion = -1;
let buildingsVersion = -1;
let lastEconomy = 0;
/** Fast-forward in progress: target time, and the settings to restore afterwards. */
let skip: { from: number; until: number; stride: number } | null = null;
let stepMs = 0;

function postState(request: number): void {
  if (!sim) return;
  // sent as text: the main thread stores it as is and never has to walk the object graph
  ctx.postMessage({ type: 'state', json: sim.serializeJson(), time: sim.state.time, request });
}
let lastWorld = 0;

function postSnapshot(lagging: boolean): void {
  if (!sim) return;
  const s = sim.snapshot();
  ctx.postMessage({ type: 'snapshot', snapshot: s, lagging }, [s.ids.buffer, s.pos.buffer, s.site.buffer, s.flags.buffer]);
}

function postRoster(): void {
  if (!sim) return;
  rosterVersion = sim.rosterVersion;
  ctx.postMessage({ type: 'roster', roster: sim.roster() });
}

ctx.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case 'init':
      sim = m.state ? new Simulation(m.sites, m.state) : Simulation.create(m.seed, m.sites, m.founding, m.population, m.time);
      buildingsVersion = -1;
      budget = 0;
      rate = 0;
      last = performance.now();
      postRoster();
      postSnapshot(false);
      lastWorld = 0;
      lastEconomy = 0;
      postState(0);
      skip = null;
      break;
    case 'rate':
      rate = m.rate;
      if (rate === 0) budget = 0;
      if (skip) skip.stride = m.stride;
      else sim?.setStride(m.stride);
      break;
    case 'watch':
      watch = m.id;
      lastDetail = 0;
      break;
    case 'divine': {
      const result = sim ? applyDivine(sim, m.act) : { ok: false, reason: 'Monde absent', deaths: 0, destroyed: 0 };
      ctx.postMessage({ type: 'divine', request: m.request, result });
      lastWorld = 0;
      lastEconomy = 0;
      break;
    }
    case 'site':
      sim?.replaceSite(m.site);
      break;
    case 'chronicle':
      ctx.postMessage({ type: 'reply', request: m.request, value: sim ? sim.chronicle(m.scope) : null });
      break;
    case 'tree':
      ctx.postMessage({ type: 'reply', request: m.request, value: sim ? sim.tree(m.id) : null });
      break;
    case 'search':
      ctx.postMessage({ type: 'search', request: m.request, hits: sim ? sim.search(m.query) : [] });
      break;
    case 'state':
      postState(m.request);
      break;
    case 'skip':
      if (sim && !skip) {
        skip = { from: sim.state.time, until: sim.state.time + m.seconds, stride: sim.state.stride };
        sim.setStride(30); // coarsest, aggregated simulation while leaping through time
      }
      break;
    case 'devWall': {
      // development builds only: opens a wall project at once, to check its drawing
      const st = import.meta.env.DEV ? sim?.settlement(m.settlement) : undefined;
      if (sim && st) planWall(sim, st, sim.census(st.id).pop, true);
      break;
    }
    case 'cancelSkip':
      endSkip();
      break;
    case 'stop':
      sim = null;
      rate = 0;
      break;
  }
};

function endSkip(): void {
  if (!skip || !sim) return;
  sim.setStride(skip.stride);
  skip = null;
  budget = 0;
  ctx.postMessage({ type: 'skip', done: true, progress: 1, time: sim.state.time });
  postState(0);
}

setInterval(() => {
  const now = performance.now();
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  if (!sim) return;
  let ticks = 0;
  if (skip) {
    // leap through time: as many steps as fit in the slice, leaving room for messages
    while (sim.state.time < skip.until && performance.now() - now < 26) {
      sim.step();
      ticks++;
    }
    stepMs = ticks ? (performance.now() - now) / ticks : stepMs;
    ctx.postMessage({ type: 'skip', done: false, progress: (sim.state.time - skip.from) / (skip.until - skip.from), time: sim.state.time });
    if (sim.state.time >= skip.until) endSkip();
  } else {
    budget += dt * rate;
  }
  const stepSeconds = TICK_SECONDS * sim.state.stride;
  while (!skip && budget >= stepSeconds && performance.now() - now < 14) {
    sim.step();
    budget -= stepSeconds;
    ticks++;
  }
  if (!skip && ticks) stepMs = stepMs * 0.9 + ((performance.now() - now) / ticks) * 0.1;
  // If the device cannot keep up with the requested speed, time simply flows slower.
  const lagging = budget > stepSeconds * 4;
  if (lagging) budget = 0;
  if (sim.rosterVersion !== rosterVersion && now - lastRoster > 400) {
    lastRoster = now;
    postRoster();
  }
  if (sim.buildingsVersion !== buildingsVersion && now - lastBuildings > 400) {
    lastBuildings = now;
    buildingsVersion = sim.buildingsVersion;
    ctx.postMessage({ type: 'buildings', buildings: sim.state.buildings });
  }
  if (now - lastEconomy > 1000) {
    lastEconomy = now;
    ctx.postMessage({ type: 'economy', economy: sim.economy() });
  }
  if (now - lastWorld > 2000) {
    lastWorld = now;
    ctx.postMessage({ type: 'world', world: sim.worldView() });
  }
  if ((ticks > 0 && (!skip || now - lastSnapshot > 400)) || now - lastSnapshot > 500) {
    lastSnapshot = now;
    postSnapshot(lagging);
    ctx.postMessage({ type: 'load', stepMs, stride: sim.state.stride, people: sim.state.persons.length });
  }
  if (watch && now - lastDetail > 400) {
    lastDetail = now;
    ctx.postMessage({ type: 'detail', id: watch, view: sim.view(watch) });
  }
  if (now - lastState > 10000 && !skip) {
    lastState = now;
    postState(0);
  }
}, 33);
