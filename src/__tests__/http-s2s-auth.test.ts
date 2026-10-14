/**
 * HTTP transport fail-closed auth.
 *
 * Startup requires a real CONDUIT_S2S_SECRET unless MCP_ALLOW_INSECURE_DEV=1.
 * Known placeholder secrets are refused even with that flag. The flag binds
 * 127.0.0.1 only. /mcp rejects a missing or invalid X-Gateway-S2S header.
 * AUTH_MODE=gateway rejects requests that omit vendor credential headers
 * and must not fall back to NINJAONE_* in process.env.
 */

import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startHttpTransport } from "../index.js";
import { mcpJson } from "./helpers.js";

const S2S_SECRET = "s2s-do-not-log-7f3a";
const ENV_CLIENT_ID = "env-client-id-must-not-be-used";
const ENV_CLIENT_SECRET = "env-secret-must-not-be-used";

const ENV_KEYS = [
  "CONDUIT_S2S_SECRET",
  "MCP_ALLOW_INSECURE_DEV",
  "MCP_HTTP_PORT",
  "MCP_HTTP_HOST",
  "AUTH_MODE",
  "NINJAONE_CLIENT_ID",
  "NINJAONE_CLIENT_SECRET",
  "NINJAONE_REGION",
  "LOG_LEVEL",
  "MCP_TRANSPORT",
] as const;

const savedEnv = new Map<string, string | undefined>();
const servers: Server[] = [];

function mintS2sHeader(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac("sha256", secret).update(message).digest("hex");
  return `${message},v1=${hex}`;
}

function captureStderr(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  });
  return {
    text: () => lines.join("\n"),
    restore: () => spy.mockRestore(),
  };
}

function mcpHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...extra,
  };
}

const statusCall = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "ninjaone_status", arguments: {} },
});

