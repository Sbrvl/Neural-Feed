"""
parcellation.py — Schaefer 200 surface parcellation for TRIBE v2 output.

TRIBE v2 outputs predictions on the fsaverage5 cortical surface:
  preds.shape = (n_timesteps, n_vertices)  where n_vertices = 20484 (10242 per hemisphere)

Scoring model (NeuralFeed Brain Rot Score, 0–10):
  Higher = more passive/brain-rotting content.  Lower = more engaging/healthy.

  Six literature-grounded components:
    (+health) Coupling Strength  — DMN↔TPN anti-correlation (Fox et al. 2005)
    (+health) Network Magnitude  — overall activation level
    (+health) Narrative Complexity — temporal variance in cognitive networks
    (−health) Sensory-Executive Ratio — sensory flood with no executive brakes
    (−health) Sensory Chaos       — visual/auditory volatility (jump cuts)
    (−health) Hijack Index        — salience spikes × sensory load (Wang 2017)

  raw_health ∈ [−0.45, +0.55]  →  health_0_100 ∈ [0, 100]
  brain_rot = 10 − health_0_100 / 10   (inverted, 0–10 scale)
"""

import numpy as np
from nilearn import datasets
from pathlib import Path
import logging

logger = logging.getLogger(__name__)

# ─── Atlas (cached after first call) ─────────────────────────────────────────

_schaefer_labels_lh = None
_schaefer_labels_rh = None
_network_parcel_map = None
_atlas_loaded = False

SCHAEFER_NETWORK_PREFIXES = {
    'dmn':         'Default',      # Schaefer uses 'Default', not 'DefaultMode'
    'fpn':         'Cont',
    'visual':      'Vis',
    'somatomotor': 'SomMot',
    'dorsal_attn': 'DorsAttn',
    'limbic':      'Limbic',
    'salience':    'SalVentAttn',
}


def _load_atlas():
    global _schaefer_labels_lh, _schaefer_labels_rh, _network_parcel_map, _atlas_loaded
    if _atlas_loaded:
        return

    logger.info("Loading Schaefer 200 fsaverage5 surface atlas...")
    schaefer = datasets.fetch_atlas_schaefer_2018(n_rois=200, yeo_networks=7, resolution_mm=1)
    fsavg5   = datasets.fetch_surf_fsaverage('fsaverage5')

    from nilearn.surface import vol_to_surf
    lh = vol_to_surf(schaefer.maps, fsavg5['pial_left'],  interpolation='nearest_most_frequent')
    rh = vol_to_surf(schaefer.maps, fsavg5['pial_right'], interpolation='nearest_most_frequent')

    _schaefer_labels_lh = np.round(lh).astype(int)
    _schaefer_labels_rh = np.round(rh).astype(int)

    logger.info(
        f"Loaded surface labels: LH {_schaefer_labels_lh.shape}, RH {_schaefer_labels_rh.shape}. "
        f"Unique parcels: {len(np.unique(np.concatenate([_schaefer_labels_lh, _schaefer_labels_rh])))}"
    )

    parcel_names = schaefer.labels
    _network_parcel_map = {k: [] for k in SCHAEFER_NETWORK_PREFIXES}
    for i, name in enumerate(parcel_names):
        name_str = name.decode() if isinstance(name, bytes) else str(name)
        for net_key, prefix in SCHAEFER_NETWORK_PREFIXES.items():
            if prefix in name_str:
                _network_parcel_map[net_key].append(i + 1)
                break

    logger.info(f"Network parcel counts: { {k: len(v) for k, v in _network_parcel_map.items()} }")
    _atlas_loaded = True


def _average_network(preds_concat, labels_concat, parcel_indices):
    """Mean activation timeseries over vertices in parcel_indices → (n_timesteps,)"""
    mask = np.isin(labels_concat, parcel_indices)
    if mask.sum() == 0:
        return np.zeros(preds_concat.shape[0])
    return preds_concat[:, mask].mean(axis=1)


def _zscore(ts):
    """Z-score a 1-D timeseries. Returns zeros if flat."""
    std = ts.std()
    if std < 1e-8:
        return np.zeros_like(ts)
    return (ts - ts.mean()) / std


