/**
 * Cloudflare Workers entry point for the NinjaOne MCP Server.
 *
 * Serves the full MCP server over the Streamable HTTP transport using the SDK's
 * Web Standard transport (Request/Response), which runs natively on Workers.
 * It reuses the exact same `createMcpServer()` factory as the stdio / Node HTTP
 * entrypoints (see `mcp-server.ts`), so there is no second tool implementation
 * to maintain.
 *
 * Credentials are resolved per request, in order:
 * 1. Gateway headers (when AUTH_MODE=gateway):
 *    - X-Ninja-Client-ID
 *    - X-Ninja-Client-Secret
 *    - X-Ninja-Region (optional; us, eu, oc, ca, us2, fed)
 * 2. Worker secrets / vars (env mode):
 *    - NINJAONE_CLIENT_ID
 *    - NINJAONE_CLIENT_SECRET
 *    - NINJAONE_REGION (optional)
 *
 * `tools/list` and `initialize` work without credentials; only `tools/call`
 * requires them.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import {
  createMcpServer,
  resolveGatewayCredentials,
  buildCredentials,
  type NinjaOneCredentials,
} from "./mcp-server.js";

export interface Env {
  NINJAONE_CLIENT_ID?: string;
  NINJAONE_CLIENT_SECRET?: string;
  NINJAONE_REGION?: string;
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

      let credOverrides: NinjaOneCredentials | undefined;
      if (isGatewayMode) {
        const { creds, error } = resolveGatewayCredentials(
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
        credOverrides = creds;
      } else {
        // env mode: build credentials from Worker secrets if present.
        // (Absent creds are fine — tools/list still works, tools/call errors.)
        const { creds } = buildCredentials(
          env.NINJAONE_CLIENT_ID,
          env.NINJAONE_CLIENT_SECRET,
          env.NINJAONE_REGION
        );
        credOverrides = creds;
      }

      // Fresh server + transport per request (stateless).
      const server = await createMcpServer(credOverrides);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);

      try {
        const response = await transport.handleRequest(request);
        return withCors(response);
      } finally {
        await transport.close();
        await server.close();
      }
    }

    return json(
      { error: "Not found", endpoints: ["/mcp", "/health"] },
      404
    );
  },
};
