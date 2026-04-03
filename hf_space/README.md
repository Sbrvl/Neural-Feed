---
title: NeuralFeed
emoji: 🧠
colorFrom: blue
colorTo: red
sdk: docker
pinned: false
---

# NeuralFeed — HuggingFace Space

FastAPI backend for the NeuralFeed Chrome extension.
Runs Meta TRIBE v2 brain encoding inference on social media reels.

## Endpoints

- `POST /analyze` — accepts `.webm` video, returns brain network scores + 3D viewer HTML
- `GET /health` — liveness check (call this to pre-warm the Space before a demo)

## Setup

1. Create a HuggingFace Space (Docker SDK)
2. Enable ZeroGPU in Space settings
3. Upload `app.py`, `parcellation.py`, `requirements.txt`, `Dockerfile`
4. Set `API_KEY` in Space Secrets (Settings → Repository secrets)
5. For development: set `MOCK_TRIBE=1` to return hardcoded responses instantly

## Development mode

Set `MOCK_TRIBE=1` in Space secrets to bypass TRIBE v2 inference and return
hardcoded JSON. Use this on Saturday morning to test the full Chrome extension
pipeline before real inference is wired up. Unset for real demo.
