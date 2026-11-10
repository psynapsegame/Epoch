import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { patchMaterial, U } from '../shared';

export enum TreeKind {
  Conifer = 0,
  Broadleaf = 1,
  Jungle = 2,
  Acacia = 3,
  Palm = 4,
}
export const TREE_KIND_COUNT = 5;

type RGB = [number, number, number];

/** Prepares a primitive: non-indexed, vertex colours with a vertical gradient, leaf flag. */
function part(geo: THREE.BufferGeometry, bottom: RGB, top: RGB, leaf: number, blobNormals = false): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('uv');
  const pos = g.getAttribute('position');
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  const n = pos.count;
  const col = new Float32Array(n * 3);
  const lf = new Float32Array(n).fill(leaf);
  const c = new THREE.Vector3();
  bb.getCenter(c);
  const nor = g.getAttribute('normal');
  for (let i = 0; i < n; i++) {
    const t = (pos.getY(i) - bb.min.y) / Math.max(1e-5, bb.max.y - bb.min.y);
    for (let k = 0; k < 3; k++) col[i * 3 + k] = bottom[k] + (top[k] - bottom[k]) * t;
    if (blobNormals) {
      const v = new THREE.Vector3(pos.getX(i) - c.x, pos.getY(i) - c.y + (bb.max.y - bb.min.y) * 0.25, pos.getZ(i) - c.z).normalize();
      nor.setXYZ(i, v.x, v.y, v.z);
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aLeaf', new THREE.BufferAttribute(lf, 1));
  return g;
}

function blob(r: number, x: number, y: number, z: number, sy: number, seed: number, detail = 0): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
    const k = 1 + 0.16 * Math.sin(vx * 3.1 + seed) * Math.cos(vz * 2.7 + seed * 1.7) + 0.08 * Math.sin(vy * 5 + seed);
    p.setXYZ(i, vx * k + x, vy * k * sy + y, vz * k + z);
  }
  return g;
}

const BARK: RGB = [0.16, 0.10, 0.06];
const BARK_TOP: RGB = [0.22, 0.15, 0.09];

function conifer(): THREE.BufferGeometry {
  const parts = [part(new THREE.CylinderGeometry(0.16, 0.3, 2.4, 5).translate(0, 1.2, 0), BARK, BARK_TOP, 0)];
  const tiers = 4;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const rad = 2.1 * (1 - t * 0.68);
    const hgt = 3.1 - t * 0.6;
    const y = 1.5 + i * 1.75;
    const cone = new THREE.ConeGeometry(rad, hgt, 7, 1, true).rotateY(i * 0.7).translate(0, y + hgt / 2, 0);
    parts.push(part(cone, [0.035, 0.11, 0.06], [0.10, 0.24, 0.11], 1));
  }
  return mergeGeometries(parts)!;
}

function broadleaf(): THREE.BufferGeometry {
  const parts = [part(new THREE.CylinderGeometry(0.2, 0.36, 3.4, 5).translate(0, 1.7, 0), BARK, BARK_TOP, 0)];
  const lo: RGB = [0.06, 0.17, 0.035], hi: RGB = [0.20, 0.40, 0.09];
  parts.push(part(blob(2.3, 0, 5.2, 0, 0.85, 1, 1), lo, hi, 1, true));
  parts.push(part(blob(1.6, 1.4, 4.3, 0.5, 0.8, 2), lo, hi, 1, true));
  parts.push(part(blob(1.5, -1.2, 4.5, -0.7, 0.8, 3), lo, hi, 1, true));
  parts.push(part(blob(1.3, 0.2, 6.6, -0.3, 0.8, 4), lo, hi, 1, true));
  return mergeGeometries(parts)!;
}

function jungle(): THREE.BufferGeometry {
  const parts = [part(new THREE.CylinderGeometry(0.22, 0.5, 8.5, 5).translate(0, 4.25, 0), [0.14, 0.11, 0.08], [0.24, 0.2, 0.14], 0)];
  const lo: RGB = [0.025, 0.14, 0.04], hi: RGB = [0.11, 0.36, 0.08];
  parts.push(part(blob(3.4, 0, 9.4, 0, 0.5, 5, 1), lo, hi, 1, true));
  parts.push(part(blob(2.3, 2.2, 8.3, 1, 0.5, 6), lo, hi, 1, true));
  parts.push(part(blob(2.2, -2, 8.6, -1.2, 0.5, 7), lo, hi, 1, true));
  parts.push(part(blob(1.5, 0.5, 5.4, -0.8, 0.55, 8), lo, hi, 1, true));
  return mergeGeometries(parts)!;
}

function acacia(): THREE.BufferGeometry {
  const parts = [
    part(new THREE.CylinderGeometry(0.14, 0.26, 3.6, 5).rotateZ(0.12).translate(0.2, 1.8, 0), BARK, BARK_TOP, 0),
    part(new THREE.CylinderGeometry(0.09, 0.13, 2.2, 4).rotateZ(-0.7).translate(1.0, 3.9, 0), BARK_TOP, BARK_TOP, 0),
    part(new THREE.CylinderGeometry(0.09, 0.13, 2.0, 4).rotateZ(0.75).translate(-0.5, 3.9, 0.2), BARK_TOP, BARK_TOP, 0),
  ];
  const lo: RGB = [0.12, 0.2, 0.05], hi: RGB = [0.3, 0.4, 0.11];
  parts.push(part(blob(2.7, 0.3, 5.0, 0, 0.26, 9, 1), lo, hi, 1, true));
  parts.push(part(blob(1.7, 1.9, 4.7, 0.6, 0.26, 10), lo, hi, 1, true));
  parts.push(part(blob(1.6, -1.5, 4.8, -0.5, 0.26, 11), lo, hi, 1, true));
  return mergeGeometries(parts)!;
}

