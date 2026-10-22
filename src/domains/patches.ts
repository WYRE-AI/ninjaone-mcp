/**
 * Patches domain handler (read-only).
 *
 * NinjaOne's patch reports, which @wyre-ai/node-ninjaone does not implement.
 * Each tool covers one report, either fleet-wide or for one device:
 *
 * - no `device_id`: `GET /api/v2/queries/<report>`. Returns
 *   `{ cursor, results }`; rows carry `deviceId`; paged by `cursor.name`.
 * - `device_id`: `GET /api/v2/device/{id}/<report>`. Returns a bare array,
 *   unpaged.
 *
 * Paths, query parameters and response shapes come from NinjaOne's published
 * OpenAPI (`NinjaRMM-API-v2.yaml`, 2.0.9-draft): getPendingFailedRejected-
 * OSPatches / SoftwarePatches, getInstalledOSPatches / SoftwarePatches and
 * their getDevice* counterparts. The spec types every filter as a plain
 * string and only lists values for the install-report status (FAILED,
 * INSTALLED), so other filter values are passed through unvalidated.
 *
 * Patch scan/apply (`POST /v2/device/{id}/patch/{os|software}/{scan|apply}`)
 * are deliberately not exposed. They need the `management` scope and their
 * own confirmation gate; ninjaone_scripts_run's allowlist is keyed by script
 * id and does not cover them.
 */
import type { Tool } from "@modelcontextprotocol/server";
import type { DomainHandler, CallToolResult } from "../utils/types.js";
import { getClient } from "../utils/client.js";
import { logger } from "../utils/logger.js";
import { sdkGet } from "../utils/sdk-http.js";
import { organizationDeviceIds } from "../utils/device-filters.js";

type FilterKey =
  | "status"
  | "type"
  | "severity"
  | "impact"
  | "product_identifier"
  | "installed_after"
  | "installed_before";

/** Tool argument name -> NinjaOne query parameter name. */
const UPSTREAM_PARAM: Record<FilterKey, string> = {
  status: "status",
  type: "type",
  severity: "severity",
  impact: "impact",
  product_identifier: "productIdentifier",
  installed_after: "installedAfter",
  installed_before: "installedBefore",
};

/** ISO-8601 filters NinjaOne takes as Unix epoch seconds. */
const DATE_FILTERS: ReadonlySet<FilterKey> = new Set(["installed_after", "installed_before"]);

/** A type alias, not an interface, so it fits the SDK's JSON-schema index signature. */
type FilterSchema = {
  type: "string";
  description: string;
  enum?: string[];
};

const PENDING_STATUS: FilterSchema = {
  type: "string",
  description:
    "Patch status. Common values: MANUAL, APPROVED, FAILED, REJECTED (REJECTED = declined by policy). Passed through unvalidated.",
};
const OS_TYPE: FilterSchema = {
  type: "string",
  description:
    "OS patch type. Common values: SECURITY_UPDATES, CRITICAL_UPDATES, UPDATE_ROLLUPS, DEFINITION_UPDATES, REGULAR_UPDATES, FEATURE_PACKS, DRIVER_UPDATES. Passed through unvalidated.",
};
const SOFTWARE_TYPE: FilterSchema = {
  type: "string",
  description: "Software patch type. Common values: PATCH, INSTALLER. Passed through unvalidated.",
};
const SEVERITY: FilterSchema = {
  type: "string",
  description:
    "OS patch severity. Common values: CRITICAL, IMPORTANT, MODERATE, OPTIONAL. Passed through unvalidated; an unrecognised value can return zero rows.",
};
const IMPACT: FilterSchema = {
  type: "string",
  description:
    "Software patch impact. Common values: CRITICAL, RECOMMENDED, OPTIONAL. Passed through unvalidated; an unrecognised value can return zero rows.",
};
const PRODUCT_IDENTIFIER: FilterSchema = {
  type: "string",
  description: "Software product identifier (UUID), as returned in a row's productIdentifier.",
};
const INSTALLED_AFTER: FilterSchema = {
  type: "string",
  description:
    "ISO-8601 date (2026-09-22, meaning midnight UTC) or date-time with Z or an offset (2026-09-22T08:00:00Z). Only installs after this time. Sent to NinjaOne as Unix epoch seconds.",
};
const INSTALLED_BEFORE: FilterSchema = {
  type: "string",
  description:
    "ISO-8601 date (2026-10-22, meaning midnight UTC) or date-time with Z or an offset (2026-10-22T08:00:00Z). Only installs before this time. Sent to NinjaOne as Unix epoch seconds.",
};

interface PatchReport {
  summary: string;
  /** Report segment: `/v2/queries/<endpoint>` and `/v2/device/{id}/<endpoint>`. */
  endpoint: string;
  filters: Partial<Record<FilterKey, FilterSchema>>;
}

