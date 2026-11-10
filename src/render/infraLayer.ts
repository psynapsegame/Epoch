import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { patchMaterial } from './shared';
import type { World } from '../world/world';

/** A road or a wall as the simulation built it, placed on the planet. */
export interface InfraItem {
  id: number;
  kind: 'road' | 'wall';
  settlement: number;
  /** 0..1: how far the builders have come. */
  progress: number;
  /** Roads: neighbour the highway leads to, or -1 for a street. Walls: 1 stone, 0 palisade. */
  res: number;
  /** Unit directions [x, y, z, …]: the road's polyline, or the centres of the wall's pieces. */
  points: Float32Array;
  /** Walls: unit directions of the gates. */
  gates: Float32Array;
  /** Unit direction of the settlement's square. */
  centre: { x: number; y: number; z: number };
}

const DRAW_DISTANCE = 3400;
const GATE_SPAN = 7.2;

function tinted(geo: THREE.BufferGeometry, hex: number, jitter = 0.08, seed = 1): THREE.BufferGeometry {
  const n = geo.getAttribute('position').count;
  const col = new Float32Array(n * 3), c = new THREE.Color(hex);
  const k = 1 + (((Math.sin(seed * 12.9898) * 43758.5453) % 1) - 0.5) * 2 * jitter;
  for (let i = 0; i < n; i++) { col[i * 3] = c.r * k; col[i * 3 + 1] = c.g * k; col[i * 3 + 2] = c.b * k; }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** Three metres of palisade: sharpened stakes side by side. */
function palisadePiece(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 6; i++) {
    const h = 4.3 + ((i * 7) % 5) * 0.09, x = -1.3 + i * 0.52;
    parts.push(tinted(new THREE.CylinderGeometry(0.25, 0.28, h, 6).translate(x, h / 2 - 1.3, 0), 0x6b4a2e, 0.14, i + 1));
    parts.push(tinted(new THREE.ConeGeometry(0.25, 0.5, 6).translate(x, h - 1.3 + 0.25, 0), 0x8a6a44, 0.1, i + 9));
  }
  parts.push(tinted(new THREE.BoxGeometry(3.1, 0.16, 0.12).translate(0, 1.9, -0.3), 0x4f3620)); // inner rail
  return mergeGeometries(parts)!;
}

/** Three metres of stone curtain wall with its battlements. */
function stonePiece(): THREE.BufferGeometry {
  const parts = [tinted(new THREE.BoxGeometry(3.06, 4.7, 1.1).translate(0, 1.05, 0), 0x8f8b82, 0.06, 3)];
  for (const x of [-1.0, 0.55]) parts.push(tinted(new THREE.BoxGeometry(0.95, 0.6, 0.45).translate(x, 3.7, 0.33), 0xa29d92, 0.06, x + 5));
  parts.push(tinted(new THREE.BoxGeometry(3.06, 0.14, 1.3).translate(0, 3.4, 0), 0x77736b));
  return mergeGeometries(parts)!;
}

function palisadeGate(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) parts.push(tinted(new THREE.CylinderGeometry(0.42, 0.46, 6.6, 8).translate((s * GATE_SPAN) / 2, 2.0, 0), 0x5a3d24, 0.1, s + 2));
  parts.push(tinted(new THREE.BoxGeometry(GATE_SPAN + 1.2, 0.45, 0.6).translate(0, 4.7, 0), 0x6b4a2e));
  parts.push(tinted(new THREE.BoxGeometry(GATE_SPAN + 0.4, 0.3, 0.45).translate(0, 4.15, 0), 0x4f3620));
  return mergeGeometries(parts)!;
}

function stoneGate(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    const x = (s * GATE_SPAN) / 2;
    parts.push(tinted(new THREE.BoxGeometry(2.3, 8.2, 2.3).translate(x, 2.8, 0), 0x8a867d, 0.06, s + 2));
    parts.push(tinted(new THREE.ConeGeometry(2.0, 2.2, 4).rotateY(Math.PI / 4).translate(x, 8.0, 0), 0x6e4a3a));
  }
  parts.push(tinted(new THREE.BoxGeometry(GATE_SPAN - 2, 1.5, 1.2).translate(0, 4.3, 0), 0x97938a));
  return mergeGeometries(parts)!;
}

