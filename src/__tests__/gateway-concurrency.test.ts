/**
 * Regression test for the cross-tenant credential leak in gateway mode.
 *
 * Before the fix, gateway mode set request-scoped credentials on module-level
 * mutable singletons (`_clientOverride` / `_credentialOverrides` in
 * src/utils/client.ts) that were cleared in a `finally` block after each tool
 * call — but real await gaps between "set" and "clear" (dispatch into a
 * domain handler that itself awaits network I/O) meant a concurrent request
 * from a different tenant could read a tenant it doesn't belong to.
 *
 * This test drives the real request path — `worker.fetch()`, the same
 * `createMcpServer()` factory used by both the Cloudflare Workers entrypoint
 * and the Node HTTP transport in index.ts — with two concurrent `tools/call`
 * requests carrying different `X-Ninja-Client-*` credentials, one of which
 * has its mocked vendor API call artificially delayed so it is still
 * in-flight while the other request's headers are being resolved. Each
 * response must reflect only its own request's credentials.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import worker, { type Env } from "../worker.js";
import { mcpJson } from "./helpers.js";

interface CapturedConfig {
  clientId: string;
  clientSecret: string;
}

// The mock fn is created via vi.hoisted and its implementation (re-)applied
// in beforeEach rather than baked into the vi.mock() factory. client.ts
// imports the SDK statically, so this module evaluates once, up front,
// before any beforeEach hooks run — with the project's mockReset:true
// config, a factory-only implementation would get wiped by the automatic
// pre-test reset before this test ever saw it.
const { NinjaOneClientMock } = vi.hoisted(() => ({
  NinjaOneClientMock: vi.fn(),
}));

vi.mock("@wyre-ai/node-ninjaone", () => ({
  NinjaOneClient: NinjaOneClientMock,
}));

beforeEach(() => {
  NinjaOneClientMock.mockReset();
  NinjaOneClientMock.mockImplementation(function (config: CapturedConfig) {
    return {
      organizations: {
        list: vi.fn().mockImplementation(async () => {
          // Tenant A's vendor call is deliberately slow, so it is guaranteed
          // to still be in-flight while tenant B's concurrent request is
          // resolved end-to-end.
          if (config.clientId === "tenant-a-id") {
            await new Promise((r) => setTimeout(r, 40));
          }
          return [{ id: 1, name: `org-for-${config.clientId}` }];
        }),
      },
    };
  });
});

const MCP_HEADERS = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
};

function orgsListRequest(id: number) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "ninjaone_organizations_list", arguments: {} },
  };
}

async function mcp(
  body: unknown,
  headers: Record<string, string>,
  env: Env = { AUTH_MODE: "gateway" }
): Promise<Response> {
  return worker.fetch(
    new Request("http://worker.local/mcp", {
      method: "POST",
      headers: { ...MCP_HEADERS, ...headers },
      body: JSON.stringify(body),
    }),
    env
  );
}

describe("Gateway mode: cross-tenant credential isolation under real concurrency", () => {
  it("resolves each concurrent tenant's own credentials, never swapped", async () => {
    const [resA, resB] = await Promise.all([
      mcp(orgsListRequest(1), {
        "x-ninja-client-id": "tenant-a-id",
        "x-ninja-client-secret": "tenant-a-secret",
      }),
      mcp(orgsListRequest(2), {
        "x-ninja-client-id": "tenant-b-id",
        "x-ninja-client-secret": "tenant-b-secret",
      }),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    // Legacy stateless serving answers POSTs as SSE, so decode via the shared
    // helper rather than assuming a single JSON body.
    const bodyA = (await mcpJson(resA)) as {
      result?: { content?: { text?: string }[] };
    };
    const bodyB = (await mcpJson(resB)) as {
      result?: { content?: { text?: string }[] };
    };

    const textA = bodyA.result?.content?.[0]?.text ?? "";
    const textB = bodyB.result?.content?.[0]?.text ?? "";

    // Tenant B's fast response lands first, while tenant A's is still
    // in-flight. Each must reflect only its own tenant's data.
    expect(textB).toContain("org-for-tenant-b-id");
    expect(textB).not.toContain("tenant-a-id");

    expect(textA).toContain("org-for-tenant-a-id");
    expect(textA).not.toContain("tenant-b-id");
  });
});
