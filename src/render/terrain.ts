import * as THREE from 'three';
import { hash2, hashString } from '../core/rng';
import { Biome } from '../world/types';
import type { World } from '../world/world';
import { TreeKind, TREE_KIND_COUNT, type TreeAssets } from './models/trees';

const RES = 32; // quads per chunk edge
const VERTS = (RES + 1) * (RES + 1);
const MAX_LEVEL = 7;
const TREE_LEVEL = 4;
const SPLIT_FACTOR = 2.5;
const TREE_GRID = 36; // candidate trees per chunk edge at TREE_LEVEL (~9 m spacing)

/** Cube faces: [normal, u axis, v axis] with u × v = normal (outward CCW winding). */
const FACES: [number[], number[], number[]][] = [
  [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
  [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
  [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
];

function buildIndex(): THREE.BufferAttribute {
  const idx: number[] = [];
  const S = RES + 1;
  for (let j = 0; j < RES; j++) {
    for (let i = 0; i < RES; i++) {
      const a = j * S + i, b = a + 1, c = a + S, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  // Skirts (both windings) hide cracks between neighbouring levels of detail.
  const edge = (k: number, e: number) => (e === 0 ? k : e === 1 ? RES * S + k : e === 2 ? k * S : k * S + RES);
  for (let e = 0; e < 4; e++) {
    for (let k = 0; k < RES; k++) {
      const a = edge(k, e), b = edge(k + 1, e);
      const sa = VERTS + e * S + k, sb = sa + 1;
      idx.push(a, b, sa, b, sb, sa, a, sa, b, b, sa, sb);
    }
  }
  return new THREE.BufferAttribute(new Uint16Array(idx), 1);
}

class TerrainNode {
  children: TerrainNode[] | null = null;
  mesh: THREE.Mesh | null = null;
  trees: THREE.InstancedMesh[] | null = null;
  queued = false;
  lastUsed = 0;
  readonly centerDir = new THREE.Vector3();
  readonly center = new THREE.Vector3();
  /** Approximate edge length in metres. */
  readonly size: number;
  boundRadius: number;

  constructor(readonly face: number, readonly level: number, readonly ix: number, readonly iy: number, world: World) {
    const n = 1 << level;
    faceDir(face, -1 + (2 * (ix + 0.5)) / n, -1 + (2 * (iy + 0.5)) / n, this.centerDir);
    const h = Math.max(0, world.baseElevation(this.centerDir.x, this.centerDir.y, this.centerDir.z));
    this.center.copy(this.centerDir).multiplyScalar(world.R + h);
    this.size = (Math.PI * 0.5 * world.R) / n;
    this.boundRadius = this.size * 0.9 + 120;
  }
}

function faceDir(face: number, a: number, b: number, out: THREE.Vector3): THREE.Vector3 {
  const [N, Uax, Vax] = FACES[face];
  const u = Math.tan(a * Math.PI * 0.25), v = Math.tan(b * Math.PI * 0.25);
  return out.set(N[0] + Uax[0] * u + Vax[0] * v, N[1] + Uax[1] * u + Vax[1] * v, N[2] + Uax[2] * u + Vax[2] * v).normalize();
}

export interface TerrainStats {
  chunksVisible: number;
  chunksTotal: number;
  treesVisible: number;
  queue: number;
}

/**
 * Planet surface as a cube-sphere quadtree of terrain chunks with distance
 * based level of detail, frustum & horizon culling and instanced forests.
 */
export class PlanetTerrain {
  readonly group = new THREE.Group();
  readonly stats: TerrainStats = { chunksVisible: 0, chunksTotal: 0, treesVisible: 0, queue: 0 };
  private roots: TerrainNode[] = [];
  private index = buildIndex();
  private queue: TerrainNode[] = [];
  private frame = 0;
  private frustum = new THREE.Frustum();
  private camPos = new THREE.Vector3();
  private sphere = new THREE.Sphere();
  private seed: number;
  /** Circles (unit direction + radius in metres) kept free of trees, e.g. settlements. */
  private clearings: { dir: THREE.Vector3; radius: number }[] = [];

  constructor(private world: World, private material: THREE.Material, private treeAssets: TreeAssets) {
    this.seed = hashString(world.data.seed);
    for (let f = 0; f < 6; f++) {
      const root = new TerrainNode(f, 0, 0, 0, world);
      this.build(root);
      this.roots.push(root);
    }
  }

  setClearings(list: { dir: THREE.Vector3; radius: number }[]): void {
    this.clearings = list;
  }

  /** Per-frame LOD selection. `budgetMs` bounds chunk construction time. */
  update(camera: THREE.PerspectiveCamera, budgetMs = 5): void {
    this.frame++;
    this.camPos.copy(camera.position);
    this.frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    this.stats.chunksVisible = 0;
    this.stats.treesVisible = 0;
    const camDist = this.camPos.length();
    const horizon = Math.acos(Math.min(1, this.world.R / camDist)) + Math.acos(this.world.R / (this.world.R + 480));
    const camDir = this.camPos.clone().divideScalar(camDist);
    for (const root of this.roots) this.visit(root, camDir, horizon);

    // Build the most important pending chunks within the time budget.
    if (this.queue.length) {
      this.queue.sort((a, b) => a.center.distanceToSquared(this.camPos) / (a.size * a.size) - b.center.distanceToSquared(this.camPos) / (b.size * b.size));
      const t0 = performance.now();
      let built = 0;
      while (this.queue.length && (built < 1 || performance.now() - t0 < budgetMs)) {
        const node = this.queue.shift()!;
        node.queued = false;
        if (this.frame - node.lastUsed > 3) continue; // no longer wanted
        this.build(node);
        built++;
      }
    }
    this.stats.queue = this.queue.length;
    if (this.frame % 90 === 0) for (const root of this.roots) this.prune(root);
  }

  private visit(node: TerrainNode, camDir: THREE.Vector3, horizon: number): void {
    node.lastUsed = this.frame;
    const dist = node.center.distanceTo(this.camPos);
    const angRadius = (node.size * 0.75) / this.world.R;
    const beyondHorizon = Math.acos(THREE.MathUtils.clamp(camDir.dot(node.centerDir), -1, 1)) - angRadius > horizon;
    this.sphere.center.copy(node.center);
    this.sphere.radius = node.boundRadius * 1.25;
    const inFrustum = this.frustum.intersectsSphere(this.sphere);
    const wantSplit = node.level < MAX_LEVEL && !beyondHorizon && inFrustum && dist < node.size * SPLIT_FACTOR;

    if (wantSplit) {
      if (!node.children) {
        node.children = [];
        for (let k = 0; k < 4; k++) {
          node.children.push(new TerrainNode(node.face, node.level + 1, node.ix * 2 + (k & 1), node.iy * 2 + (k >> 1), this.world));
        }
      }
      let ready = true;
      for (const c of node.children) {
        if (!c.mesh) {
          ready = false;
          c.lastUsed = this.frame;
          if (!c.queued) {
            c.queued = true;
            this.queue.push(c);
          }
        }
      }
      if (ready) {
        if (node.mesh) node.mesh.visible = false;
        this.showTrees(node, true);
        for (const c of node.children) this.visit(c, camDir, horizon);
        return;
      }
    }
    if (node.mesh) {
      node.mesh.visible = !beyondHorizon;
      if (node.mesh.visible) this.stats.chunksVisible++;
    }
    this.showTrees(node, !beyondHorizon);
    if (node.children) for (const c of node.children) this.hide(c);
  }

  private showTrees(node: TerrainNode, visible: boolean): void {
    if (!node.trees) return;
    for (const t of node.trees) {
      t.visible = visible;
      if (visible) this.stats.treesVisible += t.count;
    }
  }

  private hide(node: TerrainNode): void {
    if (node.mesh) node.mesh.visible = false;
    this.showTrees(node, false);
    if (node.children) for (const c of node.children) this.hide(c);
  }

  /** Frees subtrees that have not been needed for a while. */
  private prune(node: TerrainNode): void {
    if (!node.children) return;
    let stale = true;
    for (const c of node.children) if (this.frame - c.lastUsed < 240) stale = false;
    if (stale) {
      for (const c of node.children) this.dispose(c);
      node.children = null;
    } else {
      for (const c of node.children) this.prune(c);
    }
  }

  private dispose(node: TerrainNode): void {
    if (node.children) for (const c of node.children) this.dispose(c);
    node.children = null;
    if (node.mesh) {
      this.group.remove(node.mesh);
      node.mesh.geometry.dispose();
      node.mesh = null;
      this.stats.chunksTotal--;
    }
    if (node.trees) {
      for (const t of node.trees) {
        this.group.remove(t);
        t.dispose();
      }
      node.trees = null;
    }
  }

  private build(node: TerrainNode): void {
    const world = this.world;
    const S = RES + 1;
    const n = 1 << node.level;
    const total = VERTS + 4 * S;
    const pos = new Float32Array(total * 3);
    const nor = new Float32Array(total * 3);
    const dir = new THREE.Vector3();
    const a0 = -1 + (2 * node.ix) / n, b0 = -1 + (2 * node.iy) / n, step = 2 / n / RES;
    let maxR2 = 0;
    for (let j = 0; j < S; j++) {
      for (let i = 0; i < S; i++) {
        faceDir(node.face, a0 + i * step, b0 + j * step, dir);
        const r = world.R + world.elevationAt(dir.x, dir.y, dir.z);
        const o = (j * S + i) * 3;
        pos[o] = dir.x * r; pos[o + 1] = dir.y * r; pos[o + 2] = dir.z * r;
        nor[o] = dir.x; nor[o + 1] = dir.y; nor[o + 2] = dir.z;
        const dx = pos[o] - node.center.x, dy = pos[o + 1] - node.center.y, dz = pos[o + 2] - node.center.z;
        maxR2 = Math.max(maxR2, dx * dx + dy * dy + dz * dz);
      }
    }
    const skirt = Math.max(1.5, node.size * 0.06);
    for (let e = 0; e < 4; e++) {
      for (let k = 0; k < S; k++) {
        const src = (e === 0 ? k : e === 1 ? RES * S + k : e === 2 ? k * S : k * S + RES) * 3;
        const dst = (VERTS + e * S + k) * 3;
        const x = pos[src], y = pos[src + 1], z = pos[src + 2];
        const len = Math.sqrt(x * x + y * y + z * z);
        const f = (len - skirt) / len;
        pos[dst] = x * f; pos[dst + 1] = y * f; pos[dst + 2] = z * f;
        nor[dst] = nor[src]; nor[dst + 1] = nor[src + 1]; nor[dst + 2] = nor[src + 2];
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setIndex(this.index);
    node.boundRadius = Math.sqrt(maxR2) + skirt;
    geo.boundingSphere = new THREE.Sphere(node.center.clone(), node.boundRadius);
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.receiveShadow = true;
    mesh.castShadow = node.level >= 5;
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    node.mesh = mesh;
    this.group.add(mesh);
    this.stats.chunksTotal++;
    if (node.level === TREE_LEVEL) this.plantTrees(node);
  }

  /** Deterministically scatters trees over a chunk according to the forest cover field. */
  private plantTrees(node: TerrainNode): void {
    const world = this.world, d = world.data;
    const n = 1 << node.level;
    const a0 = -1 + (2 * node.ix) / n, b0 = -1 + (2 * node.iy) / n, cell = 2 / n / TREE_GRID;
    const gx0 = node.ix * TREE_GRID, gy0 = node.iy * TREE_GRID;
    const lists: number[][] = [];
    for (let k = 0; k < TREE_KIND_COUNT; k++) lists.push([]);
    const dir = new THREE.Vector3();
    const seed = this.seed + node.face * 7919;
    for (let j = 0; j < TREE_GRID; j++) {
      for (let i = 0; i < TREE_GRID; i++) {
        const gx = gx0 + i, gy = gy0 + j;
        const r0 = hash2(gx, gy, seed);
        faceDir(node.face, a0 + (i + hash2(gx, gy, seed + 1)) * cell, b0 + (j + hash2(gx, gy, seed + 2)) * cell, dir);
        const c = world.cellAt(dir.x, dir.y, dir.z);
        const cover = d.forest[c] / 255;
        if (r0 >= cover * 0.95 || d.waterMask[c] > 60) continue;
        const h = world.elevationAt(dir.x, dir.y, dir.z);
        if (h < 1.3) continue;
        let cleared = false;
        for (const cl of this.clearings) {
          if (cl.dir.angleTo(dir) * world.R < cl.radius) { cleared = true; break; }
        }
        if (cleared) continue;
        const t = d.temperature[c], b = d.biome[c];
        const r1 = hash2(gx, gy, seed + 3);
        let kind: TreeKind;
        if (b === Biome.Taiga || b === Biome.Tundra || t < 5 || h > 150) kind = TreeKind.Conifer;
        else if (b === Biome.Rainforest) kind = r1 < 0.8 ? TreeKind.Jungle : TreeKind.Palm;
        else if (b === Biome.Savanna) kind = TreeKind.Acacia;
        else if (t > 20) kind = h < 6 && d.oceanDist[c] < 6 ? TreeKind.Palm : r1 < 0.5 ? TreeKind.Jungle : TreeKind.Broadleaf;
        else kind = r1 < (t < 9 ? 0.55 : 0.14) ? TreeKind.Conifer : TreeKind.Broadleaf;
        const scale = 0.75 + hash2(gx, gy, seed + 4) * 0.7;
        lists[kind].push(dir.x, dir.y, dir.z, world.R + h - 0.15, scale, hash2(gx, gy, seed + 5));
      }
    }
    const trees: THREE.InstancedMesh[] = [];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), qYaw = new THREE.Quaternion();
    const up = new THREE.Vector3(), p = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();
    const Y = new THREE.Vector3(0, 1, 0);
    for (let k = 0; k < TREE_KIND_COUNT; k++) {
      const list = lists[k];
      const count = list.length / 6;
      if (!count) continue;
      const inst = new THREE.InstancedMesh(this.treeAssets.geometries[k], this.treeAssets.materials[k], count);
      for (let i = 0; i < count; i++) {
        const o = i * 6;
        up.set(list[o], list[o + 1], list[o + 2]);
        p.copy(up).multiplyScalar(list[o + 3]);
        q.setFromUnitVectors(Y, up);
        qYaw.setFromAxisAngle(Y, list[o + 5] * Math.PI * 2);
        q.multiply(qYaw);
        const sc = list[o + 4];
        s.set(sc * (0.9 + list[o + 5] * 0.25), sc, sc * (0.9 + list[o + 5] * 0.25));
        m.compose(p, q, s);
        inst.setMatrixAt(i, m);
        const v = 0.78 + list[o + 5] * 0.5;
        col.setRGB(v * (0.92 + sc * 0.1), v, v * (0.85 + list[o + 5] * 0.25));
        inst.setColorAt(i, col);
      }
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.matrixAutoUpdate = false;
      inst.boundingSphere = new THREE.Sphere(node.center.clone(), node.boundRadius + 14);
      inst.visible = false;
      this.group.add(inst);
      trees.push(inst);
    }
    node.trees = trees;
  }

  /** Rebuilds all vegetation (after clearings changed). */
  refreshTrees(): void {
    const walk = (node: TerrainNode) => {
      if (node.level === TREE_LEVEL && node.mesh) {
        if (node.trees) for (const t of node.trees) { this.group.remove(t); t.dispose(); }
        this.plantTrees(node);
      }
      if (node.children) for (const c of node.children) walk(c);
    };
    for (const r of this.roots) walk(r);
  }

  disposeAll(): void {
    for (const r of this.roots) this.dispose(r);
    this.roots = [];
  }
}
