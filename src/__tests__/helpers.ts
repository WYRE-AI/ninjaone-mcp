/**
 * Shared test helpers (not collected by vitest — no .test suffix).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { vi } from "vitest";

export interface WorkerdEnterWithGap {
  /**
   * True if `enterWith()` was ever called directly (outside Node's own
   * `run()` frame) — the regression this simulation exists to catch.
   */
  calledDirectly(): boolean;
}

/**
 * Simulate workerd's AsyncLocalStorage gap for the duration of one test:
 * `run()`/`getStore()` work, a *direct* `enterWith()` call throws, matching
 * production Workers (issue #103).
 *
 * A naive `vi.spyOn(AsyncLocalStorage.prototype, "enterWith")` that always
 * throws is unsound on Node (verified on v26): `AsyncLocalStorage.run()`
 * calls `this.enterWith()` internally as its own implementation detail, so
 * an unconditional throw breaks every `run()` call too — not just a
 * regression that calls `enterWith()` directly, which is the only thing
 * workerd's real gap (and this simulation) is supposed to catch. Track
 * whether we're inside Node's own `run()` frame and only reject calls
 * outside of it; callers that want a regression-guard assertion should use
 * the returned `calledDirectly()`, not `enterWith`'s own mock call count
 * (which now includes legitimate internal passthrough calls).
 */
export function simulateWorkerdEnterWithGap(): WorkerdEnterWithGap {
  const originalRun = AsyncLocalStorage.prototype.run;
  const originalEnterWith = AsyncLocalStorage.prototype.enterWith;
  let insideNativeRun = 0;
  let directCalls = 0;

  vi.spyOn(AsyncLocalStorage.prototype, "run").mockImplementation(function (
    this: AsyncLocalStorage<unknown>,
    ...args: Parameters<AsyncLocalStorage<unknown>["run"]>
  ) {
    insideNativeRun++;
    try {
      return originalRun.apply(this, args);
    } finally {
      insideNativeRun--;
    }
  });

  vi.spyOn(AsyncLocalStorage.prototype, "enterWith").mockImplementation(function (
    this: AsyncLocalStorage<unknown>,
    ...args: Parameters<AsyncLocalStorage<unknown>["enterWith"]>
  ) {
    if (insideNativeRun > 0) {
      return originalEnterWith.apply(this, args);
    }
    directCalls++;
    throw new Error("asyncLocalStorage.enterWith() is not implemented");
  });

  return {
    calledDirectly: () => directCalls > 0,
  };
}

/**
 * Decode the JSON-RPC message from a streamable-HTTP response body.
 *
 * The v2 SDK's legacy stateless serving answers POSTs as SSE
 * (`text/event-stream`) rather than v1's single JSON body
 * (`enableJsonResponse: true`), so tests accept both encodings — exactly
 * like a real streamable-HTTP client does.
 */
export async function mcpJson(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const messages = (await res.text())
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5).trim()) as unknown);
    // Stateless per-request serving carries exactly one response message.
    return messages[messages.length - 1];
  }
  return res.json();
}
