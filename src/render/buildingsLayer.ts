import * as THREE from 'three';
import { buildBuildingModels, type BuildingKind, type BuildingModel } from './models/buildings';
import { patchMaterial, U } from './shared';
import type { Building } from '../sim/settlements';
import type { World } from '../world/world';

/** Chimney mouths in model space, for the kinds that have a hearth. */
const CHIMNEYS: Partial<Record<BuildingKind, [number, number, number]>> = {
  house: [-2.4, 6.6, -1.0],
  farm: [-2.7, 5.65, -3.1],
  workshop: [3.95, 6.9, -0.6],
};
const PUFFS = 5;
/** Beyond this distance (m) a settlement's buildings are smaller than a pixel and are not drawn. */
const DRAW_DISTANCE = 3400;

interface Cluster { group: THREE.Group; centre: THREE.Vector3 }

/**
 * Renders the buildings of the world: one InstancedMesh per settlement and
 * building type, so that only the settlements in view are drawn, plus the
 * smoke of the hearths of inhabited houses.
 */
export class BuildingsLayer {
  readonly group = new THREE.Group();
  readonly models: Record<BuildingKind, BuildingModel>;
  readonly material: THREE.MeshStandardMaterial;
  private meshes = new Map<string, THREE.InstancedMesh>();
  /** instance index -> building, per mesh (for picking). */
  private lookup = new Map<string, Building[]>();
  private clusters = new Map<number, Cluster>();
  private smoke: THREE.Points | null = null;
  private smokeMaterial: THREE.ShaderMaterial;
  private occupied = new Set<number>();
  private occupiedKey = '';
  private current: Building[] = [];
  private world: World | null = null;
  drawn = 0;

