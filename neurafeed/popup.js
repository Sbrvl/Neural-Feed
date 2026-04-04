// popup.js — Extension popup for NeuralFeed session mode
//
// State flow:
//   1. On open: GET_SESSION_STATE → renderPopup(state)
//   2. User clicks START/STOP → send START_SESSION / STOP_SESSION → renderPopup on response
//   3. SW pushes SESSION_UPDATE while popup is open → renderPopup(msg.state)

'use strict';

// ─── Module-level session state ───────────────────────────────────────────────
// Set from GET_SESSION_STATE response and SESSION_UPDATE messages.
// Never assumed from thin air.

let sessionActive = false;

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const toggleBtn    = document.getElementById('toggleBtn');
const errorBanner  = document.getElementById('errorBanner');
const waitingCard  = document.getElementById('waitingCard');
const sessionCard  = document.getElementById('sessionCard');
const reelCountEl  = document.getElementById('reelCount');
const lastReelEl   = document.getElementById('lastReelContent');
const dashboardBtn = document.getElementById('dashboardBtn');

// ─── Render ───────────────────────────────────────────────────────────────────

function renderPopup(state) {
  if (!state) return;
  sessionActive = state.active || false;

  // Toggle button label and style
  if (sessionActive) {
    toggleBtn.textContent = '⏹ STOP RECORDING';
    toggleBtn.classList.add('active');
  } else {
    toggleBtn.textContent = '▶ START RECORDING';
    toggleBtn.classList.remove('active');
  }

  // Decide which card to show
  const hasData = (state.reelCount > 0) || sessionActive || state.analysisInProgress;
  waitingCard.style.display = hasData ? 'none' : '';
  sessionCard.style.display = hasData ? '' : 'none';

  if (!hasData) return;

  // Reel count
  reelCountEl.textContent = state.reelCount || 0;

  // Rolling average bars (only meaningful once at least 1 reel has completed)
  if (state.reelCount > 0) {
    updateAvgBar('BrainRot', state.brain_rot, 10);
    updateAvgBar('Dmn',      state.dmn,       10);
    updateAvgBar('Fpn',      state.fpn,       10);
    updateAvgBar('Reward',   state.reward,    10);
  }

  // Last reel section
  if (state.lastReel) {
    renderLastReel(state.lastReel);
  } else if (sessionActive || state.analysisInProgress) {
    lastReelEl.innerHTML = `
      <div class="analyzing-row">
        <div class="mini-spinner"></div>
        <span>TRIBE v2 is analyzing your reels — results in 5-30 min. You can close this popup.</span>
      </div>`;
  } else {
    lastReelEl.innerHTML = '';
  }
}

function updateAvgBar(key, value, max) {
  const barEl = document.getElementById(`avgBar${key}`);
  const valEl = document.getElementById(`avgVal${key}`);
  if (!barEl || !valEl) return;
  const pct = value != null ? Math.min(100, (value / max) * 100) : 0;
  barEl.style.width = `${pct.toFixed(1)}%`;
  valEl.textContent = value != null ? value.toFixed(1) : '—';
}

function renderLastReel(result) {
  const { brain_rot, dmn, fpn, reward, platform } = result;
  const score = Math.max(0, Math.round((brain_rot || 0) * 10) / 10);
  const scoreClass = score <= 4 ? 'green' : score <= 7 ? 'yellow' : 'red';
  const scoreLabel = score <= 4 ? 'Active engagement'
                   : score <= 7 ? 'Mixed engagement'
                   : 'Passive consumption';
  const platformTag = platform
    ? `<span class="last-score-platform">${escapeHtml(platform)}</span>`
    : '';

  // Scale the mini network bars relative to each other
  const maxNet = Math.max(dmn || 0, fpn || 0, reward || 0, 0.01);

  lastReelEl.innerHTML = `
    <div class="last-reel-score">
      <div class="last-score-number ${scoreClass}">${score}</div>
      <div class="last-score-info">
        <div class="last-score-label">Brain Rot Score</div>
        <div class="last-score-title">${escapeHtml(scoreLabel)}</div>
        ${platformTag}
      </div>
    </div>
    <div class="network-row">
      <span class="network-label">DMN</span>
      <div class="network-bar-bg">
        <div class="network-bar-fill bar-dmn" style="width:${pct(dmn, maxNet)}%"></div>
      </div>
      <span class="network-value">${fmt(dmn)}</span>
    </div>
    <div class="network-row">
      <span class="network-label">FPN</span>
      <div class="network-bar-bg">
        <div class="network-bar-fill bar-fpn" style="width:${pct(fpn, maxNet)}%"></div>
      </div>
      <span class="network-value">${fmt(fpn)}</span>
    </div>
    <div class="network-row">
      <span class="network-label">Reward</span>
      <div class="network-bar-bg">
        <div class="network-bar-fill bar-reward" style="width:${pct(reward, maxNet)}%"></div>
      </div>
      <span class="network-value">${fmt(reward)}</span>
    </div>`;
}

function pct(val, max) { return Math.min(100, ((val || 0) / max) * 100).toFixed(1); }
function fmt(val)      { return val != null ? val.toFixed(2) : '—'; }

// ─── Error display ─────────────────────────────────────────────────────────────

function showError(msg) {
  errorBanner.textContent = msg || 'Something went wrong.';
  errorBanner.style.display = '';
  setTimeout(() => { errorBanner.style.display = 'none'; }, 5000);
}

function hideError() {
  errorBanner.style.display = 'none';
}

// ─── Button handler ────────────────────────────────────────────────────────────

toggleBtn.addEventListener('click', () => {
  hideError();
  const action = sessionActive ? ACTIONS.STOP_SESSION : ACTIONS.START_SESSION;
  chrome.runtime.sendMessage({ action }, (resp) => {
    if (chrome.runtime.lastError) {
      showError('Could not reach extension background. Try reloading the extension.');
      return;
    }
    if (resp && resp.error) {
      showError(resp.error);
      return;
    }
    // Optimistically flip the button while we wait for SESSION_UPDATE
    if (action === ACTIONS.START_SESSION) {
      sessionActive = true;
      toggleBtn.textContent = '⏹ STOP RECORDING';
      toggleBtn.classList.add('active');
      // Show session card with 0 reels / Analyzing...
      renderPopup({ active: true, reelCount: 0, lastReel: null });
    } else {
      sessionActive = false;
      toggleBtn.textContent = '▶ START RECORDING';
      toggleBtn.classList.remove('active');
    }
  });
});

// ─── Dashboard button ──────────────────────────────────────────────────────────

dashboardBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

// ─── Live updates from SW ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === ACTIONS.SESSION_UPDATE) {
    renderPopup(msg.state);
  }
  if (msg.action === ACTIONS.ANALYSIS_ERROR) {
    showError(`Analysis failed: ${msg.error || 'unknown error'}`);
  }
});

// ─── Init: hydrate from SW on popup open ──────────────────────────────────────

chrome.runtime.sendMessage({ action: ACTIONS.GET_SESSION_STATE }, (resp) => {
  if (chrome.runtime.lastError || !resp) return; // SW not ready yet
  renderPopup(resp);
});

// ─── Utilities ────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
