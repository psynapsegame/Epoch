/**
 * Graphics quality tiers and the adaptive governor that keeps the game smooth
 * and cool on phones. This module is pure logic (no DOM / WebGL) so it can be
 * unit-tested.
 */
export type QualityTier = 'low' | 'medium' | 'high';
export const QUALITY_TIERS: QualityTier[] = ['low', 'medium', 'high'];
export const TIER_LABELS: Record<QualityTier, string> = { low: 'Basse', medium: 'Moyenne', high: 'Haute' };

export interface QualityProfile {
  tier: QualityTier;
  /** Upper bound of the device pixel ratio used for rendering. */
  pixelRatioCap: number;
  /** MSAA samples of the HDR scene target (0 = off). */
  msaa: number;
  bloom: boolean;
  /** Shadow map resolution (0 = no shadows). */
  shadowMapSize: number;
  softShadows: boolean;
  /** Ray-march steps of the atmosphere (view ray / light ray). */
  atmosphereSteps: number;
  atmosphereLightSteps: number;
  /** Candidate trees per forest chunk edge (density). */
  treeGrid: number;
  /** Terrain refinement: larger = sharper terrain farther away. */
  splitFactor: number;
  maxTerrainLevel: number;
  /** Milliseconds per frame allowed for building terrain chunks. */
  chunkBudgetMs: number;
  /** Cheaper fragment shaders (fewer noise octaves, no micro bump). */
  simpleShaders: boolean;
  /** Translucent blurred UI panels (backdrop-filter is costly on phones). */
  glassUi: boolean;
  textureAnisotropy: number;
}

export const PROFILES: Record<QualityTier, QualityProfile> = {
  low: {
    tier: 'low', pixelRatioCap: 1.25, msaa: 0, bloom: false, shadowMapSize: 0, softShadows: false,
    atmosphereSteps: 6, atmosphereLightSteps: 2, treeGrid: 20, splitFactor: 1.9, maxTerrainLevel: 6,
    chunkBudgetMs: 3, simpleShaders: true, glassUi: false, textureAnisotropy: 1,
  },
  medium: {
    tier: 'medium', pixelRatioCap: 1.75, msaa: 0, bloom: true, shadowMapSize: 1024, softShadows: false,
    atmosphereSteps: 8, atmosphereLightSteps: 3, treeGrid: 28, splitFactor: 2.2, maxTerrainLevel: 7,
    chunkBudgetMs: 4, simpleShaders: false, glassUi: false, textureAnisotropy: 2,
  },
  high: {
    tier: 'high', pixelRatioCap: 2, msaa: 4, bloom: true, shadowMapSize: 2048, softShadows: true,
    atmosphereSteps: 10, atmosphereLightSteps: 4, treeGrid: 36, splitFactor: 2.5, maxTerrainLevel: 7,
    chunkBudgetMs: 5, simpleShaders: false, glassUi: true, textureAnisotropy: 4,
  },
};

export interface DeviceInfo {
  /** Touch-first device (phone / tablet). */
  mobile: boolean;
  /** Approximate RAM in GB when the browser reports it. */
  memoryGB: number | null;
  cores: number | null;
}

/** Starting tier for a device; the governor refines it at run time. */
export function defaultTier(device: DeviceInfo): QualityTier {
  if (!device.mobile) return 'high';
  if ((device.memoryGB !== null && device.memoryGB <= 3) || (device.cores !== null && device.cores <= 4)) return 'low';
  return 'medium';
}

export type GovernorAction = 'none' | 'scale-down' | 'scale-up' | 'tier-down';

const SCALE_STEPS = [1, 0.85, 0.72, 0.6];
const WINDOW = 45; // frames per decision window

/**
 * Watches real frame intervals and decides when to lower the rendering
 * resolution, then the quality tier, so the device neither stutters nor
 * overheats. It may cautiously raise the resolution again after a long
 * stable period, but never beyond a level that already proved too heavy.
 */
export class QualityGovernor {
  private sum = 0;
  private count = 0;
  private holdUntil = 0;
  private scaleIndex = 0;
  /** Lowest scale index known to be sustainable (prevents oscillation). */
  private floorIndex = 0;
  private goodWindows = 0;
  /** Set once a sharper setting was tried and failed: stop trying. */
  private noRaise = false;
  private lastWasRaise = false;
  enabled = true;

  constructor(public targetFps = 60) {}

  get scale(): number {
    return SCALE_STEPS[this.scaleIndex];
  }

  /** Ignore measurements for a while (world loading, tier switches, resume from background). */
  hold(nowMs: number, durationMs: number): void {
    this.holdUntil = Math.max(this.holdUntil, nowMs + durationMs);
    this.sum = 0;
    this.count = 0;
  }

  reset(): void {
    this.scaleIndex = 0;
    this.floorIndex = 0;
    this.goodWindows = 0;
    this.noRaise = false;
    this.lastWasRaise = false;
    this.sum = 0;
    this.count = 0;
  }

  /**
   * Feeds one display frame interval.
   * @param busy true while the engine is doing one-off work (building terrain) that should not count.
   */
  sample(nowMs: number, frameMs: number, busy: boolean, canLowerTier: boolean): GovernorAction {
    if (!this.enabled || nowMs < this.holdUntil || busy || frameMs > 400) return 'none';
    this.sum += frameMs;
    if (++this.count < WINDOW) return 'none';
    const avg = this.sum / this.count;
    this.sum = 0;
    this.count = 0;
    const budget = 1000 / this.targetFps;
    if (avg > budget * 1.3) {
      this.goodWindows = 0;
      if (this.lastWasRaise) this.noRaise = true;
      this.lastWasRaise = false;
      if (this.scaleIndex < SCALE_STEPS.length - 1) {
        this.scaleIndex++;
        this.floorIndex = Math.max(this.floorIndex, this.scaleIndex);
        return 'scale-down';
      }
      if (canLowerTier) {
        this.scaleIndex = 1;
        this.floorIndex = 0;
        this.noRaise = false;
        return 'tier-down';
      }
      return 'none';
    }
    if (avg < budget * 1.08 && !this.noRaise && this.scaleIndex > Math.max(0, this.floorIndex - 1)) {
      // steady: after ~10 good windows, try one step sharper (once per floor level)
      if (++this.goodWindows >= 10) {
        this.goodWindows = 0;
        this.scaleIndex--;
        this.lastWasRaise = true;
        return 'scale-up';
      }
    } else {
      this.goodWindows = 0;
    }
    return 'none';
  }
}

/**
 * Frame pacing for battery life: full rate while the player interacts or the
 * camera moves, reduced rate when the view is at rest.
 */
export function targetFrameRate(opts: { active: boolean; eco: boolean }): number {
  if (opts.eco) return opts.active ? 30 : 20;
  return opts.active ? 60 : 30;
}
