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
 * `createMcpHandler` builds a server in the factory and invokes its handlers
 * later, possibly outside that factory's async continuation. workerd does
 * not implement `AsyncLocalStorage.enterWith()`, so the binding is
 * `AsyncLocalStorage.run()` around each handler registered after
 * `bindServerRef`. This test drives that shape: bind, register a handler,
 * then invoke it from a detached turn (and, for the interleave, from a
 * second tenant while the first is suspended). It also forces `enterWith`
 * to throw, which is what workerd does.
 *
 * (Verified by temporarily reinstating a module-singleton implementation
 * behind the same function names: this test fails with tenant A's prompt
 * observed on tenant B's mock `elicitInput`, and passes again once the
 * ALS-based fix is restored — see the PR description.)
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { describe, it, expect, vi, beforeEach } from "vitest";
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

type Handler = (request: unknown, ctx: unknown) => unknown;

type FakeServer = Server & {
  tenantId: string;
  elicitInput: ReturnType<typeof vi.fn>;
  setRequestHandler: (method: string, handler: Handler) => void;
  invoke: (method: string) => Promise<unknown>;
};

/** Minimal fake MCP Server whose elicitInput is a per-instance spy (per-tenant mock). */
function createFakeServer(tenantId: string): FakeServer {
  const handlers = new Map<string, Handler>();
  const elicitInput = vi.fn().mockImplementation(async () => ({
    action: "accept" as const,
    content: { confirm: true },
  }));
  const server = {
    tenantId,
    elicitInput,
    setRequestHandler(method: string, handler: Handler) {
      handlers.set(method, handler);
    },
    invoke(method: string) {
      const handler = handlers.get(method);
      if (!handler) throw new Error(`No handler registered for ${method}`);
      return Promise.resolve(handler(undefined, undefined));
    },
  };
  return server as unknown as FakeServer;
}

describe("server-ref cross-tenant isolation", () => {
  beforeEach(() => {
    // workerd throws from enterWith; run()/getStore() still work. If the
    // implementation calls enterWith, these tests fail the way Workers does.
    vi.spyOn(AsyncLocalStorage.prototype, "enterWith").mockImplementation(() => {
      throw new Error("asyncLocalStorage.enterWith() is not implemented");
    });
  });

  it("getServerRef returns null outside of any bound context", () => {
    expect(getServerRef()).toBeNull();
  });

  it("resolves the server inside a handler invoked after bindServerRef returns", async () => {
    const server = createFakeServer("tenant-X");
    bindServerRef(server);
    server.setRequestHandler("tools/call", async () => {
      expect(getServerRef()).toBe(server);
      await Promise.resolve();
      expect(getServerRef()).toBe(server);
      return "ok";
    });

    // Detach from the bind/register turn. The SDK invokes handlers after the
    // factory returns, not inside bindServerRef's continuation.
    await Promise.resolve();
    expect(getServerRef()).toBeNull();
    await expect(server.invoke("tools/call")).resolves.toBe("ok");
    expect(getServerRef()).toBeNull();
    expect(AsyncLocalStorage.prototype.enterWith).not.toHaveBeenCalled();
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

      bindServerRef(serverA);
      serverA.setRequestHandler("tools/call", async () => {
        await gate.promise; // the exact await gap the original bug lost the ref across
        expect((getServerRef() as FakeServer | null)?.tenantId).toBe("tenant-A");
        return elicitConfirmation("Confirm tenant A's sensitive action?");
      });

      bindServerRef(serverB);
      serverB.setRequestHandler("tools/call", async () => {
        return elicitConfirmation("Confirm tenant B's sensitive action?");
      });

      // Tenant B's handler runs to completion while tenant A is suspended.
      const tenantA = serverA.invoke("tools/call");
      const tenantB = serverB.invoke("tools/call");
      await expect(tenantB).resolves.toBe(true);

      gate.resolve();
      await expect(tenantA).resolves.toBe(true);

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

      expect(AsyncLocalStorage.prototype.enterWith).not.toHaveBeenCalled();
    }
  );

  it("rebinds the same server on each handler invocation (stdio single-session)", async () => {
    const server = createFakeServer("tenant-X");
    bindServerRef(server);
    server.setRequestHandler("tools/call", async () => getServerRef());

    // A later message on the long-lived stdio session, not the factory turn.
    await Promise.resolve();
    expect(getServerRef()).toBeNull();
    await expect(server.invoke("tools/call")).resolves.toBe(server);
    expect(getServerRef()).toBeNull();
    await expect(server.invoke("tools/call")).resolves.toBe(server);
  });
});
