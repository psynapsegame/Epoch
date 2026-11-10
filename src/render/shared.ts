import * as THREE from 'three';
import { PLANET_RADIUS } from '../world/types';

/**
 * Uniforms shared by every planet material (sun, camera, time, world textures).
 * A single object instance per uniform so one update reaches all shaders.
 */
export const U = {
  uSunDir: { value: new THREE.Vector3(1, 0.2, 0).normalize() },
  uCamPos: { value: new THREE.Vector3() },
  uTime: { value: 0 },
  /** sin of the year angle: +1 northern summer solstice. */
  uSeason: { value: 0 },
  /** cos of the year angle: +1 at the spring equinox, -1 at the autumn equinox. */
  uSeasonCos: { value: 1 },
  uRadius: { value: PLANET_RADIUS },
  uTexA: { value: null as THREE.Texture | null },
  uTexB: { value: null as THREE.Texture | null },
  uCloudTex: { value: null as THREE.Texture | null },
  uCloudShift: { value: 0 },
  uCloudCover: { value: 0.44 },
  uOverlayTex: { value: null as THREE.Texture | null },
  uOverlayMix: { value: 0 },
};

/** GLSL helpers available in all patched materials. */
export const GLSL_COMMON = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uCamPos;
uniform float uTime;
uniform float uSeason;
uniform float uSeasonCos;
uniform float uRadius;
#define SRGB(r,g,b) pow(vec3(r,g,b), vec3(2.2))

vec2 epochUV(vec3 up) {
  return vec2(atan(up.z, up.x) * 0.15915494 + 0.5, 0.5 - asin(clamp(up.y, -1.0, 1.0)) * 0.31830989);
}
// Seam-safe mip-mapped lookup in an equirectangular texture.
vec4 epochSample(sampler2D t, vec2 uv) {
  vec2 uvB = vec2(fract(uv.x + 0.5) - 0.5, uv.y);
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  vec2 dxB = dFdx(uvB), dyB = dFdy(uvB);
  if (abs(dx.x) + abs(dy.x) > abs(dxB.x) + abs(dyB.x)) { dx = dxB; dy = dyB; }
  return textureGrad(t, uv, dx, dy);
}
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1,0,0)), f.x), mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x), mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y),
    f.z);
}
float vfbm(vec3 p) {
  return vnoise(p) * 0.5 + vnoise(p * 2.03 + 7.1) * 0.25 + vnoise(p * 4.01 + 3.7) * 0.125 + vnoise(p * 8.07) * 0.0625;
}
// Colour of direct sunlight reaching a place where the sun stands at height sunUp (-1..1).
vec3 epochSunTint(float sunUp) {
  vec3 warm = mix(vec3(1.0, 0.36, 0.12), vec3(1.0, 0.72, 0.45), smoothstep(-0.02, 0.12, sunUp));
  return mix(warm, vec3(1.0), smoothstep(0.08, 0.42, sunUp)) * smoothstep(-0.1, 0.03, sunUp);
}
// Sky/ambient light: bluish by day, faint moonlight at night.
vec3 epochAmbient(vec3 up, vec3 n) {
  float sunUp = dot(up, uSunDir);
  float day = smoothstep(-0.18, 0.28, sunUp);
  vec3 sky = mix(vec3(0.042, 0.060, 0.115), vec3(0.26, 0.36, 0.52), day); // night: soft moonlight
  sky += vec3(0.30, 0.13, 0.05) * smoothstep(-0.2, 0.0, sunUp) * (1.0 - smoothstep(0.0, 0.3, sunUp));
  return sky * (0.55 + 0.45 * dot(n, up));
}
`;

export interface PatchOptions {
  vertexPars?: string;
  /** Code inserted after begin_vertex (can modify `transformed`). */
  vertexTransform?: string;
  fragPars?: string;
  /** Replaces colour computation: must write diffuseColor.rgb. Runs first in main(). */
  fragColor?: string;
  /** Runs after normals are set up: may overwrite `normal` (view space). */
  fragNormal?: string;
  /** May overwrite roughnessFactor. */
  fragRoughness?: string;
  /** May add to totalEmissiveRadiance. */
  fragEmissive?: string;
  uniforms?: Record<string, THREE.IUniform>;
}

/**
 * Extends a MeshStandardMaterial with planet-aware shading while keeping
 * three.js lighting & shadows: world position varying, per-location sunlight
 * tint (golden hours, night side) and sky ambient.
 */
export function patchMaterial<T extends THREE.MeshStandardMaterial>(mat: T, opts: PatchOptions = {}): T {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U, opts.uniforms ?? {});
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\nuniform float uTime;\n${opts.vertexPars ?? ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${opts.vertexTransform ?? ''}`)
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        {
          vec4 epochWp = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            epochWp = instanceMatrix * epochWp;
          #endif
          vWPos = (modelMatrix * epochWp).xyz;
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\n${GLSL_COMMON}\n${opts.fragPars ?? ''}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 epochUp = normalize(vWPos);
        float epochSunUp = dot(epochUp, uSunDir);
        float epochShade = 1.0; // extra direct-light occlusion (cloud shadows)
        ${opts.fragColor ?? ''}`,
      )
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${opts.fragRoughness ?? ''}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${opts.fragNormal ?? ''}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${opts.fragEmissive ?? ''}`)
      .replace(
        '#include <opaque_fragment>',
        `{
          vec3 epochN = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
          vec3 direct = outgoingLight - totalEmissiveRadiance;
          outgoingLight = direct * epochSunTint(epochSunUp) * epochShade
            + diffuseColor.rgb * epochAmbient(epochUp, epochN) + totalEmissiveRadiance;
        }
        #include <opaque_fragment>`,
      );
  };
  return mat;
}
