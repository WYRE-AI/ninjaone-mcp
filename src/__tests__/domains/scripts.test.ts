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
import {
  runWithScriptCaller,
  type ScriptCallerAuth,
} from "../../utils/script-caller.js";
import { NinjaOneServerError } from "@wyre-ai/node-ninjaone";

function callRun(
  args: Record<string, unknown>,
  caller?: ScriptCallerAuth
): Promise<Awaited<ReturnType<typeof scriptsHandler.handleCall>>> {
  const exec = () => scriptsHandler.handleCall("ninjaone_scripts_run", args);
  return caller ? runWithScriptCaller(caller, exec) : exec();
}

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

    it.each([
      ["missing", { type: "SCRIPT" }],
      ["null", { device_id: null, type: "SCRIPT", id: 1234 }],
      ["a numeric string", { device_id: "101", type: "SCRIPT", id: 1234 }],
      ["a fraction", { device_id: 1.5, type: "SCRIPT", id: 1234 }],
      ["zero", { device_id: 0, type: "SCRIPT", id: 1234 }],
      ["negative", { device_id: -3, type: "SCRIPT", id: 1234 }],
    ])(
      "rejects a %s device_id before pairing, auth, audit, or the vendor call",
      async (_label, args) => {
        currentCreds = baseCreds({ allowedScriptIds: new Set(["SCRIPT:1234"]) });
        mockElicitConfirmation.mockResolvedValue({ status: "accepted", confirm: true });
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        const result = await callRun(
          { ...args, confirm: true },
          { effect: "deny", reason: "unauthenticated" }
        );

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("device_id must be a positive integer");
        expect(result.content[0]?.text).not.toContain("not on this org's approved-scripts list");
        expect(result.content[0]?.text).not.toContain("no authenticated caller");
        expect(result.content[0]?.text).not.toContain("type is SCRIPT");
        expect(mockElicitConfirmation).not.toHaveBeenCalled();
        expect(mockScriptsRun).not.toHaveBeenCalled();
        expect(errorSpy.mock.calls.join("\n")).not.toContain("AUDIT scripts_run");
        errorSpy.mockRestore();
      }
    );

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

      const parameters = "line1\n--force";
      const result = await scriptsHandler.handleCall("ninjaone_scripts_run", {
        ...runArgs,
        parameters,
        run_as: "LOCAL_ADMIN",
      });

      expect(mockElicitConfirmation).toHaveBeenCalledTimes(1);
      const prompt = mockElicitConfirmation.mock.calls[0]?.[0] as string;
      expect(prompt).toContain("Device: 101");
      expect(prompt).toContain("Script: SCRIPT:1234");
      expect(prompt).toContain("Parameters: line1\\n--force");
      expect(prompt).not.toContain("\n--force");
      expect(prompt).toContain("Run as: LOCAL_ADMIN");
      expect(mockScriptsRun).toHaveBeenCalledWith(101, {
        type: "SCRIPT",
        id: 1234,
        uid: undefined,
        parameters,
        runAs: "LOCAL_ADMIN",
      });
      expect(result.isError).toBeUndefined();
    });

    it("records the upstream statusCode in the audit log when the vendor call fails with a NinjaOneError, and rethrows", async () => {
      currentCreds = baseCreds({ allowedScriptIds: new Set(["SCRIPT:1234"]) });
      mockElicitConfirmation.mockResolvedValue({ status: "accepted", confirm: true });
      const vendorError = new NinjaOneServerError("upstream exploded", 503);
      mockScriptsRun.mockRejectedValue(vendorError);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(scriptsHandler.handleCall("ninjaone_scripts_run", runArgs)).rejects.toBe(
        vendorError
      );

      const auditLine = errorSpy.mock.calls
        .map((call) => call.join(" "))
        .find((line) => line.includes("AUDIT scripts_run"));
      expect(auditLine).toContain('"outcome":"failed"');
      expect(auditLine).toContain('"statusCode":503');
      errorSpy.mockRestore();
    });

    it("omits statusCode when the vendor call fails with a non-NinjaOneError", async () => {
      currentCreds = baseCreds({ allowedScriptIds: new Set(["SCRIPT:1234"]) });
      mockElicitConfirmation.mockResolvedValue({ status: "accepted", confirm: true });
      mockScriptsRun.mockRejectedValue(new Error("network blip"));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(
        scriptsHandler.handleCall("ninjaone_scripts_run", runArgs)
      ).rejects.toThrow("network blip");

      const auditLine = errorSpy.mock.calls
        .map((call) => call.join(" "))
        .find((line) => line.includes("AUDIT scripts_run"));
      expect(auditLine).not.toContain("statusCode");
      errorSpy.mockRestore();
    });

    it("shows omitted parameters and run_as as none", async () => {
      currentCreds = baseCreds({ allowedScriptIds: new Set(["SCRIPT:1234"]) });
      mockElicitConfirmation.mockResolvedValue({ status: "accepted", confirm: true });
      mockScriptsRun.mockResolvedValue(undefined);

      await scriptsHandler.handleCall("ninjaone_scripts_run", runArgs);

      const prompt = mockElicitConfirmation.mock.calls[0]?.[0] as string;
      expect(prompt).toContain("Parameters: (none)");
      expect(prompt).toContain("Run as: (none)");
    });

    it("refuses HTTP execution with no authenticated caller before elicitation", async () => {
      currentCreds = baseCreds({ allowedScriptIds: new Set(["SCRIPT:1234"]) });
      mockElicitConfirmation.mockResolvedValue({ status: "accepted", confirm: true });

      const result = await callRun(
        { ...runArgs, confirm: true, parameters: "--force", run_as: "SYSTEM" },
        { effect: "deny", reason: "unauthenticated" }
      );

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("no authenticated caller");
      expect(result.content[0]?.text).toContain("does not authenticate a caller");
      expect(mockElicitConfirmation).not.toHaveBeenCalled();
      expect(mockScriptsRun).not.toHaveBeenCalled();
    });

    it("refuses server-held HTTP credentials when the opt-in flag is off", async () => {
      currentCreds = baseCreds({ allowedScriptIds: new Set(["SCRIPT:1234"]) });
      mockElicitConfirmation.mockResolvedValue({ status: "accepted", confirm: true });

      const result = await callRun(runArgs, {
        effect: "deny",
        reason: "server-held-opt-in-required",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("NINJAONE_ALLOW_SERVER_HELD_SCRIPT_EXECUTION");
      expect(result.content[0]?.text).toContain("not authorization");
      expect(mockElicitConfirmation).not.toHaveBeenCalled();
      expect(mockScriptsRun).not.toHaveBeenCalled();
    });

    it("allows a per-request gateway caller through to confirmation without the opt-in flag", async () => {
      currentCreds = baseCreds({ allowedScriptIds: new Set(["ACTION:uid-1"]) });
      mockElicitConfirmation.mockResolvedValue({ status: "accepted", confirm: true });
      mockScriptsRun.mockResolvedValue(undefined);

      const result = await callRun(
        { device_id: 55, type: "ACTION", uid: "uid-1", parameters: "x", run_as: "SYSTEM" },
        { effect: "allow", via: "per-request" }
      );

      expect(result.isError).toBeUndefined();
      const prompt = mockElicitConfirmation.mock.calls[0]?.[0] as string;
      expect(prompt).toContain("Device: 55");
      expect(prompt).toContain("Script: ACTION:uid-1");
      expect(prompt).toContain("Parameters: x");
      expect(prompt).toContain("Run as: SYSTEM");
      expect(mockScriptsRun).toHaveBeenCalledWith(55, {
        type: "ACTION",
        id: undefined,
        uid: "uid-1",
        parameters: "x",
        runAs: "SYSTEM",
      });
    });

    it("still requires confirmation when server-held execution was explicitly opted in", async () => {
      currentCreds = baseCreds({
        allowedScriptIds: new Set(["SCRIPT:1234"]),
        allowSelfAttestedConfirmation: false,
      });
      mockElicitConfirmation.mockResolvedValue({ status: "unsupported" });

      const result = await callRun(
        { ...runArgs, confirm: true },
        { effect: "allow", via: "server-held-opt-in" }
      );

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("no interactive confirmation support");
      expect(mockScriptsRun).not.toHaveBeenCalled();
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
