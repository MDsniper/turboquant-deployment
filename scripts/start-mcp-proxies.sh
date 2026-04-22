#!/bin/bash
# Start all 4 MCP SSE proxies directly on the host
# No Docker needed — uses Node.js directly

cd "$(dirname "$0")/../docker"

export Z_AI_API_KEY="${Z_AI_API_KEY:-}"

if [ -z "$Z_AI_API_KEY" ]; then
    echo "Error: Z_AI_API_KEY not set."
    echo "Export it first: export Z_AI_API_KEY='your_key'"
    exit 1
fi

# Kill any existing proxy instances
pkill -f "mcp-sse-proxy.js" 2>/dev/null || true
sleep 1

echo "Starting MCP SSE proxies on host..."

# Search
PORT=3002 MCP_BACKEND_TYPE=http MCP_BACKEND_URL=https://api.z.ai/api/mcp/web_search_prime/mcp \
    node mcp-sse-proxy.js > /tmp/mcp-search.log 2>&1 &
echo "Search proxy    → http://localhost:3002/sse  (PID: $!)"

# Reader
PORT=3003 MCP_BACKEND_TYPE=http MCP_BACKEND_URL=https://api.z.ai/api/mcp/web_reader/mcp \
    node mcp-sse-proxy.js > /tmp/mcp-reader.log 2>&1 &
echo "Reader proxy    → http://localhost:3003/sse  (PID: $!)"

# ZRead
PORT=3004 MCP_BACKEND_TYPE=http MCP_BACKEND_URL=https://api.z.ai/api/mcp/zread/mcp \
    node mcp-sse-proxy.js > /tmp/mcp-zread.log 2>&1 &
echo "ZRead proxy     → http://localhost:3004/sse  (PID: $!)"

# Vision
PORT=3005 MCP_BACKEND_TYPE=stdio MCP_BACKEND_CMD=npx MCP_BACKEND_ARGS='["-y","@z_ai/mcp-server"]' \
    node mcp-sse-proxy.js > /tmp/mcp-vision.log 2>&1 &
echo "Vision proxy    → http://localhost:3005/sse  (PID: $!)"

sleep 2
echo ""
echo "All proxies started. Checking status..."
for port in 3002 3003 3004 3005; do
    if curl -s -o /dev/null --max-time 2 "http://localhost:${port}/sse"; then
        echo "  Port ${port}: OK"
    else
        echo "  Port ${port}: FAILED (check /tmp/mcp-*.log)"
    fi
done

echo ""
echo "Add these URLs to your webchat tool:"
echo "  http://YOUR_IP:3002/sse  → Search"
echo "  http://YOUR_IP:3003/sse  → Reader"
echo "  http://YOUR_IP:3004/sse  → ZRead"
echo "  http://YOUR_IP:3005/sse  → Vision"
echo ""
echo "To stop: pkill -f mcp-sse-proxy.js"
