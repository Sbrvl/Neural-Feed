// service_worker.js — Extension orchestration layer (MV3 background service worker)
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │  SESSION STATE MACHINE                                                   │
// │                                                                          │
// │  IDLE ──(START_SESSION)──► CAPTURING ──(REEL_CHANGED)──► CAPTURING      │
// │    ▲                           │                              │          │
// │    └──────(STOP_SESSION)───────┘◄─────────────────────────────          │
// │                                                                          │
// │  All state is persisted in chrome.storage.session so SW restarts        │
// │  (which happen after ~30s idle) don't lose the session.                 │
// │                                                                          │
// │  State keys:                                                             │
// │    sessionActive  — bool: is the user recording?                        │
// │    currentReelId  — string|null: reel currently being captured          │
// │    currentTabId   — number|null: tab the session started on             │
// │    reelCount      — number: reels completed this session                │
// │    totalBrainRot, totalDmn, totalFpn, totalReward — running sums        │
// │    lastReel       — object|null: most recent result payload             │
// └──────────────────────────────────────────────────────────────────────────┘

'use strict';

importScripts('constants.js');

console.log('[NeuralFeed SW] ▶ Service Worker instance started');

// ─── Offscreen document management ────────────────────────────────────────────

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');

async function ensureOffscreenDocument() {
  // chrome.offscreen.getContexts is Chrome 116+ only.
  // Instead, attempt to create and catch the "already exists" error.
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Tab capture and MediaRecorder for reel analysis',
    });
    // Give the offscreen document a moment to initialize its message listeners
    await new Promise(resolve => setTimeout(resolve, 500));
  } catch (err) {
    // "Only a single offscreen document may be created" means it already exists — fine.
    if (!err.message?.toLowerCase().includes('single') &&
        !err.message?.toLowerCase().includes('already')) {
      throw err;
    }
  }
}

async function closeOffscreenDocument() {
  await chrome.offscreen.closeDocument().catch(() => {});
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
    // Receiving this event keeps the SW alive — no-op intentional.
  }
});

// ─── Session state (chrome.storage.session) ───────────────────────────────────
// chrome.storage.session survives SW restarts within the same browser session.
// All mutable state that must survive SW sleep goes here.

async function getSessionState() {
  const defaults = {
    sessionActive: false,
    analysisInProgress: false,
    currentReelId: null,
    currentTabId: null,
    reelCount: 0,
    totalBrainRot: 0,
    totalDmn: 0,
    totalFpn: 0,
    totalReward: 0,
    lastReel: null,
  };
  return await chrome.storage.session.get(defaults);
}

async function saveSessionState(patch) {
  await chrome.storage.session.set(patch);
}

function getAverages(state) {
  const n = Math.max(state.reelCount, 1);
  return {
    brain_rot:          state.totalBrainRot / n,
    dmn:                state.totalDmn / n,
    fpn:                state.totalFpn / n,
    reward:             state.totalReward / n,
    reelCount:          state.reelCount,
    active:             state.sessionActive,
    analysisInProgress: state.analysisInProgress,
    lastReel:           state.lastReel,
  };
}

// ─── Badge ────────────────────────────────────────────────────────────────────

function updateBadge(brainRotAvg) {
  // Compare numeric value directly — never compare .toFixed() strings with >=
  chrome.action.setBadgeText({ text: brainRotAvg.toFixed(1) });
  const color = brainRotAvg >= 7 ? '#ea4335'
              : brainRotAvg >= 4 ? '#fbbc04'
              : '#34a853';
  chrome.action.setBadgeBackgroundColor({ color });
}

// ─── Platform helpers ─────────────────────────────────────────────────────────

const SUPPORTED_PLATFORMS = ['instagram.com', 'tiktok.com', 'youtube.com'];

function isSupportedUrl(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace('www.', '');
    return SUPPORTED_PLATFORMS.some(p => host.includes(p));
  } catch {
    return false;
  }
}

