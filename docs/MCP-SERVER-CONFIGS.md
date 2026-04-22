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

## Ready-to-Paste Configurations

### 1. Search MCP — `webSearchPrime`

**Purpose:** Search the web and return summaries, URLs, titles.

```
Server URL:
https://api.z.ai/api/mcp/web_search_prime/sse?Authorization=YOUR_Z_AI_API_KEY

Custom Headers:
(none needed)
```

---

### 2. Reader MCP — `webReader`

**Purpose:** Fetch any webpage and extract its main content.

```
Server URL:
https://api.z.ai/api/mcp/web_reader/sse?Authorization=YOUR_Z_AI_API_KEY

Custom Headers:
(none needed)
```

---

### 3. ZRead MCP — `zread`

**Purpose:** Analyze GitHub repositories — structure, docs, issues, file contents.

```
Server URL:
https://api.z.ai/api/mcp/zread/sse?Authorization=YOUR_Z_AI_API_KEY

Custom Headers:
(none needed)
```

---

### 4. Vision MCP — `@z_ai/mcp-server`

**Purpose:** Analyze images, screenshots, videos, diagrams, error snapshots.

**This server runs locally on your machine** (not hosted by Z.AI). It requires Node.js.

#### Step A: Start the local proxy

```bash
cd /home/bwilliams/turboquant-deployment
export Z_AI_API_KEY="your_key"
node scripts/mcp-vision-proxy.js
```

Keep this terminal open. The proxy runs on port `3001`.

#### Step B: Add to your chat UI

```
Server URL:
http://localhost:3001/sse

Custom Headers:
(none needed)
```

---

## Alternative: Using Headers Instead of URL Query Params

If your chat UI requires headers rather than embedding the key in the URL:

| Server | URL | Header |
|---|---|---|
| Search | `https://api.z.ai/api/mcp/web_search_prime/sse` | `Authorization: Bearer YOUR_Z_AI_API_KEY` |
| Reader | `https://api.z.ai/api/mcp/web_reader/sse` | `Authorization: Bearer YOUR_Z_AI_API_KEY` |
| ZRead | `https://api.z.ai/api/mcp/zread/sse` | `Authorization: Bearer YOUR_Z_AI_API_KEY` |

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

## Automated Alternatives (No Copy-Paste Required)

If you want a fully pre-configured solution without manually adding servers to a UI:

### Option A: Terminal Chat (`mcp-chat.py`)

Already configured. Just run:

```bash
cd /home/bwilliams/turboquant-deployment
python3 scripts/mcp-chat.py
```

Type `/search`, `/read`, `/repo`, `/vision` to use tools directly.

### Option B: LibreChat (Web UI)

A ChatGPT-like web interface that supports both local LLM and MCP servers natively.

```bash
# One-time setup
cd /home/bwilliams/turboquant-deployment
docker compose -f docker/librechat.yaml up -d
```

Pre-configured with all 4 Z.AI MCP servers + your local llama-server.

### Option C: Goose (Terminal)

Already installed on this machine. Add Z.AI servers to `~/.config/goose/config.yaml` under `mcpServers`.

---

## Troubleshooting

### "Connection refused" to localhost:3001

The Vision proxy isn't running. Start it:
```bash
node scripts/mcp-vision-proxy.js
```

### "401 Unauthorized" on Z.AI endpoints

Your API key is missing or invalid. Verify:
```bash
echo $Z_AI_API_KEY
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
