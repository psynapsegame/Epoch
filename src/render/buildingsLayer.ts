import * as THREE from 'three';
import { buildBuildingModels, BUILDING_KINDS, type BuildingKind, type BuildingModel } from './models/buildings';
import { patchMaterial } from './shared';
import type { Building } from '../sim/settlements';
import type { World } from '../world/world';

/** Renders all buildings of the world with one InstancedMesh per building type. */
export class BuildingsLayer {
  readonly group = new THREE.Group();
  readonly models: Record<BuildingKind, BuildingModel>;
  private material: THREE.MeshStandardMaterial;
  private meshes = new Map<BuildingKind, THREE.InstancedMesh>();
  /** instance index -> building, per kind (for picking). */
  private lookup = new Map<BuildingKind, Building[]>();

  constructor() {
    this.models = buildBuildingModels();
    this.material = patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 }), {
      vertexPars: `attribute float emissive; varying float vGlow;`,
      vertexTransform: `vGlow = emissive;`,
      fragPars: `varying float vGlow;`,
      fragEmissive: /* glsl */ `
        {
          float night = 1.0 - smoothstep(-0.08, 0.16, epochSunUp);
          float flicker = 0.85 + 0.15 * sin(uTime * 7.0 + vWPos.x * 3.0 + vWPos.z * 5.0);
          totalEmissiveRadiance += vec3(2.6, 1.35, 0.42) * vGlow * (0.06 + 0.94 * night) * flicker;
        }`,
    });
  }

  /** Rebuilds instances from the list of buildings in the simulation state. */
  sync(world: World, buildings: Building[]): void {
    for (const m of this.meshes.values()) {
      this.group.remove(m);
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
      const inst = new THREE.InstancedMesh(this.models[kind].geometry, this.material, list.length);
      list.forEach((b, i) => {
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
