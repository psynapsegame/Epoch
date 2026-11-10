import * as THREE from 'three';
import { buildBuildingModels, BUILDING_KINDS, type BuildingKind, type BuildingModel } from './models/buildings';
import { patchMaterial } from './shared';
import type { Building } from '../sim/settlements';
import type { World } from '../world/world';

/** Renders all buildings of the world with one InstancedMesh per building type. */
export class BuildingsLayer {
  readonly group = new THREE.Group();
  readonly models: Record<BuildingKind, BuildingModel>;
  readonly material: THREE.MeshStandardMaterial;
  private meshes = new Map<BuildingKind, THREE.InstancedMesh>();
  /** instance index -> building, per kind (for picking). */
  private lookup = new Map<BuildingKind, Building[]>();

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
  }

  private signature = '';

  /**
   * Mirrors the simulation's buildings. Returns true when the set of buildings
   * changed (not just their construction progress).
   */
  sync(world: World, buildings: Building[]): boolean {
    const signature = buildings.map((b) => `${b.id}:${b.tint ?? ''}`).join(',');
    if (signature === this.signature && buildings.length) {
      // same buildings: only construction progress moved
      for (const [kind, mesh] of this.meshes) {
        const list = this.lookup.get(kind)!;
        const attr = mesh.geometry.getAttribute('aBuild') as THREE.InstancedBufferAttribute;
        const byId = new Map(buildings.map((b) => [b.id, b]));
        list.forEach((old, i) => {
          const b = byId.get(old.id) ?? old;
          list[i] = b;
          attr.setX(i, b.progress ?? 1);
        });
        attr.needsUpdate = true;
      }
      return false;
    }
    this.signature = signature;
    for (const m of this.meshes.values()) {
      this.group.remove(m);
      m.geometry.dispose();
      m.dispose();
    }
    this.meshes.clear();
    this.lookup.clear();
    const byKind = new Map<BuildingKind, Building[]>();
    for (const b of buildings) {
      if (!byKind.has(b.kind)) byKind.set(b.kind, []);
      byKind.get(b.kind)!.push(b);
    }
    const m = new THREE.Matrix4(), x = new THREE.Vector3(), y = new THREE.Vector3(), z = new THREE.Vector3(), p = new THREE.Vector3();
    for (const kind of BUILDING_KINDS) {
      const list = byKind.get(kind);
      if (!list?.length) continue;
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
      this.group.add(inst);
      this.meshes.set(kind, inst);
      this.lookup.set(kind, list);
    }
    return true;
  }

  /** Returns the building hit by a ray, if any. */
  pick(raycaster: THREE.Raycaster): { building: Building; distance: number } | null {
    let best: { building: Building; distance: number } | null = null;
    for (const [kind, mesh] of this.meshes) {
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
