#!/usr/bin/env node
/**
 * NinjaOne MCP Server with Flat Tool Architecture
 *
 * This MCP server exposes all NinjaOne tools upfront for universal MCP client
 * compatibility. All tools are available immediately without navigation state.
 *
 * Supports both stdio and HTTP transports:
 * - stdio (default): For local Claude Desktop / CLI usage
 * - http: For hosted deployment with optional gateway auth
 *
 * Both entrypoints serve dual protocol eras via the v2 SDK serving entries:
 * legacy 2025-era clients (classic `initialize` handshake) are served
 * statelessly per request, and modern 2026-07-28 envelope clients natively —
 * from the same server factory (`mcp-server.ts`). The Cloudflare Workers
 * entrypoint lives in `worker.ts` and reuses that factory too.
 *
 * Credentials are provided via environment variables:
 * - NINJAONE_CLIENT_ID
 * - NINJAONE_CLIENT_SECRET
 * - NINJAONE_REGION (us, eu, oc, ca, us2, fed)
 *
 * Or via gateway headers (when AUTH_MODE=gateway):
 * - X-Ninja-Client-ID
 * - X-Ninja-Client-Secret
 * - X-Ninja-Region
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpServer,
  makeMcpServerFactory,
  resolveGatewayCredentials,
} from "./mcp-server.js";
import { preflightAuthCheck } from "./utils/client.js";
import { logger } from "./utils/logger.js";
import { verifyS2sHeader, S2S_HEADER } from "./s2s-verify.js";

// Conduit service-to-service auth (gateway#377 parity). Non-empty =
// enforce X-Gateway-S2S on every /mcp request; empty = disabled, behavior
// exactly as before (dark-by-default until the gateway provisions this
// container's derived subkey). See src/s2s-verify.ts.
const S2S_SECRET = process.env.CONDUIT_S2S_SECRET || "";

/**
 * Start the server with stdio transport (default).
 * `serveStdio` owns the era decision: a 2025-era `initialize` pins the
 * connection legacy; modern envelope openings are served natively.
 */
function startStdioTransport(): void {
  serveStdio(() => createMcpServer(), {
    onerror: (error) => logger.error("stdio serving error", { error: error.message }),
  });
  logger.info("NinjaOne MCP server running on stdio (flattened mode)");
}

/**
 * Start the server with HTTP serving via `createMcpHandler`.
 * The handler is created once; its factory runs per request (stateless),
 * exactly like the previous per-request Server + Transport wiring.
 */
async function startHttpTransport(): Promise<void> {
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const host = process.env.MCP_HTTP_HOST || "0.0.0.0";
  const isGatewayMode = process.env.AUTH_MODE === "gateway";

  // A scope mismatch (or any other OAuth-level rejection) is otherwise silent
  // at boot and fatal on the token exchange behind *every* tool call — "all
  // the tools mysteriously error", diagnosable only by reading a single
  // tool's error body. This turns that into "server won't start, here's why"
  // in the container logs. env mode only: gateway mode has no static
  // credentials to check at startup, they only arrive per-request via
  // headers (same reasoning as the /health handler below never calling
  // getCredentials()).
  if (!isGatewayMode) {
    const preflight = await preflightAuthCheck();
    if (preflight.error) {
      // Propagates to main().catch() below, which logs and exits(1) — the
      // same fatal-startup handling every other boot-time failure gets.
      throw new Error(preflight.error);
    }
    if (preflight.checked) {
      logger.info("Preflight authentication check passed");
    }
  }

  // legacy: 'stateless' (also the default) is the dual-era posture: 2025-era
  // traffic is answered per-request statelessly, modern 2026-07-28 envelope
  // traffic natively. Never use legacy: 'reject' here — it would turn away
  // every pre-envelope client.
  const mcpHandler = createMcpHandler(
    makeMcpServerFactory({ gatewayMode: isGatewayMode }),
    {
      legacy: "stateless",
      onerror: (error) => logger.error("MCP serving error", { error: error.message }),
    }
  );
  const handleMcpRequest = toNodeHandler(mcpHandler, {
    onerror: (error) => logger.error("MCP request adapter error", { error: error.message }),
  });

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    // Health endpoint - shallow, unauthenticated liveness probe.
    // Must NOT call getCredentials() or any upstream: in gateway mode
    // credentials only arrive per-request via headers, so a credential
    // check here would always 503 and crash-loop the container.
    if (url.pathname === "/health" || url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // MCP endpoint
    if (url.pathname === "/mcp") {
      // Conduit service-to-service auth (gateway#377 parity): rejected
      // BEFORE any credential extraction, mirroring every other ported
      // wrapper (e.g. containers/sentinelone-mcp/gateway_wrapper.py).
      if (S2S_SECRET && !verifyS2sHeader(req.headers[S2S_HEADER] as string | undefined, S2S_SECRET)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.",
          })
        );
        return;
      }

      if (isGatewayMode) {
        const { error } = resolveGatewayCredentials(
          (name) => req.headers[name] as string | undefined
        );
        if (error) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Missing credentials",
              message: error,
              required: ["X-Ninja-Client-ID", "X-Ninja-Client-Secret"],
              optional: ["X-Ninja-Region"],
            })
          );
          return;
        }
      }

      // Per-request credential binding happens inside the factory (it reads
      // the gateway headers from ctx.requestInfo on every request).
      await handleMcpRequest(req, res);
      return;
    }

    // 404 for everything else
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", endpoints: ["/mcp", "/health"] }));
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, () => {
      logger.info(`NinjaOne MCP server listening on http://${host}:${port}/mcp`);
      logger.info(`Health check available at http://${host}:${port}/health`);
      logger.info(`Authentication mode: ${isGatewayMode ? "gateway (header-based)" : "env (environment variables)"}`);
      resolve();
    });
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down NinjaOne MCP server...");
    await mcpHandler.close();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Main entry point - select transport based on MCP_TRANSPORT env var
 */
async function main() {
  const transportType = process.env.MCP_TRANSPORT || "stdio";
  logger.info("Starting NinjaOne MCP server", {
    transport: transportType,
    logLevel: process.env.LOG_LEVEL || "info",
    nodeVersion: process.version,
  });

  if (transportType === "http") {
    await startHttpTransport();
  } else {
    startStdioTransport();
  }
}

main().catch((error) => {
  logger.error("Fatal startup error", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
