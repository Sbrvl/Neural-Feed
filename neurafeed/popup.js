// popup.js — Extension popup logic
// Handles: score display, 3D brain viewer, timeseries animation, share card

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────

let currentResult = null;
let animationInterval = null;
let animationFrame = 0;
let isAnimating = false;

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const mainContent = document.getElementById('mainContent');
const statusBadge = document.getElementById('statusBadge');
const dashboardBtn = document.getElementById('dashboardBtn');

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  // Load last result from storage (if popup was closed and reopened)
  const { lastResult } = await chrome.storage.local.get('lastResult');
  if (lastResult) renderResult(lastResult);

  // Listen for new results pushed by service_worker.js
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === ACTIONS.ANALYSIS_COMPLETE) {
      setStatus('DONE', 'done');
      renderResult(message.result);
    }
    if (message.action === ACTIONS.ANALYSIS_ERROR) {
      setStatus('ERROR', 'done');
      renderError(message.error);
    }
    if (message.action === ACTIONS.START_CAPTURE) {
      setStatus('ANALYZING', 'analyzing');
      renderLoading();
    }
  });

  dashboardBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  });
}

function setStatus(text, cls) {
  statusBadge.textContent = text;
  statusBadge.className = `topbar-badge ${cls}`;
}

// ─── Loading state ────────────────────────────────────────────────────────────

function renderLoading() {
  stopAnimation();
  mainContent.innerHTML = `
    <div class="card loading-card">
      <div class="loading-spinner"></div>
      <div class="loading-text">Analyzing with TRIBE v2...</div>
      <div class="loading-subtext">(~15–30s — real fMRI prediction running)</div>
    </div>`;
}

// ─── Error state ──────────────────────────────────────────────────────────────

function renderError(errorMsg) {
  stopAnimation();
  mainContent.innerHTML = `
    <div class="card error-card">
      <div class="error-text">Analysis failed</div>
      <div class="error-detail">${escapeHtml(String(errorMsg).slice(0, 300))}</div>
    </div>
    <div class="card waiting-card" style="margin-top:0">
      <div class="waiting-text">Watch another reel to try again.</div>
    </div>`;
}

// ─── Main result render ───────────────────────────────────────────────────────

function renderResultCore(result) {
  stopAnimation();
  currentResult = result;

  const { brain_rot, dmn, fpn, reward, visual, somatomotor, viewer_html, timeseries, platform } = result;

  // Clamp and round brain rot score for display
  const score = Math.max(0, Math.round(brain_rot * 10) / 10);
  const scoreClass = score <= SCORE_THRESHOLDS.GREEN_MAX ? 'green'
    : score <= SCORE_THRESHOLDS.YELLOW_MAX ? 'yellow' : 'red';
  const scoreLabel = score <= SCORE_THRESHOLDS.GREEN_MAX ? 'Active engagement'
    : score <= SCORE_THRESHOLDS.YELLOW_MAX ? 'Mixed engagement'
    : 'Passive consumption';

  const platformTag = platform ? `<span class="platform-tag">${platform}</span>` : '';

  // Max network value for bar scaling (use 1 as floor to avoid 0-division)
  const maxNet = Math.max(dmn, fpn, reward, visual, somatomotor, 1);

  mainContent.innerHTML = `
    <!-- Score card -->
    <div id="scoreCardEl" class="card score-card">
      <div class="score-number ${scoreClass}" id="scoreDisplay">${score}</div>
      <div class="score-info">
        <div class="score-label">Brain Rot Score${platformTag}</div>
        <div class="score-title">${scoreLabel}</div>
        <div class="score-subtitle">(reward + DMN) / FPN</div>
        <span class="score-disclaimer"
          title="Predictions are for the population-average brain response, not your individual brain activity.">
          ⓘ Population average — not personal
        </span>
      </div>
    </div>

    <!-- Network bars -->
    <div class="card">
      <div class="section-title">Network Activation</div>
      ${networkBar('Default Mode (DMN)', dmn, maxNet, 'bar-dmn')}
      ${networkBar('Reward Circuit', reward, maxNet, 'bar-reward')}
      ${networkBar('Frontoparietal (FPN)', fpn, maxNet, 'bar-fpn')}
      ${networkBar('Visual Cortex', visual, maxNet, 'bar-visual')}
      ${networkBar('Somatomotor', somatomotor, maxNet, 'bar-somatomotor')}
    </div>

    <!-- 3D Brain viewer -->
    <div class="card brain-viewer-card" id="brainViewerCard">
      ${viewer_html
        ? `<iframe id="brainIframe" sandbox="allow-scripts allow-same-origin"
             srcdoc="${escapeAttr(viewer_html)}"
             loading="lazy"></iframe>`
        : `<div class="brain-viewer-placeholder">3D brain viewer unavailable</div>`}
    </div>

    <!-- Timeseries sparkline -->
    ${timeseries && timeseries.length > 0 ? `
    <div class="card" id="sparklineCard">
      <div class="section-title">Activation Over Time</div>
      <canvas id="sparklineCanvas" class="sparkline-canvas" width="388" height="80"></canvas>
      <div class="sparkline-legend">
        <div class="legend-item"><div class="legend-dot" style="background:#4285f4"></div>DMN</div>
        <div class="legend-item"><div class="legend-dot" style="background:#ea4335"></div>Reward</div>
        <div class="legend-item"><div class="legend-dot" style="background:#34a853"></div>FPN</div>
      </div>
      <div class="animation-controls">
        <button class="anim-btn" id="animToggle">⏸ Pause</button>
        <span class="anim-time" id="animTime">t=0s</span>
      </div>
    </div>` : ''}
  `;

  // Start animation if timeseries is available
  if (timeseries && timeseries.length > 0) {
    startAnimation(timeseries);
    document.getElementById('animToggle').addEventListener('click', toggleAnimation);
  }

  // Popup memory check — if the iframe causes issues, offer sidePanel fallback
  const iframe = document.getElementById('brainIframe');
  if (iframe) {
    iframe.addEventListener('error', () => offerSidePanel());
    // Rough memory check: if popup becomes unresponsive within 2s, bail
    setTimeout(() => {
      if (!document.body.offsetHeight) offerSidePanel();
    }, 2000);
  }
}

