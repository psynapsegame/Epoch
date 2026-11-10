/// <reference lib="webworker" />
import { generateWorld } from './generator';
import { worldTransferables, type WorldConfig } from './types';

/** World generation runs off the main thread so the UI stays fluid. */
self.onmessage = (ev: MessageEvent<WorldConfig>) => {
  let last = 0;
  const world = generateWorld(ev.data, (stage, progress) => {
    const now = performance.now();
    if (now - last > 40 || progress === 0 || progress === 1) {
      last = now;
      (self as DedicatedWorkerGlobalScope).postMessage({ type: 'progress', stage, progress });
    }
  });
  (self as DedicatedWorkerGlobalScope).postMessage({ type: 'done', world }, worldTransferables(world));
};
