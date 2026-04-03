// tests/test_brain_rot.js — Vitest unit tests for brain rot score logic
// Run: cd tests && npm test

import { describe, it, expect } from 'vitest';

// ── Brain rot score formula (matches parcellation.py + popup.js) ──────────────

const SCORE_THRESHOLDS = { GREEN_MAX: 4, YELLOW_MAX: 7 };

function brainRotScore(reward, dmn, fpn) {
  return (reward + dmn) / Math.max(fpn, 0.01);
}

function scoreColor(score) {
  if (score <= SCORE_THRESHOLDS.GREEN_MAX) return 'green';
  if (score <= SCORE_THRESHOLDS.YELLOW_MAX) return 'yellow';
  return 'red';
}

// ─── Formula tests ────────────────────────────────────────────────────────────

describe('brain rot score formula', () => {

  it('computes correct ratio for normal inputs', () => {
    const score = brainRotScore(0.5, 0.8, 0.6);
    expect(score).toBeCloseTo(1.3 / 0.6, 5);
  });

  it('handles fpn=0 without throwing (floor at 0.01)', () => {
    expect(() => brainRotScore(1, 1, 0)).not.toThrow();
    const score = brainRotScore(1, 1, 0);
    expect(score).toBe(200); // (1+1)/0.01
  });

  it('equal networks give score of 2', () => {
    expect(brainRotScore(1, 1, 1)).toBe(2);
  });

  it('high FPN (active engagement) gives low score', () => {
    const score = brainRotScore(0.1, 0.1, 2.0);
    expect(score).toBeLessThan(1);
  });

  it('high reward + DMN, low FPN gives high score', () => {
    const score = brainRotScore(2.0, 2.0, 0.1);
    expect(score).toBeGreaterThan(10);
  });

});

// ─── Color threshold tests ────────────────────────────────────────────────────

describe('score color thresholds', () => {

  it('score 0 → green', () => {
    expect(scoreColor(0)).toBe('green');
  });

  it('score 4 (boundary) → green', () => {
    expect(scoreColor(4)).toBe('green');
  });

  it('score 4.1 → yellow', () => {
    expect(scoreColor(4.1)).toBe('yellow');
  });

  it('score 7 (boundary) → yellow', () => {
    expect(scoreColor(7)).toBe('yellow');
  });

  it('score 7.1 → red', () => {
    expect(scoreColor(7.1)).toBe('red');
  });

  it('score 100 → red', () => {
    expect(scoreColor(100)).toBe('red');
  });

  it('score -1 (edge: below 0) → green', () => {
    expect(scoreColor(-1)).toBe('green');
  });

});
