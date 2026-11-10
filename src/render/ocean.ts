import * as THREE from 'three';
import { GLSL_COMMON, U } from './shared';
import { PLANET_RADIUS } from '../world/types';

/** Ocean sphere: depth-tinted water, animated swell, fresnel sky reflection, shore foam, polar pack ice. */
export function createOcean(): THREE.Mesh {
  const geo = new THREE.IcosahedronGeometry(PLANET_RADIUS, 48);
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...U },
    transparent: true,
    depthWrite: true,
    vertexShader: /* glsl */ `
      varying vec3 vWPos;
      void main() {
        vWPos = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * viewMatrix * vec4(vWPos, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vWPos;
      uniform sampler2D uTexA;
      uniform sampler2D uTexB;
      uniform sampler2D uCloudTex;
      uniform float uCloudShift;
      uniform float uCloudCover;
      ${GLSL_COMMON}
      float swell(vec3 p, float t) {
        return vnoise(p * 0.05 + vec3(t * 0.11, 0.0, t * 0.07)) * 0.6
             + vnoise(p * 0.19 + vec3(-t * 0.23, t * 0.13, 0.0)) * 0.3
             + vnoise(p * 0.7 + vec3(t * 0.5, 0.0, -t * 0.4)) * 0.1;
      }
      void main() {
        vec3 up = normalize(vWPos);
        vec2 uv = epochUV(up);
        vec4 A = epochSample(uTexA, uv);
        vec4 B = epochSample(uTexB, uv);
        float depth = A.a * A.a * 120.0; // metres
        float dist = distance(vWPos, uCamPos);
        vec3 V = normalize(uCamPos - vWPos);
        float sunUp = dot(up, uSunDir);
        vec3 sunCol = epochSunTint(sunUp);
        float day = smoothstep(-0.18, 0.28, sunUp);

        // wave normal from finite differences of an animated swell field
        vec3 east = normalize(vec3(-up.z, 0.0, up.x));
        vec3 north = cross(east, up);
        float detail = 1.0 - smoothstep(250.0, 2600.0, dist);
        float e = 0.6;
        float w0 = swell(vWPos, uTime);
        float wE = swell(vWPos + east * e, uTime);
        float wN = swell(vWPos + north * e, uTime);
        vec3 N = normalize(up - ((wE - w0) * east + (wN - w0) * north) * (1.6 * detail + 0.25) / e);

        vec3 deep = SRGB(0.015, 0.075, 0.19);
        vec3 shallow = SRGB(0.07, 0.42, 0.50);
        vec3 water = mix(shallow, deep, smoothstep(0.0, 38.0, depth));
        water = mix(water, SRGB(0.01, 0.04, 0.12), smoothstep(40.0, 120.0, depth) * 0.7);

        float ndl = max(dot(N, uSunDir), 0.0);
        vec3 col = water * (sunCol * (0.25 + 0.75 * ndl) + epochAmbient(up, N) * 1.4);

        // reflection of the sky
        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
        vec3 R = reflect(-V, N);
        float rUp = max(dot(R, up), 0.0);
        vec3 skyDay = mix(vec3(0.62, 0.76, 0.94), vec3(0.18, 0.38, 0.80), pow(rUp, 0.6));
        vec3 sky = skyDay * day * mix(vec3(1.0), sunCol, 0.5) + vec3(0.006, 0.009, 0.02);
        sky += vec3(1.0, 0.45, 0.18) * pow(max(dot(R, uSunDir), 0.0), 6.0) * (1.0 - smoothstep(0.0, 0.35, sunUp)) * smoothstep(-0.15, 0.0, sunUp);
        col = mix(col, sky, fres * 0.85);

        // sun glitter
        vec3 Hv = normalize(V + uSunDir);
        float spec = pow(max(dot(N, Hv), 0.0), mix(160.0, 380.0, detail));
        col += sunCol * spec * mix(0.22, 4.0, detail) * smoothstep(-0.02, 0.05, sunUp);

        // cloud shadows
        vec4 cl = epochSample(uCloudTex, vec2(uv.x + uCloudShift, uv.y));
        float cov = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.22, cl.r * 0.8 + cl.g * 0.2);
        col *= 1.0 - 0.4 * cov * day;

        // shore foam: breaking bands moving toward the beach
        float shore = 1.0 - smoothstep(0.0, 3.5, depth);
        float band = sin(depth * 2.6 + uTime * 1.1 + vnoise(vWPos * 0.2) * 5.0) * 0.5 + 0.5;
        float foam = shore * smoothstep(0.55, 0.95, band * 0.6 + vnoise(vWPos * 1.5 + uTime * 0.2) * 0.6) * detail;
        foam += (1.0 - smoothstep(0.0, 0.5, depth)) * 0.5 * detail;
        vec3 lit = sunCol * 0.9 + epochAmbient(up, up);
        col = mix(col, vec3(0.95) * lit, clamp(foam, 0.0, 1.0) * 0.8);

        // polar pack ice follows the seasons
        float temp = B.r * 70.0 - 30.0 + uSeason * clamp(up.y * 1.6, -1.0, 1.0) * 9.0;
        float floe = vfbm(vWPos * 0.02) + (vnoise(vWPos * 0.3) - 0.5) * 0.25 * detail;
        float ice = smoothstep(-9.0, -15.0, temp + (floe - 0.5) * 9.0);
        col = mix(col, vec3(0.86, 0.91, 0.96) * (sunCol * (0.2 + 0.8 * max(dot(up, uSunDir), 0.0)) + epochAmbient(up, up)), ice);

        float alpha = mix(0.55, 1.0, smoothstep(0.0, 5.0, depth));
        alpha = max(max(alpha, fres), max(ice, clamp(foam, 0.0, 1.0)));
        gl_FragColor = vec4(col, alpha);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 1;
  mesh.matrixAutoUpdate = false;
  return mesh;
}
