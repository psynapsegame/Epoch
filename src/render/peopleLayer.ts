import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SECONDS_PER_YEAR } from '../sim/clock';
import { siteFrame } from '../sim/sites';
import type { Settlement } from '../sim/settlements';
import { Activity, J, type RosterEntry, type Snapshot } from '../sim/types';
import type { World } from '../world/world';
import { patchMaterial } from './shared';

const SKIN = [0xf1d3b8, 0xe2b48f, 0xc99873, 0xa97752, 0x7f5639, 0x5b3c27];
const HAIR = [0x1c1612, 0x3b2616, 0x6b4423, 0xa8743a, 0xd8b56a, 0x8f8f8f];
const TUNIC = [0x8a3b2e, 0x2f5d73, 0x56703a, 0xb08a3c, 0x6d4a7a, 0x9a9484, 0x3f4f5f, 0xa5623a, 0x4f7f72, 0x7a2f4a];
/** Inhabitants are drawn slightly larger than life so they stay readable on a phone screen. */
const SCALE = 1.25;

function tagged(geo: THREE.BufferGeometry, part: number, side: number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('uv');
  const n = g.getAttribute('position').count;
  g.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(n).fill(part), 1));
  g.setAttribute('aSide', new THREE.BufferAttribute(new Float32Array(n).fill(side), 1));
  return g;
}

/** Low-poly villager (~150 triangles). Parts: 0 tunic, 1 skin, 2 hair, 3 legs, 4 arms. */
function personGeometry(): THREE.BufferGeometry {
  const parts = [
    tagged(new THREE.BoxGeometry(0.15, 0.82, 0.17).translate(-0.1, 0.41, 0), 3, -1),
    tagged(new THREE.BoxGeometry(0.15, 0.82, 0.17).translate(0.1, 0.41, 0), 3, 1),
    tagged(new THREE.CylinderGeometry(0.2, 0.29, 0.72, 7).translate(0, 1.08, 0), 0, 0),
    tagged(new THREE.BoxGeometry(0.11, 0.58, 0.13).translate(-0.3, 1.1, 0), 4, -1),
    tagged(new THREE.BoxGeometry(0.11, 0.58, 0.13).translate(0.3, 1.1, 0), 4, 1),
    tagged(new THREE.IcosahedronGeometry(0.165, 1).translate(0, 1.6, 0), 1, 0),
    tagged(new THREE.SphereGeometry(0.185, 7, 4, 0, Math.PI * 2, 0, Math.PI * 0.55).translate(0, 1.615, -0.02), 2, 0),
    // spear and round shield, shown only on people under arms (part 5)
    tagged(new THREE.BoxGeometry(0.045, 2.2, 0.045).translate(0.4, 1.25, 0.1), 5, 0),
    tagged(new THREE.ConeGeometry(0.07, 0.28, 4).translate(0.4, 2.48, 0.1), 5, 0),
    tagged(new THREE.CylinderGeometry(0.3, 0.3, 0.05, 8).rotateX(Math.PI / 2).translate(-0.34, 1.12, 0.14), 5, 0),
  ];
  return mergeGeometries(parts)!;
}

interface Shown {
  e: number;
  n: number;
  heading: number;
  site: number;
  phase: number;
}

/**
 * Draws the inhabitants as one instanced mesh. Positions come from simulation
 * snapshots and are smoothed between ticks; walking and working poses are
 * animated in the vertex shader. The number drawn is capped by the quality tier.
 */
export class PeopleLayer {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  private mesh: THREE.InstancedMesh;
  private capacity: number;
  private skin: THREE.InstancedBufferAttribute;
  private hair: THREE.InstancedBufferAttribute;
  private tunic: THREE.InstancedBufferAttribute;
  private anim: THREE.InstancedBufferAttribute;
  private gear: THREE.InstancedBufferAttribute;
  private shown = new Map<number, Shown>();
  private frames = new Map<number, ReturnType<typeof siteFrame>>();
  private ring: THREE.Mesh;
  /** Ids and world positions of the people drawn this frame (for picking). */
  private drawnIds: number[] = [];
  private drawnPos: THREE.Vector3[] = [];
  selected = 0;
  /** World position of the selected person (valid when selectedVisible). */
  readonly selectedPos = new THREE.Vector3();
  selectedKnown = false;
  drawn = 0;

