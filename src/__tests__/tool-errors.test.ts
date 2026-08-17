/**
 * Tests for tool-call error formatting.
 *
 * The SDK stashes an upstream error's raw response body on
 * `NinjaOneError.response`, but the tool-call catch block used to surface only
 * `error.message`. For an OAuth failure that meant the operator saw a bare
 * "Failed to acquire token: 400 Bad Request" while the one diagnostic word
 * that explained it — `invalid_scope` — was collected and then dropped.
 */

import { describe, it, expect } from "vitest";
import { formatToolError } from "../mcp-server.js";

class FakeNinjaOneError extends Error {
  readonly statusCode: number;
  readonly response: unknown;

  constructor(message: string, statusCode: number, response?: unknown) {
    super(message);
    this.name = "NinjaOneAuthenticationError";
    this.statusCode = statusCode;
    this.response = response;
  }
}

describe("formatToolError", () => {
  it("appends the upstream response body so a 400 explains itself", () => {
    const error = new FakeNinjaOneError(
      "Failed to acquire token: 400 Bad Request",
      400,
      '{"error":"invalid_scope","error_description":"Invalid scope: management"}'
    );

    const text = formatToolError(error);

    expect(text).toContain("Failed to acquire token: 400 Bad Request");
    expect(text).toContain("invalid_scope");
  });

  it("adds a scope hint when the upstream rejects the requested scopes", () => {
    const error = new FakeNinjaOneError(
      "Failed to acquire token: 400 Bad Request",
      400,
      '{"error":"invalid_scope"}'
    );

    expect(formatToolError(error)).toContain("NINJAONE_SCOPES");
  });

  it("does not add the scope hint to unrelated failures", () => {
    const error = new FakeNinjaOneError("Device not found", 404, '{"error":"not_found"}');

    expect(formatToolError(error)).not.toContain("NINJAONE_SCOPES");
  });

  it("serializes a non-string response body", () => {
    const error = new FakeNinjaOneError("Bad request", 400, { error: "invalid_scope" });

    expect(formatToolError(error)).toContain("invalid_scope");
  });

  it("falls back to the bare message when there is no response body", () => {
    expect(formatToolError(new Error("boom"))).toBe("Error: boom");
  });

  it("handles a thrown non-Error value", () => {
    expect(formatToolError("kaboom")).toBe("Error: kaboom");
  });

  it("does not duplicate a body already contained in the message", () => {
    const error = new FakeNinjaOneError(
      'Request failed: {"error":"invalid_scope"}',
      400,
      '{"error":"invalid_scope"}'
    );

    const text = formatToolError(error);
    expect(text.match(/invalid_scope/g)).toHaveLength(1);
  });
});
