// tests/test_platforms.js — Vitest unit tests for platform DOM detection logic
// Run: cd tests && npm test

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Platform config (mirrors content.js) ─────────────────────────────────────

const PLATFORMS = {
  'instagram.com': {
    selector: '.x1lliihq',
    fallback: 'video[playsinline]',
    pathCheck: (pathname) =>
      pathname.includes('/reels/') || pathname === '/' || pathname.includes('instagram'),
  },
  'tiktok.com': {
    selector: '[class*="DivVideoContainer"]',
    fallback: 'video[autoplay]',
    pathCheck: () => true,
  },
  'youtube.com': {
    selector: 'ytd-reel-video-renderer',
    fallback: 'video[src]',
    pathCheck: (pathname) =>
      pathname === '/shorts/' || pathname.startsWith('/shorts/'),
  },
};

function detectPlatform(hostname, pathname) {
  const host = hostname.replace('www.', '');
  for (const [key, config] of Object.entries(PLATFORMS)) {
    if (host.includes(key) && config.pathCheck(pathname)) {
      return { key, config };
    }
  }
  return null;
}

// ─── Platform detection tests ─────────────────────────────────────────────────

describe('platform detection', () => {

  it('detects instagram.com on reels path', () => {
    const p = detectPlatform('www.instagram.com', '/reels/');
    expect(p).not.toBeNull();
    expect(p.key).toBe('instagram.com');
  });

  it('detects instagram.com on homepage', () => {
    const p = detectPlatform('www.instagram.com', '/');
    expect(p).not.toBeNull();
    expect(p.key).toBe('instagram.com');
  });

  it('detects tiktok.com on any path', () => {
    const p = detectPlatform('www.tiktok.com', '/');
    expect(p).not.toBeNull();
    expect(p.key).toBe('tiktok.com');
  });

  it('detects youtube.com on /shorts/ path', () => {
    const p = detectPlatform('www.youtube.com', '/shorts/ABC123');
    expect(p).not.toBeNull();
    expect(p.key).toBe('youtube.com');
  });

  it('does NOT detect youtube.com on /watch path', () => {
    const p = detectPlatform('www.youtube.com', '/watch?v=abc');
    expect(p).toBeNull();
  });

  it('returns null for unsupported sites', () => {
    const p = detectPlatform('www.twitter.com', '/');
    expect(p).toBeNull();
  });

});

// ─── Selector fallback logic ──────────────────────────────────────────────────

describe('selector fallback', () => {

  it('instagram primary selector is .x1lliihq', () => {
    const p = detectPlatform('www.instagram.com', '/reels/');
    expect(p.config.selector).toBe('.x1lliihq');
  });

  it('instagram fallback selector is video[playsinline]', () => {
    const p = detectPlatform('www.instagram.com', '/reels/');
    expect(p.config.fallback).toBe('video[playsinline]');
  });

  it('youtube uses stable semantic selector ytd-reel-video-renderer', () => {
    const p = detectPlatform('www.youtube.com', '/shorts/ABC');
    expect(p.config.selector).toBe('ytd-reel-video-renderer');
  });

  it('tiktok uses attribute-based selector for DivVideoContainer', () => {
    const p = detectPlatform('www.tiktok.com', '/');
    expect(p.config.selector).toContain('DivVideoContainer');
  });

});
