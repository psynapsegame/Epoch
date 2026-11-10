import type { WorldConfig, WorldData } from './types';

/** Generates a world in a Web Worker, reporting pipeline stages. */
export function generateWorldAsync(
  cfg: WorldConfig,
  onProgress: (stage: string, stageIndex: number, progress: number) => void,
): Promise<WorldData> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worldgen.worker.ts', import.meta.url), { type: 'module' });
    let stageIndex = -1;
    let lastStage = '';
    worker.onmessage = (ev) => {
      const msg = ev.data;
      if (msg.type === 'progress') {
        if (msg.stage !== lastStage) {
          lastStage = msg.stage;
          stageIndex++;
        }
        onProgress(msg.stage, stageIndex, msg.progress);
      } else if (msg.type === 'done') {
        worker.terminate();
        resolve(msg.world as WorldData);
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'Échec de la génération du monde'));
    };
    worker.postMessage(cfg);
  });
}
