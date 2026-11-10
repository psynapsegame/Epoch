import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { ATMOSPHERE_HEIGHT, PLANET_RADIUS } from '../world/types';
import { U } from './shared';

/**
 * Physically inspired atmospheric scattering as a depth-aware post process:
 * one integral gives the blue sky, sunsets, the glowing limb seen from orbit
 * and aerial perspective on distant terrain. Also draws the sun disc.
 */
export class AtmospherePass extends Pass {
  private quad: FullScreenQuad;
  readonly material: THREE.ShaderMaterial;

  constructor(private source: THREE.WebGLRenderTarget, private camera: THREE.PerspectiveCamera) {
    super();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: source.texture },
        tDepth: { value: source.depthTexture },
        uProjInv: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() },
        uCamPos: U.uCamPos,
        uSunDir: U.uSunDir,
        uNear: { value: 1 },
        uFar: { value: 1000 },
        uR: { value: PLANET_RADIUS },
        uRa: { value: PLANET_RADIUS + ATMOSPHERE_HEIGHT },
        uDensity: { value: 0.8 },
        uSunPower: { value: 18 },
        uEnabled: { value: 0 },
      },
      defines: { ATMO_STEPS: 10, ATMO_LSTEPS: 4 },
      depthTest: false,
      depthWrite: false,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        #include <packing>
        varying vec2 vUv;
        uniform sampler2D tScene;
        uniform sampler2D tDepth;
        uniform mat4 uProjInv;
        uniform mat4 uCamWorld;
        uniform vec3 uCamPos;
        uniform vec3 uSunDir;
        uniform float uNear, uFar, uR, uRa, uDensity, uSunPower, uEnabled;

        const float HR = 150.0;
        const float HM = 55.0;
        const vec3 BR = vec3(1.9e-4, 4.4e-4, 10.6e-4);
        const float BM = 1.6e-4;
        const int STEPS = ATMO_STEPS;
        const int LSTEPS = ATMO_LSTEPS;

        vec2 raySphere(vec3 o, vec3 d, float r) {
          float b = dot(o, d);
          float c = dot(o, o) - r * r;
          float disc = b * b - c;
          if (disc < 0.0) return vec2(1e9, -1e9);
          float s = sqrt(disc);
          return vec2(-b - s, -b + s);
        }

        void main() {
          vec4 scene = texture2D(tScene, vUv);
          if (uEnabled < 0.5) { gl_FragColor = vec4(scene.rgb, 1.0); return; }
          float depth = texture2D(tDepth, vUv).x;
          vec4 vp = uProjInv * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
          vec3 vdir = vp.xyz / vp.w;
          vec3 rd = normalize((uCamWorld * vec4(vdir, 0.0)).xyz);
          float sceneDist = 1e9;
          if (depth < 0.999999) {
            float viewZ = perspectiveDepthToViewZ(depth, uNear, uFar);
            sceneDist = length(vdir * (viewZ / vdir.z));
          }
          vec3 col = scene.rgb;
          float mu = dot(rd, uSunDir);

          vec2 ta = raySphere(uCamPos, rd, uRa);
          float t0 = max(ta.x, 0.0);
          float t1 = min(ta.y, sceneDist);
          vec3 trans = vec3(1.0);
          if (t1 > t0) {
            float ds = (t1 - t0) / float(STEPS);
            // Artistic licence for a miniature planet: nearby surfaces keep their
            // clarity, haze builds up fully only over long distances and for the sky.
            float dens = uDensity * (sceneDist > 1e8 ? 1.0 : mix(0.16, 1.0, smoothstep(500.0, 5000.0, sceneDist)));
            vec3 odR = vec3(0.0); float odM = 0.0;
            vec3 sumR = vec3(0.0), sumM = vec3(0.0);
            // slight jitter hides banding
            float jit = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
            for (int i = 0; i < STEPS; i++) {
              vec3 p = uCamPos + rd * (t0 + (float(i) + 0.3 + 0.4 * jit) * ds);
              float h = max(length(p) - uR, 0.0);
              float dR = exp(-h / HR) * ds * dens;
              float dM = exp(-h / HM) * ds * dens;
              odR += BR * dR; odM += BM * dM;
              // light reaching the sample
              vec2 tp = raySphere(p, uSunDir, uR - 6.0);
              float lit = (tp.x > 0.0 && tp.y > 0.0) ? 0.0 : 1.0;
              // soft terminator
              if (lit == 0.0) { lit = 0.0; }
              vec2 tl = raySphere(p, uSunDir, uRa);
              float dl = tl.y / float(LSTEPS);
              vec3 lR = vec3(0.0); float lM = 0.0;
              for (int j = 0; j < LSTEPS; j++) {
                vec3 q = p + uSunDir * ((float(j) + 0.5) * dl);
                float hq = max(length(q) - uR, 0.0);
                lR += BR * exp(-hq / HR) * dl * uDensity;
                lM += BM * exp(-hq / HM) * dl * uDensity;
              }
              vec3 att = exp(-(odR + lR + (odM + lM) * 1.1));
              sumR += att * dR * lit;
              sumM += att * dM * lit;
            }
            float pR = 0.0596831 * (1.0 + mu * mu);
            float g = 0.76;
            float pM = 0.1193662 * ((1.0 - g * g) * (1.0 + mu * mu)) / ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
            vec3 inscatter = uSunPower * (sumR * BR * pR + sumM * BM * pM);
            trans = exp(-(odR + odM * 1.1));
            col = col * trans + inscatter;
          }
          // sun disc (only against the sky)
          if (sceneDist > 1e8) {
            vec2 tpl = raySphere(uCamPos, rd, uR);
            if (!(tpl.x > 0.0 && tpl.y > 0.0)) {
              float disc = smoothstep(0.99985, 0.99995, mu);
              float halo = pow(max(mu, 0.0), 900.0) * 0.6;
              col += (disc * 30.0 + halo * 2.0) * trans * vec3(1.0, 0.95, 0.85);
            }
          }
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  /** Switches the scene target (after a quality change). */
  setSource(source: THREE.WebGLRenderTarget): void {
    this.source = source;
  }

  setSteps(view: number, light: number): void {
    this.material.defines.ATMO_STEPS = view;
    this.material.defines.ATMO_LSTEPS = light;
    this.material.needsUpdate = true;
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget): void {
    const u = this.material.uniforms;
    u.tScene.value = this.source.texture;
    u.tDepth.value = this.source.depthTexture;
    u.uProjInv.value.copy(this.camera.projectionMatrixInverse);
    u.uCamWorld.value.copy(this.camera.matrixWorld);
    u.uNear.value = this.camera.near;
    u.uFar.value = this.camera.far;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose(): void {
    this.material.dispose();
    this.quad.dispose();
  }
}
