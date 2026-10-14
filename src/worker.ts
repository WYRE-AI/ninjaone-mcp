/**
 * Cloudflare Workers entry point for the NinjaOne MCP Server.
 *
 * Serves the full MCP server via the v2 SDK's `createMcpHandler`, whose
 * web-standard `fetch` face runs natively on Workers. Dual protocol eras are
 * served from one handler: legacy 2025-era clients statelessly per request
 * (`legacy: 'stateless'`), modern 2026-07-28 envelope clients natively.
 * It reuses the exact same `createMcpServer()` factory as the stdio / Node
 * HTTP entrypoints (see `mcp-server.ts`), so there is no second tool
 * implementation to maintain.
 *
 * Credentials are resolved per request, in order:
 * 1. Gateway headers (when AUTH_MODE=gateway) — identity only:
 *    - X-Ninja-Client-ID
 *    - X-Ninja-Client-Secret
 *    - X-Ninja-Region (optional; us, eu, oc, ca, us2, fed)
 *    - X-Ninja-Scopes (optional)
 * 2. Worker secrets / vars, in both modes, for script policy. This Worker
 *    is a public endpoint, so X-Ninja-Allowed-Script-Ids and
 *    X-Ninja-Allow-Self-Attested-Confirmation on the request are ignored
 *    (and not advertised via CORS). Per-org policy headers are honored
 *    only on the Node HTTP entry, which is the gateway's target.
 *    - NINJAONE_CLIENT_ID / NINJAONE_CLIENT_SECRET / NINJAONE_REGION
 *      (env mode only; gateway mode takes identity from headers)
 *    - NINJAONE_ALLOWED_SCRIPT_IDS (optional; unset means scripts_run
 *      refuses everything — see utils/types.ts parseAllowedScriptIds)
 *    - NINJAONE_ALLOW_SELF_ATTESTED_CONFIRMATION (optional; unset/false
 *      means scripts_run refuses outright on a client with no elicitation
 *      support, rather than silently falling back to confirm:true)
 *
 * `tools/list` and `initialize` work without credentials; only `tools/call`
 * requires them.
 */
import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import {
  makeMcpServerFactory,
  resolveGatewayCredentials,
  buildCredentials,
} from "./mcp-server.js";

export interface Env {
  NINJAONE_CLIENT_ID?: string;
  NINJAONE_CLIENT_SECRET?: string;
  NINJAONE_REGION?: string;
  NINJAONE_ALLOWED_SCRIPT_IDS?: string;
  NINJAONE_ALLOW_SELF_ATTESTED_CONFIRMATION?: string;
  AUTH_MODE?: string;
  LOG_LEVEL?: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, X-Ninja-Client-ID, X-Ninja-Client-Secret, X-Ninja-Region",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * One MCP handler per distinct Worker `env` object. In production the runtime
 * passes the same `env` to every fetch in an isolate, so this memoizes to a
 * single handler per isolate; the handler's factory still runs per request
 * (stateless), exactly like the previous per-request Server + Transport
 * wiring. Tests that pass differing env objects each get a matching handler.
 */
const handlers = new WeakMap<Env, McpHttpHandler>();

function getMcpHandler(env: Env): McpHttpHandler {
  let handler = handlers.get(env);
  if (!handler) {
    const isGatewayMode = (env.AUTH_MODE ?? "env") === "gateway";
    handler = createMcpHandler(
      makeMcpServerFactory({
        gatewayMode: isGatewayMode,
        // env mode: build credentials from Worker secrets if present.
        // (Absent creds are fine — tools/list still works, tools/call errors.)
        envCredentials: isGatewayMode
          ? undefined
          : buildCredentials(
              env.NINJAONE_CLIENT_ID,
              env.NINJAONE_CLIENT_SECRET,
              env.NINJAONE_REGION,
              undefined,
              env.NINJAONE_ALLOWED_SCRIPT_IDS,
              env.NINJAONE_ALLOW_SELF_ATTESTED_CONFIRMATION
            ).creds,
        // Public boundary: script policy comes from Worker bindings, never
        // from request headers a browser or other caller can set.
        trustScriptPolicyHeaders: false,
        scriptPolicy: {
          allowedScriptIds: env.NINJAONE_ALLOWED_SCRIPT_IDS,
          allowSelfAttestedConfirmation: env.NINJAONE_ALLOW_SELF_ATTESTED_CONFIRMATION,
        },
      }),
      { legacy: "stateless" }
    );
    handlers.set(env, handler);
  }
  return handler;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Shallow, unauthenticated liveness probe.
    if (url.pathname === "/health" || url.pathname === "/healthz") {
      return json({ status: "ok" });
    }

    if (url.pathname === "/mcp") {
      const isGatewayMode = (env.AUTH_MODE ?? "env") === "gateway";

      if (isGatewayMode) {
        const { error } = resolveGatewayCredentials(
          (name) => request.headers.get(name) ?? undefined
        );
        if (error) {
          return json(
            {
              error: "Missing credentials",
              message: error,
              required: ["X-Ninja-Client-ID", "X-Ninja-Client-Secret"],
              optional: ["X-Ninja-Region"],
            },
            401
          );
        }
      }

      // Per-request credential binding happens inside the factory (gateway
      // mode reads the X-Ninja-* headers from ctx.requestInfo every request).
      const response = await getMcpHandler(env).fetch(request);
      return withCors(response);
    }

    return json(
      { error: "Not found", endpoints: ["/mcp", "/health"] },
      404
    );
  },
};
