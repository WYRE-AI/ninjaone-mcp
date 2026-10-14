#!/usr/bin/env node
/**
 * NinjaOne MCP Server with Flat Tool Architecture
 *
 * This MCP server exposes all NinjaOne tools upfront for universal MCP client
 * compatibility. All tools are available immediately without navigation state.
 *
 * Supports both stdio and HTTP transports:
 * - stdio (default): For local Claude Desktop / CLI usage. Does not use S2S auth.
 * - http: For hosted deployment. Refuses to start unless CONDUIT_S2S_SECRET is
 *   a real secret. MCP_ALLOW_INSECURE_DEV=1 is a local-only escape hatch: it
 *   logs a warning, skips X-Gateway-S2S, and binds 127.0.0.1 only.
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
 *
 * Gateway mode never falls back to NINJAONE_* env credentials. /health and
 * /healthz stay unauthenticated and do not read credentials.
 */

import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpServer,
  makeMcpServerFactory,
  resolveGatewayCredentials,
  scriptPolicyHeadersTrusted,
} from "./mcp-server.js";
import { preflightAuthCheck } from "./utils/client.js";
import { logger } from "./utils/logger.js";
import { verifyS2sHeader, S2S_HEADER } from "./s2s-verify.js";

/**
 * Public example values. A copied placeholder must not verify as a real
 * service-to-service secret, and MCP_ALLOW_INSECURE_DEV does not waive this.
 */
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "replace-with-a-real-secret",
  "your-s2s-secret",
  "your-secret",
  "changeme",
  "change-me",
  "placeholder",
  "secret",
  "example",
  "replace-me",
  "s2s-secret",
]);

const LOOPBACK_HOST = "127.0.0.1";

/** Unresolved ${...} config placeholders, plus the public example strings above. */
function isKnownPlaceholderSecret(value: string): boolean {
  if (KNOWN_PLACEHOLDER_SECRETS.has(value.toLowerCase())) return true;
  return /^\$\{.*\}$/.test(value);
}

function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.+)\]$/, "$1");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Secret for X-Gateway-S2S on /mcp. Read at HTTP startup, not module load.
 * Empty is fail-closed: the process exits unless MCP_ALLOW_INSECURE_DEV=1.
 * A known placeholder always exits, including when that flag is set.
 * The secret value is never written to logs.
 */
function resolveHttpS2sSecret(): string {
  const secret = (process.env.CONDUIT_S2S_SECRET ?? "").trim();
  if (isKnownPlaceholderSecret(secret)) {
    logger.error(
      "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. " +
        "Generate a real secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value. " +
        "MCP_ALLOW_INSECURE_DEV does not permit placeholder secrets."
    );
    process.exit(1);
  }

  if (secret) return secret;

  if (process.env.MCP_ALLOW_INSECURE_DEV === "1") {
    logger.error(
      "SECURITY WARNING: CONDUIT_S2S_SECRET is empty and MCP_ALLOW_INSECURE_DEV=1. " +
        "HTTP /mcp is not enforcing X-Gateway-S2S and listens on 127.0.0.1 only. " +
        "Do not use this outside local development."
    );
    return "";
  }

  logger.error(
    "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty. " +
      "Set CONDUIT_S2S_SECRET, or set MCP_ALLOW_INSECURE_DEV=1 for local development only."
  );
  process.exit(1);
}

/**
 * No secret (the insecure-dev bypass) always binds 127.0.0.1, even when
 * MCP_HTTP_HOST is a wider address such as 0.0.0.0. A configured secret
 * honors MCP_HTTP_HOST and defaults to 127.0.0.1 when it is unset.
 */
function resolveListenHost(s2sSecret: string): string {
  const configured = (process.env.MCP_HTTP_HOST ?? "").trim();
  if (s2sSecret) return configured || LOOPBACK_HOST;

  if (configured && !isLoopbackBindHost(configured)) {
    logger.error(
      `WARNING: MCP_HTTP_HOST=${configured} is not a loopback address. ` +
        "MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET cannot listen there. " +
        `Binding ${LOOPBACK_HOST} only.`
    );
  }
  return LOOPBACK_HOST;
}

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
export async function startHttpTransport(): Promise<HttpServer> {
  const s2sSecret = resolveHttpS2sSecret();
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const host = resolveListenHost(s2sSecret);
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
    makeMcpServerFactory({
      gatewayMode: isGatewayMode,
      // Script-policy headers are the gateway's per-tenant allowlist only
      // when this process is enforcing X-Gateway-S2S. The insecure-dev
      // bypass leaves the secret empty, so those headers stay untrusted
      // and scripts_run is deny-all.
      trustScriptPolicyHeaders: scriptPolicyHeadersTrusted(isGatewayMode, s2sSecret),
      // Remote script execution needs an authenticated caller. A non-empty
      // s2sSecret is that caller for server-held env credentials (startup
      // refuses an empty secret except for the loopback insecure-dev bypass).
      // The opt-in flag is a second gate and defaults off. Neither is implied
      // by an elicitation answer.
      s2sEnforced: s2sSecret !== "",
      allowServerHeldScriptExecution: process.env.NINJAONE_ALLOW_SERVER_HELD_SCRIPT_EXECUTION,
    }),
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
      // Empty s2sSecret is only reachable when MCP_ALLOW_INSECURE_DEV=1;
      // startup refuses otherwise. A configured secret is always enforced.
      if (s2sSecret && !verifyS2sHeader(headerValue(req.headers[S2S_HEADER]), s2sSecret)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.",
          })
        );
        return;
      }

      if (isGatewayMode) {
        const { error } = resolveGatewayCredentials((name) => headerValue(req.headers[name]));
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

  httpServer.on("close", () => {
    void mcpHandler.close().catch((error: unknown) => {
      logger.error("Error closing MCP handler", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    httpServer.once("error", onError);
    httpServer.listen(port, host, () => {
      httpServer.off("error", onError);
      logger.info(`NinjaOne MCP server listening on http://${host}:${port}/mcp`);
      logger.info(`Health check available at http://${host}:${port}/health`);
      logger.info(`Authentication mode: ${isGatewayMode ? "gateway (header-based)" : "env (environment variables)"}`);
      resolve();
    });
  });

  return httpServer;
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
    const httpServer = await startHttpTransport();
    const shutdown = async () => {
      logger.info("Shutting down NinjaOne MCP server...");
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else {
    startStdioTransport();
  }
}

// Vitest imports this module to call startHttpTransport. Skip the CLI
// entrypoint there. `node dist/index.js` still starts stdio or HTTP.
if (process.env.VITEST !== "true") {
  main().catch((error) => {
    logger.error("Fatal startup error", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  });
}
