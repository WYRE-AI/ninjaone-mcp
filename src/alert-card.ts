/**
 * Alert-card payload builder for the MCP Apps (SEP-1865) UI surface.
 *
 * ninjaone_alerts_get results get a normalized `_card` object attached (see
 * domains/alerts.ts) that the ui:// alert card renders from. The card is
 * progressive enhancement: normalization is best-effort, and a null return
 * simply means the host renders no card while the JSON payload is unchanged.
 */

import type { Alert } from "@wyre-technology/node-ninjaone";

export const ALERT_CARD_RESOURCE_URI = "ui://ninjaone/alert-card.html";

/** MCP Apps resource MIME (RESOURCE_MIME_TYPE in @modelcontextprotocol/ext-apps). */
export const MCP_APP_RESOURCE_MIME = "text/html;profile=mcp-app";

/**
 * Tool `_meta` advertising the card. Carries both the canonical flat key
 * (RESOURCE_URI_META_KEY in ext-apps) and the nested form ext-apps'
 * registerAppTool emits, so any MCP Apps host revision finds it.
 */
export const ALERT_CARD_META = {
  "ui/resourceUri": ALERT_CARD_RESOURCE_URI,
  ui: { resourceUri: ALERT_CARD_RESOURCE_URI },
} as const;

/** Mirror of AlertCard in ui/alert-card.ts — keep in sync. */
export interface AlertCard {
  uid: string;
  title: string;
  message?: string;
  severity?: string;
  status?: string;
  device?: string;
  organization?: string;
  source?: string;
  createdAt?: string;
  /** True while the alert is active — drives the "Reset alert" button. */
  canReset: boolean;
}

/** Brand overrides injected into the card as `window.__BRAND__`. */
export interface CardBrand {
  name?: string;
  logoUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  bg?: string;
  text?: string;
}

/** The comment marker in ui/index.html that serve-time injection replaces. */
const BRAND_INJECT_MARKER = /<!-- BRAND_INJECT:[\s\S]*?-->/;

/**
 * Replace the card's BRAND_INJECT comment with a `window.__BRAND__` script.
 * The card ships neutral; this is the customization mechanism. An empty
 * brand returns the HTML unchanged. `<` is escaped so brand values can
 * never break out of the injected script tag.
 */
export function applyBrandInjection(html: string, brand: CardBrand): string {
  const entries = Object.entries(brand).filter(
    ([, value]) => typeof value === "string" && value !== ""
  );
  if (entries.length === 0) return html;
  const json = JSON.stringify(Object.fromEntries(entries)).replace(/</g, "\\u003c");
  return html.replace(BRAND_INJECT_MARKER, `<script>window.__BRAND__=${json}</script>`);
}

/**
 * Resolve brand overrides from MCP_BRAND_* environment variables. Returns
 * an empty brand (HTML served unchanged) when none are set, or on runtimes
 * without `process.env` (e.g. Cloudflare Workers without nodejs_compat).
 */
export function resolveBrandFromEnv(): CardBrand {
  if (typeof process === "undefined" || !process.env) return {};
  const env = process.env;
  const brand: CardBrand = {};
  if (env.MCP_BRAND_NAME) brand.name = env.MCP_BRAND_NAME;
  if (env.MCP_BRAND_LOGO_URL) brand.logoUrl = env.MCP_BRAND_LOGO_URL;
  if (env.MCP_BRAND_PRIMARY_COLOR) brand.primaryColor = env.MCP_BRAND_PRIMARY_COLOR;
  if (env.MCP_BRAND_ACCENT_COLOR) brand.accentColor = env.MCP_BRAND_ACCENT_COLOR;
  if (env.MCP_BRAND_BG) brand.bg = env.MCP_BRAND_BG;
  if (env.MCP_BRAND_TEXT) brand.text = env.MCP_BRAND_TEXT;
  return brand;
}

const CARD_MESSAGE_MAX_LENGTH = 500;

/** "AGENT_OFFLINE" -> "Agent Offline", "OPEN" -> "Open". */
function humanizeEnum(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Labels resolved server-side (device display name, organization name) via
 * lookups the server already exposes. Both are best-effort — an unresolved
 * label is simply omitted from the card.
 */
export interface AlertCardLabels {
  device?: string;
  organization?: string;
}

/**
 * Normalize an SDK Alert into the flat, label-resolved payload the ui://
 * alert card renders from. NinjaOne enums (severity, status, sourceType)
 * are humanized; `createTime` is epoch seconds (occasionally millis), so
 * both are handled.
 */
export function buildAlertCard(
  alert: Partial<Alert> | null | undefined,
  labels: AlertCardLabels = {}
): AlertCard | null {
  if (!alert || typeof alert.uid !== "string" || alert.uid === "") {
    return null;
  }

  const card: AlertCard = {
    uid: alert.uid,
    title:
      alert.subject ??
      alert.sourceName ??
      (typeof alert.sourceType === "string" ? humanizeEnum(alert.sourceType) : "Alert"),
    canReset:
      alert.status !== "RESET" && alert.status !== "CLOSED" && alert.resetTime == null,
  };

  if (typeof alert.message === "string" && alert.message) {
    card.message = alert.message.slice(0, CARD_MESSAGE_MAX_LENGTH);
  }
  if (typeof alert.severity === "string" && alert.severity) {
    card.severity = humanizeEnum(alert.severity);
  }
  if (typeof alert.status === "string" && alert.status) {
    card.status = humanizeEnum(alert.status);
  }
  if (labels.device) card.device = labels.device;
  if (labels.organization) card.organization = labels.organization;
  if (typeof alert.sourceType === "string" && alert.sourceType) {
    card.source = humanizeEnum(alert.sourceType);
  }
  if (typeof alert.createTime === "number" && Number.isFinite(alert.createTime)) {
    // NinjaOne timestamps are epoch seconds (sometimes fractional); tolerate
    // milliseconds too in case a payload is already scaled.
    const ms = alert.createTime > 1e12 ? alert.createTime : alert.createTime * 1000;
    const created = new Date(ms);
    if (!Number.isNaN(created.getTime())) card.createdAt = created.toISOString();
  }

  return card;
}
