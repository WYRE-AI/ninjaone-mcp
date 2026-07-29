/**
 * Regression test: cross-tenant "server reference" misrouting.
 *
 * Historically the server reference used by elicitation helpers
 * (`utils/elicitation.ts`) was stored in a module-level `let _server`
 * singleton in `utils/server-ref.ts` (`setServerRef` / `getServerRef`), set
 * synchronously and read back later — including after `await` gaps inside
 * async tool handlers (e.g. after awaiting a NinjaOne API call, before
 * sending an elicitation prompt back through "the" server).
 *
 * In gateway (multi-tenant HTTP) mode, `@modelcontextprotocol/server`'s
 * `createMcpHandler` creates a fresh `Server` per request via our factory
 * and drives that request's dispatch within the SAME async continuation
 * that invoked the factory — one fresh factory call per request, never
 * sharing a continuation with a different request's call (verified against
 * the installed SDK source, same version already verified for
 * scalepad-mcp's identical fix; the Workers path in worker.ts calls the
 * exact same `fetchFace` function directly with no intervening adapter, so
 * the same guarantee holds there too). This test simulates that exact
 * shape: `bindServerRef(server)` called once, followed (in the same
 * continuation) by an awaited gap and then the elicitation call — run for
 * two independent "requests" with a forced deterministic interleave,
 * asserting BY VALUE which tenant's mock server actually received the
 * elicitation call.
 *
 * (Verified by temporarily reinstating a module-singleton implementation
 * behind the same function names: this test fails with tenant A's prompt
 * observed on tenant B's mock `elicitInput`, and passes again once the
 * ALS-based fix is restored — see the PR description.)
 */
import { describe, it, expect, vi } from "vitest";
import type { Server } from "@modelcontextprotocol/server";
import { bindServerRef, getServerRef } from "../utils/server-ref.js";
import { elicitConfirmation } from "../utils/elicitation.js";

/** A deferred promise the test can resolve on demand, for a deterministic forced interleave. */
function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type FakeServer = Server & { tenantId: string; elicitInput: ReturnType<typeof vi.fn> };

/** Minimal fake MCP Server whose elicitInput is a per-instance spy (per-tenant mock). */
function createFakeServer(tenantId: string): FakeServer {
  const elicitInput = vi.fn().mockImplementation(async () => ({
    action: "accept" as const,
    content: { confirm: true },
  }));
  return { tenantId, elicitInput } as unknown as FakeServer;
}

/**
 * Simulates one "request": `bindServerRef` called synchronously (like
 * `createMcpServer()` being invoked from our factory), then the rest of
 * that same request's dispatch continuing in the same async continuation
 * (like `createMcpHandler`'s internal `factory()` -> `invoke()` sequence).
 */
async function simulateRequest<T>(server: FakeServer, dispatch: () => Promise<T>): Promise<T> {
  bindServerRef(server);
  return dispatch();
}

describe("server-ref cross-tenant isolation", () => {
  it("getServerRef returns null outside of any bound context", () => {
    expect(getServerRef()).toBeNull();
  });

  it("getServerRef resolves the server bound by bindServerRef within its continuation", async () => {
    const server = createFakeServer("tenant-X");
    await simulateRequest(server, async () => {
      expect(getServerRef()).toBe(server);
    });
  });

  it(
    "routes each tenant's elicitation through its OWN server, even when a " +
      "second tenant's request runs to completion (its own independent " +
      "top-level async chain) while the first is still in flight (forced " +
      "deterministic interleave, not a timing stagger)",
    async () => {
      const serverA = createFakeServer("tenant-A");
      const serverB = createFakeServer("tenant-B");
      const gate = createDeferred<void>();

      // Tenant A: binds its server, then suspends on an await gap
      // (simulating an in-flight NinjaOne API call inside a tool handler)
      // BEFORE sending its confirmation prompt.
      const tenantA = simulateRequest(serverA, async () => {
        await gate.promise; // the exact await gap the original bug lost the ref across
        expect((getServerRef() as FakeServer | null)?.tenantId).toBe("tenant-A"); // must still be A's server after resuming
        return elicitConfirmation("Confirm tenant A's sensitive action?");
      });

      // Force the interleave: tenant B is its OWN independent top-level
      // async chain (like a separate concurrent HTTP request's own factory
      // + dispatch invocation) — bind, elicit, resolve — running to
      // completion while tenant A is still suspended above.
      const tenantB = simulateRequest(serverB, async () => {
        return elicitConfirmation("Confirm tenant B's sensitive action?");
      });
      await tenantB;

      // Only now let tenant A resume.
      gate.resolve();
      const resultA = await tenantA;
      expect(resultA).toBe(true);

      // --- Per-tenant VALUE assertions -----------------------------------
      // Each tenant's prompt must have gone out through THAT tenant's mock
      // server specifically, not the other tenant's.
      expect(serverA.elicitInput).toHaveBeenCalledTimes(1);
      expect(serverA.elicitInput).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Confirm tenant A's sensitive action?",
        })
      );

      expect(serverB.elicitInput).toHaveBeenCalledTimes(1);
      expect(serverB.elicitInput).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Confirm tenant B's sensitive action?",
        })
      );

      // Explicit negative checks: A's message must never have reached B's
      // transport, and B's must never have reached A's.
      for (const call of serverA.elicitInput.mock.calls) {
        expect(call[0].message).not.toBe("Confirm tenant B's sensitive action?");
      }
      for (const call of serverB.elicitInput.mock.calls) {
        expect(call[0].message).not.toBe("Confirm tenant A's sensitive action?");
      }
    }
  );

  it("bindServerRef binds for the remainder of the current async execution (stdio single-session mode)", async () => {
    const server = createFakeServer("tenant-X");
    bindServerRef(server);
    // Simulate work continuing across an await gap in the same "session".
    await Promise.resolve();
    expect(getServerRef()).toBe(server);
  });
});