def _relative_display(raw_means_dict):
    """
    Given a dict of {name: raw_mean_activation}, normalize to 0–10 so the
    most-active network = 10 and least-active = 0. Preserves relative differences.
    If all networks are equal (flat signal) returns 5.0 for each.
    """
    keys = list(raw_means_dict.keys())
    vals = np.array([raw_means_dict[k] for k in keys], dtype=float)
    v_min, v_max = vals.min(), vals.max()
    v_range = v_max - v_min
    if v_range < 1e-6:
        normed = np.full(len(keys), 5.0)
    else:
        normed = np.clip((vals - v_min) / v_range * 10, 0, 10)
    return {k: round(float(v), 2) for k, v in zip(keys, normed)}


def compute_network_scores(preds):
    """
    Args:
        preds: np.ndarray (n_timesteps, n_vertices)  — TRIBE v2 fsaverage5 output

    Returns dict with:
        brain_rot      — 0–10  higher = more passive/brain-rotting
        dmn            — 0–10  Default Mode Network activation
        fpn            — 0–10  Frontoparietal (executive) activation
        reward         — 0–10  Salience / reward-circuit activation
        visual         — 0–10  Visual cortex activation
        somatomotor    — 0–10  Somatomotor / auditory activation
        dominant_pattern — str label
        timeseries     — list of [dmn, fpn, reward, visual, somatomotor, brain_rot] per frame
        metrics        — dict of raw component values for debugging
    """
    _load_atlas()

    if preds.ndim != 2:
        raise ValueError(f"Expected preds.ndim==2, got shape {preds.shape}")

    n_timesteps, n_vertices = preds.shape
    logger.info(f"Computing network scores: preds.shape={preds.shape}")

    # Pad/trim to 20484
    expected = 20484
    if n_vertices < expected:
        preds = np.concatenate([preds, np.zeros((n_timesteps, expected - n_vertices))], axis=1)
    elif n_vertices > expected:
        preds = preds[:, :expected]

    lh_preds = preds[:, :10242]
    rh_preds = preds[:, 10242:]
    labels_concat = np.concatenate([_schaefer_labels_lh, _schaefer_labels_rh])
    preds_concat  = np.concatenate([lh_preds, rh_preds], axis=1)

    # ── Raw network timeseries ──────────────────────────────────────────────────
    net = {}
    for key, parcels in _network_parcel_map.items():
        net[key] = _average_network(preds_concat, labels_concat, parcels) if parcels \
                   else np.zeros(n_timesteps)

    dmn_ts      = net['dmn']
    exec_ts     = net['fpn']          # frontoparietal / executive
    visual_ts   = net['visual']
    somot_ts    = net['somatomotor']
    datt_ts     = net['dorsal_attn']
    limbic_ts   = net['limbic']
    sal_ts      = net['salience']     # salience / ventral attention — reward proxy

    tpn_ts = (exec_ts + limbic_ts + datt_ts) / 3.0  # task-positive composite

    EPSILON = 0.01

    def norml(val, lo, hi):
        if hi - lo < EPSILON:
            return 0.5
        return float(np.clip((val - lo) / (hi - lo), 0, 1))

    # Component 1 — Coupling Strength (0–1): |corr(DMN, TPN)|
    cc = np.corrcoef(dmn_ts, tpn_ts)
    corr_val = float(cc[0, 1]) if not np.isnan(cc[0, 1]) else 0.0
    coupling = abs(corr_val)

    # Component 2 — Network Magnitude (0–1)
    mag = np.mean(tpn_ts) + np.mean(dmn_ts)
    mag_norm = norml(mag, np.min(tpn_ts + dmn_ts), np.max(tpn_ts + dmn_ts) * 2)

    # Component 3 — Narrative Complexity (0–1): variance in cognitive networks
    narr = np.std(tpn_ts) + np.std(limbic_ts)
    narr_norm = norml(narr, 0, max(np.std(visual_ts) + np.std(somot_ts), narr, EPSILON) * 2)

    # Component 4 — Sensory-Executive Ratio: high sensory, low exec = brain rot
    # NOTE: in audio-only inference visual_ts / somot_ts are ~0 (no video modality).
    # Use salience as a proxy for sensory drive so the score is still meaningful.
    mean_vis_som = np.mean(np.abs(visual_ts) + np.abs(somot_ts))
    mean_sal     = np.mean(np.abs(sal_ts))
    mean_sens    = mean_vis_som + 0.5 * mean_sal   # salience as partial proxy
    mean_exec    = max(float(np.mean(exec_ts)), EPSILON)
    ser          = mean_sens / (mean_exec + EPSILON)
    ser_norm     = norml(ser, 0, max(ser * 2, 3.0))

    # Component 5 — Sensory Chaos: volatility (jump-cuts, flashing, sound blasts)
    chaos      = np.std(visual_ts) + np.std(somot_ts) + 0.5 * np.std(sal_ts)
    chaos_max  = max(narr, chaos, EPSILON)
    chaos_norm = norml(chaos, 0, chaos_max * 2)

    # Component 6 — Hijack Index: salience spikes × sensory load ÷ executive brakes
    sal_vol     = np.std(sal_ts)
    hijack      = (sal_vol * mean_sens) / (mean_exec + EPSILON)
    hijack_norm = norml(hijack, 0, max(hijack * 2, 5.0))

    # Weights (sum of positive = 0.55, sum of negative = 0.45)
    W1, W2, W3 = 0.25, 0.10, 0.20
    W4, W5, W6 = 0.15, 0.10, 0.20

    health_raw = (W1*coupling + W2*mag_norm + W3*narr_norm
                  - W4*ser_norm - W5*chaos_norm - W6*hijack_norm)

    # Health score 0–100  (raw ∈ [−0.45, +0.55])
    health_100 = float(np.clip((health_raw + 0.45) * 100, 0, 100))

    # Creativity/Flow bonus (+10 pts if DMN and exec co-activate positively)
    dmn_mean  = np.mean(dmn_ts)
    exec_mean = np.mean(exec_ts)
    p75 = float(np.percentile(np.concatenate([dmn_ts, exec_ts]), 75))
    if dmn_mean > p75 and exec_mean > p75 and corr_val > 0.3:
        health_100 = min(100.0, health_100 + 10.0)
        pattern = "Creative / Flow State"
    elif np.mean(tpn_ts) > dmn_mean and corr_val < -0.3:
        pattern = "Active Learning"
    else:
        pattern = "Passive Consumption"

    # ── Brain Rot Score: 0–10, higher = more brain-rotting ─────────────────────
    brain_rot = round(float(np.clip(10.0 - health_100 / 10.0, 0, 10)), 2)

    # ── Display scores (0–10, relative within this content) ────────────────────
    # Use raw means so networks that are genuinely more active score higher.
    # Min-max across the 5 networks: most active = 10, least active = 0.
    display = _relative_display({
        'dmn':         float(np.mean(dmn_ts)),
        'fpn':         float(np.mean(exec_ts)),
        'reward':      float(np.mean(sal_ts)),
        'visual':      float(np.mean(visual_ts)),
        'somatomotor': float(np.mean(somot_ts)),
    })

    # ── Z-score timeseries for per-frame animation ─────────────────────────────
    dmn_z = _zscore(dmn_ts)
    fpn_z = _zscore(exec_ts)
    sal_z = _zscore(sal_ts)
    vis_z = _zscore(visual_ts)
    som_z = _zscore(somot_ts)

    def clip_z(z): return float(np.clip(z, -10, 10))

    timeseries = [
        [clip_z(dmn_z[t]), clip_z(fpn_z[t]), clip_z(sal_z[t]),
         clip_z(vis_z[t]), clip_z(som_z[t]), brain_rot]
        for t in range(n_timesteps)
    ]

    return {
        # ── Primary display scores (0–10) ──
        'brain_rot':        brain_rot,
        'dmn':              display['dmn'],
        'fpn':              display['fpn'],
        'reward':           display['reward'],
        'visual':           display['visual'],
        'somatomotor':      display['somatomotor'],

        # ── Richer metadata ──
        'dominant_pattern': pattern,
        'health_score':     round(health_100, 1),     # 0–100, higher = healthier
        'correlation':      round(corr_val, 3),

        # ── Animation ──
        'timeseries': timeseries,

        # ── Debug components ──
        'metrics': {
            'coupling_strength':      round(coupling, 3),
            'network_magnitude':      round(mag_norm, 3),
            'narrative_complexity':   round(narr_norm, 3),
            'sensory_exec_ratio':     round(ser, 3),
            'sensory_chaos':          round(chaos_norm, 3),
            'hijack_index':           round(hijack_norm, 3),
        },
    }
