/**
 * HTTP script execution is authorized by gateway caller identity, not by
 * the client's elicitation answer. Server-held credentials need that
 * caller and a separate opt-in that defaults off.
 */
import { describe, expect, it } from "vitest";
import { resolveHttpScriptCaller } from "../utils/script-caller.js";

describe("resolveHttpScriptCaller", () => {
  it("accepts gateway per-request credentials without the server-held flag", () => {
    expect(
      resolveHttpScriptCaller({
        gatewayMode: true,
        hasPerRequestCredentials: true,
        s2sEnforced: false,
        allowServerHeldScriptExecution: false,
      })
    ).toEqual({ effect: "allow", via: "per-request" });
  });

  it("refuses server-held credentials when nothing authenticated the caller", () => {
    expect(
      resolveHttpScriptCaller({
        gatewayMode: false,
        hasPerRequestCredentials: false,
        s2sEnforced: false,
        allowServerHeldScriptExecution: true,
      })
    ).toEqual({ effect: "deny", reason: "unauthenticated" });
  });

  it("refuses an authenticated server-held caller when the opt-in flag is off", () => {
    expect(
      resolveHttpScriptCaller({
        gatewayMode: false,
        hasPerRequestCredentials: false,
        s2sEnforced: true,
        allowServerHeldScriptExecution: false,
      })
    ).toEqual({ effect: "deny", reason: "server-held-opt-in-required" });
  });

  it("allows server-held credentials only when S2S is enforced and the flag is on", () => {
    expect(
      resolveHttpScriptCaller({
        gatewayMode: false,
        hasPerRequestCredentials: false,
        s2sEnforced: true,
        allowServerHeldScriptExecution: true,
      })
    ).toEqual({ effect: "allow", via: "server-held-opt-in" });
  });

  it("does not use server-held credentials to fill in a gateway request", () => {
    expect(
      resolveHttpScriptCaller({
        gatewayMode: true,
        hasPerRequestCredentials: false,
        s2sEnforced: true,
        allowServerHeldScriptExecution: true,
      })
    ).toEqual({ effect: "deny", reason: "unauthenticated" });
  });
});
