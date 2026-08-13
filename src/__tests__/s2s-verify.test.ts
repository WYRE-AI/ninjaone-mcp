import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyS2sHeader } from "../s2s-verify.js";

/**
 * Mirrors conduit's own gateway-side derivation + minting (src/proxy/s2s.ts
 * deriveRecipientSubkey / s2sHeaders) so this test can simulate the real
 * deploy-time flow without needing a live conduit-prod deploy: the gateway
 * derives one subkey per vendor slug from a master secret, and mints a
 * header keyed by that derived subkey for a specific outbound request.
 */
function deriveRecipientSubkey(masterSecret: string, slug: string): string {
  return createHmac("sha256", masterSecret).update(`s2s-recipient:${slug}`).digest("hex");
}

function mintHeader(secret: string, unixSeconds: number): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac("sha256", secret).update(message).digest("hex");
  return `${message},v1=${hex}`;
}

describe("verifyS2sHeader", () => {
  const MASTER = "test-master-secret-do-not-use-in-prod";
  const ninjaoneSubkey = deriveRecipientSubkey(MASTER, "ninjaone");
  const liongardSubkey = deriveRecipientSubkey(MASTER, "liongard");

  it("accepts a header minted with this vendor's own derived subkey", () => {
    const now = Math.floor(Date.now() / 1000);
    const header = mintHeader(ninjaoneSubkey, now);
    expect(verifyS2sHeader(header, ninjaoneSubkey)).toBe(true);
  });

  it("REJECTS a header minted for a different vendor's derived subkey (recipient-binding proof)", () => {
    // A header a compromised sibling sidecar could produce for itself must
    // NOT verify here — this is the actual property Finding B's rollout
    // needs to deliver, not just "some verify function exists."
    const now = Math.floor(Date.now() / 1000);
    const headerMintedForLiongard = mintHeader(liongardSubkey, now);
    expect(verifyS2sHeader(headerMintedForLiongard, ninjaoneSubkey)).toBe(false);
  });

  it("rejects a stale timestamp outside the skew window", () => {
    const now = Math.floor(Date.now() / 1000);
    const staleHeader = mintHeader(ninjaoneSubkey, now - 301);
    expect(verifyS2sHeader(staleHeader, ninjaoneSubkey)).toBe(false);
  });

  it("rejects a future timestamp outside the skew window", () => {
    const now = Math.floor(Date.now() / 1000);
    const futureHeader = mintHeader(ninjaoneSubkey, now + 301);
    expect(verifyS2sHeader(futureHeader, ninjaoneSubkey)).toBe(false);
  });

  it("accepts a timestamp at the edge of the skew window", () => {
    const now = Math.floor(Date.now() / 1000);
    const edgeHeader = mintHeader(ninjaoneSubkey, now - 300);
    expect(verifyS2sHeader(edgeHeader, ninjaoneSubkey)).toBe(true);
  });

  it("rejects a malformed header value", () => {
    expect(verifyS2sHeader("not-a-valid-header", ninjaoneSubkey)).toBe(false);
    expect(verifyS2sHeader("t=abc,v1=zz", ninjaoneSubkey)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyS2sHeader(undefined, ninjaoneSubkey)).toBe(false);
  });

  it("rejects when the secret is empty (dark-by-default guarantee)", () => {
    const now = Math.floor(Date.now() / 1000);
    const header = mintHeader(ninjaoneSubkey, now);
    expect(verifyS2sHeader(header, "")).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const now = Math.floor(Date.now() / 1000);
    const header = mintHeader(ninjaoneSubkey, now);
    const tampered = header.slice(0, -1) + (header.endsWith("0") ? "1" : "0");
    expect(verifyS2sHeader(tampered, ninjaoneSubkey)).toBe(false);
  });
});
