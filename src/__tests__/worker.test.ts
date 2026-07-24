/**
 * Tests for the Cloudflare Workers entrypoint.
 *
 * Drives the exported `fetch` handler directly with Web Standard Request objects
 * (available natively in Node 18+), exercising the same WebStandardStreamableHTTP
 * transport the Worker uses in production.
 */

import { describe, it, expect } from "vitest";
import worker, { type Env } from "../worker.js";
import { mcpJson } from "./helpers.js";

const MCP_HEADERS = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
};

async function mcp(body: unknown, env: Env = {}): Promise<Response> {
  return worker.fetch(
    new Request("http://worker.local/mcp", {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify(body),
    }),
    env
  );
}

describe("Cloudflare Worker entrypoint", () => {
  it("serves a shallow health probe", async () => {
    const res = await worker.fetch(new Request("http://worker.local/health"), {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("answers CORS preflight", async () => {
    const res = await worker.fetch(
      new Request("http://worker.local/mcp", { method: "OPTIONS" }),
      {}
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("404s unknown paths", async () => {
    const res = await worker.fetch(new Request("http://worker.local/nope"), {});
    expect(res.status).toBe(404);
  });

  it("handles MCP initialize", async () => {
    const res = await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0" },
      },
    });
    expect(res.status).toBe(200);
    const body = (await mcpJson(res)) as { result?: { serverInfo?: { name?: string } } };
    expect(body.result?.serverInfo?.name).toBe("ninjaone-mcp");
  });

  it("lists all tools without credentials", async () => {
    const res = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(res.status).toBe(200);
    const body = (await mcpJson(res)) as { result?: { tools?: { name: string }[] } };
    const names = (body.result?.tools ?? []).map((t) => t.name);
    expect(names).toContain("ninjaone_navigate");
    expect(names).toContain("ninjaone_status");
    expect(names.length).toBeGreaterThan(10);
  });

  it("returns a graceful error for a credential-requiring tool when unconfigured", async () => {
    const res = await mcp({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "ninjaone_devices_list", arguments: {} },
    });
    expect(res.status).toBe(200);
    const body = (await mcpJson(res)) as {
      result?: { isError?: boolean; content?: { text?: string }[] };
    };
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toMatch(/credentials/i);
  });

  it("rejects /mcp in gateway mode without credential headers", async () => {
    const res = await mcp(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "ninjaone_devices_list", arguments: {} },
      },
      { AUTH_MODE: "gateway" }
    );
    expect(res.status).toBe(401);
  });
});
