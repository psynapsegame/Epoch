import * as THREE from 'three';
import { patchMaterial, U } from './shared';

/**
 * Terrain surface shader. Colours are derived per pixel from the simulation
 * fields (temperature, moisture, forest cover, slope, altitude, season) so the
 * landscape always reflects real world data, at every level of detail.
 */
export function createTerrainMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
  return patchMaterial(mat, {
    fragPars: /* glsl */ `
      uniform sampler2D uTexA;
      uniform sampler2D uTexB;
      uniform sampler2D uCloudTex;
      uniform sampler2D uOverlayTex;
      uniform float uCloudShift;
      uniform float uCloudCover;
      uniform float uOverlayMix;
      vec3 terrainN;
      float terrainRough;
      vec3 terrainGlow;
      float decSlope(float v) { float e = v * 2.0 - 1.0; return 4.0 * e * abs(e); }
    `,
    fragColor: /* glsl */ `
      float r = length(vWPos);
      float h = r - uRadius;
      vec2 wuv = epochUV(epochUp);
      vec4 A = epochSample(uTexA, wuv);
      vec4 B = epochSample(uTexB, wuv);
      float camDist = distance(vWPos, uCamPos);
      float near = 1.0 - smoothstep(60.0, 420.0, camDist);
      float mid = 1.0 - smoothstep(500.0, 3500.0, camDist);

      vec3 east = normalize(vec3(-epochUp.z, 0.0, epochUp.x));
      vec3 north = cross(east, epochUp);
      vec2 sl = vec2(decSlope(A.r), decSlope(A.g));
      float slope = length(sl);

      // Multi-scale procedural variation (metres -> noise space).
      float n1 = vfbm(vWPos * 0.012);
      float n2 = vfbm(vWPos * 0.09 + 17.0);
      float n3 = vnoise(vWPos * 0.9);
      float vary = (n1 - 0.47) * 1.2 + (n2 - 0.47) * 0.7 * mid;

      float temp = B.r * 70.0 - 30.0;
      float seasonal = uSeason * clamp(epochUp.y * 1.6, -1.0, 1.0);
      float tSeason = temp + seasonal * 11.0;
      float moist = clamp(B.g + vary * 0.1, 0.0, 1.0);
      float forest = B.b;
      float volc = B.a;

      // --- ground cover -------------------------------------------------
      vec3 sandDesert = SRGB(0.84, 0.70, 0.46);
      vec3 dune = SRGB(0.90, 0.78, 0.55);
      vec3 savanna = SRGB(0.66, 0.60, 0.30);
      vec3 grassDry = SRGB(0.52, 0.58, 0.27);
      vec3 grassLush = SRGB(0.27, 0.50, 0.17);
      vec3 tundra = SRGB(0.50, 0.49, 0.36);
      vec3 arid = mix(mix(sandDesert, dune, n2), savanna, smoothstep(0.24, 0.40, moist));
      vec3 green = mix(grassDry, grassLush, smoothstep(0.42, 0.72, moist));
      // summers parch the grass, winters dull it
      green = mix(green, grassDry * vec3(1.12, 1.0, 0.8), clamp(seasonal, 0.0, 1.0) * 0.35 * (1.0 - smoothstep(0.5, 0.8, moist)));
      green = mix(green, SRGB(0.45, 0.43, 0.26), clamp(-seasonal, 0.0, 1.0) * 0.45 * smoothstep(0.25, 0.7, abs(epochUp.y)));
      vec3 col = mix(arid, green, smoothstep(0.30, 0.47, moist));
      col = mix(col, tundra, smoothstep(7.0, -3.0, temp));
      col *= 0.82 + 0.36 * n2 + (n3 - 0.5) * 0.14 * near;

      // forests: canopy tint from afar, shaded undergrowth up close
      vec3 fTemperate = SRGB(0.13, 0.30, 0.10);
      vec3 fTropical = SRGB(0.07, 0.27, 0.08);
      vec3 fBoreal = SRGB(0.10, 0.22, 0.14);
      vec3 fcol = mix(fBoreal, fTemperate, smoothstep(2.0, 9.0, temp));
      fcol = mix(fcol, fTropical, smoothstep(17.0, 22.0, temp));
      float autumn = smoothstep(0.0, 0.8, -uSeasonCos * sign(epochUp.y)) * smoothstep(0.3, -0.3, seasonal);
      float deciduous = smoothstep(4.0, 9.0, temp) * (1.0 - smoothstep(16.0, 21.0, temp));
      fcol = mix(fcol, SRGB(0.52, 0.27, 0.07), autumn * deciduous * (0.45 + 0.4 * n2));
      fcol = mix(fcol, SRGB(0.26, 0.22, 0.15), smoothstep(-0.5, -0.95, seasonal) * deciduous * 0.6);
      float canopy = forest * (0.78 + 0.22 * vnoise(vWPos * 0.22));
      col = mix(col, fcol * (0.75 + 0.5 * n2), smoothstep(0.08, 0.55, canopy) * mix(0.55, 0.93, 1.0 - near));

      // shores & sea bed
      float beach = (1.0 - smoothstep(1.0, 3.2 + n2 * 1.5, h)) * (1.0 - smoothstep(0.25, 0.6, slope)) * smoothstep(-8.0, 2.0, temp);
      col = mix(col, SRGB(0.86, 0.79, 0.60) * (0.9 + 0.2 * n3), beach);
      if (h < 0.0) {
        vec3 bed = mix(SRGB(0.72, 0.68, 0.52), SRGB(0.10, 0.16, 0.20), smoothstep(0.0, -40.0, h));
        col = mix(col, bed, smoothstep(0.5, -1.5, h));
      }

      // rock on steep slopes and high ground
      float strata = mix(0.5, vnoise(vec3(h * 0.11 + n2 * 2.0, n1 * 5.0, 0.0)), 0.35 + 0.4 * near);
      vec3 rock = mix(SRGB(0.36, 0.33, 0.30), SRGB(0.52, 0.48, 0.43), strata) * (0.8 + 0.4 * n3);
      rock = mix(rock, SRGB(0.62, 0.45, 0.30), smoothstep(0.3, 0.2, moist) * 0.6); // desert sandstone
      rock = mix(rock, rock * vec3(1.12, 1.04, 0.92), n1);
      // sparse alpine meadow between crags
      rock = mix(rock, SRGB(0.40, 0.44, 0.27), (1.0 - smoothstep(0.35, 0.7, slope)) * smoothstep(0.35, 0.6, moist) * (1.0 - smoothstep(170.0, 260.0, h)) * 0.6);
      float rocky = smoothstep(0.42, 0.85, slope + (n2 - 0.5) * 0.25) ;
      rocky = max(rocky, smoothstep(190.0, 300.0, h + n1 * 60.0) * 0.8);
      col = mix(col, rock, rocky);

      // volcanic ash, basalt and glowing lava veins
      vec3 ash = mix(SRGB(0.13, 0.11, 0.11), SRGB(0.26, 0.20, 0.18), n2);
      float vmask = smoothstep(0.25, 0.8, volc + (n1 - 0.5) * 0.3);
      col = mix(col, ash, vmask * (h > 0.0 ? 1.0 : 0.5));
      float vein = smoothstep(0.016, 0.0, abs(vfbm(vWPos * 0.035 + 40.0) - 0.5)) * smoothstep(0.9, 0.99, volc);
      terrainGlow = vec3(2.4, 0.5, 0.08) * vein * (0.7 + 0.3 * sin(uTime * 0.7 + n1 * 20.0)) * mix(0.3, 1.0, mid);

      // snow & ice follow the seasonal temperature
      float snow = smoothstep(0.5, -4.5, tSeason + (n2 - 0.5) * 5.0 - forest * 2.0) * (1.0 - smoothstep(0.9, 1.6, slope));
      snow = max(snow, smoothstep(-9.0, -13.0, temp));
      snow *= smoothstep(-0.2, 0.6, h);
      col = mix(col, SRGB(0.93, 0.95, 0.98) * (0.93 + 0.07 * n3), snow);

      terrainRough = mix(0.96, 0.72, snow);

      // --- normal -------------------------------------------------------
      terrainN = normalize(epochUp - sl.x * east - sl.y * north);
      if (near > 0.0) {
        float e = 0.35;
        float d0 = vnoise(vWPos * 0.55) + 0.5 * vnoise(vWPos * 1.7);
        float dE = vnoise((vWPos + east * e) * 0.55) + 0.5 * vnoise((vWPos + east * e) * 1.7);
        float dN = vnoise((vWPos + north * e) * 0.55) + 0.5 * vnoise((vWPos + north * e) * 1.7);
        float bump = (0.10 + 0.5 * rocky) * near * (1.0 - snow * 0.6);
        terrainN = normalize(terrainN - ((dE - d0) * east + (dN - d0) * north) * bump / e * 0.6);
      }

      // --- rivers & lakes ----------------------------------------------
      float wmask = smoothstep(0.42, 0.62, A.b) * step(0.0, h);
      if (wmask > 0.0) {
        float frozen = smoothstep(-3.0, -8.0, tSeason);
        vec3 wcol = mix(SRGB(0.10, 0.30, 0.42), SRGB(0.18, 0.42, 0.50), n2);
        wcol = mix(wcol, SRGB(0.80, 0.88, 0.93), frozen);
        col = mix(col, wcol, wmask);
        vec3 rip = vec3(vnoise(vWPos * 1.3 + uTime * 0.6), vnoise(vWPos * 1.3 - uTime * 0.5 + 9.0), 0.0) - 0.5;
        vec3 wn = normalize(epochUp + (rip.x * east + rip.y * north) * 0.10 * near);
        terrainN = normalize(mix(terrainN, wn, wmask));
        terrainRough = mix(terrainRough, mix(0.12, 0.5, frozen), wmask);
        terrainGlow *= 1.0 - wmask;
      }

      // --- cloud shadows -------------------------------------------------
      {
        vec4 cl = epochSample(uCloudTex, vec2(wuv.x + uCloudShift, wuv.y));
        float cov = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.22, cl.r * 0.8 + cl.g * 0.2);
        epochShade = 1.0 - 0.55 * cov;
      }

      // --- atlas overlay -------------------------------------------------
      if (uOverlayMix > 0.001) {
        vec4 ov = texture2D(uOverlayTex, wuv);
        float lum = dot(col, vec3(0.3, 0.5, 0.2));
        vec3 oc = pow(ov.rgb, vec3(2.2)) * (0.55 + 1.2 * lum + 0.25);
        float k = ov.a * uOverlayMix;
        col = mix(col, oc, k);
        terrainGlow *= 1.0 - k;
      }

      diffuseColor.rgb = col;
      diffuseColor.a = 1.0;
    `,
    fragRoughness: `roughnessFactor = terrainRough;`,
    fragNormal: `normal = normalize((viewMatrix * vec4(terrainN, 0.0)).xyz);`,
    fragEmissive: `totalEmissiveRadiance += terrainGlow;`,
    uniforms: {
      uTexA: U.uTexA, uTexB: U.uTexB, uCloudTex: U.uCloudTex, uOverlayTex: U.uOverlayTex,
      uCloudShift: U.uCloudShift, uCloudCover: U.uCloudCover, uOverlayMix: U.uOverlayMix,
    },
  });
}
