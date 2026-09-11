/**
 * Tickets domain handler
 *
 * Provides tools for ticket operations in NinjaOne.
 *
 * Field names, enum values and paths here follow NinjaOne's published OpenAPI
 * description (`NinjaRMM-API-v2.yaml`) rather than @wyre-ai/node-ninjaone's
 * request types, which predate parts of that schema. See `ticketing-api.ts`.
 */
import type { Tool } from "@modelcontextprotocol/server";
import type { DomainHandler, CallToolResult } from "../utils/types.js";
import type {
  NinjaOneClient,
  TicketCreateData,
  TicketUpdateData,
} from "@wyre-ai/node-ninjaone";
import { getClient } from "../utils/client.js";
import { logger } from "../utils/logger.js";
import { TICKETING_PATHS, ticketingGet } from "../utils/ticketing-api.js";

/** Documented ticket types (`NewTicket.type` / `UpdateTicket.type`). */
const TICKET_TYPES = [
  "PROBLEM",
  "QUESTION",
  "INCIDENT",
  "TASK",
  "CHANGE_REQUEST",
  "SERVICE_REQUEST",
  "PROJECT",
  "APPOINTMENT",
  "MISCELLANEOUS",
] as const;

/**
 * Documented ticket priorities. NinjaOne has no CRITICAL *priority* — CRITICAL
 * is a `severity` value, and sending it as a priority is rejected.
 */
const TICKET_PRIORITIES = ["NONE", "LOW", "MEDIUM", "HIGH"] as const;

/** Documented ticket severities. */
const TICKET_SEVERITIES = ["NONE", "MINOR", "MODERATE", "MAJOR", "CRITICAL"] as const;

/** Documented `type` filter values for GET .../ticket/{id}/log-entry. */
const LOG_ENTRY_TYPES = [
  "DESCRIPTION",
  "COMMENT",
  "CONDITION",
  "SAVE",
  "DELETE",
  "PRODUCT",
  "INFO",
] as const;

type TicketTypeName = (typeof TICKET_TYPES)[number];
type TicketPriorityName = (typeof TICKET_PRIORITIES)[number];
type TicketSeverityName = (typeof TICKET_SEVERITIES)[number];

/** A `TicketingAttributeValue`: custom-field values are an array, not a map. */
interface TicketAttributeValue {
  attributeId: number;
  value: string;
}

/**
 * `NewTicket` / `UpdateTicket` request body, spelled as NinjaOne documents it.
 *
 * The SDK forwards its `data` argument to the API verbatim but types it with
 * older field names — `organizationId` where NinjaOne requires `clientId`,
 * `description` as a plain string where NinjaOne requires a log entry, and no
 * `assignedAppUserId` or `requesterUid` at all. So the body is built here and
 * handed over as-is.
 */
interface TicketBody {
  clientId?: number;
  ticketFormId?: number;
  subject?: string;
  status?: string;
  description?: { public: boolean; body: string };
  type?: TicketTypeName;
  priority?: TicketPriorityName;
  severity?: TicketSeverityName;
  nodeId?: number;
  locationId?: number;
  requesterUid?: string;
  assignedAppUserId?: number;
  tags?: string[];
  attributes?: TicketAttributeValue[];
  version?: number;
}

/**
 * Extract the ticket rows from an SDK board-run response, which may arrive as a
 * bare array, `{ tickets: [...] }`, or the raw `{ data: [...], metadata }` board
 * envelope depending on what NinjaOne returns for the tenant.
 */
function extractTickets(response: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(response)) return response as Array<Record<string, unknown>>;
  const r = (response ?? {}) as { tickets?: unknown; data?: unknown };
  if (Array.isArray(r.tickets)) return r.tickets as Array<Record<string, unknown>>;
  if (Array.isArray(r.data)) return r.data as Array<Record<string, unknown>>;
  return [];
}

