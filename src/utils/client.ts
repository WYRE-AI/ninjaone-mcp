/**
 * Lazy-loaded NinjaOne client
 *
 * This module provides lazy initialization of the NinjaOne client
 * to avoid loading the entire library upfront.
 */

import type { NinjaOneClient } from "@wyre-technology/node-ninjaone";
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

/** Per-request client override — takes priority over the cached singleton */
let _clientOverride: NinjaOneClient | null = null;

/** Per-request credential override — takes priority over env vars */
let _credentialOverrides: NinjaOneCredentials | null = null;

/**
 * Create a fresh NinjaOneClient directly from credentials,
 * bypassing environment variables and the module-level cache.
 */
export async function createClientDirect(
  creds: NinjaOneCredentials
): Promise<NinjaOneClient> {
  const { NinjaOneClient } = await import("@wyre-technology/node-ninjaone");
  return new NinjaOneClient({
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    baseUrl: creds.baseUrl,
  });
}

/**
 * Set a request-scoped client override.
 * While set, getClient() returns this instance instead of the cached one.
 */
export function setClientOverride(client: NinjaOneClient): void {
  _clientOverride = client;
}

/**
 * Clear the request-scoped client override.
 */
export function clearClientOverride(): void {
  _clientOverride = null;
}

/**
 * Set request-scoped credential overrides.
 * While set, getCredentials() returns these instead of reading env vars.
 */
export function setCredentialOverrides(creds: NinjaOneCredentials): void {
  _credentialOverrides = creds;
}

/**
 * Clear request-scoped credential overrides.
 */
export function clearCredentialOverrides(): void {
  _credentialOverrides = null;
}

/**
 * Get credentials from environment variables (or per-request overrides)
 */
export function getCredentials(): NinjaOneCredentials | null {
  if (_credentialOverrides) {
    return _credentialOverrides;
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
  if (_clientOverride) {
    return _clientOverride;
  }

  const creds = getCredentials();

  if (!creds) {
    throw new Error(
      "No API credentials provided. Please configure NINJAONE_CLIENT_ID, NINJAONE_CLIENT_SECRET, and optionally NINJAONE_REGION (us, eu, oc, ca, us2, fed) environment variables."
    );
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
      const { NinjaOneClient } = await import("@wyre-technology/node-ninjaone");
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