/**
 * Scripts domain handler
 *
 * Exposes NinjaOne's device scripting surface: listing what's available to
 * run, and running it. ninjaone_scripts_run executes code on a customer
 * endpoint -- the highest-blast-radius action this server exposes -- so it
 * carries four layers no other tool here has, all mandatory and all
 * fail-closed:
 *
 * 1. Authenticated caller on HTTP. stdio's process owner is the caller.
 *    An HTTP client is not: gateway per-request credentials or an enforced
 *    gateway signature (CONDUIT_S2S_SECRET) is required, and server-held
 *    env credentials also require NINJAONE_ALLOW_SERVER_HELD_SCRIPT_EXECUTION
 *    (default off). An elicitation answer is not that authorization.
 * 2. Per-org script allowlist (checked against NINJAONE_ALLOWED_SCRIPT_IDS /
 *    the gateway's X-Ninja-Allowed-Script-Ids header). Unset, empty, or
 *    unparseable means deny-all, never allow-all -- there is no implicit
 *    default here, unlike scopes/region.
 * 3. Explicit confirmation before executing -- via MCP elicitation when the
 *    client supports it, otherwise a required `confirm: true` tool argument.
 *    The prompt shows the device, script, parameters, and run-as role that
 *    will be submitted. Confirmation does not grant the caller auth in layer 1.
 * 4. A dedicated structured audit log line distinct from this server's
 *    normal API-call logging, because Conduit's gateway-level audit log
 *    does not capture full tool arguments for every vendor call the way it
 *    does the actor/org/tool-name/outcome tuple.
 *
 * Only ninjaone_scripts_run requests the "control" OAuth scope, and only for
 * its own call -- via a one-off client built through createClientDirect(),
 * never by changing this server's default/cached scopes. ninjaone_scripts_list
 * needs only "monitoring", already covered by the default client.
 */
import type { Tool } from "@modelcontextprotocol/server";
import type { CallToolResult, DomainHandler } from "../utils/types.js";
import type { ScriptEntryType } from "@wyre-ai/node-ninjaone";
import { NinjaOneError } from "@wyre-ai/node-ninjaone";
import { getClient, getCredentials, createClientDirect } from "../utils/client.js";
import { logger } from "../utils/logger.js";
import { elicitConfirmation } from "../utils/elicitation.js";
import { getScriptCallerAuth, scriptCallerRefusal } from "../utils/script-caller.js";

/**
 * Get scripts domain tools
 */
function getTools(): Tool[] {
  return [
    {
      name: "ninjaone_scripts_list",
      description:
        "List scripts and built-in actions available to run on a device, and the credential roles eligible to run as",
      inputSchema: {
        type: "object" as const,
        properties: {
          device_id: {
            type: "number",
          },
          lang: {
            type: "string",
            description: "Language for localized script/action names",
          },
        },
        required: ["device_id"],
      },
    },
    {
      name: "ninjaone_scripts_run",
      description:
        "Run an org-approved script or built-in action on a device (destructive action -- executes code on the customer endpoint). Only scripts the org has pre-approved can run; everything else is refused regardless of this tool's arguments. On HTTP, the caller must already be authenticated (gateway per-request credentials, or a gateway-signed request plus NINJAONE_ALLOW_SERVER_HELD_SCRIPT_EXECUTION for server-held credentials). Confirming the prompt does not authorize the run.",
      inputSchema: {
        type: "object" as const,
        properties: {
          device_id: {
            type: "number",
          },
          type: {
            type: "string",
            enum: ["SCRIPT", "ACTION"],
            description: "SCRIPT = a custom script (use id); ACTION = a built-in action (use uid)",
          },
          id: {
            type: "number",
            description: "Script identifier -- required when type is SCRIPT",
          },
          uid: {
            type: "string",
            description: "Built-in action identifier (uuid) -- required when type is ACTION",
          },
          parameters: {
            type: "string",
            description: "Parameters passed to the script/action",
          },
          run_as: {
            type: "string",
            description: "Credential role/identifier to run as",
          },
          confirm: {
            type: "boolean",
            description:
              "Set true only after you have confirmed with the end user that this script should run on this device. Required when the connected client does not support interactive confirmation prompts.",
          },
        },
        required: ["device_id", "type"],
      },
    },
  ];
}

