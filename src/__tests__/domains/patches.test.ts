/**
 * Tests for the read-only patches domain handler
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockHttpRequest, mockListByOrganization, mockClient } = vi.hoisted(() => {
  const mockHttpRequest = vi.fn();
  const mockListByOrganization = vi.fn();
  const mockClient = {
    devices: { listByOrganization: mockListByOrganization },
    // The SDK marks httpClient TypeScript-private, not #private, so the
    // documented patch endpoints it does not implement are reached through it.
    httpClient: { request: mockHttpRequest },
  };
  return { mockHttpRequest, mockListByOrganization, mockClient };
});

vi.mock("../../utils/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/client.js")>();
  return {
    ...actual,
    getClient: () => Promise.resolve(mockClient),
  };
});

import { patchesHandler } from "../../domains/patches.js";
import { organizationDeviceIds } from "../../utils/device-filters.js";

const TOOL_NAMES = [
  "ninjaone_patches_os_list",
  "ninjaone_patches_software_list",
  "ninjaone_patches_os_installs_list",
  "ninjaone_patches_software_installs_list",
];

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function rows(deviceIds: number[]) {
  return deviceIds.map((deviceId, i) => ({
    id: `patch-${i}`,
    name: `KB${5000000 + i}`,
    severity: "CRITICAL",
    status: "MANUAL",
    deviceId,
  }));
}

describe("Patches Domain Handler", () => {
  beforeEach(() => {
    mockHttpRequest.mockResolvedValue({ cursor: { name: "c1" }, results: rows([1, 2]) });
    mockListByOrganization.mockResolvedValue([{ id: 1 }, { id: 2 }]);
  });

  describe("getTools", () => {
    it("exposes exactly the four read-only report tools", () => {
      const tools = patchesHandler.getTools();

      expect(tools.map((t) => t.name)).toEqual(TOOL_NAMES);
      for (const tool of tools) {
        expect(tool.description).toMatch(/^Read-only\./);
        expect(tool.inputSchema.properties).not.toHaveProperty("confirm");
      }
    });

    it("only offers filters the vendor endpoint documents", () => {
      const props = Object.fromEntries(
        patchesHandler.getTools().map((t) => [t.name, Object.keys(t.inputSchema.properties ?? {})])
      );

      expect(props.ninjaone_patches_os_list).toContain("severity");
      expect(props.ninjaone_patches_os_list).not.toContain("impact");
      expect(props.ninjaone_patches_software_list).toContain("impact");
      expect(props.ninjaone_patches_software_list).not.toContain("severity");
      expect(props.ninjaone_patches_os_installs_list).toEqual(
        expect.arrayContaining(["status", "installed_after", "installed_before"])
      );
    });
  });

  describe("fleet-wide reports", () => {
    it("queries /v2/queries/os-patches with the filter and page size, without df", async () => {
      mockHttpRequest.mockResolvedValue({ results: rows([1, 2]) });

      const result = await patchesHandler.handleCall("ninjaone_patches_os_list", {
        severity: "CRITICAL",
      });

      expect(result.isError).toBeUndefined();
      expect(mockHttpRequest).toHaveBeenCalledTimes(1);
      const [path, options] = mockHttpRequest.mock.calls[0];
      expect(path).toBe("/api/v2/queries/os-patches");
      expect(options).toEqual({ params: { pageSize: 100, severity: "CRITICAL" } });
      expect(options.params).not.toHaveProperty("df");

      const body = parse(result);
      expect(body.patches).toHaveLength(2);
      expect(body.count).toBe(2);
      expect(body.scanned).toBe(2);
      expect(body.hasMore).toBe(false);
      expect(body.cursor).toBeUndefined();
    });

    it("reports hasMore and the next cursor on a full page, and forwards cursor", async () => {
      mockHttpRequest.mockResolvedValue({ cursor: { name: "next-c" }, results: rows([1, 2]) });

      const result = await patchesHandler.handleCall("ninjaone_patches_os_list", {
        limit: 2,
        cursor: "prev-c",
      });

      expect(mockHttpRequest).toHaveBeenCalledWith("/api/v2/queries/os-patches", {
        params: { pageSize: 2, cursor: "prev-c" },
      });
      const body = parse(result);
      expect(body.hasMore).toBe(true);
      expect(body.cursor).toBe("next-c");
    });

    it("does not report hasMore on a full page without a cursor name", async () => {
      mockHttpRequest.mockResolvedValue({ results: rows([1, 2]) });

      const body = parse(
        await patchesHandler.handleCall("ninjaone_patches_os_list", { limit: 2 })
      );

      expect(body.hasMore).toBe(false);
      expect(body.cursor).toBeUndefined();
    });

    it("reports hasMore on a short page with a cursor, in case NinjaOne capped pageSize", async () => {
      mockHttpRequest.mockResolvedValue({ cursor: { name: "c2" }, results: rows([1, 2]) });

      const body = parse(
        await patchesHandler.handleCall("ninjaone_patches_os_list", { limit: 500 })
      );

      expect(body.hasMore).toBe(true);
      expect(body.cursor).toBe("c2");
    });

    it("stops on an empty page even when NinjaOne still returns a cursor", async () => {
      mockHttpRequest.mockResolvedValue({ cursor: { name: "c3" }, results: [] });

      const body = parse(
        await patchesHandler.handleCall("ninjaone_patches_os_list", { cursor: "c3" })
      );

      expect(body).toMatchObject({ patches: [], count: 0, scanned: 0, hasMore: false });
      expect(body.cursor).toBeUndefined();
    });

    it("keeps hasMore when the organization filter drops every row of the page", async () => {
      mockHttpRequest.mockResolvedValue({ cursor: { name: "c4" }, results: rows([8, 9]) });

      const body = parse(
        await patchesHandler.handleCall("ninjaone_patches_os_list", {
          organization_id: 7,
          limit: 2,
        })
      );

      expect(body).toMatchObject({ patches: [], count: 0, scanned: 2, hasMore: true, cursor: "c4" });
    });

    it("treats an empty body ({}) as an empty page", async () => {
      mockHttpRequest.mockResolvedValue({});

      const result = await patchesHandler.handleCall("ninjaone_patches_os_list", {});

      expect(result.isError).toBeUndefined();
      expect(parse(result)).toMatchObject({ patches: [], count: 0, hasMore: false });
    });

    it.each([
      [[{ deviceId: 1 }]],
      [{ cursor: { name: "c1" }, items: [{ deviceId: 1 }] }],
      [{ results: "none" }],
      ["unexpected"],
    ])("returns an error, not zero rows, for an unexpected body (%o)", async (response) => {
      mockHttpRequest.mockResolvedValue(response);

      const result = await patchesHandler.handleCall("ninjaone_patches_os_list", {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        "Unexpected response from GET /api/v2/queries/os-patches"
      );
    });

    it.each([[""], [3]])("rejects cursor %o without calling NinjaOne", async (cursor) => {
      const result = await patchesHandler.handleCall("ninjaone_patches_os_list", { cursor });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("cursor must be a non-empty string");
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });

    it("maps every software install filter on the fleet-wide report", async () => {
      await patchesHandler.handleCall("ninjaone_patches_software_installs_list", {
        status: "FAILED",
        type: "PATCH",
        impact: "CRITICAL",
        product_identifier: "6f1c1e9c-0000-4000-8000-000000000001",
        installed_after: "2026-09-22",
        installed_before: "2026-10-22T08:00:00Z",
        organization_id: 7,
        cursor: "c5",
        limit: 250,
      });

      expect(mockHttpRequest).toHaveBeenCalledWith("/api/v2/queries/software-patch-installs", {
        params: {
          status: "FAILED",
          type: "PATCH",
          impact: "CRITICAL",
          productIdentifier: "6f1c1e9c-0000-4000-8000-000000000001",
          installedAfter: 1790035200,
          installedBefore: 1792656000,
          pageSize: 250,
          df: "org=7",
          cursor: "c5",
        },
      });
    });

    it("clamps limit to 1-1000", async () => {
      await patchesHandler.handleCall("ninjaone_patches_os_list", { limit: 5000 });
      await patchesHandler.handleCall("ninjaone_patches_os_list", { limit: -3 });

      expect(mockHttpRequest.mock.calls[0][1].params.pageSize).toBe(1000);
      expect(mockHttpRequest.mock.calls[1][1].params.pageSize).toBe(1);
    });

    it("sends df=org and drops rows for devices outside the organization", async () => {
      mockHttpRequest.mockResolvedValue({ cursor: { name: "c1" }, results: rows([1, 2, 3]) });

      const result = await patchesHandler.handleCall("ninjaone_patches_os_list", {
        organization_id: 7,
      });

      expect(mockHttpRequest).toHaveBeenCalledWith("/api/v2/queries/os-patches", {
        params: { pageSize: 100, df: "org=7" },
      });
      expect(mockListByOrganization).toHaveBeenCalledWith(7, {
        pageSize: 1000,
        after: undefined,
      });
      const body = parse(result);
      expect(body.patches.map((p: { deviceId: number }) => p.deviceId)).toEqual([1, 2]);
      expect(body.count).toBe(2);
      expect(body.scanned).toBe(3);
    });

    it("skips the organization device lookup when the page is empty", async () => {
      mockHttpRequest.mockResolvedValue({ results: [] });

      const body = parse(
        await patchesHandler.handleCall("ninjaone_patches_os_list", { organization_id: 7 })
      );

      expect(mockListByOrganization).not.toHaveBeenCalled();
      expect(body).toMatchObject({ patches: [], count: 0, scanned: 0, hasMore: false });
    });

    it("rejects a non-integer organization_id without calling NinjaOne", async () => {
      const result = await patchesHandler.handleCall("ninjaone_patches_os_list", {
        organization_id: "7",
      });

      expect(result.isError).toBe(true);
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });
  });

  describe("organizationDeviceIds", () => {
    it("pages GET /v2/organization/{id}/devices by the last device id", async () => {
      const firstPage = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1 }));
      mockListByOrganization
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValueOnce([{ id: 1001 }]);

      const ids = await organizationDeviceIds(mockClient as never, 7);

      expect(mockListByOrganization).toHaveBeenCalledTimes(2);
      expect(mockListByOrganization.mock.calls[1]).toEqual([7, { pageSize: 1000, after: 1000 }]);
      expect(ids.size).toBe(1001);
      expect(ids.has(1001)).toBe(true);
    });

    it("fails rather than return a partial set if a full page does not advance", async () => {
      const page = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1 }));
      mockListByOrganization.mockResolvedValue(page);

      await expect(organizationDeviceIds(mockClient as never, 7)).rejects.toThrow(
        "did not page past device 1000"
      );
      expect(mockListByOrganization).toHaveBeenCalledTimes(2);
    });
  });

  describe("per-device reports", () => {
    it("queries /v2/device/{id}/os-patches with only the filter params", async () => {
      mockHttpRequest.mockResolvedValue(rows([42, 42, 42]));

      const result = await patchesHandler.handleCall("ninjaone_patches_os_list", {
        device_id: 42,
        status: "FAILED",
      });

      expect(mockHttpRequest).toHaveBeenCalledWith("/api/v2/device/42/os-patches", {
        params: { status: "FAILED" },
      });
      expect(mockListByOrganization).not.toHaveBeenCalled();
      const body = parse(result);
      expect(body.deviceId).toBe(42);
      expect(body.count).toBe(3);
      expect(body.patches).toHaveLength(3);
    });

    it("treats an empty body ({}) as no patches", async () => {
      mockHttpRequest.mockResolvedValue({});

      const body = parse(
        await patchesHandler.handleCall("ninjaone_patches_os_list", { device_id: 42 })
      );

      expect(body).toEqual({ deviceId: 42, patches: [], count: 0 });
    });

    it("returns an error, not zero patches, for a non-array body", async () => {
      mockHttpRequest.mockResolvedValue({ results: rows([42]) });

      const result = await patchesHandler.handleCall("ninjaone_patches_os_list", {
        device_id: 42,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        "Unexpected response from GET /api/v2/device/42/os-patches"
      );
    });

    it.each([
      [{ device_id: 42, organization_id: 7 }],
      [{ device_id: 42, cursor: "c1" }],
    ])("refuses device_id combined with organization_id or cursor (%o)", async (args) => {
      const result = await patchesHandler.handleCall("ninjaone_patches_os_list", args);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("already scoped to one device");
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });

    it.each([0, -1, 1.5, "42"])("rejects device_id %o without calling NinjaOne", async (id) => {
      const result = await patchesHandler.handleCall("ninjaone_patches_os_list", {
        device_id: id,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("device_id must be a positive integer");
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });
  });

  describe("filters", () => {
    it("sends installed_after as Unix epoch seconds and passes status through", async () => {
      await patchesHandler.handleCall("ninjaone_patches_os_installs_list", {
        status: "INSTALLED",
        installed_after: "2026-09-22",
      });

      expect(mockHttpRequest).toHaveBeenCalledWith("/api/v2/queries/os-patch-installs", {
        params: {
          pageSize: 100,
          status: "INSTALLED",
          installedAfter: Math.floor(Date.parse("2026-09-22") / 1000),
        },
      });
      expect(Math.floor(Date.parse("2026-09-22") / 1000)).toBe(1790035200);
    });

    it("sends installed_before on the per-device install report", async () => {
      mockHttpRequest.mockResolvedValue([]);

      await patchesHandler.handleCall("ninjaone_patches_software_installs_list", {
        device_id: 9,
        installed_before: "2026-10-01T12:00:00Z",
      });

      expect(mockHttpRequest).toHaveBeenCalledWith("/api/v2/device/9/software-patch-installs", {
        params: { installedBefore: Math.floor(Date.parse("2026-10-01T12:00:00Z") / 1000) },
      });
    });

    it.each([
      "last tuesday",
      "0",
      "-1",
      "2026/09/22",
      "Sept 22 2026",
      "2026-02-30",
      "2026-09-22T10:00",
      "2026-09-22T25:00Z",
    ])("rejects %o as not a strict ISO-8601 date without calling NinjaOne", async (value) => {
      const result = await patchesHandler.handleCall("ninjaone_patches_os_installs_list", {
        installed_after: value,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("installed_after must be an ISO-8601 date");
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });

    it("honours an explicit offset on a date-time", async () => {
      await patchesHandler.handleCall("ninjaone_patches_os_installs_list", {
        installed_after: "2026-09-22T10:00:00+02:00",
      });

      expect(mockHttpRequest.mock.calls[0][1].params.installedAfter).toBe(
        Date.UTC(2026, 8, 22, 8) / 1000
      );
    });

    it("rejects a non-string filter value without calling NinjaOne", async () => {
      const result = await patchesHandler.handleCall("ninjaone_patches_os_list", {
        severity: 3,
      });

      expect(result.isError).toBe(true);
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });

    it("maps product_identifier to productIdentifier and ignores filters the report lacks", async () => {
      await patchesHandler.handleCall("ninjaone_patches_software_list", {
        product_identifier: "6f1c1e9c-0000-4000-8000-000000000001",
        impact: "CRITICAL",
        severity: "CRITICAL",
      });

      expect(mockHttpRequest).toHaveBeenCalledWith("/api/v2/queries/software-patches", {
        params: {
          pageSize: 100,
          impact: "CRITICAL",
          productIdentifier: "6f1c1e9c-0000-4000-8000-000000000001",
        },
      });
    });
  });

  describe("errors", () => {
    it("propagates an upstream failure so the server formats it", async () => {
      mockHttpRequest.mockRejectedValue(new Error("403 Forbidden"));

      await expect(
        patchesHandler.handleCall("ninjaone_patches_software_installs_list", {})
      ).rejects.toThrow("403 Forbidden");
    });

    it("returns an error for an unknown tool", async () => {
      const result = await patchesHandler.handleCall("ninjaone_patches_apply", {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown patches tool");
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });
  });
});
