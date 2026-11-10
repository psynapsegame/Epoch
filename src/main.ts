import { Game } from './game';
import { isNative } from './platform/platform';
import { App } from './ui/app';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const game = new Game(canvas);
const app = new App(game);

// Offline support for the installable web app. The native shells already ship every asset locally.
if (import.meta.env.PROD && !isNative && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

// Debug handle (used by automated visual checks; harmless in production).
(window as unknown as { __epoch: unknown }).__epoch = { game, app, engine: game.engine };