function networkBar(label, value, max, colorClass) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  const display = value.toFixed(2);
  return `
    <div class="network-row">
      <span class="network-label">${label}</span>
      <div class="network-bar-bg">
        <div class="network-bar-fill ${colorClass}" id="bar-${colorClass}" style="width:${pct}%"></div>
      </div>
      <span class="network-value">${display}</span>
    </div>`;
}

// ─── Timeseries animation ─────────────────────────────────────────────────────
// Animates at ~2fps to match approximate fMRI TR (repetition time).
// Each frame: [dmn, fpn, reward, visual, somatomotor, brain_rot] normalized values.

function startAnimation(timeseries) {
  animationFrame = 0;
  isAnimating = true;
  const canvas = document.getElementById('sparklineCanvas');
  if (!canvas) return;

  // Draw static sparkline first
  drawSparkline(canvas, timeseries, 0);

  animationInterval = setInterval(() => {
    if (!isAnimating) return;
    animationFrame = (animationFrame + 1) % timeseries.length;
    drawSparkline(canvas, timeseries, animationFrame);
    updateLiveNetworkBars(timeseries[animationFrame]);
    const timeEl = document.getElementById('animTime');
    if (timeEl) timeEl.textContent = `t=${animationFrame}s`;
  }, 1000 / ANIMATION_FPS);
}

function stopAnimation() {
  clearInterval(animationInterval);
  animationInterval = null;
  isAnimating = false;
}

function toggleAnimation() {
  const btn = document.getElementById('animToggle');
  if (isAnimating) {
    isAnimating = false;
    if (btn) btn.textContent = '▶ Play';
  } else {
    isAnimating = true;
    if (btn) btn.textContent = '⏸ Pause';
  }
}

function drawSparkline(canvas, timeseries, currentFrame) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  // Network indices in timeseries: [dmn, fpn, reward, visual, somatomotor, brain_rot]
  const lines = [
    { idx: 0, color: '#4285f4' }, // DMN
    { idx: 2, color: '#ea4335' }, // Reward
    { idx: 1, color: '#34a853' }, // FPN
  ];

  const n = timeseries.length;
  if (n < 2) return;

  // Find global max for normalization
  let globalMax = 0.01;
  for (const frame of timeseries) {
    for (const v of frame.slice(0, 3)) {
      if (v > globalMax) globalMax = v;
    }
  }

  for (const { idx, color } of lines) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * W;
      const y = H - (timeseries[i][idx] / globalMax) * (H - 8) - 4;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Draw playhead cursor
  const cursorX = (currentFrame / (n - 1)) * W;
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.moveTo(cursorX, 0);
  ctx.lineTo(cursorX, H);
  ctx.stroke();
  ctx.setLineDash([]);
}

function updateLiveNetworkBars(frame) {
  // frame = [dmn, fpn, reward, visual, somatomotor, brain_rot]
  if (!frame) return;
  const [dmn, fpn, reward, visual, somatomotor] = frame;
  const max = Math.max(dmn, fpn, reward, visual, somatomotor, 0.01);
  const updates = [
    ['bar-bar-dmn', dmn / max],
    ['bar-bar-reward', reward / max],
    ['bar-bar-fpn', fpn / max],
    ['bar-bar-visual', visual / max],
    ['bar-bar-somatomotor', somatomotor / max],
  ];
  for (const [id, ratio] of updates) {
    const el = document.getElementById(id);
    if (el) el.style.width = `${Math.round(ratio * 100)}%`;
  }
}

