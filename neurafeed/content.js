// content.js — Reel detection for Instagram, TikTok, YouTube Shorts
// Injected into matching pages by manifest.json content_scripts.
// Detects when a reel enters the viewport and messages the service worker.

'use strict';

// Platform-specific selectors and fallbacks.
// Primary selectors use platform obfuscated class names — these WILL change.
// Fallback selectors target semantic video elements and are more stable.
const PLATFORMS = {
  'instagram.com': {
    selector: '.x1lliihq',
    fallback: 'video[playsinline]',
    pathCheck: () => window.location.pathname.includes('/reels/') ||
                     window.location.pathname === '/' ||
                     window.location.href.includes('instagram.com'),
  },
  'tiktok.com': {
    selector: '[class*="DivVideoContainer"]',
    fallback: 'video[autoplay]',
    pathCheck: () => true,
  },
  'youtube.com': {
    selector: 'ytd-reel-video-renderer',
    fallback: 'video[src]',
    pathCheck: () => window.location.pathname === '/shorts/' ||
                     window.location.pathname.startsWith('/shorts/'),
  },
};

// Detect current platform from hostname
function detectPlatform() {
  const host = window.location.hostname.replace('www.', '');
  for (const [key, config] of Object.entries(PLATFORMS)) {
    if (host.includes(key) && config.pathCheck()) return { key, config };
  }
  return null;
}

const platform = detectPlatform();
if (!platform) {
  // Not a supported page — do nothing
  // (content_scripts matches are broad; exit gracefully on non-reel pages)
} else {
  let currentReelId = null;
  let currentReelElement = null;
  let mutationCount = 0;
  let noMutationWarningTimer = null;

  // Generate a unique ID for each reel we detect
  function generateReelId() {
    return `${platform.key}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  // Called when a new reel becomes fully visible (≥80% in viewport)
  function onReelVisible(reelElement) {
    const reelId = generateReelId();
    currentReelId = reelId;
    currentReelElement = reelElement;
    chrome.runtime.sendMessage({
      action: ACTIONS.START_CAPTURE,
      reelId,
      platform: platform.key,
      url: window.location.href,
    });
  }

  // Called when the current reel exits view (next reel replacing it)
  function onReelHidden() {
    if (currentReelId) {
      chrome.runtime.sendMessage({
        action: ACTIONS.STOP_CAPTURE,
        reelId: currentReelId,
      });
      currentReelId = null;
      currentReelElement = null;
    }
  }

  // IntersectionObserver: fires when reel container crosses ≥80% visibility threshold
  const intersectionObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.8) {
          onReelVisible(entry.target);
        } else if (!entry.isIntersecting && entry.target === currentReelElement) {
          // Only stop capture when the currently-active reel leaves view
          onReelHidden();
        }
      }
    },
    { threshold: [0.8] }
  );

  // Track already-observed elements to avoid double-observing
  const observedElements = new WeakSet();

  function observeReelElement(el) {
    if (!observedElements.has(el)) {
      observedElements.add(el);
      intersectionObserver.observe(el);
    }
  }

  // Find and observe reel elements using primary selector, fall back to video elements
  function findAndObserveReels() {
    const { selector, fallback } = platform.config;

    let elements = document.querySelectorAll(selector);
    if (elements.length === 0) {
      elements = document.querySelectorAll(fallback);
      if (elements.length > 0) {
        console.warn(
          `[NeuralFeed] Primary selector "${selector}" found 0 elements. ` +
          `Using fallback "${fallback}". The platform may have updated its DOM. ` +
          `Please report at github.com/YOUR_REPO/issues`
        );
      }
    }
    elements.forEach(observeReelElement);
  }

  // MutationObserver: watches for new reel containers added to the DOM
  // (Instagram/TikTok load reels dynamically as you scroll)
  const mutationObserver = new MutationObserver((mutations) => {
    mutationCount += mutations.length;
    findAndObserveReels();
  });

  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Initial scan for any reels already in the DOM
  findAndObserveReels();

  // Watchdog: if no mutations fire in 30 seconds, the selector may be broken
  function resetNoMutationWarning() {
    clearTimeout(noMutationWarningTimer);
    noMutationWarningTimer = setTimeout(() => {
      if (mutationCount === 0) {
        console.warn(
          `[NeuralFeed] No DOM mutations detected in 30 seconds on ${platform.key}. ` +
          `Reel detection may not be working. Check the platform's DOM structure.`
        );
      }
      mutationCount = 0;
      resetNoMutationWarning();
    }, 30_000);
  }
  resetNoMutationWarning();
}