  constructor() {
    this.models = buildBuildingModels();
    this.material = patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 }), {
      vertexPars: `attribute float emissive; attribute vec2 aBuild; varying float vGlow; varying float vCut;`,
      // aBuild = (progress 0..1, model height): the building rises from its foundations as work advances
      vertexTransform: `vGlow = emissive; vCut = (-1.5 + (aBuild.y + 1.5) * aBuild.x) - position.y + step(0.999, aBuild.x) * 1000.0;`,
      fragPars: `varying float vGlow; varying float vCut;`,
      fragColor: `if (vCut < 0.0) discard; diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.5, 0.36), 0.35 * (1.0 - smoothstep(0.0, 0.35, vCut)) * step(vCut, 500.0));`,
      fragEmissive: /* glsl */ `
        if (vCut > 500.0) {
          float night = 1.0 - smoothstep(-0.08, 0.16, epochSunUp);
          float flicker = 0.85 + 0.15 * sin(uTime * 7.0 + vWPos.x * 3.0 + vWPos.z * 5.0);
          totalEmissiveRadiance += vec3(2.6, 1.35, 0.42) * vGlow * (0.06 + 0.94 * night) * flicker;
        }`,
    });
    this.smokeMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: U.uTime, uSunDir: U.uSunDir, uScale: { value: 600 } },
      transparent: true, depthWrite: false,
      vertexShader: /* glsl */ `
        attribute vec3 aUp; attribute float aPhase;
        uniform float uTime; uniform vec3 uSunDir; uniform float uScale;
        varying float vAlpha; varying float vLight;
        void main() {
          float t = fract(uTime * 0.085 + aPhase);
          vec3 wind = normalize(cross(aUp, vec3(0.31, 0.83, 0.46)));
          vec3 p = position + aUp * (t * 9.0) + wind * (t * t * 5.0 + 0.35 * sin(uTime * 0.9 + aPhase * 40.0) * t);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = min(64.0, uScale * (0.5 + 2.2 * t) / max(1.0, -mv.z));
          vAlpha = smoothstep(0.0, 0.12, t) * (1.0 - t) * 0.5;
          vLight = 0.16 + 0.84 * smoothstep(-0.1, 0.25, dot(aUp, uSunDir));
        }`,
      fragmentShader: /* glsl */ `
        varying float vAlpha; varying float vLight;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = (1.0 - smoothstep(0.25, 1.0, d)) * vAlpha;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vec3(0.78, 0.76, 0.74) * vLight, a);
        }`,
    });
  }

  /**
   * Tells which buildings are inhabited or worked in: only their hearths smoke.
   */
  setOccupied(ids: Set<number>): void {
    let key = 0;
    for (const id of ids) key = (key * 31 + id) | 0;
    const k = `${ids.size}:${key}`;
    if (k === this.occupiedKey) return;
    this.occupiedKey = k;
    this.occupied = ids;
    this.rebuildSmoke();
  }

  private rebuildSmoke(): void {
    if (this.smoke) {
      this.group.remove(this.smoke);
      this.smoke.geometry.dispose();
      this.smoke = null;
    }
    const world = this.world;
    if (!world) return;
    const hearths = this.current.filter((b) => CHIMNEYS[b.kind] && (b.progress ?? 1) >= 1 && this.occupied.has(b.id));
    if (!hearths.length) return;
    const pos = new Float32Array(hearths.length * PUFFS * 3), up = new Float32Array(hearths.length * PUFFS * 3), phase = new Float32Array(hearths.length * PUFFS);
    const x = new THREE.Vector3(), y = new THREE.Vector3(), z = new THREE.Vector3(), p = new THREE.Vector3();
    hearths.forEach((b, i) => {
      const c = CHIMNEYS[b.kind]!;
      y.set(b.dir.x, b.dir.y, b.dir.z);
      z.set(b.facing.x, b.facing.y, b.facing.z);
      x.crossVectors(y, z).normalize();
      z.crossVectors(x, y).normalize();
      p.copy(y).multiplyScalar(world.R + world.elevationAt(b.dir.x, b.dir.y, b.dir.z) + 0.05 + c[1]).addScaledVector(x, c[0]).addScaledVector(z, c[2]);
      for (let k = 0; k < PUFFS; k++) {
        const o = (i * PUFFS + k) * 3;
        pos[o] = p.x; pos[o + 1] = p.y; pos[o + 2] = p.z;
        up[o] = y.x; up[o + 1] = y.y; up[o + 2] = y.z;
        phase[i * PUFFS + k] = (k + ((b.id * 0.6180339) % 1)) / PUFFS;
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aUp', new THREE.BufferAttribute(up, 3));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    this.smoke = new THREE.Points(geo, this.smokeMaterial);
    this.smoke.frustumCulled = false;
    this.smoke.renderOrder = 5;
    this.group.add(this.smoke);
  }

  /** Shows only the settlements near enough to be seen; returns how many buildings are drawn. */
  update(camera: THREE.Vector3, viewportHeight: number, fov: number): void {
    let drawn = 0, near = false;
    for (const c of this.clusters.values()) {
      const d = c.centre.distanceTo(camera);
      c.group.visible = d < DRAW_DISTANCE;
      if (c.group.visible) for (const m of c.group.children) drawn += (m as THREE.InstancedMesh).count;
      if (d < 1500) near = true;
    }
    this.drawn = drawn;
    if (this.smoke) this.smoke.visible = near;
    this.smokeMaterial.uniforms.uScale.value = (2.1 * viewportHeight) / (2 * Math.tan((fov * Math.PI) / 360));
  }

  private signature = '';

  /** Forces the next sync to rebuild every instance (e.g. the ground moved under the buildings). */
  invalidate(): void {
    this.signature = '';
  }

  /**
   * Mirrors the simulation's buildings. Returns true when the set of buildings
   * changed (not just their construction progress).
   */
  sync(world: World, buildings: Building[]): boolean {
    const signature = buildings.map((b) => `${b.id}:${b.tint ?? ''}`).join(',');
    if (signature === this.signature && buildings.length) {
      // same buildings: only construction progress moved
      const byId = new Map(buildings.map((b) => [b.id, b]));
      let finished = false;
      for (const [key, mesh] of this.meshes) {
        const list = this.lookup.get(key)!;
        const attr = mesh.geometry.getAttribute('aBuild') as THREE.InstancedBufferAttribute;
        let changed = false;
        list.forEach((old, i) => {
          const b = byId.get(old.id) ?? old;
          list[i] = b;
          const v = b.progress ?? 1;
          if (attr.getX(i) !== v) {
            if (v >= 1) finished = true;
            attr.setX(i, v);
            changed = true;
          }
        });
        if (changed) attr.needsUpdate = true;
      }
      this.current = buildings;
      if (finished) this.rebuildSmoke();
      return false;
    }
    this.signature = signature;
    this.current = buildings;
    this.world = world;
    for (const m of this.meshes.values()) {
      m.geometry.dispose();
      m.dispose();
    }
    for (const c of this.clusters.values()) this.group.remove(c.group);
    this.meshes.clear();
    this.lookup.clear();
    this.clusters.clear();
    const byKey = new Map<string, Building[]>();
    for (const b of buildings) {
      const key = `${b.settlement}:${b.kind}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(b);
      let c = this.clusters.get(b.settlement);
      if (!c) {
        c = { group: new THREE.Group(), centre: new THREE.Vector3(b.dir.x, b.dir.y, b.dir.z).multiplyScalar(world.R) };
        this.clusters.set(b.settlement, c);
        this.group.add(c.group);
      }
    }
    const m = new THREE.Matrix4(), x = new THREE.Vector3(), y = new THREE.Vector3(), z = new THREE.Vector3(), p = new THREE.Vector3();
    for (const [key, list] of byKey) {
      const kind = list[0].kind;
      const model = this.models[kind] ?? this.models.house;
      // each kind owns a copy of the geometry so it can carry per-instance construction data
      const geo = model.geometry.clone();
      const build = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 2), 2);
      list.forEach((b, i) => build.setXY(i, b.progress ?? 1, model.height));
      geo.setAttribute('aBuild', build);
      const inst = new THREE.InstancedMesh(geo, this.material, list.length);
      const tint = new THREE.Color(), white = new THREE.Color(1, 1, 1);
      list.forEach((b, i) => {
        // roofs and walls take a hint of the people's colour
        inst.setColorAt(i, b.tint === undefined ? white : tint.setHex(b.tint).lerp(white, 0.72));
        y.set(b.dir.x, b.dir.y, b.dir.z);
        z.set(b.facing.x, b.facing.y, b.facing.z);
        x.crossVectors(y, z).normalize();
        z.crossVectors(x, y).normalize();
        const h = world.elevationAt(b.dir.x, b.dir.y, b.dir.z);
        p.copy(y).multiplyScalar(world.R + (kind === 'dock' ? Math.max(h, 0.35) : h) + 0.05);
        m.makeBasis(x, y, z).setPosition(p);
        inst.setMatrixAt(i, m);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.computeBoundingSphere();
      this.clusters.get(list[0].settlement)!.group.add(inst);
      this.meshes.set(key, inst);
      this.lookup.set(key, list);
    }
    this.rebuildSmoke();
    return true;
  }

  /** Returns the building hit by a ray, if any. */
  pick(raycaster: THREE.Raycaster): { building: Building; distance: number } | null {
    let best: { building: Building; distance: number } | null = null;
    for (const [kind, mesh] of this.meshes) {
      if (!mesh.parent?.visible) continue;
      const hits = raycaster.intersectObject(mesh, false);
      if (hits.length && hits[0].instanceId !== undefined && (!best || hits[0].distance < best.distance)) {
        best = { building: this.lookup.get(kind)![hits[0].instanceId], distance: hits[0].distance };
      }
    }
    return best;
  }

  get count(): number {
    let n = 0;
    for (const m of this.meshes.values()) n += m.count;
    return n;
  }
}
