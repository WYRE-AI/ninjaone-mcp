/**
 * Caller authorization for remote script execution.
 *
 * ninjaone_scripts_run executes code on a customer endpoint. On stdio the
 * process owner is the caller. On HTTP (Node or Workers) the connected MCP
 * client is not: it can answer an elicitation prompt itself, so that prompt
 * is confirmation only and never authorization.
 *
 * An HTTP call is authorized only when the caller is already authenticated
 * by this server's existing gateway controls:
 * - per-request gateway credentials (X-Ninja-Client-ID / X-Ninja-Client-Secret), or
 * - a gateway-signed request (CONDUIT_S2S_SECRET is enforced, so an unsigned
 *   request never reaches the tool).
 *
 * Server-held deployment credentials (NINJAONE_CLIENT_ID / SECRET on the
 * process or Worker) are a second gate on top of that. They also require
 * NINJAONE_ALLOW_SERVER_HELD_SCRIPT_EXECUTION=true, which is off unless the
 * value is the literal "true". The flag does not authenticate a caller, and
 * it is never read from a request header.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type ScriptCallerAuth =
  | { effect: "allow"; via: "local" | "per-request" | "server-held-opt-in" }
  | { effect: "deny"; reason: "unauthenticated" | "server-held-opt-in-required" };

const LOCAL_CALLER: ScriptCallerAuth = { effect: "allow", via: "local" };

const scriptCallerStore = new AsyncLocalStorage<ScriptCallerAuth>();

/**
 * Bind caller authorization for the current tool-handler turn.
 * Entered from inside the handler (AsyncLocalStorage.run), not at server
 * construction, so it follows that handler on Workers.
 */
export function runWithScriptCaller<T>(auth: ScriptCallerAuth, fn: () => T): T {
  return scriptCallerStore.run(auth, fn);
}

/**
 * Caller authorization for this handler turn.
 *
 * An empty store means the handler was invoked in-process (stdio, or a unit
 * test that calls the domain handler directly). HTTP entrypoints always set
 * the store; they must not rely on this default.
 */
export function getScriptCallerAuth(): ScriptCallerAuth {
  return scriptCallerStore.getStore() ?? LOCAL_CALLER;
}

export function resolveHttpScriptCaller(input: {
  gatewayMode: boolean;
  hasPerRequestCredentials: boolean;
  s2sEnforced: boolean;
  allowServerHeldScriptExecution: boolean;
}): ScriptCallerAuth {
  // Per-request credential pattern: this request presented the NinjaOne
  // client id and secret. That is the caller, whether or not S2S is also on.
  if (input.gatewayMode && input.hasPerRequestCredentials) {
    return { effect: "allow", via: "per-request" };
  }

  // No per-request credentials. S2S is the other authenticated caller this
  // process already knows how to require. Without it, refuse — including
  // when the server-held opt-in flag is set.
  if (!input.s2sEnforced) {
    return { effect: "deny", reason: "unauthenticated" };
  }

  // Gateway mode without per-request credentials must not fall through to
  // the deployment's env credentials. The HTTP layer already rejects that
  // request; if a tool runs anyway, keep script execution closed.
  if (input.gatewayMode) {
    return { effect: "deny", reason: "unauthenticated" };
  }

  if (!input.allowServerHeldScriptExecution) {
    return { effect: "deny", reason: "server-held-opt-in-required" };
  }

  return { effect: "allow", via: "server-held-opt-in" };
}

export function scriptCallerRefusal(
  reason: "unauthenticated" | "server-held-opt-in-required"
): string {
  if (reason === "server-held-opt-in-required") {
    return (
      "Refused -- this HTTP deployment authenticated the caller, but script execution would use server-held credentials. " +
      "That also requires NINJAONE_ALLOW_SERVER_HELD_SCRIPT_EXECUTION=true, which is off by default. " +
      "A client's confirmation response is not authorization, and the script was not run."
    );
  }
  return (
    "Refused -- script execution over HTTP has no authenticated caller. " +
    "Use gateway per-request credentials (X-Ninja-Client-ID and X-Ninja-Client-Secret) or enforce a gateway signature (CONDUIT_S2S_SECRET). " +
    "NINJAONE_ALLOW_SERVER_HELD_SCRIPT_EXECUTION does not authenticate a caller. " +
    "A client's confirmation response is not authorization, and the script was not run."
  );
}
