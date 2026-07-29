/**
 * Shared MCP Server reference for elicitation support.
 * Avoids circular imports by decoupling server instance from domain handlers.
 *
 * SECURITY (cross-tenant misroute): this used to be a module-level
 * `let _server` singleton, set synchronously via `setServerRef` and read
 * back later by elicitation helpers — including after `await` gaps inside
 * async tool handlers (e.g. after awaiting a NinjaOne API call, before
 * sending an elicitation prompt back through "the" server).
 *
 * In gateway (multi-tenant HTTP) mode, `@modelcontextprotocol/server`'s
 * `createMcpHandler` creates a fresh `Server` per request via our factory
 * (`makeMcpServerFactory` in mcp-server.ts) and then drives that same
 * request's `tools/call` dispatch within the SAME async continuation that
 * invoked the factory — one fresh factory call per inbound request, never
 * nested inside or sharing a continuation with a different request. That
 * makes `bindServerRef` (AsyncLocalStorage's `enterWith`), called once at
 * server creation, correctly scoped per request here: `enterWith`'s binding
 * follows only this request's own causal async chain and is never observed
 * by a concurrently-running sibling request's chain, even across `await`
 * gaps (unlike a plain module-level `let`, which every request shares
 * unconditionally). This is the same wiring (and same SDK version) already
 * verified for scalepad-mcp's identical fix.
 *
 * This differs from repos where our own code owns the raw per-request HTTP
 * callback directly (e.g. a bespoke `http.ts` built on `node:http`) — there,
 * the whole per-request chain gets wrapped in `runWithServerRef` (ALS's
 * `.run()`) instead, since that code owns the callback boundary needed to
 * scope it explicitly. Here, `createMcpHandler` owns request dispatch
 * internally after the factory returns, so there is no callback boundary of
 * our own to wrap — `enterWith`, bound once at server creation, is the only
 * viable option, and is correctly scoped given the factory-per-request
 * contract above. The same applies to worker.ts's Cloudflare Workers
 * `createMcpHandler` usage.
 *
 * For stdio, `index.ts` passes a 0-arg factory to `serveStdio` that's
 * called exactly once for the process's single long-lived session — the
 * same `bindServerRef` call there binds for that entire session, since
 * there is only ever one tenant and no concurrent request to isolate from.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Server } from "@modelcontextprotocol/server";

const serverRefStore = new AsyncLocalStorage<Server>();

/**
 * Bind `server` for the remainder of the current async execution.
 *
 * Safe for both entrypoints given each one's own factory-invocation
 * contract: stdio's factory runs once for the whole process (single
 * session, no concurrent tenants); gateway/HTTP's and Workers' factory runs
 * once per request, with that request's own dispatch continuing in the
 * same causal chain, so concurrent requests never share a binding.
 */
export function bindServerRef(server: Server): void {
  serverRefStore.enterWith(server);
}

/**
 * Get the server bound to the current request's async context, or `null`
 * if none is bound (e.g. called outside of any request/session).
 */
export function getServerRef(): Server | null {
  return serverRefStore.getStore() ?? null;
}
