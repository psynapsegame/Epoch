import * as THREE from 'three';
import '@fontsource/cinzel/400.css';
import '@fontsource/cinzel/600.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import './styles.css';
import type { Game } from '../game';
import { SEASONS, SPEEDS } from '../sim/clock';
import type { Building } from '../sim/settlements';
import type { BuildingKind } from '../render/models/buildings';
import type { AtlasMode } from '../render/worldTextures';
import { exportSave, importSave, saveStore, type SaveData } from '../persistence/saveStore';
import { shareTextFile } from '../platform/platform';
import { PROFILES, QUALITY_TIERS, TIER_LABELS } from '../render/quality';
import { Water } from '../world/types';
import { ICONS } from './icons';

type SectionId = 'world' | 'population' | 'civilizations' | 'economy' | 'politics' | 'history' | 'atlas' | 'chronicles' | 'divinity';
const SECTIONS: { id: SectionId; label: string; phase: number }[] = [
  { id: 'world', label: 'Monde', phase: 1 },
  { id: 'population', label: 'Population', phase: 2 },
  { id: 'civilizations', label: 'Civilisations', phase: 3 },
  { id: 'economy', label: 'Économie', phase: 3 },
  { id: 'politics', label: 'Politique', phase: 4 },
  { id: 'history', label: 'Histoire', phase: 4 },
  { id: 'atlas', label: 'Atlas', phase: 1 },
  { id: 'chronicles', label: 'Chroniques', phase: 7 },
  { id: 'divinity', label: 'Divinité', phase: 6 },
];
const CURRENT_PHASE = 1;

const BUILDING_INFO: Record<BuildingKind, [string, string]> = {
  hut: ['Hutte', 'Abri rudimentaire pour une petite famille.'],
  house: ['Maison', 'Foyer à colombages : logement d’une famille.'],
  longhouse: ['Grande maison', 'Demeure commune, lieu d’assemblée du hameau.'],
  farm: ['Ferme', 'Chaumière et parcelle cultivée : production de nourriture.'],
  barn: ['Grange', 'Stockage des récoltes et abri du bétail.'],
  market: ['Marché', 'Étals où s’échangent les marchandises.'],
  workshop: ['Atelier', 'Transformation des matières premières par les artisans.'],
  storehouse: ['Entrepôt', 'Réserve commune de ressources.'],
  temple: ['Temple', 'Lieu de culte et de rassemblement.'],
  well: ['Puits', 'Source d’eau du hameau.'],
  windmill: ['Moulin', 'Mouture du grain en farine.'],
  watchtower: ['Tour de guet', 'Surveillance des alentours.'],
  dock: ['Ponton', 'Accès à la mer : pêche et, plus tard, navigation.'],
};

const QUOTE = ['Avant les royaumes,', ' avant les guerres,', ' avant les légendes,', ' il n’existait qu’un monde.'];
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmt = (n: number, d = 0) => n.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
const el = <T extends HTMLElement>(html: string): T => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as T;
};
const SEED_WORDS = ['Aurore', 'Cendre', 'Borée', 'Ys', 'Thulé', 'Ambre', 'Oriflamme', 'Solstice', 'Ether', 'Lumen', 'Mnémosyne', 'Avalon', 'Hespérie', 'Ogygie'];

/** Whole user interface. Reads the game state; every control calls a real engine/game function. */
export class App {
  private root = document.getElementById('ui')!;
  private topbar: HTMLElement;
  private nav: HTMLElement;
  private panel: HTMLElement;
  private inspector: HTMLElement;
  private viewbar: HTMLElement;
  private perf: HTMLElement;
  private tutorial: HTMLElement;
  private intro: HTMLElement;
  private toastEl: HTMLElement;
  private section: SectionId | null = null;
  private lastHud = 0;
  private tutorialState = { move: false, zoom: false, rotate: false, inspect: false, atlas: false };
  private camRef: { dir: THREE.Vector3; dist: number; heading: number } | null = null;
  private toastTimer = 0;
  private touch: boolean;

