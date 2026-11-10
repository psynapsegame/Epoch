import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { clamp, smoothstep } from '../core/math';
import { SECONDS_PER_DAY, SECONDS_PER_YEAR } from '../sim/clock';
import type { Building } from '../sim/settlements';
import { World } from '../world/world';
import type { WorldData } from '../world/types';
import { AtmospherePass } from './atmospherePass';
import { BuildingsLayer } from './buildingsLayer';
import { CameraController } from './cameraController';
import { DivineFx } from './divineFx';
import { applyEdit, type WorldEdit } from '../world/edits';
import { PeopleLayer } from './peopleLayer';
import { createTreeAssets, type TreeAssets } from './models/trees';
import { createOcean } from './ocean';
import { U } from './shared';
import { createClouds, createStars } from './sky';
import { PlanetTerrain } from './terrain';
import { createTerrainMaterial } from './terrainMaterial';
import { PROFILES, type QualityProfile } from './quality';
import { ATLAS_MODES, POLITICAL_MODES, buildAtlasTexture, buildCloudTexture, buildPoliticalTexture, buildWorldTextures, type AtlasMode, type PoliticalMark } from './worldTextures';

const AXIAL_TILT = 23.4 * (Math.PI / 180);
const Y = new THREE.Vector3(0, 1, 0);

export interface PerfStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  chunks: number;
  chunksTotal: number;
  trees: number;
  buildings: number;
  people: number;
  queue: number;
  geometries: number;
  textures: number;
}

export type PickResult =
  | { type: 'person'; id: number }
  | { type: 'building'; building: Building }
  | { type: 'terrain'; cell: number; point: THREE.Vector3 }
  | null;

