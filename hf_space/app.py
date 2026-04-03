"""
app.py — NeuralFeed HuggingFace Space backend (FastAPI + ZeroGPU)

Endpoints:
  POST /analyze  — accepts .webm video, returns brain network scores + 3D viewer HTML
  GET  /health   — liveness check (for pre-warm ping before demo)

Environment variables:
  MOCK_TRIBE=1       — return hardcoded JSON instantly (development/Saturday AM)
  API_KEY            — shared secret for X-API-Key header validation

Deploy to HuggingFace Spaces:
  1. Create a new Space (Gradio or Docker SDK)
  2. Enable ZeroGPU in Space settings
  3. Upload this file + parcellation.py + requirements.txt
  4. Set API_KEY in Space Secrets (Settings → Repository secrets)
  5. Unset MOCK_TRIBE when switching to real inference
"""

import os
import uuid
import base64
import logging
import tempfile
from pathlib import Path
from io import BytesIO

import numpy as np
from fastapi import FastAPI, File, Form, UploadFile, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ─── Config ───────────────────────────────────────────────────────────────────

MOCK_MODE = os.getenv('MOCK_TRIBE', '').strip() in ('1', 'true', 'True')
API_KEY   = os.getenv('API_KEY', '').strip()

if MOCK_MODE:
    logger.warning("MOCK_TRIBE is set — returning hardcoded responses. Unset for real inference.")

if not API_KEY:
    logger.warning("API_KEY is not set — endpoint is unprotected. Set it in Space Secrets.")

# ─── App ──────────────────────────────────────────────────────────────────────

app = FastAPI(title='NeuralFeed', version='1.0.0')

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],  # Chrome extensions use chrome-extension:// origin
    allow_methods=['GET', 'POST'],
    allow_headers=['*'],
)

# ─── Model loading (deferred until first real request) ────────────────────────

_model = None

def get_model():
    global _model
    if _model is not None:
        return _model
    logger.info("Loading TRIBE v2 model (first request — may take ~60s)...")
    try:
        from tribev2 import TribeModel  # pip install -e ".[plotting]"
        _model = TribeModel.from_pretrained('facebook/tribev2', cache_folder='./cache')
        logger.info("TRIBE v2 loaded successfully.")
    except Exception as e:
        logger.error(f"Failed to load TRIBE v2: {e}")
        raise RuntimeError(f"Model load failed: {e}")
    return _model

# ─── Auth middleware ──────────────────────────────────────────────────────────

def check_auth(x_api_key: str):
    if not API_KEY:
        return  # No key configured — open access (development)
    if x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing X-API-Key header.")

# ─── Health endpoint ──────────────────────────────────────────────────────────

@app.get('/health')
async def health():
    """Liveness check. Call this before the demo to pre-warm the Space."""
    return {'status': 'ok', 'mock': MOCK_MODE}

# ─── Mock response ────────────────────────────────────────────────────────────

def mock_response(reel_id: str) -> dict:
    """Hardcoded response for development. Matches real response shape exactly."""
    n_frames = 30
    t = np.linspace(0, 2 * np.pi, n_frames)

    # Plausible-looking Z-scored activation timeseries
    dmn_ts    = (np.sin(t) * 0.8 + 0.5).tolist()
    fpn_ts    = (np.cos(t) * 0.6 + 0.3).tolist()
    reward_ts = (np.sin(t * 1.5) * 0.9 + 0.4).tolist()
    visual_ts = (np.sin(t * 2) * 0.7 + 0.2).tolist()
    somot_ts  = (np.cos(t * 0.8) * 0.5 + 0.1).tolist()

    timeseries = [
        [dmn_ts[i], fpn_ts[i], reward_ts[i], visual_ts[i], somot_ts[i],
         (reward_ts[i] + dmn_ts[i]) / max(fpn_ts[i], 0.01)]
        for i in range(n_frames)
    ]

    dmn    = float(np.mean(dmn_ts))
    fpn    = float(np.mean(fpn_ts))
    reward = float(np.mean(reward_ts))
    visual = float(np.mean(visual_ts))
    somot  = float(np.mean(somot_ts))
    brain_rot = (reward + dmn) / max(fpn, 0.01)

    return {
        'reel_id':      reel_id,
        'dmn':          dmn,
        'fpn':          fpn,
        'reward':       reward,
        'visual':       visual,
        'somatomotor':  somot,
        'brain_rot':    brain_rot,
        'viewer_html':  '<html><body style="background:#1a1a2e;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><p style="color:#4285f4;font-family:sans-serif;font-size:18px">🧠 Mock brain viewer — replace with real nilearn output</p></body></html>',
        'brain_png_b64': '',
        'timeseries':   timeseries,
        'mock':         True,
    }

# ─── /analyze endpoint ────────────────────────────────────────────────────────

@app.post('/analyze')
async def analyze(
    video: UploadFile = File(...),
    reel_id: str = Form(default=''),
    x_api_key: str = Header(default=''),
):
    check_auth(x_api_key)

    if not reel_id:
        reel_id = str(uuid.uuid4())

    # Validate file type
    content_type = video.content_type or ''
    if not content_type.startswith('video/') and not video.filename.endswith('.webm'):
        raise HTTPException(status_code=415, detail='Only video files accepted.')

    # Read and check file size (50MB HF limit)
    video_bytes = await video.read()
    size_mb = len(video_bytes) / (1024 * 1024)
    logger.info(f"Received reel {reel_id}: {size_mb:.1f} MB, content_type={content_type}")

    if size_mb > 50:
        raise HTTPException(status_code=413, detail=f'File too large: {size_mb:.1f} MB (max 50 MB).')

    # Mock mode: return instantly without running the model
    if MOCK_MODE:
        logger.info(f"MOCK_TRIBE: returning hardcoded response for {reel_id}")
        return JSONResponse(mock_response(reel_id))

    # ── Real inference ──
    with tempfile.NamedTemporaryFile(suffix='.webm', delete=False) as tmp:
        tmp.write(video_bytes)
        video_path = tmp.name

    try:
        result = await run_tribe_inference(video_path, reel_id)
    finally:
        Path(video_path).unlink(missing_ok=True)

    return JSONResponse(result)


