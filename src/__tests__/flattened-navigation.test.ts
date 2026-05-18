/**
 * Tests for the flattened navigation architecture
 *
 * Verifies that all tools are always available and navigation is stateless.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock environment for testing
vi.mock("../utils/client.js", () => ({
  getCredentials: vi.fn().mockReturnValue({
    clientId: "test-id",
    clientSecret: "test-secret",
    region: "us",
    baseUrl: "https://app.ninjarmm.com",
  }),
  createClientDirect: vi.fn().mockResolvedValue({}),
  setClientOverride: vi.fn(),
  clearClientOverride: vi.fn(),
  setCredentialOverrides: vi.fn(),
  clearCredentialOverrides: vi.fn(),
}));

// Mock domain handlers using vi.hoisted
const { mockHandlers } = vi.hoisted(() => {
  const mockHandlers = {
    devices: {
      getTools: vi.fn().mockReturnValue([
        { name: "ninjaone_devices_list", description: "List devices", inputSchema: { type: "object", properties: {} } },
        { name: "ninjaone_devices_get", description: "Get device", inputSchema: { type: "object", properties: {} } },
      ]),
      handleCall: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "Device tool called" }],
      }),
    },
    organizations: {
      getTools: vi.fn().mockReturnValue([
        { name: "ninjaone_organizations_list", description: "List organizations", inputSchema: { type: "object", properties: {} } },
        { name: "ninjaone_organizations_get", description: "Get organization", inputSchema: { type: "object", properties: {} } },
      ]),
      handleCall: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "Organization tool called" }],
      }),
    },
    alerts: {
      getTools: vi.fn().mockReturnValue([
        { name: "ninjaone_alerts_list", description: "List alerts", inputSchema: { type: "object", properties: {} } },
        { name: "ninjaone_alerts_reset", description: "Reset alert", inputSchema: { type: "object", properties: {} } },
      ]),
      handleCall: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "Alert tool called" }],
      }),
    },
    tickets: {
      getTools: vi.fn().mockReturnValue([
        { name: "ninjaone_tickets_list", description: "List tickets", inputSchema: { type: "object", properties: {} } },
        { name: "ninjaone_tickets_get", description: "Get ticket", inputSchema: { type: "object", properties: {} } },
      ]),
      handleCall: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "Ticket tool called" }],
      }),
    },
  };

  return { mockHandlers };
});

vi.mock("../domains/devices.js", () => ({
  devicesHandler: mockHandlers.devices,
}));

vi.mock("../domains/organizations.js", () => ({
  organizationsHandler: mockHandlers.organizations,
}));

vi.mock("../domains/alerts.js", () => ({
  alertsHandler: mockHandlers.alerts,
}));

vi.mock("../domains/tickets.js", () => ({
  ticketsHandler: mockHandlers.tickets,
}));

vi.mock("../utils/server-ref.js", () => ({
  setServerRef: vi.fn(),
}));

vi.mock("../prompts.js", () => ({
  registerPromptHandlers: vi.fn(),
}));

// Import the domain utilities for testing the architecture
import { getDomainHandler, getAvailableDomains } from "../domains/index.js";

describe("Flattened Navigation Architecture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock return values explicitly
    mockHandlers.devices.getTools.mockReturnValue([
      { name: "ninjaone_devices_list", description: "List devices", inputSchema: { type: "object", properties: {} } },
      { name: "ninjaone_devices_get", description: "Get device", inputSchema: { type: "object", properties: {} } },
    ]);
    mockHandlers.organizations.getTools.mockReturnValue([
      { name: "ninjaone_organizations_list", description: "List organizations", inputSchema: { type: "object", properties: {} } },
      { name: "ninjaone_organizations_get", description: "Get organization", inputSchema: { type: "object", properties: {} } },
    ]);
    mockHandlers.alerts.getTools.mockReturnValue([
      { name: "ninjaone_alerts_list", description: "List alerts", inputSchema: { type: "object", properties: {} } },
      { name: "ninjaone_alerts_reset", description: "Reset alert", inputSchema: { type: "object", properties: {} } },
    ]);
    mockHandlers.tickets.getTools.mockReturnValue([
      { name: "ninjaone_tickets_list", description: "List tickets", inputSchema: { type: "object", properties: {} } },
      { name: "ninjaone_tickets_get", description: "Get ticket", inputSchema: { type: "object", properties: {} } },
    ]);
  });

  describe("Tool Collection for Flattened Architecture", () => {
    it("should collect all domain tools", async () => {
      const domains = getAvailableDomains();
      expect(domains).toEqual(["devices", "organizations", "alerts", "tickets"]);

      const allTools = [];
      for (const domain of domains) {
        const handler = await getDomainHandler(domain);
        const tools = handler.getTools();
        allTools.push(...tools);
      }

      // Should have tools from all domains
      expect(allTools.length).toBeGreaterThan(0);

      const toolNames = allTools.map((t) => t.name);

      // Should include device tools
      expect(toolNames.filter(name => name.startsWith("ninjaone_devices_"))).toHaveLength(2);

      // Should include organization tools
      expect(toolNames.filter(name => name.startsWith("ninjaone_organizations_"))).toHaveLength(2);

      // Should include alert tools
      expect(toolNames.filter(name => name.startsWith("ninjaone_alerts_"))).toHaveLength(2);

      // Should include ticket tools
      expect(toolNames.filter(name => name.startsWith("ninjaone_tickets_"))).toHaveLength(2);
    });

    it("should provide tools that follow consistent naming patterns", async () => {
      const domains = getAvailableDomains();

      for (const domain of domains) {
        const handler = await getDomainHandler(domain);
        const tools = handler.getTools();

        for (const tool of tools) {
          expect(tool.name).toMatch(/^ninjaone_[a-z]+_[a-z_]+$/);
          expect(tool.name).toContain(`ninjaone_${domain}_`);
          expect(tool.description).toBeDefined();
          expect(tool.inputSchema).toBeDefined();
        }
      }
    });
  });

  describe("Navigation Architecture Verification", () => {
    it("should support prefix-based routing for all domains", async () => {
      const domains = getAvailableDomains();

      for (const domain of domains) {
        const handler = await getDomainHandler(domain);
        const tools = handler.getTools();

        // All tools in a domain should have the domain prefix
        for (const tool of tools) {
          expect(tool.name.startsWith(`ninjaone_${domain}_`)).toBe(true);
        }
      }
    });

    it("should not have state-dependent behavior in domain loading", async () => {
      // Load domains in different orders to ensure no state dependency
      const handler1 = await getDomainHandler("alerts");
      const tools1 = handler1.getTools();

      const handler2 = await getDomainHandler("devices");
      const tools2 = handler2.getTools();

      const handler3 = await getDomainHandler("alerts");
      const tools3 = handler3.getTools();

      // Same domain should always return same tools regardless of load order
      expect(tools1.map(t => t.name)).toEqual(tools3.map(t => t.name));
      // A different domain returns a different tool set
      expect(tools2.map(t => t.name)).not.toEqual(tools1.map(t => t.name));
    });
  });
});