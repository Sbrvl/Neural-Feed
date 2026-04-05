"""
parcellation.py - Aggregate TRIBE v2 cortical predictions into transparent,
literature-informed engagement metrics.

What this file does:
- Maps fsaverage5 vertex predictions onto large-scale cortical systems.
- Derives composite metrics we can plausibly support from cortical outputs:
  coordination, control-vs-sensory balance, cognitive dynamism,
  sensory fragmentation, and salience capture.
- Produces a backwards-compatible `brain_rot` display score while keeping the
  internal interpretation honest: this is a literature-informed cortical proxy,
  not a clinical measure and not a direct readout of dopamine, addiction,
  nucleus accumbens activity, or individual brain health.

Important limits:
- TRIBE v2 predicts population-average cortical responses on fsaverage5.
- The Schaefer 7-network atlas does not give us a clean language or auditory
  system, so this model only uses networks we can defend from the atlas.
- `reward` is retained as an API alias for cortical salience so the extension
  stays compatible, but it should be read as salience / attention capture.
"""

import logging

import numpy as np
from nilearn import datasets


logger = logging.getLogger(__name__)


_schaefer_labels_lh = None
_schaefer_labels_rh = None
_network_parcel_map = None
_atlas_loaded = False


SCHAEFER_NETWORK_PREFIXES = {
    "dmn": "Default",
    "fpn": "Cont",
    "visual": "Vis",
    "somatomotor": "SomMot",
    "dorsal_attn": "DorsAttn",
    "limbic": "Limbic",
    "salience": "SalVentAttn",
}


def _load_atlas():
    global _schaefer_labels_lh, _schaefer_labels_rh, _network_parcel_map, _atlas_loaded
    if _atlas_loaded:
        return

    logger.info("Loading Schaefer 200 fsaverage5 surface atlas...")
    schaefer = datasets.fetch_atlas_schaefer_2018(
        n_rois=200,
        yeo_networks=7,
        resolution_mm=1,
    )
    fsavg5 = datasets.fetch_surf_fsaverage("fsaverage5")

    from nilearn.surface import vol_to_surf

    lh = vol_to_surf(
        schaefer.maps,
        fsavg5["pial_left"],
        interpolation="nearest_most_frequent",
    )
    rh = vol_to_surf(
        schaefer.maps,
        fsavg5["pial_right"],
        interpolation="nearest_most_frequent",
    )

    _schaefer_labels_lh = np.round(lh).astype(int)
    _schaefer_labels_rh = np.round(rh).astype(int)

    parcel_names = schaefer.labels
    _network_parcel_map = {key: [] for key in SCHAEFER_NETWORK_PREFIXES}
    for i, name in enumerate(parcel_names):
        label = name.decode() if isinstance(name, bytes) else str(name)
        for key, prefix in SCHAEFER_NETWORK_PREFIXES.items():
            if prefix in label:
                _network_parcel_map[key].append(i + 1)
                break

    logger.info(
        "Network parcel counts: %s",
        {key: len(values) for key, values in _network_parcel_map.items()},
    )
    _atlas_loaded = True


def _average_network(preds_concat, labels_concat, parcel_indices):
    """Mean timeseries over vertices in parcel_indices."""
    mask = np.isin(labels_concat, parcel_indices)
    if mask.sum() == 0:
        return np.zeros(preds_concat.shape[0], dtype=np.float32)
    return preds_concat[:, mask].mean(axis=1)


def _zscore_timeseries(ts):
    """Z-score a 1-D timeseries. Flat signals return zeros."""
    std = float(np.std(ts))
    if std < 1e-8:
        return np.zeros_like(ts)
    return (ts - np.mean(ts)) / std


# Backwards-compatible alias for older imports/tests.
_zscore = _zscore_timeseries


def _safe_corr(ts_a, ts_b):
    """Correlation guarded against flat or degenerate signals."""
    if ts_a.size < 2 or ts_b.size < 2:
        return 0.0
    if float(np.std(ts_a)) < 1e-8 or float(np.std(ts_b)) < 1e-8:
        return 0.0
    corr = float(np.corrcoef(ts_a, ts_b)[0, 1])
    if np.isnan(corr):
        return 0.0
    return corr


def _rms(ts):
    """Root-mean-square magnitude of a timeseries."""
    return float(np.sqrt(np.mean(np.square(ts))))


