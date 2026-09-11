/**
 * Tests for tickets domain handler
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Create mock functions using vi.hoisted
const {
  mockTicketsList,
  mockTicketsGet,
  mockTicketsCreate,
  mockTicketsUpdate,
  mockTicketsAddComment,
  mockTicketsGetComments,
  mockTicketsListBoards,
  mockTicketsListForms,
  mockTicketsGetForm,
  mockHttpRequest,
  mockClient,
} = vi.hoisted(() => {
  const mockTicketsList = vi.fn();
  const mockTicketsGet = vi.fn();
  const mockTicketsCreate = vi.fn();
  const mockTicketsUpdate = vi.fn();
  const mockTicketsAddComment = vi.fn();
  const mockTicketsGetComments = vi.fn();
  const mockTicketsListBoards = vi.fn();
  const mockTicketsListForms = vi.fn();
  const mockTicketsGetForm = vi.fn();
  const mockHttpRequest = vi.fn();

  const mockClient = {
    tickets: {
      list: mockTicketsList,
      get: mockTicketsGet,
      create: mockTicketsCreate,
      update: mockTicketsUpdate,
      addComment: mockTicketsAddComment,
      getComments: mockTicketsGetComments,
      listBoards: mockTicketsListBoards,
      listForms: mockTicketsListForms,
      getForm: mockTicketsGetForm,
    },
    // The SDK marks httpClient TypeScript-private, not #private, so the
    // documented endpoints it does not implement are reached through it.
    httpClient: { request: mockHttpRequest },
  };

  return {
    mockTicketsList,
    mockTicketsGet,
    mockTicketsCreate,
    mockTicketsUpdate,
    mockTicketsAddComment,
    mockTicketsGetComments,
    mockTicketsListBoards,
    mockTicketsListForms,
    mockTicketsGetForm,
    mockHttpRequest,
    mockClient,
  };
});

// Mock the client module before importing the handler
vi.mock("../../utils/client.js", () => ({
  getClient: () => Promise.resolve(mockClient),
  clearClient: vi.fn(),
  getCredentials: () => ({
    clientId: "test",
    clientSecret: "test",
    region: "us",
    baseUrl: "https://app.ninjarmm.com",
  }),
}));

// Import handler after mocking
import { ticketsHandler } from "../../domains/tickets.js";
import { TICKETING_PATHS, ticketingGet } from "../../utils/ticketing-api.js";

describe("Tickets Domain Handler", () => {
  beforeEach(() => {
    // Clear call history
    mockTicketsList.mockClear();
    mockTicketsGet.mockClear();
    mockTicketsCreate.mockClear();
    mockTicketsUpdate.mockClear();
    mockTicketsAddComment.mockClear();
    mockTicketsGetComments.mockClear();
    mockTicketsListBoards.mockClear();
    mockTicketsListForms.mockClear();
    mockTicketsGetForm.mockClear();
    mockHttpRequest.mockClear();

    // Reset mock implementations - list returns TicketListResponse
    mockTicketsList.mockResolvedValue({
      tickets: [
        { id: 1, subject: "Ticket 1", status: "OPEN" },
        { id: 2, subject: "Ticket 2", status: "IN_PROGRESS" },
      ],
      cursor: "next-page",
    });
    mockTicketsGet.mockResolvedValue({
      id: 1,
      subject: "Ticket 1",
      description: "Test ticket",
      status: "OPEN",
    });
    mockTicketsCreate.mockResolvedValue({
      id: 100,
      subject: "New Ticket",
      status: "OPEN",
    });
    mockTicketsUpdate.mockResolvedValue({
      id: 1,
      subject: "Updated Ticket",
      status: "IN_PROGRESS",
    });
    mockTicketsAddComment.mockResolvedValue({
      id: 50,
      ticketId: 1,
      body: "Test comment",
    });
    mockTicketsGetComments.mockResolvedValue([
      { id: 1, body: "Comment 1" },
      { id: 2, body: "Comment 2" },
    ]);
    mockTicketsListBoards.mockResolvedValue([
      { id: 1, name: "All Tickets" },
      { id: 2, name: "Service Desk" },
    ]);
    mockTicketsListForms.mockResolvedValue([
      { id: 1, name: "Default Form" },
      { id: 2, name: "Onboarding" },
    ]);
    mockTicketsGetForm.mockResolvedValue({ id: 1, name: "Default Form", fields: [] });
    mockHttpRequest.mockResolvedValue([
      { id: 1, name: "All Tickets" },
      { id: 2, name: "Service Desk" },
    ]);
  });

  describe("getTools", () => {
    it("should return all ticket tools", () => {
      const tools = ticketsHandler.getTools();

      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toEqual([
        "ninjaone_tickets_list",
        "ninjaone_tickets_get",
        "ninjaone_tickets_create",
        "ninjaone_tickets_update",
        "ninjaone_tickets_add_comment",
        "ninjaone_tickets_comments",
        "ninjaone_tickets_boards_list",
        "ninjaone_tickets_forms_list",
        "ninjaone_tickets_form_get",
        "ninjaone_tickets_statuses_list",
        "ninjaone_tickets_attributes_list",
        "ninjaone_tickets_contacts_list",
        "ninjaone_tickets_users_list",
      ]);
    });

    it("ninjaone_tickets_list should require board_id", () => {
      const tools = ticketsHandler.getTools();
      const listTool = tools.find((t) => t.name === "ninjaone_tickets_list");

      expect(listTool).toBeDefined();
      expect(listTool?.inputSchema.required).toContain("board_id");
    });

    it("ninjaone_tickets_get should require ticket_id", () => {
      const tools = ticketsHandler.getTools();
      const getTool = tools.find((t) => t.name === "ninjaone_tickets_get");

      expect(getTool).toBeDefined();
      expect(getTool?.inputSchema.required).toContain("ticket_id");
    });

    it("ninjaone_tickets_create should require subject, organization_id and ticket_form_id", () => {
      // NewTicket requires clientId, status, subject and ticketFormId; status
      // has a documented default of "1000", the other three do not.
      const tools = ticketsHandler.getTools();
      const createTool = tools.find((t) => t.name === "ninjaone_tickets_create");

      expect(createTool).toBeDefined();
      expect(createTool?.inputSchema.required).toContain("subject");
      expect(createTool?.inputSchema.required).toContain("organization_id");
      expect(createTool?.inputSchema.required).toContain("ticket_form_id");
    });

    it.each(["ninjaone_tickets_create", "ninjaone_tickets_update"])(
      "%s priority enum matches NewTicket/UpdateTicket (CRITICAL is a severity)",
      (toolName) => {
        const tool = ticketsHandler.getTools().find((t) => t.name === toolName);
        const props = tool?.inputSchema.properties as Record<
          string,
          { enum?: string[] }
        >;

        expect(props.priority.enum).toEqual(["NONE", "LOW", "MEDIUM", "HIGH"]);
        expect(props.severity.enum).toEqual([
          "NONE",
          "MINOR",
          "MODERATE",
          "MAJOR",
          "CRITICAL",
        ]);
        expect(props.type.enum).toEqual([
          "PROBLEM",
          "QUESTION",
          "INCIDENT",
          "TASK",
          "CHANGE_REQUEST",
          "SERVICE_REQUEST",
          "PROJECT",
          "APPOINTMENT",
          "MISCELLANEOUS",
        ]);
      }
    );

    it("status is a free-form per-tenant id, not a hardcoded enum", () => {
      const tools = ticketsHandler.getTools();
      for (const name of [
        "ninjaone_tickets_list",
        "ninjaone_tickets_create",
        "ninjaone_tickets_update",
      ]) {
        const props = tools.find((t) => t.name === name)?.inputSchema
          .properties as Record<string, { enum?: string[] }>;
        expect(props.status.enum).toBeUndefined();
      }
    });

    it("ninjaone_tickets_comments exposes the documented log-entry types", () => {
      const tool = ticketsHandler
        .getTools()
        .find((t) => t.name === "ninjaone_tickets_comments");
      const props = tool?.inputSchema.properties as Record<string, { enum?: string[] }>;

      expect(props.type.enum).toEqual([
        "DESCRIPTION",
        "COMMENT",
        "CONDITION",
        "SAVE",
        "DELETE",
        "PRODUCT",
        "INFO",
      ]);
    });

    it("ninjaone_tickets_update does not accept a description (PUT takes no comments)", () => {
      const tool = ticketsHandler
        .getTools()
        .find((t) => t.name === "ninjaone_tickets_update");
      const props = tool?.inputSchema.properties as Record<string, unknown>;

      expect(props).not.toHaveProperty("description");
      expect(props).not.toHaveProperty("description_public");
    });

    it("ninjaone_tickets_add_comment should require ticket_id and body", () => {
      const tools = ticketsHandler.getTools();
      const commentTool = tools.find((t) => t.name === "ninjaone_tickets_add_comment");

      expect(commentTool).toBeDefined();
      expect(commentTool?.inputSchema.required).toContain("ticket_id");
      expect(commentTool?.inputSchema.required).toContain("body");
    });
  });

  describe("handleCall", () => {
    describe("ninjaone_tickets_list", () => {
      it("should list tickets for an explicit board", async () => {
        const result = await ticketsHandler.handleCall("ninjaone_tickets_list", {
          board_id: 2,
        });

        expect(result.isError).toBeUndefined();
        expect(result.content[0].type).toBe("text");
        expect(mockTicketsList).toHaveBeenCalledWith(
          expect.objectContaining({ boardId: 2 })
        );

        const data = JSON.parse(result.content[0].text);
        expect(data.tickets).toHaveLength(2);
        expect(data.cursor).toBe("next-page");
      });

      it("should return an actionable error when board_id is omitted", async () => {
        const result = await ticketsHandler.handleCall("ninjaone_tickets_list", {});

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("board_id");
        expect(result.content[0].text).toContain("ninjaone_tickets_boards_list");
        expect(mockTicketsList).not.toHaveBeenCalled();
      });

      it("should NOT send status/org/device filters to the board API (#60, #61)", async () => {
        // NinjaOne's board-run endpoint 400s on these filters, so the handler must
        // never forward them — it fetches the board page and filters client-side.
        await ticketsHandler.handleCall("ninjaone_tickets_list", {
          board_id: 1,
          status: "OPEN",
          organization_id: 5,
          device_id: 10,
          limit: 25,
        });

        expect(mockTicketsList).toHaveBeenCalledWith({
          boardId: 1,
          pageSize: 25,
          lastCursorId: undefined,
        });
        const passed = mockTicketsList.mock.calls[0][0];
        expect(passed).not.toHaveProperty("status");
        expect(passed).not.toHaveProperty("organizationId");
        expect(passed).not.toHaveProperty("deviceId");
      });

      it("should filter tickets by status client-side (board-row status object)", async () => {
        mockTicketsList.mockResolvedValueOnce({
          data: [
            { id: 1, status: { statusId: 2000, displayName: "Open" }, clientId: 5, nodeId: 10 },
            { id: 2, status: { statusId: 4000, displayName: "In Progress" }, clientId: 5, nodeId: 11 },
            { id: 3, status: { statusId: 2000, displayName: "Open" }, clientId: 7, nodeId: 12 },
          ],
        });

        const result = await ticketsHandler.handleCall("ninjaone_tickets_list", {
          board_id: 1,
          status: "OPEN",
        });

        const data = JSON.parse(result.content[0].text);
        expect(data.count).toBe(2);
        expect(data.scanned).toBe(3);
        expect(data.tickets.map((t: { id: number }) => t.id)).toEqual([1, 3]);
        expect(data.note).toContain("client-side");
      });

      it("should match status enum against the display name (IN_PROGRESS → 'In Progress')", async () => {
        mockTicketsList.mockResolvedValueOnce({
          data: [
            { id: 1, status: { statusId: 2000, displayName: "Open" } },
            { id: 2, status: { statusId: 4000, displayName: "In Progress" } },
          ],
        });

        const result = await ticketsHandler.handleCall("ninjaone_tickets_list", {
          board_id: 1,
          status: "IN_PROGRESS",
        });

        const data = JSON.parse(result.content[0].text);
        expect(data.tickets.map((t: { id: number }) => t.id)).toEqual([2]);
      });

      it("should filter by organization (clientId) and device (nodeId) client-side", async () => {
        mockTicketsList.mockResolvedValueOnce({
          data: [
            { id: 1, status: { displayName: "Open" }, clientId: 5, nodeId: 10 },
            { id: 2, status: { displayName: "Open" }, clientId: 5, nodeId: 99 },
            { id: 3, status: { displayName: "Open" }, clientId: 7, nodeId: 10 },
          ],
        });

        const result = await ticketsHandler.handleCall("ninjaone_tickets_list", {
          board_id: 1,
          organization_id: 5,
          device_id: 10,
        });

        const data = JSON.parse(result.content[0].text);
        expect(data.tickets.map((t: { id: number }) => t.id)).toEqual([1]);
      });

      it("should flag hasMore and a cursor when the board page is full", async () => {
        // A full page (length === limit) means the board has more tickets.
        mockTicketsList.mockResolvedValueOnce({
          data: [
            { id: 10, status: { displayName: "Open" }, clientId: 5 },
            { id: 20, status: { displayName: "Closed" }, clientId: 5 },
          ],
        });

        const result = await ticketsHandler.handleCall("ninjaone_tickets_list", {
          board_id: 1,
          status: "OPEN",
          limit: 2,
        });

        const data = JSON.parse(result.content[0].text);
        expect(data.count).toBe(1); // only the Open one matched...
        expect(data.scanned).toBe(2); // ...out of 2 scanned
        expect(data.hasMore).toBe(true); // full page → more tickets exist
        expect(data.cursor).toBe("20"); // resume after the max row id
      });

      it("should forward cursor as lastCursorId for pagination", async () => {
        await ticketsHandler.handleCall("ninjaone_tickets_list", {
          board_id: 2,
          limit: 50,
          cursor: "50",
        });

        expect(mockTicketsList).toHaveBeenCalledWith(
          expect.objectContaining({ lastCursorId: 50, pageSize: 50, boardId: 2 })
        );
      });
    });

    describe("ninjaone_tickets_get", () => {
      it("should get a single ticket", async () => {
        const result = await ticketsHandler.handleCall("ninjaone_tickets_get", {
          ticket_id: 1,
        });

        expect(result.isError).toBeUndefined();

        const data = JSON.parse(result.content[0].text);
        expect(data.id).toBe(1);
        expect(data.subject).toBe("Ticket 1");
      });
    });

    describe("ninjaone_tickets_create", () => {
      it("should create a ticket", async () => {
        const result = await ticketsHandler.handleCall("ninjaone_tickets_create", {
          subject: "New Ticket",
          description: "Test description",
          organization_id: 1,
        });

        expect(result.isError).toBeUndefined();

        const data = JSON.parse(result.content[0].text);
        expect(data.id).toBe(100);
        expect(data.subject).toBe("New Ticket");
      });

      it("should send the documented NewTicket body", async () => {
        await ticketsHandler.handleCall("ninjaone_tickets_create", {
          subject: "New Ticket",
          description: "Test description",
          organization_id: 1,
          ticket_form_id: 3,
          device_id: 5,
          location_id: 7,
          status: "1000",
          priority: "HIGH",
          severity: "MAJOR",
          type: "INCIDENT",
          requester_uid: "8a1f0e6a-0000-4000-8000-000000000001",
          assignee_id: 42,
          tags: ["tag1"],
          attributes: [{ attributeId: 9, value: "blue" }],
        });

        // NinjaOne spells these clientId/ticketFormId/nodeId/assignedAppUserId,
        // and takes the description as a NewTicketLogEntry rather than a string.
        expect(mockTicketsCreate).toHaveBeenCalledWith({
          subject: "New Ticket",
          clientId: 1,
          ticketFormId: 3,
          nodeId: 5,
          locationId: 7,
          status: "1000",
          priority: "HIGH",
          severity: "MAJOR",
          type: "INCIDENT",
          requesterUid: "8a1f0e6a-0000-4000-8000-000000000001",
          assignedAppUserId: 42,
          tags: ["tag1"],
          attributes: [{ attributeId: 9, value: "blue" }],
          description: { public: true, body: "Test description" },
        });
      });

      it("should mark the description internal when description_public is false", async () => {
        await ticketsHandler.handleCall("ninjaone_tickets_create", {
          subject: "New Ticket",
          organization_id: 1,
          ticket_form_id: 3,
          description: "Internal note",
          description_public: false,
        });

        expect(mockTicketsCreate.mock.calls[0][0].description).toEqual({
          public: false,
          body: "Internal note",
        });
      });

      it("should omit fields the caller did not supply", async () => {
        await ticketsHandler.handleCall("ninjaone_tickets_create", {
          subject: "New Ticket",
          organization_id: 1,
          ticket_form_id: 3,
        });

        expect(mockTicketsCreate).toHaveBeenCalledWith({
          subject: "New Ticket",
          clientId: 1,
          ticketFormId: 3,
        });
      });
    });

    describe("ninjaone_tickets_update", () => {
      it("should update a ticket", async () => {
        const result = await ticketsHandler.handleCall("ninjaone_tickets_update", {
          ticket_id: 1,
          subject: "Updated Ticket",
          status: "IN_PROGRESS",
        });

        expect(result.isError).toBeUndefined();

        const data = JSON.parse(result.content[0].text);
        expect(data.subject).toBe("Updated Ticket");
        expect(data.status).toBe("IN_PROGRESS");
      });

      it("should send the documented UpdateTicket body", async () => {
        await ticketsHandler.handleCall("ninjaone_tickets_update", {
          ticket_id: 1,
          subject: "Updated Ticket",
          status: "4000",
          organization_id: 1,
          ticket_form_id: 3,
          requester_uid: "8a1f0e6a-0000-4000-8000-000000000001",
          version: 2,
          assignee_id: 42,
          priority: "MEDIUM",
        });

        expect(mockTicketsUpdate).toHaveBeenCalledWith(1, {
          subject: "Updated Ticket",
          status: "4000",
          clientId: 1,
          ticketFormId: 3,
          requesterUid: "8a1f0e6a-0000-4000-8000-000000000001",
          version: 2,
          assignedAppUserId: 42,
          priority: "MEDIUM",
        });
      });

      it("should never send a description on update", async () => {
        // UpdateTicket has no description field — the PUT "does not accept
        // comments" — so one must not leak into the body even if passed.
        await ticketsHandler.handleCall("ninjaone_tickets_update", {
          ticket_id: 1,
          subject: "Updated Ticket",
          description: "should be dropped",
        });

        expect(mockTicketsUpdate.mock.calls[0][1]).not.toHaveProperty("description");
      });
    });

    describe("ninjaone_tickets_add_comment", () => {
      it("should add a comment to a ticket", async () => {
        const result = await ticketsHandler.handleCall("ninjaone_tickets_add_comment", {
          ticket_id: 1,
          body: "Test comment",
        });

        expect(result.isError).toBeUndefined();

        const data = JSON.parse(result.content[0].text);
        expect(data.ticketId).toBe(1);
        expect(data.body).toBe("Test comment");
      });

      it("should set internal flag when public is false", async () => {
        await ticketsHandler.handleCall("ninjaone_tickets_add_comment", {
          ticket_id: 1,
          body: "Private comment",
          public: false,
        });

        expect(mockTicketsAddComment).toHaveBeenCalledWith(1, {
          body: "Private comment",
          internal: true,
        });
      });
    });

    describe("ninjaone_tickets_comments", () => {
      it("should get ticket comments", async () => {
        const result = await ticketsHandler.handleCall("ninjaone_tickets_comments", {
          ticket_id: 1,
        });

        expect(result.isError).toBeUndefined();

        const data = JSON.parse(result.content[0].text);
        expect(data).toHaveLength(2);
      });

      it("should forward the log-entry type filter", async () => {
        await ticketsHandler.handleCall("ninjaone_tickets_comments", {
          ticket_id: 1,
          type: "COMMENT",
        });

        expect(mockTicketsGetComments).toHaveBeenCalledWith(1, "COMMENT");
      });
    });

    describe("documented endpoint paths", () => {
      // These paths are copied verbatim from NinjaOne's published OpenAPI
      // description (NinjaRMM-API-v2.yaml). Pinning them here means a wrong
      // path is a failing test rather than a 404 in a customer's tenant.
      it("pins every ticketing path the SDK does not implement", () => {
        expect(TICKETING_PATHS).toEqual({
          boards: "/api/v2/ticketing/trigger/boards",
          statuses: "/api/v2/ticketing/statuses",
          attributes: "/api/v2/ticketing/attributes",
          contacts: "/api/v2/ticketing/contact/contacts",
          users: "/api/v2/ticketing/app-user-contact",
        });
      });

      it.each([
        ["ninjaone_tickets_boards_list", "/api/v2/ticketing/trigger/boards"],
        ["ninjaone_tickets_statuses_list", "/api/v2/ticketing/statuses"],
        ["ninjaone_tickets_attributes_list", "/api/v2/ticketing/attributes"],
        ["ninjaone_tickets_contacts_list", "/api/v2/ticketing/contact/contacts"],
      ])("%s GETs %s", async (toolName, path) => {
        const result = await ticketsHandler.handleCall(toolName, {});

        expect(result.isError).toBeUndefined();
        expect(mockHttpRequest).toHaveBeenCalledWith(path, undefined);
      });

      it("boards_list uses the plural path, not the SDK's singular one", async () => {
        // The SDK's listBoards() requests /api/v2/ticketing/trigger/board,
        // which NinjaOne does not serve — the 404 previously blamed on tenants.
        await ticketsHandler.handleCall("ninjaone_tickets_boards_list", {});

        expect(mockTicketsListBoards).not.toHaveBeenCalled();
        expect(mockHttpRequest.mock.calls[0][0]).toBe(
          "/api/v2/ticketing/trigger/boards"
        );
      });

      it("users_list sends the documented query parameter names", async () => {
        await ticketsHandler.handleCall("ninjaone_tickets_users_list", {
          user_type: "TECHNICIAN",
          organization_id: 5,
          search: "ada",
          limit: 25,
          cursor: 100,
        });

        expect(mockHttpRequest).toHaveBeenCalledWith(
          "/api/v2/ticketing/app-user-contact",
          {
            params: {
              userType: "TECHNICIAN",
              clientId: 5,
              searchCriteria: "ada",
              pageSize: 25,
              anchorNaturalId: 100,
            },
          }
        );
      });

      it("explains itself if a future SDK build hides its httpClient", async () => {
        await expect(
          ticketingGet({} as never, TICKETING_PATHS.boards)
        ).rejects.toThrow(/no longer exposes an internal httpClient/);
      });
    });

    describe("ticket forms", () => {
      it("should list ticket forms", async () => {
        const result = await ticketsHandler.handleCall("ninjaone_tickets_forms_list", {});

        expect(result.isError).toBeUndefined();
        expect(mockTicketsListForms).toHaveBeenCalledWith();
        expect(JSON.parse(result.content[0].text)).toHaveLength(2);
      });

      it("should get one ticket form", async () => {
        const result = await ticketsHandler.handleCall("ninjaone_tickets_form_get", {
          form_id: 1,
        });

        expect(result.isError).toBeUndefined();
        expect(mockTicketsGetForm).toHaveBeenCalledWith(1);
        expect(JSON.parse(result.content[0].text).id).toBe(1);
      });
    });

    describe("unknown tool", () => {
      it("should return error for unknown tool", async () => {
        const result = await ticketsHandler.handleCall("ninjaone_tickets_unknown", {});

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Unknown ticket tool");
      });
    });
  });
});
