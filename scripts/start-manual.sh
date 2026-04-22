#!/bin/bash
# Manual start script (for testing, not as a service)
# Usage: ./start-manual.sh [extra-args]

set -e

MODEL="${HOME}/models/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"
SERVER="${HOME}/llama-cpp-turboquant/build/bin/llama-server"

if [ ! -f "$SERVER" ]; then
    echo "ERROR: llama-server not found at $SERVER"
    echo "Run ./scripts/install.sh first or build manually."
    exit 1
fi

if [ ! -f "$MODEL" ]; then
    echo "ERROR: Model not found at $MODEL"
    echo "Run ./scripts/install.sh first or download manually."
    exit 1
fi

export LD_LIBRARY_PATH="${HOME}/llama-cpp-turboquant/build/bin:${LD_LIBRARY_PATH:-}"

echo "Starting llama-server with TurboQuant..."
echo "Model: $MODEL"
echo "Cache: K=q8_0, V=turbo4"
echo "URL:   http://localhost:8080"
echo ""

exec "$SERVER" \
    -m "$MODEL" \
    --alias "Qwen3.6-35B-A3B-TurboQuant" \
    -ngl 99 \
    -c 24576 \
    -fa on \
    --jinja \
    --cache-type-k q8_0 \
    --cache-type-v turbo4 \
    -np 1 \
    --metrics \
    --host 0.0.0.0 \
    --port 8080 \
    "$@"