async def run_tribe_inference(video_path: str, reel_id: str) -> dict:
    """Run TRIBE v2 inference + parcellation + nilearn viewer generation."""
    from parcellation import compute_network_scores

    model = get_model()

    # ── TRIBE v2 inference ──
    logger.info(f"Running TRIBE v2 inference on {video_path}...")
    try:
        # Full inference: video file contains audio; TRIBE auto-transcribes for text modal.
        events_df = model.get_events_dataframe(video_path=video_path)
        preds, segments = model.predict(events=events_df)
        logger.info(f"TRIBE preds.shape={preds.shape}")
    except Exception as e:
        logger.warning(f"Inference failed with full model ({e}). Retrying without text modality...")
        try:
            # Fallback: pass audio_path explicitly from the video to skip LLaMA transcription.
            # The video_path alone omits text events — LLaMA OOM is the most common failure.
            events_df = model.get_events_dataframe(video_path=video_path, audio_path=video_path)
            preds, segments = model.predict(events=events_df)
            logger.info(f"Fallback inference succeeded. preds.shape={preds.shape}")
        except Exception as e2:
            raise RuntimeError(f"TRIBE inference failed: {e2}") from e2

    # Convert to numpy if needed
    if hasattr(preds, 'numpy'):
        preds = preds.numpy()
    preds = np.array(preds, dtype=np.float32)

    # ── Network scores via Schaefer 200 + Tian parcellation ──
    scores = compute_network_scores(preds)

    # ── 3D interactive brain viewer (nilearn) ──
    viewer_html = generate_brain_viewer(preds)

    # ── Static brain PNG for share card (base64) ──
    brain_png_b64 = generate_brain_png(preds)

    return {
        'reel_id':      reel_id,
        'dmn':          scores['dmn'],
        'fpn':          scores['fpn'],
        'reward':       scores['reward'],
        'visual':       scores['visual'],
        'somatomotor':  scores['somatomotor'],
        'brain_rot':    scores['brain_rot'],
        'viewer_html':  viewer_html,
        'brain_png_b64': brain_png_b64,
        'timeseries':   scores['timeseries'],
        'mock':         False,
    }


def generate_brain_viewer(preds: np.ndarray) -> str:
    """
    Generate an interactive 3D brain heatmap using nilearn.
    Returns the full HTML string from view.get_standalone_html().
    """
    try:
        from nilearn import datasets, surface, plotting

        fsavg5 = datasets.fetch_surf_fsaverage('fsaverage5')

        # Use mean activation across time as the stat map
        mean_activation = preds.mean(axis=0)  # (n_vertices,)
        lh_stat = mean_activation[:10242]
        rh_stat = mean_activation[10242:20484]

        vmax = float(np.percentile(np.abs(mean_activation), 95))

        view = plotting.view_surf_stat_map(
            surf_mesh=fsavg5['infl_left'],
            stat_map=lh_stat,
            bg_map=fsavg5['sulc_left'],
            colorbar=True,
            title='NeuralFeed — Cortical Activation',
            symmetric_cbar=False,
            vmax=vmax,
        )
        return view.get_standalone_html()

    except Exception as e:
        logger.warning(f"nilearn viewer generation failed: {e}")
        return (
            '<html><body style="background:#1a1a2e;display:flex;align-items:center;'
            'justify-content:center;height:100vh;margin:0">'
            '<p style="color:#4285f4;font-family:sans-serif">Brain viewer unavailable</p>'
            '</body></html>'
        )


def generate_brain_png(preds: np.ndarray) -> str:
    """
    Generate a static brain PNG for the share card using nilearn.
    Returns base64-encoded PNG string.
    """
    try:
        from nilearn import datasets, plotting
        import matplotlib
        matplotlib.use('Agg')  # Non-interactive backend
        import matplotlib.pyplot as plt

        fsavg5 = datasets.fetch_surf_fsaverage('fsaverage5')
        mean_activation = preds.mean(axis=0)
        lh_stat = mean_activation[:10242]

        fig, ax = plt.subplots(figsize=(4, 3), subplot_kw={'projection': '3d'})
        plotting.plot_surf_stat_map(
            surf_mesh=fsavg5['infl_left'],
            stat_map=lh_stat,
            hemi='left',
            view='lateral',
            bg_map=fsavg5['sulc_left'],
            colorbar=False,
            figure=fig,
            axes=ax,
        )
        buf = BytesIO()
        fig.savefig(buf, format='png', dpi=72, bbox_inches='tight',
                    facecolor='#1a1a2e', edgecolor='none')
        plt.close(fig)
        buf.seek(0)
        return base64.b64encode(buf.read()).decode('utf-8')

    except Exception as e:
        logger.warning(f"Brain PNG generation failed: {e}")
        return ''


# ─── Entry point ──────────────────────────────────────────────────────────────

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='0.0.0.0', port=7860)
