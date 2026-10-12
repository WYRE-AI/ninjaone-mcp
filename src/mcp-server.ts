/**
 * Shared MCP server factory for NinjaOne.
 *
 * This module is **side-effect free** (importing it never starts a transport),
 * so it can be reused by every entrypoint:
 * - `index.ts` — stdio + Node HTTP serving
 * - `worker.ts` — Cloudflare Workers serving
 *
 * All NinjaOne tools are exposed upfront (flat architecture) for universal MCP
 * client compatibility.
 */

import { Server } from "@modelcontextprotocol/server";
import type { McpServerFactory, Tool } from "@modelcontextprotocol/server";
import { getDomainHandler, getAvailableDomains } from "./domains/index.js";
import {
  isDomainName,
  isValidRegion,
  getBaseUrlForRegion,
  parseScopes,
  parseAllowedScriptIds,
  parseBooleanFlag,
  type CallToolResult,
} from "./utils/types.js";
import {
  getCredentials,
  runWithCredentials,
  formatToolError,
  type NinjaOneCredentials,
} from "./utils/client.js";
import { logger } from "./utils/logger.js";
import { bindServerRef } from "./utils/server-ref.js";
import { elicitConfirmation } from "./utils/elicitation.js";
import { registerPromptHandlers } from "./prompts.js";
import {
  ALERT_CARD_RESOURCE_URI,
  MCP_APP_RESOURCE_MIME,
  applyBrandInjection,
  resolveBrandFromEnv,
} from "./alert-card.js";
import { ALERT_CARD_HTML } from "./generated/alert-card-html.js";

export type { NinjaOneCredentials };

/**
 * Collect all domain tools for flattened tool listing.
 *
 * The tool set is static and credential-independent, but a fresh server is
 * created per request (for credential isolation), so the assembled list is
 * memoized at module scope to avoid rebuilding it on every request.
 */
let cachedDomainTools: Tool[] | undefined;
async function getAllDomainTools(): Promise<Tool[]> {
  if (cachedDomainTools) return cachedDomainTools;

  const allTools: Tool[] = [];
  for (const domain of getAvailableDomains()) {
    const handler = await getDomainHandler(domain);
    allTools.push(...handler.getTools());
  }

  cachedDomainTools = allTools;
  return allTools;
}

type DomainName = "devices" | "organizations" | "alerts" | "tickets" | "scripts";

const domainDescriptions: Record<DomainName, string> = {
  devices:
    "Device management - manage endpoints, reboot systems, view services, and get device alerts/activities",
  organizations:
    "Organization management - manage customer accounts, locations, and view organization devices",
  alerts:
    "Alert management - view, reset, and summarize monitoring alerts across devices and organizations",
  tickets:
    "Ticket management - create, update, comment on, and track service tickets",
  scripts:
    "Scripting - list and run org-approved scripts/actions on a device (ninjaone_scripts_run is destructive and requires org pre-approval)",
};

const navigateTool: Tool = {
  name: "ninjaone_navigate",
  description:
    "Discover available NinjaOne tools by domain. Returns tool names and descriptions for the selected domain. All tools are callable at any time — this is a help/discovery aid, not a prerequisite.",
  inputSchema: {
    type: "object",
    properties: {
      domain: {
        type: "string",
        enum: getAvailableDomains(),
        description: `The domain to explore:
- devices: ${domainDescriptions.devices}
- organizations: ${domainDescriptions.organizations}
- alerts: ${domainDescriptions.alerts}
- tickets: ${domainDescriptions.tickets}
- scripts: ${domainDescriptions.scripts}`,
      },
    },
    required: ["domain"],
  },
};

