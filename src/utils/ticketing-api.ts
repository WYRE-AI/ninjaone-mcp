/**
 * Documented NinjaOne ticketing endpoints that @wyre-ai/node-ninjaone does not
 * implement — plus the one it implements at a path the API does not serve.
 *
 * Every path here is copied verbatim from NinjaOne's published OpenAPI
 * description (`NinjaRMM-API-v2.yaml`, served at
 * https://app.ninjarmm.com/apidocs-beta/NinjaRMM-API-v2.yaml), with the `/api`
 * prefix the SDK applies to every other resource path.
 *
 * Requests go through the SDK client's own HTTP client (see `sdk-http.ts`). This
 * module exists only to cover the SDK's gaps — delete it once node-ninjaone
 * exposes these endpoints itself.
 */
import type { NinjaOneClient } from "@wyre-ai/node-ninjaone";
import { sdkGet, type QueryParams } from "./sdk-http.js";

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

/** GET one of the documented ticketing endpoints listed in `TICKETING_PATHS`. */
export async function ticketingGet<T>(
  client: NinjaOneClient,
  path: TicketingPath,
  params?: QueryParams
): Promise<T> {
  return sdkGet<T>(client, path, params);
}
