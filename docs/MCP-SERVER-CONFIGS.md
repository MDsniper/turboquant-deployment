# Z.AI MCP Server Configuration Reference

> Complete configuration for connecting Z.AI MCP servers to your local TurboQuant llama-server setup.

---

## Architecture Reality Check

**What you have:**

```
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────┐
│  llama-server   │◄────►│   Chat UI / MCP  │◄────►│  Z.AI MCP       │
│  (your GPU)     │      │   Client         │      │  Servers        │
│                 │      │                  │      │                 │
│  • Runs model   │      │  • Talks to      │      │  • Search       │
│  • Generates    │      │    llama-server  │      │  • Reader       │
│    text         │      │  • Calls MCP     │      │  • ZRead        │
│                 │      │    tools         │      │  • Vision       │
└─────────────────┘      └──────────────────┘      └─────────────────┘
```

**The limitation:** `llama-server` is an **inference engine** — it takes text in, generates text out. It does not understand the MCP protocol, cannot browse the web, cannot read GitHub repos, and cannot analyze images. Those capabilities come from the **MCP Client** (your chat UI) and the **MCP Tool Servers** (Z.AI).

**Why I can't "bake this into llama-server":** The llama.cpp project does not have MCP client support. It's not a matter of configuration — it's a missing feature in the codebase. The Z.AI servers speak the MCP protocol; llama-server speaks HTTP + OpenAI-compatible JSON. They are different languages.

**What actually needs to happen:** Your chat UI must act as the translator — sending prompts to your GPU (llama-server) and calling tools from Z.AI when needed.

---

## Recommended: Docker SSE Containers

The cleanest solution — 4 Docker containers that expose Z.AI MCP servers as local SSE URLs. Your webchat tool just adds `http://localhost:PORT/sse` for each one.

### Step 1: Set your API key

```bash
cd /home/bwilliams/turboquant-deployment/docker
cp .env.example .env
nano .env
# Paste your Z.AI API key
```

### Step 2: Start the containers

```bash
cd /home/bwilliams/turboquant-deployment/docker
docker compose up -d
```

### Step 3: Add to your webchat tool

| Container | URL | What It Does |
|---|---|---|
| **mcp-search** | `http://localhost:3002/sse` | Web search |
| **mcp-reader** | `http://localhost:3003/sse` | Read any webpage |
| **mcp-zread** | `http://localhost:3004/sse` | GitHub repo analysis |
| **mcp-vision** | `http://localhost:3005/sse` | Image/video/screenshot analysis |

**No custom headers needed** — the proxy injects the auth internally.

### Step 4: Verify

```bash
# All 4 should show "Up"
docker ps | grep mcp-

# Test the SSE endpoint
curl -N http://localhost:3002/sse
# Should show: event: endpoint\ndata: /message?sessionId=...
```

### Management

```bash
# Stop
docker compose down

# Restart
docker compose restart

# View logs
docker logs -f mcp-search
```

---

## Manual URL Configuration (Alternative)

If you prefer not to use Docker, paste these directly into your chat tool's "Add New Server" dialog.

> **Important:** Your webchat tool must support **Streamable HTTP** transport (not SSE) for these URLs to work. If your tool only supports SSE, use the Docker containers above.

### Search MCP — `webSearchPrime`

| Field | Value |
|---|---|
| **Server URL** | `https://api.z.ai/api/mcp/web_search_prime/mcp` |
| **Custom Header** | `Authorization: Bearer YOUR_Z_AI_API_KEY` |

### Reader MCP — `webReader`

| Field | Value |
|---|---|
| **Server URL** | `https://api.z.ai/api/mcp/web_reader/mcp` |
| **Custom Header** | `Authorization: Bearer YOUR_Z_AI_API_KEY` |

### ZRead MCP — `zread`

| Field | Value |
|---|---|
| **Server URL** | `https://api.z.ai/api/mcp/zread/mcp` |
| **Custom Header** | `Authorization: Bearer YOUR_Z_AI_API_KEY` |

### Vision MCP — `@z_ai/mcp-server`

This one runs locally on your machine. Start the proxy first:

```bash
cd /home/bwilliams/turboquant-deployment
export Z_AI_API_KEY="your_key"
node scripts/mcp-vision-proxy.js
```

Then in your chat tool:

| Field | Value |
|---|---|
| **Server URL** | `http://localhost:3001/sse` |
| **Custom Headers** | *(none needed)* |

> Keep the proxy terminal open. To stop it, press `Ctrl+C`.

---

## Tool Reference

Once all 4 servers are connected, your local model gains these capabilities:

| Tool | What It Does | Example Trigger |
|---|---|---|
| `webSearchPrime` | Searches the web | "Find the latest Python release" |
| `webReader` | Reads any URL | "Read this docs page: ..." |
| `search_doc` | Searches GitHub repo docs | "Search langchain docs for embeddings" |
| `get_repo_structure` | Lists repo directories | "Show me the langchain repo structure" |
| `read_file` | Reads a GitHub file | "Read langchain's README" |
| `image_analysis` | Describes any image | "Analyze this screenshot" |
| `video_analysis` | Describes video content | "What's in this video?" |
| `ui_to_artifact` | Turns UI shots into code | "Build this UI from my screenshot" |
| `extract_text_from_screenshot` | OCR | "Extract text from this image" |
| `diagnose_error_screenshot` | Debug errors from images | "Fix this error" [paste screenshot] |
| `understand_technical_diagram` | Explains diagrams | "Explain this architecture diagram" |
| `analyze_data_visualization` | Reads charts | "What does this graph show?" |
| `ui_diff_check` | Compares two screenshots | "Spot the differences" |

---

## Troubleshooting

### "token expired or incorrect"

Your Z.AI API key has expired or been invalidated. Get a new one from your [Z.AI Coding Plan dashboard](https://z.ai/).

```bash
# Update the key
nano docker/.env
docker compose restart
```

### "Connection refused" to localhost:3002-3005

The Docker containers aren't running. Start them:
```bash
cd docker
docker compose up -d
```

### Vision proxy won't start

```bash
# Verify Node.js >= v22
node --version

# If missing:
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

### MCP tools don't appear in chat

Restart your chat UI completely after adding servers. Some clients cache the tool list.

---

## Why This Architecture Exists

| Component | Role | Can It Do MCP? |
|---|---|---|
| **llama-server** | Runs your model on GPU | ❌ No — it's an inference engine |
| **Your Chat UI** | Orchestrates LLM + tools | ✅ Yes — it's the MCP client |
| **Z.AI Servers** | Provide tools (search, vision, etc.) | ✅ Yes — they are MCP servers |

The MCP protocol was designed specifically so that **tools and LLMs are separate**. This lets you:
- Swap LLMs without losing tools
- Use the same tools with different models
- Keep inference local while using cloud tools

If llama.cpp adds native MCP client support in the future, this manual configuration step will disappear. Until then, an MCP client layer is required.
