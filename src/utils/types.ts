/**
 * Shared types for the NinjaOne MCP server
 */
import type { Tool } from "@modelcontextprotocol/server";
import { logger } from "./logger.js";

/**
 * Matches an unresolved MCPB/DXT config placeholder, e.g. "${user_config.ninjaone_region}".
 * When an optional user_config field is left blank, Claude Desktop injects the literal
 * placeholder string (not empty, not omitted) into the env var. Treat it as unset.
 */
export const CONFIG_PLACEHOLDER = /^\$\{.*\}$/;

/**
 * Tool call result type - inline definition for MCP SDK compatibility
 */
export type CallToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
};

/**
 * Domain handler interface
 */
export interface DomainHandler {
  /** Get the tools for this domain */
  getTools(): Tool[];
  /** Handle a tool call */
  handleCall(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult>;
}

/**
 * Domain names for NinjaOne
 */
export type DomainName =
  | "devices"
  | "organizations"
  | "alerts"
  | "tickets"
  | "scripts";

/**
 * Check if a string is a valid domain name
 */
export function isDomainName(value: string): value is DomainName {
  return ["devices", "organizations", "alerts", "tickets", "scripts"].includes(value);
}

/**
 * NinjaOne region type
 */
export type NinjaOneRegion = "us" | "eu" | "oc" | "ca" | "us2" | "fed";

/**
 * Check if a string is a valid NinjaOne region
 */
export function isValidRegion(value: string): value is NinjaOneRegion {
  return ["us", "eu", "oc", "ca", "us2", "fed"].includes(value);
}

/**
 * OAuth scopes a NinjaOne API Services app can be granted.
 */
export type NinjaOneScope = "monitoring" | "management" | "control";

const VALID_SCOPES: NinjaOneScope[] = ["monitoring", "management", "control"];

/**
 * Parse a configured scope list (`NINJAONE_SCOPES`, or the gateway's
 * `X-Ninja-Scopes` header) into the scopes to request at the token endpoint.
 *
 * Returns `undefined` for "not configured", which leaves the SDK's own default
 * in place. That distinction matters: NinjaOne rejects a client_credentials
 * request asking for a scope the app was never granted (400 `invalid_scope`)
 * rather than narrowing the grant, so an app scoped to monitoring only cannot
 * get a token at all unless the caller says so. Requesting *more* than you were
 * granted is the failure mode — never widen this on a caller's behalf.
 *
 * Accepts comma- or space-separated values, in any case. Unrecognized entries
 * are dropped with a warning rather than failing startup, mirroring how an
 * invalid region degrades to "us" above.
 */
export function parseScopes(raw: string | undefined): NinjaOneScope[] | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || CONFIG_PLACEHOLDER.test(trimmed)) {
    return undefined;
  }

  const requested = trimmed
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());

  const valid = requested.filter((s): s is NinjaOneScope =>
    (VALID_SCOPES as string[]).includes(s)
  );
  const unknown = requested.filter((s) => !(VALID_SCOPES as string[]).includes(s));

  if (unknown.length > 0) {
    logger.warn("Ignoring unrecognized NinjaOne scope(s)", {
      ignored: unknown,
      valid: VALID_SCOPES,
    });
  }

  // Nothing usable (e.g. a pure typo) — fall back to the SDK default rather
  // than sending an empty `scope` parameter, which is not the same as omitting it.
  if (valid.length === 0) {
    return undefined;
  }

  return [...new Set(valid)];
}

/**
 * Parse a configured per-org script allowlist (`NINJAONE_ALLOWED_SCRIPT_IDS`,
 * or the gateway's `X-Ninja-Allowed-Script-Ids` header) into the Set of
 * composite keys ninjaone_scripts_run checks against -- see domains/scripts.ts
 * scriptKey() for the "TYPE:identifier" format each entry must match.
 *
 * Deliberately fail-closed, unlike parseScopes: unset, blank, or entirely
 * unparseable ALWAYS returns an empty Set, never `undefined`-as-"no
 * restriction". scripts_run treats an empty Set as deny-all. There is no
 * default-allow reading of this value anywhere in this server.
 *
 * Expected format: comma-separated composite keys, e.g.
 * "SCRIPT:1234,ACTION:9f2b6e2e-....". A bare number/uuid without its
 * "SCRIPT:"/"ACTION:" prefix is dropped (with a warning) rather than guessed
 * at, since id and uid are different identifier spaces.
 */
export function parseAllowedScriptIds(raw: string | undefined): Set<string> {
  const trimmed = raw?.trim();
  if (!trimmed || CONFIG_PLACEHOLDER.test(trimmed)) {
    return new Set();
  }

  const entries = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const valid: string[] = [];
  const invalid: string[] = [];
  for (const entry of entries) {
    const [type, ...rest] = entry.split(":");
    const identifier = rest.join(":");
    if ((type === "SCRIPT" || type === "ACTION") && identifier.length > 0) {
      valid.push(`${type}:${identifier}`);
    } else {
      invalid.push(entry);
    }
  }

  if (invalid.length > 0) {
    logger.warn("Ignoring malformed NinjaOne allowed-script-id entries", {
      ignored: invalid,
      expectedFormat: "SCRIPT:<id> or ACTION:<uid>",
    });
  }

  return new Set(valid);
}

/**
 * Parse an ops-only boolean flag (`NINJAONE_ALLOW_SELF_ATTESTED_CONFIRMATION`,
 * or the gateway's `X-Ninja-Allow-Self-Attested-Confirmation` header).
 * Fail-closed like parseAllowedScriptIds: anything other than the literal
 * string "true" (case-insensitive) is false, including unset/blank/typo'd --
 * there is no implicit "on" reading.
 */
export function parseBooleanFlag(raw: string | undefined): boolean {
  const trimmed = raw?.trim().toLowerCase();
  if (!trimmed || CONFIG_PLACEHOLDER.test(trimmed)) return false;
  return trimmed === "true";
}

/**
 * Get the base URL for a NinjaOne region
 */
export function getBaseUrlForRegion(region: NinjaOneRegion): string {
  switch (region) {
    case "eu":
      return "https://eu.ninjarmm.com";
    case "oc":
      return "https://oc.ninjarmm.com";
    case "ca":
      return "https://ca.ninjarmm.com";
    case "us2":
      return "https://us2.ninjarmm.com";
    case "fed":
      return "https://fed.ninjarmm.com";
    case "us":
    default:
      return "https://app.ninjarmm.com";
  }
}
