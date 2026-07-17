/**
 * Shared MCP server factory for NinjaOne.
 *
 * This module is **side-effect free** (importing it never starts a transport),
 * so it can be reused by every entrypoint:
 * - `index.ts` — stdio + Node HTTP transport
 * - `worker.ts` — Cloudflare Workers (Web Standard) transport
 *
 * All NinjaOne tools are exposed upfront (flat architecture) for universal MCP
 * client compatibility.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getDomainHandler, getAvailableDomains } from "./domains/index.js";
import { isDomainName, isValidRegion, getBaseUrlForRegion } from "./utils/types.js";
import {
  getCredentials,
  createClientDirect,
  setClientOverride,
  clearClientOverride,
  setCredentialOverrides,
  clearCredentialOverrides,
  type NinjaOneCredentials,
} from "./utils/client.js";
import { logger } from "./utils/logger.js";
import { setServerRef } from "./utils/server-ref.js";
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

type DomainName = "devices" | "organizations" | "alerts" | "tickets";

const domainDescriptions: Record<DomainName, string> = {
  devices:
    "Device management - manage endpoints, reboot systems, view services, and get device alerts/activities",
  organizations:
    "Organization management - manage customer accounts, locations, and view organization devices",
  alerts:
    "Alert management - view, reset, and summarize monitoring alerts across devices and organizations",
  tickets:
    "Ticket management - create, update, comment on, and track service tickets",
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
- tickets: ${domainDescriptions.tickets}`,
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
 * Build a validated NinjaOneCredentials object from raw values.
 * Returns `{ creds }` on success or `{ error }` when client id/secret are missing.
 * Shared by every transport (Node HTTP headers, Workers headers, Workers env).
 */
export function buildCredentials(
  clientId: string | undefined,
  clientSecret: string | undefined,
  region: string | undefined
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
    getHeader("x-ninja-region")
  );
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
      },
    }
  );
  setServerRef(server);
  registerPromptHandlers(server);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: [navigateTool, statusTool, ...allDomainTools] };
  });

  // MCP Apps (SEP-1865): the ui:// alert card is static HTML embedded at
  // build time (src/generated/alert-card-html.ts), so it serves identically
  // from stdio, Node HTTP, and the fs-less Cloudflare Workers runtime.
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
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

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
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

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    logger.info("Tool call received", { tool: name, arguments: args });

    if (credentialOverrides) {
      setCredentialOverrides(credentialOverrides);
      const directClient = await createClientDirect(credentialOverrides);
      setClientOverride(directClient);
    }

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
              text: `NinjaOne MCP Server Status\n\nCredentials: ${credStatus}\nAvailable domains: ${getAvailableDomains().join(", ")}\n\nAll tools are available. Use ninjaone_navigate to discover tools by domain.`,
            },
          ],
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

      return {
        content: [
          {
            type: "text",
            text: `Unknown tool: ${name}. Use ninjaone_navigate to discover available tools by domain.`,
          },
        ],
        isError: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      logger.error("Tool call failed", { tool: name, error: message, stack });
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    } finally {
      if (credentialOverrides) {
        clearClientOverride();
        clearCredentialOverrides();
      }
    }
  });

  return server;
}
