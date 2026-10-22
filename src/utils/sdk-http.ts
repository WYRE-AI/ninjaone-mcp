/**
 * Authenticated GET for documented NinjaOne endpoints that
 * @wyre-ai/node-ninjaone does not implement (ticketing discovery, patch
 * reports).
 *
 * Requests go through the SDK client's own HTTP client rather than a second
 * fetch stack, so there stays exactly one OAuth token, one rate limiter and one
 * set of typed error classes per client. Delete this module once node-ninjaone
 * exposes these endpoints (or a public request method) itself.
 */
import type { NinjaOneClient } from "@wyre-ai/node-ninjaone";

export type QueryParams = Record<string, string | number | boolean | undefined>;

interface SdkHttpClient {
  request<T>(path: string, options?: { params?: QueryParams }): Promise<T>;
}

/**
 * The SDK marks `httpClient` TypeScript-private rather than `#private`, so it is
 * an ordinary runtime property. If a future SDK build hides or renames it, fail
 * with a sentence that says what to do instead of a `undefined.request` crash.
 */
function httpClientOf(client: NinjaOneClient): SdkHttpClient {
  const http = (client as unknown as { httpClient?: SdkHttpClient }).httpClient;
  if (!http || typeof http.request !== "function") {
    throw new Error(
      "This build of @wyre-ai/node-ninjaone no longer exposes an internal httpClient, " +
        "so documented endpoints the SDK does not implement (ticketing discovery, " +
        "patch reports) cannot be reached. Add them to @wyre-ai/node-ninjaone and " +
        "call them directly."
    );
  }
  return http;
}

/** GET a documented NinjaOne API path (including the `/api` prefix). */
export async function sdkGet<T>(
  client: NinjaOneClient,
  path: string,
  params?: QueryParams
): Promise<T> {
  return httpClientOf(client).request<T>(path, params ? { params } : undefined);
}
