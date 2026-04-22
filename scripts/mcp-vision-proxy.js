#!/usr/bin/env node
/**
 * SSE Proxy for Z.AI Vision MCP Server
 * Converts the local stdio MCP server (@z_ai/mcp-server) to an SSE endpoint.
 *
 * Usage:
 *   export Z_AI_API_KEY="your_key"
 *   export Z_AI_MODE="ZAI"
 *   node scripts/mcp-vision-proxy.js
 *
 * Then in your MCP client, add:
 *   URL: http://localhost:3001/sse
 */

const { spawn } = require("child_process");
const http = require("http");
const { randomUUID } = require("crypto");

const PORT = process.env.VISION_PROXY_PORT || 3001;
const Z_AI_KEY = process.env.Z_AI_API_KEY || "";

if (!Z_AI_KEY) {
  console.error("Error: Z_AI_API_KEY not set.");
  process.exit(1);
}

// Spawn the local Vision MCP server
const mcp = spawn("npx", ["-y", "@z_ai/mcp-server"], {
  env: { ...process.env, Z_AI_API_KEY: Z_AI_KEY, Z_AI_MODE: "ZAI" },
  stdio: ["pipe", "pipe", "pipe"],
});

let messageId = 0;
const pending = new Map();
const sessions = new Map();

function sendRpc(method, params, callback) {
  const id = ++messageId;
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  pending.set(id, callback);
  mcp.stdin.write(msg);
}

mcp.stdout.on("data", (data) => {
  const lines = data.toString().split("\n").filter((l) => l.trim());
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      // Ignore non-JSON lines
    }
  }
});

mcp.stderr.on("data", (data) => {
  // Uncomment to debug MCP server stderr
  // console.error("[MCP STDERR]", data.toString().trim());
});

// Initialize the MCP server
sendRpc(
  "initialize",
  {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "vision-sse-proxy", version: "1.0.0" },
  },
  (initResp) => {
    console.log("Vision MCP initialized:", initResp.result?.serverInfo?.name || "OK");
  }
);

// HTTP SSE Server
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // SSE endpoint
  if (url.pathname === "/sse") {
    const sessionId = randomUUID();
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    sessions.set(sessionId, res);
    console.log(`Client connected: ${sessionId}`);

    req.on("close", () => {
      sessions.delete(sessionId);
      console.log(`Client disconnected: ${sessionId}`);
    });
    return;
  }

  // Message endpoint (POST)
  if (url.pathname === "/message" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const msg = JSON.parse(body);
        sendRpc(msg.method, msg.params || {}, (result) => {
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify(result));
        });
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

server.listen(PORT, () => {
  console.log(`Vision MCP SSE Proxy running on http://localhost:${PORT}/sse`);
  console.log(`Add this URL to your MCP client.`);
});

process.on("SIGINT", () => {
  mcp.kill();
  server.close();
  process.exit(0);
});
