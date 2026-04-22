# TurboQuant+ Deployment Guide

> Deploy [Qwen3.6-35B-A3B-GGUF](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF) with [TurboQuant+](https://github.com/TheTom/turboquant_plus) KV-cache compression on NVIDIA GPUs using llama.cpp.

**Author:** [@TheTom](https://github.com/TheTom) (TurboQuant+), [@unsloth](https://huggingface.co/unsloth) (GGUF quantization)  
**Target Hardware:** NVIDIA RTX 3090 24GB (tested & validated — also adaptable to RTX 4090, 5090, A100, H100)  
**OS:** Ubuntu 22.04+ / Debian 12+  
**Last Updated:** 2026-04-22

---

## What is TurboQuant+?

TurboQuant is a KV-cache compression technique from Google Research (ICLR 2026) that achieves **3.8–6.4× compression** of transformer attention caches with near-zero quality loss.

| Cache Type | Bits/Value | Compression | Quality vs q8_0 |
|---|---|---|---|
| `f16` | 16.0 | 1.0× | baseline |
| `q8_0` | 8.5 | 1.9× | baseline |
| **turbo4** | **4.25** | **3.8×** | **+0.23%** |
| `q4_0` | 4.5 | 3.6× | +0.52% |
| **turbo3** | **3.5** | **4.6×** | **+1.06%** |
| **turbo2** | **2.5** | **6.4×** | **+6.48%** |

### Key Insight: Asymmetric K/V

For low-bit weight models (Q4_K_M), **all quality degradation comes from K compression**, not V compression. The recommended configuration is:

- **K cache:** `q8_0` (high precision — controls attention routing)
- **V cache:** `turbo4` (3.8× compression — free quality-wise)

This rescues models where symmetric turbo (`turbo3/turbo3`) would be catastrophic.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  System Boot → systemd service              │
│  ├── Runs as dedicated user                 │
│  ├── Auto-restart on crash (5s delay)       │
│  └── GPU persistence across reboots         │
│                                               │
│  llama-server (port 8080)                   │
│  ├── Model: Qwen3.6-35B-A3B Q4_K_M (21 GB)  │
│  ├── GPU offload: 99 layers (100%)          │
│  ├── Context: 24,576 tokens                 │
│  ├── Flash Attention: ON                    │
│  ├── KV Cache K: q8_0                       │
│  └── KV Cache V: turbo4 (3.8× compression)  │
│                                               │
│  OpenAI-compatible API                      │
│  └── POST /v1/chat/completions              │
└─────────────────────────────────────────────┘
                    │
                    ▼
         NVIDIA RTX 3090 24 GB
         (21.6 GB VRAM used at idle)
```

---

## Quick Start

```bash
# 1. Clone this repo
git clone https://github.com/YOUR_USERNAME/turboquant-deployment.git
cd turboquant-deployment

# 2. Run the installer (downloads model + builds llama.cpp)
./scripts/install.sh

# 3. Enable and start the systemd service
sudo systemctl enable --now llama-turboquant

# 4. Verify
curl http://localhost:8080/health
# {"status":"ok"}
```

---

## Prerequisites

### Hardware

| Component | Minimum | Recommended |
|---|---|---|
| GPU | NVIDIA with 16 GB VRAM | RTX 3090 / 4090 / A100 (24 GB+) |
| RAM | 32 GB | 64 GB |
| Storage | 50 GB free | 100 GB SSD |

### Software

```bash
# Ubuntu / Debian
sudo apt update
sudo apt install -y \
    git cmake build-essential \
    nvidia-driver-550 nvidia-cuda-toolkit \
    curl jq

# Verify CUDA
nvcc --version
nvidia-smi
```

---

## Manual Deployment

If you prefer to understand each step, follow this guide instead of the install script.

### Step 1: Clone TurboQuant+ llama.cpp Fork

```bash
git clone https://github.com/TheTom/llama-cpp-turboquant.git
cd llama-cpp-turboquant
git checkout feature/turboquant-kv-cache
```

### Step 2: Build with CUDA

```bash
cmake -B build -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)
```

**Verify TurboQuant support:**
```bash
./build/bin/llama-server --help | grep turbo
# Expected: turbo2, turbo3, turbo4 listed under --cache-type-k and --cache-type-v
```

### Step 3: Download the Model

```bash
mkdir -p ~/models
cd ~/models

# Qwen3.6-35B-A3B Q4_K_M — sweet spot for 24 GB VRAM
curl -L -C - -O \
  "https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/resolve/main/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"
```

**File size:** ~21 GB  
**VRAM usage at load:** ~21.6 GB

### Step 4: Test Manually

```bash
./build/bin/llama-server \
  -m ~/models/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf \
  -ngl 99 -c 24576 -fa on --jinja \
  --cache-type-k q8_0 --cache-type-v turbo4 \
  --host 0.0.0.0 --port 8080
```

> **Note:** This guide was written for and tested on an **RTX 3090 24GB**. VRAM numbers and context sizes are specific to this card. Adjust `-c` (context) and model quantization if using a different GPU.

In another terminal:
```bash
curl http://localhost:8080/health
```

### Step 5: Create Systemd Service (Boot-Time Auto-Start)

Copy the provided service file:

```bash
sudo cp systemd/llama-turboquant.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now llama-turboquant
```

**Why system-level (not user-level)?**

| | User Service | System Service |
|---|---|---|
| Starts on | User login | **System boot** |
| Needs login? | Yes | **No** |
| GPU access | Yes | Yes (with `User=` directive) |
| Use case | Desktop/workstation | **Server/headless** |

Our service runs as your user but is managed by systemd system, giving us the best of both worlds.

---

## Configuration Reference

### llama-server Flags Explained

| Flag | Value | Explanation |
|---|---|---|
| `-m` | path to `.gguf` | Model weights file |
| `-ngl 99` | max layers | Offload all layers to GPU |
| `-c 24576` | tokens | Max context length. Reduce if OOM |
| `-fa on` | boolean | Flash Attention — faster + less memory |
| `--jinja` | boolean | Modern chat template support (Qwen3 native) |
| `--cache-type-k q8_0` | `f16`, `q8_0`, `q4_0`, `turbo2-4` | Key cache precision |
| `--cache-type-v turbo4` | `f16`, `q8_0`, `q4_0`, `turbo2-4` | Value cache precision |
| `-np 1` | integer | Parallel sequences (slots) |
| `--metrics` | boolean | Expose Prometheus-style metrics |
| `--host 0.0.0.0` | IP | Bind to all interfaces |
| `--port 8080` | port | HTTP server port |

### Context Length Sizing

For RTX 3090 24 GB with Qwen3.6-35B-A3B Q4_K_M:

| Context | VRAM | Use Case |
|---|---|---|
| 8,192 | ~19 GB | Safe, lots of headroom |
| **24,576** | **~21.6 GB** | **Default — good balance** |
| 32,768 | ~23 GB | Aggressive, minimal headroom |

If you get CUDA OOM errors, lower `-c`.

---

## API Usage

### Chat Completions (OpenAI-compatible)

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen3.6-35B-A3B-TurboQuant",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Explain quantum computing in simple terms."}
    ],
    "max_tokens": 512,
    "temperature": 0.7
  }'
```

### Health Check

```bash
curl http://localhost:8080/health
# {"status":"ok"}
```

### List Models

```bash
curl http://localhost:8080/v1/models
```

### Streaming Response

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen3.6-35B-A3B-TurboQuant",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

---

## Service Management

```bash
# View status and recent logs
sudo systemctl status llama-turboquant

# View full logs
sudo journalctl -u llama-turboquant -f

# Restart after config changes
sudo systemctl restart llama-turboquant

# Stop temporarily
sudo systemctl stop llama-turboquant

# Disable auto-start on boot
sudo systemctl disable llama-turboquant
```

---

## Monitoring

### GPU Usage

```bash
# Real-time
watch -n 1 nvidia-smi

# One-shot
nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu \
  --format=csv,noheader
```

### Server Metrics

If `--metrics` is enabled:

```bash
curl http://localhost:8080/metrics
```

Returns Prometheus-compatible metrics including:
- `llama_tokens_predicted_total`
- `llama_tokens_evaluated_total`
- `llama_prompt_tokens_total`
- Request latency histograms

---

## Benchmarking

### llama.cpp Built-in Benchmark

```bash
./llama-cpp-turboquant/build/bin/llama-bench \
  -m ~/models/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf \
  -ngl 99 -fa 1 \
  --cache-type-k q8_0 --cache-type-v turbo4
```

### Expected Performance (RTX 3090)

Based on community benchmarks with similar MoE models:

| Phase | Tokens/sec | Notes |
|---|---|---|
| Prefill (pp512) | ~3,500–3,700 | Matches q8_0 baseline |
| Decode (tg128) | ~95–102 | Within 4–7% of q8_0 |

TurboQuant's advantage grows with **long context** — less memory bandwidth = faster attention at 16K+ tokens.

---

## Model Selection Guide

### For 24 GB VRAM (RTX 3090 / 4090)

| Model | Quantization | Size | Fit | KV Recommendation |
|---|---|---|---|---|
| Qwen3.6-35B-A3B | **Q4_K_M** | 21 GB | ✅ Perfect | q8_0-K + turbo4-V |
| Qwen3.6-35B-A3B | Q5_K_M | ~25 GB | ⚠️ Tight | q8_0-K + turbo4-V |
| Qwen3.6-35B-A3B | Q8_0 | ~35 GB | ❌ No | — |

### For 16 GB VRAM (RTX 4080 / 4060 Ti)

Use a smaller model or more aggressive quantization:
- Qwen3.6-35B-A3B IQ3_XXS / IQ4_XS
- Qwen2.5-14B Q8_0

### For 48+ GB VRAM (A6000 / A100)

- Qwen3.6-35B-A3B Q5_K_M or Q8_0
- Symmetric turbo4/turbo4 works well with Q8_0 weights

---

## Troubleshooting

### CUDA Out of Memory

```bash
# Reduce context length
-c 8192    # instead of 24576

# Or use a smaller model
```

### Service Fails to Start

```bash
# Check logs
sudo journalctl -u llama-turboquant -n 50 --no-pager

# Common causes:
# 1. Model file not found — verify path in service file
# 2. Port 8080 already in use — change --port
# 3. GPU driver issue — run nvidia-smi to verify
```

### Slow First Request

This is normal. The model is already loaded in GPU memory. The "warmup" is:
1. CUDA kernel compilation (first run only)
2. First token generation initializes CUDA graphs

Subsequent requests will be fast.

### TurboQuant Types Not Available

```bash
# Verify you built from the correct branch
cd llama-cpp-turboquant
git branch --show-current
# Should print: feature/turboquant-kv-cache

# Rebuild if needed
cmake --build build -j$(nproc)
```

---

## Updating

### Update llama.cpp

```bash
cd llama-cpp-turboquant
git pull origin feature/turboquant-kv-cache
cmake --build build -j$(nproc)
sudo systemctl restart llama-turboquant
```

### Update Model

```bash
cd ~/models
# Download newer version
curl -L -C - -O "https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/resolve/main/NEW_VERSION.gguf"
# Update model path in /etc/systemd/system/llama-turboquant.service
sudo systemctl daemon-reload
sudo systemctl restart llama-turboquant
```

---

## References

- [TurboQuant+ Repository](https://github.com/TheTom/turboquant_plus)
- [TurboQuant Paper](https://arxiv.org/abs/2504.19874) (ICLR 2026)
- [PolarQuant Paper](https://arxiv.org/abs/2502.02617) (AISTATS 2026)
- [Google Research Blog Post](https://research.google/blog/turboquant-redefining-ai-efficiency-with-extreme-compression/)
- [Model: unsloth/Qwen3.6-35B-A3B-GGUF](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/tree/main)
- [llama.cpp Server Documentation](https://github.com/ggml-org/llama.cpp/blob/master/examples/server/README.md)

---

## License

This deployment guide is provided as-is. TurboQuant+ and llama.cpp are under their respective licenses (Apache 2.0). Model weights are subject to the original model license (Qwen license).
