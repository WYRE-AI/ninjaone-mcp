/**
 * Tickets domain handler
 *
 * Provides tools for ticket operations in NinjaOne.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { DomainHandler, CallToolResult } from "../utils/types.js";
import type { TicketStatus, TicketPriority, TicketType } from "@wyre-technology/node-ninjaone";
import { getClient } from "../utils/client.js";
import { logger } from "../utils/logger.js";

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
              "Ticket board to query. Use ninjaone_tickets_boards_list to discover valid IDs; " +
              "if that endpoint is unavailable on your tenant, read the ID from the board's URL " +
              "in the NinjaOne web UI.",
          },
          status: {
            type: "string",
            enum: ["OPEN", "IN_PROGRESS", "WAITING", "CLOSED"],
            description:
              "Filter by status, matched client-side against each ticket's status display name. " +
              "Custom board statuses whose names differ from these values won't match.",
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
      description: "Create new ticket",
      inputSchema: {
        type: "object" as const,
        properties: {
          subject: {
            type: "string",
          },
          description: {
            type: "string",
          },
          organization_id: {
            type: "number",
          },
          device_id: {
            type: "number",
          },
          board_id: {
            type: "number",
          },
          priority: {
            type: "string",
            enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
          },
          type: {
            type: "string",
            enum: ["PROBLEM", "QUESTION", "INCIDENT", "TASK"],
          },
        },
        required: ["subject", "organization_id"],
      },
    },
    {
      name: "ninjaone_tickets_update",
      description: "Update existing ticket",
      inputSchema: {
        type: "object" as const,
        properties: {
          ticket_id: {
            type: "number",
          },
          subject: {
            type: "string",
          },
          description: {
            type: "string",
          },
          status: {
            type: "string",
            enum: ["OPEN", "IN_PROGRESS", "WAITING", "CLOSED"],
          },
          priority: {
            type: "string",
            enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
          },
          assignee_id: {
            type: "number",
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
      description: "Get ticket comments and activity",
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
      name: "ninjaone_tickets_boards_list",
      description:
        "List available ticket boards for the tenant. Use this to discover board_id values for ninjaone_tickets_list.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
  ];
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
        return {
          content: [
            {
              type: "text",
              text:
                "board_id is required: NinjaOne queries tickets per board, and board IDs " +
                "vary by tenant — board 1 is not guaranteed to be the 'All Tickets' board, " +
                "so guessing a default can silently return the wrong board's tickets. " +
                "Call ninjaone_tickets_boards_list to discover board IDs; if that endpoint " +
                "returns 404 on your tenant, read the ID from the board's URL in the " +
                "NinjaOne web UI (e.g. the 'All tickets' sidebar link).",
            },
          ],
          isError: true,
        };
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
        return {
          content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        };
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

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
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
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case "ninjaone_tickets_get": {
      const ticketId = args.ticket_id as number;
      logger.info("API call: tickets.get", { ticketId });
      const ticket = await client.tickets.get(ticketId);
      logger.debug("API response: tickets.get", { ticket });

      return {
        content: [{ type: "text", text: JSON.stringify(ticket, null, 2) }],
      };
    }

    case "ninjaone_tickets_create": {
      logger.info("API call: tickets.create", { subject: args.subject, organizationId: args.organization_id });
      const ticket = await client.tickets.create({
        subject: args.subject as string,
        description: args.description as string | undefined,
        organizationId: args.organization_id as number,
        deviceId: args.device_id as number | undefined,
        priority: args.priority as TicketPriority | undefined,
        type: args.type as TicketType | undefined,
      });
      logger.debug("API response: tickets.create", { ticket });

      return {
        content: [{ type: "text", text: JSON.stringify(ticket, null, 2) }],
      };
    }

    case "ninjaone_tickets_update": {
      const ticketId = args.ticket_id as number;
      logger.info("API call: tickets.update", { ticketId });
      const ticket = await client.tickets.update(ticketId, {
        subject: args.subject as string | undefined,
        description: args.description as string | undefined,
        status: args.status as TicketStatus | undefined,
        priority: args.priority as TicketPriority | undefined,
        assigneeUid: args.assignee_id ? String(args.assignee_id) : undefined,
      });
      logger.debug("API response: tickets.update", { ticket });

      return {
        content: [{ type: "text", text: JSON.stringify(ticket, null, 2) }],
      };
    }

    case "ninjaone_tickets_add_comment": {
      const ticketId = args.ticket_id as number;
      logger.info("API call: tickets.addComment", { ticketId });
      const comment = await client.tickets.addComment(ticketId, {
        body: args.body as string,
        internal: args.public === false,
      });
      logger.debug("API response: tickets.addComment", { comment });

      return {
        content: [{ type: "text", text: JSON.stringify(comment, null, 2) }],
      };
    }

    case "ninjaone_tickets_comments": {
      const ticketId = args.ticket_id as number;
      logger.info("API call: tickets.getComments", { ticketId });
      const comments = await client.tickets.getComments(ticketId);
      logger.debug("API response: tickets.getComments", { comments });

      return {
        content: [{ type: "text", text: JSON.stringify(comments, null, 2) }],
      };
    }

    case "ninjaone_tickets_boards_list": {
      logger.info("API call: tickets.listBoards");
      let boards: unknown[];
      try {
        boards = await client.tickets.listBoards();
      } catch (error) {
        // Some tenants 404 on GET /api/v2/ticketing/trigger/board, leaving no
        // API path to discover board IDs — point the caller at the web UI
        // instead of surfacing a bare "Resource not found".
        const status = (error as { status?: number }).status;
        if (status === 404) {
          return {
            content: [
              {
                type: "text",
                text:
                  "The board listing endpoint (GET /api/v2/ticketing/trigger/board) returned " +
                  "404 — some NinjaOne tenants do not expose it. To find a board_id for " +
                  "ninjaone_tickets_list, open Ticketing in the NinjaOne web UI and read the " +
                  "numeric ID from the board link's URL (e.g. the 'All tickets' sidebar link).",
              },
            ],
            isError: true,
          };
        }
        throw error;
      }
      logger.debug("API response: tickets.listBoards", { count: boards.length });

      return {
        content: [{ type: "text", text: JSON.stringify(boards, null, 2) }],
      };
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown ticket tool: ${toolName}` }],
        isError: true,
      };
  }
}

export const ticketsHandler: DomainHandler = {
  getTools,
  handleCall,
};
