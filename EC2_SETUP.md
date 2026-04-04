# NeuralFeed EC2 Operations Guide

## Instance Details
- **Public IP**: `3.144.178.72`
- **Port**: `7860` (FastAPI server)
- **User**: `ec2-user`
- **Key file**: `tribev2-key.pem` (in repo root — send this securely to friend)

---

## 1. How to Connect via SSH

### Mac / Linux
```bash
chmod 600 /path/to/tribev2-key.pem
ssh -i /path/to/tribev2-key.pem ec2-user@3.144.178.72
```

### Windows (Git Bash / WSL)
```bash
cp /path/to/tribev2-key.pem /tmp/tribe.pem
chmod 600 /tmp/tribe.pem
ssh -i /tmp/tribe.pem ec2-user@3.144.178.72
```

### Test connection
```bash
ssh -i /tmp/tribe.pem ec2-user@3.144.178.72 "echo connected && uptime"
```

---

## 2. Remove WhisperX from TRIBE v2 (PRIMARY TASK)

The server hangs because WhisperX transcription is slow on CPU (16+ hrs with large model).
TRIBE v2 can work directly from raw video+audio without transcription.

### Step 1 — Find the transcript function
```bash
ssh -i /tmp/tribe.pem ec2-user@3.144.178.72 \
  "grep -n 'def _get_transcript_from_audio\|whisper\|WhisperX' \
   ~/.local/lib/python3.11/site-packages/tribev2/eventstransforms.py | head -30"
```

### Step 2 — View the function body
```bash
ssh -i /tmp/tribe.pem ec2-user@3.144.178.72 \
  "grep -n '' ~/.local/lib/python3.11/site-packages/tribev2/eventstransforms.py | \
   grep -A 40 'def _get_transcript_from_audio'"
```

### Step 3 — Patch it to return empty (skip transcription entirely)

Run this Python one-liner on the EC2 instance to patch the file:

```bash
ssh -i /tmp/tribe.pem ec2-user@3.144.178.72 'python3.11 - << '"'"'EOF'"'"'
import re

path = "/home/ec2-user/.local/lib/python3.11/site-packages/tribev2/eventstransforms.py"
with open(path, "r") as f:
    src = f.read()

# Find the function and replace its body with an immediate empty return
# Pattern: find def _get_transcript_from_audio(...): and replace full body
old_pattern = r"(    def _get_transcript_from_audio\(self[^)]*\):)"
new_body = r"""\1
        # WhisperX removed — too slow on CPU. TRIBE works on raw video/audio directly.
        return []"""

patched = re.sub(old_pattern + r".*?(?=\n    def |\nclass |\Z)", new_body, src, flags=re.DOTALL)

if patched == src:
    print("ERROR: Pattern not matched — function signature may differ. Check manually.")
else:
    with open(path, "w") as f:
        f.write(patched)
    print("SUCCESS: _get_transcript_from_audio patched to return []")
EOF'
```

### Step 4 — If Step 3 fails (manual patch)

SSH in and edit directly:
```bash
ssh -i /tmp/tribe.pem ec2-user@3.144.178.72
nano ~/.local/lib/python3.11/site-packages/tribev2/eventstransforms.py
```

Find the function `_get_transcript_from_audio` and replace its entire body with:
```python
    def _get_transcript_from_audio(self, audio_path, **kwargs):
        # WhisperX removed — too slow on CPU
        return []
```

Save with `Ctrl+O`, exit with `Ctrl+X`.

---

## 3. Fix app.py on the Server (SECONDARY TASK)

The `app.py` running on EC2 has some outdated values. Update it:

### Find where app.py is running from
```bash
ssh -i /tmp/tribe.pem ec2-user@3.144.178.72 \
  "ps aux | grep uvicorn; find /home/ec2-user -name 'app.py' 2>/dev/null"
```

### Fix FFMPEG_BIN path (line 177)
The current code has:
```python
FFMPEG_BIN = '/home/ec2-user/ffmpeg-7.0.2-amd64-static/ffmpeg'
```
It should be:
```python
FFMPEG_BIN = '/usr/local/bin/ffmpeg'
```

Check which ffmpeg is installed:
```bash
ssh -i /tmp/tribe.pem ec2-user@3.144.178.72 "which ffmpeg"
```

---

## 4. Restart the Server

After any patches:

```bash
ssh -i /tmp/tribe.pem ec2-user@3.144.178.72 "
  pkill -f uvicorn
  sleep 2
  cd ~/neurafeed_server  # or wherever app.py lives — check with: find /home/ec2-user -name app.py
  nohup python3.11 -m uvicorn app:app --host 0.0.0.0 --port 7860 > server.log 2>&1 &
  echo 'Server restarted, PID:' \$!
"
```

Watch the logs:
```bash
ssh -i /tmp/tribe.pem ec2-user@3.144.178.72 "tail -f ~/neurafeed_server/server.log"
```

---

## 5. Check Server Health

```bash
curl http://3.144.178.72:7860/health
# Expected: {"status":"ok","mock":false}
```

---

## 6. Test with a Real Video

From your friend's computer:
```bash
curl -X POST http://3.144.178.72:7860/analyze \
  -H "X-Api-Key: mysecretkey" \
  -F "video=@/path/to/test.webm" \
  -F "reel_id=test-001" \
  --max-time 300
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| SSH banner timeout | Instance under heavy load (loading models). Wait 2-3 min and retry. |
| Port 7860 closed | Server not started. See section 4. |
| WhisperX hangs | See section 2 — remove it. |
| `torch.load` UnpicklingError | PyTorch 2.6 compat issue — see cloud_io.py patch below. |
| ffmpeg not found | Run `which ffmpeg` and update `FFMPEG_BIN` in app.py. |

### PyTorch 2.6 cloud_io.py patch (if needed)
```bash
ssh -i /tmp/tribe.pem ec2-user@3.144.178.72 \
  "grep -rn 'torch.load' ~/.local/lib/python3.11/site-packages/tribev2/"
```
Any `torch.load(path)` call needs `weights_only=False` added:
```python
# Before:
torch.load(path)
# After:
torch.load(path, weights_only=False)
```
