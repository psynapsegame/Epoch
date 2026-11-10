import * as THREE from 'three';
import { GLSL_COMMON, U } from './shared';
import { CLOUD_ALTITUDE, PLANET_RADIUS } from '../world/types';
import { Rng } from '../core/rng';

/** Cloud layer: a shell sampling the shared coverage map (the same one that casts shadows on the ground). */
export function createClouds(): THREE.Mesh {
  const geo = new THREE.IcosahedronGeometry(PLANET_RADIUS + CLOUD_ALTITUDE, 32);
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...U },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec3 vWPos;
      void main() {
        vWPos = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * viewMatrix * vec4(vWPos, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vWPos;
      uniform sampler2D uCloudTex;
      uniform float uCloudShift;
      uniform float uCloudCover;
      ${GLSL_COMMON}
      void main() {
        vec3 up = normalize(vWPos);
        vec2 uv = epochUV(up);
        vec4 cl = epochSample(uCloudTex, vec2(uv.x + uCloudShift, uv.y));
        float dist = distance(vWPos, uCamPos);
        float near = 1.0 - smoothstep(400.0, 3000.0, dist);
        vec3 q = vWPos * 0.012 + vec3(uTime * 0.01, 0.0, uTime * 0.006);
        float fine = vfbm(q) * 0.6 + vfbm(q * 3.1) * 0.4 * near;
        float d = cl.r * 0.8 + cl.g * 0.2 + (fine - 0.45) * 0.22;
        float edge = 1.0 - uCloudCover;
        float cov = smoothstep(edge, edge + 0.2, d);
        if (cov < 0.004) discard;
        float thick = smoothstep(edge + 0.05, edge + 0.45, d);
        float sunUp = dot(up, uSunDir);
        vec3 sunCol = epochSunTint(sunUp + 0.06);
        vec3 lit = mix(vec3(1.0), vec3(0.62, 0.66, 0.74), thick * 0.75);
        vec3 col = lit * (sunCol * 1.15 + epochAmbient(up, up) * 0.9);
        // seen from below, thick clouds are darker
        float below = step(length(uCamPos), length(vWPos));
        col *= mix(1.0, 0.72 - 0.25 * thick, below);
        // soften where the shell meets the horizon to avoid a hard ring
        float graze = abs(dot(normalize(uCamPos - vWPos), up));
        float alpha = cov * (0.5 + 0.4 * thick) * smoothstep(0.0, 0.12, graze) * smoothstep(40.0, 320.0, dist);
        gl_FragColor = vec4(col, alpha);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 2;
  mesh.matrixAutoUpdate = false;
  mesh.frustumCulled = false;
  return mesh;
}

/** Star field rendered behind everything; rotates with the sun so the sky turns over the day. */
export function createStars(): THREE.Points {
  const rng = new Rng(0xe90c4);
  const count = 7000;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let x = rng.gauss(), y = rng.gauss(), z = rng.gauss();
    // denser band: a faint galactic plane
    if (rng.chance(0.45)) y *= 0.22;
    const l = Math.hypot(x, y, z) || 1;
    pos[i * 3] = x / l; pos[i * 3 + 1] = y / l; pos[i * 3 + 2] = z / l;
    const mag = Math.pow(rng.next(), 5);
    const warm = rng.next();
    const b = 0.25 + mag * 1.6;
    col[i * 3] = b * (0.8 + 0.3 * warm);
    col[i * 3 + 1] = b * 0.88;
    col[i * 3 + 2] = b * (1.1 - 0.35 * warm);
    size[i] = 1.1 + mag * 2.6;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uFade: { value: 1 }, uPixelRatio: { value: 1 } },
    depthTest: false,
    depthWrite: false,
    transparent: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aSize; attribute vec3 color; varying vec3 vCol; uniform float uPixelRatio;
      void main() {
        vCol = color;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uPixelRatio;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vCol; uniform float uFade;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        gl_FragColor = vec4(vCol * smoothstep(0.5, 0.1, d) * uFade, 1.0);
      }`,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = -10;
  return pts;
}

