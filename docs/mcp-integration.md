# MCP Integration Guide

> Use Z.AI MCP servers (Vision, Search, Reader, ZRead) with your local TurboQuant LLM.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    AI Client                                │
│         (Cline / Goose / Continue.dev)                      │
│                                                             │
│   ┌──────────────┐  ┌──────────────────────────────────┐   │
│   │ LLM Backend  │  │        MCP Tool Servers          │   │
│   │              │  │                                  │   │
│   │  Local       │  │  ┌──────────┐  ┌────────────┐   │   │
│   │  TurboQuant  │  │  │ Z.AI     │  │ Z.AI       │   │   │
│   │  (localhost) │  │  │ Search   │  │ Reader     │   │   │
│   └──────┬───────┘  │  │ (HTTP)   │  │ (HTTP)     │   │   │
│          │          │  └────┬─────┘  └─────┬──────┘   │   │
│          │          │       │              │          │   │
│          │          │  ┌────┴─────┐  ┌─────┴──────┐   │   │
│          │          │  │ Z.AI     │  │ Z.AI       │   │   │
│          │          │  │ Vision   │  │ ZRead      │   │   │
│          │          │  │ (stdio)  │  │ (HTTP)     │   │   │
│          │          │  └──────────┘  └────────────┘   │   │
│          │          └──────────────────────────────────┘   │
│          │                                                  │
│          ▼                                                  │
│   http://localhost:8080/v1                                  │
└─────────────────────────────────────────────────────────────┘
                    │
                    ▼
         ┌─────────────────────┐
         │  llama-server       │
         │  TurboQuant +       │
         │  Qwen3.6-35B-A3B    │
         └─────────────────────┘