  constructor(private game: Game) {
    this.topbar = el(`<div id="topbar" class="glass fade out">
      <div id="brand"><b>EPOCH</b><span>The Living World</span></div>
      <div id="stats"></div><div id="speeds"></div></div>`);
    this.nav = el(`<nav id="nav" class="glass fade out"></nav>`);
    this.panel = el(`<section id="panel" class="glass closed"><header><h2 class="caps"></h2><button title="Fermer">×</button></header><div class="body"></div></section>`);
    this.inspector = el(`<aside id="inspector" class="glass closed"></aside>`);
    this.viewbar = el(`<div id="viewbar" class="glass fade out">
      <button data-a="strategic">Vue stratégique</button><button data-a="immersive">Vue immersive</button>
      <span class="sep"></span><span class="readout"></span><span class="sep"></span>
      <button data-a="perf" title="Diagnostic (F3)">Diagnostic</button><button data-a="help" title="Aide">Aide</button></div>`);
    this.perf = el(`<div id="perf" class="glass hidden"></div>`);
    this.touch = game.device.mobile;
    document.body.classList.toggle('touch', this.touch);
    this.applyUiQuality();
    const steps = this.touch
      ? ['Glisser un doigt pour parcourir le monde', 'Pincer avec deux doigts : de l’orbite jusqu’au sol', 'Tourner deux doigts pour pivoter, les glisser ensemble vers le haut pour incliner', 'Toucher une terre ou un bâtiment pour l’examiner', 'Ouvrir l’Atlas pour lire les données du monde']
      : ['Glisser avec le clic gauche pour parcourir le monde (<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>)', 'Molette : de l’orbite jusqu’au niveau du sol', 'Clic droit glissé : pivoter et incliner (<kbd>Q</kbd><kbd>E</kbd>)', 'Cliquer sur une terre ou un bâtiment pour l’examiner', 'Ouvrir l’Atlas pour lire les données du monde'];
    const keys = ['move', 'zoom', 'rotate', 'inspect', 'atlas'];
    this.tutorial = el(`<div id="tutorial" class="glass hidden"><h4 class="caps">Premiers pas <button>masquer</button></h4><ul>
      ${steps.map((t, i) => `<li data-k="${keys[i]}">${t}</li>`).join('')}</ul></div>`);
    const rotate = el(`<div id="rotate"><div>${ICONS.rotate}<p>Tournez votre appareil<br>EPOCH se joue en mode paysage</p></div></div>`);
    this.intro = el(`<div id="intro" class="fade"><div class="inner">
      <h1 class="title">EPOCH</h1><div class="subtitle">The Living World</div><div class="rule"></div>
      <p class="quote">${QUOTE.map((q) => `<span>${q}</span>`).join('')}</p>
      <div class="form" style="opacity:0">
        <div class="seed"><label for="seed">Graine</label><input id="seed" maxlength="32" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" enterkeyhint="go" /><button title="Graine aléatoire" data-a="dice">⚄</button></div>
        <div class="btns"><button class="btn primary" data-a="create">Créer le monde</button><button class="btn hidden" data-a="resume">Reprendre</button></div>
        <div class="err"></div>
      </div>
      <div class="progress hidden"><div class="stage"></div><div class="track"><i></i></div></div>
    </div></div>`);
    this.toastEl = el(`<div id="toast" class="glass closed"></div>`);
    this.root.append(this.topbar, this.nav, this.panel, this.inspector, this.viewbar, this.perf, this.tutorial, this.toastEl, this.intro, rotate);

    this.buildTopbar();
    this.buildNav();
    this.bindViewbar();
    this.bindIntro();
    this.panel.querySelector('header button')!.addEventListener('click', () => this.openSection(null));
    this.tutorial.querySelector('button')!.addEventListener('click', () => this.endTutorial());

    game.engine.controls.onClick = (ev) => this.onWorldClick(ev);
    game.onTick = () => this.tick();
    game.onQualityChange = (tier, automatic) => {
      this.applyUiQuality();
      if (automatic) this.toast(`Qualité graphique adaptée à l’appareil : ${TIER_LABELS[tier]}`);
      if (this.section === 'world') void this.renderWorldPanel();
    };
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.code === 'F3') { e.preventDefault(); this.perf.classList.toggle('hidden'); }
      if (e.code === 'Space' && game.running) { e.preventDefault(); game.setSpeed(game.clock.speedIndex === 0 ? 1 : 0); }
      if (e.code === 'Escape') { this.openSection(null); this.inspector.classList.add('closed'); }
      const n = Number(e.key);
      if (game.running && n >= 1 && n <= SPEEDS.length - 1) game.setSpeed(n);
    });
  }

  /** Panels drop their blur on tiers where it would cost too much GPU time. */
  private applyUiQuality(): void {
    document.body.classList.toggle('no-glass', !PROFILES[this.game.tier].glassUi);
  }

  // ------------------------------------------------------------------ HUD
  private buildTopbar(): void {
    const stats = this.topbar.querySelector('#stats')!;
    const defs: [string, string, string?][] = [
      ['date', 'Année', 'date'], ['season', 'Saison'], ['hour', 'Heure locale', 'opt'], ['pop', 'Population'],
      ['civ', 'Civilisations'], ['city', 'Villes'], ['war', 'Conflits'], ['temp', 'Température', 'opt2'],
    ];
    for (const [id, label, cls] of defs) stats.append(el(`<div class="stat ${cls ?? ''}"><label>${label}</label><b data-s="${id}">—</b></div>`));
    const speeds = this.topbar.querySelector('#speeds')!;
    SPEEDS.forEach((s, i) => {
      const b = el<HTMLButtonElement>(`<button title="${i === 0 ? 'Pause (Espace)' : 'Vitesse ' + s.label}">${i === 0 ? '❚❚' : s.label}</button>`);
      b.addEventListener('click', () => this.game.setSpeed(i));
      speeds.append(b);
    });
  }

  private buildNav(): void {
    for (const s of SECTIONS) {
      const locked = s.phase > CURRENT_PHASE;
      const b = el<HTMLButtonElement>(`<button class="${locked ? 'locked' : ''}" data-id="${s.id}" aria-label="${s.label}${locked ? ` (phase ${s.phase})` : ''}">
        ${ICONS[s.id]}<span class="tip">${s.label}${locked ? `<i>— arrive en phase ${s.phase}</i>` : ''}</span></button>`);
      b.addEventListener('click', () => {
        if (locked) this.toast(`${s.label} — arrive en phase ${s.phase}`);
        else this.openSection(this.section === s.id ? null : s.id);
      });
      this.nav.append(b);
    }
  }

  private bindViewbar(): void {
    this.viewbar.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('button')?.dataset.a;
      const c = this.game.engine.controls;
      if (a === 'strategic') c.strategicView();
      if (a === 'immersive') c.immersiveView();
      if (a === 'perf') this.perf.classList.toggle('hidden');
      if (a === 'help') this.toggleHelp();
    });
  }

  private toggleHelp(): void {
    this.tutorial.classList.toggle('hidden');
    this.tutorial.querySelectorAll('li').forEach((li) => li.classList.remove('done'));
    this.tutorialState = { move: false, zoom: false, rotate: false, inspect: false, atlas: false };
    this.camRef = null;
  }

  private tick(): void {
    const now = performance.now();
    if (now - this.lastHud < 180) return;
    this.lastHud = now;
    const g = this.game;
    if (!g.world) return;
    const set = (id: string, v: string) => {
      const n = this.topbar.querySelector(`[data-s="${id}"]`)!;
      if (n.textContent !== v) n.textContent = v;
    };
    const d = g.date;
    const sum = g.summary;
    const south = g.engine.controls.dir.y < 0;
    set('date', `An ${fmt(d.year)} · jour ${d.dayOfYear + 1}`);
    set('season', SEASONS[(d.season + (south ? 2 : 0)) % 4]);
    const h = g.engine.localHour(g.clock.time);
    set('hour', `${String(Math.floor(h)).padStart(2, '0')} h ${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`);
    set('pop', fmt(sum.population));
    set('civ', fmt(sum.civilizations));
    set('city', fmt(sum.settlements));
    set('war', fmt(sum.conflicts));
    const t = g.focusTemperature();
    set('temp', t === null ? '—' : `${fmt(t, 1)} °C`);
    this.topbar.querySelectorAll('#speeds button').forEach((b, i) => b.classList.toggle('on', i === g.clock.speedIndex));

    const c = g.engine.controls;
    const lat = (Math.asin(c.dir.y) * 180) / Math.PI, lon = (Math.atan2(c.dir.z, c.dir.x) * 180) / Math.PI;
    this.viewbar.querySelector('.readout')!.textContent =
      `${fmt(Math.abs(lat), 1)}° ${lat >= 0 ? 'N' : 'S'}  ${fmt(Math.abs(lon), 1)}° ${lon >= 0 ? 'E' : 'O'}  ·  altitude ${fmt(Math.max(0, c.altitude))} m`;

    if (!this.perf.classList.contains('hidden')) {
      const p = g.engine.perf;
      this.perf.innerHTML = `<b>DIAGNOSTIC</b><br>FPS ${fmt(p.fps)} (cible ${g.pacedFps}) · image ${fmt(p.frameMs, 1)} ms<br>Qualité ${TIER_LABELS[g.tier]} · résolution ${fmt(g.governor.scale * 100)} %<br>Appels de dessin ${fmt(p.drawCalls)}<br>Triangles ${fmt(p.triangles)}<br>Parcelles de terrain ${p.chunks} / ${p.chunksTotal} (file ${p.queue})<br>Arbres affichés ${fmt(p.trees)}<br>Bâtiments ${fmt(p.buildings)}<br>Géométries ${p.geometries} · textures ${p.textures}<br>Individus simulés ${fmt(sum.population)}`;
    }
    this.trackTutorial();
  }

  // ------------------------------------------------------------- tutorial
  private trackTutorial(): void {
    if (this.tutorial.classList.contains('hidden') || !this.game.running) return;
    const c = this.game.engine.controls;
    if (!this.camRef) this.camRef = { dir: c.goalDir.clone(), dist: c.goalDistance, heading: c.goalHeading };
    const s = this.tutorialState;
    if (c.goalDir.angleTo(this.camRef.dir) > 0.01) s.move = true;
    if (Math.abs(Math.log(c.goalDistance / this.camRef.dist)) > 0.25) s.zoom = true;
    if (Math.abs(c.goalHeading - this.camRef.heading) > 0.15) s.rotate = true;
    let all = true;
    for (const k of Object.keys(s) as (keyof typeof s)[]) {
      this.tutorial.querySelector(`[data-k="${k}"]`)!.classList.toggle('done', s[k]);
      if (!s[k]) all = false;
    }
    if (all) window.setTimeout(() => this.endTutorial(), 1800);
  }

  private endTutorial(): void {
    this.tutorial.classList.add('hidden');
    try { localStorage.setItem('epoch.tutorial', 'done'); } catch { /* storage unavailable */ }
  }

  toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.remove('closed');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.add('closed'), 3200);
  }

  // --------------------------------------------------------------- panels
  private openSection(id: SectionId | null): void {
    this.section = id;
    this.nav.querySelectorAll('button').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.id === id));
    this.panel.classList.toggle('closed', id === null);
    if (id === 'world') void this.renderWorldPanel();
    if (id === 'atlas') {
      this.tutorialState.atlas = true;
      this.renderAtlasPanel();
    }
  }

  private async renderWorldPanel(): Promise<void> {
    const g = this.game, w = g.world;
    if (!w) return;
    this.panel.querySelector('h2')!.textContent = 'Monde';
    const st = w.data.stats;
    const cellKm = w.cellSize / 1000;
    const body = this.panel.querySelector('.body')!;
    const continents = w.data.landmasses.filter((l) => l.kind === 'continent');
    const islands = w.data.landmasses.filter((l) => l.kind === 'island');
    let saves: SaveData[] = [];
    try { saves = await saveStore.list(); } catch { /* IndexedDB unavailable */ }
    if (this.section !== 'world') return;
    const slotRow = (slot: string, label: string) => {
      const s = saves.find((x) => x.slot === slot);
      return `<div class="row"><span><span class="name">${label}</span><br><small>${s ? `${esc(s.seed)} · an ${fmt(Math.floor(s.simTime / 31104000) + 1)} · ${new Date(s.savedAt).toLocaleString('fr-FR')}` : 'Vide'}</small></span>
        <span class="btns">${slot !== 'auto' ? `<button class="btn" data-save="${slot}">Sauver</button>` : ''}${s ? `<button class="btn" data-load="${slot}">Charger</button>` : ''}</span></div>`;
    };
    body.innerHTML = `
      <h3>Planète</h3>
      <div class="kv">
        <span>Graine</span><b>${esc(w.data.seed)}</b>
        <span>Circonférence</span><b>${fmt((2 * Math.PI * w.R) / 1000, 1)} km</b>
        <span>Terres émergées</span><b>${fmt(st.landRatio * 100, 1)} %</b>
        <span>Point culminant</span><b>${fmt(st.maxElevation)} m</b>
        <span>Température moyenne des terres</span><b>${fmt(st.meanLandTemperature, 1)} °C</b>
        <span>Cours d’eau</span><b>${fmt(st.riverCells * cellKm, 1)} km</b>
        <span>Lacs</span><b>${fmt(st.lakeCells * cellKm * cellKm, 2)} km²</b>
        <span>Volcans</span><b>${w.data.volcanoes.length}</b>
        <span>Gisements</span><b>${w.data.deposits.length}</b>
      </div>
      <h3>Continents (${continents.length}) et îles (${islands.length})</h3>
      <div class="list">${w.data.landmasses.slice(0, 8).map((l) => `<button class="row" data-land="${l.id}"><span class="name">${esc(l.name)}</span><small>${l.kind === 'continent' ? 'Continent' : 'Île'} · ${fmt(l.area, 2)} km²</small></button>`).join('')}</div>
      <h3>Hameaux fondateurs</h3>
      <div class="list">${g.settlements.map((s) => `<button class="row" data-settle="${s.id}"><span class="name">${esc(s.name)}</span><small>${s.buildings.length} bâtiments · inhabité</small></button>`).join('')}</div>
      <p class="note">Bâtis sur les terres les plus propices du monde (fertilité, eau douce, relief). Leurs premiers habitants arriveront avec la phase 2.</p>
      <h3>Terres propices encore vierges</h3>
      <div class="list">${w.data.sites.slice(g.settlements.length, g.settlements.length + 6).map((s, i) => `<button class="row" data-site="${i + g.settlements.length}"><span class="name">Site ${i + 1 + g.settlements.length}</span><small>${[s.riverside ? 'eau douce' : '', s.coastal ? 'côtier' : ''].filter(Boolean).join(' · ') || 'intérieur'} · indice ${fmt(s.score * 100)}</small></button>`).join('')}</div>
      <h3>Sauvegardes</h3>
      <div class="list">${slotRow('auto', 'Automatique')}${slotRow('slot1', 'Emplacement I')}${slotRow('slot2', 'Emplacement II')}${slotRow('slot3', 'Emplacement III')}</div>
      <div class="btns" style="margin-top:10px"><button class="btn" data-a="export">Exporter</button><button class="btn" data-a="import">Importer</button><button class="btn" data-a="new">Nouveau monde</button></div>
      <h3>Affichage et énergie</h3>
      <div class="btns">${(['auto', ...QUALITY_TIERS] as const).map((q) => `<button class="btn ${g.settings.quality === q ? 'primary' : ''}" data-q="${q}">${q === 'auto' ? 'Auto' : TIER_LABELS[q]}</button>`).join('')}</div>
      <p class="note">Qualité active : ${TIER_LABELS[g.tier]}${g.settings.quality === 'auto' ? ' (adaptée automatiquement aux performances de l’appareil)' : ''}.</p>
      <div class="btns" style="margin-top:8px"><button class="btn ${g.settings.eco ? 'primary' : ''}" data-a="eco">Économie d’énergie</button><button class="btn" data-a="perf">Diagnostic</button><button class="btn" data-a="help">Aide</button></div>
      <p class="note">L’économie d’énergie limite l’affichage à 30 images par seconde (20 au repos) pour ménager la batterie et la température du téléphone.</p>`;
    body.querySelectorAll<HTMLElement>('[data-land]').forEach((b) => b.addEventListener('click', () => {
      const l = w.data.landmasses.find((x) => x.id === Number(b.dataset.land))!;
      const d = new THREE.Vector3();
      w.cellDir(l.x, l.y, d);
      g.engine.controls.flyTo(d, Math.max(1200, Math.sqrt(l.area) * 1700));
    }));
    body.querySelectorAll<HTMLElement>('[data-settle]').forEach((b) => b.addEventListener('click', () => {
      const s = g.settlements.find((x) => x.id === Number(b.dataset.settle))!;
      g.engine.controls.flyTo(new THREE.Vector3(s.dir.x, s.dir.y, s.dir.z), 230, 1.08);
    }));
    body.querySelectorAll<HTMLElement>('[data-site]').forEach((b) => b.addEventListener('click', () => {
      const s = w.data.sites[Number(b.dataset.site)];
      const d = new THREE.Vector3();
      w.cellDir(s.x, s.y, d);
      g.engine.controls.flyTo(d, 420, 1.0);
    }));
    body.querySelectorAll<HTMLElement>('[data-save]').forEach((b) => b.addEventListener('click', async () => {
      try { await g.save(b.dataset.save!); this.toast('Partie sauvegardée'); } catch (e) { this.toast(`Échec de la sauvegarde : ${(e as Error).message}`); }
      void this.renderWorldPanel();
    }));
    body.querySelectorAll<HTMLElement>('[data-load]').forEach((b) => b.addEventListener('click', async () => {
      const s = await saveStore.get(b.dataset.load!);
      if (s) void this.loadSave(s);
    }));
    body.querySelectorAll<HTMLElement>('[data-q]').forEach((b) => b.addEventListener('click', () => g.setQuality(b.dataset.q as typeof g.settings.quality)));
    body.querySelector('[data-a="eco"]')!.addEventListener('click', () => { g.setEco(!g.settings.eco); void this.renderWorldPanel(); });
    body.querySelector('[data-a="perf"]')!.addEventListener('click', () => this.perf.classList.toggle('hidden'));
    body.querySelector('[data-a="help"]')!.addEventListener('click', () => { this.openSection(null); this.toggleHelp(); });
    body.querySelector('[data-a="export"]')!.addEventListener('click', async () => {
      const name = `epoch-${w.data.seed.replace(/[^\w-]+/g, '_')}-an${g.date.year}.json`;
      try {
        await shareTextFile(name, exportSave(g.snapshot('export')));
      } catch (e) {
        this.toast(`Export impossible : ${(e as Error).message}`);
      }
    });
    body.querySelector('[data-a="import"]')!.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try { void this.loadSave(importSave(await file.text())); } catch (e) { this.toast((e as Error).message); }
      };
      input.click();
    });
    body.querySelector('[data-a="new"]')!.addEventListener('click', async () => {
      await g.autosave();
      this.showTitle();
    });
  }

  private renderAtlasPanel(): void {
    const e = this.game.engine;
    this.panel.querySelector('h2')!.textContent = 'Atlas';
    const body = this.panel.querySelector('.body')!;
    const mode = e.atlasModes.find((m) => m.id === e.atlas)!;
    body.innerHTML = `<h3>Cartes</h3><div class="list">${e.atlasModes.map((m) => `<button class="row ${m.id === e.atlas ? 'on' : ''}" data-mode="${m.id}"><span class="name">${m.label}</span></button>`).join('')}</div>
      ${mode.legend.length ? `<h3>Légende</h3><div class="legend">${mode.legend.map(([c, l]) => `<div><i style="background:${c}"></i>${l}</div>`).join('')}</div>` : ''}
      <p class="note">Chaque carte est tracée à partir des champs réels du monde (grille de ${fmt(this.game.world!.W)} × ${fmt(this.game.world!.H)} cellules). Populations, frontières, cultures, religions, commerce et guerres s’ajouteront avec les phases correspondantes.</p>`;
    body.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) => b.addEventListener('click', () => {
      e.setAtlasMode(b.dataset.mode as AtlasMode);
      this.renderAtlasPanel();
    }));
  }

  // ------------------------------------------------------------ inspector
  private onWorldClick(ev: PointerEvent): void {
    const g = this.game;
    if (!g.world || !g.running) return;
    const hit = g.engine.pick(ev.clientX, ev.clientY);
    if (!hit) { this.inspector.classList.add('closed'); return; }
    this.tutorialState.inspect = true;
    if (hit.type === 'building') this.showBuilding(hit.building);
    else this.showCell(hit.cell);
  }

  private showCell(cell: number): void {
    const g = this.game, w = g.world!;
    const c = w.describe(cell);
    const d = g.date;
    const phase = Math.sin(((d.dayOfYear + d.hour / 24) / 360) * 2 * Math.PI);
    const now = w.seasonalTemperature(cell, phase);
    const site = w.data.sites.findIndex((s) => Math.abs(s.x - c.x) < 14 && Math.abs(s.y - c.y) < 14);
    const land = c.water !== Water.Ocean;
    const where = c.landmass ? `${c.landmass.kind === 'continent' ? 'Continent' : 'Île'} de ${esc(c.landmass.name)}` : 'Haute mer';
    this.inspector.innerHTML = `<button class="close">×</button>
      <div class="kicker">${land ? 'Terre' : 'Océan'} · ${esc(c.climate)}</div>
      <h2>${esc(c.biomeName)}</h2>
      <div class="sub">${where} · ${fmt(Math.abs(c.latitude), 1)}° ${c.latitude >= 0 ? 'N' : 'S'}, ${fmt(Math.abs(c.longitude), 1)}° ${c.longitude >= 0 ? 'E' : 'O'}</div>
      <div class="kv">
        <span>${land ? 'Altitude' : 'Profondeur'}</span><b>${fmt(Math.abs(c.elevation))} m</b>
        <span>Température actuelle</span><b>${fmt(now, 1)} °C</b>
        <span>Moyenne annuelle</span><b>${fmt(c.temperature, 1)} °C</b>
        <span>Précipitations</span><b>${fmt(c.moisture * 100)} %</b>
        ${land ? `<span>Fertilité</span><b>${fmt(c.fertility * 100)} %</b><span>Couvert forestier</span><b>${fmt(c.forest * 100)} %</b>` : ''}
        <span>Biodiversité</span><b>${fmt(c.biodiversity * 100)} %</b>
        ${c.mineral ? `<span>Gisement</span><b>${c.mineral.name} · ${fmt(c.mineral.richness * 100)} %</b>` : ''}
      </div>
      <div class="tags">${c.constraints.map((t) => `<span>${esc(t)}</span>`).join('')}${site >= 0 ? '<span class="good">Terre propice à un village</span>' : ''}${c.water === Water.River ? '<span class="good">Eau douce</span>' : ''}</div>`;
    this.inspector.classList.remove('closed');
    this.inspector.querySelector('.close')!.addEventListener('click', () => this.inspector.classList.add('closed'));
  }

  private showBuilding(b: Building): void {
    const g = this.game;
    const s = g.settlements.find((x) => x.id === b.settlement);
    const [name, desc] = BUILDING_INFO[b.kind];
    const cell = g.world!.cellAt(b.dir.x, b.dir.y, b.dir.z);
    const c = g.world!.describe(cell);
    this.inspector.innerHTML = `<button class="close">×</button>
      <div class="kicker">Bâtiment · n° ${b.id}</div><h2>${name}</h2>
      <div class="sub">${s ? `Hameau de ${esc(s.name)}` : ''}</div>
      <p class="note" style="margin:0 0 12px">${desc}</p>
      <div class="kv"><span>Occupants</span><b>Aucun</b><span>Production</span><b>À l’arrêt</b>
      <span>Terrain</span><b>${esc(c.biomeName)}</b><span>Altitude</span><b>${fmt(c.elevation)} m</b><span>Fertilité alentour</span><b>${fmt(c.fertility * 100)} %</b></div>
      <p class="note">Ce bâtiment attend ses premiers habitants : la population autonome arrive en phase 2, l’économie en phase 3.</p>`;
    this.inspector.classList.remove('closed');
    this.inspector.querySelector('.close')!.addEventListener('click', () => this.inspector.classList.add('closed'));
  }

  // ---------------------------------------------------------------- intro
  private hud(show: boolean): void {
    for (const n of [this.topbar, this.nav, this.viewbar]) n.classList.toggle('out', !show);
    if (!show) {
      this.openSection(null);
      this.inspector.classList.add('closed');
      this.tutorial.classList.add('hidden');
    }
  }

  private bindIntro(): void {
    const input = this.intro.querySelector<HTMLInputElement>('#seed')!;
    const dice = () => { input.value = `${SEED_WORDS[Math.floor(Math.random() * SEED_WORDS.length)]}-${Math.floor(Math.random() * 9000 + 1000)}`; };
    dice();
    this.intro.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('button')?.dataset.a;
      if (a === 'dice') dice();
      if (a === 'create') void this.createWorld(input.value.trim() || 'Epoch');
      if (a === 'resume') void saveStore.get('auto').then((s) => s && this.loadSave(s));
      if (a === 'enter') this.enterWorld(true);
    });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && void this.createWorld(input.value.trim() || 'Epoch'));
    this.showTitle();
  }

  /** Title screen: the quote appears line by line, then the seed form. */
  private showTitle(): void {
    const g = this.game;
    g.running = false;
    this.hud(false);
    g.engine.controls.cinematic = true;
    this.intro.classList.remove('out', 'reveal');
    this.intro.querySelector('.progress')!.classList.add('hidden');
    const form = this.intro.querySelector<HTMLElement>('.form')!;
    form.classList.remove('hidden');
    form.style.opacity = '0';
    this.intro.querySelector('.err')!.textContent = '';
    const quote = this.intro.querySelector('.quote')!;
    quote.innerHTML = QUOTE.map((q) => `<span>${q}</span>`).join('');
    quote.querySelectorAll('span').forEach((s, i) => window.setTimeout(() => s.classList.add('in'), 500 + i * 1100));
    window.setTimeout(() => (form.style.opacity = '1'), 500 + QUOTE.length * 1100);
    saveStore.get('auto').then((s) => this.intro.querySelector('[data-a="resume"]')!.classList.toggle('hidden', !s)).catch(() => {});
  }

  private progress(stage: string, index: number, p: number): void {
    const box = this.intro.querySelector('.progress')!;
    box.querySelector('.stage')!.textContent = stage;
    const STAGES = 11;
    (box.querySelector('.track i') as HTMLElement).style.width = `${Math.min(100, ((index + p) / STAGES) * 100)}%`;
  }

  private beginLoading(): void {
    this.intro.querySelector('.form')!.classList.add('hidden');
    this.intro.querySelector('.progress')!.classList.remove('hidden');
    this.progress('Éveil du monde', 0, 0);
  }

  private async createWorld(seed: string): Promise<void> {
    const g = this.game;
    this.beginLoading();
    try {
      await g.createWorld(seed, (s, i, p) => this.progress(s, i, p));
    } catch (e) {
      this.showTitle();
      this.intro.querySelector('.err')!.textContent = (e as Error).message;
      return;
    }
    // Reveal: a cinematic orbit over the newborn, still empty planet.
    const w = g.world!;
    const continents = w.data.landmasses.filter((l) => l.kind === 'continent').length;
    const islands = w.data.landmasses.length - continents;
    this.intro.classList.add('reveal');
    this.intro.querySelector('.progress')!.classList.add('hidden');
    const quote = this.intro.querySelector('.quote')!;
    quote.innerHTML = `<span>Un monde est né de la graine « ${esc(seed)} ».</span><br><span>${continents} continent${continents > 1 ? 's' : ''}, ${islands} île${islands > 1 ? 's' : ''}, ${w.data.volcanoes.length} volcans, et pas encore une seule âme.</span>`;
    quote.querySelectorAll('span').forEach((s, i) => window.setTimeout(() => s.classList.add('in'), 600 + i * 1800));
    const form = this.intro.querySelector<HTMLElement>('.form')!;
    form.classList.remove('hidden');
    form.style.opacity = '0';
    form.innerHTML = `<button class="btn primary" data-a="enter">Descendre sur le monde</button>`;
    window.setTimeout(() => (form.style.opacity = '1'), 3600);
  }

  private async loadSave(save: SaveData): Promise<void> {
    const g = this.game;
    g.running = false;
    this.hud(false);
    this.intro.classList.remove('out', 'reveal');
    this.beginLoading();
    try {
      const { checksumOk } = await g.load(save, (s, i, p) => this.progress(s, i, p));
      this.enterWorld(false);
      this.toast(checksumOk ? `Partie restaurée — an ${g.date.year}` : 'Partie restaurée (monde régénéré par une version différente du générateur)');
    } catch (e) {
      this.showTitle();
      this.intro.querySelector('.err')!.textContent = (e as Error).message;
    }
  }

  private enterWorld(fresh: boolean): void {
    const g = this.game;
    this.intro.classList.add('out');
    g.engine.controls.cinematic = false;
    g.running = true;
    this.hud(true);
    // restore the seed form for a later "new world"
    const form = this.intro.querySelector<HTMLElement>('.form')!;
    window.setTimeout(() => {
      form.innerHTML = `<div class="seed"><label for="seed">Graine</label><input id="seed" maxlength="32" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" enterkeyhint="go" /><button title="Graine aléatoire" data-a="dice">⚄</button></div>
        <div class="btns"><button class="btn primary" data-a="create">Créer le monde</button><button class="btn hidden" data-a="resume">Reprendre</button></div><div class="err"></div>`;
      const input = form.querySelector<HTMLInputElement>('#seed')!;
      input.value = `${SEED_WORDS[Math.floor(Math.random() * SEED_WORDS.length)]}-${Math.floor(Math.random() * 9000 + 1000)}`;
      input.addEventListener('keydown', (e) => e.key === 'Enter' && void this.createWorld(input.value.trim() || 'Epoch'));
    }, 1000);
    if (fresh) {
      const s = g.settlements[0];
      if (s) g.engine.controls.flyTo(new THREE.Vector3(s.dir.x, s.dir.y, s.dir.z), 1500);
      let seen = false;
      try { seen = localStorage.getItem('epoch.tutorial') === 'done'; } catch { /* ignore */ }
      if (!seen) this.tutorial.classList.remove('hidden');
    }
  }
}
