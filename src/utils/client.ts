/**
 * Lazy-initialized NinjaOne client
 *
 * This module defers *constructing* a NinjaOneClient instance until the
 * first `getClient()` call (single-tenant env mode caches it thereafter;
 * gateway mode constructs one per request via `createClientDirect()`).
 *
 * The SDK is imported statically (not via a dynamic `await import()`):
 * under real concurrent load, a dynamic import of a module that is also
 * `vi.mock()`-intercepted can race and resolve to the real, un-mocked
 * module for one of the concurrent calls — the same flake class hit by
 * ncentral-mcp and connectwise-automate-mcp this week (symptom there:
 * "only 1 of N expected mock instances shows up"; here, both requests
 * silently fell through to the real SDK and made live HTTP calls). A
 * static import always resolves through the mocked binding.
 */
import { NinjaOneClient } from "@wyre-technology/node-ninjaone";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  isValidRegion,
  getBaseUrlForRegion,
  parseScopes,
  CONFIG_PLACEHOLDER,
  type NinjaOneRegion,
  type NinjaOneScope,
} from "./types.js";
import { logger } from "./logger.js";

export interface NinjaOneCredentials {
  clientId: string;
  clientSecret: string;
  region: NinjaOneRegion;
  baseUrl: string;
  /**
   * OAuth scopes to request. Omitted means "not configured" — the SDK's own
   * default (monitoring + management) applies. Set this when the API Services
   * app is granted a narrower set, or the token request 400s.
   */
  scopes?: NinjaOneScope[];
}

let _client: NinjaOneClient | null = null;
let _credentials: NinjaOneCredentials | null = null;

/**
 * Request-scoped credentials for gateway mode. The HTTP/Worker entrypoint wraps
 * each request's handling in runWithCredentials(creds, fn); getCredentials() reads
 * it via .getStore(). Concurrent requests each get their own isolated store frame —
 * there is no shared mutable state left to race on.
 */
const credentialStore = new AsyncLocalStorage<NinjaOneCredentials>();

export function runWithCredentials<T>(creds: NinjaOneCredentials, fn: () => T): T {
  return credentialStore.run(creds, fn);
}

/**
 * Create a fresh NinjaOneClient directly from credentials,
 * bypassing environment variables and the module-level cache.
 */
export async function createClientDirect(
  creds: NinjaOneCredentials
): Promise<NinjaOneClient> {
  return new NinjaOneClient({
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    baseUrl: creds.baseUrl,
    // Passing `undefined` leaves the SDK default intact; passing `[]` would
    // send an empty `scope` parameter, which is a different request.
    ...(creds.scopes ? { scopes: creds.scopes } : {}),
  });
}

/**
 * Get credentials from environment variables (or the request-scoped ALS override)
 */
export function getCredentials(): NinjaOneCredentials | null {
  const scoped = credentialStore.getStore();
  if (scoped) {
    return scoped;
  }

  const clientId = process.env.NINJAONE_CLIENT_ID;
  const clientSecret = process.env.NINJAONE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    logger.warn("Missing credentials", {
      hasClientId: !!clientId,
      hasClientSecret: !!clientSecret,
    });
    return null;
  }

  // Ignore a blank value or an unresolved MCPB config placeholder so an optional,
  // left-blank region falls back to "us" — mirroring the gateway/worker paths that
  // already do `isValidRegion(x) ? x : "us"` instead of failing hard.
  const rawRegion = process.env.NINJAONE_REGION?.trim();
  const regionEnv =
    rawRegion && !CONFIG_PLACEHOLDER.test(rawRegion) ? rawRegion.toLowerCase() : "us";

  if (!isValidRegion(regionEnv)) {
    logger.warn("Invalid region configured, defaulting to us", {
      region: regionEnv,
      valid: ["us", "eu", "oc", "ca", "us2", "fed"],
    });
  }

  const region = isValidRegion(regionEnv) ? regionEnv : "us";
  const baseUrl = getBaseUrlForRegion(region);
  const scopes = parseScopes(process.env.NINJAONE_SCOPES);

  return { clientId, clientSecret, region, baseUrl, scopes };
}

