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
import { createTreeAssets, type TreeAssets } from './models/trees';
import { createOcean } from './ocean';
import { U } from './shared';
import { createClouds, createStars } from './sky';
import { PlanetTerrain } from './terrain';
import { createTerrainMaterial } from './terrainMaterial';
import { ATLAS_MODES, buildAtlasTexture, buildCloudTexture, buildWorldTextures, type AtlasMode } from './worldTextures';

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
  queue: number;
  geometries: number;
  textures: number;
}

export type PickResult =
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
  readonly perf: PerfStats = { fps: 0, frameMs: 0, drawCalls: 0, triangles: 0, chunks: 0, chunksTotal: 0, trees: 0, buildings: 0, queue: 0, geometries: 0, textures: 0 };
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
  private planet = new THREE.Group();
  private atlasTex: THREE.DataTexture | null = null;
  private atlasMode: AtlasMode = 'none';
  private overlayGoal = 0;
  private raycaster = new THREE.Raycaster();
  private fpsAcc = 0;
  private fpsFrames = 0;
  private quality = 1;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = false;

    this.sceneRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
    this.sceneRT.depthTexture = new THREE.DepthTexture(4, 4);
    this.sceneRT.depthTexture.type = THREE.UnsignedIntType;

    this.composer = new EffectComposer(this.renderer, new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType }));
    this.atmosphere = new AtmospherePass(this.sceneRT, this.camera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), 0.22, 0.6, 1.0);
    this.composer.addPass(this.atmosphere);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.scene.background = new THREE.Color(0x000000);
    this.scene.add(this.stars);
    this.scene.add(this.planet);
    this.planet.visible = false;
    this.planet.add(this.ocean, this.clouds, this.buildings.group);

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun, this.sun.target);

    this.controls = new CameraController(this.camera, canvas);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const pr = Math.min(window.devicePixelRatio, 2) * this.quality;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.sceneRT.setSize(Math.round(w * pr), Math.round(h * pr));
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    (this.stars.material as THREE.ShaderMaterial).uniforms.uPixelRatio.value = pr;
  }

  /** Render resolution scale (0.5..1) for weaker GPUs. */
  setQuality(q: number): void {
    this.quality = clamp(q, 0.4, 1);
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

    this.terrain = new PlanetTerrain(world, this.terrainMaterial, this.treeAssets);
    this.planet.add(this.terrain.group);
    this.planet.visible = true;
    this.atmosphere.material.uniforms.uEnabled.value = 1;
    this.controls.setWorld(world);
    this.buildings.sync(world, []);
    return world;
  }

  /** Mirrors the simulation's buildings into the scene. */
  syncBuildings(buildings: Building[], clearings: { dir: THREE.Vector3; radius: number }[]): void {
    if (!this.world || !this.terrain) return;
    this.buildings.sync(this.world, buildings);
    this.terrain.setClearings(clearings);
    this.terrain.refreshTrees();
  }

  setAtlasMode(mode: AtlasMode): void {
    if (!this.world || !this.atlasTex) return;
    this.atlasMode = mode;
    if (mode !== 'none') buildAtlasTexture(this.world.data, mode, this.atlasTex);
    this.overlayGoal = mode === 'none' ? 0 : 1;
  }

  get atlas(): AtlasMode {
    return this.atlasMode;
  }

  get atlasModes() {
    return ATLAS_MODES;
  }

  /** What lies under a screen position? */
  pick(clientX: number, clientY: number): PickResult {
    if (!this.world) return null;
    const rect = this.canvas.getBoundingClientRect();
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
    const shadowOn = this.controls.distance < 1300 && this.controls.dir.dot(U.uSunDir.value) > -0.05;
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
    p.buildings = this.buildings.count;
  }

  /** Converts simulated time into the day counter used for the sun. */
  static dayOf(simTime: number): number {
    return simTime / SECONDS_PER_DAY;
  }
}
