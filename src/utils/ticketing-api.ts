/**
 * Documented NinjaOne ticketing endpoints that @wyre-ai/node-ninjaone does not
 * implement — plus the one it implements at a path the API does not serve.
 *
 * Every path here is copied verbatim from NinjaOne's published OpenAPI
 * description (`NinjaRMM-API-v2.yaml`, served at
 * https://app.ninjarmm.com/apidocs-beta/NinjaRMM-API-v2.yaml), with the `/api`
 * prefix the SDK applies to every other resource path.
 *
 * Requests go through the SDK client's own HTTP client rather than a second
 * fetch stack, so there stays exactly one OAuth token, one rate limiter and one
 * set of typed error classes per client. This module exists only to cover the
 * SDK's gaps — delete it once node-ninjaone exposes these endpoints itself.
 */
import type { NinjaOneClient } from "@wyre-ai/node-ninjaone";

export const TICKETING_PATHS = {
  /**
   * `getBoards`. The SDK's `listBoards()` requests the singular
   * `/api/v2/ticketing/trigger/board`, which NinjaOne does not serve — that is
   * the 404 previously blamed on individual tenants.
   */
  boards: "/api/v2/ticketing/trigger/boards",
  /** `getAllStatuses` — the tenant's configured ticket statuses and their IDs. */
  statuses: "/api/v2/ticketing/statuses",
  /** `getTicketAttributes` — ticket custom-field definitions and their IDs. */
  attributes: "/api/v2/ticketing/attributes",
  /** `getContacts_1` — ticketing contacts, with the UID a requester is set by. */
  contacts: "/api/v2/ticketing/contact/contacts",
  /** `getAllUserAndContacts` — technicians, end users and contacts. */
  users: "/api/v2/ticketing/app-user-contact",
} as const;

export type TicketingPath = (typeof TICKETING_PATHS)[keyof typeof TICKETING_PATHS];

type QueryParams = Record<string, string | number | boolean | undefined>;

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
        "so the documented ticketing endpoints the SDK does not implement (boards, " +
        "statuses, attributes, contacts, users) cannot be reached. Add them to " +
        "@wyre-ai/node-ninjaone and call them directly."
    );
  }
  return http;
}

/** GET one of the documented ticketing endpoints listed in `TICKETING_PATHS`. */
export async function ticketingGet<T>(
  client: NinjaOneClient,
  path: TicketingPath,
  params?: QueryParams
): Promise<T> {
  return httpClientOf(client).request<T>(path, params ? { params } : undefined);
}
