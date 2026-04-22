#!/bin/bash
# TurboQuant+ Automated Deployment Script
# Usage: ./install.sh

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

MODEL_URL="https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/resolve/main/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"
MODEL_PATH="$HOME/models/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"
LLAMA_CPP_DIR="$HOME/llama-cpp-turboquant"
SERVICE_NAME="llama-turboquant"

echo -e "${GREEN}=== TurboQuant+ Deployment Script ===${NC}"
echo ""

# ─── Prerequisites Check ─────────────────────────────────────────────
echo -e "${YELLOW}[1/6] Checking prerequisites...${NC}"

command -v git >/dev/null 2>&1 || { echo -e "${RED}git is required but not installed.${NC}"; exit 1; }
command -v cmake >/dev/null 2>&1 || { echo -e "${RED}cmake is required but not installed.${NC}"; exit 1; }
command -v nvcc >/dev/null 2>&1 || { echo -e "${RED}CUDA toolkit (nvcc) is required but not installed.${NC}"; exit 1; }
command -v nvidia-smi >/dev/null 2>&1 || { echo -e "${RED}NVIDIA drivers (nvidia-smi) are required.${NC}"; exit 1; }

GPU_MEM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -n1 | tr -d ' ')
echo "  ✓ CUDA available ($(nvcc --version | grep release | awk '{print $6}'))"
echo "  ✓ GPU detected ($(nvidia-smi --query-gpu=name --format=csv,noheader | head -n1))"
echo "  ✓ GPU Memory: ${GPU_MEM} MiB"

if [ "$GPU_MEM" -lt 22000 ]; then
    echo -e "${YELLOW}  ⚠ Warning: Less than 22 GB VRAM detected. You may need to reduce context length (-c) or use a smaller model.${NC}"
fi

# ─── Clone llama.cpp ─────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}[2/6] Cloning TurboQuant+ llama.cpp fork...${NC}"

if [ -d "$LLAMA_CPP_DIR" ]; then
    echo "  Directory exists, updating..."
    cd "$LLAMA_CPP_DIR"
    git fetch origin
    git checkout feature/turboquant-kv-cache
    git pull origin feature/turboquant-kv-cache
else
    git clone https://github.com/TheTom/llama-cpp-turboquant.git "$LLAMA_CPP_DIR"
    cd "$LLAMA_CPP_DIR"
    git checkout feature/turboquant-kv-cache
fi

echo "  ✓ llama.cpp ready at $LLAMA_CPP_DIR"

# ─── Build ───────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}[3/6] Building llama.cpp with CUDA...${NC}"
echo "  This may take 10–30 minutes depending on your CPU."

cd "$LLAMA_CPP_DIR"

if [ ! -d "build" ]; then
    cmake -B build -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release
fi

cmake --build build -j"$(nproc)"

# Verify turbo support
if ./build/bin/llama-server --help 2>/dev/null | grep -q "turbo3"; then
    echo "  ✓ Build successful — TurboQuant types detected"
else
    echo -e "${RED}  ✗ Build succeeded but TurboQuant types not found. Check branch.${NC}"
    exit 1
fi

# ─── Download Model ──────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}[4/6] Downloading model (Qwen3.6-35B-A3B Q4_K_M, ~21 GB)...${NC}"

mkdir -p "$HOME/models"

if [ -f "$MODEL_PATH" ]; then
    echo "  Model already exists at $MODEL_PATH"
    echo "  ✓ Skipping download"
else
    echo "  Starting download..."
    curl -L -C - -o "$MODEL_PATH" "$MODEL_URL"
    echo "  ✓ Download complete"
fi

# ─── Install Systemd Service ─────────────────────────────────────────
echo ""
echo -e "${YELLOW}[5/6] Installing systemd service...${NC}"

# Detect current user for service file
CURRENT_USER="${SUDO_USER:-$USER}"
CURRENT_HOME="$(eval echo ~"$CURRENT_USER")"

# We need sudo for system service
if [ "$EUID" -ne 0 ]; then
    echo "  Requesting sudo for system service installation..."
fi

sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" > /dev/null <<EOF
[Unit]
Description=llama.cpp server with TurboQuant (Qwen3.6-35B-A3B)
After=network.target

[Service]
Type=simple
User=${CURRENT_USER}
Group=${CURRENT_USER}
Restart=always
RestartSec=5
WorkingDirectory=${CURRENT_HOME}
Environment="LD_LIBRARY_PATH=${LLAMA_CPP_DIR}/build/bin"
Environment="CUDA_VISIBLE_DEVICES=0"
Environment="HOME=${CURRENT_HOME}"
ExecStart=${LLAMA_CPP_DIR}/build/bin/llama-server \
    -m ${MODEL_PATH} \
    --alias "Qwen3.6-35B-A3B-TurboQuant" \
    -ngl 99 -c 24576 -fa on --jinja \
    --cache-type-k q8_0 --cache-type-v turbo4 \
    -np 1 --metrics --host 0.0.0.0 --port 8080

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"

echo "  ✓ Service installed and enabled for boot"

# ─── Start Service ───────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}[6/6] Starting service...${NC}"

sudo systemctl start "$SERVICE_NAME"

# Wait for server to be ready
for i in {1..30}; do
    if curl -s http://localhost:8080/health >/dev/null 2>&1; then
        echo "  ✓ Server responding on http://localhost:8080"
        break
    fi
    sleep 1
    if [ "$i" -eq 30 ]; then
        echo -e "${RED}  ✗ Server did not start within 30 seconds. Check logs:${NC}"
        echo "    sudo journalctl -u $SERVICE_NAME -n 50"
        exit 1
    fi
done

# ─── Summary ─────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}=== Deployment Complete ===${NC}"
echo ""
echo "  Service:     $SERVICE_NAME"
echo "  Status:      $(sudo systemctl is-active "$SERVICE_NAME")"
echo "  URL:         http://localhost:8080"
echo "  Health:      curl http://localhost:8080/health"
echo "  API:         POST /v1/chat/completions"
echo "  GPU Memory:  $(nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader | head -n1)"
echo ""
echo "  Management:"
echo "    sudo systemctl status $SERVICE_NAME"
echo "    sudo systemctl restart $SERVICE_NAME"
echo "    sudo systemctl stop $SERVICE_NAME"
echo ""
