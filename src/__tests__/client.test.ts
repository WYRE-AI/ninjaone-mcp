/**
 * Tests for lazy-loaded NinjaOne client
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getCredentials, getClient, clearClient } from "../utils/client.js";

// Mock the node-ninjaone library
vi.mock("@wyre-technology/node-ninjaone", () => ({
  NinjaOneClient: vi.fn().mockImplementation(function (config) { return ({
    config,
    devices: {
      list: vi.fn(),
      get: vi.fn(),
      reboot: vi.fn(),
      getServices: vi.fn(),
      getAlerts: vi.fn(),
      getActivities: vi.fn(),
    },
    organizations: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      getLocations: vi.fn(),
      getDevices: vi.fn(),
    },
    alerts: {
      list: vi.fn(),
      reset: vi.fn(),
      resetAll: vi.fn(),
      getSummary: vi.fn(),
    },
    tickets: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      addComment: vi.fn(),
      getComments: vi.fn(),
    },
  }) }),
}));

describe("NinjaOne Client Utilities", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment variables before each test
    process.env = { ...originalEnv };
    clearClient();
  });

  afterEach(() => {
    process.env = originalEnv;
    clearClient();
  });

  describe("getCredentials", () => {
    it("should return null when no credentials are set", () => {
      delete process.env.NINJAONE_CLIENT_ID;
      delete process.env.NINJAONE_CLIENT_SECRET;
      delete process.env.NINJAONE_REGION;

      const creds = getCredentials();
      expect(creds).toBeNull();
    });

    it("should return null when client ID is missing", () => {
      delete process.env.NINJAONE_CLIENT_ID;
      process.env.NINJAONE_CLIENT_SECRET = "test-secret";
      process.env.NINJAONE_REGION = "us";

      const creds = getCredentials();
      expect(creds).toBeNull();
    });

    it("should return null when client secret is missing", () => {
      process.env.NINJAONE_CLIENT_ID = "test-id";
      delete process.env.NINJAONE_CLIENT_SECRET;
      process.env.NINJAONE_REGION = "us";

      const creds = getCredentials();
      expect(creds).toBeNull();
    });

    it("should fall back to US region for an invalid region", () => {
      process.env.NINJAONE_CLIENT_ID = "test-id";
      process.env.NINJAONE_CLIENT_SECRET = "test-secret";
      process.env.NINJAONE_REGION = "invalid";

      const creds = getCredentials();
      expect(creds).toEqual({
        clientId: "test-id",
        clientSecret: "test-secret",
        region: "us",
        baseUrl: "https://app.ninjarmm.com",
      });
    });

    // Regression: MCPB/DXT desktop bundles map NINJAONE_REGION to
    // "${user_config.ninjaone_region}". When this OPTIONAL field is left blank,
    // Claude Desktop injects the LITERAL placeholder string (truthy, not empty),
    // which used to bypass the `|| "us"` default, fail isValidRegion(), and make
    // getCredentials() return null — surfacing as "No API credentials provided"
    // on every tool call and misdirecting the user to their (correct) credentials.
    it("should treat an unresolved config placeholder region as US (not null)", () => {
      process.env.NINJAONE_CLIENT_ID = "test-id";
      process.env.NINJAONE_CLIENT_SECRET = "test-secret";
      process.env.NINJAONE_REGION = "${user_config.ninjaone_region}";

      const creds = getCredentials();
      expect(creds).not.toBeNull();
      expect(creds).toEqual({
        clientId: "test-id",
        clientSecret: "test-secret",
        region: "us",
        baseUrl: "https://app.ninjarmm.com",
      });
    });

    it("should fall back to US region for a blank or whitespace region", () => {
      process.env.NINJAONE_CLIENT_ID = "test-id";
      process.env.NINJAONE_CLIENT_SECRET = "test-secret";

      for (const value of ["", "   "]) {
        process.env.NINJAONE_REGION = value;
        expect(getCredentials()).toEqual({
          clientId: "test-id",
          clientSecret: "test-secret",
          region: "us",
          baseUrl: "https://app.ninjarmm.com",
        });
      }
    });

    it("should return credentials with default US region", () => {
      process.env.NINJAONE_CLIENT_ID = "test-id";
      process.env.NINJAONE_CLIENT_SECRET = "test-secret";
      delete process.env.NINJAONE_REGION;

      const creds = getCredentials();
      expect(creds).toEqual({
        clientId: "test-id",
        clientSecret: "test-secret",
        region: "us",
        baseUrl: "https://app.ninjarmm.com",
      });
    });

    it("should return credentials with EU region", () => {
      process.env.NINJAONE_CLIENT_ID = "test-id";
      process.env.NINJAONE_CLIENT_SECRET = "test-secret";
      process.env.NINJAONE_REGION = "eu";

      const creds = getCredentials();
      expect(creds).toEqual({
        clientId: "test-id",
        clientSecret: "test-secret",
        region: "eu",
        baseUrl: "https://eu.ninjarmm.com",
      });
    });

    it("should return credentials with OC region", () => {
      process.env.NINJAONE_CLIENT_ID = "test-id";
      process.env.NINJAONE_CLIENT_SECRET = "test-secret";
      process.env.NINJAONE_REGION = "oc";

      const creds = getCredentials();
      expect(creds).toEqual({
        clientId: "test-id",
        clientSecret: "test-secret",
        region: "oc",
        baseUrl: "https://oc.ninjarmm.com",
      });
    });

    it("should handle case-insensitive region", () => {
      process.env.NINJAONE_CLIENT_ID = "test-id";
      process.env.NINJAONE_CLIENT_SECRET = "test-secret";
      process.env.NINJAONE_REGION = "EU";

      const creds = getCredentials();
      expect(creds).toEqual({
        clientId: "test-id",
        clientSecret: "test-secret",
        region: "eu",
        baseUrl: "https://eu.ninjarmm.com",
      });
    });
  });

  describe("getClient", () => {
    it("should throw error when no credentials are configured", async () => {
      delete process.env.NINJAONE_CLIENT_ID;
      delete process.env.NINJAONE_CLIENT_SECRET;
      delete process.env.NINJAONE_REGION;

      await expect(getClient()).rejects.toThrow(
        "No API credentials provided"
      );
    });

    it("should create client when valid credentials are provided", async () => {
      process.env.NINJAONE_CLIENT_ID = "test-id";
      process.env.NINJAONE_CLIENT_SECRET = "test-secret";
      process.env.NINJAONE_REGION = "us";

      const client = await getClient();
      expect(client).toBeDefined();
      expect(client.devices).toBeDefined();
      expect(client.organizations).toBeDefined();
      expect(client.alerts).toBeDefined();
      expect(client.tickets).toBeDefined();
    });

    it("should return cached client on subsequent calls", async () => {
      process.env.NINJAONE_CLIENT_ID = "test-id";
      process.env.NINJAONE_CLIENT_SECRET = "test-secret";
      process.env.NINJAONE_REGION = "us";

      const client1 = await getClient();
      const client2 = await getClient();

      expect(client1).toBe(client2);
    });

    it("should create new client when credentials change", async () => {
      process.env.NINJAONE_CLIENT_ID = "test-id-1";
      process.env.NINJAONE_CLIENT_SECRET = "test-secret";
      process.env.NINJAONE_REGION = "us";

      const client1 = await getClient();

      // Change credentials
      process.env.NINJAONE_CLIENT_ID = "test-id-2";
      clearClient();

      const client2 = await getClient();

      expect(client1).not.toBe(client2);
    });

    // Regression: before the fix, a left-blank optional region arrived as the
    // literal "${user_config.ninjaone_region}", failed region validation, made
    // getCredentials() return null, and getClient() rejected with
    // "No API credentials provided" on every tool call. It must now resolve.
    it("should not reject with the credentials error when the region is an unresolved placeholder", async () => {
      process.env.NINJAONE_CLIENT_ID = "test-id";
      process.env.NINJAONE_CLIENT_SECRET = "test-secret";
      process.env.NINJAONE_REGION = "${user_config.ninjaone_region}";

      let caught: unknown;
      try {
        await getClient();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeUndefined();
    });
  });

  describe("clearClient", () => {
    it("should clear cached client", async () => {
      process.env.NINJAONE_CLIENT_ID = "test-id";
      process.env.NINJAONE_CLIENT_SECRET = "test-secret";
      process.env.NINJAONE_REGION = "us";

      const client1 = await getClient();
      clearClient();
      const client2 = await getClient();

      expect(client1).not.toBe(client2);
    });
  });
});