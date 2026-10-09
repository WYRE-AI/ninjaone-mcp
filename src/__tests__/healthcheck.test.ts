/**
 * The image health probe must reach the IPv4 bind.
 *
 * Node listens on MCP_HTTP_HOST=0.0.0.0 (IPv4 only). In the Alpine image,
 * localhost resolves to ::1 first, so wget --spider http://localhost:PORT/health
 * gets connection refused and the container stays unhealthy. The probe has to
 * use 127.0.0.1 and the port the server actually bound (MCP_HTTP_PORT).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function wgetLine(source: string): string {
  const line = source.split("\n").find((entry) => entry.includes("wget"));
  expect(line).toBeDefined();
  return line ?? "";
}

describe("container healthcheck", () => {
  it("probes 127.0.0.1 and MCP_HTTP_PORT from the image HEALTHCHECK", () => {
    const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");
    const probe = wgetLine(dockerfile);

    expect(probe).toContain("http://127.0.0.1:${MCP_HTTP_PORT:-8080}/health");
    expect(probe).not.toContain("localhost");
    expect(probe.trim().startsWith("CMD [")).toBe(false);
  });

  it("probes 127.0.0.1 and the container's MCP_HTTP_PORT from Compose", () => {
    const compose = readFileSync(resolve(root, "docker-compose.yml"), "utf8");
    const probe = wgetLine(compose);

    expect(probe).toContain("CMD-SHELL");
    // $$ so Compose does not substitute the host port before the container
    // shell reads MCP_HTTP_PORT.
    expect(probe).toContain("http://127.0.0.1:$${MCP_HTTP_PORT:-8080}/health");
    expect(probe).not.toContain("localhost");
  });
});
