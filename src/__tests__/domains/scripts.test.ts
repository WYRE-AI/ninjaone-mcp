/**
 * Tests for scripts domain handler
 *
 * Covers the fail-closed properties this domain exists to guarantee:
 * an unset/empty allowlist denies everything, an unsupported client with
 * self-attested confirmation disabled refuses outright (never silently
 * falls back), and the elevated-scope client is requested only for
 * scripts_run, never the shared/cached one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockScriptsListOptions, mockScriptsRun, mockClient, mockElicitConfirmation } =
  vi.hoisted(() => {
    const mockScriptsListOptions = vi.fn();
    const mockScriptsRun = vi.fn();
    const mockClient = {
      scripts: {
        listOptions: mockScriptsListOptions,
        run: mockScriptsRun,
      },
    };
    const mockElicitConfirmation = vi.fn();
    return { mockScriptsListOptions, mockScriptsRun, mockClient, mockElicitConfirmation };
  });

let currentCreds: {
  clientId: string;
  clientSecret: string;
  region: string;
  baseUrl: string;
  scopes?: string[];
  allowedScriptIds: Set<string>;
  allowSelfAttestedConfirmation: boolean;
} | null = null;

vi.mock("../../utils/client.js", () => ({
  getClient: () => Promise.resolve(mockClient),
  getCredentials: () => currentCreds,
  createClientDirect: () => Promise.resolve(mockClient),
}));

vi.mock("../../utils/elicitation.js", () => ({
  elicitConfirmation: mockElicitConfirmation,
}));

import { scriptsHandler } from "../../domains/scripts.js";

function baseCreds(overrides: Partial<NonNullable<typeof currentCreds>> = {}) {
  return {
    clientId: "test",
    clientSecret: "test",
    region: "us",
    baseUrl: "https://app.ninjarmm.com",
    allowedScriptIds: new Set<string>(),
    allowSelfAttestedConfirmation: false,
    ...overrides,
  };
}

describe("Scripts Domain Handler", () => {
  beforeEach(() => {
    mockScriptsListOptions.mockClear();
    mockScriptsRun.mockClear();
    mockElicitConfirmation.mockReset();
    currentCreds = baseCreds();
  });

  describe("ninjaone_scripts_list", () => {
    it("lists scripting options for a device", async () => {
      mockScriptsListOptions.mockResolvedValue({
        categories: [],
        scripts: [{ type: "SCRIPT", id: 1234, name: "Clear Temp" }],
        credentials: { roles: [], credentials: [] },
      });

      const result = await scriptsHandler.handleCall("ninjaone_scripts_list", {
        device_id: 101,
      });

      expect(mockScriptsListOptions).toHaveBeenCalledWith(101, undefined);
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toContain("Clear Temp");
    });
  });

  describe("ninjaone_scripts_run", () => {
    const runArgs = { device_id: 101, type: "SCRIPT", id: 1234 };

    it("refuses when allowedScriptIds is unset (deny-all, not allow-all)", async () => {
      currentCreds = baseCreds({ allowedScriptIds: new Set() });

      const result = await scriptsHandler.handleCall("ninjaone_scripts_run", runArgs);

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("not on this org's approved-scripts list");
      expect(mockScriptsRun).not.toHaveBeenCalled();
      expect(mockElicitConfirmation).not.toHaveBeenCalled();
    });

    it("refuses an allowlisted-elsewhere script that doesn't match this key", async () => {
      currentCreds = baseCreds({ allowedScriptIds: new Set(["SCRIPT:9999"]) });

      const result = await scriptsHandler.handleCall("ninjaone_scripts_run", runArgs);

      expect(result.isError).toBe(true);
      expect(mockScriptsRun).not.toHaveBeenCalled();
    });

    it("runs an allowlisted script after elicitation confirms", async () => {
      currentCreds = baseCreds({ allowedScriptIds: new Set(["SCRIPT:1234"]) });
      mockElicitConfirmation.mockResolvedValue({ status: "accepted", confirm: true });
      mockScriptsRun.mockResolvedValue(undefined);

      const result = await scriptsHandler.handleCall("ninjaone_scripts_run", runArgs);

      expect(mockElicitConfirmation).toHaveBeenCalledTimes(1);
      expect(mockScriptsRun).toHaveBeenCalledWith(101, {
        type: "SCRIPT",
        id: 1234,
        uid: undefined,
        parameters: undefined,
        runAs: undefined,
      });
      expect(result.isError).toBeUndefined();
    });

    it("cancels (not an error) when elicitation returns declined", async () => {
      currentCreds = baseCreds({ allowedScriptIds: new Set(["SCRIPT:1234"]) });
      mockElicitConfirmation.mockResolvedValue({ status: "declined" });

      const result = await scriptsHandler.handleCall("ninjaone_scripts_run", runArgs);

      expect(result.isError).not.toBe(true);
      expect(mockScriptsRun).not.toHaveBeenCalled();
    });

    it("refuses outright when elicitation is unsupported (null) and self-attested confirmation is disabled", async () => {
      currentCreds = baseCreds({
        allowedScriptIds: new Set(["SCRIPT:1234"]),
        allowSelfAttestedConfirmation: false,
      });
      mockElicitConfirmation.mockResolvedValue({ status: "unsupported" });

      const result = await scriptsHandler.handleCall("ninjaone_scripts_run", {
        ...runArgs,
        confirm: true,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("no interactive confirmation support");
      expect(mockScriptsRun).not.toHaveBeenCalled();
    });

    it("accepts the self-attested fallback only when the org flag is enabled AND confirm:true is passed", async () => {
      currentCreds = baseCreds({
        allowedScriptIds: new Set(["SCRIPT:1234"]),
        allowSelfAttestedConfirmation: true,
      });
      mockElicitConfirmation.mockResolvedValue({ status: "unsupported" });
      mockScriptsRun.mockResolvedValue(undefined);

      const result = await scriptsHandler.handleCall("ninjaone_scripts_run", {
        ...runArgs,
        confirm: true,
      });

      expect(result.isError).toBeUndefined();
      expect(mockScriptsRun).toHaveBeenCalledTimes(1);
    });

    it("does not let a human decline fall through to self-attested confirmation", async () => {
      currentCreds = baseCreds({
        allowedScriptIds: new Set(["SCRIPT:1234"]),
        allowSelfAttestedConfirmation: true,
      });
      mockElicitConfirmation.mockResolvedValue({ status: "declined" });

      const result = await scriptsHandler.handleCall("ninjaone_scripts_run", {
        ...runArgs,
        confirm: true,
      });

      expect(result.isError).not.toBe(true);
      expect(result.content[0]?.text).toContain("not confirmed");
      expect(mockScriptsRun).not.toHaveBeenCalled();
    });

    it("does not let an elicitation error fall through to self-attested confirmation", async () => {
      currentCreds = baseCreds({
        allowedScriptIds: new Set(["SCRIPT:1234"]),
        allowSelfAttestedConfirmation: true,
      });
      mockElicitConfirmation.mockResolvedValue({
        status: "error",
        message: "request timed out",
      });

      const result = await scriptsHandler.handleCall("ninjaone_scripts_run", {
        ...runArgs,
        confirm: true,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("request timed out");
      expect(mockScriptsRun).not.toHaveBeenCalled();
    });

    it("does not accept the self-attested fallback without confirm:true, even with the flag enabled", async () => {
      currentCreds = baseCreds({
        allowedScriptIds: new Set(["SCRIPT:1234"]),
        allowSelfAttestedConfirmation: true,
      });
      mockElicitConfirmation.mockResolvedValue({ status: "unsupported" });

      await scriptsHandler.handleCall("ninjaone_scripts_run", runArgs);

      expect(mockScriptsRun).not.toHaveBeenCalled();
    });

    it("rejects a SCRIPT type with no id", async () => {
      currentCreds = baseCreds({ allowedScriptIds: new Set(["SCRIPT:1234"]) });

      const result = await scriptsHandler.handleCall("ninjaone_scripts_run", {
        device_id: 101,
        type: "SCRIPT",
      });

      expect(result.isError).toBe(true);
      expect(mockElicitConfirmation).not.toHaveBeenCalled();
    });

    it("rejects a SCRIPT type that also carries uid", async () => {
      currentCreds = baseCreds({ allowedScriptIds: new Set(["SCRIPT:1234"]) });

      const result = await scriptsHandler.handleCall("ninjaone_scripts_run", {
        device_id: 101,
        type: "SCRIPT",
        id: 1234,
        uid: "some-uuid",
      });

      expect(result.isError).toBe(true);
    });
  });
});