interface Cluster { group: THREE.Group; centre: THREE.Vector3; signature: string }

/**
 * Draws the roads and the walls the inhabitants built: roads as ribbons laid
 * on the ground up to where the builders have come, walls piece by piece.
 */
export class InfraLayer {
  readonly group = new THREE.Group();
  readonly materials: THREE.MeshStandardMaterial[];
  private road: THREE.MeshStandardMaterial;
  private solid: THREE.MeshStandardMaterial;
  private clusters = new Map<number, Cluster>();
  private pieces = { palisade: palisadePiece(), stone: stonePiece(), palisadeGate: palisadeGate(), stoneGate: stoneGate() };
  private ids = '';

  constructor() {
    this.road = patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
    this.solid = patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 }));
    this.materials = [this.road, this.solid];
  }

  /** Forces a full rebuild (the ground moved). */
  invalidate(): void {
    for (const c of this.clusters.values()) c.signature = '';
    this.ids = '';
  }

  /** Mirrors the simulation. Returns true when the set of works changed (not just their progress). */
  sync(world: World, items: InfraItem[]): boolean {
    const bySettlement = new Map<number, InfraItem[]>();
    for (const it of items) {
      if (!bySettlement.has(it.settlement)) bySettlement.set(it.settlement, []);
      bySettlement.get(it.settlement)!.push(it);
    }
    for (const [id, c] of this.clusters) {
      if (bySettlement.has(id)) continue;
      this.dispose(c);
      this.group.remove(c.group);
      this.clusters.delete(id);
    }
    for (const [id, list] of bySettlement) {
      const signature = list.map((it) => `${it.id}:${Math.round(it.progress * 60)}:${it.res}`).join(',');
      let c = this.clusters.get(id);
      if (!c) {
        c = { group: new THREE.Group(), centre: new THREE.Vector3(list[0].centre.x, list[0].centre.y, list[0].centre.z).multiplyScalar(world.R), signature: '' };
        this.clusters.set(id, c);
        this.group.add(c.group);
      }
      if (c.signature === signature) continue;
      c.signature = signature;
      this.dispose(c);
      for (const it of list) {
        if (it.kind === 'road') this.buildRoad(world, c.group, it);
        else this.buildWall(world, c.group, it);
      }
    }
    const ids = items.map((it) => it.id).join(',');
    const changed = ids !== this.ids;
    this.ids = ids;
    return changed;
  }

  private dispose(c: Cluster): void {
    for (const m of [...c.group.children]) {
      const mesh = m as THREE.Mesh;
      if (mesh.userData.own) mesh.geometry.dispose();
      (mesh as unknown as THREE.InstancedMesh).dispose?.();
      c.group.remove(m);
    }
  }

  private buildRoad(world: World, group: THREE.Group, it: InfraItem): void {
    if (it.progress <= 0.01 || it.points.length < 6) return;
    const R = world.R;
    // smooth the walked line (corner cutting), then lay a sample every metre and a half
    let pts: THREE.Vector3[] = [];
    for (let i = 0; i < it.points.length; i += 3) pts.push(new THREE.Vector3(it.points[i], it.points[i + 1], it.points[i + 2]));
    for (let pass = 0; pass < 2; pass++) {
      const next = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        next.push(pts[i].clone().lerp(pts[i + 1], 0.25).normalize(), pts[i].clone().lerp(pts[i + 1], 0.75).normalize());
      }
      next.push(pts[pts.length - 1]);
      pts = next;
    }
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += pts[i].distanceTo(pts[i - 1]) * R;
    const upTo = total * Math.min(1, it.progress);
    const samples: THREE.Vector3[] = [];
    let walked = 0;
    for (let i = 1; i < pts.length && walked < upTo; i++) {
      const d = pts[i].distanceTo(pts[i - 1]) * R, steps = Math.max(1, Math.ceil(d / 1.5));
      for (let s = i === 1 ? 0 : 1; s <= steps; s++) {
        if (walked + (d * s) / steps > upTo + 1e-6) break;
        samples.push(pts[i - 1].clone().lerp(pts[i], s / steps).normalize());
      }
      walked += d;
    }
    if (samples.length < 2) return;
    const half = (it.res >= 0 ? 4.2 : 3.0) / 2;
    const pos = new Float32Array(samples.length * 9), nor = new Float32Array(samples.length * 9), col = new Float32Array(samples.length * 9);
    const side = new THREE.Vector3(), tan = new THREE.Vector3(), p = new THREE.Vector3();
    const dirt = new THREE.Color(it.res >= 0 ? 0x9a8463 : 0x8b7354), edge = new THREE.Color(0x6f6146);
    samples.forEach((c, i) => {
      tan.copy(samples[Math.min(samples.length - 1, i + 1)]).sub(samples[Math.max(0, i - 1)]);
      side.crossVectors(c, tan).normalize();
      const wobble = 1 + 0.12 * Math.sin(i * 1.7 + it.id);
      for (let k = 0; k < 3; k++) {
        p.copy(c).multiplyScalar(R).addScaledVector(side, (k - 1) * half * wobble).normalize();
        const h = Math.max(0.05, world.elevationAt(p.x, p.y, p.z)) + (k === 1 ? 0.2 : 0.11);
        const o = (i * 3 + k) * 3;
        pos[o] = p.x * (R + h); pos[o + 1] = p.y * (R + h); pos[o + 2] = p.z * (R + h);
        nor[o] = c.x; nor[o + 1] = c.y; nor[o + 2] = c.z;
        const shade = 0.92 + 0.16 * (((Math.sin(i * 12.9898 + k * 78.233 + it.id) * 43758.5453) % 1 + 1) % 1);
        const cc = k === 1 ? dirt : edge;
        col[o] = cc.r * shade; col[o + 1] = cc.g * shade; col[o + 2] = cc.b * shade;
      }
    });
    const index: number[] = [];
    for (let i = 0; i < samples.length - 1; i++) {
      for (let k = 0; k < 2; k++) {
        const a = i * 3 + k, b = a + 1, c = a + 3, d = a + 4;
        index.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(index);
    const mesh = new THREE.Mesh(geo, this.road);
    mesh.receiveShadow = true;
    mesh.userData.own = true;
    mesh.renderOrder = 1;
    group.add(mesh);
  }

  private buildWall(world: World, group: THREE.Group, it: InfraItem): void {
    const n = it.points.length / 3, raised = Math.floor(n * Math.min(1, it.progress) + 1e-6);
    const stone = it.res === 1;
    const centre = new THREE.Vector3(it.centre.x, it.centre.y, it.centre.z);
    const m = new THREE.Matrix4(), up = new THREE.Vector3(), out = new THREE.Vector3(), tan = new THREE.Vector3(), p = new THREE.Vector3();
    const place = (src: Float32Array, i: number) => {
      up.set(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]);
      out.copy(up).sub(centre);
      out.addScaledVector(up, -out.dot(up)).normalize();
      tan.crossVectors(up, out).normalize();
      p.copy(up).multiplyScalar(world.R + Math.max(0.05, world.elevationAt(up.x, up.y, up.z)));
      m.makeBasis(tan, up, out).setPosition(p);
    };
    if (raised > 0) {
      const mesh = new THREE.InstancedMesh(stone ? this.pieces.stone : this.pieces.palisade, this.solid, raised);
      for (let i = 0; i < raised; i++) { place(it.points, i); mesh.setMatrixAt(i, m); }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
    // a gate stands once the wall has come round to it
    const gates = it.gates.length / 3, open = Math.floor(gates * Math.min(1, it.progress) + 1e-6);
    if (open > 0) {
      const mesh = new THREE.InstancedMesh(stone ? this.pieces.stoneGate : this.pieces.palisadeGate, this.solid, open);
      for (let i = 0; i < open; i++) { place(it.gates, i); mesh.setMatrixAt(i, m); }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
  }

  /** Shows only the works of the settlements near enough to be seen. */
  update(camera: THREE.Vector3): void {
    for (const c of this.clusters.values()) c.group.visible = c.centre.distanceTo(camera) < DRAW_DISTANCE;
  }
}
