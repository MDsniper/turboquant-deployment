#!/usr/bin/env node
/**
 * MCP SSE-to-Backend Proxy
 *
 * Exposes any MCP backend (HTTP or stdio) as an SSE endpoint.
 *
 * HTTP Backend Mode:
 *   MCP_BACKEND_TYPE=http
 *   MCP_BACKEND_URL=https://api.z.ai/api/mcp/.../mcp
 *   Z_AI_API_KEY=...
 *
 * Stdio Backend Mode:
 *   MCP_BACKEND_TYPE=stdio
 *   MCP_BACKEND_CMD=npx
 *   MCP_BACKEND_ARGS=["-y","@z_ai/mcp-server"]
 *   Z_AI_API_KEY=...
 *   Z_AI_MODE=ZAI
 *
 * Usage:
 *   node mcp-sse-proxy.js
 *
 * Then in your MCP client, add:
 *   http://localhost:PORT/sse
 */

const http = require("http");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");

const PORT = process.env.PORT || 3000;
const BACKEND_TYPE = process.env.MCP_BACKEND_TYPE || "http";
const BACKEND_URL = process.env.MCP_BACKEND_URL || "";
const BACKEND_CMD = process.env.MCP_BACKEND_CMD || "";
const BACKEND_ARGS = JSON.parse(process.env.MCP_BACKEND_ARGS || "[]");
const Z_AI_KEY = process.env.Z_AI_API_KEY || "";

if (BACKEND_TYPE === "http" && !BACKEND_URL) {
  console.error("Error: MCP_BACKEND_URL required for http backend");
  process.exit(1);
}
if (BACKEND_TYPE === "stdio" && !BACKEND_CMD) {
  console.error("Error: MCP_BACKEND_CMD required for stdio backend");
  process.exit(1);
}
if (!Z_AI_KEY) {
  console.warn("Warning: Z_AI_API_KEY not set — requests will fail auth.");
}

// ─── Stdio Backend ─────────────────────────────────────────────────
let stdioProc = null;
let stdioPending = new Map();
let stdioMsgId = 0;

function startStdioBackend() {
  const env = { ...process.env, Z_AI_API_KEY: Z_AI_KEY, Z_AI_MODE: "ZAI" };
  stdioProc = spawn(BACKEND_CMD, BACKEND_ARGS, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  stdioProc.stdout.on("data", (data) => {
    const lines = data.toString().split("\n").filter((l) => l.trim());
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && stdioPending.has(msg.id)) {
          const { res, sessionId } = stdioPending.get(msg.id);
          sendSseEvent(res, "message", JSON.stringify(msg));
          stdioPending.delete(msg.id);
        }
      } catch {
        // ignore non-JSON
      }
    }
  });

  stdioProc.stderr.on("data", (data) => {
    const txt = data.toString().trim();
    if (txt) console.error(`[stdio stderr] ${txt}`);
  });

  stdioProc.on("exit", (code) => {
    console.log(`Stdio backend exited with code ${code}, restarting...`);
    setTimeout(startStdioBackend, 2000);
  });

  // Initialize
  const initReq = {
    jsonrpc: "2.0",
    id: ++stdioMsgId,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mcp-sse-proxy", version: "1.0.0" },
    },
  };
  stdioProc.stdin.write(JSON.stringify(initReq) + "\n");
}

function stdioSend(method, params, sessionId, res) {
  const id = ++stdioMsgId;
  const req = { jsonrpc: "2.0", id, method, params };
  stdioPending.set(id, { res, sessionId });
  stdioProc.stdin.write(JSON.stringify(req) + "\n");
}

// ─── HTTP Backend ──────────────────────────────────────────────────
async function httpSend(body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BACKEND_URL);
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${Z_AI_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const proto = url.protocol === "https:" ? require("https") : require("http");
    const req = proto.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── SSE Transport ─────────────────────────────────────────────────
const sessions = new Map();

function sendSseEvent(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${data}\n\n`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /sse — establish SSE stream
  if (url.pathname === "/sse" && req.method === "GET") {
    const sessionId = randomUUID();
    const postUrl = `/message?sessionId=${sessionId}`;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    sessions.set(sessionId, res);
    console.log(`[${sessionId}] Client connected`);

    // Send endpoint event
    sendSseEvent(res, "endpoint", postUrl);

    req.on("close", () => {
      sessions.delete(sessionId);
      console.log(`[${sessionId}] Client disconnected`);
    });
    return;
  }

  // POST /message — handle JSON-RPC request
  if (url.pathname === "/message" && req.method === "POST") {
    const sessionId = url.searchParams.get("sessionId");
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const jsonBody = JSON.parse(body);

        if (BACKEND_TYPE === "http") {
          const result = await httpSend(body);
          res.writeHead(result.status, { "Content-Type": "application/json" });
          res.end(result.body);

          // Also send to SSE stream if session exists
          const sseRes = sessions.get(sessionId);
          if (sseRes && result.status === 200) {
            sendSseEvent(sseRes, "message", result.body);
          }
        } else {
          // stdio
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ accepted: true }));

          const method = jsonBody.method;
          const params = jsonBody.params || {};
          const sseRes = sessions.get(sessionId);
          if (sseRes) {
            stdioSend(method, params, sessionId, sseRes);
          }
        }
      } catch (err) {
        console.error("Error handling message:", err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

// Start
if (BACKEND_TYPE === "stdio") {
  startStdioBackend();
}

server.listen(PORT, () => {
  console.log(`MCP SSE Proxy running on http://localhost:${PORT}/sse`);
  console.log(`Backend: ${BACKEND_TYPE} → ${BACKEND_TYPE === "http" ? BACKEND_URL : BACKEND_CMD}`);
});

process.on("SIGINT", () => {
  if (stdioProc) stdioProc.kill();
  server.close();
  process.exit(0);
});
