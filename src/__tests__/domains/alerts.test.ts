/**
 * Tests for alerts domain handler
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Create mock functions using vi.hoisted
const {
  mockAlertsList,
  mockAlertsReset,
  mockAlertsResetByDevice,
  mockAlertsResetByOrganization,
  mockClient,
} = vi.hoisted(() => {
  const mockAlertsList = vi.fn();
  const mockAlertsReset = vi.fn();
  const mockAlertsResetByDevice = vi.fn();
  const mockAlertsResetByOrganization = vi.fn();

  const mockClient = {
    alerts: {
      list: mockAlertsList,
      reset: mockAlertsReset,
      resetByDevice: mockAlertsResetByDevice,
      resetByOrganization: mockAlertsResetByOrganization,
    },
  };

  return {
    mockAlertsList,
    mockAlertsReset,
    mockAlertsResetByDevice,
    mockAlertsResetByOrganization,
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
import { alertsHandler } from "../../domains/alerts.js";

describe("Alerts Domain Handler", () => {
  beforeEach(() => {
    // Clear call history
    mockAlertsList.mockClear();
    mockAlertsReset.mockClear();
    mockAlertsResetByDevice.mockClear();
    mockAlertsResetByOrganization.mockClear();

    // Reset mock implementations - list returns Alert[] directly
    mockAlertsList.mockResolvedValue([
      { uid: "alert-1", message: "Alert 1", severity: "CRITICAL", deviceId: 1, organizationId: 1 },
      { uid: "alert-2", message: "Alert 2", severity: "MAJOR", deviceId: 2, organizationId: 1 },
    ]);
    mockAlertsReset.mockResolvedValue(undefined);
    mockAlertsResetByDevice.mockResolvedValue({ count: 5, success: true });
    mockAlertsResetByOrganization.mockResolvedValue({ count: 10, success: true });
  });

  describe("getTools", () => {
    it("should return all alert tools", () => {
      const tools = alertsHandler.getTools();

      expect(tools.length).toBe(5);

      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain("ninjaone_alerts_list");
      expect(toolNames).toContain("ninjaone_alerts_get");
      expect(toolNames).toContain("ninjaone_alerts_reset");
      expect(toolNames).toContain("ninjaone_alerts_reset_all");
      expect(toolNames).toContain("ninjaone_alerts_summary");
    });

    it("ninjaone_alerts_reset should require alert_uid", () => {
      const tools = alertsHandler.getTools();
      const resetTool = tools.find((t) => t.name === "ninjaone_alerts_reset");

      expect(resetTool).toBeDefined();
      expect(resetTool?.inputSchema.required).toContain("alert_uid");
    });
  });

  describe("handleCall", () => {
    describe("ninjaone_alerts_list", () => {
      it("should list alerts with default parameters", async () => {
        const result = await alertsHandler.handleCall("ninjaone_alerts_list", {});

        expect(result.isError).toBeUndefined();
        expect(result.content[0].type).toBe("text");

        const data = JSON.parse(result.content[0].text);
        expect(data.alerts).toHaveLength(2);
      });

      it("should pass filters to API", async () => {
        await alertsHandler.handleCall("ninjaone_alerts_list", {
          severity: "CRITICAL",
          organization_id: 5,
          device_id: 10,
          limit: 25,
        });

        expect(mockAlertsList).toHaveBeenCalledWith({
          severity: "CRITICAL",
          organizationId: 5,
          deviceId: 10,
          sourceType: undefined,
          pageSize: 25,
          cursor: undefined,
        });
      });
    });

    describe("ninjaone_alerts_reset", () => {
      it("should reset a single alert", async () => {
        const result = await alertsHandler.handleCall("ninjaone_alerts_reset", {
          alert_uid: "alert-1",
        });

        expect(result.isError).toBeUndefined();

        const data = JSON.parse(result.content[0].text);
        expect(data.success).toBe(true);
        expect(data.message).toBe("Alert reset successfully");
      });
    });

    describe("ninjaone_alerts_reset_all", () => {
      it("should reset all alerts for a device", async () => {
        const result = await alertsHandler.handleCall("ninjaone_alerts_reset_all", {
          device_id: 1,
        });

        expect(result.isError).toBeUndefined();
        expect(mockAlertsResetByDevice).toHaveBeenCalledWith(1);

        const data = JSON.parse(result.content[0].text);
        expect(data.success).toBe(true);
      });

      it("should reset all alerts for an organization", async () => {
        const result = await alertsHandler.handleCall("ninjaone_alerts_reset_all", {
          organization_id: 1,
        });

        expect(result.isError).toBeUndefined();
        expect(mockAlertsResetByOrganization).toHaveBeenCalledWith(1);

        const data = JSON.parse(result.content[0].text);
        expect(data.success).toBe(true);
      });

      it("should return error when neither device_id nor organization_id provided", async () => {
        const result = await alertsHandler.handleCall("ninjaone_alerts_reset_all", {});

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Must specify either device_id or organization_id");
      });
    });

    describe("ninjaone_alerts_summary", () => {
      it("should compute alert summary client-side", async () => {
        const result = await alertsHandler.handleCall("ninjaone_alerts_summary", {});

        expect(result.isError).toBeUndefined();
        expect(mockAlertsList).toHaveBeenCalledWith();

        const data = JSON.parse(result.content[0].text);
        expect(data.total).toBe(2);
        expect(data.bySeverity).toBeDefined();
        expect(data.bySeverity.CRITICAL).toBe(1);
        expect(data.bySeverity.MAJOR).toBe(1);
      });

      it("should group by organization when requested", async () => {
        const result = await alertsHandler.handleCall("ninjaone_alerts_summary", {
          group_by: "organization",
        });

        expect(result.isError).toBeUndefined();

        const data = JSON.parse(result.content[0].text);
        expect(data.total).toBe(2);
        expect(data.byOrganization).toBeDefined();
        expect(data.byOrganization["1"]).toBe(2);
      });
    });

    describe("unknown tool", () => {
      it("should return error for unknown tool", async () => {
        const result = await alertsHandler.handleCall("ninjaone_alerts_unknown", {});

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Unknown alert tool");
      });
    });
  });
});
