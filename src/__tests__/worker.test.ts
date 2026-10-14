/**
 * Tests for the Cloudflare Workers entrypoint.
 *
 * Drives the exported `fetch` handler directly with Web Standard Request objects
 * (available natively in Node 18+), exercising the same WebStandardStreamableHTTP
 * transport the Worker uses in production.
 */

import { describe, it, expect, beforeEach } from "vitest";
import worker, { type Env } from "../worker.js";
import { mcpJson, simulateWorkerdEnterWithGap, type WorkerdEnterWithGap } from "./helpers.js";

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
  let enterWithGap: WorkerdEnterWithGap;

  beforeEach(() => {
    // workerd's node:async_hooks implements AsyncLocalStorage.run()/getStore()
    // and throws from enterWith(). This Node harness does the same so a
    // regression that calls enterWith fails the /mcp path with HTTP 500,
    // matching production Workers (issue #103).
    enterWithGap = simulateWorkerdEnterWithGap();
  });

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
    const allowHeaders = res.headers.get("Access-Control-Allow-Headers") ?? "";
    expect(allowHeaders).not.toMatch(/x-ninja-allowed-script-ids/i);
    expect(allowHeaders).not.toMatch(/x-ninja-allow-self-attested-confirmation/i);
    expect(allowHeaders).not.toMatch(/x-ninja-scopes/i);
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
    expect(enterWithGap.calledDirectly()).toBe(false);
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

  it("does not let a public caller set the script allowlist in gateway mode", async () => {
    const previous = process.env.NINJAONE_ALLOWED_SCRIPT_IDS;
    process.env.NINJAONE_ALLOWED_SCRIPT_IDS = "SCRIPT:1234";
    try {
      const res = await worker.fetch(
        new Request("http://worker.local/mcp", {
          method: "POST",
          headers: {
            ...MCP_HEADERS,
            "X-Ninja-Client-ID": "tenant-id",
            "X-Ninja-Client-Secret": "tenant-secret",
            "X-Ninja-Allowed-Script-Ids": "SCRIPT:1234",
            "X-Ninja-Allow-Self-Attested-Confirmation": "true",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 5,
            method: "tools/call",
            params: {
              name: "ninjaone_scripts_run",
              arguments: { device_id: 101, type: "SCRIPT", id: 1234, confirm: true },
            },
          }),
        }),
        { AUTH_MODE: "gateway" }
      );
      expect(res.status).toBe(200);
      const body = (await mcpJson(res)) as { result?: { content?: { text?: string }[] } };
      expect(body.result?.content?.[0]?.text).toContain("not on this org's approved-scripts list");
    } finally {
      if (previous === undefined) delete process.env.NINJAONE_ALLOWED_SCRIPT_IDS;
      else process.env.NINJAONE_ALLOWED_SCRIPT_IDS = previous;
    }
  });

  it("applies the Worker script allowlist binding in gateway mode", async () => {
    const res = await worker.fetch(
      new Request("http://worker.local/mcp", {
        method: "POST",
        headers: {
          ...MCP_HEADERS,
          "X-Ninja-Client-ID": "tenant-id",
          "X-Ninja-Client-Secret": "tenant-secret",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: {
            name: "ninjaone_scripts_run",
            arguments: { device_id: 101, type: "SCRIPT", id: 1234, confirm: true },
          },
        }),
      }),
      {
        AUTH_MODE: "gateway",
        NINJAONE_ALLOWED_SCRIPT_IDS: "SCRIPT:1234",
      }
    );
    expect(res.status).toBe(200);
    const body = (await mcpJson(res)) as { result?: { content?: { text?: string }[] } };
    const text = body.result?.content?.[0]?.text ?? "";
    expect(text).not.toContain("not on this org's approved-scripts list");
    expect(text).toMatch(/confirmation/i);
  });

  it("applies the Worker script allowlist binding in env mode", async () => {
    const previous = process.env.NINJAONE_ALLOWED_SCRIPT_IDS;
    delete process.env.NINJAONE_ALLOWED_SCRIPT_IDS;
    try {
      const res = await worker.fetch(
        new Request("http://worker.local/mcp", {
          method: "POST",
          headers: MCP_HEADERS,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 6,
            method: "tools/call",
            params: {
              name: "ninjaone_scripts_run",
              arguments: { device_id: 101, type: "SCRIPT", id: 1234, confirm: true },
            },
          }),
        }),
        {
          NINJAONE_CLIENT_ID: "id",
          NINJAONE_CLIENT_SECRET: "secret",
          NINJAONE_ALLOWED_SCRIPT_IDS: "SCRIPT:1234",
        }
      );
      expect(res.status).toBe(200);
      const body = (await mcpJson(res)) as { result?: { content?: { text?: string }[] } };
      const text = body.result?.content?.[0]?.text ?? "";
      expect(text).not.toContain("not on this org's approved-scripts list");
      expect(text).toMatch(/confirmation/i);
    } finally {
      if (previous === undefined) delete process.env.NINJAONE_ALLOWED_SCRIPT_IDS;
      else process.env.NINJAONE_ALLOWED_SCRIPT_IDS = previous;
    }
  });
});
