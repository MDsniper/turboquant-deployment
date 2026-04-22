#!/usr/bin/env python3
"""
MCP Chat Client for TurboQuant + Z.AI MCP Servers
Connects your local llama-server to Z.AI tools (Search, Reader, ZRead, Vision).

Usage:
    export Z_AI_API_KEY="your_key"
    python3 scripts/mcp-chat.py

Commands within chat:
    /search <query>     - Search the web
    /read <url>         - Read a webpage
    /repo <user/repo>   - Analyze a GitHub repo
    /vision <path>      - Analyze an image/screenshot
    /tools              - List available tools
    /clear              - Clear conversation history
    /quit               - Exit
"""

import os
import sys
import json
import subprocess
import urllib.request
import urllib.error
from pathlib import Path

# ─── Configuration ───────────────────────────────────────────────────

LLAMA_URL = os.environ.get("LLAMA_URL", "http://localhost:8080/v1/chat/completions")
Z_AI_KEY = os.environ.get("Z_AI_API_KEY", "")
MODEL = os.environ.get("LLAMA_MODEL", "Qwen3.6-35B-A3B-TurboQuant")

MCP_ENDPOINTS = {
    "search": "https://api.z.ai/api/mcp/web_search_prime/mcp",
    "reader": "https://api.z.ai/api/mcp/web_reader/mcp",
    "zread": "https://api.z.ai/api/mcp/zread/mcp",
}

# ─── Colors ──────────────────────────────────────────────────────────

CYAN = "\033[36m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
RESET = "\033[0m"

# ─── HTTP Helpers ────────────────────────────────────────────────────

def llama_chat(messages, stream=True):
    """Send chat request to local llama-server."""
    payload = {
        "model": MODEL,
        "messages": messages,
        "stream": stream,
        "temperature": 0.7,
        "max_tokens": 2048,
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        LLAMA_URL,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            if stream:
                # Parse SSE stream
                full_text = ""
                for line in resp:
                    line = line.decode("utf-8").strip()
                    if line.startswith("data: "):
                        chunk = line[6:]
                        if chunk == "[DONE]":
                            break
                        try:
                            obj = json.loads(chunk)
                            delta = obj["choices"][0]["delta"].get("content", "")
                            if delta:
                                full_text += delta
                                print(delta, end="", flush=True)
                        except Exception:
                            pass
                print()
                return full_text
            else:
                obj = json.loads(resp.read().decode("utf-8"))
                return obj["choices"][0]["message"]["content"]
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8")
        print(f"{RED}LLM Error: {e.code} - {err}{RESET}")
        return ""
    except Exception as e:
        print(f"{RED}Connection Error: {e}{RESET}")
        return ""


def mcp_initialize(endpoint):
    """Initialize an MCP HTTP server."""
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "turboquant-mcp-chat", "version": "1.0.0"},
        },
    }
    return mcp_call_raw(endpoint, payload)


def mcp_tools_list(endpoint):
    """List tools from an MCP server."""
    payload = {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
        "params": {},
    }
    return mcp_call_raw(endpoint, payload)


def mcp_tool_call(endpoint, name, arguments):
    """Call a tool on an MCP server."""
    payload = {
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }
    return mcp_call_raw(endpoint, payload)


def mcp_call_raw(endpoint, payload):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        endpoint,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {Z_AI_KEY}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code}: {e.read().decode('utf-8')}"}
    except Exception as e:
        return {"error": str(e)}


# ─── Vision MCP (stdio) ──────────────────────────────────────────────

vision_proc = None


def start_vision_mcp():
    global vision_proc
    if vision_proc and vision_proc.poll() is None:
        return True
    try:
        env = os.environ.copy()
        env["Z_AI_API_KEY"] = Z_AI_KEY
        env["Z_AI_MODE"] = "ZAI"
        vision_proc = subprocess.Popen(
            ["npx", "-y", "@z_ai/mcp-server"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
        # Initialize
        init_req = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "turboquant-mcp-chat", "version": "1.0.0"},
            },
        }
        vision_proc.stdin.write(json.dumps(init_req) + "\n")
        vision_proc.stdin.flush()
        vision_proc.stdout.readline()  # Read init response
        return True
    except Exception as e:
        print(f"{RED}Failed to start Vision MCP: {e}{RESET}")
        return False


def vision_tool_call(name, arguments):
    if not start_vision_mcp():
        return "Vision MCP unavailable"
    req = {
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }
    vision_proc.stdin.write(json.dumps(req) + "\n")
    vision_proc.stdin.flush()
    resp = vision_proc.stdout.readline()
    try:
        obj = json.loads(resp)
        result = obj.get("result", {})
        content = result.get("content", [])
        return "\n".join([c.get("text", "") for c in content])
    except Exception as e:
        return f"Vision error: {e}"


# ─── Tool Wrappers ───────────────────────────────────────────────────

def web_search(query):
    print(f"{YELLOW}🔍 Searching: {query}...{RESET}")
    resp = mcp_tool_call(MCP_ENDPOINTS["search"], "webSearchPrime", {"query": query})
    result = resp.get("result", {})
    content = result.get("content", [])
    texts = []
    for c in content:
        if c.get("type") == "text":
            texts.append(c.get("text", ""))
    return "\n".join(texts) or "No search results found."


def web_read(url):
    print(f"{YELLOW}📄 Reading: {url}...{RESET}")
    resp = mcp_tool_call(MCP_ENDPOINTS["reader"], "webReader", {"url": url})
    result = resp.get("result", {})
    content = result.get("content", [])
    texts = []
    for c in content:
        if c.get("type") == "text":
            texts.append(c.get("text", ""))
    return "\n".join(texts) or "Could not read page."