/**
 * Build the composite allowlist key for a script/action entry. Composite
 * because `id` (SCRIPT) and `uid` (ACTION) are different identifier spaces --
 * a bare number/string alone can't disambiguate which.
 */
function scriptKey(type: ScriptEntryType, idOrUid: number | string): string {
  return `${type}:${idOrUid}`;
}

/**
 * NinjaOne device ids are positive integers. The tool dispatcher does not
 * enforce the input schema, so a missing or non-integer device_id must be
 * refused here before pairing, caller auth, the audit line, or scripts.run.
 */
function positiveDeviceId(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

/**
 * One-line rendering of a caller-controlled confirmation field.
 *
 * Newlines and other control characters are escaped so a parameter or
 * run_as value cannot forge extra prompt lines. The escaped text is
 * display-only; scripts.run receives the original string.
 */
function renderConfirmationValue(value: string | undefined): string {
  if (typeof value !== "string" || value.length === 0) return "(none)";
  let rendered = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (ch === "\\") rendered += "\\\\";
    else if (ch === "\r") rendered += "\\r";
    else if (ch === "\n") rendered += "\\n";
    else if (ch === "\t") rendered += "\\t";
    else if (code < 0x20 || code === 0x7f) {
      rendered += `\\u${code.toString(16).padStart(4, "0")}`;
    } else rendered += ch;
  }
  return rendered;
}

function scriptRunConfirmationMessage(input: {
  deviceId: number;
  script: string;
  parameters: string | undefined;
  runAs: string | undefined;
}): string {
  return [
    `Device: ${input.deviceId}`,
    `Script: ${input.script}`,
    `Parameters: ${renderConfirmationValue(input.parameters)}`,
    `Run as: ${renderConfirmationValue(input.runAs)}`,
    "This executes code on the customer's endpoint.",
  ].join("\n");
}

/**
 * Validate the type/id/uid pairing the API itself doesn't reject. Returns an
 * error string, or null when the pairing is valid.
 */
function validatePairing(
  type: ScriptEntryType,
  id: number | undefined,
  uid: string | undefined
): string | null {
  if (type === "SCRIPT") {
    if (typeof id !== "number") return "type is SCRIPT but no numeric id was provided";
    if (uid !== undefined) return "type is SCRIPT but uid was also provided -- provide only id";
  } else {
    if (typeof uid !== "string" || uid.length === 0)
      return "type is ACTION but no uid was provided";
    if (id !== undefined) return "type is ACTION but id was also provided -- provide only uid";
  }
  return null;
}

/**
 * Structured audit line for the one tool here that executes code on a
 * customer endpoint. Deliberately its own log call (not folded into the
 * generic "API call" debug line every other handler uses) so it's
 * grep-able on its own and carries the full decision context even when
 * LOG_LEVEL=info suppresses debug-level API tracing.
 */
