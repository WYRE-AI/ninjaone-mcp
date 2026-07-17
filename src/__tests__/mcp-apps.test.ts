/**
 * MCP Apps (SEP-1865) contract tests — mirrors the checks an MCP Apps host
 * performs to render the alert card:
 *   1. renderable tools advertise the UI resource via _meta (both key forms)
 *   2. the ui:// resource lists and reads back as profile=mcp-app HTML
 *   3. ninjaone_alerts_get results carry the normalized `_card` payload the
 *      iframe renders from
 *
 * Wire-level checks drive the Cloudflare Worker fetch handler (the same
 * Server + transport as production); buildAlertCard is unit-tested directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker, { type Env } from "../worker.js";
import {
  applyBrandInjection,
  buildAlertCard,
  resolveBrandFromEnv,
  ALERT_CARD_RESOURCE_URI,
  MCP_APP_RESOURCE_MIME,
} from "../alert-card.js";
import { ALERT_CARD_HTML } from "../generated/alert-card-html.js";

const { mockAlertsGet, mockAlertsReset, mockDevicesGet, mockOrgsGet } = vi.hoisted(() => ({
  mockAlertsGet: vi.fn(),
  mockAlertsReset: vi.fn(),
  mockDevicesGet: vi.fn(),
  mockOrgsGet: vi.fn(),
}));

vi.mock("@wyre-technology/node-ninjaone", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@wyre-technology/node-ninjaone")>();
  return {
    ...actual,
    NinjaOneClient: class {
      alerts = { get: mockAlertsGet, reset: mockAlertsReset };
      devices = { get: mockDevicesGet };
      organizations = { get: mockOrgsGet };
    },
  };
});

const MCP_HEADERS = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
};

const CREDS_ENV: Env = {
  NINJAONE_CLIENT_ID: "test-id",
  NINJAONE_CLIENT_SECRET: "test-secret",
};

async function mcp(body: unknown, env: Env = {}): Promise<Response> {
  return worker.fetch(
    new Request("http://worker.local/mcp", {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify(body),
    }),
    env
  );
}

const RENDERABLE_TOOLS = ["ninjaone_alerts_get", "ninjaone_alerts_reset"];

const openAlert = {
  uid: "3f8a1b2c-4d5e-6f70-8192-a3b4c5d6e7f8",
  deviceId: 42,
  organizationId: 7,
  message: "Drive C: has 4% free space remaining",
  severity: "CRITICAL" as const,
  sourceType: "DISK_SPACE" as const,
  status: "OPEN" as const,
  createTime: 1752742800, // epoch seconds (NinjaOne convention)
  subject: "Low disk space",
};

describe("MCP Apps alert card", () => {
  beforeEach(() => {
    mockDevicesGet.mockResolvedValue({ id: 42, displayName: "SRV-DC01" });
    mockOrgsGet.mockResolvedValue({ id: 7, name: "Main Office" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("tool _meta advertisement", () => {
    it.each(RENDERABLE_TOOLS)("%s links the card via _meta", async (name) => {
      const res = await mcp({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result?: {
          tools?: { name: string; _meta?: Record<string, unknown> }[];
        };
      };
      const tool = body.result?.tools?.find((t) => t.name === name);
      expect(tool).toBeDefined();
      // Canonical flat key (ext-apps RESOURCE_URI_META_KEY) …
      expect(tool?._meta?.["ui/resourceUri"]).toBe(ALERT_CARD_RESOURCE_URI);
      // … and the nested form registerAppTool also emits.
      expect((tool?._meta?.ui as { resourceUri?: string })?.resourceUri).toBe(
        ALERT_CARD_RESOURCE_URI
      );
    });

    it("no other tools carry UI metadata", async () => {
      const res = await mcp({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      const body = (await res.json()) as {
        result?: {
          tools?: { name: string; _meta?: Record<string, unknown> }[];
        };
      };
      const tools = body.result?.tools ?? [];
      expect(tools.length).toBeGreaterThan(10);
      const others = tools.filter(
        (t) => t._meta && !RENDERABLE_TOOLS.includes(t.name)
      );
      expect(others).toEqual([]);
    });
  });

  describe("ui:// resource", () => {
    it("is listed with the MCP Apps MIME type", async () => {
      const res = await mcp({
        jsonrpc: "2.0",
        id: 3,
        method: "resources/list",
        params: {},
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result?: { resources?: { uri: string; mimeType?: string }[] };
      };
      const card = body.result?.resources?.find(
        (r) => r.uri === ALERT_CARD_RESOURCE_URI
      );
      expect(card?.mimeType).toBe(MCP_APP_RESOURCE_MIME);
    });

    it("reads back as profile=mcp-app HTML containing the card app", async () => {
      const res = await mcp({
        jsonrpc: "2.0",
        id: 4,
        method: "resources/read",
        params: { uri: ALERT_CARD_RESOURCE_URI },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result?: { contents?: { uri: string; mimeType?: string; text?: string }[] };
      };
      const content = body.result?.contents?.[0];
      expect(content?.mimeType).toBe(MCP_APP_RESOURCE_MIME);
      expect(content?.text).toBe(ALERT_CARD_HTML);
      expect(content?.text).toContain("card__bar");
      expect(content?.text).toContain("BRAND_INJECT");
      // The vite build must have inlined the bridge script — a bare <script src>
      // would be unloadable from a resources/read HTML string.
      expect(content?.text).not.toContain('src="./alert-card.ts"');
    });

    it("injects MCP_BRAND_* env branding at serve time", async () => {
      vi.stubEnv("MCP_BRAND_NAME", "Acme MSP");
      const res = await mcp({
        jsonrpc: "2.0",
        id: 5,
        method: "resources/read",
        params: { uri: ALERT_CARD_RESOURCE_URI },
      });
      const body = (await res.json()) as {
        result?: { contents?: { text?: string }[] };
      };
      const text = body.result?.contents?.[0]?.text ?? "";
      expect(text).toContain('window.__BRAND__={"name":"Acme MSP"}');
      expect(text).not.toContain("BRAND_INJECT");
    });

    it("rejects unknown resource URIs", async () => {
      const res = await mcp({
        jsonrpc: "2.0",
        id: 6,
        method: "resources/read",
        params: { uri: "ui://ninjaone/nope.html" },
      });
      const body = (await res.json()) as { error?: { message?: string } };
      expect(body.error?.message).toMatch(/Unknown resource/);
    });
  });

  describe("brand neutrality", () => {
    it("default bundle is brand-neutral (published server — no baked-in identity)", () => {
      expect(ALERT_CARD_HTML).not.toMatch(/WYRE/i);
      expect(ALERT_CARD_HTML).not.toContain("fonts.googleapis.com");
      // The injection marker must survive the vite build exactly once.
      expect(ALERT_CARD_HTML.match(/BRAND_INJECT/g)).toHaveLength(1);
    });
  });

  describe("ninjaone_alerts_get result", () => {
    it("carries the normalized _card payload alongside the raw alert", async () => {
      mockAlertsGet.mockResolvedValue(openAlert);
      const res = await mcp(
        {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: {
            name: "ninjaone_alerts_get",
            arguments: { alert_uid: openAlert.uid },
          },
        },
        CREDS_ENV
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result?: { isError?: boolean; content?: { text?: string }[] };
      };
      expect(body.result?.isError).toBeFalsy();
      const payload = JSON.parse(body.result?.content?.[0]?.text ?? "{}");
      expect(payload.uid).toBe(openAlert.uid);
      expect(payload.message).toBe(openAlert.message);
      expect(payload._card).toEqual({
        uid: openAlert.uid,
        title: "Low disk space",
        message: "Drive C: has 4% free space remaining",
        severity: "Critical",
        status: "Open",
        device: "SRV-DC01",
        organization: "Main Office",
        source: "Disk Space",
        createdAt: new Date(1752742800 * 1000).toISOString(),
        canReset: true,
      });
    });

    it("omits labels (not the card) when device/org lookups fail", async () => {
      mockAlertsGet.mockResolvedValue(openAlert);
      mockDevicesGet.mockRejectedValue(new Error("boom"));
      mockOrgsGet.mockRejectedValue(new Error("boom"));
      const res = await mcp(
        {
          jsonrpc: "2.0",
          id: 8,
          method: "tools/call",
          params: {
            name: "ninjaone_alerts_get",
            arguments: { alert_uid: openAlert.uid },
          },
        },
        CREDS_ENV
      );
      const body = (await res.json()) as {
        result?: { isError?: boolean; content?: { text?: string }[] };
      };
      expect(body.result?.isError).toBeFalsy();
      const payload = JSON.parse(body.result?.content?.[0]?.text ?? "{}");
      expect(payload._card.device).toBeUndefined();
      expect(payload._card.organization).toBeUndefined();
      expect(payload._card.title).toBe("Low disk space");
    });

    it("serves the raw payload without a card when normalization is impossible", async () => {
      // No uid — buildAlertCard returns null; the tool result must still be
      // the raw JSON, never an error (card is best-effort).
      mockAlertsGet.mockResolvedValue({ message: "odd payload" });
      const res = await mcp(
        {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: {
            name: "ninjaone_alerts_get",
            arguments: { alert_uid: "whatever" },
          },
        },
        CREDS_ENV
      );
      const body = (await res.json()) as {
        result?: { isError?: boolean; content?: { text?: string }[] };
      };
      expect(body.result?.isError).toBeFalsy();
      const payload = JSON.parse(body.result?.content?.[0]?.text ?? "{}");
      expect(payload.message).toBe("odd payload");
      expect(payload._card).toBeUndefined();
    });
  });

  describe("applyBrandInjection", () => {
    it("replaces the BRAND_INJECT marker with a window.__BRAND__ script", () => {
      const out = applyBrandInjection(ALERT_CARD_HTML, {
        name: "Acme MSP",
        primaryColor: "#ff0000",
      });
      expect(out).not.toContain("BRAND_INJECT");
      expect(out).toContain(
        'window.__BRAND__={"name":"Acme MSP","primaryColor":"#ff0000"}'
      );
    });

    it("escapes < so brand values cannot break out of the script tag", () => {
      const out = applyBrandInjection(ALERT_CARD_HTML, {
        name: "</script><script>alert(1)",
      });
      expect(out).not.toContain("</script><script>alert(1)");
      expect(out).toContain("\\u003c/script");
    });

    it("returns the HTML byte-identical for an empty brand", () => {
      expect(applyBrandInjection(ALERT_CARD_HTML, {})).toBe(ALERT_CARD_HTML);
      expect(applyBrandInjection(ALERT_CARD_HTML, { name: "" })).toBe(ALERT_CARD_HTML);
    });
  });

  describe("resolveBrandFromEnv", () => {
    it("maps MCP_BRAND_* vars and ignores everything else", () => {
      vi.stubEnv("MCP_BRAND_NAME", "Acme MSP");
      vi.stubEnv("MCP_BRAND_PRIMARY_COLOR", "#123456");
      expect(resolveBrandFromEnv()).toEqual({
        name: "Acme MSP",
        primaryColor: "#123456",
      });
    });

    it("returns an empty brand when nothing is configured", () => {
      expect(resolveBrandFromEnv()).toEqual({});
    });
  });

  describe("buildAlertCard", () => {
    it("falls back through subject → sourceName → humanized sourceType for the title", () => {
      expect(buildAlertCard(openAlert)?.title).toBe("Low disk space");
      expect(
        buildAlertCard({ ...openAlert, subject: undefined, sourceName: "Disk monitor" })
          ?.title
      ).toBe("Disk monitor");
      expect(
        buildAlertCard({ ...openAlert, subject: undefined })?.title
      ).toBe("Disk Space");
    });

    it("marks reset/closed alerts as not resettable", () => {
      const card = buildAlertCard({
        ...openAlert,
        status: "RESET",
        resetTime: 1752750000,
      });
      expect(card?.status).toBe("Reset");
      expect(card?.canReset).toBe(false);
      expect(buildAlertCard({ ...openAlert, status: "CLOSED" })?.canReset).toBe(false);
    });

    it("resolves labels passed by the server", () => {
      const card = buildAlertCard(openAlert, {
        device: "SRV-DC01",
        organization: "Main Office",
      });
      expect(card?.device).toBe("SRV-DC01");
      expect(card?.organization).toBe("Main Office");
    });

    it("handles millisecond createTime values too", () => {
      const card = buildAlertCard({ ...openAlert, createTime: 1752742800000 });
      expect(card?.createdAt).toBe(new Date(1752742800000).toISOString());
    });

    it("truncates long messages", () => {
      const card = buildAlertCard({ ...openAlert, message: "x".repeat(2000) });
      expect(card?.message).toHaveLength(500);
    });

    it("returns null for payloads that are not an alert", () => {
      expect(buildAlertCard(undefined)).toBeNull();
      expect(buildAlertCard(null)).toBeNull();
      expect(buildAlertCard({} as never)).toBeNull();
    });

    it("survives sparse alerts (card is best-effort)", () => {
      const card = buildAlertCard({ uid: "abc" } as never);
      expect(card).toEqual({
        uid: "abc",
        title: "Alert",
        canReset: true,
      });
    });
  });
});
