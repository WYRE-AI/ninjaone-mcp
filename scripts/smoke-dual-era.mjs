#!/usr/bin/env node
/**
 * Dual-era smoke test: proves one HTTP endpoint serves BOTH protocol eras.
 *
 * Starts the built server (dist/index.js — run `npm run build` first) on a
 * local port with dummy env credentials, then:
 *  (a) drives a LEGACY client: hand-crafted 2025-era JSON-RPC POSTs —
 *      initialize (protocolVersion 2025-03-26) → notifications/initialized →
 *      tools/list — asserting a valid InitializeResult and >0 tools;
 *  (b) drives a MODERN client: @modelcontextprotocol/client (v2) over
 *      StreamableHTTPClientTransport → tools/list — asserting the same
 *      tool count.
 *
 * Exits non-zero on any failure.
 */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.SMOKE_PORT ?? 8931);
const BASE = `http://127.0.0.1:${PORT}`;
const MCP_URL = `${BASE}/mcp`;

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

let failed = false;
function check(condition, label, detail) {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failed = true;
    console.error(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

/** Decode a JSON-RPC message from a streamable-HTTP response (JSON or SSE). */
async function mcpJson(res) {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const messages = (await res.text())
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5).trim()));
    return messages[messages.length - 1];
  }
  return res.json();
}

async function legacyPost(body) {
  return fetch(MCP_URL, {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify(body),
  });
}

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await delay(200);
  }
  throw new Error(`server did not become healthy on ${BASE} within ${timeoutMs}ms`);
}

async function legacyEra() {
  console.log("[legacy era] classic 2025-03-26 JSON-RPC sequence");

  const initRes = await legacyPost({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "smoke-legacy", version: "0.0.0" },
    },
  });
  check(initRes.status === 200, `initialize HTTP 200 (got ${initRes.status})`);
  const init = await mcpJson(initRes);
  check(typeof init?.result?.protocolVersion === "string", "InitializeResult.protocolVersion present", init);
  check(init?.result?.serverInfo?.name === "ninjaone-mcp", "InitializeResult.serverInfo.name === ninjaone-mcp", init?.result?.serverInfo);
  check(typeof init?.result?.capabilities === "object" && init?.result?.capabilities !== null, "InitializeResult.capabilities present");

  const notifRes = await legacyPost({ jsonrpc: "2.0", method: "notifications/initialized" });
  check(notifRes.status === 202, `notifications/initialized HTTP 202 (got ${notifRes.status})`);

  const listRes = await legacyPost({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  check(listRes.status === 200, `tools/list HTTP 200 (got ${listRes.status})`);
  const list = await mcpJson(listRes);
  const tools = list?.result?.tools ?? [];
  check(tools.length > 0, `tools/list returned ${tools.length} tools (>0)`);
  return tools.length;
}

async function modernEra() {
  console.log("[modern era] @modelcontextprotocol/client v2 over StreamableHTTPClientTransport");
  const client = new Client({ name: "smoke-modern", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  await client.connect(transport);
  const { tools } = await client.listTools();
  check(tools.length > 0, `tools/list returned ${tools.length} tools (>0)`);
  await client.close();
  return tools.length;
}

async function main() {
  console.log(`Starting server on ${BASE} ...`);
  const child = spawn("node", [resolve(ROOT, "dist/index.js")], {
    env: {
      ...process.env,
      MCP_TRANSPORT: "http",
      MCP_HTTP_PORT: String(PORT),
      MCP_HTTP_HOST: "127.0.0.1",
      NINJAONE_CLIENT_ID: "smoke-dummy-id",
      NINJAONE_CLIENT_SECRET: "smoke-dummy-secret",
      NINJAONE_REGION: "us",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  try {
    await waitForHealth();

    const legacyCount = await legacyEra();
    const modernCount = await modernEra();
    check(
      legacyCount === modernCount,
      `both eras list the same tool count (legacy=${legacyCount}, modern=${modernCount})`
    );
  } finally {
    child.kill("SIGTERM");
  }

  if (failed) {
    console.error("\nsmoke-dual-era: FAILED");
    process.exit(1);
  }
  console.log("\nsmoke-dual-era: PASS — one endpoint, both eras served");
}

main().catch((error) => {
  console.error("smoke-dual-era: FAILED —", error);
  process.exit(1);
});