const statusTool: Tool = {
  name: "ninjaone_status",
  description: "Show API credential status and available tool domains",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

/**
 * TEMPORARY -- remove once the Nwaj Tech go-live elicitation smoke test
 * (task_1791839481841_16496506) is done. No device/org targeting, no
 * NinjaOne API call -- purely echoes what this MCP client returns for a
 * server-initiated elicitation request, so whoever runs the smoke test
 * doesn't need any MCP-internals knowledge to interpret the result.
 */
const debugElicitationCheckTool: Tool = {
  name: "ninjaone_debug_elicitation_check",
  description:
    "TEMPORARY diagnostic for the ninjaone_scripts_run launch smoke test -- remove after use. Issues a server-initiated confirmation prompt and reports exactly what the connected client returned. No side effects.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

/**
 * Build a validated NinjaOneCredentials object from raw values.
 * Returns `{ creds }` on success or `{ error }` when client id/secret are missing.
 * Shared by every transport (Node HTTP headers, Workers headers, Workers env).
 */
export function buildCredentials(
  clientId: string | undefined,
  clientSecret: string | undefined,
  region: string | undefined,
  scopes?: string | undefined,
  allowedScriptIds?: string | undefined,
  allowSelfAttestedConfirmation?: string | undefined
): { creds?: NinjaOneCredentials; error?: string } {
  if (!clientId || !clientSecret) {
    return {
      error:
        "Missing credentials: X-Ninja-Client-ID / X-Ninja-Client-Secret (or NINJAONE_CLIENT_ID / NINJAONE_CLIENT_SECRET)",
    };
  }

  const regionVal = region?.toLowerCase() || "us";
  const validRegion = isValidRegion(regionVal) ? regionVal : "us";
  return {
    creds: {
      clientId,
      clientSecret,
      region: validRegion,
      baseUrl: getBaseUrlForRegion(validRegion),
      scopes: parseScopes(scopes ?? process.env.NINJAONE_SCOPES),
      // Deliberately NOT `?? undefined`-defaulted to "allow" on a missing
      // value anywhere in this chain -- parseAllowedScriptIds itself always
      // returns a Set (empty when unset/unparseable), and the scripts domain
      // handler treats an empty Set as deny-all. See its own module comment.
      allowedScriptIds: parseAllowedScriptIds(
        allowedScriptIds ?? process.env.NINJAONE_ALLOWED_SCRIPT_IDS
      ),
      // Same fail-closed shape: unset/unparseable is always false, never an
      // implicit "on". See types.ts parseBooleanFlag and domains/scripts.ts.
      allowSelfAttestedConfirmation: parseBooleanFlag(
        allowSelfAttestedConfirmation ?? process.env.NINJAONE_ALLOW_SELF_ATTESTED_CONFIRMATION
      ),
    },
  };
}

/**
 * Resolve per-request gateway credentials from a header accessor.
 *
 * Works with any transport: pass a getter that returns a (lowercased) header
 * value. Returns `{ creds }` on success, or `{ error }` when required headers
 * are missing.
 */
export function resolveGatewayCredentials(
  getHeader: (lowerName: string) => string | undefined
): { creds?: NinjaOneCredentials; error?: string } {
  return buildCredentials(
    getHeader("x-ninja-client-id"),
    getHeader("x-ninja-client-secret"),
    getHeader("x-ninja-region"),
    getHeader("x-ninja-scopes"),
    getHeader("x-ninja-allowed-script-ids"),
    getHeader("x-ninja-allow-self-attested-confirmation")
  );
}

/**
 * Bind `createMcpServer` into the `McpServerFactory` shape the v2 HTTP serving
 * entry (`createMcpHandler`) consumes. The factory runs once per HTTP request
 * — the same fresh-instance-per-request stateless idiom this server has always
 * used — for BOTH protocol eras (legacy 2025 traffic and modern 2026-07-28
 * envelope traffic).
 *
 * In gateway mode the request's X-Ninja-* headers are read from
 * `ctx.requestInfo`, keeping credentials bound per request. Missing headers
 * are answered 401 by the HTTP layer before serving ever starts; if a request
 * slips through without them, tools/call reports the credential error in-band.
 */
export function makeMcpServerFactory(options: {
  gatewayMode: boolean;
  envCredentials?: NinjaOneCredentials;
}): McpServerFactory {
  return (ctx) => {
    if (options.gatewayMode) {
      const { creds } = resolveGatewayCredentials(
        (name) => ctx.requestInfo?.headers.get(name) ?? undefined
      );
      return createMcpServer(creds);
    }
    return createMcpServer(options.envCredentials);
  };
}

/**
 * Create a fresh MCP server instance with all handlers registered.
 * Called once for stdio, or per-request for HTTP / Workers transports.
 *
 * @param credentialOverrides - Optional credentials for gateway mode. When
 *   provided, a per-request client is created from these credentials instead of
 *   reading from process.env.
 */
export async function createMcpServer(
  credentialOverrides?: NinjaOneCredentials
): Promise<Server> {
  const allDomainTools = await getAllDomainTools();

  const server = new Server(
    {
      name: "ninjaone-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
        resources: {},
        extensions: {
          "io.modelcontextprotocol/ui": {},
        },
      },
    }
  );
  bindServerRef(server);
  registerPromptHandlers(server);

  server.setRequestHandler('tools/list', async () => {
    return {
      tools: [navigateTool, statusTool, debugElicitationCheckTool, ...allDomainTools],
    };
  });

  // MCP Apps (SEP-1865): the ui:// alert card is static HTML embedded at
  // build time (src/generated/alert-card-html.ts), so it serves identically
  // from stdio, Node HTTP, and the fs-less Cloudflare Workers runtime.
  server.setRequestHandler('resources/list', async () => {
    return {
      resources: [
        {
          uri: ALERT_CARD_RESOURCE_URI,
          name: "NinjaOne Alert Card",
          description: "Interactive MCP Apps card rendering a NinjaOne alert",
          mimeType: MCP_APP_RESOURCE_MIME,
        },
      ],
    };
  });

  server.setRequestHandler('resources/read', async (request) => {
    const { uri } = request.params;
    if (uri !== ALERT_CARD_RESOURCE_URI) {
      throw new Error(`Unknown resource: ${uri}`);
    }
    return {
      contents: [
        {
          uri,
          mimeType: MCP_APP_RESOURCE_MIME,
          // The card ships neutral; operators brand it at serve time via
          // MCP_BRAND_* env vars (no vars = HTML served unchanged).
          text: applyBrandInjection(ALERT_CARD_HTML, resolveBrandFromEnv()),
        },
      ],
    };
  });

  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: args } = request.params;
    logger.info("Tool call received", { tool: name, arguments: args });

    const run = async (): Promise<CallToolResult> => {
      try {
        if (name === "ninjaone_navigate") {
          const domain = (args as { domain: string }).domain;

          if (!isDomainName(domain)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Invalid domain: ${domain}. Available domains: ${getAvailableDomains().join(", ")}`,
                },
              ],
              isError: true,
            };
          }

          const handler = await getDomainHandler(domain);
          const domainTools = handler.getTools();

          const toolSummary = domainTools
            .map((t) => `- ${t.name}: ${t.description}`)
            .join("\n");

          return {
            content: [
              {
                type: "text",
                text: `${domainDescriptions[domain]}\n\nAvailable tools:\n${toolSummary}\n\nYou can call any of these tools directly.`,
              },
            ],
          };
        }

        if (name === "ninjaone_status") {
          const creds = getCredentials();
          const credStatus = creds
            ? `Configured (region: ${creds.region}, base URL: ${creds.baseUrl})`
            : "NOT CONFIGURED - Please set environment variables";

          return {
            content: [
              {
                type: "text",
                text: `NinjaOne MCP Server Status\n\nCredentials: ${credStatus}\nAvailable domains: ${getAvailableDomains().join(", ")}\n\nCall conduit__my_access to see which tools you can use under the gateway, or ninjaone_navigate to browse all tools by domain when running standalone.`,
              },
            ],
          };
        }

        if (name === "ninjaone_debug_elicitation_check") {
          const result = await elicitConfirmation(
            "Elicitation smoke test for ninjaone_scripts_run -- click confirm (or decline) to report what this client returns."
          );
          const verdict =
            result === null
              ? "FAIL (unsupported): this client did not respond to the elicitation request at all -- server.elicitInput() returned null, meaning the client never implements the capability. ninjaone_scripts_run will refuse every call for this client unless allowSelfAttestedConfirmation is explicitly enabled for this org."
              : result === true
                ? "PASS (confirmed): this client supports elicitation and returned 'confirm'. ninjaone_scripts_run's human-confirmation step will work normally."
                : "PASS (declined): this client supports elicitation and returned 'decline' -- the capability works; you just didn't confirm this particular prompt. Run again and click confirm to see the PASS/confirmed result.";

          return {
            content: [{ type: "text", text: `Elicitation check result: ${verdict}\n\nRaw return value: ${JSON.stringify(result)}` }],
          };
        }

        const toolArgs = (args ?? {}) as Record<string, unknown>;

        if (name.startsWith("ninjaone_devices_")) {
          const handler = await getDomainHandler("devices");
          return await handler.handleCall(name, toolArgs);
        }
        if (name.startsWith("ninjaone_organizations_")) {
          const handler = await getDomainHandler("organizations");
          return await handler.handleCall(name, toolArgs);
        }
        if (name.startsWith("ninjaone_alerts_")) {
          const handler = await getDomainHandler("alerts");
          return await handler.handleCall(name, toolArgs);
        }
        if (name.startsWith("ninjaone_tickets_")) {
          const handler = await getDomainHandler("tickets");
          return await handler.handleCall(name, toolArgs);
        }
        if (name.startsWith("ninjaone_scripts_")) {
          const handler = await getDomainHandler("scripts");
          return await handler.handleCall(name, toolArgs);
        }

        return {
          content: [
            {
              type: "text",
              text: `Unknown tool: ${name}. Call conduit__my_access to see which tools you can use under the gateway, or ninjaone_navigate to browse available tools by domain when running standalone.`,
            },
          ],
          isError: true,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        logger.error("Tool call failed", { tool: name, error: message, stack });
        return {
          content: [{ type: "text", text: formatToolError(error) }],
          isError: true,
        };
      }
    };

    return credentialOverrides ? runWithCredentials(credentialOverrides, run) : run();
  });

  return server;
}
