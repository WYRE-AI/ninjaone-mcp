/**
 * Tests for navigation and domain state management
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Create mock handlers using vi.hoisted
const { mockHandlers } = vi.hoisted(() => {
  const mockHandlers = {
    devices: {
      getTools: vi.fn().mockReturnValue([
        { name: "ninjaone_devices_list", description: "List devices" },
        { name: "ninjaone_devices_get", description: "Get device" },
      ]),
      handleCall: vi.fn(),
    },
    organizations: {
      getTools: vi.fn().mockReturnValue([
        { name: "ninjaone_organizations_list", description: "List organizations" },
        { name: "ninjaone_organizations_get", description: "Get organization" },
      ]),
      handleCall: vi.fn(),
    },
    alerts: {
      getTools: vi.fn().mockReturnValue([
        { name: "ninjaone_alerts_list", description: "List alerts" },
        { name: "ninjaone_alerts_reset", description: "Reset alert" },
      ]),
      handleCall: vi.fn(),
    },
    tickets: {
      getTools: vi.fn().mockReturnValue([
        { name: "ninjaone_tickets_list", description: "List tickets" },
        { name: "ninjaone_tickets_get", description: "Get ticket" },
      ]),
      handleCall: vi.fn(),
    },
  };

  return { mockHandlers };
});

// Mock all domain handlers
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

import {
  getDomainHandler,
  getAvailableDomains,
  clearDomainCache,
} from "../domains/index.js";
import { isDomainName } from "../utils/types.js";

describe("Domain Navigation", () => {
  beforeEach(() => {
    clearDomainCache();
    vi.clearAllMocks();

    // Reset mock return values
    mockHandlers.devices.getTools.mockReturnValue([
      { name: "ninjaone_devices_list", description: "List devices" },
      { name: "ninjaone_devices_get", description: "Get device" },
    ]);
    mockHandlers.organizations.getTools.mockReturnValue([
      { name: "ninjaone_organizations_list", description: "List organizations" },
      { name: "ninjaone_organizations_get", description: "Get organization" },
    ]);
    mockHandlers.alerts.getTools.mockReturnValue([
      { name: "ninjaone_alerts_list", description: "List alerts" },
      { name: "ninjaone_alerts_reset", description: "Reset alert" },
    ]);
    mockHandlers.tickets.getTools.mockReturnValue([
      { name: "ninjaone_tickets_list", description: "List tickets" },
      { name: "ninjaone_tickets_get", description: "Get ticket" },
    ]);
  });

  describe("getAvailableDomains", () => {
    it("should return all available domains", () => {
      const domains = getAvailableDomains();

      expect(domains).toEqual([
        "devices",
        "organizations",
        "alerts",
        "tickets",
        "scripts",
        "patches",
      ]);
    });

    it("should return a consistent list", () => {
      const domains1 = getAvailableDomains();
      const domains2 = getAvailableDomains();

      expect(domains1).toEqual(domains2);
    });
  });

  describe("isDomainName", () => {
    it("should return true for valid domain names", () => {
      expect(isDomainName("devices")).toBe(true);
      expect(isDomainName("organizations")).toBe(true);
      expect(isDomainName("alerts")).toBe(true);
      expect(isDomainName("tickets")).toBe(true);
    });

    it("should return false for invalid domain names", () => {
      expect(isDomainName("invalid")).toBe(false);
      expect(isDomainName("")).toBe(false);
      expect(isDomainName("DEVICES")).toBe(false);
      expect(isDomainName("device")).toBe(false);
    });
  });

  describe("getDomainHandler", () => {
    it("should load devices domain handler", async () => {
      const handler = await getDomainHandler("devices");

      expect(handler).toBeDefined();
      expect(handler.getTools).toBeDefined();
      expect(handler.handleCall).toBeDefined();
    });

    it("should load organizations domain handler", async () => {
      const handler = await getDomainHandler("organizations");

      expect(handler).toBeDefined();
      expect(handler.getTools()).toHaveLength(2);
    });

    it("should load alerts domain handler", async () => {
      const handler = await getDomainHandler("alerts");

      expect(handler).toBeDefined();
      expect(handler.getTools()).toHaveLength(2);
    });

    it("should load tickets domain handler", async () => {
      const handler = await getDomainHandler("tickets");

      expect(handler).toBeDefined();
      expect(handler.getTools()).toHaveLength(2);
    });

    it("should cache domain handlers", async () => {
      const handler1 = await getDomainHandler("devices");
      const handler2 = await getDomainHandler("devices");

      expect(handler1).toBe(handler2);
    });

    it("should throw for unknown domain", async () => {
      await expect(
        getDomainHandler("unknown" as "devices")
      ).rejects.toThrow("Unknown domain: unknown");
    });
  });

  describe("clearDomainCache", () => {
    it("should clear the cached handlers", async () => {
      // Load a handler to cache it
      const _handler1 = await getDomainHandler("devices");

      // Clear cache
      clearDomainCache();

      // The handler should still be loadable
      const handler2 = await getDomainHandler("devices");

      // Both should have same interface but may be different objects
      expect(handler2).toBeDefined();
      expect(handler2.getTools).toBeDefined();
    });
  });
});

describe("Domain Tools Structure", () => {
  beforeEach(() => {
    clearDomainCache();

    // Reset mock return values
    mockHandlers.devices.getTools.mockReturnValue([
      { name: "ninjaone_devices_list", description: "List devices" },
      { name: "ninjaone_devices_get", description: "Get device" },
    ]);
    mockHandlers.organizations.getTools.mockReturnValue([
      { name: "ninjaone_organizations_list", description: "List organizations" },
      { name: "ninjaone_organizations_get", description: "Get organization" },
    ]);
    mockHandlers.alerts.getTools.mockReturnValue([
      { name: "ninjaone_alerts_list", description: "List alerts" },
      { name: "ninjaone_alerts_reset", description: "Reset alert" },
    ]);
    mockHandlers.tickets.getTools.mockReturnValue([
      { name: "ninjaone_tickets_list", description: "List tickets" },
      { name: "ninjaone_tickets_get", description: "Get ticket" },
    ]);
  });

  it("devices domain should expose device-specific tools", async () => {
    const handler = await getDomainHandler("devices");
    const tools = handler.getTools();

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("ninjaone_devices_list");
    expect(toolNames).toContain("ninjaone_devices_get");
  });

  it("organizations domain should expose organization-specific tools", async () => {
    const handler = await getDomainHandler("organizations");
    const tools = handler.getTools();

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("ninjaone_organizations_list");
    expect(toolNames).toContain("ninjaone_organizations_get");
  });

  it("alerts domain should expose alert-specific tools", async () => {
    const handler = await getDomainHandler("alerts");
    const tools = handler.getTools();

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("ninjaone_alerts_list");
    expect(toolNames).toContain("ninjaone_alerts_reset");
  });

  it("tickets domain should expose ticket-specific tools", async () => {
    const handler = await getDomainHandler("tickets");
    const tools = handler.getTools();

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("ninjaone_tickets_list");
    expect(toolNames).toContain("ninjaone_tickets_get");
  });
});