def repo_analyze(repo):
    print(f"{YELLOW}🔎 Analyzing repo: {repo}...{RESET}")
    # Get structure
    struct_resp = mcp_tool_call(MCP_ENDPOINTS["zread"], "get_repo_structure", {"repo": repo})
    struct_result = struct_resp.get("result", {})
    struct_content = "\n".join([c.get("text", "") for c in struct_result.get("content", [])])

    # Search docs
    doc_resp = mcp_tool_call(MCP_ENDPOINTS["zread"], "search_doc", {"repo": repo, "query": "overview"})
    doc_result = doc_resp.get("result", {})
    doc_content = "\n".join([c.get("text", "") for c in doc_result.get("content", [])])

    return f"=== Repo Structure ===\n{struct_content}\n\n=== Documentation ===\n{doc_content}"


def analyze_image(path):
    print(f"{YELLOW}🖼️ Analyzing image: {path}...{RESET}")
    if not Path(path).exists():
        return f"File not found: {path}"
    abs_path = str(Path(path).resolve())
    return vision_tool_call("image_analysis", {"image_path": abs_path})


# ─── Main Chat Loop ──────────────────────────────────────────────────

def print_banner():
    print(f"""{CYAN}
╔══════════════════════════════════════════════════════════════╗
║  TurboQuant MCP Chat — Local LLM + Z.AI Tools               ║
║  Model: {MODEL:<50} ║
║  LLM:   {LLAMA_URL:<50} ║
╚══════════════════════════════════════════════════════════════╝{RESET}
Type /help for commands.
""")


def main():
    if not Z_AI_KEY:
        print(f"{RED}Error: Z_AI_API_KEY not set.{RESET}")
        print("Export it first: export Z_AI_API_KEY='your_key'")
        sys.exit(1)

    # Verify llama-server is up
    try:
        urllib.request.urlopen("http://localhost:8080/health", timeout=5)
    except Exception:
        print(f"{RED}Warning: llama-server not responding on localhost:8080{RESET}")
        print("Start it first: sudo systemctl start llama-turboquant")
        print("")

    print_banner()

    messages = [
        {
            "role": "system",
            "content": (
                "You are a helpful AI assistant running on a local GPU. "
                "You have access to web search, webpage reading, GitHub repo analysis, "
                "and image analysis tools via the user's client. "
                "When the user shares tool results, synthesize them into a clear, helpful response."
            ),
        }
    ]

    while True:
        try:
            user_input = input(f"{GREEN}You{RESET}: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nGoodbye!")
            break

        if not user_input:
            continue

        # Handle commands
        if user_input == "/quit":
            print("Goodbye!")
            break

        if user_input == "/clear":
            messages = [messages[0]]  # Keep system prompt
            print(f"{YELLOW}Conversation cleared.{RESET}")
            continue

        if user_input == "/help":
            print(f"""{CYAN}Commands:{RESET}
  /search <query>     Search the web
  /read <url>         Read a webpage
  /repo <user/repo>   Analyze GitHub repo structure
  /vision <path>      Analyze an image
  /tools              List available MCP tools
  /clear              Clear conversation history
  /quit               Exit
""")
            continue

        if user_input == "/tools":
            print(f"{CYAN}Available Tools:{RESET}")
            print("  🔍 webSearchPrime  — Search web information")
            print("  📄 webReader       — Fetch webpage content")
            print("  🔎 search_doc      — Search GitHub repo docs")
            print("  📁 get_repo_structure — Get repo directory tree")
            print("  📄 read_file       — Read GitHub file contents")
            print("  🖼️ image_analysis  — Analyze images (Vision MCP)")
            print("  📹 video_analysis  — Analyze videos (Vision MCP)")
            print("  🖥️ ui_to_artifact   — Turn screenshots into code")
            print("  🔤 extract_text_from_screenshot — OCR screenshots")
            print("  🐛 diagnose_error_screenshot — Analyze error images")
            continue

        if user_input.startswith("/search "):
            query = user_input[8:].strip()
            result = web_search(query)
            print(f"{CYAN}Search Results:{RESET}\n{result[:2000]}...\n")
            messages.append({"role": "user", "content": f"Search results for '{query}':\n{result}"})
            messages.append({"role": "assistant", "content": "I've retrieved the search results. What would you like to know about them?"})
            continue

        if user_input.startswith("/read "):
            url = user_input[6:].strip()
            result = web_read(url)
            print(f"{CYAN}Page Content:{RESET}\n{result[:2000]}...\n")
            messages.append({"role": "user", "content": f"Content from {url}:\n{result}"})
            messages.append({"role": "assistant", "content": "I've read the page. What would you like me to explain?"})
            continue

        if user_input.startswith("/repo "):
            repo = user_input[6:].strip()
            result = repo_analyze(repo)
            print(f"{CYAN}Repo Analysis:{RESET}\n{result[:2000]}...\n")
            messages.append({"role": "user", "content": f"GitHub repo analysis for {repo}:\n{result}"})
            messages.append({"role": "assistant", "content": "I've analyzed the repo. What would you like to know?"})
            continue

        if user_input.startswith("/vision "):
            path = user_input[8:].strip()
            result = analyze_image(path)
            print(f"{CYAN}Image Analysis:{RESET}\n{result}\n")
            messages.append({"role": "user", "content": f"Image analysis result:\n{result}"})
            messages.append({"role": "assistant", "content": "I've analyzed the image. What would you like to know?"})
            continue

        # Normal chat
        messages.append({"role": "user", "content": user_input})
        print(f"{CYAN}Assistant{RESET}: ", end="", flush=True)
        reply = llama_chat(messages)
        if reply:
            messages.append({"role": "assistant", "content": reply})


if __name__ == "__main__":
    main()
