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
        "ninjaone_tickets_boards_list first.",
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
          },
          organization_id: {
            type: "number",
          },
          device_id: {
            type: "number",
          },
          limit: {
            type: "number",
          },
          cursor: {
            type: "string",
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
      logger.info("API call: tickets.list", {
        status: args.status,
        organizationId: args.organization_id,
        deviceId: args.device_id,
        boardId: args.board_id,
        limit,
        cursor,
      });

      const response = await client.tickets.list({
        status: args.status as TicketStatus | undefined,
        organizationId: args.organization_id as number | undefined,
        deviceId: args.device_id as number | undefined,
        boardId,
        pageSize: limit,
        lastCursorId: cursor !== undefined ? Number(cursor) : undefined,
      });
      logger.debug("API response: tickets.list", { count: response.tickets?.length });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response, null, 2),
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