/**
 * 3D rendering engine. It only *reads* the world & simulation state: nothing
 * here influences the simulation, so rendering can be throttled, paused or
 * replaced without affecting determinism.
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(48, 1, 1, 30000);
  readonly controls: CameraController;
  readonly perf: PerfStats = { fps: 0, frameMs: 0, drawCalls: 0, triangles: 0, chunks: 0, chunksTotal: 0, trees: 0, buildings: 0, people: 0, queue: 0, geometries: 0, textures: 0 };
  world: World | null = null;

  private sceneRT: THREE.WebGLRenderTarget;
  private composer: EffectComposer;
  private atmosphere: AtmospherePass;
  private bloom: UnrealBloomPass;
  private sun = new THREE.DirectionalLight(0xfff4e0, 3.4);
  private stars = createStars();
  private ocean = createOcean();
  private clouds = createClouds();
  private terrain: PlanetTerrain | null = null;
  private terrainMaterial = createTerrainMaterial();
  private treeAssets: TreeAssets = createTreeAssets();
  readonly buildings = new BuildingsLayer();
  readonly people = new PeopleLayer();
  readonly fx = new DivineFx();
  /** Seconds of stormy sky left to show (cosmetic). */
  private stormTime = 0;
  private planet = new THREE.Group();
  private atlasTex: THREE.DataTexture | null = null;
  private atlasMode: AtlasMode = 'none';
  private overlayGoal = 0;
  private raycaster = new THREE.Raycaster();
  private fpsAcc = 0;
  private fpsFrames = 0;
  /** Active quality profile and dynamic resolution scale (set by the governor). */
  profile: QualityProfile = PROFILES.high;
  private resolutionScale = 1;
  private outputPass = new OutputPass();

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.info.autoReset = false;

    this.sceneRT = this.createSceneTarget(this.profile.msaa);

    this.composer = new EffectComposer(this.renderer, new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType }));
    this.atmosphere = new AtmospherePass(this.sceneRT, this.camera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), 0.22, 0.6, 1.0);
    this.composer.addPass(this.atmosphere);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.outputPass);

    this.scene.background = new THREE.Color(0x000000);
    this.scene.add(this.stars);
    this.scene.add(this.planet);
    this.planet.visible = false;
    this.planet.add(this.ocean, this.clouds, this.buildings.group, this.people.group, this.fx.group);

    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun, this.sun.target);

    this.controls = new CameraController(this.camera, canvas);
    this.applyQuality(this.profile);
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => window.setTimeout(() => this.resize(), 250));
    // A lost WebGL context (common on phones after backgrounding) is restored by three.js; just re-render.
    canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const pr = Math.max(0.5, Math.min(window.devicePixelRatio || 1, this.profile.pixelRatioCap) * this.resolutionScale);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.sceneRT.setSize(Math.round(w * pr), Math.round(h * pr));
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    (this.stars.material as THREE.ShaderMaterial).uniforms.uPixelRatio.value = pr;
  }

  private createSceneTarget(samples: number): THREE.WebGLRenderTarget {
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples });
    rt.depthTexture = new THREE.DepthTexture(4, 4);
    rt.depthTexture.type = THREE.UnsignedIntType;
    return rt;
  }

  private get terrainOptions() {
    const q = this.profile;
    return { maxLevel: q.maxTerrainLevel, splitFactor: q.splitFactor, treeGrid: q.treeGrid, budgetMs: q.chunkBudgetMs };
  }

  /** Dynamic resolution scale (0.5..1), driven by the quality governor. */
  setResolutionScale(scale: number): void {
    const s = clamp(scale, 0.5, 1);
    if (s === this.resolutionScale) return;
    this.resolutionScale = s;
    this.resize();
  }

  /** Applies a quality tier: render targets, shadows, post effects, shader variants, LOD. */
  applyQuality(profile: QualityProfile): void {
    const previous = this.profile;
    this.profile = profile;

    if (this.sceneRT.samples !== profile.msaa) {
      this.sceneRT.dispose();
      this.sceneRT.depthTexture?.dispose();
      this.sceneRT = this.createSceneTarget(profile.msaa);
      this.atmosphere.setSource(this.sceneRT);
    }
    this.bloom.enabled = profile.bloom;
    this.atmosphere.setSteps(profile.atmosphereSteps, profile.atmosphereLightSteps);

    const r = this.renderer;
    r.shadowMap.enabled = profile.shadowMapSize > 0;
    r.shadowMap.type = profile.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    if (profile.shadowMapSize > 0 && this.sun.shadow.mapSize.x !== profile.shadowMapSize) {
      this.sun.shadow.mapSize.set(profile.shadowMapSize, profile.shadowMapSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }

    // Shader variants: every planet material is recompiled with or without EPOCH_LOW.
    const mats: THREE.Material[] = [
      this.terrainMaterial, this.ocean.material as THREE.Material, this.clouds.material as THREE.Material,
      this.buildings.material, this.people.material, ...this.treeAssets.materials,
    ];
    const shadowChanged = previous.softShadows !== profile.softShadows || (previous.shadowMapSize > 0) !== (profile.shadowMapSize > 0);
    for (const m of mats) {
      const defs = (m.defines ??= {});
      const had = 'EPOCH_LOW' in defs;
      if (profile.simpleShaders) defs.EPOCH_LOW = 1;
      else delete defs.EPOCH_LOW;
      if (had !== profile.simpleShaders || shadowChanged) m.needsUpdate = true;
    }
    for (const t of [U.uTexA.value, U.uTexB.value, U.uCloudTex.value]) {
      if (t && t.anisotropy !== profile.textureAnisotropy) {
        t.anisotropy = profile.textureAnisotropy;
        t.needsUpdate = true;
      }
    }
    this.terrain?.setOptions(this.terrainOptions);
    this.people.setBudget(profile.peopleBudget);
    this.resize();
  }

  /** Installs a freshly generated (or loaded) world. */
  setWorld(data: WorldData): World {
    this.terrain?.disposeAll();
    if (this.terrain) this.planet.remove(this.terrain.group);
    U.uTexA.value?.dispose();
    U.uTexB.value?.dispose();
    U.uCloudTex.value?.dispose();
    this.atlasTex?.dispose();

    const world = new World(data);
    this.world = world;
    const { texA, texB } = buildWorldTextures(data);
    U.uTexA.value = texA;
    U.uTexB.value = texB;
    U.uCloudTex.value = buildCloudTexture(data.seed);
    this.atlasTex = buildAtlasTexture(data, 'none');
    U.uOverlayTex.value = this.atlasTex;
    U.uOverlayMix.value = 0;
    this.atlasMode = 'none';
    this.overlayGoal = 0;

    for (const t of [texA, texB, U.uCloudTex.value]) t.anisotropy = this.profile.textureAnisotropy;
    this.terrain = new PlanetTerrain(world, this.terrainMaterial, this.treeAssets, this.terrainOptions);
    this.planet.add(this.terrain.group);
    this.planet.visible = true;
    this.atmosphere.material.uniforms.uEnabled.value = 1;
    this.controls.setWorld(world);
    this.buildings.sync(world, []);
    return world;
  }

  /**
   * A divine edit reshaped the planet: update the world grid, the GPU
   * textures derived from it, the terrain chunks and the vegetation.
   */
  applyWorldEdit(edit: WorldEdit): void {
    const world = this.world;
    if (!world || !this.terrain) return;
    applyEdit(world.data, edit);
    U.uTexA.value?.dispose();
    U.uTexB.value?.dispose();
    const { texA, texB } = buildWorldTextures(world.data);
    texA.anisotropy = texB.anisotropy = this.profile.textureAnisotropy;
    U.uTexA.value = texA;
    U.uTexB.value = texB;
    const dir = new THREE.Vector3();
    world.cellDir(edit.x, edit.y, dir);
    this.terrain.invalidate(dir.clone().multiplyScalar(world.R), edit.radius);
    this.terrain.refreshTrees();
    this.buildings.invalidate();
    if (this.atlasMode !== 'none' && this.atlasTex && !POLITICAL_MODES.includes(this.atlasMode)) buildAtlasTexture(world.data, this.atlasMode, this.atlasTex);
  }

  /** Darkens the sky for a while (storms). */
  storm(seconds: number): void {
    this.stormTime = seconds;
  }

  /** Mirrors the simulation's buildings into the scene. */
  syncBuildings(buildings: Building[]): void {
    if (!this.world || !this.terrain) return;
    if (!this.buildings.sync(this.world, buildings)) return;
    // new plots are cleared of trees
    this.terrain.setClearings(buildings.map((b) => ({ dir: new THREE.Vector3(b.dir.x, b.dir.y, b.dir.z), radius: b.radius + 5 })));
    this.terrain.refreshTrees();
  }

  setAtlasMode(mode: AtlasMode): void {
    if (!this.world || !this.atlasTex) return;
    this.atlasMode = mode;
    if (mode !== 'none') buildAtlasTexture(this.world.data, mode, this.atlasTex);
    this.overlayGoal = mode === 'none' ? 0 : 1;
  }

  /** Political maps (borders, population, religions) painted from live simulation data. */
  setPoliticalOverlay(mode: AtlasMode, marks: PoliticalMark[]): void {
    if (!this.world || !this.atlasTex) return;
    this.atlasMode = mode;
    buildPoliticalTexture(this.world.data, marks, this.atlasTex);
    this.overlayGoal = 1;
  }

  get atlas(): AtlasMode {
    return this.atlasMode;
  }

  get atlasModes() {
    return ATLAS_MODES;
  }

  /** What lies under a screen position? */
  pick(clientX: number, clientY: number, touch = false): PickResult {
    if (!this.world) return null;
    const rect = this.canvas.getBoundingClientRect();
    // Inhabitants first: they are small, so the finger gets a generous radius.
    const person = this.people.pick(this.camera, rect, clientX, clientY, touch ? 30 : 16);
    if (person) return { type: 'person', id: person };
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const o = this.raycaster.ray.origin, d = this.raycaster.ray.direction;
    const t = this.world.raycast(o.x, o.y, o.z, d.x, d.y, d.z);
    const hit = this.buildings.pick(this.raycaster);
    if (hit && (t < 0 || hit.distance < t + 1)) return { type: 'building', building: hit.building };
    if (t < 0) return null;
    const point = o.clone().addScaledVector(d, t);
    const n = point.clone().normalize();
    return { type: 'terrain', cell: this.world.cellAt(n.x, n.y, n.z), point };
  }

  /** Local solar time (0..24 h) at the camera focus, for display. */
  localHour(simTime: number): number {
    const d = this.controls.dir;
    const sun = U.uSunDir.value;
    const lonSun = Math.atan2(sun.z, sun.x), lon = Math.atan2(d.z, d.x);
    void simTime;
    return ((((lon - lonSun) / (2 * Math.PI)) * 24 + 12) % 24 + 24) % 24;
  }

  /**
   * Renders a frame.
   * @param dt real seconds since the last frame
   * @param simTime simulated seconds (drives seasons)
   * @param visualDay continuous day counter driving the sun (may be slowed at high speeds)
   */
  frame(dt: number, simTime: number, visualDay: number): void {
    const t0 = performance.now();
    U.uTime.value += dt;

    // --- sun & seasons ---------------------------------------------------
    const yearAngle = ((simTime / SECONDS_PER_YEAR) % 1) * Math.PI * 2;
    U.uSeason.value = Math.sin(yearAngle);
    U.uSeasonCos.value = Math.cos(yearAngle);
    const decl = AXIAL_TILT * Math.sin(yearAngle);
    const hourAngle = -visualDay * Math.PI * 2;
    U.uSunDir.value.set(Math.cos(decl) * Math.cos(hourAngle), Math.sin(decl), Math.cos(decl) * Math.sin(hourAngle)).normalize();
    this.stars.quaternion.setFromAxisAngle(Y, -hourAngle);
    U.uCloudShift.value = (U.uTime.value * 0.0006) % 1;
    this.buildings.update(this.camera.position, this.renderer.domElement.height, this.camera.fov);
    this.stormTime = Math.max(0, this.stormTime - dt);
    const cover = this.stormTime > 0 ? 0.82 : 0.44;
    U.uCloudCover.value += (cover - U.uCloudCover.value) * Math.min(1, dt * 0.8);
    this.fx.update(dt);

    this.controls.update(dt);
    const cam = this.camera;
    U.uCamPos.value.copy(cam.position);
    this.stars.position.copy(cam.position);
    this.stars.scale.setScalar((cam.near + cam.far) * 0.5);

    // stars fade under a bright daytime sky
    const camUp = cam.position.clone().normalize();
    const alt = this.controls.altitude;
    const dayAtCam = smoothstep(-0.12, 0.2, camUp.dot(U.uSunDir.value));
    const inAtmo = 1 - smoothstep(250, 1400, alt);
    (this.stars.material as THREE.ShaderMaterial).uniforms.uFade.value = 1 - dayAtCam * inAtmo * 0.97;

    // --- sun light & shadows follow the focus point ----------------------
    const focus = this.controls.dir.clone().multiplyScalar(this.world?.R ?? 3200);
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(U.uSunDir.value, 2500);
    const shadowOn = this.profile.shadowMapSize > 0 && this.controls.distance < 1300 && this.controls.dir.dot(U.uSunDir.value) > -0.05;
    this.sun.castShadow = shadowOn;
    if (shadowOn) {
      const ext = clamp(this.controls.distance * 1.25, 90, 900);
      const sc = this.sun.shadow.camera;
      if (Math.abs(sc.right - ext) > ext * 0.08) {
        sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext;
        sc.near = 100; sc.far = 5000;
        sc.updateProjectionMatrix();
      }
      this.sun.shadow.normalBias = ext / 500;
    }

    // --- overlay fade, LOD, render --------------------------------------
    U.uOverlayMix.value += (this.overlayGoal - U.uOverlayMix.value) * Math.min(1, dt * 6);
    this.terrain?.update(cam);

    this.renderer.info.reset();
    this.renderer.setRenderTarget(this.sceneRT);
    this.renderer.clear();
    this.renderer.render(this.scene, cam);
    this.renderer.setRenderTarget(null);
    this.composer.render(dt);

    // --- diagnostics -----------------------------------------------------
    const p = this.perf;
    p.frameMs = p.frameMs * 0.9 + (performance.now() - t0) * 0.1;
    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc >= 0.5) {
      p.fps = this.fpsFrames / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }
    p.drawCalls = this.renderer.info.render.calls;
    p.triangles = this.renderer.info.render.triangles;
    p.geometries = this.renderer.info.memory.geometries;
    p.textures = this.renderer.info.memory.textures;
    if (this.terrain) {
      p.chunks = this.terrain.stats.chunksVisible;
      p.chunksTotal = this.terrain.stats.chunksTotal;
      p.trees = this.terrain.stats.treesVisible;
      p.queue = this.terrain.stats.queue;
    }
    p.buildings = this.buildings.drawn;
    p.people = this.people.drawn;
  }

  /** True while one-off work (terrain construction) inflates frame times. */
  get busy(): boolean {
    return (this.terrain?.stats.queue ?? 0) > 0;
  }

  /** Converts simulated time into the day counter used for the sun. */
  static dayOf(simTime: number): number {
    return simTime / SECONDS_PER_DAY;
  }
}