const REPORTS = {
  ninjaone_patches_os_list: {
    summary: "Pending, failed and rejected operating-system patches.",
    endpoint: "os-patches",
    filters: { status: PENDING_STATUS, type: OS_TYPE, severity: SEVERITY },
  },
  ninjaone_patches_software_list: {
    summary: "Pending, failed and rejected third-party software patches.",
    endpoint: "software-patches",
    filters: {
      status: PENDING_STATUS,
      type: SOFTWARE_TYPE,
      impact: IMPACT,
      product_identifier: PRODUCT_IDENTIFIER,
    },
  },
  ninjaone_patches_os_installs_list: {
    summary: "OS patch install history (installed and failed installs).",
    endpoint: "os-patch-installs",
    filters: {
      status: { type: "string", description: "FAILED or INSTALLED.", enum: ["FAILED", "INSTALLED"] },
      installed_after: INSTALLED_AFTER,
      installed_before: INSTALLED_BEFORE,
    },
  },
  ninjaone_patches_software_installs_list: {
    summary: "Third-party software patch install history (installed and failed installs).",
    endpoint: "software-patch-installs",
    filters: {
      status: {
        type: "string",
        description: "Common values: FAILED, INSTALLED. Passed through unvalidated.",
      },
      type: SOFTWARE_TYPE,
      impact: IMPACT,
      product_identifier: PRODUCT_IDENTIFIER,
      installed_after: INSTALLED_AFTER,
      installed_before: INSTALLED_BEFORE,
    },
  },
} satisfies Record<string, PatchReport>;

type PatchToolName = keyof typeof REPORTS;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function isPatchToolName(name: string): name is PatchToolName {
  return Object.prototype.hasOwnProperty.call(REPORTS, name);
}

function toolDescription(report: PatchReport): string {
  return (
    `Read-only. ${report.summary} ` +
    `Without device_id: fleet-wide report (GET /v2/queries/${report.endpoint}), ` +
    "one row per device and patch, each with deviceId. Paged: while hasMore is true, pass " +
    "cursor back for the next page; a device is only absent from the report once hasMore is " +
    "false. organization_id limits rows to that organization; rows " +
    "are re-checked against the organization's device list, so count (rows kept) can be " +
    "lower than scanned (rows read). " +
    `With device_id: that device only (GET /v2/device/{id}/${report.endpoint}), unpaged; ` +
    "cannot be combined with organization_id or cursor. " +
    "Rows carry deviceId, not device names: join with ninjaone_organizations_devices or " +
    "ninjaone_devices_list."
  );
}

