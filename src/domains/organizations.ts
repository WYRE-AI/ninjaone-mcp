/**
 * Organizations domain handler
 *
 * Provides tools for organization operations in NinjaOne.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { DomainHandler, CallToolResult } from "../utils/types.js";
import { getClient } from "../utils/client.js";
import { logger } from "../utils/logger.js";

/**
 * Get organization domain tools
 */
function getTools(): Tool[] {
  return [
    {
      name: "ninjaone_organizations_list",
      description:
        "List organizations (customer accounts)",
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: {
            type: "number",
          },
          cursor: {
            type: "string",
          },
        },
      },
    },
    {
      name: "ninjaone_organizations_get",
      description: "Get organization details by ID",
      inputSchema: {
        type: "object" as const,
        properties: {
          organization_id: {
            type: "number",
          },
        },
        required: ["organization_id"],
      },
    },
    {
      name: "ninjaone_organizations_create",
      description: "Create new organization",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
          },
          description: {
            type: "string",
          },
          node_approval_mode: {
            type: "string",
            enum: ["AUTOMATIC", "MANUAL", "REJECT"],
            description: "How to handle new device registrations",
          },
          policy_id: {
            type: "number",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "ninjaone_organizations_locations",
      description: "List organization locations",
      inputSchema: {
        type: "object" as const,
        properties: {
          organization_id: {
            type: "number",
          },
        },
        required: ["organization_id"],
      },
    },
    {
      name: "ninjaone_organizations_devices",
      description: "List organization devices",
      inputSchema: {
        type: "object" as const,
        properties: {
          organization_id: {
            type: "number",
          },
          device_class: {
            type: "string",
            enum: ["WINDOWS_WORKSTATION", "WINDOWS_SERVER", "MAC", "LINUX", "VMWARE_VM"],
          },
          limit: {
            type: "number",
          },
        },
        required: ["organization_id"],
      },
    },
  ];
}

/**
 * Handle an organization domain tool call
 */
async function handleCall(
  toolName: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const client = await getClient();

  switch (toolName) {
    case "ninjaone_organizations_list": {
      const limit = (args.limit as number) || 50;
      const cursor = args.cursor as string | undefined;
      logger.info("API call: organizations.list", { limit, cursor });

      const organizations = await client.organizations.list({
        pageSize: limit,
        cursor,
      });
      logger.debug("API response: organizations.list", { count: organizations.length });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ organizations }, null, 2),
          },
        ],
      };
    }

    case "ninjaone_organizations_get": {
      const orgId = args.organization_id as number;
      logger.info("API call: organizations.get", { orgId });
      const organization = await client.organizations.get(orgId);
      logger.debug("API response: organizations.get", { organization });

      return {
        content: [{ type: "text", text: JSON.stringify(organization, null, 2) }],
      };
    }

    case "ninjaone_organizations_create": {
      logger.info("API call: organizations.create", { name: args.name });
      const organization = await client.organizations.create({
        name: args.name as string,
        description: args.description as string | undefined,
        nodeApprovalMode: args.node_approval_mode as 'AUTOMATIC' | 'MANUAL' | 'REJECT' | undefined,
        policyId: args.policy_id as number | undefined,
      });
      logger.debug("API response: organizations.create", { organization });

      return {
        content: [{ type: "text", text: JSON.stringify(organization, null, 2) }],
      };
    }

    case "ninjaone_organizations_locations": {
      const orgId = args.organization_id as number;
      logger.info("API call: organizations.getLocations", { orgId });
      const locations = await client.organizations.getLocations(orgId);
      logger.debug("API response: organizations.getLocations", { locations });

      return {
        content: [{ type: "text", text: JSON.stringify(locations, null, 2) }],
      };
    }

    case "ninjaone_organizations_devices": {
      const orgId = args.organization_id as number;
      const limit = (args.limit as number) || 50;
      logger.info("API call: devices.listByOrganization", { orgId, limit, deviceClass: args.device_class });
      const devices = await client.devices.listByOrganization(orgId, {
        pageSize: limit,
      });
      logger.debug("API response: devices.listByOrganization", { devices });

      return {
        content: [{ type: "text", text: JSON.stringify(devices, null, 2) }],
      };
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown organization tool: ${toolName}` }],
        isError: true,
      };
  }
}

export const organizationsHandler: DomainHandler = {
  getTools,
  handleCall,
};