function auditScriptRun(entry: {
  deviceId: number;
  scriptKey: string;
  runAs: string | undefined;
  /**
   * `submitted` means the vendor accepted the run request. The endpoint
   * may still be executing; this line does not record completion.
   */
  outcome:
    | "denied-unauthenticated"
    | "denied-not-allowlisted"
    | "declined"
    | "submitted"
    | "failed";
  /**
   * Which confirmation path served the call -- "elicitation" (a human was
   * actually asked via the MCP client) vs "self-attested" (the calling
   * agent asserted confirm:true with no client-side human check) vs "none"
   * (denied before any confirmation path ran, e.g. the allowlist check).
   * These are different security properties; collapsing them into a single
   * "confirmed: true" would make "was this human-confirmed" unanswerable
   * after the fact.
   */
  confirmationPath: "elicitation" | "self-attested" | "none";
  detail?: unknown;
  /** Upstream HTTP status, when the failure came from a NinjaOneError. */
  statusCode?: number;
}): void {
  logger.info("AUDIT scripts_run", {
    deviceId: entry.deviceId,
    script: entry.scriptKey,
    runAs: entry.runAs,
    outcome: entry.outcome,
    confirmationPath: entry.confirmationPath,
    detail: entry.detail,
    statusCode: entry.statusCode,
    // Conduit's gateway-level audit log already records actor/org/tool-name/
    // timestamp/statusCode for every call through the proxy; this line adds
    // what that one doesn't carry for every vendor call -- which script and
    // which confirmation path served it.
    timestamp: new Date().toISOString(),
  });
}

/**
 * Handle a scripts domain tool call
 */
