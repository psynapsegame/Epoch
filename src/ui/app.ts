import * as THREE from 'three';
import '@fontsource/cinzel/400.css';
import '@fontsource/cinzel/600.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import './styles.css';
import type { Game } from '../game';
import { SEASONS, SECONDS_PER_YEAR, SPEEDS } from '../sim/clock';
import { BUILDING_NAMES, TRADITION_NAMES, eventText, formatDate, memoryText } from '../sim/text';
import { TECHS, TECH_BY_ID } from '../sim/tech';
import { FAITH_COLORS_HEX, civCss } from '../render/palette';
import { siteFrame } from '../sim/sites';
import { POWERS, POWER_ORDER, type DivinePower } from '../sim/divine';
import { chronicleText, type Chronicle } from '../sim/chronicle';
import {
  ACTIVITY_LABELS, CULTURE_AXES, GOVERNMENT_LABELS, JOB_LABELS_F, JOB_LABELS_M, NEED_LABELS, RESOURCE_LABELS, RULER_TITLES, SKILL_LABELS, TRAIT_LABELS,
  WAR_CAUSE_LABELS, type DeadPerson, type FamilyTree, type Person, type PersonView, type SimEvent, type TreeNode,
} from '../sim/types';
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
  { id: 'civilizations', label: 'Civilisations', phase: 4 },
  { id: 'economy', label: 'Économie', phase: 3 },
  { id: 'politics', label: 'Politique', phase: 4 },
  { id: 'history', label: 'Histoire', phase: 4 },
  { id: 'atlas', label: 'Atlas', phase: 1 },
  { id: 'chronicles', label: 'Chroniques', phase: 7 },
  { id: 'divinity', label: 'Divinité', phase: 6 },
];
const CURRENT_PHASE = 7;

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
  mine: ['Mine', 'Galerie étayée : extraction de la pierre et des minerais.'],
};

