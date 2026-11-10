/// <reference lib="webworker" />
import { TICK_SECONDS } from './clock';
import { Simulation } from './simulation';
import type { SimSite, SimState } from './types';

/**
 * Simulation thread. The society lives here, independent of rendering: the
 * frame rate, resolution or a busy main thread never change its history.
 * It advances in fixed ticks paced by the requested speed and publishes
 * compact snapshots for the renderer and the interface.
 */
export type ToWorker =
  | { type: 'init'; seed: string; sites: SimSite[]; population: number; time: number; state?: SimState }
  | { type: 'rate'; rate: number }
  | { type: 'watch'; id: number }
  | { type: 'state'; request: number }
  | { type: 'stop' };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let sim: Simulation | null = null;
let rate = 0;
let budget = 0;
let last = performance.now();
let watch = 0;
let lastSnapshot = 0, lastDetail = 0, lastState = 0;
let rosterVersion = -1;

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
      sim = m.state ? new Simulation(m.sites, m.state) : Simulation.create(m.seed, m.sites, m.population, m.time);
      budget = 0;
      rate = 0;
      last = performance.now();
      postRoster();
      postSnapshot(false);
      ctx.postMessage({ type: 'state', state: sim.serialize(), request: 0 });
      break;
    case 'rate':
      rate = m.rate;
      if (rate === 0) budget = 0;
      break;
    case 'watch':
      watch = m.id;
      lastDetail = 0;
      break;
    case 'state':
      if (sim) ctx.postMessage({ type: 'state', state: sim.serialize(), request: m.request });
      break;
    case 'stop':
      sim = null;
      rate = 0;
      break;
  }
};

setInterval(() => {
  const now = performance.now();
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  if (!sim) return;
  budget += dt * rate;
  let ticks = 0;
  while (budget >= TICK_SECONDS && performance.now() - now < 14) {
    sim.step();
    budget -= TICK_SECONDS;
    ticks++;
  }
  // If the device cannot keep up with the requested speed, time simply flows slower.
  const lagging = budget > TICK_SECONDS * 4;
  if (lagging) budget = 0;
  if (sim.rosterVersion !== rosterVersion) postRoster();
  if (ticks > 0 || now - lastSnapshot > 500) {
    lastSnapshot = now;
    postSnapshot(lagging);
  }
  if (watch && now - lastDetail > 400) {
    lastDetail = now;
    ctx.postMessage({ type: 'detail', id: watch, view: sim.view(watch) });
  }
  if (now - lastState > 10000) {
    lastState = now;
    ctx.postMessage({ type: 'state', state: sim.serialize(), request: 0 });
  }
}, 33);
