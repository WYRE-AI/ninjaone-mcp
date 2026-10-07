/**
 * Shared MCP Server reference for elicitation support.
 * Avoids circular imports by decoupling server instance from domain handlers.
 *
 * SECURITY (cross-tenant misroute): this used to be a module-level
 * `let _server` singleton, set synchronously via `setServerRef` and read
 * back later by elicitation helpers — including after `await` gaps inside
 * async tool handlers (e.g. after awaiting a NinjaOne API call, before
 * sending an elicitation prompt back through "the" server). A module-level
 * fallback is still unsafe in gateway mode: concurrent requests share it,
 * so one tenant's elicitation can be delivered on another's server.
 *
 * `createMcpHandler` (Node HTTP and Cloudflare Workers) and `serveStdio`
 * build a fresh `Server` in the factory, return it, and only later invoke
 * that server's request handlers. Binding with `AsyncLocalStorage.enterWith()`
 * at construction time relied on those later invocations staying in the same
 * async continuation. workerd does not implement `enterWith()` — the call
 * throws `asyncLocalStorage.enterWith() is not implemented` — so every
 * Workers `/mcp` request died inside `createMcpServer` before initialize
 * (issue #103). `run()` and `getStore()` are implemented.
 *
 * `bindServerRef` therefore does not enter a context at construction time.
 * It wraps `server.setRequestHandler` so each handler registered afterwards
 * (tools, prompts, resources) runs inside `AsyncLocalStorage.run(server, ...)`.
 * The store follows that handler's awaited descendants and nobody else's.
 * Concurrent requests each get their own server and their own `run()` frame.
 * stdio is the same wrap: one long-lived server, rebound on every handler
 * invocation. No module-level server is retained.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Server } from "@modelcontextprotocol/server";

const serverRefStore = new AsyncLocalStorage<Server>();

/** Servers whose `setRequestHandler` already scopes handlers with `run()`. */
const patchedServers = new WeakSet<Server>();

type RequestHandler = (request: unknown, ctx: unknown) => unknown;

/**
 * The subset of `Server.setRequestHandler` this module wraps. The SDK method
 * is overloaded (spec method + handler, or custom method + schemas + handler);
 * both forms end in a user callback, which is what must run inside `run()`.
 */
interface HandlerRegistration {
  setRequestHandler(
    method: string,
    schemasOrHandler: RequestHandler | object,
    maybeHandler?: RequestHandler
  ): void;
}

/**
 * Arm `server` so every request handler registered after this call runs with
 * `server` bound via `AsyncLocalStorage.run()`.
 *
 * Call once, before registering handlers (`createMcpServer` does). Safe for
 * stdio, Node HTTP, and Cloudflare Workers: nothing here calls `enterWith()`.
 */
export function bindServerRef(server: Server): void {
  if (patchedServers.has(server)) return;

  const registration = server as unknown as HandlerRegistration;
  if (typeof registration.setRequestHandler !== "function") {
    throw new TypeError("bindServerRef requires server.setRequestHandler");
  }
  patchedServers.add(server);

  const original = registration.setRequestHandler.bind(registration);
  registration.setRequestHandler = (method, schemasOrHandler, maybeHandler) => {
    if (typeof schemasOrHandler === "function") {
      const handler = schemasOrHandler;
      original(method, (request, ctx) => serverRefStore.run(server, () => handler(request, ctx)));
      return;
    }
    if (typeof maybeHandler === "function") {
      original(method, schemasOrHandler, (request, ctx) =>
        serverRefStore.run(server, () => maybeHandler(request, ctx))
      );
      return;
    }
    original(method, schemasOrHandler, maybeHandler);
  };
}

/**
 * Get the server bound to the current handler's async context, or `null`
 * if none is bound (outside a request handler, or before `bindServerRef`).
 */
export function getServerRef(): Server | null {
  return serverRefStore.getStore() ?? null;
}
