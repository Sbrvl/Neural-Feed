// content.js — Reel change detector for Instagram, TikTok, YouTube Shorts
// Injected into matching pages by manifest.json content_scripts.
//
// Responsibilities:
//   - Detect when the user scrolls to a new reel (URL change or video visibility)
//   - Send REEL_CHANGED to service_worker.js
//   - Do NOT start or stop capture directly — that's the SW's job
//
// ┌─────────────────────────────────────────────────────────┐
// │  DETECTION STRATEGY (per platform)                      │
// │                                                         │
// │  Instagram / YouTube Shorts                             │
// │    URL changes per reel → setInterval URL poll          │
// │                                                         │
// │  TikTok                                                 │
// │    URL stays the same → IntersectionObserver on <video> │
// │    (fires when next video enters viewport at ≥80%)      │
// │                                                         │
// │  All platforms                                          │
// │    MutationObserver watches for new <video> elements    │
// │    added by infinite scroll                             │
// └─────────────────────────────────────────────────────────┘

'use strict';

console.log('[NeuralFeed] content.js loaded on', window.location.href);

// ─── Reel change debounce ─────────────────────────────────────────────────────
// Prevents duplicate REEL_CHANGED messages when:
//   - TikTok briefly shows two videos at ≥80% visibility during a scroll
//   - URL polling fires while IntersectionObserver also fires
//   - Rapid scroll causes multiple URL changes within 1s

let lastUrl = location.href;
let reelChangeCooldown = false;

function fireReelChanged() {
  if (reelChangeCooldown) return;
  reelChangeCooldown = true;
  setTimeout(() => { reelChangeCooldown = false; }, 1000); // 1s debounce
  console.log('[NeuralFeed] REEL_CHANGED fired', location.href);
  chrome.runtime.sendMessage({ action: ACTIONS.REEL_CHANGED }, (response) => {
    if (chrome.runtime.lastError) {
      console.log('[NeuralFeed] REEL_CHANGED lastError:', chrome.runtime.lastError.message);
    } else {
      console.log('[NeuralFeed] REEL_CHANGED response from SW:', JSON.stringify(response));
    }
  });
}

// ─── URL polling — Instagram Reels + YouTube Shorts ──────────────────────────
// Instagram and YouTube Shorts change the URL with each reel. Poll every 500ms.

setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    fireReelChanged();
  }
}, 500);

// ─── IntersectionObserver — TikTok ───────────────────────────────────────────
// TikTok keeps the same URL across reels. Trigger REEL_CHANGED when a new
// <video> element enters the viewport at ≥80% visibility.

const intersectionObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting && entry.intersectionRatio >= 0.8) {
      fireReelChanged();
    }
  }
}, { threshold: [0.8] });

// Track observed elements to avoid double-observing the same video
function observeVideos() {
  document.querySelectorAll('video').forEach((v) => {
    if (!v._nfObserved) {
      v._nfObserved = true;
      intersectionObserver.observe(v);
    }
  });
}

// Observe any videos already in the DOM on script load
observeVideos();

// ─── MutationObserver — infinite scroll ──────────────────────────────────────
// Instagram, TikTok, and YouTube Shorts all add video elements dynamically
// as the user scrolls. Watch for new <video> tags and observe them.

new MutationObserver(observeVideos)
  .observe(document.body, { childList: true, subtree: true });
