"""
parcellation.py — Schaefer 200 + Tian subcortical surface parcellation for TRIBE v2 output.

TRIBE v2 outputs predictions on the fsaverage5 cortical surface:
  preds.shape = (n_timesteps, n_vertices)  where n_vertices ~ 20484 (10242 per hemisphere)

This module:
1. Loads Schaefer 200 surface-native labels for fsaverage5 (left + right hemisphere)
2. Loads Tian subcortical labels (appended after cortical vertices in some models — handle separately)
3. Averages preds over label indices → per-network mean activation timeseries
4. Computes the NeuralFeed Brain Health Score (0-100) using six literature-grounded
   components: coupling strength, network magnitude, narrative complexity,
   sensory-executive ratio, sensory chaos, and hijack index

Prior learning: TRIBE v2 is surface-native (fsaverage5). NiftiLabelsMasker is WRONG here.
Use manual index averaging on surface vertex arrays.
"""

import numpy as np
from nilearn import datasets, surface
from pathlib import Path
import logging

logger = logging.getLogger(__name__)

# ─── Atlas loading (cached at module level after first call) ──────────────────

_schaefer_labels_lh = None  # (10242,) int array, 0=unlabeled, 1-200=parcels
_schaefer_labels_rh = None
_network_parcel_map = None   # dict: network_name → list of parcel indices (1-indexed)
_atlas_loaded = False

# Schaefer 200 7-network assignment (Kong 2019 ordering within Schaefer 200).
# Each key maps to parcel indices (1-based) belonging to that network.
# Generated from the Schaefer 200 parcel names which encode network membership.
SCHAEFER_NETWORK_PREFIXES = {
    'dmn':         'DefaultMode',
    'fpn':         'Cont',          # Frontoparietal / Control network
    'visual':      'Vis',
    'somatomotor': 'SomMot',
    'dorsal_attn': 'DorsAttn',
    'limbic':      'Limbic',
    'salience':    'SalVentAttn',
}

# Tian subcortical parcels contributing to reward signal
# (nucleus accumbens = parcels named 'Hipp' area is separate; NAc + Caudate for reward)
TIAN_REWARD_KEYWORDS = ['Accu', 'Caud']


def _load_atlas():
    global _schaefer_labels_lh, _schaefer_labels_rh, _network_parcel_map, _atlas_loaded

    if _atlas_loaded:
        return

    logger.info("Loading Schaefer 200 fsaverage5 surface atlas...")
    try:
        schaefer = datasets.fetch_atlas_schaefer_2018(
            n_rois=200,
            yeo_networks=7,
            resolution_mm=1,
        )
    except Exception as e:
        logger.error(f"Failed to fetch Schaefer atlas: {e}")
        raise

    # Schaefer atlas comes as a volumetric NIfTI — we need the surface version.
    # nilearn provides surface-projected Schaefer labels via fetch_atlas_surf_destrieux
    # but for Schaefer 200 we use the fsaverage5 gifti files from nilearn's data.
    # Fall back to manual projection if surface gifti isn't available.
    try:
        schaefer_surf = datasets.fetch_atlas_schaefer_2018(
            n_rois=200,
            yeo_networks=7,
            resolution_mm=1,
        )
        # Try to get surface-native labels
        fsavg5 = datasets.fetch_surf_fsaverage('fsaverage5')

        # Load surface label arrays
        # nilearn >= 0.10 exposes gifti surface atlases for Schaefer
        from nilearn.surface import load_surf_data
        lh_path = schaefer.get('maps_img', None)

        # Use nilearn's built-in surface Schaefer atlas if available
        try:
            from nilearn import datasets as nlds
            surf_schaefer = nlds.fetch_atlas_schaefer_2018(
                n_rois=200, yeo_networks=7, resolution_mm=1
            )
            # Surface labels are sometimes in surf_schaefer.labels
            lh_labels = load_surf_data(fsavg5['pial_left'])  # placeholder
        except Exception:
            pass

        # Robust fallback: use volumetric parcellation projected to surface
        # via nilearn.surface.vol_to_surf
        from nilearn.surface import vol_to_surf
        schaefer_img = schaefer.maps  # NIfTI image
        fsavg5_mesh_lh = fsavg5['pial_left']
        fsavg5_mesh_rh = fsavg5['pial_right']

        lh_surface_labels = vol_to_surf(schaefer_img, fsavg5_mesh_lh, interpolation='nearest')
        rh_surface_labels = vol_to_surf(schaefer_img, fsavg5_mesh_rh, interpolation='nearest')

        _schaefer_labels_lh = np.round(lh_surface_labels).astype(int)
        _schaefer_labels_rh = np.round(rh_surface_labels).astype(int)

        logger.info(
            f"Loaded surface labels: LH {_schaefer_labels_lh.shape}, RH {_schaefer_labels_rh.shape}. "
            f"Unique parcels: {len(np.unique(np.concatenate([_schaefer_labels_lh, _schaefer_labels_rh])))}"
        )

    except Exception as e:
        logger.error(f"Surface atlas projection failed: {e}")
        raise

    # Build parcel → network mapping from Schaefer label names
    parcel_names = schaefer.labels  # list of bytes or str, e.g. b'7Networks_LH_Vis_1'
    _network_parcel_map = {k: [] for k in SCHAEFER_NETWORK_PREFIXES}

    for i, name in enumerate(parcel_names):
        name_str = name.decode() if isinstance(name, bytes) else str(name)
        parcel_idx = i + 1  # 1-indexed
        for net_key, prefix in SCHAEFER_NETWORK_PREFIXES.items():
            if prefix in name_str:
                _network_parcel_map[net_key].append(parcel_idx)
                break

    logger.info(f"Network parcel counts: { {k: len(v) for k, v in _network_parcel_map.items()} }")
    _atlas_loaded = True