function getPlatform(url) {
  if (!url) return 'unknown';
  try {
    const host = new URL(url).hostname.replace('www.', '');
    if (host.includes('instagram.com')) return 'instagram';
    if (host.includes('tiktok.com'))    return 'tiktok';
    if (host.includes('youtube.com'))   return 'youtube';
  } catch {}
  return 'unknown';
}

// ─── Session history ──────────────────────────────────────────────────────────

async function saveReelResult(result) {
  const { sessionHistory = [] } = await chrome.storage.local.get('sessionHistory');
  sessionHistory.push({ ...result, savedAt: Date.now() });
  if (sessionHistory.length > 200) sessionHistory.splice(0, sessionHistory.length - 200);
  await chrome.storage.local.set({ sessionHistory, lastResult: result });
}

// ─── Notify popup ─────────────────────────────────────────────────────────────

function notifyPopup(action, payload) {
  chrome.runtime.sendMessage({ action, ...payload }).catch(() => {
    // Popup may not be open — ignore
  });
}

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[NeuralFeed SW] Raw message received:', message.action, 'from tab:', sender.tab?.id);
  handleMessage(message, sender).then(sendResponse).catch((err) => {
    console.error('[NeuralFeed SW] Message handler error:', err);
    sendResponse({ error: err.message });
  });
  return true;
});

