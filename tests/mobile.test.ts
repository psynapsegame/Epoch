import { describe, expect, it } from 'vitest';
import { twoFingerDelta } from '../src/render/gestures';
import { PROFILES, QUALITY_TIERS, QualityGovernor, defaultTier, targetFrameRate } from '../src/render/quality';

describe('two-finger gestures', () => {
  it('reads a pinch as zoom only', () => {
    const g = twoFingerDelta({ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 50, y: 100 }, { x: 250, y: 100 });
    expect(g.zoomFactor).toBeCloseTo(0.5, 6); // fingers apart -> distance halves -> zoom in
    expect(g.rotation).toBeCloseTo(0, 6);
    expect(g.tiltPixels).toBe(0);
  });
  it('reads a twist as rotation without zoom', () => {
    const g = twoFingerDelta({ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 200 });
    expect(g.zoomFactor).toBeCloseTo(1, 6);
    expect(g.rotation).toBeCloseTo(Math.PI / 2, 6); // clockwise on screen (y grows downwards)
  });
  it('reads a parallel vertical slide as tilt', () => {
    const g = twoFingerDelta({ x: 100, y: 200 }, { x: 200, y: 200 }, { x: 100, y: 180 }, { x: 200, y: 181 });
    expect(g.tiltPixels).toBeCloseTo(-19.5, 6);
    expect(Math.abs(g.zoomFactor - 1)).toBeLessThan(0.01);
    // opposite vertical motion is a pinch, not a tilt
    expect(twoFingerDelta({ x: 100, y: 100 }, { x: 100, y: 200 }, { x: 100, y: 80 }, { x: 100, y: 220 }).tiltPixels).toBe(0);
  });
  it('ignores rotation when fingers nearly touch', () => {
    expect(twoFingerDelta({ x: 100, y: 100 }, { x: 110, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 110 }).rotation).toBe(0);
  });
});

describe('quality tiers', () => {
  it('get cheaper from high to low', () => {
    for (let i = 1; i < QUALITY_TIERS.length; i++) {
      const lo = PROFILES[QUALITY_TIERS[i - 1]], hi = PROFILES[QUALITY_TIERS[i]];
      expect(lo.pixelRatioCap).toBeLessThanOrEqual(hi.pixelRatioCap);
      expect(lo.shadowMapSize).toBeLessThanOrEqual(hi.shadowMapSize);
      expect(lo.treeGrid).toBeLessThanOrEqual(hi.treeGrid);
      expect(lo.atmosphereSteps).toBeLessThanOrEqual(hi.atmosphereSteps);
    }
  });
  it('start phones lower than desktops', () => {
    expect(defaultTier({ mobile: false, memoryGB: 16, cores: 8 })).toBe('high');
    expect(defaultTier({ mobile: true, memoryGB: 8, cores: 8 })).toBe('medium');
    expect(defaultTier({ mobile: true, memoryGB: 2, cores: 8 })).toBe('low');
    expect(defaultTier({ mobile: true, memoryGB: null, cores: null })).toBe('medium');
  });
  it('pace frames for battery life', () => {
    expect(targetFrameRate({ active: true, eco: false })).toBe(60);
    expect(targetFrameRate({ active: false, eco: false })).toBe(30);
    expect(targetFrameRate({ active: true, eco: true })).toBe(30);
    expect(targetFrameRate({ active: false, eco: true })).toBe(20);
  });
});

describe('quality governor', () => {
  const run = (g: QualityGovernor, frameMs: number, frames: number, canLower = true) => {
    const actions: string[] = [];
    for (let i = 0; i < frames; i++) {
      const a = g.sample(1e6 + i, frameMs, false, canLower);
      if (a !== 'none') actions.push(a);
    }
    return actions;
  };
  it('does nothing when frames are on budget', () => {
    const g = new QualityGovernor(60);
    expect(run(g, 16.7, 2000)).toEqual([]);
    expect(g.scale).toBe(1);
  });
  it('lowers resolution first, then the tier', () => {
    const g = new QualityGovernor(60);
    const actions = run(g, 30, 45 * 4);
    expect(actions).toEqual(['scale-down', 'scale-down', 'scale-down', 'tier-down']);
    expect(g.scale).toBeLessThan(1);
  });
  it('never asks for a lower tier when not allowed', () => {
    const g = new QualityGovernor(60);
    expect(run(g, 40, 45 * 10, false)).not.toContain('tier-down');
    expect(g.scale).toBe(0.6);
  });
  it('ignores loading spikes and held periods', () => {
    const g = new QualityGovernor(60);
    for (let i = 0; i < 500; i++) expect(g.sample(i, 80, true, true)).toBe('none');
    g.hold(1000, 5000);
    for (let i = 0; i < 500; i++) expect(g.sample(1000 + i, 80, false, true)).toBe('none');
  });
  it('tries a sharper image once, and stops trying if it fails', () => {
    const g = new QualityGovernor(60);
    run(g, 30, 45); // -> 0.85
    expect(g.scale).toBe(0.85);
    expect(run(g, 16.7, 45 * 10)).toEqual(['scale-up']);
    expect(g.scale).toBe(1);
    run(g, 30, 45); // sharper failed -> back down
    expect(g.scale).toBe(0.85);
    expect(run(g, 16.7, 45 * 40)).toEqual([]); // no more oscillation
  });
});