/** Collapse status labels for comparison: "IN_PROGRESS" and "In Progress" → "inprogress". */
function normalizeStatus(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Client-side ticket filter. NinjaOne's board-run endpoint does not reliably
 * support server-side filtering by status, client, or device — sending those
 * filters throws a generic 400 (issues #60, #61) — so matching happens here.
 *
 * Board rows carry `status` as an object ({ statusId, displayName }), the client
 * as `clientId`, and the device as `nodeId`; the single-ticket endpoint uses a
 * plain status string and `organizationId`/`deviceId`, so all shapes are checked.
 */
function ticketMatchesFilters(
  ticket: Record<string, unknown>,
  status: string | undefined,
  organizationId: number | undefined,
  deviceId: number | undefined
): boolean {
  if (status !== undefined) {
    const s = ticket.status as { displayName?: string; name?: string } | string | undefined;
    const label = typeof s === "string" ? s : (s?.displayName ?? s?.name ?? "");
    if (normalizeStatus(label) !== normalizeStatus(status)) return false;
  }
  if (organizationId !== undefined) {
    const org = ticket.clientId ?? ticket.organizationId;
    if (org !== organizationId) return false;
  }
  if (deviceId !== undefined) {
    const node = ticket.nodeId ?? ticket.deviceId;
    if (node !== deviceId) return false;
  }
  return true;
}

/** Next-page cursor for board-run pagination: the API's metadata cursor, else the max row id. */
function ticketPageCursor(
  response: unknown,
  tickets: Array<Record<string, unknown>>
): number {
  const meta = (response as { metadata?: { lastCursorId?: unknown } } | null)?.metadata;
  if (meta && typeof meta.lastCursorId === "number") return meta.lastCursorId;
  const ids = tickets.map((t) => Number(t.id)).filter((n) => Number.isFinite(n));
  return ids.length ? Math.max(...ids) : 0;
}

/** Render a value as the single JSON text block every ticket tool returns. */
function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Drop undefined entries so a partial update never sends `"field": null`. */
function compact(body: TicketBody): TicketBody {
  return Object.fromEntries(
    Object.entries(body).filter(([, v]) => v !== undefined)
  ) as TicketBody;
}

/**
 * Get ticket domain tools
 */
function getTools(): Tool[] {
  return [
    {
      name: "ninjaone_tickets_list",
      description:
        "List tickets from a ticket board, filterable by status, organization, or device. " +
        "Requires board_id: NinjaOne queries tickets per board and board IDs vary by tenant " +
        "(board 1 is NOT always the 'All Tickets' board). Discover board IDs with " +
        "ninjaone_tickets_boards_list first. NOTE: status/organization/device filters are " +
        "applied client-side within one board page (NinjaOne's board API cannot filter by " +
        "them server-side), so the response reports `count` (matches in this page) separately " +
        "from `scanned`, plus `hasMore`/`cursor` — page through until hasMore is false to get " +
        "every match; never treat one page's count as a board-wide total.",
      inputSchema: {
        type: "object" as const,
        properties: {
          board_id: {
            type: "number",
            description:
              "Ticket board to query. Use ninjaone_tickets_boards_list to discover valid IDs.",
          },
          status: {
            type: "string",
            description:
              "Filter by status, matched client-side against each ticket's status display " +
              "name. Statuses are configured per tenant — use ninjaone_tickets_statuses_list " +
              "to see the real names rather than guessing.",
          },
          organization_id: {
            type: "number",
            description: "Filter by organization (ticket clientId), matched client-side.",
          },
          device_id: {
            type: "number",
            description: "Filter by linked device (ticket nodeId), matched client-side.",
          },
          limit: {
            type: "number",
            description:
              "Board page size (default 50). A full page sets hasMore=true and returns a cursor.",
          },
          cursor: {
            type: "string",
            description:
              "Pagination cursor from a previous response's cursor field (the board's lastCursorId).",
          },
        },
        required: ["board_id"],
      },
    },
    {
      name: "ninjaone_tickets_get",
      description: "Get ticket details by ID",
      inputSchema: {
        type: "object" as const,
        properties: {
          ticket_id: {
            type: "number",
          },
        },
        required: ["ticket_id"],
      },
    },
    {
      name: "ninjaone_tickets_create",
      description:
        "Create a new ticket. NinjaOne requires a ticket form, so call " +
        "ninjaone_tickets_forms_list first and pass its id as ticket_form_id.",
      inputSchema: {
        type: "object" as const,
        properties: {
          subject: {
            type: "string",
            description: "Ticket subject (max 200 characters).",
          },
          description: {
            type: "string",
            description:
              "Initial description, stored as the ticket's first log entry. " +
              "Set description_public=false to keep it internal.",
          },
          description_public: {
            type: "boolean",
            description: "Whether the description is visible to the requester (default: true).",
          },
          organization_id: {
            type: "number",
            description: "Organization the ticket belongs to (sent as clientId).",
          },
          ticket_form_id: {
            type: "number",
            description:
              "Ticket form to create against. Required by NinjaOne — discover IDs with " +
              "ninjaone_tickets_forms_list.",
          },
          device_id: {
            type: "number",
            description: "Link the ticket to a device (sent as nodeId).",
          },
          location_id: { type: "number" },
          status: {
            type: "string",
            description:
              "Status ID to open the ticket in. Statuses are per-tenant — use " +
              "ninjaone_tickets_statuses_list. Defaults to 1000 (New).",
          },
          priority: {
            type: "string",
            enum: [...TICKET_PRIORITIES],
            description: "Ticket priority. CRITICAL is a severity, not a priority.",
          },
          severity: {
            type: "string",
            enum: [...TICKET_SEVERITIES],
          },
          type: {
            type: "string",
            enum: [...TICKET_TYPES],
          },
          requester_uid: {
            type: "string",
            description:
              "UUID of the requesting contact. Discover with ninjaone_tickets_contacts_list.",
          },
          assignee_id: {
            type: "number",
            description:
              "Technician to assign (sent as assignedAppUserId). Discover with " +
              "ninjaone_tickets_users_list.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
          },
          attributes: {
            type: "array",
            description:
              "Custom field values. Discover attribute IDs with ninjaone_tickets_attributes_list.",
            items: {
              type: "object",
              properties: {
                attributeId: { type: "number" },
                value: { type: "string" },
              },
              required: ["attributeId", "value"],
            },
          },
        },
        required: ["subject", "organization_id", "ticket_form_id"],
      },
    },
    {
      name: "ninjaone_tickets_update",
      description:
        "Update an existing ticket's fields. NinjaOne's ticket PUT is a full replace and may " +
        "reject a partial body — if it does, read the ticket with ninjaone_tickets_get and " +
        "resend its subject, status, organization_id, ticket_form_id, requester_uid and " +
        "version alongside your changes. It does not accept comments: use " +
        "ninjaone_tickets_add_comment for those.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ticket_id: {
            type: "number",
          },
          subject: {
            type: "string",
          },
          status: {
            type: "string",
            description:
              "Status ID. Statuses are per-tenant — use ninjaone_tickets_statuses_list.",
          },
          priority: {
            type: "string",
            enum: [...TICKET_PRIORITIES],
            description: "Ticket priority. CRITICAL is a severity, not a priority.",
          },
          severity: {
            type: "string",
            enum: [...TICKET_SEVERITIES],
          },
          type: {
            type: "string",
            enum: [...TICKET_TYPES],
          },
          assignee_id: {
            type: "number",
            description:
              "Technician to assign (sent as assignedAppUserId). Discover with " +
              "ninjaone_tickets_users_list.",
          },
          requester_uid: { type: "string" },
          organization_id: {
            type: "number",
            description: "Sent as clientId; required when NinjaOne rejects a partial update.",
          },
          ticket_form_id: { type: "number" },
          location_id: { type: "number" },
          version: {
            type: "number",
            description: "Ticket version from ninjaone_tickets_get, for optimistic locking.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
          },
          attributes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                attributeId: { type: "number" },
                value: { type: "string" },
              },
              required: ["attributeId", "value"],
            },
          },
        },
        required: ["ticket_id"],
      },
    },
    {
      name: "ninjaone_tickets_add_comment",
      description: "Add comment to ticket",
      inputSchema: {
        type: "object" as const,
        properties: {
          ticket_id: {
            type: "number",
          },
          body: {
            type: "string",
          },
          public: {
            type: "boolean",
            description: "visible to customers (default: true)",
          },
        },
        required: ["ticket_id", "body"],
      },
    },
    {
      name: "ninjaone_tickets_comments",
      description:
        "Get a ticket's log entries (comments and activity). Pass type to narrow the feed, " +
        "e.g. type=COMMENT for just the conversation.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ticket_id: {
            type: "number",
          },
          type: {
            type: "string",
            enum: [...LOG_ENTRY_TYPES],
            description: "Return only log entries of this type.",
          },
        },
        required: ["ticket_id"],
      },
    },
    {
      name: "ninjaone_tickets_boards_list",
      description:
        "List available ticket boards for the tenant. Use this to discover board_id values for ninjaone_tickets_list.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "ninjaone_tickets_forms_list",
      description:
        "List ticket forms with their fields. Every ticket is created against a form, so " +
        "use this to find the ticket_form_id for ninjaone_tickets_create.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "ninjaone_tickets_form_get",
      description: "Get one ticket form, including its field definitions.",
      inputSchema: {
        type: "object" as const,
        properties: {
          form_id: { type: "number" },
        },
        required: ["form_id"],
      },
    },
    {
      name: "ninjaone_tickets_statuses_list",
      description:
        "List the tenant's configured ticket statuses with their IDs. Statuses are per-tenant, " +
        "so read them here rather than assuming names like OPEN or CLOSED.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "ninjaone_tickets_attributes_list",
      description:
        "List ticket attribute (custom field) definitions and their IDs, for the attributes " +
        "argument of ninjaone_tickets_create and ninjaone_tickets_update.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "ninjaone_tickets_contacts_list",
      description:
        "List ticketing contacts. Each carries the uid used as a ticket's requester_uid.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "ninjaone_tickets_users_list",
      description:
        "List ticketing users — technicians, end users and contacts. Use this to find the " +
        "assignee_id (a technician's numeric id) for ninjaone_tickets_create/update.",
      inputSchema: {
        type: "object" as const,
        properties: {
          user_type: {
            type: "string",
            enum: ["TECHNICIAN", "END_USER", "CONTACT"],
          },
          organization_id: {
            type: "number",
            description: "Restrict to one organization (sent as clientId).",
          },
          search: {
            type: "string",
            description: "Match on first name, last name or email address.",
          },
          limit: {
            type: "number",
            description: "Records per page (default 50).",
          },
          cursor: {
            type: "number",
            description: "anchorNaturalId of the last user from the previous page.",
          },
        },
      },
    },
  ];
}

