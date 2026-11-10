import { Game } from './game';
import { App } from './ui/app';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const game = new Game(canvas);
const app = new App(game);

// Debug handle (used by automated visual checks; harmless in production).
(window as unknown as { __epoch: unknown }).__epoch = { game, app, engine: game.engine };
