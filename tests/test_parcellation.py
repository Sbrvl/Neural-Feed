"""
tests/test_parcellation.py — pytest unit tests for parcellation.py

Run: pytest tests/test_parcellation.py -v
"""

import numpy as np
import pytest
import sys
import os

# Add hf_space to path so we can import parcellation
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'hf_space'))


# ─── Helpers ─────────────────────────────────────────────────────────────────

def make_preds(n_timesteps=30, n_vertices=20484, seed=42):
    rng = np.random.default_rng(seed)
    return rng.standard_normal((n_timesteps, n_vertices)).astype(np.float32)


# ─── Z-score tests (no atlas needed) ─────────────────────────────────────────

def test_zscore_normal():
    from parcellation import _zscore_timeseries
    ts = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
    z = _zscore_timeseries(ts)
    assert abs(z.mean()) < 1e-6, "Z-scored mean should be ~0"
    assert abs(z.std() - 1.0) < 1e-6, "Z-scored std should be ~1"


def test_zscore_flat_signal_returns_zeros():
    """Flat signal (std=0) should return zeros, not NaN."""
    from parcellation import _zscore_timeseries
    ts = np.ones(30)
    z = _zscore_timeseries(ts)
    assert not np.any(np.isnan(z)), "NaN in z-score output for flat signal"
    assert np.all(z == 0.0), "Flat signal should z-score to all zeros"


def test_zscore_preserves_shape():
    from parcellation import _zscore_timeseries
    ts = np.random.randn(50)
    z = _zscore_timeseries(ts)
    assert z.shape == ts.shape


# ─── Brain rot formula tests ──────────────────────────────────────────────────

def test_brain_rot_no_division_by_zero():
    """fpn=0 should not cause ZeroDivisionError — floor at 0.01."""
    reward, dmn, fpn = 1.0, 1.0, 0.0
    brain_rot = (reward + dmn) / max(fpn, 0.01)
    assert np.isfinite(brain_rot), "brain_rot should be finite when fpn=0"
    assert brain_rot == 200.0  # (1+1)/0.01


def test_brain_rot_normal_values():
    reward, dmn, fpn = 0.5, 0.8, 0.6
    brain_rot = (reward + dmn) / max(fpn, 0.01)
    assert abs(brain_rot - (1.3 / 0.6)) < 1e-6


def test_brain_rot_all_equal():
    """When all networks are equal, brain rot = 2."""
    v = 1.0
    brain_rot = (v + v) / max(v, 0.01)
    assert brain_rot == 2.0


# ─── API tests (requires running FastAPI app) ─────────────────────────────────
# These use httpx/TestClient — mark slow and require MOCK_TRIBE=1

@pytest.mark.skipif(
    os.getenv('MOCK_TRIBE') != '1',
    reason="Requires MOCK_TRIBE=1 and FastAPI app"
)
def test_mock_endpoint_returns_valid_shape():
    """POST /analyze in mock mode should return JSON with all required fields."""
    os.environ['MOCK_TRIBE'] = '1'
    from fastapi.testclient import TestClient
    from app import app

    client = TestClient(app)

    dummy_video = b'\x00' * 1024  # 1KB fake webm
    response = client.post(
        '/analyze',
        files={'video': ('test.webm', dummy_video, 'video/webm')},
        data={'reel_id': 'test-reel-123'},
        headers={'X-API-Key': ''},
    )
    assert response.status_code == 200
    data = response.json()
    required = ['reel_id', 'dmn', 'fpn', 'reward', 'brain_rot', 'timeseries', 'viewer_html']
    for field in required:
        assert field in data, f"Missing field: {field}"
    assert data['mock'] is True
    assert len(data['timeseries']) == 30


@pytest.mark.skipif(
    os.getenv('MOCK_TRIBE') != '1',
    reason="Requires MOCK_TRIBE=1 and FastAPI app"
)
def test_missing_api_key_returns_401():
    os.environ['MOCK_TRIBE'] = '1'
    os.environ['API_KEY'] = 'secret-key'
    from fastapi.testclient import TestClient
    import importlib
    import app as app_module
    importlib.reload(app_module)

    client = TestClient(app_module.app)
    response = client.post(
        '/analyze',
        files={'video': ('test.webm', b'\x00' * 1024, 'video/webm')},
        data={'reel_id': 'test'},
        # No X-API-Key header
    )
    assert response.status_code == 401
    del os.environ['API_KEY']


@pytest.mark.skipif(
    os.getenv('MOCK_TRIBE') != '1',
    reason="Requires MOCK_TRIBE=1 and FastAPI app"
)
def test_oversized_file_returns_413():
    os.environ['MOCK_TRIBE'] = '1'
    from fastapi.testclient import TestClient
    from app import app

    client = TestClient(app)
    big_video = b'\x00' * (51 * 1024 * 1024)  # 51MB
    response = client.post(
        '/analyze',
        files={'video': ('big.webm', big_video, 'video/webm')},
        data={'reel_id': 'test'},
        headers={'X-API-Key': ''},
    )
    assert response.status_code == 413


@pytest.mark.skipif(
    os.getenv('MOCK_TRIBE') != '1',
    reason="Requires MOCK_TRIBE=1 and FastAPI app"
)
def test_health_endpoint():
    from fastapi.testclient import TestClient
    from app import app
    client = TestClient(app)
    response = client.get('/health')
    assert response.status_code == 200
    assert response.json()['status'] == 'ok'