function palm(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // gently curved trunk
  const segs = 5;
  for (let i = 0; i < segs; i++) {
    const t = i / segs;
    const bend = t * t * 1.3;
    parts.push(part(
      new THREE.CylinderGeometry(0.17 - t * 0.05, 0.2 - t * 0.05, 1.5, 5).rotateZ(-t * 0.35).translate(bend, 0.72 + i * 1.4, 0),
      [0.3, 0.22, 0.13], [0.38, 0.29, 0.18], 0));
  }
  const topX = 1.3 + 0.2, topY = segs * 1.4 + 0.1;
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    // frond: a drooping, tapered strip
    const frond = new THREE.PlaneGeometry(0.9, 3.4, 1, 3);
    const p = frond.getAttribute('position');
    for (let k = 0; k < p.count; k++) {
      const y = p.getY(k) + 1.7; // 0..3.4 along the frond
      const t = y / 3.4;
      p.setXYZ(k, p.getX(k) * (1 - t * 0.85), 0.5 * Math.sin(t * 2.4) - t * t * 1.5, y);
    }
    frond.computeVertexNormals();
    frond.rotateY(a).translate(topX, topY, 0);
    const g = part(frond, [0.1, 0.3, 0.08], [0.2, 0.42, 0.1], 1);
    // double-sided strip: add flipped copy
    const back = g.clone();
    const bp = back.getAttribute('position'), bn = back.getAttribute('normal');
    for (let k = 0; k < bp.count; k += 3) {
      const ax = bp.getX(k + 1), ay = bp.getY(k + 1), az = bp.getZ(k + 1);
      bp.setXYZ(k + 1, bp.getX(k + 2), bp.getY(k + 2), bp.getZ(k + 2));
      bp.setXYZ(k + 2, ax, ay, az);
    }
    for (let k = 0; k < bn.count; k++) bn.setXYZ(k, -bn.getX(k), -bn.getY(k), -bn.getZ(k));
    parts.push(g, back);
  }
  return mergeGeometries(parts)!;
}

export interface TreeAssets {
  geometries: THREE.BufferGeometry[];
  materials: THREE.MeshStandardMaterial[];
}

/** Builds the tree model library (one geometry + material per species). */
export function createTreeAssets(): TreeAssets {
  const geometries = [conifer(), broadleaf(), jungle(), acacia(), palm()];
  const deciduous = [0, 1, 0, 0.35, 0];
  const materials = geometries.map((_, kind) => {
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
    return patchMaterial(mat, {
      vertexPars: /* glsl */ `attribute float aLeaf; varying float vLeaf; varying float vLocalY;`,
      vertexTransform: /* glsl */ `
        vLeaf = aLeaf;
        vLocalY = position.y;
        #ifdef USE_INSTANCING
          float phase = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.23 + instanceMatrix[3].y * 0.31;
          float sway = sin(uTime * 1.4 + phase) * 0.6 + sin(uTime * 2.3 + phase * 1.7) * 0.4;
          transformed.x += sway * 0.022 * position.y * (0.4 + aLeaf);
          transformed.z += cos(uTime * 1.1 + phase) * 0.014 * position.y * (0.4 + aLeaf);
        #endif
      `,
      fragPars: /* glsl */ `varying float vLeaf; varying float vLocalY; uniform sampler2D uTexB; uniform float uDeciduous;`,
      fragColor: /* glsl */ `
        {
          float temp = texture2D(uTexB, epochUV(epochUp)).r * 70.0 - 30.0;
          float seasonal = uSeason * clamp(epochUp.y * 1.6, -1.0, 1.0);
          float tSeason = temp + seasonal * 11.0;
          if (vLeaf > 0.5) {
            float autumn = smoothstep(0.0, 0.8, -uSeasonCos * sign(epochUp.y)) * smoothstep(0.3, -0.3, seasonal);
            float temperate = smoothstep(0.25, 0.5, abs(epochUp.y));
            float lum = dot(diffuseColor.rgb, vec3(0.3, 0.55, 0.15));
            float tone = hash13(floor(vWPos * 0.12));
            vec3 fall = mix(SRGB(0.85, 0.45, 0.08), SRGB(0.72, 0.16, 0.06), tone) * (0.35 + lum * 3.2);
            diffuseColor.rgb = mix(diffuseColor.rgb, fall, autumn * uDeciduous * temperate);
            vec3 bare = SRGB(0.30, 0.25, 0.19) * (0.5 + lum * 2.0);
            diffuseColor.rgb = mix(diffuseColor.rgb, bare, smoothstep(-0.5, -0.95, seasonal) * uDeciduous * temperate);
          }
          float snow = smoothstep(-1.0, -7.0, tSeason) * smoothstep(1.0, 3.5, vLocalY) * 0.75;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.93, 0.97), snow * (0.35 + 0.65 * vLeaf));
        }
      `,
      uniforms: { uTexB: U.uTexB, uDeciduous: { value: deciduous[kind] } },
    });
  });
  return { geometries, materials };
}
