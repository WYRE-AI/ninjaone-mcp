#!/usr/bin/env node
/**
 * NinjaOne MCP Server with Flat Tool Architecture
 *
 * This MCP server exposes all NinjaOne tools upfront for universal MCP client
 * compatibility. All tools are available immediately without navigation state.
 * The ninjaone_navigate tool provides domain discovery and guidance but is not
 * required to access domain tools.
 *
 * This flattened approach works with all MCP clients including remote connectors
 * (claude.ai, mcp-remote) that do not support dynamic tool-list changes.
 *
 * Supports both stdio and HTTP transports:
 * - stdio (default): For local Claude Desktop / CLI usage
 * - http: For hosted deployment with optional gateway auth
 *
 * Credentials are provided via environment variables:
 * - NINJAONE_CLIENT_ID
 * - NINJAONE_CLIENT_SECRET
 * - NINJAONE_REGION (us, eu, oc, ca, us2, fed)
 *
 * Or via gateway headers (when AUTH_MODE=gateway):
 * - X-Ninja-Client-ID
 * - X-Ninja-Client-Secret
 * - X-Ninja-Region
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
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

/**
 * Collect all domain tools at startup for flattened tool listing
 */
async function getAllDomainTools(): Promise<Tool[]> {
  const allTools: Tool[] = [];
  const domains = getAvailableDomains();

  for (const domain of domains) {
    const handler = await getDomainHandler(domain);
    const domainTools = handler.getTools();
    allTools.push(...domainTools);
  }

  return allTools;
}

/**
 * Available domains for navigation
 */
type DomainName = "devices" | "organizations" | "alerts" | "tickets";

/**
 * Domain metadata for discovery
 */
const domainDescriptions: Record<DomainName, string> = {
  devices: "Device management - manage endpoints, reboot systems, view services, and get device alerts/activities",
  organizations: "Organization management - manage customer accounts, locations, and view organization devices",
  alerts: "Alert management - view, reset, and summarize monitoring alerts across devices and organizations",
  tickets: "Ticket management - create, update, comment on, and track service tickets",
};

/**
 * Navigation/discovery tool - helps find relevant tools by domain
 *
 * This is a stateless helper that describes available tools for a domain.
 * All domain tools are always callable - this is a discovery aid, not a prerequisite.
 */
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

/**
 * Status tool - shows API credential status and available tools
 */
const statusTool: Tool = {
  name: "ninjaone_status",
  description:
    "Show API credential status and available tool domains",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

/**
 * Create a fresh MCP server instance with all handlers registered.
 * Called once for stdio, or per-request for HTTP transport.
 *
 * @param credentialOverrides - Optional credentials for gateway mode.
 *   When provided, a per-request client is created from these credentials
 *   instead of reading from process.env.
 */
async function createMcpServer(credentialOverrides?: NinjaOneCredentials): Promise<Server> {
  // Collect all domain tools once at startup for flattened tool listing
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
      },
    }
  );
  setServerRef(server);
  registerPromptHandlers(server);

  /**
   * Handle ListTools requests - always returns ALL tools
   */
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: [navigateTool, statusTool, ...allDomainTools] };
  });

  /**
   * Handle CallTool requests
   */
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    logger.info("Tool call received", { tool: name, arguments: args });

    // If per-request credentials were provided, create an isolated client
    // and set it as the override so all domain handlers pick it up via getClient().
    if (credentialOverrides) {
      setCredentialOverrides(credentialOverrides);
      const directClient = await createClientDirect(credentialOverrides);
      setClientOverride(directClient);
    }

    try {
      // Handle navigation / discovery helper (stateless)
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

      // Handle status tool
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

      // Route to appropriate domain handler based on tool name prefix
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

      // Unknown tool
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

/**
 * Start the server with stdio transport (default)
 */
async function startStdioTransport(): Promise<void> {
  const server = await createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("NinjaOne MCP server running on stdio (flattened mode)");
}

/**
 * Start the server with HTTP Streamable transport.
 * Each request gets a fresh Server + Transport (stateless).
 */
async function startHttpTransport(): Promise<void> {
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const host = process.env.MCP_HTTP_HOST || "0.0.0.0";
  const isGatewayMode = process.env.AUTH_MODE === "gateway";

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    // Health endpoint - no auth required
    if (url.pathname === "/health") {
      const creds = getCredentials();
      const status = creds ? "ok" : "degraded";
      const statusCode = creds ? 200 : 503;

      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status,
          transport: "http",
          authMode: isGatewayMode ? "gateway" : "env",
          timestamp: new Date().toISOString(),
          credentials: {
            configured: !!creds,
            region: creds?.region ?? null,
            hasClientId: !!process.env.NINJAONE_CLIENT_ID,
            hasClientSecret: !!process.env.NINJAONE_CLIENT_SECRET,
          },
          logLevel: process.env.LOG_LEVEL || "info",
          version: "1.0.0",
        })
      );
      return;
    }

    // MCP endpoint
    if (url.pathname === "/mcp") {
      // In gateway mode, extract per-request credentials from headers
      // and pass them directly to createMcpServer() for isolation.
      // No process.env mutation — each request gets its own client.
      let credOverrides: NinjaOneCredentials | undefined;
      if (isGatewayMode) {
        const clientId = req.headers["x-ninja-client-id"] as string | undefined;
        const clientSecret = req.headers["x-ninja-client-secret"] as string | undefined;
        const region = req.headers["x-ninja-region"] as string | undefined;

        if (!clientId || !clientSecret) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Missing credentials",
              message:
                "Gateway mode requires X-Ninja-Client-ID and X-Ninja-Client-Secret headers",
              required: ["X-Ninja-Client-ID", "X-Ninja-Client-Secret"],
              optional: ["X-Ninja-Region"],
            })
          );
          return;
        }

        const regionVal = (region?.toLowerCase() || "us") as string;
        const validRegion = isValidRegion(regionVal) ? regionVal : "us" as const;
        credOverrides = {
          clientId,
          clientSecret,
          region: validRegion,
          baseUrl: getBaseUrlForRegion(validRegion),
        };
      }

      // Create fresh server + transport per request (stateless)
      const server = await createMcpServer(credOverrides);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on("close", () => {
        transport.close();
        server.close();
      });

      await server.connect(transport);
      transport.handleRequest(req, res);
      return;
    }

    // 404 for everything else
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", endpoints: ["/mcp", "/health"] }));
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, () => {
      logger.info(`NinjaOne MCP server listening on http://${host}:${port}/mcp`);
      logger.info(`Health check available at http://${host}:${port}/health`);
      logger.info(`Authentication mode: ${isGatewayMode ? "gateway (header-based)" : "env (environment variables)"}`);
      resolve();
    });
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down NinjaOne MCP server...");
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Main entry point - select transport based on MCP_TRANSPORT env var
 */
async function main() {
  const transportType = process.env.MCP_TRANSPORT || "stdio";
  logger.info("Starting NinjaOne MCP server", {
    transport: transportType,
    logLevel: process.env.LOG_LEVEL || "info",
    nodeVersion: process.version,
  });

  if (transportType === "http") {
    await startHttpTransport();
  } else {
    await startStdioTransport();
  }
}

main().catch((error) => {
  logger.error("Fatal startup error", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