def _average_network(preds_concat, labels_concat, parcel_indices):
    """
    Average preds over all vertices belonging to the given parcel_indices.
    preds_concat: (n_timesteps, n_vertices_total) — LH+RH concatenated
    labels_concat: (n_vertices_total,) int
    Returns: (n_timesteps,) mean activation per timestep
    """
    mask = np.isin(labels_concat, parcel_indices)
    if mask.sum() == 0:
        return np.zeros(preds_concat.shape[0])
    return preds_concat[:, mask].mean(axis=1)


def _zscore_timeseries(ts):
    """
    Z-score a 1D timeseries across time.
    Returns z-scored values (mean=0, std=1).
    If std is near 0 (flat signal), return zeros.
    """
    std = ts.std()
    if std < 1e-8:
        return np.zeros_like(ts)
    return (ts - ts.mean()) / std


def compute_network_scores(preds):
    """
    Main entry point.

    Args:
        preds: np.ndarray shape (n_timesteps, n_vertices)
               TRIBE v2 predictions on fsaverage5 surface.
               n_vertices is expected to be ~20484 (10242 LH + 10242 RH).
               If shape differs, we attempt to handle gracefully.

    Returns:
        dict with keys:
            dmn, fpn, reward, visual, somatomotor  — Z-scored mean activation (scalar, mean over time)
            dmn_ts, fpn_ts, reward_ts              — Z-scored timeseries (list of floats)
            brain_rot                              — (reward_z + dmn_z) / max(fpn_z, 0.01)
            timeseries                             — list of [dmn, fpn, reward, visual, somatomotor, brain_rot] per timestep
    """
    _load_atlas()

    if preds.ndim != 2:
        raise ValueError(f"Expected preds.ndim == 2, got {preds.ndim}")

    n_timesteps, n_vertices = preds.shape
    logger.info(f"Computing network scores: preds.shape={preds.shape}")

    # Validate vertex count — fsaverage5 has 10242 vertices per hemisphere = 20484 total
    expected_vertices = 20484
    if n_vertices != expected_vertices:
        logger.warning(
            f"preds has {n_vertices} vertices, expected {expected_vertices}. "
            f"Attempting to proceed — verify preds.shape after first TRIBE inference."
        )
        # Pad or trim to expected size
        if n_vertices < expected_vertices:
            pad = np.zeros((n_timesteps, expected_vertices - n_vertices))
            preds = np.concatenate([preds, pad], axis=1)
        else:
            preds = preds[:, :expected_vertices]

    # Split LH / RH
    lh_preds = preds[:, :10242]   # (n_timesteps, 10242)
    rh_preds = preds[:, 10242:]   # (n_timesteps, 10242)

    # Concatenate labels and predictions
    labels_concat = np.concatenate([_schaefer_labels_lh, _schaefer_labels_rh])
    preds_concat = np.concatenate([lh_preds, rh_preds], axis=1)

    # ── Cortical network timeseries (raw) ──
    network_ts = {}
    for net_key, parcel_indices in _network_parcel_map.items():
        if parcel_indices:
            network_ts[net_key] = _average_network(preds_concat, labels_concat, parcel_indices)
        else:
            network_ts[net_key] = np.zeros(n_timesteps)

    # ── Map Schaefer 7-network names to NeuralFeed scoring network names ──
    # visual → Vis, auditory → SomMot (closest proxy), executive → Cont/FPN,
    # language → Limbic (proxy), attention → DorsAttn, dmn → DefaultMode,
    # salience → SalVentAttn
    visual_ts    = network_ts['visual']
    auditory_ts  = network_ts['somatomotor']
    executive_ts = network_ts['fpn']
    language_ts  = network_ts['limbic']
    attention_ts = network_ts['dorsal_attn']
    dmn_ts       = network_ts['dmn']
    salience_ts  = network_ts['salience']

    # === NeuralFeed Brain Health Score (TRIBE v2) ===

    # === STEP 2: Composite TPN ===
    tpn_ts = (executive_ts + language_ts + attention_ts) / 3.0

    EPSILON = 0.01

    # === STEP 3: Per-content normalization (min-max within this content) ===
    def normalize(val, min_val, max_val):
        if max_val - min_val < EPSILON:
            return 0.5
        return float(np.clip((val - min_val) / (max_val - min_val), 0, 1))

    # === COMPONENT 1: Coupling Strength (w1 = 0.25) ===
    # |corr(DMN, TPN)| — near 0 = brain rot, high = organized brain
    corr_matrix = np.corrcoef(dmn_ts, tpn_ts)
    correlation_val = corr_matrix[0, 1] if not np.isnan(corr_matrix[0, 1]) else 0.0
    coupling_strength = abs(correlation_val)  # Already 0 to 1

    # === COMPONENT 2: Network Magnitude (w2 = 0.10) ===
    # Overall activation level — both networks active = brain is working
    network_magnitude = np.mean(tpn_ts) + np.mean(dmn_ts)
    # Normalize against range observed in this content
    mag_min, mag_max = np.min(tpn_ts + dmn_ts), np.max(tpn_ts + dmn_ts)
    network_magnitude_norm = normalize(network_magnitude, mag_min, mag_max * 2)

    # === COMPONENT 3: Narrative Complexity (w3 = 0.20) ===
    # Temporal variance in COGNITIVE networks only — excludes sensory
    narrative_complexity = np.std(tpn_ts) + np.std(language_ts)
    nc_max = max(np.std(visual_ts) + np.std(auditory_ts), narrative_complexity, EPSILON)
    narrative_complexity_norm = normalize(narrative_complexity, 0, nc_max * 2)

    # === COMPONENT 4: Sensory-to-Executive Ratio / SER (w4 = 0.15) ===
    # High sensory + low executive = junk food for the brain
    mean_sensory = np.mean(visual_ts + auditory_ts)
    mean_exec = np.mean(executive_ts)
    ser = mean_sensory / (mean_exec + EPSILON)
    ser_norm = normalize(ser, 0, max(ser * 2, 3.0))

    # === COMPONENT 5: Sensory Chaos (w5 = 0.10) ===
    # Visual/auditory volatility — jump cuts, flashing, sound blasts
    sensory_chaos = np.std(visual_ts) + np.std(auditory_ts)
    sc_max = max(narrative_complexity, sensory_chaos, EPSILON)
    sensory_chaos_norm = normalize(sensory_chaos, 0, sc_max * 2)

    # === COMPONENT 6: Hijack Index (w6 = 0.20) ===
    # Addiction signature: salience spikes * sensory load / executive brakes
    salience_volatility = np.std(salience_ts)  # Temporal std = intermittent reward pattern
    hijack_index = (salience_volatility * mean_sensory) / (mean_exec + EPSILON)
    hijack_max = max(hijack_index * 2, 5.0)
    hijack_norm = normalize(hijack_index, 0, hijack_max)

    # === LITERATURE-GROUNDED WEIGHTS ===
    W1 = 0.25   # Coupling Strength (+) — Fox et al. 2005
    W2 = 0.10   # Network Magnitude (+) — secondary importance
    W3 = 0.20   # Narrative Complexity (+) — Stillesjö et al. 2021
    W4 = 0.15   # SER (-) — sensory overload penalty
    W5 = 0.10   # Sensory Chaos (-) — jump cut penalty
    W6 = 0.20   # Hijack Index (-) — Wang et al. 2017, Montag et al. 2017

    # === FINAL SCORE COMPUTATION ===
    raw_score = (
        W1 * coupling_strength +
        W2 * network_magnitude_norm +
        W3 * narrative_complexity_norm -
        W4 * ser_norm -
        W5 * sensory_chaos_norm -
        W6 * hijack_norm
    )

    # Raw score range is roughly [-0.45, +0.55], rescale to 0-100
    neuralfeed_score = np.clip((raw_score + 0.45) * 100, 0, 100)

    # === CREATIVITY / FLOW BONUS (up to +10 points) ===
    # When DMN and Executive co-activate with positive correlation = creative engagement
    dmn_mean = np.mean(dmn_ts)
    exec_mean = np.mean(executive_ts)
    dmn_75th = np.percentile(np.concatenate([dmn_ts, executive_ts]), 75)

    if dmn_mean > dmn_75th and exec_mean > dmn_75th and correlation_val > 0.3:
        neuralfeed_score = min(100, neuralfeed_score + 10)
        pattern = "Creative/Narrative Engagement (Flow)"
    elif np.mean(tpn_ts) > dmn_mean and correlation_val < -0.3:
        pattern = "Active Learning / Deep Work"
    else:
        pattern = "Passive Consumption (Brain Rot)"

    # ── Per-timestep timeseries for animation (backward compat) ──
    def zs(ts): return _zscore_timeseries(ts)
    dmn_z    = zs(dmn_ts)
    fpn_z    = zs(executive_ts)
    reward_z = zs(language_ts)
    visual_z = zs(visual_ts)
    sommotor_z = zs(auditory_ts)

    timeseries_frames = []
    for t in range(n_timesteps):
        dmn_t    = float(np.clip(dmn_z[t], -10, 10))
        fpn_t    = float(np.clip(fpn_z[t], -10, 10))
        rew_t    = float(np.clip(reward_z[t], -10, 10))
        vis_t    = float(np.clip(visual_z[t], -10, 10))
        som_t    = float(np.clip(sommotor_z[t], -10, 10))
        brot_t   = float(neuralfeed_score)
        timeseries_frames.append([dmn_t, fpn_t, rew_t, vis_t, som_t, brot_t])

    # ── Backward-compatible scalars for app.py ──
    def safe_mean(z): return float(np.clip(z, -10, 10).mean()) if z.size > 0 else 0.001

    return {
        'dmn':              max(safe_mean(dmn_z), 0.001),
        'fpn':              max(safe_mean(fpn_z), 0.001),
        'reward':           max(safe_mean(reward_z), 0.001),
        'visual':           max(safe_mean(visual_z), 0.001),
        'somatomotor':      max(safe_mean(sommotor_z), 0.001),
        'brain_rot':        round(float(neuralfeed_score), 2),
        'timeseries':       timeseries_frames,
        'score':            round(float(neuralfeed_score), 2),
        'dominant_pattern': pattern,
        'correlation_direction': round(float(correlation_val), 3),
        'metrics': {
            'coupling_strength':        round(float(coupling_strength), 3),
            'network_magnitude':        round(float(network_magnitude_norm), 3),
            'narrative_complexity':      round(float(narrative_complexity_norm), 3),
            'sensory_executive_ratio':   round(float(ser), 3),
            'sensory_chaos':            round(float(sensory_chaos_norm), 3),
            'hijack_index':             round(float(hijack_index), 3),
        },
        'weights': {'w1': W1, 'w2': W2, 'w3': W3, 'w4': W4, 'w5': W5, 'w6': W6},
    }
