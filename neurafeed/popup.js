'use strict';

let sessionActive = false;

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

  toggleBtn.textContent = sessionActive ? '⏹ STOP RECORDING' : '▶ START RECORDING';
  toggleBtn.classList.toggle('active', sessionActive);

  const hasData = (state.reelCount > 0) || sessionActive || state.analysisInProgress;
  waitingCard.style.display = hasData ? 'none' : '';
  sessionCard.style.display = hasData ? '' : 'none';
  if (!hasData) return;

  reelCountEl.textContent = state.reelCount || 0;

  if (state.reelCount > 0) {
    // Guard against old-scale data (brain_rot was 0-100 before the scoring fix)
    const br = (state.brain_rot || 0) > 10 ? state.brain_rot / 10 : (state.brain_rot || 0);
    updateAvgBar('BrainRot', br,                  10);
    updateAvgBar('Dmn',      state.dmn,           10);
    updateAvgBar('Fpn',      state.fpn,           10);
    updateAvgBar('Reward',   state.reward,        10);
    updateAvgBar('Visual',   state.visual,        10);
    updateAvgBar('Somot',    state.somatomotor,   10);
  }

  if (state.lastReel) {
    renderLastReel(state.lastReel);
  } else if (sessionActive || state.analysisInProgress) {
    lastReelEl.innerHTML = `
      <div class="analyzing-row">
        <div class="mini-spinner"></div>
        <span>Analyzing reel — results arrive in ~30 seconds. You can close this popup.</span>
      </div>`;
  } else {
    lastReelEl.innerHTML = '';
  }
}

function updateAvgBar(key, value, max) {
  const bar = document.getElementById(`avgBar${key}`);
  const val = document.getElementById(`avgVal${key}`);
  if (!bar || !val) return;
  const pct = value != null ? Math.min(100, (value / max) * 100) : 0;
  bar.style.width = `${pct.toFixed(1)}%`;
  val.textContent = value != null ? value.toFixed(1) : '—';
}

function renderLastReel(result) {
  let { brain_rot, dmn, fpn, reward, visual, somatomotor,
        dominant_pattern, platform, metrics } = result;

  // Guard against old-scale data (brain_rot was 0-100 before the fix)
  if (brain_rot > 10) brain_rot = brain_rot / 10;

  const score      = Math.max(0, Math.round((brain_rot || 0) * 10) / 10);
  const scoreClass = score <= SCORE_THRESHOLDS.GREEN_MAX  ? 'green'
                   : score <= SCORE_THRESHOLDS.YELLOW_MAX ? 'yellow' : 'red';
  const scoreLabel = score <= SCORE_THRESHOLDS.GREEN_MAX  ? 'Active engagement'
                   : score <= SCORE_THRESHOLDS.YELLOW_MAX ? 'Mixed engagement'
                   : 'Passive consumption';

  const patternHtml = dominant_pattern
    ? `<div class="last-score-pattern">${escapeHtml(dominant_pattern)}</div>` : '';
  const platformTag = platform
    ? `<span class="last-score-platform">${escapeHtml(platform)}</span>` : '';

  // Network bars — relative to their own max
  const maxNet = Math.max(dmn||0, fpn||0, reward||0, visual||0, somatomotor||0, 0.01);

  // Optional metrics badges
  let metricsBadges = '';
  if (metrics) {
    metricsBadges = `
      <div class="metrics-row">
        <span class="metric-badge">Coupling <strong>${fmt(metrics.coupling_strength)}</strong></span>
        <span class="metric-badge">Narr. Complexity <strong>${fmt(metrics.narrative_complexity)}</strong></span>
        <span class="metric-badge">Hijack <strong>${fmt(metrics.hijack_index)}</strong></span>
        <span class="metric-badge">Sens/Exec <strong>${fmt(metrics.sensory_exec_ratio)}</strong></span>
      </div>`;
  }

  lastReelEl.innerHTML = `
    <div class="last-reel-score">
      <div class="last-score-number ${scoreClass}">${score}</div>
      <div class="last-score-info">
        <div class="last-score-label">Brain Rot Score (0–10)</div>
        <div class="last-score-title">${escapeHtml(scoreLabel)}</div>
        ${patternHtml}
        ${platformTag}
      </div>
    </div>
    <div class="network-row">
      <span class="network-label">DMN</span>
      <div class="network-bar-bg"><div class="network-bar-fill bar-dmn" style="width:${pct(dmn,maxNet)}%"></div></div>
      <span class="network-value">${fmt(dmn)}</span>
    </div>
    <div class="network-row">
      <span class="network-label">FPN</span>
      <div class="network-bar-bg"><div class="network-bar-fill bar-fpn" style="width:${pct(fpn,maxNet)}%"></div></div>
      <span class="network-value">${fmt(fpn)}</span>
    </div>
    <div class="network-row">
      <span class="network-label">Reward / Salience</span>
      <div class="network-bar-bg"><div class="network-bar-fill bar-reward" style="width:${pct(reward,maxNet)}%"></div></div>
      <span class="network-value">${fmt(reward)}</span>
    </div>
    <div class="network-row">
      <span class="network-label">Visual</span>
      <div class="network-bar-bg"><div class="network-bar-fill bar-visual" style="width:${pct(visual,maxNet)}%"></div></div>
      <span class="network-value">${fmt(visual)}</span>
    </div>
    <div class="network-row">
      <span class="network-label">Somatomotor</span>
      <div class="network-bar-bg"><div class="network-bar-fill bar-somot" style="width:${pct(somatomotor,maxNet)}%"></div></div>
      <span class="network-value">${fmt(somatomotor)}</span>
    </div>
    ${metricsBadges}`;
}

function pct(val, max) { return Math.min(100, ((val || 0) / max) * 100).toFixed(1); }
function fmt(val)      { return val != null ? Number(val).toFixed(2) : '—'; }

// ─── Error ────────────────────────────────────────────────────────────────────

function showError(msg) {
  errorBanner.textContent = msg || 'Something went wrong.';
  errorBanner.style.display = '';
  setTimeout(() => { errorBanner.style.display = 'none'; }, 5000);
}
function hideError() { errorBanner.style.display = 'none'; }

// ─── Button ───────────────────────────────────────────────────────────────────

toggleBtn.addEventListener('click', () => {
  hideError();
  const action = sessionActive ? ACTIONS.STOP_SESSION : ACTIONS.START_SESSION;
  chrome.runtime.sendMessage({ action }, (resp) => {
    if (chrome.runtime.lastError) {
      showError('Could not reach extension background. Try reloading the extension.');
      return;
    }
    if (resp && resp.error) { showError(resp.error); return; }
    if (action === ACTIONS.START_SESSION) {
      sessionActive = true;
      toggleBtn.textContent = '⏹ STOP RECORDING';
      toggleBtn.classList.add('active');
      renderPopup({ active: true, reelCount: 0, lastReel: null });
    } else {
      sessionActive = false;
      toggleBtn.textContent = '▶ START RECORDING';
      toggleBtn.classList.remove('active');
    }
  });
});

dashboardBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

// ─── Live updates ─────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === ACTIONS.SESSION_UPDATE)  renderPopup(msg.state);
  if (msg.action === ACTIONS.ANALYSIS_ERROR)  showError(`Analysis failed: ${msg.error || 'unknown error'}`);
});

// ─── Init ─────────────────────────────────────────────────────────────────────

chrome.runtime.sendMessage({ action: ACTIONS.GET_SESSION_STATE }, (resp) => {
  if (chrome.runtime.lastError || !resp) return;
  renderPopup(resp);
});

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