```

**How it works:**
1. You type a request in your AI client (e.g., "Search for the latest Python release and summarize it")
2. The AI client decides which tool to use — it calls the **Z.AI Search MCP** to fetch web results
3. The search results are fed back into your **local TurboQuant LLM** as context
4. The LLM generates the final response using the retrieved information
5. If you upload a screenshot, the **Z.AI Vision MCP** analyzes it and feeds the description to the LLM

Your data stays local — only the tool queries (search terms, URLs, image analysis) go to Z.AI's APIs. The actual LLM inference runs entirely on your GPU.

---

## Prerequisites

- TurboQuant server running locally (`http://localhost:8080`)
- [Z.AI Coding Plan](https://z.ai/) API key (free tier available)
- Node.js >= v22.0.0 (for Vision MCP server)
- One of the supported AI clients below

---

## Supported Clients

| Client | Type | Local LLM | MCP Support | Best For |
|---|---|---|---|---|
| **Cline** | VS Code Extension | ✅ Yes | ✅ Yes | Coding in IDE |
| **Goose** | Terminal CLI | ✅ Yes | ✅ Yes | Terminal workflows |
| **Continue.dev** | VS Code/JetBrains | ✅ Yes | ✅ Yes | General coding |
| **OpenCode** | Desktop App | ✅ Yes | ✅ Yes | Standalone app |
| Claude Code | Terminal CLI | ❌ No | ✅ Yes | Not compatible |

> **Note:** Claude Code does NOT support custom LLM backends — it only uses Anthropic's API. Use Cline, Goose, or Continue instead.

---

## Z.AI MCP Server Reference

### 1. Vision MCP Server (`@z_ai/mcp-server`)

**Type:** Local stdio server (runs via `npx`)  
**Requires:** `Z_AI_API_KEY`, `Z_AI_MODE=ZAI`

**Tools:**
| Tool | Purpose |
|---|---|
| `ui_to_artifact` | Turn UI screenshots into code |
| `extract_text_from_screenshot` | OCR for screenshots |
| `diagnose_error_screenshot` | Analyze error snapshots |
| `understand_technical_diagram` | Interpret architecture diagrams |
| `analyze_data_visualization` | Read charts and dashboards |
| `ui_diff_check` | Compare two UI screenshots |
| `image_analysis` | General image understanding |
| `video_analysis` | Inspect videos (≤8 MB) |

### 2. Search MCP Server (`web-search-prime`)

**Type:** Remote HTTP server  
**Endpoint:** `https://api.z.ai/api/mcp/web_search_prime/mcp`

**Tools:**
| Tool | Purpose |
|---|---|
| `webSearchPrime` | Search web information with summaries, URLs, site info |

### 3. Reader MCP Server (`web-reader`)

**Type:** Remote HTTP server  
**Endpoint:** `https://api.z.ai/api/mcp/web_reader/mcp`

**Tools:**
| Tool | Purpose |
|---|---|
| `webReader` | Fetch webpage content, title, metadata, links |

### 4. ZRead MCP Server (`zread`)

**Type:** Remote HTTP server  
**Endpoint:** `https://api.z.ai/api/mcp/zread/mcp`

**Tools:**
| Tool | Purpose |
|---|---|
| `search_doc` | Search GitHub repo knowledge, issues, PRs |
| `get_repo_structure` | Get directory structure of a GitHub repo |
| `read_file` | Read file contents from a GitHub repo |

---

## Setup: Cline (VS Code)

### Step 1: Install Cline

In VS Code:
```
Extensions → Search "Cline" → Install
```

### Step 2: Configure Local LLM (TurboQuant)

Open Cline settings (gear icon) → API Configuration:

| Setting | Value |
|---|---|
| API Provider | `OpenAI Compatible` |
| Base URL | `http://localhost:8080/v1` |
| API Key | `no-key-needed` |
| Model ID | `Qwen3.6-35B-A3B-TurboQuant` |

Test the connection — you should see a green checkmark.

### Step 3: Add MCP Servers

Open Cline's MCP settings and paste the full configuration from [`mcp-configs/cline.json`](../mcp-configs/cline.json).

Or manually add each server in Cline's MCP tab.

### Step 4: Use It

In the Cline chat:
```
Search for the latest React 19 features and explain them to me.
```

Cline will:
1. Call `webSearchPrime` to search for React 19
2. Pass results to your local TurboQuant LLM
3. Generate a comprehensive explanation

---

## Setup: Goose (Terminal)

### Step 1: Install Goose

```bash
# macOS
brew install goose

# Linux
curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash
```

### Step 2: Configure

Copy the Goose config:
```bash
cp mcp-configs/goose.yaml ~/.config/goose/config.yaml
# Edit and add your Z_AI_API_KEY
nano ~/.config/goose/config.yaml
```

### Step 3: Run

```bash
goose session
```

Type your requests — Goose will use your local LLM + Z.AI tools automatically.

---

## Setup: Continue.dev (VS Code / JetBrains)

### Step 1: Install

VS Code: `Extensions → Search "Continue" → Install`

### Step 2: Configure

Open `~/.continue/config.json` and merge the settings from [`mcp-configs/continue.json`](../mcp-configs/continue.json).

---

## Environment Variable Setup

All configs need your Z.AI API key. Set it in your shell profile:

```bash
# ~/.bashrc or ~/.zshrc
export Z_AI_API_KEY="your_api_key_here"
```

Then reload:
```bash
source ~/.bashrc  # or ~/.zshrc
```

> **Never commit your API key to git.** All configs in this repo use `${Z_AI_API_KEY}` or `<YOUR_API_KEY>` placeholders.

---

## Example Workflows

### Workflow 1: Research + Code

```
You: "Find the best practices for Python async error handling in 2025,
      then write a robust example function."

AI Client:
  1. Calls webSearchPrime → Finds relevant articles
  2. Calls webReader → Reads top 3 results
  3. Sends context to local TurboQuant LLM
  4. Returns polished code with explanations
```

### Workflow 2: Screenshot → Code

```
You: [Upload screenshot of a website design]
You: "Build this UI in React + Tailwind"

AI Client:
  1. Calls ui_to_artifact → Extracts design spec from image
  2. Sends spec to local TurboQuant LLM
  3. Returns complete React component
```

### Workflow 3: GitHub Repo Analysis

```
You: "Analyze the langchain-ai/langchain repo structure and
      summarize the key modules"

AI Client:
  1. Calls get_repo_structure → Gets directory tree
  2. Calls search_doc → Finds key documentation
  3. Calls read_file → Reads main entry points
  4. Sends analysis to local TurboQuant LLM
  5. Returns structured summary
```

### Workflow 4: Error Diagnosis

```
You: [Paste error screenshot]
You: "What's wrong and how do I fix it?"

AI Client:
  1. Calls diagnose_error_screenshot → Analyzes error
  2. Calls webSearchPrime → Searches for similar issues
  3. Sends findings to local TurboQuant LLM
  4. Returns root cause + fix
```

---

## Troubleshooting

### "Cannot connect to localhost:8080"

```bash
# Verify llama-server is running
curl http://localhost:8080/health

# If not running:
sudo systemctl start llama-turboquant
```

### "Z_AI_API_KEY not found"

```bash
# Verify it's set
echo $Z_AI_API_KEY

# If empty, add to ~/.bashrc:
echo 'export Z_AI_API_KEY="your_key"' >> ~/.bashrc
source ~/.bashrc
```

### Vision MCP won't start (npx error)

```bash
# Verify Node.js version
node --version  # Must be >= v22.0.0

# If not, install/update Node.js:
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

### MCP tools not showing in client

1. Restart the AI client completely
2. Check MCP server logs in the client's UI
3. Verify the server URLs are reachable:
   ```bash
   curl -H "Authorization: Bearer $Z_AI_API_KEY" \
        https://api.z.ai/api/mcp/web_search_prime/mcp
   ```

---

## Security Notes

- **Your LLM stays local.** All inference runs on your GPU. No prompts or completions leave your machine.
- **Tool queries go to Z.AI.** Search queries, URLs, and image analysis requests are sent to Z.AI's servers — this is necessary for the tools to function.
- **No model weights are transmitted.** Only text/images you explicitly share with the tools.
- **Use environment variables for API keys.** Never hardcode keys in config files that might be shared.
