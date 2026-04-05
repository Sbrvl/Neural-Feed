// tests/test_brain_rot.js — Vitest unit tests for brain rot score logic
// Run: cd tests && npm test

import { describe, it, expect } from 'vitest';

// ── Brain rot display mapping (matches parcellation.py + popup.js) ───────────

const SCORE_THRESHOLDS = { GREEN_MAX: 4, YELLOW_MAX: 7 };

function brainRotScore(healthScore) {
  return Math.max(0, Math.min(10, +(10 - (healthScore / 10)).toFixed(2)));
}

function scoreColor(score) {
  if (score <= SCORE_THRESHOLDS.GREEN_MAX) return 'green';
  if (score <= SCORE_THRESHOLDS.YELLOW_MAX) return 'yellow';
  return 'red';
}

// ─── Formula tests ────────────────────────────────────────────────────────────

describe('brain rot score mapping', () => {

  it('maps health 100 to brain rot 0', () => {
    expect(brainRotScore(100)).toBe(0);
  });

  it('maps health 0 to brain rot 10', () => {
    expect(brainRotScore(0)).toBe(10);
  });

  it('maps health 72 to brain rot 2.8', () => {
    expect(brainRotScore(72)).toBe(2.8);
  });

  it('clips out-of-range health inputs', () => {
    expect(brainRotScore(-20)).toBe(10);
    expect(brainRotScore(140)).toBe(0);
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