/** Build the documented create/update body from tool arguments. */
function ticketBodyFromArgs(args: Record<string, unknown>): TicketBody {
  const description = args.description as string | undefined;
  return compact({
    subject: args.subject as string | undefined,
    clientId: args.organization_id as number | undefined,
    ticketFormId: args.ticket_form_id as number | undefined,
    nodeId: args.device_id as number | undefined,
    locationId: args.location_id as number | undefined,
    status: args.status as string | undefined,
    priority: args.priority as TicketPriorityName | undefined,
    severity: args.severity as TicketSeverityName | undefined,
    type: args.type as TicketTypeName | undefined,
    requesterUid: args.requester_uid as string | undefined,
    assignedAppUserId: args.assignee_id as number | undefined,
    tags: args.tags as string[] | undefined,
    attributes: args.attributes as TicketAttributeValue[] | undefined,
    version: args.version as number | undefined,
    description:
      description !== undefined
        ? { public: args.description_public !== false, body: description }
        : undefined,
  });
}

/** Read a documented ticketing endpoint the SDK does not implement. */
async function readTicketing(
  client: NinjaOneClient,
  name: keyof typeof TICKETING_PATHS,
  params?: Record<string, string | number | boolean | undefined>
): Promise<CallToolResult> {
  logger.info(`API call: ticketing ${name}`, { path: TICKETING_PATHS[name], params });
  const data = await ticketingGet<unknown>(client, TICKETING_PATHS[name], params);
  logger.debug(`API response: ticketing ${name}`, {
    count: Array.isArray(data) ? data.length : undefined,
  });
  return jsonResult(data);
}

