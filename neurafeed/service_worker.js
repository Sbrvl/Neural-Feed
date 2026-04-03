// service_worker.js — Extension orchestration layer (MV3 background service worker)
// Responsibilities:
//   - Receive START_CAPTURE / STOP_CAPTURE messages from content.js
//   - Create/manage the offscreen document (MediaRecorder lives there)
//   - Maintain chrome.alarms keepalive during active capture
//   - Manage the FIFO reel queue (max 3 pending)
//   - Forward analysis results to popup.js
//
// IMPORTANT: MediaRecorder is NOT available in service workers (no DOM access).
// All capture work happens in offscreen.js via the Chrome Offscreen Document API.

'use strict';

importScripts('constants.js');

// ─── Offscreen document management ────────────────────────────────────────────

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');

async function ensureOffscreenDocument() {
  // Chrome only allows one offscreen document per extension at a time.
  const existing = await chrome.offscreen.getContexts({
    documentUrls: [OFFSCREEN_URL],
  }).catch(() => []);
  if (existing.length > 0) return; // Already exists — reuse it
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Tab capture and MediaRecorder for reel analysis',
  });
}

async function closeOffscreenDocument() {
  const existing = await chrome.offscreen.getContexts({
    documentUrls: [OFFSCREEN_URL],
  }).catch(() => []);
  if (existing.length > 0) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

// ─── FIFO queue (persisted in chrome.storage.local) ───────────────────────────

async function getQueue() {
  const { reelQueue = [] } = await chrome.storage.local.get('reelQueue');
  return reelQueue;
}

async function saveQueue(queue) {
  await chrome.storage.local.set({ reelQueue: queue });
}

async function enqueue(reelMeta) {
  let queue = await getQueue();
  if (queue.length >= QUEUE_MAX_DEPTH) {
    const dropped = queue.shift();
    console.warn(`[NeuralFeed SW] Queue full — dropped oldest reel: ${dropped.reelId}`);
  }
  queue.push(reelMeta);
  await saveQueue(queue);
}

async function dequeue(reelId) {
  let queue = await getQueue();
  const idx = queue.findIndex(r => r.reelId === reelId);
  if (idx === -1) return null;
  const [item] = queue.splice(idx, 1);
  await saveQueue(queue);
  return item;
}

// ─── chrome.alarms keepalive ──────────────────────────────────────────────────
// MV3 service workers terminate after ~30s of inactivity.
// While a reel is being captured (could be 60s+), we ping an alarm every 20s.

let activeCaptures = new Set();

function startKeepalive(reelId) {
  activeCaptures.add(reelId);
  chrome.alarms.create(ALARM_KEEPALIVE, { periodInMinutes: 20 / 60 });
}

function stopKeepalive(reelId) {
  activeCaptures.delete(reelId);
  if (activeCaptures.size === 0) {
    chrome.alarms.clear(ALARM_KEEPALIVE);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_KEEPALIVE) {
    // Just receiving this event wakes the service worker — that's all we need.
    // No-op intentional.
  }
});

// ─── Session history helpers ──────────────────────────────────────────────────

async function saveReelResult(result) {
  const { sessionHistory = [] } = await chrome.storage.local.get('sessionHistory');
  sessionHistory.push({
    ...result,
    savedAt: Date.now(),
  });
  // Keep last 200 reels
  if (sessionHistory.length > 200) sessionHistory.splice(0, sessionHistory.length - 200);
  await chrome.storage.local.set({ sessionHistory, lastResult: result });
}

// ─── Notify popup (if open) ───────────────────────────────────────────────────

function notifyPopup(action, payload) {
  chrome.runtime.sendMessage({ action, ...payload }).catch(() => {
    // Popup may not be open — ignore the error
  });
}

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch((err) => {
    console.error('[NeuralFeed SW] Message handler error:', err);
    sendResponse({ error: err.message });
  });
  return true; // Keep message channel open for async response
});

async function handleMessage(message, sender) {
  const { action } = message;

  if (action === ACTIONS.START_CAPTURE) {
    const { reelId, platform, url } = message;
    await enqueue({ reelId, platform, url, startedAt: Date.now() });
    startKeepalive(reelId);
    await ensureOffscreenDocument();
    // Get stream ID from tabCapture (only available in SW, not offscreen documents).
    // Offscreen doc uses this to call getUserMedia with chromeMediaSource: 'tab'.
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: sender.tab?.id,
    });
    // Forward to offscreen.js to start MediaRecorder
    chrome.runtime.sendMessage({
      action: ACTIONS.CAPTURE_READY,
      reelId,
      streamId,
    });
    return { ok: true };
  }

  if (action === ACTIONS.STOP_CAPTURE) {
    const { reelId } = message;
    chrome.runtime.sendMessage({ action: ACTIONS.STOP_CAPTURE, reelId });
    return { ok: true };
  }

  if (action === ACTIONS.CAPTURE_RESULT) {
    // Received from offscreen.js after blob is assembled and POST completes
    const { reelId, data, error } = message;
    stopKeepalive(reelId);
    const meta = await dequeue(reelId);

    if (error) {
      console.error(`[NeuralFeed SW] Capture/analysis error for ${reelId}:`, error);
      notifyPopup(ACTIONS.ANALYSIS_ERROR, { reelId, error });
      return { ok: false };
    }

    if (!meta) {
      // reel_id not in queue — stale result from a previous session, discard
      console.warn(`[NeuralFeed SW] Received result for unknown reelId: ${reelId} — discarding`);
      return { ok: false };
    }

    const result = { ...data, reelId, platform: meta.platform, capturedAt: meta.startedAt };
    await saveReelResult(result);
    notifyPopup(ACTIONS.ANALYSIS_COMPLETE, { reelId, result });
    return { ok: true };
  }

  if (action === ACTIONS.OPEN_SIDE_PANEL) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      await chrome.sidePanel.open({ tabId: tabs[0].id });
    }
    return { ok: true };
  }

  return { error: `Unknown action: ${action}` };
}
