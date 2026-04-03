// offscreen.js — MediaRecorder + HF Space POST (runs in Chrome Offscreen Document)
// This is the only context in MV3 where we can use MediaRecorder.
//
// Flow:
//   1. service_worker.js sends CAPTURE_READY with tabId
//   2. offscreen.js calls chrome.tabCapture.capture() → MediaStream
//   3. MediaRecorder assembles .webm chunks → Blob
//   4. On STOP_CAPTURE (or reel ends), POST blob to HF Space /analyze
//   5. Parse JSON response, send CAPTURE_RESULT back to service_worker.js

'use strict';

let mediaRecorder = null;
let recordedChunks = [];
let currentReelId = null;
let captureStream = null;

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action } = message;

  if (action === ACTIONS.CAPTURE_READY) {
    handleCaptureReady(message).then(sendResponse).catch((err) => {
      console.error('[NeuralFeed Offscreen] Capture error:', err);
      sendResponse({ error: err.message });
      reportError(message.reelId, err.message);
    });
    return true;
  }

  if (action === ACTIONS.STOP_CAPTURE) {
    handleStopCapture(message.reelId);
    sendResponse({ ok: true });
    return false;
  }
});

// ─── Start capture ────────────────────────────────────────────────────────────

async function handleCaptureReady({ reelId, streamId }) {
  // Guard: don't start a second capture if one is already running
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    console.warn('[NeuralFeed Offscreen] Capture already in progress — stopping previous');
    stopAndProcess();
  }

  currentReelId = reelId;
  recordedChunks = [];

  // Use streamId from service_worker (chrome.tabCapture.getMediaStreamId).
  // chrome.tabCapture.capture is only available in SW, not in offscreen documents.
  if (!streamId) {
    throw new Error('tabCapture stream ID is missing. Make sure the target tab is active and in the foreground.');
  }
  captureStream = await navigator.mediaDevices.getUserMedia({
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
  });

  // Use explicit bitrate to keep .webm files to ~9MB for a 30s clip
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
    ? 'video/webm;codecs=vp8'
    : 'video/webm';

  mediaRecorder = new MediaRecorder(captureStream, {
    mimeType,
    videoBitsPerSecond: 2_500_000,
    audioBitsPerSecond: 128_000,
  });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };

  const capturedReelId = reelId; // Close over reelId now, before currentReelId can change
  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: mimeType });
    recordedChunks = [];
    analyzeBlob(blob, capturedReelId);
  };

  mediaRecorder.onerror = (e) => {
    reportError(currentReelId, `MediaRecorder error: ${e.error?.message || 'unknown'}`);
  };

  // Collect data every 1s so we can detect premature tab closure
  mediaRecorder.start(1000);
  return { ok: true };
}

// ─── Stop capture ─────────────────────────────────────────────────────────────

function handleStopCapture(reelId) {
  if (reelId !== currentReelId) return; // Different reel — ignore
  stopAndProcess();
}

function stopAndProcess() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (captureStream) {
    captureStream.getTracks().forEach(t => t.stop());
    captureStream = null;
  }
}

// ─── POST to HuggingFace Space ────────────────────────────────────────────────

async function analyzeBlob(blob, reelId) {
  if (!reelId) return;

  const formData = new FormData();
  formData.append('video', blob, `reel-${reelId}.webm`);
  formData.append('reel_id', reelId);

  let response;
  try {
    response = await fetchWithRetry(
      `${HF_SPACE_URL}/analyze`,
      {
        method: 'POST',
        headers: { 'X-API-Key': HF_API_KEY },
        body: formData,
      },
      { retries: 1, retryDelayMs: 10_000 }
    );
  } catch (err) {
    reportError(reelId, `Network error: ${err.message}`);
    return;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    reportError(reelId, `HF Space returned ${response.status}: ${body.slice(0, 200)}`);
    return;
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    reportError(reelId, `Invalid JSON response from HF Space`);
    return;
  }

  chrome.runtime.sendMessage({
    action: ACTIONS.CAPTURE_RESULT,
    reelId,
    data,
  });
}

// ─── Fetch with retry ─────────────────────────────────────────────────────────

async function fetchWithRetry(url, options, { retries = 1, retryDelayMs = 10_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok && retries > 0 && (res.status === 429 || res.status === 503)) {
      await sleep(retryDelayMs);
      return fetchWithRetry(url, options, { retries: retries - 1, retryDelayMs });
    }
    return res;
  } catch (err) {
    clearTimeout(timeout);
    if (retries > 0 && err.name !== 'AbortError') {
      await sleep(retryDelayMs);
      return fetchWithRetry(url, options, { retries: retries - 1, retryDelayMs });
    }
    throw err;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Error reporting ──────────────────────────────────────────────────────────

function reportError(reelId, error) {
  console.error(`[NeuralFeed Offscreen] ${error}`);
  chrome.runtime.sendMessage({
    action: ACTIONS.CAPTURE_RESULT,
    reelId,
    error,
  });
}
