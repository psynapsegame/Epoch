import type { CameraState } from '../render/cameraController';
import type { SimState } from '../sim/types';
import type { WorldEdit } from '../world/edits';
import { mirrorDelete, mirrorReadAll, mirrorWrite } from '../platform/platform';

/**
 * Save games in IndexedDB. A world is fully determined by its seed, so a save
 * stores the seed plus everything that evolved since creation. The format is
 * versioned so future phases (population, history...) can migrate old saves.
 */
export const SAVE_VERSION = 2;

export interface SaveData {
  version: number;
  slot: string;
  name: string;
  savedAt: number;
  seed: string;
  worldWidth: number;
  /** Checksum of the generated world, to detect generator drift between versions. */
  worldChecksum: number;
  simTime: number;
  speedIndex: number;
  camera: CameraState;
  /** The whole society: individuals, families, households, the dead (null in saves older than phase 2). */
  sim: SimState | null;
  /** Divine changes made to the planet, replayed in order after regeneration. */
  worldEdits: WorldEdit[];
}

export const SAVE_SLOTS = ['auto', 'slot1', 'slot2', 'slot3'] as const;
export type SaveSlot = (typeof SAVE_SLOTS)[number];

const DB_NAME = 'epoch-living-world';
const STORE = 'saves';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'slot' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => { db.close(); resolve(req.result); };
        t.onerror = () => { db.close(); reject(t.error); };
        t.onabort = () => { db.close(); reject(t.error); };
      }),
  );
}

export function validateSave(data: unknown): SaveData {
  const s = data as Partial<SaveData>;
  if (!s || typeof s !== 'object') throw new Error('Sauvegarde illisible');
  // version 1 (phase 1, no inhabitants) is still readable: the population is founded at load time
  if (s.version !== SAVE_VERSION && s.version !== 1) throw new Error(`Version de sauvegarde non prise en charge (${String(s.version)})`);
  const sim = s.version === SAVE_VERSION ? s.sim ?? null : null;
  if (sim && (!Array.isArray(sim.persons) || !Array.isArray(sim.households) || typeof sim.time !== 'number')) throw new Error('Population illisible');
  if (typeof s.seed !== 'string' || !s.seed) throw new Error('Graine manquante');
  if (typeof s.simTime !== 'number' || !Number.isFinite(s.simTime)) throw new Error('Date invalide');
  if (!s.camera || !Array.isArray(s.camera.dir) || s.camera.dir.length !== 3) throw new Error('Caméra invalide');
  return {
    version: SAVE_VERSION,
    slot: typeof s.slot === 'string' ? s.slot : 'auto',
    name: typeof s.name === 'string' ? s.name : s.seed,
    savedAt: typeof s.savedAt === 'number' ? s.savedAt : Date.now(),
    seed: s.seed,
    worldWidth: typeof s.worldWidth === 'number' ? s.worldWidth : 2048,
    worldChecksum: typeof s.worldChecksum === 'number' ? s.worldChecksum : 0,
    simTime: s.simTime,
    speedIndex: typeof s.speedIndex === 'number' ? s.speedIndex : 1,
    camera: s.camera,
    sim,
    worldEdits: Array.isArray(s.worldEdits) ? s.worldEdits.filter((e) => e && typeof e.kind === 'string' && Number.isFinite(e.x) && Number.isFinite(e.y)) : [],
  };
}

export const saveStore = {
  /** Writes to IndexedDB and, in the native apps, to a durable file mirror. */
  put: async (save: SaveData) => {
    await tx('readwrite', (s) => s.put(save));
    await mirrorWrite(save.slot, JSON.stringify(save)).catch((e) => console.warn('Save mirror failed', e));
  },
  get: (slot: string) => tx<SaveData | undefined>('readonly', (s) => s.get(slot)).then((v) => (v ? validateSave(v) : undefined)),
  list: () => tx<SaveData[]>('readonly', (s) => s.getAll()),
  remove: async (slot: string) => {
    await tx('readwrite', (s) => s.delete(slot));
    await mirrorDelete(slot).catch(() => {});
  },
  /**
   * Native apps: if the WebView storage was evicted, restore saves from the file mirror
   * (only slots missing from IndexedDB, never overwriting newer data).
   */
  recoverFromMirror: async (): Promise<number> => {
    const raw = await mirrorReadAll();
    if (!raw.length) return 0;
    const existing = new Map((await tx<SaveData[]>('readonly', (s) => s.getAll())).map((s) => [s.slot, s]));
    let restored = 0;
    for (const text of raw) {
      try {
        const save = validateSave(JSON.parse(text));
        const cur = existing.get(save.slot);
        if (!cur || cur.savedAt < save.savedAt) {
          await tx('readwrite', (s) => s.put(save));
          restored++;
        }
      } catch { /* skip unreadable mirror file */ }
    }
    return restored;
  },
};

export function exportSave(save: SaveData): string {
  return JSON.stringify({ format: 'epoch-save', ...save }, null, 2);
}

export function importSave(text: string): SaveData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Fichier de sauvegarde invalide (JSON illisible)');
  }
  if ((parsed as { format?: string }).format !== 'epoch-save') throw new Error('Ce fichier n’est pas une sauvegarde EPOCH');
  return validateSave(parsed);
}