async function listen(): Promise<{ port: number; address: string; close: () => Promise<void> }> {
  const server = await startHttpTransport();
  servers.push(server);
  const bound = server.address();
  if (!bound || typeof bound === "string") {
    throw new Error("HTTP server did not bind a TCP port");
  }
  return {
    port: bound.port,
    address: bound.address,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        server.closeAllConnections();
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}

function refuseExit(): void {
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${String(code)}`);
  }) as typeof process.exit);
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  process.env.MCP_HTTP_PORT = "0";
  process.env.MCP_HTTP_HOST = "127.0.0.1";
  process.env.LOG_LEVEL = "info";
  delete process.env.CONDUIT_S2S_SECRET;
  delete process.env.MCP_ALLOW_INSECURE_DEV;
  delete process.env.AUTH_MODE;
  delete process.env.NINJAONE_CLIENT_ID;
  delete process.env.NINJAONE_CLIENT_SECRET;
  delete process.env.NINJAONE_REGION;
  delete process.env.MCP_TRANSPORT;
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server?.listening) continue;
    await new Promise<void>((resolveClose, rejectClose) => {
      server.closeAllConnections();
      server.close((err) => (err ? rejectClose(err) : resolveClose()));
    });
  }
});

describe("HTTP startup", () => {
  it("refuses to start when CONDUIT_S2S_SECRET is empty", async () => {
    const logs = captureStderr();
    refuseExit();

    await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
    const text = logs.text();
    expect(text).toContain("Refusing to start HTTP transport");
    expect(text).toContain("CONDUIT_S2S_SECRET");
    expect(text).not.toContain(S2S_SECRET);
  });

  it("still refuses when MCP_ALLOW_INSECURE_DEV is not exactly 1", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "true";
    process.env.CONDUIT_S2S_SECRET = "   ";
    const logs = captureStderr();
    refuseExit();

    await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
    expect(logs.text()).toContain("Refusing to start HTTP transport");
    expect(logs.text()).toContain("CONDUIT_S2S_SECRET is empty");
  });

  it.each(["changeme", "  CHANGE-ME  ", "replace-with-a-real-secret", "${CONDUIT_S2S_SECRET}"])(
    "refuses known placeholder %j even when MCP_ALLOW_INSECURE_DEV=1",
    async (placeholder) => {
      process.env.CONDUIT_S2S_SECRET = placeholder;
      process.env.MCP_ALLOW_INSECURE_DEV = "1";
      const logs = captureStderr();
      refuseExit();

      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      const text = logs.text();
      expect(text).toContain("known placeholder");
      expect(text).toContain("Refusing to start HTTP transport");
      expect(text).not.toContain("SECURITY WARNING");
      expect(text).not.toContain(placeholder.trim());
    }
  );

  it("allows startup with a warning when MCP_ALLOW_INSECURE_DEV=1 and binds 127.0.0.1", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    delete process.env.MCP_HTTP_HOST;
    const logs = captureStderr();

    const server = await listen();
    const text = logs.text();
    expect(server.address).toBe("127.0.0.1");
    expect(text).toContain("SECURITY WARNING");
    expect(text).toContain("CONDUIT_S2S_SECRET");
    expect(text).toContain("MCP_ALLOW_INSECURE_DEV");
    expect(text).toContain("127.0.0.1");
    expect(text).not.toContain("not a loopback address");
    expect(text).not.toContain(S2S_SECRET);
  });

  it.each(["0.0.0.0", "10.1.2.3"])(
    "forces 127.0.0.1 when MCP_ALLOW_INSECURE_DEV=1 and MCP_HTTP_HOST is %s",
    async (host) => {
      process.env.MCP_ALLOW_INSECURE_DEV = "1";
      process.env.MCP_HTTP_HOST = host;
      const logs = captureStderr();

      const server = await listen();
      const text = logs.text();
      expect(server.address).toBe("127.0.0.1");
      expect(text).toContain(`MCP_HTTP_HOST=${host} is not a loopback address`);
      expect(text).toContain("Binding 127.0.0.1 only");
      expect(text).not.toContain(S2S_SECRET);
    }
  );

  it("honors a non-loopback MCP_HTTP_HOST when CONDUIT_S2S_SECRET is set", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = "0.0.0.0";
    const logs = captureStderr();

    const server = await listen();
    expect(server.address).toBe("0.0.0.0");
    expect(logs.text()).not.toContain("not a loopback address");
    expect(logs.text()).not.toContain(S2S_SECRET);
  });

  it("binds 127.0.0.1 when MCP_HTTP_HOST is unset and a secret is configured", async () => {
    delete process.env.MCP_HTTP_HOST;
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;

    const server = await listen();
    expect(server.address).toBe("127.0.0.1");
  });
});

describe("HTTP /mcp authentication", () => {
  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = "gateway";
    process.env.NINJAONE_CLIENT_ID = ENV_CLIENT_ID;
    process.env.NINJAONE_CLIENT_SECRET = ENV_CLIENT_SECRET;
    process.env.NINJAONE_REGION = "oc";
  });

  it("returns 401 when the S2S header is missing or invalid and does not log the secret", async () => {
    const logs = captureStderr();
    const server = await listen();

    const missing = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: mcpHeaders({
        "x-ninja-client-id": "header-client-id",
        "x-ninja-client-secret": "header-client-secret",
      }),
      body: statusCall,
    });
    const invalid = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: mcpHeaders({
        "x-gateway-s2s": mintS2sHeader("wrong-secret"),
        "x-ninja-client-id": "header-client-id",
        "x-ninja-client-secret": "header-client-secret",
      }),
      body: statusCall,
    });

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    const missingBody = await missing.text();
    const invalidBody = await invalid.text();
    expect(missingBody).toContain("X-Gateway-S2S");
    expect(invalidBody).toContain("X-Gateway-S2S");
    expect(missingBody).not.toContain(S2S_SECRET);
    expect(invalidBody).not.toContain(S2S_SECRET);
    expect(missingBody).not.toContain(ENV_CLIENT_ID);
    expect(missingBody).not.toContain(ENV_CLIENT_SECRET);
    expect(logs.text()).not.toContain(S2S_SECRET);
    expect(logs.text()).not.toContain(ENV_CLIENT_SECRET);
  });

  it("returns 401 in gateway mode without credential headers and does not use env credentials", async () => {
    const server = await listen();

    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: mcpHeaders({ "x-gateway-s2s": mintS2sHeader(S2S_SECRET) }),
      body: statusCall,
    });
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(body).toContain("Missing credentials");
    expect(body).toContain("X-Ninja-Client-ID");
    expect(body).toContain("X-Ninja-Client-Secret");
    expect(body).not.toContain(ENV_CLIENT_ID);
    expect(body).not.toContain(ENV_CLIENT_SECRET);
    expect(body).not.toContain(S2S_SECRET);
    expect(body).not.toContain("oc.ninjarmm.com");

    const partial = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: mcpHeaders({
        "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
        "x-ninja-client-id": "header-client-id",
      }),
      body: statusCall,
    });
    expect(partial.status).toBe(401);
  });

  it("accepts a valid S2S header plus credential headers and uses those credentials", async () => {
    const logs = captureStderr();
    const server = await listen();

    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: mcpHeaders({
        "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
        "x-ninja-client-id": "header-client-id",
        "x-ninja-client-secret": "header-client-secret",
        "x-ninja-region": "eu",
      }),
      body: statusCall,
    });
    const payload = (await mcpJson(response)) as {
      result?: { content?: Array<{ text?: string }> };
    };
    const text = payload.result?.content?.[0]?.text ?? "";

    expect(response.status).toBe(200);
    expect(text).toContain("region: eu");
    expect(text).toContain("https://eu.ninjarmm.com");
    expect(text).not.toContain("region: oc");
    expect(text).not.toContain(ENV_CLIENT_ID);
    expect(text).not.toContain(ENV_CLIENT_SECRET);
    expect(text).not.toContain(S2S_SECRET);
    expect(logs.text()).not.toContain(S2S_SECRET);
    expect(logs.text()).not.toContain(ENV_CLIENT_SECRET);
  });

  it("serves /health without authentication and without reading credentials", async () => {
    const server = await listen();
    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    const body = (await response.json()) as { status?: string };

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(S2S_SECRET);
    expect(raw).not.toContain(ENV_CLIENT_ID);
    expect(raw).not.toContain(ENV_CLIENT_SECRET);
  });
});

describe("fail-closed deployment config", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

  it("leaves CONDUIT_S2S_SECRET empty in .env.example", () => {
    const example = readFileSync(resolve(root, ".env.example"), "utf8");
    expect(example).toMatch(/^CONDUIT_S2S_SECRET=\s*$/m);
    expect(example).toContain("MCP_ALLOW_INSECURE_DEV");
    expect(example).not.toContain(S2S_SECRET);
  });

  it("requires the S2S secret in compose and gives the gateway service no static creds", () => {
    const compose = readFileSync(resolve(root, "docker-compose.yml"), "utf8");
    const gateway = compose.split("ninjaone-mcp-dev:")[0] ?? "";

    expect(gateway).toContain("127.0.0.1:8080:8080");
    expect(gateway).toContain("AUTH_MODE=gateway");
    expect(gateway).toContain("CONDUIT_S2S_SECRET=${CONDUIT_S2S_SECRET:?set CONDUIT_S2S_SECRET}");
    expect(gateway).not.toMatch(/^\s*env_file:/m);
    expect(gateway).not.toMatch(/NINJAONE_CLIENT_ID=\$\{/);
    expect(gateway).not.toMatch(/NINJAONE_CLIENT_SECRET=\$\{/);
  });

  it("documents X-Gateway-S2S signing in the README", () => {
    const readme = readFileSync(resolve(root, "README.md"), "utf8");
    expect(readme).toContain("X-Gateway-S2S");
    expect(readme).toContain("t=<unix seconds>,v1=<hex>");
    expect(readme).toMatch(/HMAC-SHA256/i);
    expect(readme).toContain("CONDUIT_S2S_SECRET");
  });
});
