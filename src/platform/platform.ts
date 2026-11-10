import { Capacitor } from '@capacitor/core';
import type { DeviceInfo } from '../render/quality';

/**
 * Everything that differs between a desktop browser, a mobile browser / PWA
 * and the native iOS / Android shells (Capacitor). Native plugins are loaded
 * lazily so the web build never pays for them.
 */
export const isNative = Capacitor.isNativePlatform();

export function deviceInfo(): DeviceInfo {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const ua = nav.userAgent || '';
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const iPadOS = /Macintosh/.test(ua) && nav.maxTouchPoints > 1;
  return {
    mobile: isNative || coarse || iPadOS || /Android|iPhone|iPad|iPod/i.test(ua),
    memoryGB: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    cores: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
  };
}

/** Asks the browser not to evict our saves under storage pressure (important on iOS). */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* unsupported */ }
  return false;
}

/** Native shell setup: immersive full screen, save when the app goes to the background. */
export async function initNativeShell(onPause: () => void, onResume: () => void): Promise<void> {
  if (!isNative) return;
  try {
    const { StatusBar } = await import('@capacitor/status-bar');
    await StatusBar.hide();
  } catch { /* plugin unavailable */ }
  try {
    const { App } = await import('@capacitor/app');
    await App.addListener('pause', onPause);
    await App.addListener('resume', onResume);
  } catch { /* plugin unavailable */ }
}

const MIRROR_DIR = 'saves';

/** Native only: durable copy of a save in the app's private files (survives WebView storage eviction). */
export async function mirrorWrite(slot: string, json: string): Promise<void> {
  if (!isNative) return;
  const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
  await Filesystem.writeFile({ path: `${MIRROR_DIR}/${slot}.json`, data: json, directory: Directory.Data, encoding: Encoding.UTF8, recursive: true });
}

export async function mirrorDelete(slot: string): Promise<void> {
  if (!isNative) return;
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  await Filesystem.deleteFile({ path: `${MIRROR_DIR}/${slot}.json`, directory: Directory.Data }).catch(() => {});
}

/** Native only: reads every mirrored save (raw JSON strings). */
export async function mirrorReadAll(): Promise<string[]> {
  if (!isNative) return [];
  const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
  const out: string[] = [];
  try {
    const dir = await Filesystem.readdir({ path: MIRROR_DIR, directory: Directory.Data });
    for (const f of dir.files) {
      if (!f.name.endsWith('.json')) continue;
      const file = await Filesystem.readFile({ path: `${MIRROR_DIR}/${f.name}`, directory: Directory.Data, encoding: Encoding.UTF8 });
      if (typeof file.data === 'string') out.push(file.data);
    }
  } catch { /* no mirror yet */ }
  return out;
}

/**
 * Hands a save file to the user: native share sheet in the apps, Web Share on
 * mobile browsers, classic download on desktop.
 */
export async function shareTextFile(filename: string, text: string): Promise<'shared' | 'downloaded'> {
  if (isNative) {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const res = await Filesystem.writeFile({ path: filename, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
    await Share.share({ title: filename, url: res.uri });
    return 'shared';
  }
  const file = new File([text], filename, { type: 'application/json' });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (deviceInfo().mobile && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: filename });
      return 'shared';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'shared';
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = filename;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return 'downloaded';
}