def _bounded_share(primary, comparison, epsilon=1e-6):
    """
    Convert two non-negative quantities into a stable [0, 1] share.

    This avoids clip-specific min-max normalization and makes the score depend on
    relative dominance instead of arbitrary signal scale.
    """
    primary = max(float(primary), 0.0)
    comparison = max(float(comparison), 0.0)
    return primary / (primary + comparison + epsilon)


def _relative_display(raw_values):
    """
    Map network magnitudes to a relative 0-10 prominence scale for display only.

    This is intentionally labeled as relative prominence, not an absolute
    neuroscientific intensity scale.
    """
    keys = list(raw_values.keys())
    values = np.array([raw_values[key] for key in keys], dtype=float)
    v_min = float(values.min())
    v_max = float(values.max())
    if abs(v_max - v_min) < 1e-6:
        scaled = np.full(len(keys), 5.0)
    else:
        scaled = np.clip((values - v_min) / (v_max - v_min) * 10.0, 0.0, 10.0)
    return {key: round(float(value), 2) for key, value in zip(keys, scaled)}


def _brain_rot_from_enrichment(score_100):
    """Inverse display mapping retained for product continuity."""
    return round(float(np.clip(10.0 - score_100 / 10.0, 0.0, 10.0)), 2)


def compute_network_scores(preds, modality="audiovisual"):
    """
    Aggregate TRIBE cortical predictions into interpretable engagement metrics.

    Args:
        preds: np.ndarray of shape (n_timesteps, n_vertices)
        modality: "audiovisual" or "audio"

    Returns:
        dict with:
          brain_rot         - 0-10 inverse risk display used by the extension
          health_score      - 0-100 cognitive enrichment score
          enrichment_score  - alias of health_score
          passive_risk      - 0-100 sensory-dominant passive risk
          dmn/fpn/salience  - relative 0-10 network prominence for display
          reward            - backwards-compatible alias of salience
          dominant_pattern  - honest qualitative label
          correlation       - signed DMN-control correlation
          metrics           - component values for debugging / UI
    """
    if modality not in {"audiovisual", "audio"}:
        raise ValueError(f"Unsupported modality: {modality}")

    _load_atlas()

    if preds.ndim != 2:
        raise ValueError(f"Expected preds.ndim == 2, got shape {preds.shape}")

    n_timesteps, n_vertices = preds.shape
    if n_timesteps == 0:
        raise ValueError("Expected at least one timestep in preds")

    expected_vertices = 20484
    if n_vertices < expected_vertices:
        pad = np.zeros((n_timesteps, expected_vertices - n_vertices), dtype=preds.dtype)
        preds = np.concatenate([preds, pad], axis=1)
    elif n_vertices > expected_vertices:
        preds = preds[:, :expected_vertices]

    lh_preds = preds[:, :10242]
    rh_preds = preds[:, 10242:]
    labels_concat = np.concatenate([_schaefer_labels_lh, _schaefer_labels_rh])
    preds_concat = np.concatenate([lh_preds, rh_preds], axis=1)

    net = {}
    for key, parcels in _network_parcel_map.items():
        net[key] = _average_network(preds_concat, labels_concat, parcels)

    dmn_ts = net["dmn"]
    exec_ts = net["fpn"]
    visual_ts = net["visual"]
    somot_ts = net["somatomotor"]
    dorsal_attn_ts = net["dorsal_attn"]
    salience_ts = net["salience"]

    # Control is the strongest task-positive signal we can justify from the
    # available Schaefer 7-network atlas.
    control_ts = 0.65 * exec_ts + 0.35 * dorsal_attn_ts

    # We do not claim an auditory network here because the atlas does not expose
    # one cleanly. Somatomotor is treated as the best available sensory-adjacent
    # cortical proxy. In audio-only mode we lean on it more heavily.
    if modality == "audio":
        sensory_ts = 0.20 * visual_ts + 0.80 * somot_ts
    else:
        sensory_ts = 0.70 * visual_ts + 0.30 * somot_ts

    dmn_power = _rms(dmn_ts)
    exec_power = _rms(exec_ts)
    control_power = _rms(control_ts)
    visual_power = _rms(visual_ts)
    somot_power = _rms(somot_ts)
    salience_power = _rms(salience_ts)
    sensory_power = _rms(sensory_ts)

    dmn_var = float(np.std(dmn_ts))
    control_var = float(np.std(control_ts))
    salience_var = float(np.std(salience_ts))

    cognitive_var = control_var + 0.5 * dmn_var
    sensory_var = float(np.std(sensory_ts))

    corr_val = _safe_corr(dmn_ts, control_ts)

    network_coordination = abs(corr_val)
    internal_control_balance = 1.0 - abs(dmn_power - control_power) / (
        dmn_power + control_power + 1e-6
    )
    control_share = _bounded_share(control_power, sensory_power)
    cognitive_dynamism = _bounded_share(cognitive_var, sensory_var)
    sensory_dominance = _bounded_share(sensory_power, control_power)
    sensory_fragmentation = _bounded_share(sensory_var, cognitive_var)
    salience_capture = _bounded_share(salience_power + 0.5 * salience_var, control_power + 0.5 * control_var)

    # Transparent composite. Positive terms reward organized cortical engagement.
    enrichment = (
        0.35 * network_coordination
        + 0.25 * control_share
        + 0.20 * cognitive_dynamism
        + 0.20 * internal_control_balance
    )

    # Negative terms penalize sensory-heavy, fragmented, attention-capturing content.
    passive_risk = (
        0.40 * sensory_dominance
        + 0.30 * sensory_fragmentation
        + 0.30 * salience_capture
    )

    enrichment_score = float(np.clip(50.0 + 50.0 * (enrichment - passive_risk), 0.0, 100.0))
    passive_risk_score = float(np.clip(passive_risk * 100.0, 0.0, 100.0))
    brain_rot = _brain_rot_from_enrichment(enrichment_score)

    if passive_risk >= 0.62 and network_coordination < 0.40:
        pattern = "Sensory-dominant passive consumption"
    elif corr_val >= 0.20 and internal_control_balance >= 0.55 and cognitive_dynamism >= 0.50:
        pattern = "Reflective / narrative engagement"
    elif corr_val <= -0.15 and control_share >= 0.55:
        pattern = "Focused / task-positive engagement"
    else:
        pattern = "Mixed engagement"

    display = _relative_display(
        {
            "dmn": dmn_power,
            "fpn": exec_power,
            "salience": salience_power,
            "visual": visual_power,
            "somatomotor": somot_power,
        }
    )

    dmn_z = _zscore_timeseries(dmn_ts)
    fpn_z = _zscore_timeseries(exec_ts)
    salience_z = _zscore_timeseries(salience_ts)
    visual_z = _zscore_timeseries(visual_ts)
    somot_z = _zscore_timeseries(somot_ts)

    def clip_z(value):
        return float(np.clip(value, -10.0, 10.0))

    timeseries = [
        [
            clip_z(dmn_z[t]),
            clip_z(fpn_z[t]),
            clip_z(salience_z[t]),
            clip_z(visual_z[t]),
            clip_z(somot_z[t]),
            brain_rot,
        ]
        for t in range(n_timesteps)
    ]

    metrics = {
        "network_coordination": round(float(network_coordination), 3),
        "control_share": round(float(control_share), 3),
        "cognitive_dynamism": round(float(cognitive_dynamism), 3),
        "internal_control_balance": round(float(internal_control_balance), 3),
        "sensory_dominance": round(float(sensory_dominance), 3),
        "sensory_fragmentation": round(float(sensory_fragmentation), 3),
        "salience_capture": round(float(salience_capture), 3),
        "salience_variability": round(float(_bounded_share(salience_var, control_var + 1e-6)), 3),
        # Backwards-compatible aliases for the current UI.
        "coupling_strength": round(float(network_coordination), 3),
        "narrative_complexity": round(float(cognitive_dynamism), 3),
        "sensory_exec_ratio": round(float(sensory_dominance), 3),
        "sensory_chaos": round(float(sensory_fragmentation), 3),
        "hijack_index": round(float(salience_capture), 3),
    }

    return {
        "brain_rot": brain_rot,
        "dmn": display["dmn"],
        "fpn": display["fpn"],
        "salience": display["salience"],
        "reward": display["salience"],  # Legacy alias used by the extension.
        "visual": display["visual"],
        "somatomotor": display["somatomotor"],
        "dominant_pattern": pattern,
        "health_score": round(enrichment_score, 1),
        "enrichment_score": round(enrichment_score, 1),
        "passive_risk": round(passive_risk_score, 1),
        "correlation": round(float(corr_val), 3),
        "modality": modality,
        "timeseries": timeseries,
        "metrics": metrics,
        "scientific_basis": (
            "Cortical proxy score derived from TRIBE v2 large-scale network "
            "coordination, control-vs-sensory balance, cognitive dynamism, "
            "sensory fragmentation, and salience capture."
        ),
    }
