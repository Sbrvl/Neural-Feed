// offscreen.js — MediaRecorder + AWS EC2 POST (runs in Chrome Offscreen Document)
// This is the only context in MV3 where we can use MediaRecorder.
//
// Architecture: one persistent captureStream per session.
// The stream is acquired once on CAPTURE_READY and stays alive until STOP_CAPTURE.
// Between reels, only the MediaRecorder is restarted — no new getUserMedia call needed.
//
// ┌──────────────────────────────────────────────────────────────────┐
// │  Message flow                                                    │
// │                                                                  │
// │  CAPTURE_READY {reelId, streamId}                               │
// │    → getUserMedia(streamId) → captureStream                      │
// │    → startRecorderForReel(reelId)                                │
// │                                                                  │
// │  REEL_CHANGED {reelId}                                          │
// │    → activeRecorder.stop() → onstop → POST blob (prev reel)     │
// │    → startRecorderForReel(newReelId)  ← same captureStream       │
// │                                                                  │
// │  STOP_CAPTURE {reelId}   (session end)                          │
// │    → activeRecorder.stop() → onstop → POST blob (final reel)    │
// │    → captureStream.getTracks().stop()                            │
// └──────────────────────────────────────────────────────────────────┘
//
// NOTE: CPU inference on AWS EC2 takes 5-30 min. Timeout = 35 min.
//       With MOCK_TRIBE=1 (demo mode) responses come back in ~1s.

'use strict';

let captureStream  = null;  // Alive for the whole session
let activeRecorder = null;  // Current MediaRecorder (replaced each reel)
let currentReelId  = null;
let audioCtx       = null;  // Web Audio context for audio passthrough to speakers

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getMimeType() {
  return MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
    ? 'video/webm;codecs=vp8'
    : 'video/webm';
}

// Each recorder owns its own chunks array and reelId via closure.
// This prevents cross-reel data mixing when two recorders overlap.
function startRecorderForReel(reelId) {
  const mimeType = getMimeType();
  const chunks = [];
  const capturedReelId = reelId;

  const recorder = new MediaRecorder(captureStream, {
    mimeType,
    videoBitsPerSecond: 2_500_000,
    audioBitsPerSecond: 128_000,
  });

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  recorder.onstop = () => {
    console.log(`[NeuralFeed Offscreen] Reel ended: ${capturedReelId} (${chunks.length} chunks)`);
    const blob = new Blob(chunks, { type: mimeType });
    analyzeBlob(blob, capturedReelId);
  };

  recorder.onerror = (e) => {
    reportError(capturedReelId, `MediaRecorder error: ${e.error?.message || 'unknown'}`);
  };

  recorder.start(1000); // Collect data every 1s
  console.log(`[NeuralFeed Offscreen] Recording started: ${capturedReelId}`);
  return recorder;
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action } = message;

  if (action === ACTIONS.CAPTURE_READY) {
    handleCaptureReady(message).then(sendResponse).catch((err) => {
      console.error('[NeuralFeed Offscreen] CAPTURE_READY error:', err);
      sendResponse({ error: err.message });
      reportError(message.reelId, err.message);
    });
    return true;
  }

  if (action === ACTIONS.REEL_CHANGED) {
    console.log(`[NeuralFeed Offscreen] REEL_CHANGED received — newReelId=${message.reelId}, captureStream=${captureStream ? 'active' : 'null'}`);
    handleReelChanged(message.reelId);
    sendResponse({ ok: true });
    return false;
  }

  if (action === ACTIONS.STOP_CAPTURE) {
    handleStopCapture(message.reelId);
    sendResponse({ ok: true });
    return false;
  }
});

// ─── CAPTURE_READY — session start ────────────────────────────────────────────

async function handleCaptureReady({ reelId, streamId }) {
  // Tear down any previous session
  if (activeRecorder && activeRecorder.state !== 'inactive') {
    activeRecorder.stop();
    activeRecorder = null;
  }
  if (captureStream) {
    captureStream.getTracks().forEach(t => t.stop());
    captureStream = null;
  }

  if (!streamId) {
    throw new Error('streamId missing — make sure the target tab is active.');
  }

  captureStream = await navigator.mediaDevices.getUserMedia({
    video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
  });

  // Route captured audio back to speakers — without this the tab goes silent during capture.
  audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(captureStream);
  source.connect(audioCtx.destination);

  currentReelId  = reelId;
  activeRecorder = startRecorderForReel(reelId);
  return { ok: true };
}

// ─── REEL_CHANGED — reel boundary ─────────────────────────────────────────────
// Stop the current recorder (triggers blob assembly + POST for the PREVIOUS reel).
// Immediately start a new recorder on the same captureStream.

function handleReelChanged(newReelId) {
  if (!captureStream) {
    console.warn('[NeuralFeed Offscreen] REEL_CHANGED but no active stream — session not started?');
    return;
  }

  // Stop old recorder — its onstop closure POSTs the blob with the old reelId
  if (activeRecorder && activeRecorder.state !== 'inactive') {
    activeRecorder.stop();
  }

  // Start new recorder on the same persistent stream (no new getUserMedia needed)
  currentReelId  = newReelId;
  activeRecorder = startRecorderForReel(newReelId);
}

// ─── STOP_CAPTURE — session end ───────────────────────────────────────────────
// Stop the final recorder (posts the last blob) and release the stream.

function handleStopCapture(reelId) {
  // Ignore stale stop messages for reels we no longer track
  if (reelId && reelId !== currentReelId) {
    console.warn(`[NeuralFeed Offscreen] STOP_CAPTURE for unknown reel ${reelId} (current: ${currentReelId}) — ignoring`);
    return;
  }

  if (activeRecorder && activeRecorder.state !== 'inactive') {
    activeRecorder.stop(); // onstop assembles and POSTs the final blob
  }
  activeRecorder = null;

  // Stop the stream tracks to release the tab capture
  if (captureStream) {
    captureStream.getTracks().forEach(t => t.stop());
    captureStream = null;
  }
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  currentReelId = null;
}

// ─── POST to AWS EC2 /analyze ─────────────────────────────────────────────────

async function analyzeBlob(blob, reelId) {
  if (!reelId) return;
  if (blob.size < 1000) {
    console.warn(`[NeuralFeed Offscreen] Blob too small for ${reelId} (${blob.size} bytes) — skipping POST`);
    return;
  }

  console.log(`[NeuralFeed Offscreen] POSTing ${(blob.size / 1024).toFixed(0)} KB for reel ${reelId}`);

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
    reportError(reelId, `Server returned ${response.status}: ${body.slice(0, 200)}`);
    return;
  }

  let data;
  try {
    data = await response.json();
  } catch {
    reportError(reelId, 'Invalid JSON response from server');
    return;
  }

  chrome.runtime.sendMessage({ action: ACTIONS.CAPTURE_RESULT, reelId, data });
}

// ─── Fetch with retry ─────────────────────────────────────────────────────────

async function fetchWithRetry(url, options, { retries = 1, retryDelayMs = 10_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35 * 60 * 1000);

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

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ─── Error reporting ──────────────────────────────────────────────────────────

function reportError(reelId, error) {
  console.error(`[NeuralFeed Offscreen] ${error}`);
  chrome.runtime.sendMessage({ action: ACTIONS.CAPTURE_RESULT, reelId, error });
}