function getTools(): Tool[] {
  return (Object.entries(REPORTS) as Array<[PatchToolName, PatchReport]>).map(
    ([name, report]) => ({
      name,
      description: toolDescription(report),
      inputSchema: {
        type: "object" as const,
        properties: {
          device_id: {
            type: "number",
            description: "Report on one device only (per-device endpoint, unpaged).",
          },
          organization_id: {
            type: "number",
            description: "Limit a fleet-wide report to one organization's devices.",
          },
          ...report.filters,
          limit: {
            type: "number",
            description: `Rows per page for fleet-wide reports (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
          },
          cursor: {
            type: "string",
            description: "Cursor from a previous fleet-wide response, to read the next page.",
          },
        },
      },
    })
  );
}

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** YYYY-MM-DD, optionally followed by a time with Z or a +hh:mm / -hh:mm offset. */
const ISO_DATE = /^(\d{4}-\d{2}-\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

/**
 * Unix epoch seconds for a strict ISO-8601 date or date-time, else undefined.
 * Date.parse alone accepts "0", "2026/09/22" or "Sept 22 2026" as local time
 * and rolls 2026-02-30 over to March 2, so the format is checked first and
 * the calendar date must survive a round trip.
 */
function epochSeconds(value: string): number | undefined {
  const match = ISO_DATE.exec(value);
  if (!match) return undefined;
  const ms = Date.parse(value);
  const day = Date.parse(match[1]);
  if (Number.isNaN(ms) || Number.isNaN(day)) return undefined;
  if (new Date(day).toISOString().slice(0, 10) !== match[1]) return undefined;
  return Math.floor(ms / 1000);
}

/** Map this report's filter arguments onto NinjaOne query parameters. */
function filterParams(
  report: PatchReport,
  args: Record<string, unknown>
): { params: Record<string, string | number> } | { error: string } {
  const params: Record<string, string | number> = {};
  for (const key of Object.keys(report.filters) as FilterKey[]) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value === "") {
      return { error: `${key} must be a non-empty string.` };
    }
    if (DATE_FILTERS.has(key)) {
      const seconds = epochSeconds(value);
      if (seconds === undefined) {
        return {
          error:
            `${key} must be an ISO-8601 date (2026-09-22) or date-time with Z or an offset ` +
            `(2026-09-22T08:00:00Z), got "${value}".`,
        };
      }
      params[UPSTREAM_PARAM[key]] = seconds;
    } else {
      params[UPSTREAM_PARAM[key]] = value;
    }
  }
  return { params };
}

function pageLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)));
}

interface PatchQueryPage {
  cursor?: { name?: string };
  results?: Array<{ deviceId?: number }>;
}

/** The SDK returns `{}` for an empty body or a 204; that alone means "no rows". */
function isEmptyBody(body: unknown): boolean {
  return (
    body === undefined ||
    body === null ||
    (typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0)
  );
}

/**
 * Any other unexpected body is an error, never zero rows: an empty patch
 * report reads as "fully patched".
 */
function unexpectedShape(path: string, expected: string): CallToolResult {
  return errorResult(
    `Unexpected response from GET ${path}: expected ${expected}. ` +
      "This is not the same as no patches; report it instead of a count."
  );
}

async function handleCall(
  toolName: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  if (!isPatchToolName(toolName)) {
    return errorResult(`Unknown patches tool: ${toolName}`);
  }
  const report: PatchReport = REPORTS[toolName];
  const logName = `patches.${toolName.replace("ninjaone_patches_", "")}`;

  const filters = filterParams(report, args);
  if ("error" in filters) return errorResult(filters.error);

  const { device_id: deviceId, organization_id: orgId, cursor } = args;
  if (orgId !== undefined && !isPositiveInteger(orgId)) {
    return errorResult("organization_id must be a positive integer.");
  }
  if (cursor !== undefined && (typeof cursor !== "string" || cursor === "")) {
    return errorResult("cursor must be a non-empty string.");
  }

  if (deviceId !== undefined) {
    if (!isPositiveInteger(deviceId)) {
      return errorResult("device_id must be a positive integer.");
    }
    if (orgId !== undefined || cursor !== undefined) {
      return errorResult(
        "device_id cannot be combined with organization_id or cursor: the per-device " +
          "endpoint is already scoped to one device and is not paged."
      );
    }
    const path = `/api/v2/device/${deviceId}/${report.endpoint}`;
    const client = await getClient();
    logger.info(`API call: ${logName}`, { path, params: Object.keys(filters.params) });
    const body = await sdkGet<unknown>(client, path, filters.params);
    const patches = isEmptyBody(body) ? [] : body;
    if (!Array.isArray(patches)) return unexpectedShape(path, "an array of patches");
    logger.debug(`API response: ${logName}`, { count: patches.length });
    return jsonResult({ deviceId, patches, count: patches.length });
  }

  const limit = pageLimit(args.limit);
  const params: Record<string, string | number> = { ...filters.params, pageSize: limit };
  // df=org may be ignored upstream (#60), so rows are re-checked below.
  if (orgId !== undefined) params.df = `org=${orgId}`;
  if (cursor !== undefined) params.cursor = cursor;

  const path = `/api/v2/queries/${report.endpoint}`;
  const client = await getClient();
  logger.info(`API call: ${logName}`, { path, params: Object.keys(params) });
  const body = await sdkGet<unknown>(client, path, params);
  const page = (isEmptyBody(body) ? { results: [] } : body) as PatchQueryPage;
  if (!Array.isArray(page.results)) return unexpectedShape(path, "{ cursor, results }");
  const raw = page.results;

  let patches = raw;
  if (orgId !== undefined && raw.length > 0) {
    const orgDevices = await organizationDeviceIds(client, orgId);
    patches = raw.filter((row) => row.deviceId !== undefined && orgDevices.has(row.deviceId));
  }

  // Keep paging until a page comes back empty or without a cursor, not just
  // until a short page: NinjaOne may cap pageSize below the requested limit,
  // and its Cursor (name, offset, count, expires) is a server-side cursor
  // whose name need not change between pages. The cost is at most one extra,
  // empty page. hasMore is computed from the raw page, before the
  // organization filter.
  const nextCursor = page.cursor?.name;
  const hasMore = raw.length > 0 && typeof nextCursor === "string" && nextCursor !== "";
  logger.debug(`API response: ${logName}`, {
    scanned: raw.length,
    matched: patches.length,
    hasMore,
  });

  return jsonResult({
    patches,
    count: patches.length,
    scanned: raw.length,
    hasMore,
    cursor: hasMore ? nextCursor : undefined,
  });
}

export const patchesHandler: DomainHandler = {
  getTools,
  handleCall,
};
