/**
 * Tests for devices domain handler
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Create mock functions using vi.hoisted so they're available when vi.mock is hoisted
const {
  mockDevicesList,
  mockDevicesGet,
  mockDevicesReboot,
  mockDevicesGetServices,
  mockAlertsListByDevice,
  mockDevicesGetActivities,
  mockClient,
} = vi.hoisted(() => {
  const mockDevicesList = vi.fn();
  const mockDevicesGet = vi.fn();
  const mockDevicesReboot = vi.fn();
  const mockDevicesGetServices = vi.fn();
  const mockAlertsListByDevice = vi.fn();
  const mockDevicesGetActivities = vi.fn();

  const mockClient = {
    devices: {
      list: mockDevicesList,
      get: mockDevicesGet,
      reboot: mockDevicesReboot,
      getServices: mockDevicesGetServices,
      getActivities: mockDevicesGetActivities,
    },
    alerts: {
      listByDevice: mockAlertsListByDevice,
    },
  };

  return {
    mockDevicesList,
    mockDevicesGet,
    mockDevicesReboot,
    mockDevicesGetServices,
    mockAlertsListByDevice,
    mockDevicesGetActivities,
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
import { devicesHandler } from "../../domains/devices.js";

describe("Devices Domain Handler", () => {
  beforeEach(() => {
    // Clear call history
    mockDevicesList.mockClear();
    mockDevicesGet.mockClear();
    mockDevicesReboot.mockClear();
    mockDevicesGetServices.mockClear();
    mockAlertsListByDevice.mockClear();
    mockDevicesGetActivities.mockClear();

    // Reset mock implementations - list returns Device[] directly
    mockDevicesList.mockResolvedValue([
      { id: 1, systemName: "Device 1", organizationId: 1 },
      { id: 2, systemName: "Device 2", organizationId: 1 },
    ]);
    mockDevicesGet.mockResolvedValue({
      id: 1,
      systemName: "Device 1",
      organizationId: 1,
      online: true,
    });
    mockDevicesReboot.mockResolvedValue(undefined);
    // getServices returns DeviceService[] directly
    mockDevicesGetServices.mockResolvedValue([
      { name: "Service 1", state: "RUNNING" },
      { name: "Service 2", state: "STOPPED" },
    ]);
    // alerts.listByDevice returns Alert[] directly
    mockAlertsListByDevice.mockResolvedValue([
      { uid: "alert-1", message: "Alert 1", severity: "CRITICAL", deviceId: 1, organizationId: 1 },
    ]);
    mockDevicesGetActivities.mockResolvedValue({
      activities: [
        { id: 1, type: "LOGIN", timestamp: "2024-01-01T00:00:00Z" },
      ],
    });
  });

  describe("getTools", () => {
    it("should return all device tools", () => {
      const tools = devicesHandler.getTools();

      expect(tools.length).toBe(6);

      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain("ninjaone_devices_list");
      expect(toolNames).toContain("ninjaone_devices_get");
      expect(toolNames).toContain("ninjaone_devices_reboot");
      expect(toolNames).toContain("ninjaone_devices_services");
      expect(toolNames).toContain("ninjaone_devices_alerts");
      expect(toolNames).toContain("ninjaone_devices_activities");
    });

    it("ninjaone_devices_get should require device_id", () => {
      const tools = devicesHandler.getTools();
      const getTool = tools.find((t) => t.name === "ninjaone_devices_get");

      expect(getTool).toBeDefined();
      expect(getTool?.inputSchema.required).toContain("device_id");
    });

    it("ninjaone_devices_reboot should require device_id", () => {
      const tools = devicesHandler.getTools();
      const rebootTool = tools.find((t) => t.name === "ninjaone_devices_reboot");

      expect(rebootTool).toBeDefined();
      expect(rebootTool?.inputSchema.required).toContain("device_id");
    });
  });

  describe("handleCall", () => {
    describe("ninjaone_devices_list", () => {
      it("should list devices with default parameters", async () => {
        const result = await devicesHandler.handleCall("ninjaone_devices_list", {});

        expect(result.isError).toBeUndefined();
        expect(result.content[0].type).toBe("text");

        const data = JSON.parse(result.content[0].text);
        expect(data.devices).toHaveLength(2);
      });

      it("should forward class and online filters to the API", async () => {
        await devicesHandler.handleCall("ninjaone_devices_list", {
          organization_id: 5,
          device_class: "WINDOWS_SERVER",
          online: true,
          limit: 10,
        });

        expect(mockDevicesList).toHaveBeenCalledWith({
          organizationId: 5,
          nodeClass: "WINDOWS_SERVER",
          status: "ONLINE",
          pageSize: 10,
          cursor: undefined,
        });
      });

      it("should map online:false to OFFLINE status", async () => {
        await devicesHandler.handleCall("ninjaone_devices_list", {
          organization_id: 5,
          online: false,
        });

        expect(mockDevicesList).toHaveBeenCalledWith(
          expect.objectContaining({ status: "OFFLINE" })
        );
      });

      it("should omit the status filter when online is not provided", async () => {
        await devicesHandler.handleCall("ninjaone_devices_list", {
          organization_id: 5,
        });

        const passed = mockDevicesList.mock.calls[0][0];
        expect(passed.status).toBeUndefined();
      });

      it("should surface a pagination cursor when a full page is returned", async () => {
        // A page exactly the size of the limit signals possible truncation.
        mockDevicesList.mockResolvedValueOnce([
          { id: 11, systemName: "A", organizationId: 1 },
          { id: 22, systemName: "B", organizationId: 1 },
        ]);

        const result = await devicesHandler.handleCall("ninjaone_devices_list", {
          organization_id: 5,
          limit: 2,
        });

        const data = JSON.parse(result.content[0].text);
        expect(data.count).toBe(2);
        expect(data.hasMore).toBe(true);
        expect(data.cursor).toBe("22");
      });

      it("should not surface a cursor when the page is not full", async () => {
        // Default mock returns 2 devices; limit 50 → not a full page.
        const result = await devicesHandler.handleCall("ninjaone_devices_list", {
          organization_id: 5,
          limit: 50,
        });

        const data = JSON.parse(result.content[0].text);
        expect(data.hasMore).toBe(false);
        expect(data.cursor).toBeUndefined();
      });
    });

    describe("ninjaone_devices_get", () => {
      it("should get a single device", async () => {
        const result = await devicesHandler.handleCall("ninjaone_devices_get", {
          device_id: 1,
        });

        expect(result.isError).toBeUndefined();

        const data = JSON.parse(result.content[0].text);
        expect(data.id).toBe(1);
        expect(data.systemName).toBe("Device 1");
      });

      it("should accept camelCase deviceId param", async () => {
        const result = await devicesHandler.handleCall("ninjaone_devices_get", {
          deviceId: 1,
        });

        expect(result.isError).toBeUndefined();
        expect(mockDevicesGet).toHaveBeenCalledWith(1);
      });

      it("should return error when no device_id provided", async () => {
        const result = await devicesHandler.handleCall("ninjaone_devices_get", {});

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("device_id is required");
      });
    });

    describe("ninjaone_devices_reboot", () => {
      it("should schedule a reboot", async () => {
        const result = await devicesHandler.handleCall("ninjaone_devices_reboot", {
          device_id: 1,
          reason: "Scheduled maintenance",
        });

        expect(result.isError).toBeUndefined();

        const data = JSON.parse(result.content[0].text);
        expect(data.success).toBe(true);
        expect(data.message).toBe("Reboot scheduled");
        expect(mockDevicesReboot).toHaveBeenCalledWith(1, "Scheduled maintenance");
      });
    });

    describe("ninjaone_devices_services", () => {
      it("should list services", async () => {
        const result = await devicesHandler.handleCall("ninjaone_devices_services", {
          device_id: 1,
        });

        expect(result.isError).toBeUndefined();

        const data = JSON.parse(result.content[0].text);
        expect(data).toHaveLength(2);
      });

      it("should filter services by state client-side", async () => {
        const result = await devicesHandler.handleCall("ninjaone_devices_services", {
          device_id: 1,
          state: "RUNNING",
        });

        expect(result.isError).toBeUndefined();

        const data = JSON.parse(result.content[0].text);
        expect(data).toHaveLength(1);
        expect(data[0].state).toBe("RUNNING");
      });
    });

    describe("ninjaone_devices_alerts", () => {
      it("should list device alerts via alerts.listByDevice", async () => {
        const result = await devicesHandler.handleCall("ninjaone_devices_alerts", {
          device_id: 1,
        });

        expect(result.isError).toBeUndefined();
        expect(mockAlertsListByDevice).toHaveBeenCalledWith(1);

        const data = JSON.parse(result.content[0].text);
        expect(data).toHaveLength(1);
      });
    });

    describe("ninjaone_devices_activities", () => {
      it("should list device activities", async () => {
        const result = await devicesHandler.handleCall("ninjaone_devices_activities", {
          device_id: 1,
        });

        expect(result.isError).toBeUndefined();

        const data = JSON.parse(result.content[0].text);
        expect(data.activities).toHaveLength(1);
      });
    });

    describe("unknown tool", () => {
      it("should return error for unknown tool", async () => {
        const result = await devicesHandler.handleCall("ninjaone_devices_unknown", {});

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Unknown device tool");
      });
    });
  });
});