async function handleCall(
  toolName: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  switch (toolName) {
    case "ninjaone_scripts_list": {
      const client = await getClient();
      const deviceId = args.device_id as number;
      const lang = args.lang as string | undefined;

      logger.info("API call: scripts.listOptions", { deviceId });
      const options = await client.scripts.listOptions(deviceId, lang ? { lang } : undefined);
      logger.debug("API response: scripts.listOptions", {
        scriptCount: options.scripts.length,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(options, null, 2) }],
      };
    }

    case "ninjaone_scripts_run": {
      const deviceId = positiveDeviceId(args.device_id);
      const type = args.type as ScriptEntryType;
      const id = args.id as number | undefined;
      const uid = args.uid as string | undefined;
      const parameters = args.parameters as string | undefined;
      const runAs = args.run_as as string | undefined;
      const confirmArg = args.confirm as boolean | undefined;

      if (deviceId === null) {
        return {
          content: [{ type: "text", text: "Error: device_id must be a positive integer." }],
          isError: true,
        };
      }

      const pairingError = validatePairing(type, id, uid);
      if (pairingError) {
        return {
          content: [{ type: "text", text: `Error: ${pairingError}` }],
          isError: true,
        };
      }
      const key = scriptKey(type, (id ?? uid) as number | string);

      const creds = getCredentials();
      if (!creds) {
        return {
          content: [{ type: "text", text: "Error: No API credentials configured." }],
          isError: true,
        };
      }

      // Layer 1: authenticated caller on HTTP. Checked before the allowlist
      // and before any confirmation prompt, so a client cannot answer its
      // way into server-held credentials or learn whether a script is approved.
      const caller = getScriptCallerAuth();
      if (caller.effect === "deny") {
        auditScriptRun({
          deviceId,
          scriptKey: key,
          runAs,
          outcome: "denied-unauthenticated",
          confirmationPath: "none",
          detail: caller.reason,
        });
        return {
          content: [{ type: "text", text: scriptCallerRefusal(caller.reason) }],
          isError: true,
        };
      }

      // Layer 2: per-org allowlist. Unset/empty/unparseable means deny-all --
      // see parseAllowedScriptIds, there is no implicit "allow" default here.
      const allowed = creds.allowedScriptIds;
      if (!allowed || allowed.size === 0 || !allowed.has(key)) {
        auditScriptRun({
          deviceId,
          scriptKey: key,
          runAs,
          outcome: "denied-not-allowlisted",
          confirmationPath: "none",
        });
        return {
          content: [
            {
              type: "text",
              text: `Error: ${key} is not on this org's approved-scripts list. Script execution is refused for anything not explicitly pre-approved -- contact your account team to have it added.`,
            },
          ],
          isError: true,
        };
      }

      // Layer 3: explicit confirmation, mandatory on every call regardless
      // of which path serves it. Self-attestation is only available when
      // the client cannot be asked at all (`unsupported`). A decline, a
      // cancellation, an unchecked confirm box, and any elicitation error
      // are refusals — they must not fall through to confirm:true, or the
      // agent can override a human who already said no.
      //
      // The confirm:true fallback is itself gated by an ops-only flag
      // (allowSelfAttestedConfirmation, default false) -- elicitation and
      // self-attestation are different security properties (a human was
      // actually asked, vs. the calling agent asserts a human agreed), so
      // an unsupported client does NOT automatically downgrade to the
      // weaker one. Both the path taken and the outcome go into the audit
      // entry, so "was this human-confirmed" is answerable after the fact.
      const elicited = await elicitConfirmation(
        scriptRunConfirmationMessage({
          deviceId,
          script: key,
          parameters,
          runAs,
        })
      );

      let confirmationPath: "elicitation" | "self-attested" | "none";
      let confirmed: boolean;
      if (elicited.status === "unsupported") {
        if (creds.allowSelfAttestedConfirmation) {
          confirmationPath = "self-attested";
          confirmed = confirmArg === true;
        } else {
          confirmationPath = "none";
          confirmed = false;
        }
      } else if (elicited.status === "accepted") {
        confirmationPath = "elicitation";
        confirmed = elicited.confirm === true;
      } else {
        confirmationPath = "elicitation";
        confirmed = false;
      }

      if (!confirmed) {
        auditScriptRun({
          deviceId,
          scriptKey: key,
          runAs,
          outcome: "declined",
          confirmationPath,
          detail: elicited.status === "error" ? elicited.message : undefined,
        });
        const text =
          elicited.status === "error"
            ? `Refused -- confirmation failed (${elicited.message}). The script was not run.`
            : confirmationPath === "none"
              ? "Refused -- this client has no interactive confirmation support, and self-attested confirmation (confirm: true) is not enabled for this org. Script execution requires a human-confirmed path; contact your account team if self-attested confirmation should be enabled."
              : confirmationPath === "self-attested"
                ? "Cancelled -- scripts_run requires confirm: true to be passed explicitly once the end user has agreed to run this script."
                : "Cancelled -- script run was not confirmed.";
        return {
          content: [{ type: "text", text }],
          isError: confirmationPath === "none" || elicited.status === "error",
        };
      }

      // Layer 4: run with a one-off elevated-scope client. "control" is
      // requested only for this call, on top of whatever scopes this
      // request's credentials already carry -- never on the shared/cached
      // client, so no other tool call is affected. If the org's NinjaOne
      // OAuth app was never granted "control", this fails loud as
      // invalid_scope (see utils/client.ts formatToolError).
      const elevatedScopes = Array.from(
        new Set([...(creds.scopes ?? ["monitoring", "management"]), "control" as const])
      );
      const client = await createClientDirect({ ...creds, scopes: elevatedScopes });

      logger.info("API call: scripts.run", { deviceId, script: key, runAs });
      try {
        await client.scripts.run(deviceId, { type, id, uid, parameters, runAs });
        auditScriptRun({ deviceId, scriptKey: key, runAs, outcome: "submitted", confirmationPath });
      } catch (error) {
        auditScriptRun({
          deviceId,
          scriptKey: key,
          runAs,
          outcome: "failed",
          confirmationPath,
          detail: error instanceof Error ? error.message : String(error),
          // NinjaOneError carries the upstream HTTP statusCode; worth this
          // log's own copy since the gateway audit log's statusCode covers
          // the proxy call, not the vendor call this handler makes directly.
          statusCode: error instanceof NinjaOneError ? error.statusCode : undefined,
        });
        throw error;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                message:
                  "Script run submitted. The API confirms submission, not completion -- check ninjaone_devices_activities for the device to see the result.",
                deviceId,
                script: key,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown scripts tool: ${toolName}` }],
        isError: true,
      };
  }
}

export const scriptsHandler: DomainHandler = {
  getTools,
  handleCall,
};
