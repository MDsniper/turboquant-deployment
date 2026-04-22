#!/usr/bin/env node
/**
 * MCP SSE Proxy — correct implementation for Z.AI backends
 *
 * For HTTP backends:
 *   1. Establishes background SSE connection to Z.AI /sse endpoint
 *   2. Extracts message endpoint URL with sessionId
 *   3. Client POSTs → forwarded to Z.AI message endpoint
 *   4. Z.AI responses (via SSE) → forwarded to client SSE streams
 *
 * For stdio backends:
 *   Spawns local process, exposes as SSE
 */

const http = require("http");
const https = require("https");
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

// ─── HTTP Backend State ────────────────────────────────────────────
let zaiMessageUrl = null;
let zaiSseRes = null;

// Map: jsonrpc id -> { clientRes, sessionId }
const pendingResponses = new Map();

async function connectZaiSse() {
  return new Promise((resolve, reject) => {
    const url = new URL(BACKEND_URL.replace("/mcp", "/sse"));
    const proto = url.protocol === "https:" ? https : http;

    const req = proto.get(url, {
      headers: { Authorization: `Bearer ${Z_AI_KEY}` },
    }, (res) => {
      let buffer = "";

      res.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop(); // keep incomplete line

        let eventName = "";
        let eventData = "";

        for (const line of lines) {
          if (line.startsWith("event:")) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            eventData = line.slice(5).trim();
          } else if (line === "" && eventName) {
            if (eventName === "endpoint") {
              zaiMessageUrl = eventData.startsWith("http")
                ? eventData
                : `https://${url.hostname}${eventData}`;
              console.log(`[Z.AI] Message endpoint: ${zaiMessageUrl}`);
              resolve();
            }

            if (eventName === "message" && eventData) {
              try {
                const msg = JSON.parse(eventData);
                if (msg.id !== undefined && pendingResponses.has(msg.id)) {
                  const { clientRes, clientSessionId } = pendingResponses.get(msg.id);
                  if (clientRes && !clientRes.writableEnded) {
                    sendSseEvent(clientRes, "message", eventData);
                  }
                  pendingResponses.delete(msg.id);
                }
              } catch (e) {
                // ignore parse errors
              }
            }

            eventName = "";
            eventData = "";
          }
        }
      });

      res.on("error", reject);
      res.on("end", () => {
        console.log("[Z.AI] SSE stream ended, reconnecting...");
        setTimeout(() => connectZaiSse().catch(console.error), 3000);
      });
    });

    req.on("error", reject);
    req.setTimeout(30000);
  });
}

async function zaiPost(body) {
  return new Promise((resolve, reject) => {
    if (!zaiMessageUrl) {
      reject(new Error("Z.AI message endpoint not ready"));
      return;
    }

    const url = new URL(zaiMessageUrl);
    const proto = url.protocol === "https:" ? https : http;
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
          const { clientRes } = stdioPending.get(msg.id);
          if (clientRes && !clientRes.writableEnded) {
            sendSseEvent(clientRes, "message", JSON.stringify(msg));
          }
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
    console.log(`Stdio backend exited (${code}), restarting...`);
    setTimeout(startStdioBackend, 2000);
  });
}

function stdioSend(method, params, clientRes) {
  const id = ++stdioMsgId;
  const req = { jsonrpc: "2.0", id, method, params };
  stdioPending.set(id, { clientRes });
  stdioProc.stdin.write(JSON.stringify(req) + "\n");
}

// ─── Client SSE Transport ──────────────────────────────────────────
const clientSessions = new Map();

function sendSseEvent(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${data}\n\n`);
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
  res.setHeader("Access-Control-Expose-Headers", "*");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /sse — establish client SSE stream
  if (url.pathname === "/sse" && req.method === "GET") {
    const sessionId = randomUUID();
    const postUrl = `/message?sessionId=${sessionId}`;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    clientSessions.set(sessionId, res);
    console.log(`[client ${sessionId}] Connected`);

    sendSseEvent(res, "endpoint", postUrl);

    req.on("close", () => {
      clientSessions.delete(sessionId);
      console.log(`[client ${sessionId}] Disconnected`);
    });
    return;
  }

  // POST /sse — Streamable HTTP
  if (url.pathname === "/sse" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const jsonBody = JSON.parse(body);
        const id = jsonBody.id;

        if (BACKEND_TYPE === "http") {
          // Store pending so we can route Z.AI response back
          const lastClient = Array.from(clientSessions.values()).pop();
          if (id !== undefined && lastClient) {
            pendingResponses.set(id, { clientRes: lastClient, clientSessionId: "streamable" });
          }

          const result = await zaiPost(body);
          res.writeHead(result.status, { "Content-Type": "application/json" });
          res.end(result.body);
        } else {
          const lastClient = Array.from(clientSessions.values()).pop();
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ accepted: true }));
          if (lastClient) {
            stdioSend(jsonBody.method, jsonBody.params || {}, lastClient);
          }
        }
      } catch (err) {
        console.error("POST /sse error:", err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // POST /message — legacy SSE message endpoint
  if (url.pathname === "/message" && req.method === "POST") {
    const sessionId = url.searchParams.get("sessionId");
    const clientRes = clientSessions.get(sessionId);
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const jsonBody = JSON.parse(body);
        const id = jsonBody.id;

        if (BACKEND_TYPE === "http") {
          if (id !== undefined && clientRes) {
            pendingResponses.set(id, { clientRes, clientSessionId: sessionId });
          }

          const result = await zaiPost(body);
          res.writeHead(result.status, { "Content-Type": "application/json" });
          res.end(result.body);

          // Z.AI response will come via background SSE and be routed above
        } else {
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ accepted: true }));
          if (clientRes) {
            stdioSend(jsonBody.method, jsonBody.params || {}, clientRes);
          }
        }
      } catch (err) {
        console.error("POST /message error:", err.message);
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
async function main() {
  if (BACKEND_TYPE === "stdio") {
    startStdioBackend();
  } else {
    console.log("[Z.AI] Connecting to SSE endpoint...");
    try {
      await connectZaiSse();
    } catch (err) {
      console.error("[Z.AI] Failed to connect SSE:", err.message);
      console.log("[Z.AI] Retrying in 5s...");
      setTimeout(main, 5000);
      return;
    }
  }

  server.listen(PORT, () => {
    console.log(`MCP SSE Proxy running on http://0.0.0.0:${PORT}/sse`);
  });
}

main();

process.on("SIGINT", () => {
  if (stdioProc) stdioProc.kill();
  if (zaiSseRes) zaiSseRes.destroy();
  server.close();
  process.exit(0);
});