// ─── Side panel fallback ──────────────────────────────────────────────────────

function offerSidePanel() {
  const card = document.getElementById('brainViewerCard');
  if (!card) return;
  card.innerHTML = `
    <div class="brain-viewer-placeholder" style="flex-direction:column;gap:8px;">
      <div>3D viewer needs more space</div>
      <button class="action-btn" onclick="openSidePanel()" style="width:auto;padding:6px 16px">
        Open in side panel
      </button>
    </div>`;
}

function openSidePanel() {
  chrome.runtime.sendMessage({ action: ACTIONS.OPEN_SIDE_PANEL });
}

// ─── Share card ────────────────────────────────────────────────────────────────
// html2canvas cannot capture srcdoc iframes.
// Share card uses: score number + network bars + brain_png_b64 from server.

async function exportShareCard() {
  if (!currentResult) return;

  const { brain_rot, dmn, fpn, reward, brain_png_b64 } = currentResult;
  const score = Math.max(0, Math.round(brain_rot * 10) / 10);
  const scoreClass = score <= SCORE_THRESHOLDS.GREEN_MAX ? '#34a853'
    : score <= SCORE_THRESHOLDS.YELLOW_MAX ? '#fbbc04' : '#ea4335';

  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 630;
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 1200, 630);

  // Left panel background
  ctx.fillStyle = '#1a73e8';
  ctx.fillRect(0, 0, 420, 630);

  // Score
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 120px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(score.toString(), 210, 260);

  ctx.font = '24px sans-serif';
  ctx.fillText('Brain Rot Score', 210, 310);

  ctx.font = '18px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.fillText('Powered by Meta TRIBE v2', 210, 380);
  ctx.fillText('Population average response', 210, 408);

  // Right panel: network bars
  const barY = [120, 190, 260, 330, 400];
  const barLabels = ['DMN', 'Reward', 'FPN', 'Visual', 'Somatomotor'];
  const barValues = [dmn, fpn, reward, currentResult.visual, currentResult.somatomotor];
  const barColors = ['#4285f4', '#ea4335', '#34a853', '#fbbc04', '#00bcd4'];
  const barMax = Math.max(...barValues, 0.01);

  ctx.font = 'bold 18px sans-serif';
  ctx.fillStyle = '#5f6368';
  ctx.textAlign = 'left';
  ctx.fillText('NETWORK ACTIVATION', 500, 80);

  for (let i = 0; i < 5; i++) {
    const y = barY[i];
    ctx.fillStyle = '#202124';
    ctx.font = '16px sans-serif';
    ctx.fillText(barLabels[i], 500, y);

    // Bar background
    ctx.fillStyle = '#e8eaed';
    ctx.beginPath();
    ctx.roundRect(500, y + 8, 500, 20, 4);
    ctx.fill();

    // Bar fill
    ctx.fillStyle = barColors[i];
    ctx.beginPath();
    ctx.roundRect(500, y + 8, (barValues[i] / barMax) * 500, 20, 4);
    ctx.fill();

    ctx.fillStyle = '#5f6368';
    ctx.font = '13px sans-serif';
    ctx.fillText(barValues[i].toFixed(2), 1010, y + 22);
  }

  // Brain image if available
  if (brain_png_b64) {
    await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 500, 450, 200, 150);
        resolve();
      };
      img.onerror = resolve;
      img.src = `data:image/png;base64,${brain_png_b64}`;
    });
  }

  // Footer
  ctx.fillStyle = '#9aa0a6';
  ctx.font = '14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('NeuralFeed — Real fMRI brain encoding for social media', 600, 600);

  // Download
  const link = document.createElement('a');
  link.download = `neurafeed-brain-rot-${Date.now()}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

// ─── Action row (appended after render) ──────────────────────────────────────

function appendActions() {
  if (!currentResult) return;
  const existing = document.getElementById('actionRow');
  if (existing) existing.remove();

  const row = document.createElement('div');
  row.id = 'actionRow';
  row.className = 'action-row';
  row.innerHTML = `
    <button class="action-btn" id="shareBtn">⬇ Save brain card</button>
    <button class="action-btn primary" id="historyBtn">📊 History</button>
  `;
  document.body.appendChild(row);

  document.getElementById('shareBtn').addEventListener('click', exportShareCard);
  document.getElementById('historyBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  });
}

function renderResult(result) {
  renderResultCore(result);
  appendActions();
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

init();
