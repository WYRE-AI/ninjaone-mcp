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
    // devices.listByOrganization returns Device[] directly
    mockDevicesListByOrganization.mockResolvedValue([
      { id: 1, systemName: "Device 1" },
      { id: 2, systemName: "Device 2" },
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
        });

        const data = JSON.parse(result.content[0].text);
        expect(data).toHaveLength(2);
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