/**
 * Get or create the NinjaOne client (lazy initialization)
 */
export async function getClient(): Promise<NinjaOneClient> {
  const creds = getCredentials();

  if (!creds) {
    throw new Error(
      "No API credentials provided. Please configure NINJAONE_CLIENT_ID, NINJAONE_CLIENT_SECRET, and optionally NINJAONE_REGION (us, eu, oc, ca, us2, fed) environment variables."
    );
  }

  // Gateway (request-scoped) credentials never populate the shared _client /
  // _credentials cache below — doing so would reintroduce a milder version of
  // the same cross-tenant bug for subsequent non-scoped (env-mode) calls.
  const scoped = credentialStore.getStore();
  if (scoped) {
    return createClientDirect(scoped);
  }

  // If credentials changed, invalidate the cached client
  if (
    _client &&
    _credentials &&
    (creds.clientId !== _credentials.clientId ||
      creds.clientSecret !== _credentials.clientSecret ||
      creds.region !== _credentials.region ||
      (creds.scopes ?? []).join(" ") !== (_credentials.scopes ?? []).join(" "))
  ) {
    logger.info("Credentials changed, recreating client");
    _client = null;
  }

  if (!_client) {
    try {
      logger.info("Creating NinjaOne client", {
        region: creds.region,
        baseUrl: creds.baseUrl,
        scopes: creds.scopes ?? "sdk default (monitoring, management)",
      });
      _client = new NinjaOneClient({
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        baseUrl: creds.baseUrl,
        ...(creds.scopes ? { scopes: creds.scopes } : {}),
      });
      _credentials = creds;
    } catch (error) {
      logger.error("Failed to create NinjaOne client", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  return _client;
}

/**
 * Verify the configured credentials can actually acquire a token, by making
 * one cheap authenticated call (organizations, minimal page size — available
 * under every OAuth scope). `checked` is false when no credentials are
 * configured yet — `getClient()` already reports that clearly on the first
 * tool call, so there's nothing to preflight. `error` (with the upstream
 * response body already folded in via `formatToolError`) is only set when
 * the check ran and failed.
 */
export async function preflightAuthCheck(): Promise<{ checked: boolean; error?: string }> {
  if (!getCredentials()) {
    return { checked: false };
  }

  try {
    const client = await getClient();
    await client.organizations.list({ pageSize: 1 });
    return { checked: true };
  } catch (error) {
    return { checked: true, error: formatToolError(error) };
  }
}

/**
 * Render a thrown error as the text a tool call (or the startup preflight
 * check) reports back.
 *
 * The SDK's error classes carry the upstream response body on `.response`, but
 * only `.message` used to be surfaced — so an OAuth failure read as a bare
 * "Failed to acquire token: 400 Bad Request" with no reason attached. The body
 * is where `invalid_scope` lives, and that one word is the whole diagnosis.
 */
export function formatToolError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  const raw = (error as { response?: unknown } | null)?.response;
  const body =
    typeof raw === "string" ? raw : raw != null ? safeStringify(raw) : undefined;

  const parts = [`Error: ${message}`];
  if (body && !message.includes(body)) {
    parts.push(body);
  }

  // An invalid_scope rejection is fully self-inflicted and fully fixable, so
  // say how rather than leaving the operator to infer it from an OAuth code.
  if (body?.includes("invalid_scope")) {
    parts.push(
      "The API Services app does not grant every requested OAuth scope. Set NINJAONE_SCOPES " +
        "to the scopes it actually has (e.g. NINJAONE_SCOPES=monitoring), or grant the missing " +
        "scope in NinjaOne under Administration > Apps > API."
    );
  }

  return parts.join("\n");
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * Clear the cached client (useful for testing)
 */
export function clearClient(): void {
  _client = null;
  _credentials = null;
}