/**
 * Handle a ticket domain tool call
 */
async function handleCall(
  toolName: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const client = await getClient();

  switch (toolName) {
    case "ninjaone_tickets_list": {
      // Board IDs are tenant-specific; guessing one (the SDK used to default to
      // board 1) silently returns the wrong board's tickets on multi-board
      // tenants, so refuse to run without an explicit board_id.
      const boardId = args.board_id;
      if (typeof boardId !== "number" || !Number.isFinite(boardId)) {
        return errorResult(
          "board_id is required: NinjaOne queries tickets per board, and board IDs " +
            "vary by tenant — board 1 is not guaranteed to be the 'All Tickets' board, " +
            "so guessing a default can silently return the wrong board's tickets. " +
            "Call ninjaone_tickets_boards_list to discover board IDs."
        );
      }

      const limit = (args.limit as number) || 50;
      const cursor = args.cursor as string | undefined;
      const statusFilter = args.status as string | undefined;
      const organizationId = args.organization_id as number | undefined;
      const deviceId = args.device_id as number | undefined;
      const filtersActive =
        statusFilter !== undefined ||
        organizationId !== undefined ||
        deviceId !== undefined;

      logger.info("API call: tickets.list", {
        status: statusFilter,
        organizationId,
        deviceId,
        boardId,
        limit,
        cursor,
        clientSideFilter: filtersActive,
      });

      // NinjaOne's board-run endpoint (POST .../board/{id}/run) does not reliably
      // support server-side filtering by status, client, or device — passing those
      // filters throws a generic "Bad request" that is indistinguishable from an
      // auth failure, and in the wild that silently masqueraded as "zero matching
      // tickets" (issues #60, #61). So never send them to the API: fetch the board
      // page and filter in code, exactly as NinjaOne's own integrations do.
      const response = await client.tickets.list({
        boardId,
        pageSize: limit,
        lastCursorId: cursor !== undefined ? Number(cursor) : undefined,
      });

      if (!filtersActive) {
        // No filter requested → return the board page unchanged.
        logger.debug("API response: tickets.list", {
          count: extractTickets(response).length,
        });
        return jsonResult(response);
      }

      const rawTickets = extractTickets(response);
      const tickets = rawTickets.filter((t) =>
        ticketMatchesFilters(t, statusFilter, organizationId, deviceId)
      );
      // A page exactly the size of the limit means the board almost certainly has
      // more tickets, so surface it — otherwise a caller (or an LLM) mistakes one
      // page's matches for the board-wide total, the exact failure behind #61.
      const hasMore = rawTickets.length === limit;
      const nextCursor = hasMore
        ? String(ticketPageCursor(response, rawTickets))
        : undefined;
      logger.debug("API response: tickets.list", {
        scanned: rawTickets.length,
        matched: tickets.length,
        hasMore,
      });

      return jsonResult({
        tickets,
        count: tickets.length,
        scanned: rawTickets.length,
        hasMore,
        cursor: nextCursor,
        filter: { status: statusFilter, organizationId, deviceId },
        note:
          "Tickets are filtered client-side within a single board page — " +
          "NinjaOne's board API cannot filter by status/organization/device " +
          "server-side. `count` is the matches in THIS page only, not a " +
          "board-wide total. When `hasMore` is true, pass `cursor` back to " +
          "scan the next page, and keep going until `hasMore` is false to " +
          "see every match.",
      });
    }

    case "ninjaone_tickets_get": {
      const ticketId = args.ticket_id as number;
      logger.info("API call: tickets.get", { ticketId });
      const ticket = await client.tickets.get(ticketId);
      logger.debug("API response: tickets.get", { ticket });

      return jsonResult(ticket);
    }

    case "ninjaone_tickets_create": {
      const body = ticketBodyFromArgs(args);
      logger.info("API call: tickets.create", {
        subject: body.subject,
        clientId: body.clientId,
        ticketFormId: body.ticketFormId,
      });
      const ticket = await client.tickets.create(body as unknown as TicketCreateData);
      logger.debug("API response: tickets.create", { ticket });

      return jsonResult(ticket);
    }

    case "ninjaone_tickets_update": {
      const ticketId = args.ticket_id as number;
      // `UpdateTicket` has no description field — the PUT "does not accept
      // comments" — so a description never reaches the update body.
      const { description: _ignored, ...body } = ticketBodyFromArgs(args);
      logger.info("API call: tickets.update", { ticketId });
      const ticket = await client.tickets.update(
        ticketId,
        body as unknown as TicketUpdateData
      );
      logger.debug("API response: tickets.update", { ticket });

      return jsonResult(ticket);
    }

    case "ninjaone_tickets_add_comment": {
      const ticketId = args.ticket_id as number;
      logger.info("API call: tickets.addComment", { ticketId });
      const comment = await client.tickets.addComment(ticketId, {
        body: args.body as string,
        internal: args.public === false,
      });
      logger.debug("API response: tickets.addComment", { comment });

      return jsonResult(comment);
    }

    case "ninjaone_tickets_comments": {
      const ticketId = args.ticket_id as number;
      const type = args.type as string | undefined;
      logger.info("API call: tickets.getComments", { ticketId, type });
      const comments = await client.tickets.getComments(ticketId, type);
      logger.debug("API response: tickets.getComments", { comments });

      return jsonResult(comments);
    }

    case "ninjaone_tickets_boards_list":
      return readTicketing(client, "boards");

    case "ninjaone_tickets_statuses_list":
      return readTicketing(client, "statuses");

    case "ninjaone_tickets_attributes_list":
      return readTicketing(client, "attributes");

    case "ninjaone_tickets_contacts_list":
      return readTicketing(client, "contacts");

    case "ninjaone_tickets_users_list":
      return readTicketing(client, "users", {
        userType: args.user_type as string | undefined,
        clientId: args.organization_id as number | undefined,
        searchCriteria: args.search as string | undefined,
        pageSize: args.limit as number | undefined,
        anchorNaturalId: args.cursor as number | undefined,
      });

    case "ninjaone_tickets_forms_list": {
      logger.info("API call: tickets.listForms");
      const forms = await client.tickets.listForms();
      logger.debug("API response: tickets.listForms", { count: forms.length });

      return jsonResult(forms);
    }

    case "ninjaone_tickets_form_get": {
      const formId = args.form_id as number;
      logger.info("API call: tickets.getForm", { formId });
      const form = await client.tickets.getForm(formId);
      logger.debug("API response: tickets.getForm", { form });

      return jsonResult(form);
    }

    default:
      return errorResult(`Unknown ticket tool: ${toolName}`);
  }
}

export const ticketsHandler: DomainHandler = {
  getTools,
  handleCall,
};
