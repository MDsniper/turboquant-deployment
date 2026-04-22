# GPU-Specific Configurations

This directory contains pre-tuned systemd service files for different NVIDIA GPUs.

## Available Configs

| Config | GPU | VRAM | Model | Context | Status |
|---|---|---|---|---|---|
| [`rtx3090-24gb`](rtx3090-24gb/) | RTX 3090 | 24 GB | Qwen3.6-35B-A3B Q4_K_M | 24,576 | ✅ Tested |
| [`rtx4080-16gb`](rtx4080-16gb/) | RTX 4080 | 16 GB | Qwen3.6-35B-A3B Q4_K_S / IQ4_XS | 12,288 | 📝 Template |

## How to Use

### Option 1: Copy the service file manually

```bash
# Pick your GPU config
sudo cp configs/rtx4080-16gb/llama-turboquant.service /etc/systemd/system/

# Edit it to set your username and correct model path
sudo nano /etc/systemd/system/llama-turboquant.service

# Reload and start
sudo systemctl daemon-reload
sudo systemctl enable --now llama-turboquant
```

### Option 2: Use the install script with a profile

```bash
./scripts/install.sh --gpu rtx4080
```

## Model Selection by GPU

### RTX 3090 / 4090 (24 GB)

| Model | Quant | Size | Context | Fit |
|---|---|---|---|---|
| Qwen3.6-35B-A3B | Q4_K_M | ~21 GB | 24K | ✅ Perfect |
| Qwen3.6-35B-A3B | Q5_K_M | ~25 GB | 8K | ⚠️ Tight |

### RTX 4080 / 4070 Ti Super (16 GB)

| Model | Quant | Size | Context | Fit |
|---|---|---|---|---|
| Qwen3.6-35B-A3B | IQ4_XS | ~13 GB | 12K | ✅ Good |
| Qwen3.6-35B-A3B | Q4_K_S | ~16 GB | 8K | ⚠️ Tight |
| Qwen2.5-14B | Q8_0 | ~14 GB | 16K | ✅ Good |
| Qwen3-8B | Q8_0 | ~8 GB | 32K | ✅ Lots of room |

### RTX 4060 Ti / Laptop (8 GB)

| Model | Quant | Size | Context | Fit |
|---|---|---|---|---|
| Qwen3-8B | Q4_K_M | ~5 GB | 16K | ✅ Good |
| Qwen2.5-7B | Q8_0 | ~7 GB | 8K | ✅ Good |
| Llama-3.1-8B | Q8_0 | ~8 GB | 8K | ⚠️ Tight |

## Creating a New Config

1. Copy an existing config:
   ```bash
   cp -r configs/rtx3090-24gb configs/YOUR_GPU
   ```

2. Edit the service file:
   - Adjust `-c` (context) based on your VRAM
   - Change the model path to your chosen `.gguf`
   - Update the description comment

3. Test VRAM usage before committing:
   ```bash
   nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader
   ```

4. Submit a PR if you want to share it!
