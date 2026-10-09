/**
 * Tests for organizations domain handler
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Create mock functions using vi.hoisted
const {
  mockOrganizationsList,
  mockOrganizationsGet,
  mockOrganizationsCreate,
  mockOrganizationsGetLocations,
  mockOrganizationsGetCustomFields,
  mockOrganizationsUpdateCustomFields,
  mockDevicesListByOrganization,
  mockClient,
} = vi.hoisted(() => {
  const mockOrganizationsList = vi.fn();
  const mockOrganizationsGet = vi.fn();
  const mockOrganizationsCreate = vi.fn();
  const mockOrganizationsGetLocations = vi.fn();
  const mockOrganizationsGetCustomFields = vi.fn();
  const mockOrganizationsUpdateCustomFields = vi.fn();
  const mockDevicesListByOrganization = vi.fn();

  const mockClient = {
    organizations: {
      list: mockOrganizationsList,
      get: mockOrganizationsGet,
      create: mockOrganizationsCreate,
      getLocations: mockOrganizationsGetLocations,
      getCustomFields: mockOrganizationsGetCustomFields,
      updateCustomFields: mockOrganizationsUpdateCustomFields,
    },
    devices: {
      listByOrganization: mockDevicesListByOrganization,
    },
  };

  return {
    mockOrganizationsList,
    mockOrganizationsGet,
    mockOrganizationsCreate,
    mockOrganizationsGetLocations,
    mockOrganizationsGetCustomFields,
    mockOrganizationsUpdateCustomFields,
    mockDevicesListByOrganization,
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
import { organizationsHandler } from "../../domains/organizations.js";

describe("Organizations Domain Handler", () => {
  beforeEach(() => {
    // Clear call history
    mockOrganizationsList.mockClear();
    mockOrganizationsGet.mockClear();
    mockOrganizationsCreate.mockClear();
    mockOrganizationsGetLocations.mockClear();
    mockOrganizationsGetCustomFields.mockClear();
    mockOrganizationsUpdateCustomFields.mockClear();
    mockDevicesListByOrganization.mockClear();

    // Reset mock implementations - list returns Organization[] directly
    mockOrganizationsList.mockResolvedValue([
      { id: 1, name: "Org 1" },
      { id: 2, name: "Org 2" },
    ]);
    mockOrganizationsGet.mockResolvedValue({
      id: 1,
      name: "Org 1",
      description: "Test organization",
    });
    mockOrganizationsCreate.mockResolvedValue({
      id: 100,
      name: "New Org",
    });
    mockOrganizationsGetLocations.mockResolvedValue({
      locations: [
        { id: 1, name: "Main Office" },
        { id: 2, name: "Branch Office" },
      ],
    });
    // devices.listByOrganization returns Device[] directly (raw NinjaOne
    // shape: nodeClass + offline boolean).
    mockDevicesListByOrganization.mockResolvedValue([
      { id: 1, systemName: "Device 1", nodeClass: "WINDOWS_SERVER", offline: false },
      { id: 2, systemName: "Device 2", nodeClass: "WINDOWS_WORKSTATION", offline: true },
    ]);
    mockOrganizationsGetCustomFields.mockResolvedValue({
      accountManager: "Jane Smith",
      contractType: "Managed Services",
    });
    mockOrganizationsUpdateCustomFields.mockResolvedValue(undefined);
  });

  describe("getTools", () => {
    it("should return all organization tools", () => {
      const tools = organizationsHandler.getTools();

      expect(tools.length).toBe(7);

      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain("ninjaone_organizations_list");
      expect(toolNames).toContain("ninjaone_organizations_get");
      expect(toolNames).toContain("ninjaone_organizations_create");
      expect(toolNames).toContain("ninjaone_organizations_locations");
      expect(toolNames).toContain("ninjaone_organizations_devices");
      expect(toolNames).toContain("ninjaone_organizations_get_custom_fields");
      expect(toolNames).toContain("ninjaone_organizations_update_custom_fields");
    });

    it("ninjaone_organizations_get should require organization_id", () => {
      const tools = organizationsHandler.getTools();
      const getTool = tools.find((t) => t.name === "ninjaone_organizations_get");

      expect(getTool).toBeDefined();
      expect(getTool?.inputSchema.required).toContain("organization_id");
    });

    it("ninjaone_organizations_devices should advertise NinjaOne node classes", () => {
      const tools = organizationsHandler.getTools();
      const devicesTool = tools.find((t) => t.name === "ninjaone_organizations_devices");
      const deviceClass = devicesTool?.inputSchema.properties?.device_class as
        | { enum?: string[] }
        | undefined;

      expect(deviceClass?.enum).toContain("LINUX_WORKSTATION");
      expect(deviceClass?.enum).toContain("LINUX_SERVER");
      expect(deviceClass?.enum).toContain("VMWARE_VM_HOST");
      expect(deviceClass?.enum).toContain("VMWARE_VM_GUEST");
      expect(deviceClass?.enum).toContain("NMS_SWITCH");
      expect(deviceClass?.enum).toContain("CLOUD_MONITOR_TARGET");
      expect(deviceClass?.enum).toContain("ANDROID");
      expect(deviceClass?.enum).toContain("AOSP");
      expect(deviceClass?.enum).not.toContain("LINUX");
      expect(deviceClass?.enum).not.toContain("VMWARE_VM");
      expect(deviceClass?.enum).not.toContain("NMS");
    });

    it("ninjaone_organizations_create should require name", () => {
      const tools = organizationsHandler.getTools();
      const createTool = tools.find((t) => t.name === "ninjaone_organizations_create");

      expect(createTool).toBeDefined();
      expect(createTool?.inputSchema.required).toContain("name");
    });
  });

  describe("handleCall", () => {
    describe("ninjaone_organizations_list", () => {
      it("should list organizations with default parameters", async () => {
        const result = await organizationsHandler.handleCall("ninjaone_organizations_list", {});

        expect(result.isError).toBeUndefined();
        expect(result.content[0].type).toBe("text");

        const data = JSON.parse(result.content[0].text);
        expect(data.organizations).toHaveLength(2);
      });
    });

    describe("ninjaone_organizations_get", () => {
      it("should get a single organization", async () => {
        const result = await organizationsHandler.handleCall("ninjaone_organizations_get", {
          organization_id: 1,
        });

        expect(result.isError).toBeUndefined();

        const data = JSON.parse(result.content[0].text);
        expect(data.id).toBe(1);
        expect(data.name).toBe("Org 1");
      });
    });

    describe("ninjaone_organizations_create", () => {
      it("should create an organization", async () => {
        const result = await organizationsHandler.handleCall("ninjaone_organizations_create", {
          name: "New Org",
          description: "New organization",
        });

        expect(result.isError).toBeUndefined();

        const data = JSON.parse(result.content[0].text);
        expect(data.id).toBe(100);
        expect(data.name).toBe("New Org");
      });
    });

    describe("ninjaone_organizations_locations", () => {
      it("should list organization locations", async () => {
        const result = await organizationsHandler.handleCall("ninjaone_organizations_locations", {
          organization_id: 1,
        });

        expect(result.isError).toBeUndefined();

        const data = JSON.parse(result.content[0].text);
        expect(data.locations).toHaveLength(2);
      });
    });

    describe("ninjaone_organizations_devices", () => {
      it("should list organization devices via devices.listByOrganization", async () => {
        const result = await organizationsHandler.handleCall("ninjaone_organizations_devices", {
          organization_id: 1,
        });

        expect(result.isError).toBeUndefined();
        expect(mockDevicesListByOrganization).toHaveBeenCalledWith(1, {
          pageSize: 50,
          after: undefined,
        });

        const data = JSON.parse(result.content[0].text);
        expect(data.devices).toHaveLength(2);
        expect(data.count).toBe(2);
        expect(data.hasMore).toBe(false);
        expect(data.cursor).toBeUndefined();
      });

      it("sends device_class upstream as df=class=MAC and does not return other classes", async () => {
        // Image 2.2.7 repro: organization 9, device_class MAC, limit 3 came
        // back as WINDOWS_SERVER because the class never left the handler.
        mockDevicesListByOrganization.mockResolvedValueOnce([
          { id: 11, systemName: "Srv-A", nodeClass: "WINDOWS_SERVER", offline: false },
          { id: 12, systemName: "Srv-B", nodeClass: "WINDOWS_SERVER", offline: false },
          { id: 13, systemName: "Mac-1", nodeClass: "MAC", offline: false },
        ]);

        const result = await organizationsHandler.handleCall("ninjaone_organizations_devices", {
          organization_id: 9,
          device_class: "MAC",
          limit: 3,
        });

        // listByOrganization copies `df` onto GET /v2/organization/{id}/devices.
        // A named nodeClass param is not what the API applies.
        expect(mockDevicesListByOrganization).toHaveBeenCalledWith(9, {
          pageSize: 3,
          after: undefined,
          df: "class=MAC",
        });
        const passed = mockDevicesListByOrganization.mock.calls[0][1] as Record<string, unknown>;
        expect(passed.nodeClass).toBeUndefined();

        const data = JSON.parse(result.content[0].text);
        expect(Array.isArray(data)).toBe(false);
        expect(data.devices.map((d: { nodeClass: string }) => d.nodeClass)).toEqual(["MAC"]);
        expect(data.count).toBe(1);
        expect(data.hasMore).toBe(true);
        expect(data.cursor).toBe("13");
      });

      it("forwards API node classes that are not the old shorthand values", async () => {
        await organizationsHandler.handleCall("ninjaone_organizations_devices", {
          organization_id: 7,
          device_class: "NMS_SWITCH",
        });

        expect(mockDevicesListByOrganization).toHaveBeenCalledWith(
          7,
          expect.objectContaining({ df: "class=NMS_SWITCH" }),
        );
      });

      it("should apply online to the returned page", async () => {
        const result = await organizationsHandler.handleCall("ninjaone_organizations_devices", {
          organization_id: 1,
          online: false,
        });

        expect(mockDevicesListByOrganization).toHaveBeenCalledWith(
          1,
          expect.objectContaining({ df: "offline" }),
        );

        const data = JSON.parse(result.content[0].text);
        expect(data.count).toBe(1);
        expect(data.devices[0].offline).toBe(true);
      });

      it("should page with after and report hasMore from the raw page", async () => {
        mockDevicesListByOrganization.mockResolvedValueOnce([
          { id: 10, systemName: "Wks", nodeClass: "WINDOWS_WORKSTATION", offline: false },
          { id: 20, systemName: "Srv", nodeClass: "WINDOWS_SERVER", offline: false },
        ]);

        const result = await organizationsHandler.handleCall("ninjaone_organizations_devices", {
          organization_id: 1,
          device_class: "WINDOWS_SERVER",
          limit: 2,
          cursor: "99",
        });

        expect(mockDevicesListByOrganization).toHaveBeenCalledWith(1, {
          pageSize: 2,
          after: 99,
          df: "class=WINDOWS_SERVER",
        });

        const data = JSON.parse(result.content[0].text);
        // One match in a full page is not the last page. Cursor is the max id
        // of the raw page, not the filtered subset.
        expect(data.count).toBe(1);
        expect(data.hasMore).toBe(true);
        expect(data.cursor).toBe("20");
      });

      it("uses the last device id as the cursor, not the max id", async () => {
        mockDevicesListByOrganization.mockResolvedValueOnce([
          { id: 30, systemName: "Later", nodeClass: "MAC", offline: false },
          { id: 10, systemName: "Earlier", nodeClass: "MAC", offline: false },
        ]);

        const result = await organizationsHandler.handleCall("ninjaone_organizations_devices", {
          organization_id: 9,
          limit: 2,
        });

        const data = JSON.parse(result.content[0].text);
        expect(data.cursor).toBe("10");
      });

      it("drops devices whose online state cannot be read when online is set", async () => {
        mockDevicesListByOrganization.mockResolvedValueOnce([
          { id: 1, systemName: "Known", nodeClass: "MAC", offline: false },
          { id: 2, systemName: "Unknown", nodeClass: "MAC" },
        ]);

        const result = await organizationsHandler.handleCall("ninjaone_organizations_devices", {
          organization_id: 9,
          online: true,
          limit: 2,
        });

        const data = JSON.parse(result.content[0].text);
        expect(data.devices.map((d: { systemName: string }) => d.systemName)).toEqual(["Known"]);
      });
    });

    describe("ninjaone_organizations_get_custom_fields", () => {
      it("should get organization custom fields", async () => {
        const result = await organizationsHandler.handleCall(
          "ninjaone_organizations_get_custom_fields",
          { organization_id: 1 },
        );

        expect(result.isError).toBeUndefined();
        expect(mockOrganizationsGetCustomFields).toHaveBeenCalledWith(1);

        const data = JSON.parse(result.content[0].text);
        expect(data.accountManager).toBe("Jane Smith");
      });
    });

    describe("ninjaone_organizations_update_custom_fields", () => {
      it("should update organization custom fields", async () => {
        const result = await organizationsHandler.handleCall(
          "ninjaone_organizations_update_custom_fields",
          { organization_id: 1, fields: { accountManager: "John Doe" } },
        );

        expect(result.isError).toBeUndefined();
        expect(mockOrganizationsUpdateCustomFields).toHaveBeenCalledWith(1, {
          accountManager: "John Doe",
        });

        const data = JSON.parse(result.content[0].text);
        expect(data.success).toBe(true);
      });
    });

    describe("unknown tool", () => {
      it("should return error for unknown tool", async () => {
        const result = await organizationsHandler.handleCall("ninjaone_organizations_unknown", {});

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Unknown organization tool");
      });
    });
  });
});
