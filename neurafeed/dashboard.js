'use strict';

let chartInstance = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const { sessionHistory = [] } = await chrome.storage.local.get('sessionHistory');
  render(sessionHistory);

  document.getElementById('clearMockBtn').addEventListener('click', async () => {
    const { sessionHistory: h = [] } = await chrome.storage.local.get('sessionHistory');
    const clean = h.filter(r => !r.mock);
    const removed = h.length - clean.length;
    if (removed === 0) { alert('No mock data found.'); return; }
    if (confirm(`Remove ${removed} mock result(s)? Real results will be kept.`)) {
      await chrome.storage.local.set({ sessionHistory: clean });
      chrome.runtime.sendMessage({ action: ACTIONS.RESET_SESSION }).catch(() => {});
      render(clean);
    }
  });

  document.getElementById('clearAllBtn').addEventListener('click', async () => {
    if (confirm('Clear all session history? This cannot be undone.')) {
      await chrome.storage.local.remove(['sessionHistory', 'lastResult']);
      chrome.runtime.sendMessage({ action: ACTIONS.RESET_SESSION }).catch(() => {});
      render([]);
    }
  });
}

// Live refresh when service worker saves a new result
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.sessionHistory) {
    render(changes.sessionHistory.newValue || []);
  }
});

// ─── Render ───────────────────────────────────────────────────────────────────

function normalise(history) {
  // Guard against old-scale data (brain_rot was 0-100 before the scoring fix).
  // Any entry with brain_rot > 10 is pre-fix; scale it down for display.
  return history.filter(r => !r.mock).map(r => ({
    ...r,
    brain_rot: (r.brain_rot || 0) > 10 ? r.brain_rot / 10 : (r.brain_rot || 0),
  }));
}

function render(history) {
  const real = normalise(history);
  renderStats(real);
  renderChart(real);
  renderTable(real);
}

// ─── Stat cards ───────────────────────────────────────────────────────────────

function renderStats(history) {
  const empty = '—';
  if (history.length === 0) {
    ['statAvgScore','statAvgDmn','statAvgFpn','statAvgReward',
     'statAvgVisual','statAvgSomot'].forEach(id => {
      document.getElementById(id).textContent = empty;
    });
    document.getElementById('statReelsToday').textContent = '0';
    document.getElementById('statTotal').textContent = '0';
    return;
  }

  const avg = key => (history.reduce((s, r) => s + (r[key] || 0), 0) / history.length);

  const avgScore = avg('brain_rot');
  const scoreEl  = document.getElementById('statAvgScore');
  scoreEl.textContent = avgScore.toFixed(1);
  scoreEl.className = 'stat-value ' + (
    avgScore <= SCORE_THRESHOLDS.GREEN_MAX  ? 'green'  :
    avgScore <= SCORE_THRESHOLDS.YELLOW_MAX ? 'yellow' : 'red'
  );

  document.getElementById('statAvgDmn').textContent    = avg('dmn').toFixed(1);
  document.getElementById('statAvgFpn').textContent    = avg('fpn').toFixed(1);
  document.getElementById('statAvgReward').textContent = avg('reward').toFixed(1);
  document.getElementById('statAvgVisual').textContent = avg('visual').toFixed(1);
  document.getElementById('statAvgSomot').textContent  = avg('somatomotor').toFixed(1);

  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  document.getElementById('statReelsToday').textContent =
    history.filter(r => r.savedAt >= todayStart.getTime()).length;
  document.getElementById('statTotal').textContent = history.length;
}

// ─── Chart ────────────────────────────────────────────────────────────────────