  constructor(capacity = 600) {
    this.capacity = capacity;
    const geo = personGeometry();
    this.skin = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.hair = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.tunic = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.anim = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.gear = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    for (const a of [this.skin, this.hair, this.tunic, this.anim, this.gear]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aSkin', this.skin);
    geo.setAttribute('aHair', this.hair);
    geo.setAttribute('aTunic', this.tunic);
    geo.setAttribute('aAnim', this.anim);
    geo.setAttribute('aGear', this.gear);
    this.material = patchMaterial(new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 }), {
      vertexPars: /* glsl */ `
        attribute float aPart; attribute float aSide;
        attribute vec3 aSkin; attribute vec3 aHair; attribute vec3 aTunic;
        attribute vec4 aAnim; // x: walking 0..1, y: phase offset, z: bend 0..1, w: skirt 0..1
        attribute float aGear; // 1 = armed
        varying vec3 vPersonCol;
        vec3 rotX(vec3 p, float a, float pivotY) {
          float c = cos(a), s = sin(a);
          p.y -= pivotY;
          p = vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c);
          p.y += pivotY;
          return p;
        }`,
      vertexTransform: /* glsl */ `
        {
          float ph = uTime * 9.0 + aAnim.y;
          float swing = sin(ph) * 0.75 * aAnim.x;
          float work = aAnim.z * (0.75 + 0.2 * sin(uTime * 2.4 + aAnim.y));
          if (aPart > 4.5) {
            // weapons collapse to nothing on civilians
            transformed = mix(vec3(0.0, 1.0, 0.0), transformed, aGear);
          } else if (aPart > 2.5 && aPart < 3.5) {
            transformed = rotX(transformed, swing * aSide, 0.82);
          } else {
            // skirt-like flare of the tunic
            if (aPart < 0.5) transformed.xz *= 1.0 + aAnim.w * 0.55 * clamp((1.44 - transformed.y) / 0.72, 0.0, 1.0);
            if (aPart > 3.5) transformed = rotX(transformed, -swing * aSide * 0.8 - work * 0.9, 1.36);
            transformed = rotX(transformed, work * 0.85, 0.82);
          }
          transformed.y += abs(sin(ph)) * 0.035 * aAnim.x;
          vPersonCol = aPart < 0.5 ? aTunic : aPart < 1.5 ? aSkin : aPart < 2.5 ? aHair : aPart < 3.5 ? aTunic * 0.35 + vec3(0.03, 0.025, 0.02) : aPart < 4.5 ? mix(aTunic, aSkin, 0.25) : mix(vec3(0.22, 0.17, 0.12), aTunic, 0.45);
        }`,
      fragPars: `varying vec3 vPersonCol;`,
      fragColor: `diffuseColor.rgb = vPersonCol;`,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.material, capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.matrixAutoUpdate = false;
    this.group.add(this.mesh);

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.75, 1.0, 28).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffd98a, transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide }),
    );
    this.ring.renderOrder = 5;
    this.ring.visible = false;
    this.group.add(this.ring);
  }

  setSettlements(list: Settlement[]): void {
    this.frames.clear();
    for (const s of list) this.frames.set(s.id, siteFrame(s));
    this.shown.clear();
    this.mesh.count = 0;
    this.drawn = 0;
  }

  /** Limits how many inhabitants are drawn (quality tier). */
  setBudget(n: number): void {
    this.budget = Math.min(this.capacity, n);
  }
  private budget = 600;

  /**
   * @param simRate simulated seconds per real second (drives smoothing)
   */
  update(world: World, snap: Snapshot | null, roster: Map<number, RosterEntry>, camPos: THREE.Vector3, dt: number, simRate: number): void {
    this.drawnIds.length = 0;
    this.selectedKnown = false;
    if (!snap || !this.frames.size) {
      this.mesh.count = 0;
      this.drawn = 0;
      this.ring.visible = false;
      return;
    }
    const k = 1 - Math.exp(-dt * (simRate > 1000 ? 14 : 6));
    const dir = { x: 0, y: 0, z: 0 };
    const m = new THREE.Matrix4(), X = new THREE.Vector3(), Yv = new THREE.Vector3(), Z = new THREE.Vector3(), P = new THREE.Vector3();
    const col = new THREE.Color();
    const R = world.R;
    let w = 0;
    const seen = this.seen;
    seen.clear();
    for (let i = 0; i < snap.count; i++) {
      const id = snap.ids[i];
      seen.add(id);
      const te = snap.pos[i * 2], tn = snap.pos[i * 2 + 1];
      const flags = snap.flags[i];
      let s = this.shown.get(id);
      if (!s || s.site !== snap.site[i]) {
        s = { e: te, n: tn, heading: (id * 2.39996) % 6.283, site: snap.site[i], phase: (id * 1.618) % 6.283 };
        this.shown.set(id, s);
      }
      const de = te - s.e, dn = tn - s.n;
      const d2 = de * de + dn * dn;
      if (d2 > 900 && simRate > 1000) { s.e = te; s.n = tn; } // teleport-sized jumps (very high speeds) are not animated
      else { s.e += de * k; s.n += dn * k; }
      const moving = d2 > 0.02;
      if (moving) {
        const target = Math.atan2(de, dn);
        let dh = target - s.heading;
        while (dh > Math.PI) dh -= 2 * Math.PI;
        while (dh < -Math.PI) dh += 2 * Math.PI;
        s.heading += dh * Math.min(1, dt * 8);
      }
      const inside = (flags & 128) !== 0 && d2 < 4;
      const isSelected = id === this.selected;
      if (inside && !isSelected) continue;
      const frame = this.frames.get(s.site);
      const r = roster.get(id);
      if (!frame || !r) continue;
      frame.toDir(s.e, s.n, R, dir);
      const h = world.elevationAt(dir.x, dir.y, dir.z);
      P.set(dir.x, dir.y, dir.z).multiplyScalar(R + Math.max(h, 0.2));
      if (isSelected) {
        this.selectedPos.copy(P);
        this.selectedKnown = true;
        if (inside) continue;
      }
      if (w >= this.budget || P.distanceToSquared(camPos) > 1400 * 1400) continue;
      // local frame: Y = up, Z = walking direction
      Yv.set(dir.x, dir.y, dir.z);
      frame.toDir(s.e + Math.sin(s.heading) * 2, s.n + Math.cos(s.heading) * 2, R, dir);
      Z.set(dir.x, dir.y, dir.z).sub(Yv).normalize();
      X.crossVectors(Yv, Z).normalize();
      Z.crossVectors(X, Yv).normalize();
      const age = (snap.time - r.birth) / SECONDS_PER_YEAR;
      const grow = age < 16 ? 0.45 + 0.55 * (age / 16) : 1;
      const sc = SCALE * r.look.height * grow;
      m.makeBasis(X, Yv, Z).scale(X.set(sc * (r.sex === 0 ? 0.92 : 1), sc, sc)).setPosition(P);
      this.mesh.setMatrixAt(w, m);
      col.setHex(SKIN[r.look.skin] ?? SKIN[2]);
      this.skin.setXYZ(w, col.r, col.g, col.b);
      col.setHex(age > 58 ? 0xb9b9b4 : HAIR[r.look.hair] ?? HAIR[1]);
      this.hair.setXYZ(w, col.r, col.g, col.b);
      col.setHex(TUNIC[r.look.tunic] ?? TUNIC[0]);
      this.tunic.setXYZ(w, col.r, col.g, col.b);
      const act = flags & 15;
      const fighting = act === Activity.Fighting && !moving;
      const working = fighting ? 0.55 : !moving && (flags & 64) === 0 && act === Activity.Foraging ? 1 : 0;
      this.gear.setX(w, r.job === J.Soldier || act === Activity.Fighting ? 1 : 0);
      this.anim.setXYZW(w, moving ? 1 : 0, s.phase, working, r.sex === 0 ? 1 : 0);
      this.drawnIds.push(id);
      (this.drawnPos[w] ??= new THREE.Vector3()).copy(P);
      w++;
    }
    // forget people who left the snapshot
    if (this.shown.size > snap.count) for (const id of this.shown.keys()) if (!seen.has(id)) this.shown.delete(id);
    this.mesh.count = w;
    this.drawn = w;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.skin.needsUpdate = this.hair.needsUpdate = this.tunic.needsUpdate = this.anim.needsUpdate = this.gear.needsUpdate = true;

    this.ring.visible = this.selectedKnown;
    if (this.selectedKnown) {
      Yv.copy(this.selectedPos).normalize();
      this.ring.quaternion.setFromUnitVectors(UP, Yv);
      this.ring.position.copy(this.selectedPos).addScaledVector(Yv, 0.25);
      const pulse = 1 + 0.08 * Math.sin(performance.now() * 0.006);
      this.ring.scale.setScalar(pulse * Math.max(1, this.selectedPos.distanceTo(camPos) / 60));
    }
  }
  private seen = new Set<number>();

  /** Person under a screen position, within `radiusPx` (people are small: generous touch radius). */
  pick(camera: THREE.Camera, rect: DOMRect, clientX: number, clientY: number, radiusPx: number): number {
    let best = 0, bestD = radiusPx * radiusPx;
    const v = new THREE.Vector3(), up = new THREE.Vector3();
    for (let i = 0; i < this.drawnIds.length; i++) {
      up.copy(this.drawnPos[i]).normalize();
      v.copy(this.drawnPos[i]).addScaledVector(up, 1).project(camera); // aim at the chest, not the feet
      if (v.z > 1 || v.z < -1) continue;
      const sx = rect.left + (v.x * 0.5 + 0.5) * rect.width, sy = rect.top + (-v.y * 0.5 + 0.5) * rect.height;
      const d = (sx - clientX) * (sx - clientX) + (sy - clientY) * (sy - clientY);
      if (d < bestD) { bestD = d; best = this.drawnIds[i]; }
    }
    return best;
  }
}

const UP = new THREE.Vector3(0, 1, 0);