async function handleMessage(message, sender) {
  const { action } = message;

  // ── START_SESSION ──────────────────────────────────────────────────────────
  if (action === ACTIONS.START_SESSION) {
    console.log('[NeuralFeed SW] START_SESSION received');
    // sender.tab is undefined for popup messages — must query active tab directly
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab) return { ok: false, error: 'No active tab found.' };

    if (!isSupportedUrl(tab.url)) {
      return { ok: false, error: 'Open Instagram, TikTok, or YouTube Shorts first.' };
    }

    let streamId;
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    } catch (err) {
      console.error('[NeuralFeed SW] tabCapture failed on START_SESSION:', err.message);
      return { ok: false, error: `Tab capture failed: ${err.message}` };
    }

    const reelId = `${tab.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    await ensureOffscreenDocument();

    // Clear stale queue from any previous session before starting fresh
    await saveQueue([]);

    startKeepalive(reelId);
    await enqueue({ reelId, platform: getPlatform(tab.url), url: tab.url, startedAt: Date.now() });

    // Reset session state and record this tab
    await saveSessionState({
      sessionActive: true,
      analysisInProgress: true,
      currentReelId: reelId,
      currentTabId: tab.id,
      reelCount: 0,
      totalBrainRot: 0,
      totalDmn: 0,
      totalFpn: 0,
      totalReward: 0,
      lastReel: null,
    });

    chrome.runtime.sendMessage({
      action: ACTIONS.CAPTURE_READY,
      reelId,
      streamId,
    }).catch((err) => {
      console.error('[NeuralFeed SW] Failed to reach offscreen document:', err.message);
    });

    return { ok: true };
  }

  // ── STOP_SESSION ───────────────────────────────────────────────────────────
  if (action === ACTIONS.STOP_SESSION) {
    const state = await getSessionState();
    if (state.currentReelId) {
      // Stop the recorder — final blob will still POST to server asynchronously.
      // Do NOT close the offscreen document: the POST is still in flight.
      chrome.runtime.sendMessage({
        action: ACTIONS.STOP_CAPTURE,
        reelId: state.currentReelId,
      }).catch(() => {});
      stopKeepalive(state.currentReelId);
    }
    await saveSessionState({
      sessionActive: false,
      currentReelId: null,
      currentTabId: null,
    });
    chrome.action.setBadgeText({ text: '' });
    return { ok: true };
  }

  // ── REEL_CHANGED ───────────────────────────────────────────────────────────
  if (action === ACTIONS.REEL_CHANGED) {
    const state = await getSessionState();
    const senderTabId = sender.tab?.id;

    console.log(`[NeuralFeed SW] REEL_CHANGED received — sessionActive=${state.sessionActive}, senderTab=${senderTabId}, currentTab=${state.currentTabId}`);

    if (!state.sessionActive) {
      console.warn('[NeuralFeed SW] REEL_CHANGED ignored — session not active');
      return { ok: false }; // Session not running — ignore
    }

    // Tab filter: only accept REEL_CHANGED from the tab that started the session.
    if (senderTabId && state.currentTabId && senderTabId !== state.currentTabId) {
      console.warn(`[NeuralFeed SW] REEL_CHANGED ignored — wrong tab (${senderTabId} vs ${state.currentTabId})`);
      return { ok: false }; // Message from wrong tab — ignore
    }

    // Rotate keepalive from old reel to new reel
    if (state.currentReelId) stopKeepalive(state.currentReelId);
    const newReelId = `${state.currentTabId || senderTabId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    startKeepalive(newReelId);

    // Enqueue metadata for the new reel so CAPTURE_RESULT can correlate it
    const tabUrl = sender.tab?.url || '';
    await enqueue({ reelId: newReelId, platform: getPlatform(tabUrl), url: tabUrl, startedAt: Date.now() });
    await saveSessionState({ currentReelId: newReelId });

    // Tell offscreen doc to split at this reel boundary.
    // The offscreen doc restarts its MediaRecorder on the SAME captureStream —
    // no new getMediaStreamId() call needed (and Chrome won't allow one anyway
    // while the first capture is still active).
    chrome.runtime.sendMessage({
      action: ACTIONS.REEL_CHANGED,
      reelId: newReelId,
    }).catch((err) => {
      console.error('[NeuralFeed SW] Failed to send REEL_CHANGED to offscreen:', err.message);
    });

    console.log(`[NeuralFeed SW] Reel split → new reel: ${newReelId}`);
    return { ok: true };
  }

  // ── GET_SESSION_STATE ──────────────────────────────────────────────────────
  if (action === ACTIONS.GET_SESSION_STATE) {
    const state = await getSessionState();
    return getAverages(state);
  }

  // ── CAPTURE_RESULT ─────────────────────────────────────────────────────────
  if (action === ACTIONS.CAPTURE_RESULT) {
    const { reelId, data, error } = message;
    stopKeepalive(reelId);
    const meta = await dequeue(reelId);

    if (error) {
      console.error(`[NeuralFeed SW] Capture/analysis error for ${reelId}:`, error);
      notifyPopup(ACTIONS.ANALYSIS_ERROR, { reelId, error });
      return { ok: false };
    }

    if (!meta) {
      // reelId not in queue — stale result from a stopped session, discard
      console.warn(`[NeuralFeed SW] Unknown reelId: ${reelId} — discarding`);
      return { ok: false };
    }

    const result = { ...data, reelId, platform: meta.platform, capturedAt: meta.startedAt };
    await saveReelResult(result);

    // Update session running totals
    const state = await getSessionState();
    const newCount = state.reelCount + 1;
    const patch = {
      reelCount:      newCount,
      totalBrainRot:  state.totalBrainRot + (data.brain_rot || 0),
      totalDmn:       state.totalDmn      + (data.dmn       || 0),
      totalFpn:       state.totalFpn      + (data.fpn       || 0),
      totalReward:    state.totalReward   + (data.reward     || 0),
      lastReel:       result,
    };
    await saveSessionState(patch);

    // Update badge with rolling brain_rot average
    const avgBrainRot = patch.totalBrainRot / newCount;
    updateBadge(avgBrainRot);

    // Push update to popup (if open)
    const updatedState = await getSessionState();
    notifyPopup(ACTIONS.SESSION_UPDATE, { state: getAverages(updatedState) });
    notifyPopup(ACTIONS.ANALYSIS_COMPLETE, { reelId, result });

    return { ok: true };
  }

  // ── OPEN_SIDE_PANEL ────────────────────────────────────────────────────────
  if (action === ACTIONS.OPEN_SIDE_PANEL) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      await chrome.sidePanel.open({ tabId: tabs[0].id });
    }
    return { ok: true };
  }

  return { error: `Unknown action: ${action}` };
}