function renderChart(history) {
  const canvas = document.getElementById('scoreChart');
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
  if (history.length === 0) return;

  const last30 = history.slice(-30);
  const labels = last30.map((_, i) => `#${history.length - last30.length + i + 1}`);
  const scores = last30.map(r => +(r.brain_rot || 0).toFixed(1));
  const colors = scores.map(s =>
    s <= SCORE_THRESHOLDS.GREEN_MAX  ? '#34a853' :
    s <= SCORE_THRESHOLDS.YELLOW_MAX ? '#fbbc04' : '#ea4335'
  );

  chartInstance = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Brain Rot Score',
        data: scores,
        backgroundColor: colors,
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => {
              const r = last30[items[0].dataIndex];
              return `Reel ${labels[items[0].dataIndex]} · ${r.platform || 'unknown'}`;
            },
            label: (item) => {
              const r = last30[item.dataIndex];
              const lines = [`Brain Rot: ${item.raw}`];
              if (r.dominant_pattern) lines.push(`Pattern: ${r.dominant_pattern}`);
              if (r.dmn != null) lines.push(`DMN: ${(r.dmn||0).toFixed(1)}  FPN: ${(r.fpn||0).toFixed(1)}  Reward: ${(r.reward||0).toFixed(1)}`);
              return lines;
            },
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          max: 10,
          grid: { color: '#f1f3f4' },
          ticks: { color: '#5f6368', font: { size: 11 } },
        },
        x: {
          grid: { display: false },
          ticks: { color: '#5f6368', font: { size: 11 } },
        },
      },
    },
  });
}

// ─── Table ────────────────────────────────────────────────────────────────────

function renderTable(history) {
  const container = document.getElementById('tableContainer');

  if (history.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🧠</div>
        <div>No real results yet.</div>
        <div style="margin-top:8px;font-size:12px">Start a session on Instagram, TikTok, or YouTube Shorts.</div>
      </div>`;
    return;
  }

  function patternClass(p) {
    if (!p) return '';
    if (p.includes('Flow') || p.includes('Creative')) return 'flow';
    if (p.includes('Active') || p.includes('Learning')) return 'active';
    return 'passive';
  }

  function mval(v) {
    return v != null ? `<span class="mval">${Number(v).toFixed(3)}</span>` : '—';
  }

  const rows = [...history].reverse().map((r) => {
    const score      = +(r.brain_rot || 0).toFixed(1);
    const scoreClass = score <= SCORE_THRESHOLDS.GREEN_MAX  ? 'green'
                     : score <= SCORE_THRESHOLDS.YELLOW_MAX ? 'yellow' : 'red';
    const time = r.savedAt ? new Date(r.savedAt).toLocaleString() : '—';
    const m    = r.metrics || {};
    const pattern = r.dominant_pattern || '';
    return `
      <tr>
        <td>${time}</td>
        <td><span class="platform-tag">${r.platform || '—'}</span></td>
        <td><span class="score-pill ${scoreClass}">${score}</span></td>
        <td>${(r.dmn         ||0).toFixed(1)}</td>
        <td>${(r.fpn         ||0).toFixed(1)}</td>
        <td>${(r.reward      ||0).toFixed(1)}</td>
        <td>${(r.visual      ||0).toFixed(1)}</td>
        <td>${(r.somatomotor ||0).toFixed(1)}</td>
        <td><span class="pattern-tag ${patternClass(pattern)}">${pattern || '—'}</span></td>
        <td>${mval(m.coupling_strength)}</td>
        <td>${mval(m.narrative_complexity)}</td>
        <td>${mval(m.sensory_exec_ratio)}</td>
        <td>${mval(m.sensory_chaos)}</td>
        <td>${mval(m.hijack_index)}</td>
      </tr>`;
  }).join('');

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Platform</th>
          <th>Brain Rot (/10)</th>
          <th>DMN</th>
          <th>FPN</th>
          <th>Reward</th>
          <th>Visual</th>
          <th>Somatomotor</th>
          <th>Pattern</th>
          <th>Coupling</th>
          <th>Narr. Complexity</th>
          <th>Sens/Exec Ratio</th>
          <th>Sens. Chaos</th>
          <th>Hijack Index</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

init();