const QUOTE = ['Avant les royaumes,', ' avant les guerres,', ' avant les légendes,', ' il n’existait qu’un monde.'];
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const fmt = (n: number, d = 0) => n.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
const el = <T extends HTMLElement>(html: string): T => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as T;
};
const MARK_LABELS: Record<string, string> = { drought: 'sécheresse', storm: 'tempête', blessed: 'bénie', protected: 'protégée', game: 'gibier abondant' };
const faithCss = (id: number) => `#${FAITH_COLORS_HEX[(id - 1) % FAITH_COLORS_HEX.length].toString(16).padStart(6, '0')}`;
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
  private inspectorHeld = false;
  private panelHeld = false;
  private lastPopulationUpdate = 0;
  private econSite = 0;
  private civShown = 0;
  private armed: DivinePower | null = null;
  private chron: Chronicle | null = null;
  private chronScope = 0;
  /** Person whose family tree is shown in the inspector (0 = none). */
  private treeFor = 0;
  private armedBar: HTMLElement;
  private historyFilter = 'all';
  private labels: HTMLElement;
  private labelNodes = new Map<number, HTMLButtonElement>();
  private frames = new Map<number, ReturnType<typeof siteFrame>>();
  private shownBuilding = 0;
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
      ? ['Glisser un doigt pour parcourir le monde', 'Pincer avec deux doigts : de l’orbite jusqu’au sol', 'Tourner deux doigts pour pivoter, les glisser ensemble vers le haut pour incliner', 'Toucher un habitant, un bâtiment ou une terre pour l’examiner', 'Ouvrir l’Atlas pour lire les données du monde']
      : ['Glisser avec le clic gauche pour parcourir le monde (<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>)', 'Molette : de l’orbite jusqu’au niveau du sol', 'Clic droit glissé : pivoter et incliner (<kbd>Q</kbd><kbd>E</kbd>)', 'Cliquer sur un habitant, un bâtiment ou une terre pour l’examiner', 'Ouvrir l’Atlas pour lire les données du monde'];
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
    this.labels = el(`<div id="labels" class="fade out"></div>`);
    this.armedBar = el(`<div id="armed" class="glass hidden"><div><b></b><br><span></span></div><button class="btn" data-a="disarm">Annuler</button></div>`);
    this.armedBar.querySelector('button')!.addEventListener('click', () => this.arm(null));
    this.root.append(this.labels, this.armedBar);
    this.root.append(this.topbar, this.nav, this.panel, this.inspector, this.viewbar, this.perf, this.tutorial, this.toastEl, this.intro, rotate);

    this.buildTopbar();
    this.buildNav();
    this.bindViewbar();
    this.bindIntro();
    this.panel.querySelector('header button')!.addEventListener('click', () => this.openSection(null));
    this.tutorial.querySelector('button')!.addEventListener('click', () => this.endTutorial());

    game.engine.controls.onClick = (ev) => this.onWorldClick(ev);
    game.onTick = () => this.tick();
    game.sim.onDetail = (id, view) => {
      if (id === game.selected && view && !this.inspectorHeld && !this.treeFor) this.renderPerson(view);
    };
    game.sim.onRoster = () => {
      if (this.section === 'population') this.renderPopulationPanel();
      if (this.section === 'world') void this.renderWorldPanel();
    };
    game.engine.controls.onPan = () => { game.following = false; };
    game.onWorldView = () => {
      if (this.panelHeld) return;
      if (this.section === 'civilizations') this.renderCivPanel();
      if (this.section === 'politics') this.renderPoliticsPanel();
      if (this.section === 'history' && document.activeElement?.tagName !== 'INPUT') this.renderHistoryPanel();
      if (this.section === 'divinity') this.updateDivinity();
    };
    game.onBuildings = () => {
      const b = game.buildings.find((x) => x.id === this.shownBuilding);
      if (b && !this.inspectorHeld && !this.inspector.classList.contains('closed') && !game.selected) this.showBuilding(b);
    };
    this.panel.addEventListener('pointerdown', () => (this.panelHeld = true));
    window.addEventListener('pointerup', () => (this.panelHeld = false));
    window.addEventListener('pointercancel', () => (this.panelHeld = false));
    this.inspector.addEventListener('pointerdown', () => (this.inspectorHeld = true));
    window.addEventListener('pointerup', () => (this.inspectorHeld = false));
    window.addEventListener('pointercancel', () => (this.inspectorHeld = false));
    this.inspector.addEventListener('click', (e) => this.onInspectorClick(e));
    game.onQualityChange = (tier, automatic) => {
      this.applyUiQuality();
      if (automatic) this.toast(`Qualité graphique adaptée à l’appareil : ${TIER_LABELS[tier]}`);
      if (this.section === 'world') void this.renderWorldPanel();
    };
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.code === 'F3') { e.preventDefault(); this.perf.classList.toggle('hidden'); }
      if (e.code === 'Space' && game.running) { e.preventDefault(); game.setSpeed(game.clock.speedIndex === 0 ? 1 : 0); }
      if (e.code === 'Escape') { this.openSection(null); this.closeInspector(); this.arm(null); }
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
    this.updateLabels(); // every frame: they must stick to the moving world
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
      this.perf.innerHTML = `<b>DIAGNOSTIC</b><br>FPS ${fmt(p.fps)} (cible ${g.pacedFps}) · image ${fmt(p.frameMs, 1)} ms<br>Qualité ${TIER_LABELS[g.tier]} · résolution ${fmt(g.governor.scale * 100)} %<br>Appels de dessin ${fmt(p.drawCalls)}<br>Triangles ${fmt(p.triangles)}<br>Parcelles de terrain ${p.chunks} / ${p.chunksTotal} (file ${p.queue})<br>Arbres affichés ${fmt(p.trees)}<br>Bâtiments ${fmt(p.buildings)}<br>Habitants affichés ${fmt(p.people)}${g.sim.lagging ? ' · simulation ralentie' : ''}<br>Géométries ${p.geometries} · textures ${p.textures}<br>Individus simulés ${fmt(sum.population)}`;
    }
    if (this.section === 'population' && now - this.lastPopulationUpdate > 900) this.updatePopulation();
    if (this.section === 'economy' && now - this.lastPopulationUpdate > 900 && !this.panelHeld) this.renderEconomyPanel();
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
    if (id === 'population') this.renderPopulationPanel();
    if (id === 'economy') this.renderEconomyPanel();
    if (id === 'civilizations') this.renderCivPanel();
    if (id === 'politics') this.renderPoliticsPanel();
    if (id === 'history') this.renderHistoryPanel();
    if (id === 'divinity') this.renderDivinityPanel();
    if (id === 'chronicles') void this.loadChronicle(this.chronScope);
    if (id === 'atlas') {
      this.tutorialState.atlas = true;
      this.renderAtlasPanel();
    }
  }

  /** Name of a settlement's rank from its real population. */
  private tier(pop: number): string {
    return pop === 0 ? 'Site désert' : pop < 60 ? 'Hameau' : pop < 200 ? 'Village' : pop < 500 ? 'Bourg' : 'Ville';
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
      <div class="list">${g.settlements.map((s) => `<button class="row" data-settle="${s.id}"><span class="name">${esc(s.name)}</span><small>${this.tier(g.sim.roster.filter((r) => r.settlement === s.id).length)} · ${g.buildings.filter((b) => b.settlement === s.id && (b.progress ?? 1) >= 1).length} bâtiments · ${g.sim.roster.filter((r) => r.settlement === s.id).length} habitants</small></button>`).join('')}</div>
      <p class="note">Bâtis sur les terres les plus propices du monde (fertilité, eau douce, relief). Les familles fondatrices s’y sont installées à l’aube de l’an 1.</p>
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
    const mode = e.atlasModes.find((m) => m.id === this.game.atlasMode) ?? e.atlasModes[0];
    body.innerHTML = `<h3>Cartes</h3><div class="list">${e.atlasModes.map((m) => `<button class="row ${m.id === this.game.atlasMode ? 'on' : ''}" data-mode="${m.id}"><span class="name">${m.label}</span></button>`).join('')}</div>
      ${mode.legend.length ? `<h3>Légende</h3><div class="legend">${mode.legend.map(([c, l]) => `<div><i style="background:${c}"></i>${l}</div>`).join('')}</div>` : ''}
      <p class="note">Chaque carte est tracée à partir des champs réels du monde (grille de ${fmt(this.game.world!.W)} × ${fmt(this.game.world!.H)} cellules). Frontières, population, religions et guerres sont peintes d’après la simulation en cours.</p>
      ${this.game.atlasMode === 'borders' || this.game.atlasMode === 'religions' ? `<h3>Légende</h3><div class="legend">${this.game.atlasMode === 'borders' ? (this.game.sim.world?.civs.filter((c) => !c.fallen).map((c) => `<div><i style="background:${civCss(c.color)}"></i>${esc(c.name)}</div>`).join('') ?? '') : (this.game.sim.world?.religions.filter((r) => !r.ended).map((r) => `<div><i style="background:${faithCss(r.id)}"></i>${esc(r.name)}</div>`).join('') ?? '')}</div>` : ''}`;
    body.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) => b.addEventListener('click', () => {
      this.game.setAtlas(b.dataset.mode as AtlasMode);
      this.renderAtlasPanel();
    }));
  }

  // ------------------------------------------------------------ inspector
  private closeInspector(): void {
    this.inspector.classList.add('closed');
    this.treeFor = 0;
    this.shownBuilding = 0;
    this.game.select(0);
  }

  private onWorldClick(ev: PointerEvent): void {
    const g = this.game;
    if (!g.world || !g.running) return;
    if (this.armed) { void this.castPower(ev); return; }
    const hit = g.engine.pick(ev.clientX, ev.clientY, ev.pointerType !== 'mouse');
    if (!hit) { this.closeInspector(); return; }
    this.tutorialState.inspect = true;
    if (hit.type === 'person') { this.selectPerson(hit.id, false); return; }
    g.select(0);
    if (hit.type === 'building') this.showBuilding(hit.building);
    else this.showCell(hit.cell);
  }

  /** Selects an inhabitant and opens their sheet (filled as soon as the simulation answers). */
  private selectPerson(id: number, travel: boolean): void {
    const g = this.game;
    this.treeFor = 0;
    g.select(id, travel);
    const r = g.sim.rosterById.get(id);
    this.inspector.innerHTML = `<button class="close" data-a="close">×</button><div class="kicker">Habitant</div><h2>${r ? esc(r.name) : '…'}</h2>`;
    this.inspector.classList.remove('closed');
    this.inspector.scrollTop = 0;
    if (travel && r) {
      const s = g.settlements.find((x) => x.id === r.settlement);
      const c = g.engine.controls;
      if (s && (c.goalDistance > 220 || c.goalDir.angleTo(new THREE.Vector3(s.dir.x, s.dir.y, s.dir.z)) * g.world!.R > 400)) {
        c.flyTo(new THREE.Vector3(s.dir.x, s.dir.y, s.dir.z), 110, 1.05);
      }
    }
  }

  private onInspectorClick(e: Event): void {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    const g = this.game;
    if (b.dataset.a === 'close') this.closeInspector();
    if (b.dataset.a === 'follow') {
      g.following = !g.following;
      b.classList.toggle('primary', g.following);
      if (g.following && g.engine.controls.goalDistance > 220) g.engine.controls.flyTo(g.engine.controls.goalDir, 110, 1.05);
    }
    if (b.dataset.a === 'tree') void this.showTree(Number(b.dataset.id));
    if (b.dataset.tree) void this.showTree(Number(b.dataset.tree));
    if (b.dataset.person) this.selectPerson(Number(b.dataset.person), true);
  }

  private meter(label: string, v: number, cls = ''): string {
    return `<div class="meter"><span>${label}</span><div class="bar"><i class="${cls || (v < 0.25 ? 'low' : '')}" style="width:${Math.round(clamp01(v) * 100)}%"></i></div><b>${Math.round(clamp01(v) * 100)}</b></div>`;
  }

  /** Live sheet of an inhabitant (or of someone who died), built only from simulation data. */
  private renderPerson(v: PersonView): void {
    const g = this.game;
    const p = v.person;
    const female = p.sex === 0;
    const name = (id: number) => (v.names[id] ? `${esc(v.names[id])}${v.deceased.includes(id) ? ' †' : ''}` : 'inconnu');
    const link = (id: number, role: string) => (v.names[id] ? `<button class="row" data-person="${id}"><span class="name">${name(id)}</span><small>${role}</small></button>` : '');
    const years = Math.floor(v.age);
    const world = g.sim.world;
    const ruled = v.alive ? world?.civs.find((c) => c.leader === p.id) : undefined;
    const faith = v.alive ? world?.religions.find((r) => r.id === (p as Person).faith) : undefined;
    let body: string;
    if (v.alive) {
      const a = p as Person;
      const walking = a.phase !== 1;
      const wb = g.buildings.find((x) => x.id === a.workplace);
      const workplace = wb ? BUILDING_NAMES[wb.kind].toLowerCase() : '';
      const what = walking && a.activity !== 0 ? `En chemin · ${ACTIVITY_LABELS[a.activity].toLowerCase()}` : ACTIVITY_LABELS[a.activity];
      const bonds = Object.entries(a.bonds).map(([id, val]) => [Number(id), val] as [number, number])
        .filter(([id]) => !v.household?.members.includes(id)).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])).slice(0, 4);
      const bondLabel = (x: number) => (x >= 0.5 ? (female ? 'Amie' : 'Ami') : x >= 0.15 ? 'Bonne entente' : x <= -0.3 ? 'Brouille' : x < 0 ? 'Froideur' : 'Connaissance');
      body = `
        <div class="status"><b>${what}</b><small>${years < 14 ? 'Enfant' : years >= 68 ? `${female ? 'Ancienne' : 'Ancien'}` : (female ? JOB_LABELS_F : JOB_LABELS_M)[a.job]}${workplace ? ` · ${workplace}` : ''}${a.carry >= 0.5 ? ` · porte ${fmt(a.carry, 1)} × ${RESOURCE_LABELS[a.carryRes].toLowerCase()}` : ''}${a.pregnantUntil ? ' · attend un enfant' : ''}</small></div>
        <div class="btns"><button class="btn ${g.following ? 'primary' : ''}" data-a="follow">Suivre</button><button class="btn" data-a="tree" data-id="${a.id}">Arbre généalogique</button></div>
        <h3>Besoins</h3>${NEED_LABELS.map((l, i) => this.meter(l, a.needs[i])).join('')}${this.meter('Santé', a.health)}
        <h3>Ce qui l’attire maintenant</h3>${v.utilities.slice(0, 3).map((u) => this.meter(ACTIVITY_LABELS[u.activity], Math.min(1, u.score), 'calm')).join('')}
        <h3>Personnalité</h3>${TRAIT_LABELS.map((l, i) => this.meter(l, a.traits[i], 'calm')).join('')}
        <h3>Savoir-faire</h3>${a.skills.map((v, i) => [i, v] as [number, number]).sort((x, y) => y[1] - x[1]).slice(0, 4).filter((x) => x[1] > 0.005).map(([i, v]) => this.meter(SKILL_LABELS[i], v, 'calm')).join('') || '<p class="note">Encore rien appris.</p>'}
        <h3>Foyer ${v.household ? esc(v.household.name) : ''}</h3>
        <div class="kv"><span>Réserves</span><b>${v.household ? fmt(v.household.food, 1) : '0'} repas</b><span>Bourse</span><b>${v.household ? fmt(v.household.coins, 1) : '0'} pièces</b></div>
        ${(v.household?.members ?? []).filter((id) => id !== a.id).map((id) => link(id, id === a.spouse ? (female ? 'Époux' : 'Épouse') : a.children.includes(id) ? 'Enfant' : a.parents.includes(id) ? 'Parent' : 'Foyer')).join('')}
        ${bonds.length ? `<h3>Liens</h3>${bonds.map(([id, val]) => link(id, bondLabel(val))).join('')}` : ''}`;
    } else {
      const d = p as DeadPerson;
      body = `<div class="status"><b>${female ? 'Morte' : 'Mort'} ${d.cause === 'thirst' ? 'de soif' : d.cause === 'age' ? 'de vieillesse' : d.cause === 'battle' ? 'au combat' : d.cause === 'disaster' ? 'dans un fléau' : 'de faim'}</b><small>${formatDate(d.death)}, à ${years} ans</small></div>
        <div class="btns"><button class="btn" data-a="tree" data-id="${d.id}">Arbre généalogique</button></div>
        <h3>Famille</h3>${[d.spouse, ...d.parents, ...d.children].filter(Boolean).map((id) => link(id, id === d.spouse ? 'Conjoint' : d.children.includes(id) ? 'Enfant' : 'Parent')).join('')}`;
    }
    const absent = v.alive ? [p.spouse, ...p.parents].filter((id) => id && !v.household?.members.includes(id)) : [];
    const html = `<button class="close" data-a="close">×</button>
      <div class="kicker">${v.alive ? 'Habitant' : 'Archives'} · n° ${p.id}</div>
      <h2>${esc(p.firstName)} ${esc(p.lastName)}</h2>
      <div class="sub">${years} an${years > 1 ? 's' : ''} · ${female ? 'femme' : 'homme'} · ${esc(v.settlementName)}${ruled ? ` · ${RULER_TITLES[ruled.government][female ? 1 : 0]} du peuple de ${esc(ruled.name)}` : ''}${faith ? `<br>Fidèle : ${esc(faith.name)}` : ''}</div>
      ${body}
      ${absent.length ? `<h3>Famille</h3>${absent.map((id) => link(id, id === p.spouse ? 'Conjoint' : 'Parent')).join('')}` : ''}
      <h3>Récit de vie</h3><p class="bio">${esc(this.biography(v))}</p>
      <h3>Chronologie</h3>
      <ul class="timeline">${[...p.memories].reverse().slice(0, 14).map((m) => `<li><small>${formatDate(m.t)}</small>${esc(memoryText(m, v.names, female))}</li>`).join('')}</ul>`;
    const top = this.inspector.scrollTop;
    this.inspector.innerHTML = html;
    this.inspector.scrollTop = top;
    this.inspector.classList.remove('closed');
  }

  // ----------------------------------------------------------- population
  private renderPopulationPanel(): void {
    const g = this.game;
    this.panel.querySelector('h2')!.textContent = 'Population';
    const body = this.panel.querySelector('.body')!;
    const roster = [...g.sim.roster].sort((a, b) => a.settlement - b.settlement || a.name.localeCompare(b.name, 'fr'));
    let list = '';
    let current = -1;
    for (const r of roster) {
      if (r.settlement !== current) {
        current = r.settlement;
        const s = g.settlements.find((x) => x.id === current);
        list += `<h3>${s ? esc(s.name) : 'Hameau'} — ${roster.filter((x) => x.settlement === current).length} habitants</h3>`;
      }
      list += `<button class="row" data-person="${r.id}"><span class="name">${esc(r.name)}</span><small data-act="${r.id}"></small></button>`;
    }
    body.innerHTML = `<div id="pop-stats"></div><div class="list" id="pop-list">${list}</div>`;
    body.querySelector('#pop-list')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-person]');
      if (b) this.selectPerson(Number(b.dataset.person), true);
    });
    this.updatePopulation();
  }

  /** Refreshes the live figures of the population panel from the latest simulation snapshot. */
  private updatePopulation(): void {
    this.lastPopulationUpdate = performance.now();
    const g = this.game;
    const snap = g.sim.snapshot;
    const stats = this.panel.querySelector('#pop-stats');
    if (!snap || !stats) return;
    const s = snap.summary;
    const acts = s.byActivity.map((n, i) => [i, n] as [number, number]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]);
    stats.innerHTML = `<h3>Société</h3>
      <div class="kv"><span>Habitants</span><b>${fmt(s.alive)}</b><span>Foyers</span><b>${fmt(s.households)}</b>
      <span>Réserves des foyers</span><b>${fmt(s.pantryMeals)} repas</b><span>Naissances depuis l’an 1</span><b>${fmt(s.births)}</b><span>Décès depuis l’an 1</span><b>${fmt(s.deaths)}</b></div>
      <h3>Métiers</h3>${s.byJob.map((n, i) => [i, n] as [number, number]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]).map(([i, n]) => `<div class="meter"><span>${JOB_LABELS_M[i]}s</span><div class="bar"><i class="calm" style="width:${(n / Math.max(1, s.alive)) * 100}%"></i></div><b>${n}</b></div>`).join('')}
      <h3>Besoins moyens</h3>${NEED_LABELS.map((l, i) => this.meter(l, s.avgNeeds[i])).join('')}${this.meter('Santé', s.avgHealth)}
      <h3>En ce moment</h3>${acts.map(([i, n]) => `<div class="meter"><span>${ACTIVITY_LABELS[i]}</span><div class="bar"><i class="calm" style="width:${(n / Math.max(1, s.alive)) * 100}%"></i></div><b>${n}</b></div>`).join('')}`;
    const flags = new Map<number, number>();
    for (let i = 0; i < snap.count; i++) flags.set(snap.ids[i], snap.flags[i]);
    this.panel.querySelectorAll<HTMLElement>('[data-act]').forEach((el) => {
      const id = Number(el.dataset.act);
      const r = g.sim.rosterById.get(id);
      const f = flags.get(id);
      if (!r || f === undefined) return;
      const text = `${Math.floor((snap.time - r.birth) / SECONDS_PER_YEAR)} ans · ${ACTIVITY_LABELS[f & 15]}`;
      if (el.textContent !== text) el.textContent = text;
    });
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
    this.inspector.innerHTML = `<button class="close" data-a="close">×</button>
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
  }

  private showBuilding(b: Building): void {
    const g = this.game;
    this.shownBuilding = b.id;
    const s = g.settlements.find((x) => x.id === b.settlement);
    const [name, desc] = BUILDING_INFO[b.kind] ?? ['Bâtiment', ''];
    const sb = g.sim.buildings.find((x) => x.id === b.id);
    const progress = b.progress ?? 1;
    const occupants = g.sim.roster.filter((r) => r.home === b.id);
    const workers = g.sim.roster.filter((r) => r.workplace === b.id);
    const person = (r: { id: number; name: string; sex: 0 | 1; job: number }, withJob: boolean) =>
      `<button class="row" data-person="${r.id}"><span class="name">${esc(r.name)}</span>${withJob ? `<small>${(r.sex === 0 ? JOB_LABELS_F : JOB_LABELS_M)[r.job]}</small>` : ''}</button>`;
    const project = g.sim.economy?.settlements.find((x) => x.id === b.settlement)?.projects.find((p) => p.id === b.id);
    const top = this.inspector.scrollTop;
    this.inspector.innerHTML = `<button class="close" data-a="close">×</button>
      <div class="kicker">${progress < 1 ? 'Chantier' : 'Bâtiment'} · n° ${b.id}</div><h2>${name}</h2>
      <div class="sub">${s ? esc(s.name) : ''}</div>
      <p class="note" style="margin:0 0 12px">${desc}</p>
      ${progress < 1 ? `<div class="status"><b>En construction</b><small>${project?.missing.length ? `À l’arrêt : manque de ${project.missing.map((r) => RESOURCE_LABELS[r].toLowerCase()).join(', ')}` : 'Les bâtisseurs y travaillent'}</small></div>${this.meter('Avancement', progress)}` : ''}
      <div class="kv">
        ${sb && sb.completed && progress >= 1 ? `<span>Achevé</span><b>${formatDate(sb.completed)}</b>` : sb ? `<span>Chantier ouvert</span><b>${formatDate(sb.started)}</b>` : ''}
        ${sb && sb.res >= 0 ? `<span>Extraction</span><b>${RESOURCE_LABELS[sb.res]}</b>` : ''}
        ${sb && sb.produced > 0 ? `<span>Production cumulée</span><b>${fmt(sb.produced)} unités</b>` : ''}
        ${occupants.length ? `<span>Habitants</span><b>${occupants.length}</b>` : ''}${workers.length ? `<span>Travailleurs</span><b>${workers.length}</b>` : ''}
      </div>
      ${workers.length ? `<h3>Y travaillent</h3>${workers.map((r) => person(r, true)).join('')}` : ''}
      ${occupants.length ? `<h3>Y vivent</h3>${occupants.map((r) => person(r, false)).join('')}` : ''}
      ${!workers.length && !occupants.length && progress >= 1 ? `<p class="note">${['house', 'hut', 'longhouse', 'farm'].includes(b.kind) ? 'Ce logis est vide pour l’instant.' : 'Personne n’y est affecté en ce moment.'}</p>` : ''}`;
    this.inspector.scrollTop = top;
    this.inspector.classList.remove('closed');
  }

  // -------------------------------------------------------- civilisations
  private placeName = (id: number): string => this.game.settlements.find((x) => x.id === id)?.name ?? 'terres lointaines';

  /** Turns an event into a line whose people can be opened (living or dead). */
  private eventLine(e: SimEvent): string {
    let text = esc(eventText(e, this.placeName));
    const link = (id: number | undefined, name: string | undefined) => {
      if (!id || !name) return;
      const n = esc(name);
      if (text.includes(n)) text = text.replace(n, `<button data-person="${id}">${n}</button>`);
    };
    const collective = e.type === 'omen' || e.type === 'war' || e.type === 'peace' || e.type === 'alliance' || e.type === 'battle' || e.type === 'siege' || e.type === 'conquest' || e.type === 'secession';
    if (!collective) link(e.a, e.names?.[0]);
    if (e.type !== 'war' && e.type !== 'peace' && e.type !== 'alliance' && e.type !== 'battle' && e.type !== 'siege' && e.type !== 'conquest' && e.type !== 'secession') {
      link(e.b, e.type === 'birth' || e.type === 'marriage' || e.type === 'ruler' || e.type === 'coup' ? e.names?.[1] : undefined);
    }
    return `<li><small>${formatDate(e.t)}${e.settlement ? ` · ${esc(this.placeName(e.settlement))}` : ''}</small>${text}</li>`;
  }

  private bindPanelLinks(body: HTMLElement): void {
    body.querySelectorAll<HTMLElement>('[data-person]').forEach((b) => b.addEventListener('click', () => this.selectPerson(Number(b.dataset.person), true)));
    body.querySelectorAll<HTMLElement>('[data-civ]').forEach((b) => b.addEventListener('click', () => {
      this.civShown = Number(b.dataset.civ);
      this.openSection('civilizations');
    }));
    body.querySelectorAll<HTMLElement>('[data-place]').forEach((b) => b.addEventListener('click', () => {
      const st = this.game.settlements.find((x) => x.id === Number(b.dataset.place));
      if (st) this.game.engine.controls.flyTo(new THREE.Vector3(st.dir.x, st.dir.y, st.dir.z), 320, 0.95);
    }));
  }

  /** A people: its ruler and houses, culture, beliefs, knowledge and lands. */
  private renderCivPanel(): void {
    const g = this.game;
    this.panel.querySelector('h2')!.textContent = 'Civilisations';
    const body = this.panel.querySelector<HTMLElement>('.body')!;
    const w = g.sim.world;
    if (!w || !w.civs.length) { body.innerHTML = '<p class="note">Aucun peuple encore.</p>'; return; }
    if (!w.civs.some((c) => c.id === this.civShown)) this.civShown = w.civs.find((c) => !c.fallen)?.id ?? w.civs[0].id;
    const c = w.civs.find((x) => x.id === this.civShown)!;
    const title = (sex: number) => RULER_TITLES[c.government][sex];
    // RULER_TITLES holds [masculine, feminine]; a person's sex is 0 for a woman
    const leaderSex = g.sim.rosterById.get(c.leader)?.sex === 0 ? 1 : 0;
    const research = c.research.tech ? TECH_BY_ID.get(c.research.tech) : undefined;
    const rel = w.religions.find((r) => r.id === c.religion);
    const faiths = Object.entries(c.followers).map(([id, n]) => [w.religions.find((r) => r.id === Number(id)), n] as const).filter((x) => x[0]).sort((a, b) => b[1] - a[1]);
    const top = body.scrollTop;
    body.innerHTML = `
      <div class="btns">${w.civs.map((x) => `<button class="btn ${x.id === c.id ? 'primary' : ''}" data-civ="${x.id}"><span class="dot" style="background:${civCss(x.color)}"></span>${esc(x.name)}${x.fallen ? ' †' : ''}</button>`).join('')}</div>
      <h3>Peuple de ${esc(c.name)}</h3>
      <div class="kv"><span>Nom du peuple</span><b>${esc(c.culture.people)}</b><span>Né en</span><b>${formatDate(c.founded)}</b>
        <span>Population</span><b>${fmt(c.population)}</b><span>Régime</span><b>${GOVERNMENT_LABELS[c.government]}</b>
        ${c.fallen ? `<span>Éteint en</span><b>${formatDate(c.fallen)}</b>` : ''}</div>
      ${c.leader ? `<h3>${title(leaderSex)}</h3><button class="row" data-person="${c.leader}"><span class="name">${esc(c.leaderName)}</span><small>au pouvoir</small></button>${this.meter('Légitimité', c.legitimacy)}` : ''}
      <h3>Maisons régnantes</h3>
      ${c.dynasties.map((d) => `<p class="note" style="margin:6px 0 2px;color:var(--gold-bright)">Maison ${esc(d.name)} — depuis ${formatDate(d.from)}</p>${d.rulers.map((r) => `<button class="row" data-person="${r.person}"><span class="name">${esc(r.name)}</span><small>${({ founding: 'fondation', election: 'élection', inheritance: 'héritage', coup: 'coup de force', revolt: 'révolte' } as Record<string, string>)[r.how]} · ${formatDate(r.from).replace('An ', 'an ')}${r.to ? ` → ${formatDate(r.to).replace('An ', 'an ')}` : ''}</small></button>`).join('')}`).join('')}
      <h3>Terres</h3><div class="list">${c.settlements.map((id) => `<button class="row" data-place="${id}"><span class="name">${esc(this.placeName(id))}${id === c.capital ? ' ★' : ''}</span><small>${this.tier(w.settlements[id]?.[1] ?? 0)} · ${w.settlements[id]?.[1] ?? 0} hab.</small></button>`).join('') || '<p class="note">Plus aucune terre.</p>'}</div>
      <h3>Culture</h3>${CULTURE_AXES.map((l, i) => this.meter(l, c.culture.values[i], 'calm')).join('')}
      <p class="note">Tradition : ${TRADITION_NAMES[c.culture.traditions[0]] ?? '—'}, chaque année au jour ${c.culture.festivalDay + 1} si les greniers le permettent. Les enfants grandissent dans ces valeurs.</p>
      <h3>Croyances</h3>${rel ? `<p class="note" style="margin-top:0">Culte du peuple : <b style="color:var(--text)">${esc(rel.name)}</b>, fondé par ${esc(rel.founderName)} (${formatDate(rel.founded)}).</p>${this.meter('Ferveur', rel.fervor, 'calm')}` : '<p class="note" style="margin-top:0">Aucune croyance commune encore.</p>'}
      ${faiths.map(([r, n]) => `<div class="meter"><span>${esc(r!.name)}</span><div class="bar"><i class="calm" style="width:${(n / Math.max(1, c.population)) * 100}%"></i></div><b>${n}</b></div>`).join('')}
      <h3>Savoir (${c.techs.length} / ${TECHS.length})</h3>
      ${research ? `<div class="status"><b>À l’étude : ${research.name}</b><small>${research.effect}</small></div>${this.meter('Avancement', c.research.progress / research.cost)}` : '<p class="note">Tout ce qui pouvait être appris l’a été.</p>'}
      <ul class="timeline">${c.techs.map((id) => TECH_BY_ID.get(id)).filter(Boolean).reverse().map((t) => `<li><small>${t!.field}</small>${t!.name} — ${t!.effect}</li>`).join('')}</ul>`;
    body.scrollTop = top;
    this.bindPanelLinks(body);
  }

  /** Who rules whom, how, and how firmly. */
  private renderPoliticsPanel(): void {
    const g = this.game;
    this.panel.querySelector('h2')!.textContent = 'Politique';
    const body = this.panel.querySelector<HTMLElement>('.body')!;
    const w = g.sim.world;
    if (!w) { body.innerHTML = '<p class="note">La simulation démarre…</p>'; return; }
    const political = new Set(['ruler', 'coup', 'government', 'civ', 'colony', 'war', 'peace', 'alliance', 'battle', 'siege', 'conquest', 'secession']);
    const events = w.events.filter((e) => political.has(e.type)).slice(-30).reverse();
    const civName = (id: number) => esc(w.civs.find((c) => c.id === id)?.name ?? '?');
    const living = new Set(w.civs.filter((c) => !c.fallen).map((c) => c.id));
    const relations = w.relations.filter((r) => living.has(r.a) && living.has(r.b));
    const statusLabel = { peace: 'Paix', war: 'Guerre', alliance: 'Alliance' } as const;
    const wars = [...w.wars].reverse().slice(0, 8);
    const top = body.scrollTop;
    body.innerHTML = `<h3>Pouvoirs en place</h3>
      ${w.civs.filter((c) => !c.fallen).map((c) => {
        const sex = g.sim.rosterById.get(c.leader)?.sex === 0 ? 1 : 0;
        const house = c.dynasties[c.dynasties.length - 1];
        return `<button class="row" data-civ="${c.id}"><span><span class="dot" style="background:${civCss(c.color)}"></span><span class="name">${esc(c.name)}</span><br><small>${GOVERNMENT_LABELS[c.government]} · ${c.population} hab. · ${c.settlements.length} terre${c.settlements.length > 1 ? 's' : ''}</small></span></button>
          ${c.leader ? `<button class="row" data-person="${c.leader}"><span class="name">${esc(c.leaderName)}</span><small>${RULER_TITLES[c.government][sex]} · maison ${esc(house?.name ?? '')} (${house?.rulers.length ?? 1}ᵉ règne)</small></button>` : ''}
          ${this.meter('Légitimité', c.legitimacy)}`;
      }).join('<div style="height:8px"></div>')}
      <p class="note">La légitimité suit le sort du peuple (faim, famine), l’habileté du dirigeant et la ferveur partagée. Trop basse, elle ouvre la voie aux usurpateurs et aux révoltes.</p>
      <h3>Diplomatie</h3>
      ${relations.length ? relations.map((r) => `<div class="meter"><span>${civName(r.a)} – ${civName(r.b)}<br><small style="color:${r.status === 'war' ? '#e0a08a' : r.status === 'alliance' ? '#a9d59a' : 'var(--dim)'}">${statusLabel[r.status]}${r.status === 'peace' && r.truceUntil > g.clock.time ? ' jurée' : ''} · tension : ${WAR_CAUSE_LABELS[r.tension]}</small></span><div class="bar"><i class="${r.opinion < -0.2 ? 'low' : 'calm'}" style="width:${(r.opinion + 1) * 50}%"></i></div><b>${r.opinion >= 0 ? '+' : ''}${fmt(r.opinion * 100)}</b></div>`).join('') : '<p class="note">Aucun peuple n’en connaît encore un autre.</p>'}
      <p class="note">L’entente naît du commerce, d’une foi et de mœurs communes ; elle s’use par la proximité des terres, la rivalité de dirigeants agressifs, les querelles de croyance, la convoitise et les blessures des guerres passées.</p>
      <h3>Forces</h3>${w.civs.filter((c) => !c.fallen).map((c) => `<div class="meter"><span><span class="dot" style="background:${civCss(c.color)}"></span>${esc(c.name)}</span><div class="bar"><i class="calm" style="width:${Math.min(100, (c.soldiers / Math.max(1, c.population)) * 300)}%"></i></div><b>${c.soldiers}</b></div>`).join('')}
      <p class="note">Soldats sous les armes. Ce sont des habitants : chaque mort au combat est un fils, une mère, un voisin.</p>
      ${wars.length ? `<h3>Guerres</h3><ul class="timeline">${wars.map((x) => `<li><small>${formatDate(x.start)}${x.end ? ` → ${formatDate(x.end)}` : ' · en cours'}</small>${civName(x.attacker)} contre ${civName(x.defender)} — ${WAR_CAUSE_LABELS[x.cause]}. ${x.battles} bataille${x.battles > 1 ? 's' : ''}, ${x.deathsAttacker + x.deathsDefender} morts${x.takenByAttacker.length + x.takenByDefender.length ? `, ${x.takenByAttacker.length + x.takenByDefender.length} terre(s) prise(s)` : ''}${x.end ? ` — ${x.outcome === 'draw' ? 'sans vainqueur' : `victoire de ${civName(x.outcome === 'attacker' ? x.attacker : x.defender)}`}` : ''}</li>`).join('')}</ul>` : ''}
      <h3>Événements politiques</h3><ul class="timeline">${events.map((e) => this.eventLine(e)).join('') || '<li>Rien encore.</li>'}</ul>`;
    body.scrollTop = top;
    this.bindPanelLinks(body);
  }

  /** The chronicle of recorded events, and the archives of everyone who ever lived. */
  private renderHistoryPanel(): void {
    const g = this.game;
    this.panel.querySelector('h2')!.textContent = 'Histoire';
    const body = this.panel.querySelector<HTMLElement>('.body')!;
    const w = g.sim.world;
    if (!w) { body.innerHTML = '<p class="note">La simulation démarre…</p>'; return; }
    const groups: Record<string, string[]> = {
      all: [], power: ['civ', 'ruler', 'coup', 'government', 'colony', 'secession', 'alliance'], war: ['war', 'peace', 'battle', 'siege', 'conquest'], mind: ['tech', 'religion', 'schism', 'faithEnd', 'festival', 'divine', 'omen'],
      life: ['birth', 'death', 'marriage'], works: ['built', 'famine', 'harvest', 'trade', 'shortage', 'founded'],
    };
    const labels: Record<string, string> = { all: 'Grands faits', power: 'Pouvoir', war: 'Guerres', mind: 'Esprit', life: 'Vies', works: 'Travaux' };
    const minor = new Set(['birth', 'trade', 'project', 'shortage', 'marriage', 'festival', 'built', 'death', 'harvest']);
    const f = this.historyFilter;
    const events = w.events.filter((e) => (f === 'all' ? !minor.has(e.type) : groups[f].includes(e.type))).slice(-70).reverse();
    const top = body.scrollTop;
    const existing = body.querySelector<HTMLInputElement>('.search');
    const query = existing?.value ?? '';
    body.innerHTML = `<h3>Archives</h3>
      <input class="search" placeholder="Rechercher une personne, vivante ou morte…" value="${esc(query)}" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" />
      <div class="list" id="hits"></div>
      <h3>Chronologie</h3>
      <div class="btns">${Object.keys(groups).map((k) => `<button class="btn ${k === f ? 'primary' : ''}" data-filter="${k}">${labels[k]}</button>`).join('')}</div>
      <ul class="timeline" style="margin-top:8px">${events.map((e) => this.eventLine(e)).join('') || '<li>Rien encore dans cette catégorie.</li>'}</ul>
      <p class="note">Chaque ligne est un événement enregistré par la simulation ; les noms mènent aux fiches, y compris celles des défunts.</p>`;
    body.scrollTop = top;
    body.querySelectorAll<HTMLElement>('[data-filter]').forEach((b) => b.addEventListener('click', () => { this.historyFilter = b.dataset.filter!; this.renderHistoryPanel(); }));
    const input = body.querySelector<HTMLInputElement>('.search')!;
    const hits = body.querySelector<HTMLElement>('#hits')!;
    const run = async () => {
      const q = input.value.trim();
      if (q.length < 2) { hits.innerHTML = ''; return; }
      const found = await g.sim.search(q);
      if (input.value.trim() !== q) return;
      hits.innerHTML = found.map((h) => `<button class="row" data-person="${h.id}"><span class="name">${esc(h.name)}${h.alive ? '' : ' †'}</span><small>${esc(this.placeName(h.settlement))} · ${h.alive ? 'en vie' : `mort${''} ${formatDate(h.death).replace('An ', 'an ')}`}</small></button>`).join('') || '<p class="note">Personne de ce nom dans les archives.</p>';
      this.bindPanelLinks(hits);
    };
    input.addEventListener('input', () => void run());
    if (query) void run();
    this.bindPanelLinks(body);
  }

  /** Name tags floating over inhabited settlements (tap to visit). */
  private updateLabels(): void {
    const g = this.game;
    const w = g.sim.world;
    if (!w || !g.world || !g.running) return;
    const cam = g.engine.camera;
    const rect = g.engine.canvas.getBoundingClientRect();
    const camLen = cam.position.length();
    const horizon = Math.acos(Math.min(1, g.world.R / camLen)) + 0.05;
    const v = new THREE.Vector3();
    const seen = new Set<number>();
    const far = g.engine.controls.distance > 260;
    for (const s of g.settlements) {
      const [civId, pop] = w.settlements[s.id] ?? [0, 0];
      if (!pop) continue;
      v.set(s.dir.x, s.dir.y, s.dir.z);
      const visible = far && Math.acos(Math.min(1, v.dot(cam.position) / camLen)) < horizon;
      if (!visible) continue;
      v.multiplyScalar(g.world.R + 60).project(cam);
      if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) continue;
      seen.add(s.id);
      let node = this.labelNodes.get(s.id);
      if (!node) {
        node = document.createElement('button');
        node.addEventListener('click', () => {
          g.engine.controls.flyTo(new THREE.Vector3(s.dir.x, s.dir.y, s.dir.z), 200, 1.0);
          this.civShown = (g.sim.world?.settlements[s.id]?.[0]) ?? 0;
          this.openSection('civilizations');
        });
        this.labels.append(node);
        this.labelNodes.set(s.id, node);
      }
      const civ = w.civs.find((c) => c.id === civId);
      const html = `<span class="dot" style="background:${civ ? civCss(civ.color) : '#777'}"></span>${esc(s.name)}<small>${pop}</small>`;
      if (node.dataset.html !== html) { node.innerHTML = html; node.dataset.html = html; }
      node.style.transform = `translate(-50%, -100%) translate(${((v.x * 0.5 + 0.5) * rect.width).toFixed(1)}px, ${((-v.y * 0.5 + 0.5) * rect.height).toFixed(1)}px)`;
      node.style.display = '';
    }
    // armies in the field
    for (const army of w.armies) {
      const home = g.settlements.find((x) => x.id === army.home);
      if (!home) continue;
      let frame = this.frames.get(home.id);
      if (!frame) this.frames.set(home.id, (frame = siteFrame(home)));
      const d = { x: 0, y: 0, z: 0 };
      frame.toDir(army.e, army.n, g.world.R, d);
      v.set(d.x, d.y, d.z);
      if (Math.acos(Math.min(1, v.dot(cam.position) / camLen)) >= horizon) continue;
      v.multiplyScalar(g.world.R + 45).project(cam);
      if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) continue;
      const key = -army.id;
      seen.add(key);
      let node = this.labelNodes.get(key);
      if (!node) {
        node = document.createElement('button');
        node.addEventListener('click', () => {
          const f = this.frames.get(army.home);
          const a = g.sim.world?.armies.find((x) => x.id === army.id);
          if (!f || !a) return;
          const p = { x: 0, y: 0, z: 0 };
          f.toDir(a.e, a.n, g.world!.R, p);
          g.engine.controls.flyTo(new THREE.Vector3(p.x, p.y, p.z), 110, 1.05);
        });
        this.labels.append(node);
        this.labelNodes.set(key, node);
      }
      const civ = w.civs.find((c) => c.id === army.civ);
      const what = army.state === 'siege' ? 'siège' : army.state === 'battle' ? 'bataille' : army.state === 'return' ? 'retour' : 'en marche';
      const html = `<span class="dot" style="background:${civ ? civCss(civ.color) : '#777'}"></span>⚔ ${esc(civ?.name ?? '')}<small>${army.size} · ${what}</small>`;
      if (node.dataset.html !== html) { node.innerHTML = html; node.dataset.html = html; }
      node.style.transform = `translate(-50%, -100%) translate(${((v.x * 0.5 + 0.5) * rect.width).toFixed(1)}px, ${((-v.y * 0.5 + 0.5) * rect.height).toFixed(1)}px)`;
      node.style.display = '';
    }
    for (const [id, node] of this.labelNodes) if (!seen.has(id)) node.style.display = 'none';
  }

  // ----------------------------------------------------------- chronicles
  /** A short life story: every clause restates a recorded fact of the person's sheet. */
  private biography(v: PersonView): string {
    const p = v.person;
    const f = p.sex === 0;
    const nm = (id: number) => v.names[id];
    const parents = p.parents.map(nm).filter(Boolean);
    const out: string[] = [`${f ? 'Née' : 'Né'} à ${p.birthPlace} (${formatDate(p.birth).replace('An ', 'an ')})${parents.length ? `, ${f ? 'fille' : 'fils'} de ${parents.join(' et ')}` : ''}.`];
    const mem = p.memories;
    const has = (t: string) => mem.filter((m) => m.type === t);
    const spouse = has('married').map((m) => nm(m.ref ?? 0)).filter(Boolean);
    if (spouse.length) out.push(`${f ? 'Unie' : 'Uni'} à ${spouse[spouse.length - 1]}.`);
    if (p.children.length) out.push(`${f ? 'Mère' : 'Père'} de ${p.children.length} enfant${p.children.length > 1 ? 's' : ''}.`);
    const deeds = mem.filter((m) => ['ruler', 'deposed', 'prophet', 'chosen', 'colonist', 'discoveryTech', 'built', 'battle', 'wounded', 'conquered', 'journey'].includes(m.type));
    const seen = new Set<string>();
    for (const m of deeds) {
      const text = memoryText(m, v.names, f);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      if (seen.size > 7) break;
      out.push(`${text} (${formatDate(m.t).replace('An ', 'an ').replace(/, jour.*/, '')}).`);
    }
    const friends = has('friend').length, griefs = has('mourning').length;
    if (friends) out.push(`${friends} amitié${friends > 1 ? 's' : ''} nouée${friends > 1 ? 's' : ''}.`);
    if (griefs) out.push(`${griefs} deuil${griefs > 1 ? 's' : ''} traversé${griefs > 1 ? 's' : ''}.`);
    if (!v.alive) {
      const d = p as DeadPerson;
      out.push(`${f ? 'Morte' : 'Mort'} à ${Math.floor(v.age)} ans (${formatDate(d.death).replace('An ', 'an ').replace(/, jour.*/, '')}).`);
    }
    return out.join(' ');
  }

  /** Family tree of a living or dead person, five generations around them. */
  private async showTree(id: number): Promise<void> {
    const g = this.game;
    const tree: FamilyTree | null = await g.sim.tree(id);
    if (!tree) return;
    this.treeFor = id;
    const year = (t: number) => formatDate(t).replace('An ', 'an ').replace(/, jour.*/, '');
    const row = (n: TreeNode, role = '') => `<button class="row" data-tree="${n.id}"><span class="name">${esc(n.name)}${n.death ? ' †' : ''}</span><small>${role ? `${role} · ` : ''}${year(n.birth)}${n.death ? ` – ${year(n.death)}` : ''}</small></button>`;
    const group = (title: string, list: TreeNode[]) => (list.length ? `<h3>${title} (${list.length})</h3>${list.map((n) => row(n)).join('')}` : '');
    const me = tree.self;
    this.inspector.innerHTML = `<button class="close" data-a="close">×</button>
      <div class="kicker">Arbre généalogique</div><h2>${esc(me.name)}${me.death ? ' †' : ''}</h2>
      <div class="sub">${year(me.birth)}${me.death ? ` – ${year(me.death)}` : ''} · ${esc(this.placeName(me.settlement))}</div>
      <div class="btns"><button class="btn primary" data-person="${me.id}">Voir la fiche</button></div>
      ${group('Grands-parents', tree.grandparents)}${group('Parents', tree.parents)}
      ${tree.spouse ? `<h3>${tree.spouse.sex === 0 ? 'Épouse' : 'Époux'}</h3>${row(tree.spouse)}` : ''}
      ${group('Frères et sœurs', tree.siblings)}${group('Enfants', tree.children)}${group('Petits-enfants', tree.grandchildren)}
      ${tree.parents.length + tree.children.length + tree.siblings.length === 0 && !tree.spouse ? '<p class="note">Aucune parenté connue des archives.</p>' : ''}
      <p class="note">Touchez un nom pour recentrer l’arbre sur cette personne. † : défunt.</p>`;
    this.inspector.scrollTop = 0;
    this.inspector.classList.remove('closed');
  }

  private async loadChronicle(scope: number): Promise<void> {
    this.chronScope = scope;
    this.panel.querySelector('h2')!.textContent = 'Chroniques';
    const body = this.panel.querySelector<HTMLElement>('.body')!;
    if (!this.chron || this.chron.scope !== scope) body.innerHTML = '<p class="note">Les scribes consultent les archives…</p>';
    const ch = await this.game.sim.chronicle(scope);
    if (this.section !== 'chronicles' || this.chronScope !== scope) return;
    this.chron = ch;
    this.renderChronicle();
  }

  /** The written history. Each sentence can be touched to see the recorded facts it rests on. */
  private renderChronicle(): void {
    const g = this.game;
    const body = this.panel.querySelector<HTMLElement>('.body')!;
    const ch = this.chron;
    const civs = g.sim.world?.civs ?? [];
    const scopes = `<div class="btns"><button class="btn ${this.chronScope === 0 ? 'primary' : ''}" data-scope="0">Monde</button>${civs.map((c) => `<button class="btn ${this.chronScope === c.id ? 'primary' : ''}" data-scope="${c.id}"><span class="dot" style="background:${civCss(c.color)}"></span>${esc(c.name)}${c.fallen ? ' †' : ''}</button>`).join('')}</div>`;
    if (!ch) { body.innerHTML = `${scopes}<p class="note">Rien n’a encore été consigné.</p>`; return; }
    body.innerHTML = `${scopes}
      <div class="chron"><div class="chron-title">${esc(ch.title)}</div><p class="chron-sub">${esc(ch.subtitle)}</p>
      ${ch.chapters.map((c, ci) => `<h3>${esc(c.title)}</h3>${c.paragraphs.map((p, pi) => `<p>${p.map((s, si) => `<span data-s="${ci}.${pi}.${si}">${esc(s.text)}</span>`).join(' ')}</p>`).join('')}`).join('') || '<p class="note">Rien n’a encore été consigné pour ce peuple.</p>'}</div>
      <div class="btns"><button class="btn" data-a="refresh">Actualiser</button><button class="btn" data-a="export">Exporter le récit</button></div>
      <p class="note">Ce récit est composé uniquement à partir des faits enregistrés par la simulation : rien n’y est inventé. Touchez une phrase pour voir ses sources.</p>`;
    body.scrollTop = 0;
    body.querySelectorAll<HTMLElement>('[data-scope]').forEach((b) => b.addEventListener('click', () => void this.loadChronicle(Number(b.dataset.scope))));
    body.querySelector('[data-a="refresh"]')!.addEventListener('click', () => void this.loadChronicle(this.chronScope));
    body.querySelector('[data-a="export"]')!.addEventListener('click', async () => {
      try { await shareTextFile(`epoch-chronique-${ch.scope || 'monde'}.txt`, chronicleText(ch)); } catch (e) { this.toast(`Export impossible : ${(e as Error).message}`); }
    });
    body.querySelector('.chron')!.addEventListener('click', (e) => {
      const span = (e.target as HTMLElement).closest<HTMLElement>('[data-s]');
      if (!span) return;
      body.querySelectorAll('.chron span.on').forEach((x) => x.classList.remove('on'));
      span.classList.add('on');
      const [ci, pi, si] = span.dataset.s!.split('.').map(Number);
      this.showSources(ci, pi, si);
    });
  }

  /** The recorded facts behind one sentence of the chronicle. */
  private showSources(ci: number, pi: number, si: number): void {
    const ch = this.chron;
    const s = ch?.chapters[ci]?.paragraphs[pi]?.[si];
    if (!ch || !s) return;
    this.game.select(0);
    this.treeFor = 0;
    const events = s.sources.map((id) => ch.events[id]).filter(Boolean);
    const annals = s.annals.map((id) => ch.annals[id]).filter(Boolean).sort((a, b) => a.year - b.year || a.settlement - b.settlement);
    this.inspector.innerHTML = `<button class="close" data-a="close">×</button>
      <div class="kicker">Sources de ce passage</div>
      <p class="quote">${esc(s.text)}</p>
      ${events.length ? `<h3>Événement${events.length > 1 ? 's' : ''} enregistré${events.length > 1 ? 's' : ''}</h3><ul class="timeline">${events.map((e) => this.eventLine(e)).join('')}</ul>` : ''}
      ${annals.length ? `<h3>Relevés annuels (${annals.length})</h3><ul class="timeline">${annals.map((a) => `<li><small>An ${a.year} · ${esc(this.placeName(a.settlement))}</small>${a.births} naissance${a.births > 1 ? 's' : ''}, ${a.deaths} décès, ${a.marriages} union${a.marriages > 1 ? 's' : ''}, ${a.built} bâtiment${a.built > 1 ? 's' : ''} ; ${a.pop} habitants en fin d’année</li>`).join('')}</ul>` : ''}
      <p class="note">Le récit ne dit rien de plus que ces faits.</p>`;
    this.inspector.scrollTop = 0;
    this.inspector.classList.remove('closed');
  }

  // ------------------------------------------------------------- divinity
  /** Chooses a power: the next touch on the world casts it there. */
  private arm(power: DivinePower | null): void {
    this.armed = power;
    this.armedBar.classList.toggle('hidden', !power);
    if (!power) return;
    const def = POWERS[power];
    this.armedBar.querySelector('b')!.textContent = def.name;
    this.armedBar.querySelector('span')!.textContent = def.target === 'people' ? 'Touchez un lieu habité' : 'Touchez la terre où agir';
    this.openSection(null);
    this.closeInspector();
  }

  private async castPower(ev: PointerEvent): Promise<void> {
    const g = this.game;
    const power = this.armed!;
    const hit = g.engine.pick(ev.clientX, ev.clientY, ev.pointerType !== 'mouse');
    let point: THREE.Vector3 | null = null;
    if (hit?.type === 'terrain') point = hit.point;
    else if (hit?.type === 'building') point = new THREE.Vector3(hit.building.dir.x, hit.building.dir.y, hit.building.dir.z).multiplyScalar(g.world!.R);
    else if (hit?.type === 'person') {
      const r = g.sim.rosterById.get(hit.id);
      const st = g.settlements.find((x) => x.id === r?.settlement);
      if (st) point = new THREE.Vector3(st.dir.x, st.dir.y, st.dir.z).multiplyScalar(g.world!.R);
    }
    if (!point) return;
    this.arm(null);
    const res = await g.divine(power, point);
    if (!res.ok) { this.toast(res.reason ?? 'Rien ne se produit'); return; }
    const parts: string[] = [POWERS[power].name];
    if (res.deaths) parts.push(`${res.deaths} mort${res.deaths > 1 ? 's' : ''}`);
    if (res.destroyed) parts.push(`${res.destroyed} bâtiment${res.destroyed > 1 ? 's' : ''} touché${res.destroyed > 1 ? 's' : ''}`);
    this.toast(parts.join(' — '));
    if (res.person) this.selectPerson(res.person, true);
  }

  /** Live refresh of the Divinity panel without rebuilding its buttons (so a tap is never lost). */
  private updateDivinity(): void {
    const w = this.game.sim.world;
    const meter = this.panel.querySelector('#div-meter'), list = this.panel.querySelector<HTMLElement>('#div-journal');
    if (!w || !meter || !list) return;
    const energy = w.divine.energy;
    meter.innerHTML = this.meter('Puissance', energy / 100);
    this.panel.querySelectorAll<HTMLElement>('[data-power]').forEach((b) => b.classList.toggle('off', energy < POWERS[b.dataset.power as DivinePower].cost));
    const journal = w.events.filter((e) => e.type === 'divine' || e.type === 'omen').slice(-14).reverse();
    const html = journal.map((e) => this.eventLine(e)).join('') || '<li>Vous n’êtes pas encore intervenu.</li>';
    if (list.dataset.html !== html) {
      list.innerHTML = html;
      list.dataset.html = html;
      this.bindPanelLinks(list);
    }
  }

  private renderDivinityPanel(): void {
    const g = this.game;
    this.panel.querySelector('h2')!.textContent = 'Divinité';
    const body = this.panel.querySelector<HTMLElement>('.body')!;
    const w = g.sim.world;
    const energy = w?.divine.energy ?? 0;
    const journal = (w?.events ?? []).filter((e) => e.type === 'divine' || e.type === 'omen').slice(-14).reverse();
    const top = body.scrollTop;
    body.innerHTML = `<h3>Ferveur du monde</h3><div id="div-meter">${this.meter('Puissance', energy / 100)}</div>
      <p class="note">Chaque intervention puise dans cette réserve. Elle se reforme avec le temps, et plus vite quand les peuples croient avec ferveur.</p>
      <h3>Pouvoirs</h3>
      ${POWER_ORDER.map((id) => { const d = POWERS[id]; return `<button class="power ${d.benevolent ? '' : 'harm'} ${energy < d.cost ? 'off' : ''}" data-power="${id}"><span class="name">${d.name}<i>${d.cost}</i></span><small>${d.effect}</small></button>`; }).join('')}
      <p class="note">Choisissez un pouvoir, puis touchez le monde. Chaque acte modifie réellement la planète ou la vie des habitants, et les peuples l’interprètent selon ce qu’ils croient.</p>
      <h3>Vos actes et ce qu’on en dit</h3><ul class="timeline" id="div-journal">${journal.map((e) => this.eventLine(e)).join('') || '<li>Vous n’êtes pas encore intervenu.</li>'}</ul>`;
    body.scrollTop = top;
    body.querySelectorAll<HTMLElement>('[data-power]').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.power as DivinePower;
      if ((g.sim.world?.divine.energy ?? 0) < POWERS[id].cost) { this.toast('Ferveur insuffisante pour ce pouvoir'); return; }
      this.arm(id);
    }));
    this.bindPanelLinks(body);
  }

  // -------------------------------------------------------------- economy
  /** Stocks, prices, trades, building sites and journal of one settlement — live simulation data. */
  private renderEconomyPanel(): void {
    this.lastPopulationUpdate = performance.now();
    const g = this.game;
    this.panel.querySelector('h2')!.textContent = 'Économie';
    const body = this.panel.querySelector<HTMLElement>('.body')!;
    const eco = g.sim.economy;
    if (!eco) { body.innerHTML = '<p class="note">La simulation démarre…</p>'; return; }
    const inhabited = eco.settlements.filter((x) => x.population > 0);
    if (!inhabited.some((x) => x.id === this.econSite)) this.econSite = inhabited[0]?.id ?? 0;
    const st = inhabited.find((x) => x.id === this.econSite);
    if (!st) { body.innerHTML = '<p class="note">Aucun lieu habité.</p>'; return; }
    const nameOf = (id: number) => g.settlements.find((x) => x.id === id)?.name ?? '?';
    const units = ['repas', 'stères', 'blocs', 'lingots', 'sacs', 'pépites', 'outils', 'pièces'];
    const rows = st.stock.map((v, r) => {
      const t = st.targets[r];
      if (v < 0.5 && t === 0) return '';
      const level = t > 0 ? v / t : 2;
      const state = t === 0 ? '' : level < 0.35 ? 'Pénurie' : level < 0.8 ? 'Bas' : level > 1.6 ? 'Abondant' : 'Suffisant';
      return `<div class="meter"><span>${RESOURCE_LABELS[r]}<br><small style="color:var(--dim)">${fmt(st.prices[r], 2)} p. · ${state}</small></span><div class="bar"><i class="${level < 0.35 ? 'low' : ''}" style="width:${Math.min(100, level * 50)}%"></i></div><b>${fmt(v)}</b></div>`;
    }).join('');
    const events = eco.events.filter((e) => e.settlement === st.id).slice(-10).reverse();
    const top = body.scrollTop;
    body.innerHTML = `
      <div class="btns">${inhabited.map((x) => `<button class="btn ${x.id === st.id ? 'primary' : ''}" data-site="${x.id}">${esc(nameOf(x.id))}</button>`).join('')}</div>
      <h3>${this.tier(st.population)} de ${esc(nameOf(st.id))}</h3>
      <div class="kv"><span>Habitants</span><b>${st.population} (${st.adults} actifs)</b><span>Logements</span><b>${st.housing} places</b>
        <span>Bâtiments</span><b>${st.buildings}</b><span>Caisse commune</span><b>${fmt(st.treasury)} pièces</b>
        ${st.marks.length ? `<span>Marques divines</span><b>${st.marks.map((m) => MARK_LABELS[m] ?? m).join(', ')}</b>` : ''}
        <span>Gibier et cueillette</span><b>${fmt(Math.min(1, st.forage) * 100)} %</b><span>Récolte de l’année</span><b>${fmt(st.harvest * 100)} %</b></div>
      <h3>Greniers et prix</h3>${rows}
      <p class="note">Barre : stock par rapport au niveau visé (${units[0]}, ${units[1]}, ${units[2]}…). Un prix élevé signale un manque et attire les bras.</p>
      <h3>Métiers</h3>${st.jobs.map((n, i) => [i, n] as [number, number]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]).map(([i, n]) => `<div class="meter"><span>${JOB_LABELS_M[i]}s</span><div class="bar"><i class="calm" style="width:${(n / Math.max(1, st.adults)) * 100}%"></i></div><b>${n}</b></div>`).join('')}
      <h3>Chantiers</h3>${st.projects.length ? st.projects.map((p) => `<button class="row" data-building="${p.id}"><span class="name">${BUILDING_NAMES[p.kind] ?? p.kind}</span><small>${fmt(p.progress * 100)} %${p.missing.length ? ` · manque : ${p.missing.map((r) => RESOURCE_LABELS[r].toLowerCase()).join(', ')}` : ''}</small></button>`).join('') : '<p class="note">Aucun chantier en cours.</p>'}
      <h3>Journal</h3><ul class="timeline">${events.map((e) => `<li><small>${formatDate(e.t)}</small>${esc(eventText(e, nameOf))}</li>`).join('') || '<li>Rien à signaler.</li>'}</ul>`;
    body.scrollTop = top;
    body.querySelectorAll<HTMLElement>('[data-site]').forEach((b) => b.addEventListener('click', () => { this.econSite = Number(b.dataset.site); this.renderEconomyPanel(); }));
    body.querySelectorAll<HTMLElement>('[data-building]').forEach((b) => b.addEventListener('click', () => {
      const bd = g.buildings.find((x) => x.id === Number(b.dataset.building));
      if (!bd) return;
      g.select(0);
      this.showBuilding(bd);
      g.engine.controls.flyTo(new THREE.Vector3(bd.dir.x, bd.dir.y, bd.dir.z), 90, 1.05);
    }));
  }

  // ---------------------------------------------------------------- intro
  private hud(show: boolean): void {
    for (const n of [this.topbar, this.nav, this.viewbar, this.labels]) n.classList.toggle('out', !show);
    if (!show) {
      this.openSection(null);
      this.closeInspector();
      this.arm(null);
      this.tutorial.classList.add('hidden');
      for (const n of this.labelNodes.values()) n.remove();
      this.labelNodes.clear();
      this.frames.clear();
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
    g.setRunning(false);
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
    g.setRunning(false);
    this.hud(false);
    this.intro.classList.remove('out', 'reveal');
    this.beginLoading();
    try {
      const { checksumOk } = await g.load(save, (s, i, p) => this.progress(s, i, p));
      this.enterWorld(false);
      this.toast(g.refounded ? 'Sauvegarde d’une phase antérieure : le monde et la date sont conservés, la société est refondée' : checksumOk ? `Partie restaurée — an ${g.date.year}` : 'Partie restaurée (monde régénéré par une version différente du générateur)');
    } catch (e) {
      this.showTitle();
      this.intro.querySelector('.err')!.textContent = (e as Error).message;
    }
  }

  private enterWorld(fresh: boolean): void {
    const g = this.game;
    this.intro.classList.add('out');
    g.engine.controls.cinematic = false;
    g.setRunning(true);
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
