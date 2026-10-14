/**
 * Script policy must not leak across tenants or from a public request.
 * Gateway mode ignores process-wide script settings. Policy headers are
 * ignored unless the caller (the Node HTTP entry) opts in.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildCredentials, resolveGatewayCredentials } from "../mcp-server.js";

const ENV_KEYS = [
  "NINJAONE_ALLOWED_SCRIPT_IDS",
  "NINJAONE_ALLOW_SELF_ATTESTED_CONFIRMATION",
] as const;

const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function setScriptEnv(allowed: string | undefined, selfAttested: string | undefined): void {
  for (const key of ENV_KEYS) {
    if (!(key in saved)) saved[key] = process.env[key];
  }
  if (allowed === undefined) delete process.env.NINJAONE_ALLOWED_SCRIPT_IDS;
  else process.env.NINJAONE_ALLOWED_SCRIPT_IDS = allowed;
  if (selfAttested === undefined) delete process.env.NINJAONE_ALLOW_SELF_ATTESTED_CONFIRMATION;
  else process.env.NINJAONE_ALLOW_SELF_ATTESTED_CONFIRMATION = selfAttested;
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
    delete saved[key];
  }
});

const gatewayHeaders: Record<string, string> = {
  "x-ninja-client-id": "tenant-id",
  "x-ninja-client-secret": "tenant-secret",
  "x-ninja-allowed-script-ids": "SCRIPT:42",
  "x-ninja-allow-self-attested-confirmation": "true",
};

describe("buildCredentials script policy", () => {
  it("falls back to process env outside gateway mode", () => {
    setScriptEnv("SCRIPT:1", "true");
    const { creds } = buildCredentials("id", "secret", "us");
    expect(creds?.allowedScriptIds).toEqual(new Set(["SCRIPT:1"]));
    expect(creds?.allowSelfAttestedConfirmation).toBe(true);
  });

  it("does not apply process-wide script settings in gateway mode", () => {
    setScriptEnv("SCRIPT:1", "true");
    const { creds } = buildCredentials("id", "secret", "us", undefined, undefined, undefined, {
      gatewayMode: true,
    });
    expect(creds?.allowedScriptIds).toEqual(new Set());
    expect(creds?.allowSelfAttestedConfirmation).toBe(false);
  });

  it("uses the explicit gateway values instead of process env", () => {
    setScriptEnv("SCRIPT:1", "false");
    const { creds } = buildCredentials("id", "secret", "us", undefined, "SCRIPT:9", "true", {
      gatewayMode: true,
    });
    expect(creds?.allowedScriptIds).toEqual(new Set(["SCRIPT:9"]));
    expect(creds?.allowSelfAttestedConfirmation).toBe(true);
  });
});

describe("resolveGatewayCredentials script policy", () => {
  it("ignores client policy headers unless the caller opts in", () => {
    setScriptEnv("SCRIPT:1", "true");
    const getHeader = (name: string) => gatewayHeaders[name];

    const untrusted = resolveGatewayCredentials(getHeader);
    expect(untrusted.creds?.allowedScriptIds).toEqual(new Set());
    expect(untrusted.creds?.allowSelfAttestedConfirmation).toBe(false);

    const fromServer = resolveGatewayCredentials(getHeader, {
      scriptPolicy: {
        allowedScriptIds: "ACTION:uid-1",
        allowSelfAttestedConfirmation: "false",
      },
    });
    expect(fromServer.creds?.allowedScriptIds).toEqual(new Set(["ACTION:uid-1"]));
    expect(fromServer.creds?.allowSelfAttestedConfirmation).toBe(false);

    const trusted = resolveGatewayCredentials(getHeader, { trustScriptPolicyHeaders: true });
    expect(trusted.creds?.allowedScriptIds).toEqual(new Set(["SCRIPT:42"]));
    expect(trusted.creds?.allowSelfAttestedConfirmation).toBe(true);
  });
});
