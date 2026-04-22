# TurboQuant+ Deep Dive

## What Problem Does It Solve?

Transformer models store Key and Value tensors for every token in the context window. At long context, this KV cache becomes the **memory bottleneck**:

| Model | Context | fp16 KV Cache | % of RTX 3090 VRAM |
|---|---|---|---|
| Qwen3.6-35B-A3B | 8K | 8.4 GB | 35% |
| Qwen3.6-35B-A3B | 32K | 33.6 GB | 140% ❌ |
| Qwen3.6-35B-A3B | 128K | 134.4 GB | 560% ❌ |

Without compression, long-context inference is impossible on consumer GPUs.

## How TurboQuant Works

### 1. Norm Extraction

Each KV vector `x` is split into magnitude and direction:

```
γ = ||x||       (scalar norm)
x̂ = x / γ      (unit vector)
```

### 2. Walsh-Hadamard Rotation

Apply a random rotation to Gaussianize the distribution:

```
y = WHT(random_signs ⊙ x̂)
```

After rotation, coordinates follow `N(0, 1/d)` — ideal for scalar quantization.

**Validation on real Qwen3 KV tensors:**
```
Raw kurtosis:       900.4
After rotation:     2.9   (Gaussian = 3.0)
```

### 3. PolarQuant (Lloyd-Max Quantization)

Optimal scalar quantization with centroid counts:

| Format | Centroids | Bits/Value | Compression |
|---|---|---|---|
| turbo4 | 16 | 4.25 | 3.8× |
| turbo3 | 8  | 3.5  | 4.6× |
| turbo2 | 4  | 2.5  | 6.4× |

### 4. Block Storage

Values are packed into blocks of 32 for efficient GPU access.

## Quality Validation

### Perplexity (Wikitext-2, 512 context)

| Cache | PPL | vs q8_0 |
|---|---|---|
| f16 | 6.121 | -0.16% |
| q8_0 | 6.111 | baseline |
| **turbo4** | **6.125** | **+0.23%** |
| q4_0 | 6.142 | +0.52% |
| turbo3 | 6.176 | +1.06% |
| turbo2 | 6.507 | +6.48% |

### Needle-In-A-Haystack (Retrieval)

| Test | q8_0 | turbo4 | turbo3 + sparse V |
|---|---|---|---|
| Single needle | 30/33 (90.9%) | **31/33 (93.9%)** | 9/9 |
| Multi-key (distractors) | 100% | 100% | 100% |

turbo4 actually **beats** q8_0 on retrieval — the quantization has a mild denoising effect.

### KL Divergence vs f16

| Cache | Mean KLD | Δp RMS | Same top-p % |
|---|---|---|---|
| q8_0 | 0.001549 | 1.23% | 98.43% |
| **turbo4** | **0.009633** | 2.71% | **95.98%** |
| q4_0 | 0.008091 | 2.75% | 95.83% |

turbo4 is closer to q8_0 than q4_0 is, despite better compression.

## TurboQuant+ Extensions (This Fork)

The `turboquant_plus` repo includes several follow-on findings:

### 1. Sparse V Dequant

Skip dequantizing V positions where attention weight < 1e-6.

- **+22.8% decode speed** at 32K context
- Zero PPL change (validated with 50 chunks, CI ±0.021)
- Works on all KV formats (not just TurboQuant)

### 2. Boundary V (Layer-Aware)

Protect first 2 + last 2 layers at higher precision.

| Model | turbo2 PPL | Boundary V PPL | Recovery |
|---|---|---|---|
| Qwen3.5-35B MoE | 5.257 | 5.148 | 91% |
| phi-4 | 4.835 | 4.784 | 55% |

### 3. Block Size Optimization

Increase storage block size from 32 → 128:

- turbo3: 3.5 bits/val → 3.125 bits/val
- Additional 12% compression
- Zero quality cost

### 4. Norm Correction

Per-channel norm correction ported from community contributor @spiritbuun:

- **-1.17% PPL on CUDA** (beats q8_0!)
- +1.1% PPL on Metal

## Speed Benchmarks

### Prefill (tokens/sec)

| Context | turbo4 | turbo3 | q8_0 | turbo4/q8_0 |
|---|---|---|---|---|
| 2K | 2,682 | 2,708 | 2,665 | 1.01× |
| 8K | 2,041 | 2,054 | 2,002 | 1.02× |
| 16K | 1,621 | 1,698 | 1,605 | 1.01× |
| 32K | 1,141 | 1,204 | 1,098 | **1.04×** |

At long context, compressed cache uses less memory bandwidth → faster prefill.

### Decode (tokens/sec, Qwen3.5-35B-A3B MoE)

| Config | Short | Long (32K) | vs q8_0 |
|---|---|---|---|
| q8_0 | 85.71 | 68.2 | baseline |
| turbo4 | 79.87 | 63.7 | 0.93× |
| turbo3 | 76.84 | 53.3 | 0.78× |

Decode is slightly slower due to dequant overhead, but the gap shrinks at long context.

## When to Use Which Format

| Scenario | K Cache | V Cache | Reason |
|---|---|---|---|
| **Default (Q4_K_M)** | q8_0 | turbo4 | Asymmetric rescues quality |
| **Default (Q8_0+)** | turbo4 | turbo4 | Symmetric works fine |
| **Extreme memory pressure** | q8_0 | turbo3 | 4.6× V compression |
| **Max compression** | turbo2 | turbo2 | 6.4×, +6.5% PPL |
| **Best quality** | q8_0 | q8_0 | Baseline, no compression |

## Further Reading

- [TurboQuant Paper](https://arxiv.org/abs/2504.19874) — Google Research, ICLR 2026
- [PolarQuant Paper](https://arxiv.org/abs/2502.02617) — AISTATS 2026
- [QJL Paper](https://arxiv.org/abs/2406.03482) — Original quantization method
- [Google Research Blog](https://research.google/blog/turboquant-redefining-ai-efficiency-with-extreme-compression/)
