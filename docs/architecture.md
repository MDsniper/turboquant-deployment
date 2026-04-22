# Architecture Deep Dive

## System Design

This deployment combines three technologies into a production-ready local LLM inference stack:

1. **llama.cpp** — High-performance inference engine
2. **TurboQuant+** — KV-cache compression extension
3. **systemd** — Process supervision and boot-time orchestration

## Component Interaction

```
┌─────────────────────────────────────────────────────────────┐
│                         USER                                │
│  curl / OpenAI client / Chat UI / Claude Code / etc.        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ HTTP/8080
┌─────────────────────────────────────────────────────────────┐
│                   llama-server (C++)                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │ HTTP Server │  │ Chat Template│  │  Slot Manager       │ │
│  │ (port 8080) │  │ (Jinja/Qwen) │  │  (parallel reqs)    │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
│                              │                              │
│                   ┌──────────┴──────────┐                   │
│                   ▼                     ▼                   │
│  ┌─────────────────────────┐  ┌─────────────────────────┐  │
│  │   llama.cpp Engine      │  │   GGML Compute Graph    │  │
│  │   (model loading,       │  │   (CUDA kernels,        │  │
│  │    tokenization,        │  │    flash attention,     │  │
│  │    sampling)            │  │    turboquant dequant)  │  │
│  └─────────────────────────┘  └─────────────────────────┘  │
│                   │                     │                   │
│                   └──────────┬──────────┘                   │
│                              ▼                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              KV Cache Storage                        │   │
│  │  ┌──────────────┐        ┌──────────────┐           │   │
│  │  │  K Cache     │        │  V Cache     │           │   │
│  │  │  q8_0        │        │  turbo4      │           │   │
│  │  │  (8-bit)     │        │  (4.25-bit)  │           │   │
│  │  │  1.9× comp   │        │  3.8× comp   │           │   │
│  │  └──────────────┘        └──────────────┘           │   │
│  │                                                     │   │
│  │  Total KV compression: ~3.0× vs fp16                │   │
│  │  Memory saved at 24K context: ~3.2 GB               │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ CUDA
┌─────────────────────────────────────────────────────────────┐
│              NVIDIA GPU (RTX 3090 24 GB)                    │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Model Weights (Q4_K_M)              ~21.0 GB       │    │
│  │  KV Cache (asymmetric)               ~2.5 GB        │    │
│  │  CUDA Graphs / Overhead              ~1.0 GB        │    │
│  │  ─────────────────────────────────────────          │    │
│  │  Total Used                          ~24.5 GB       │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## Why Asymmetric KV?

TurboQuant's research revealed that **K precision dominates attention quality** because:

1. **Keys route attention** via softmax: `softmax(Q · K^T / √d)`
2. **Values only accumulate** weighted outputs: `Σ(softmax_weights · V)`
3. K quantization error propagates through the softmax nonlinearity
4. V quantization error is linearly averaged — much more forgiving

For Q4_K_M weight models, the stacking of low-bit weights + low-bit KV cache causes quality collapse. Asymmetric KV solves this by protecting K at full q8_0 precision.

## Memory Math

### Without TurboQuant (fp16 KV)

For Qwen3.6-35B-A3B at 24,576 context:

```
KV cache per layer = 2 × num_heads × head_dim × context × 2 bytes (fp16)
                   ≈ 2 × 32 × 128 × 24576 × 2
                   ≈ 402 MB per layer

Total KV (64 layers) ≈ 25.7 GB fp16
```

This alone exceeds 24 GB VRAM — impossible without offloading.

### With TurboQuant (asymmetric)

```
K cache: 25.7 GB / 2 (q8_0)    = 12.9 GB
V cache: 25.7 GB / 3.8 (turbo4) = 6.8 GB
Total KV                         = 19.7 GB

Savings vs fp16: 6.0 GB (23%)
Savings vs q8_0: 6.0 GB (23%)
```

Combined with Q4_K_M weights (~21 GB), the entire inference fits in 24 GB.

## Boot Process

```
Linux Kernel
    │
    ▼
nvidia-driver loaded (modules + CUDA runtime)
    │
    ▼
network.target reached
    │
    ▼
systemd starts llama-turboquant.service
    │
    ├──► Runs as <USER> user
    │
    ├──► Sets LD_LIBRARY_PATH for custom libs
    │
    ├──► llama-server loads Q4_K_M model to GPU
    │         (~30 seconds for 21 GB)
    │
    └──► Binds to 0.0.0.0:8080
              │
              ▼
         Ready for requests
```

## Failure Modes & Recovery

| Failure | systemd Response | Recovery Time |
|---|---|---|
| llama-server crash | Restart after 5s | ~5s + model load (~30s) |
| GPU driver error | Restart after 5s | Depends on driver reset |
| Port conflict | Restart after 5s | Manual fix required |
| Model file missing | Immediate fail | Manual fix required |
| OOM kill | Restart after 5s | Reduce -c in config |

## Security Considerations

By default, the server binds to `0.0.0.0:8080` (all interfaces). In production:

1. **Bind to localhost only** if using a reverse proxy:
   ```
   --host 127.0.0.1 --port 8080
   ```

2. **Use nginx/caddy** for TLS termination and auth

3. **Firewall rules:**
   ```bash
   sudo ufw allow from 10.0.0.0/8 to any port 8080
   ```

4. **API key support:** llama-server supports `--api-key` flag
