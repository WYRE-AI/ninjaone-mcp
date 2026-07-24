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
import { isValidRegion, getBaseUrlForRegion, type NinjaOneRegion } from "./types.js";
import { logger } from "./logger.js";

export interface NinjaOneCredentials {
  clientId: string;
  clientSecret: string;
  region: NinjaOneRegion;
  baseUrl: string;
}

/**
 * Matches an unresolved MCPB/DXT config placeholder, e.g. "${user_config.ninjaone_region}".
 * When an optional user_config field is left blank, Claude Desktop injects the literal
 * placeholder string (not empty, not omitted) into the env var. Treat it as unset.
 */
const CONFIG_PLACEHOLDER = /^\$\{.*\}$/;

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

  return { clientId, clientSecret, region, baseUrl };
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
      creds.region !== _credentials.region)
  ) {
    logger.info("Credentials changed, recreating client");
    _client = null;
  }

  if (!_client) {
    try {
      logger.info("Creating NinjaOne client", { region: creds.region, baseUrl: creds.baseUrl });
      _client = new NinjaOneClient({
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        baseUrl: creds.baseUrl,
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
 * Clear the cached client (useful for testing)
 */
export function clearClient(): void {
  _client = null;
  _credentials = null;
}