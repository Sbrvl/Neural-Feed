# NeuralFeed — TODOS

Generated from /plan-ceo-review + /plan-eng-review on 2026-04-03

---

## TODO 1: Video stream isolation
**What:** Test capturing the `<video>` element's srcObject MediaStream directly instead of using chrome.tabCapture.
**Why:** tabCapture records the full Instagram tab UI (scroll chrome, surrounding content). TRIBE v2 was trained on clean naturalistic video. Direct video stream = cleaner model input = better predictions.
**Pros:** Eliminates out-of-distribution input. Cleaner TRIBE v2 predictions. No UI wrapper artifacts.
**Cons:** Instagram uses Media Source Extensions (MSE) which may block srcObject access. Requires testing.
**Context:** The current architecture uses chrome.tabCapture (offscreen.js → MediaRecorder). MSE/DRM was the original reason for choosing tabCapture. Worth retesting with current Chrome MSE behavior.
**Depends on / blocked by:** — (independent investigation)

---

## TODO 2: Population baseline normalization
**What:** Pre-compute per-network mean/std across a corpus of ~50 diverse reels. Store as baseline in the HF Space. New reels normalized against the population baseline instead of Z-scored within themselves.
**Why:** Per-reel Z-score makes scores internally consistent but not cross-session or cross-user comparable. A reel with uniformly flat activation Z-scores the same as a reel with dramatic peaks. Population baseline makes brain_rot scores meaningful as a persistent number.
**Pros:** Cross-reel and cross-session comparison. "Your score today vs last week" becomes valid. Scientifically defensible.
**Cons:** Requires ~50 reel corpus to compute baseline. Baseline may need to be regenerated for different user populations or platform mixes. Runtime: ~2-4 GPU-hours on ZeroGPU.
**Context:** Current implementation Z-scores each network across the reel's own timeseries before computing brain_rot_score = (reward + dmn) / max(fpn, 0.01). This gives consistent relative values within a reel but absolute values drift across reels.
**Depends on / blocked by:** Core pipeline working (ship hackathon build first)

---

## TODO 3: Dedicated HF Inference Endpoint
**What:** Upgrade from ZeroGPU (shared, queued) to a HuggingFace Dedicated Inference Endpoint.
**Why:** ZeroGPU has a global request queue — if the Space is popular or cold (idle >15 min), first requests wait 15-60+ seconds. Dedicated endpoint gives reserved A10G with guaranteed latency of 5-15s.
**Pros:** Reliable demo latency. No queue pressure. Can serve multiple users simultaneously.
**Cons:** ~$0.60/hr for A10G (~$15/day always-on, ~$4/day if scaled to zero). Not free.
**Context:** For the hackathon demo, ZeroGPU + pre-warm is sufficient. Post-hackathon if usage grows or if you want to demonstrate the product seriously, upgrade to dedicated.
**Depends on / blocked by:** Post-hackathon, after confirming there's interest

---

## TODO 4: Server-side job polling
**What:** Replace the long-lived open HTTP fetch with a job ID pattern. Server returns `{job_id}` immediately. Extension polls `/result/{job_id}` every 30s until complete.
**Why:** A 35-minute open fetch will eventually be suspended by Chrome's renderer process lifecycle. Current workaround (35-min AbortController timeout) works for demo but will silently fail in production for long CPU-mode sessions.
**Pros:** Robust to SW restarts and renderer suspension. Enables progress reporting. Allows graceful retry on server restart.
**Cons:** Requires server changes (job queue in app.py, new /result endpoint). Adds polling complexity to offscreen.js.
**Context:** Identified in /plan-eng-review (2026-04-04). For hackathon, MOCK_TRIBE=1 makes inference ~1s so not blocking. For real inference post-hackathon, this is the correct architecture.
**Depends on / blocked by:** Core session mode working (ship hackathon build first)

---

## TODO 5: Session reset button
**What:** Add a "Reset Session" button in the popup. Clicking it clears chrome.storage.session totals and resets reelCount to 0.
**Why:** STOP does NOT clear stats by design. Users can't start a fresh comparison session without relaunching Chrome.
**Pros:** Simple UX. One button + one message handler + one storage clear. 5 min to add.
**Cons:** Risk of accidental reset if placed too close to Stop button.
**Context:** Identified in /plan-eng-review (2026-04-04). Bundle into the popup.js rewrite pass.
**Depends on / blocked by:** popup.js rewrite (bundle into same PR)
