import type { CameraState } from '../render/cameraController';

/**
 * Save games in IndexedDB. A world is fully determined by its seed, so a save
 * stores the seed plus everything that evolved since creation. The format is
 * versioned so future phases (population, history...) can migrate old saves.
 */
export const SAVE_VERSION = 1;

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
  if (s.version !== SAVE_VERSION) throw new Error(`Version de sauvegarde non prise en charge (${String(s.version)})`);
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
  };
}

export const saveStore = {
  put: (save: SaveData) => tx('readwrite', (s) => s.put(save)).then(() => undefined),
  get: (slot: string) => tx<SaveData | undefined>('readonly', (s) => s.get(slot)).then((v) => (v ? validateSave(v) : undefined)),
  list: () => tx<SaveData[]>('readonly', (s) => s.getAll()),
  remove: (slot: string) => tx('readwrite', (s) => s.delete(slot)).then(() => undefined),
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
