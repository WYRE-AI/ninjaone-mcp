/**
 * Devices domain handler
 *
 * Provides tools for device operations in NinjaOne.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { DeviceNodeClass } from "@wyre-technology/node-ninjaone";
import type { DomainHandler, CallToolResult } from "../utils/types.js";
import { getClient } from "../utils/client.js";
import { logger } from "../utils/logger.js";
import { elicitSelection } from "../utils/elicitation.js";

/**
 * Get device domain tools
 */
function getTools(): Tool[] {
  return [
    {
      name: "ninjaone_devices_list",
      description:
        "List NinjaOne devices, filterable by organization, device class, or online status",
      inputSchema: {
        type: "object" as const,
        properties: {
          organization_id: {
            type: "number",
          },
          device_class: {
            type: "string",
            enum: [
              "WINDOWS_WORKSTATION",
              "WINDOWS_SERVER",
              "MAC",
              "LINUX_WORKSTATION",
              "LINUX_SERVER",
              "VMWARE_VM_HOST",
              "VMWARE_VM_GUEST",
              "NMS",
            ],
          },
          online: {
            type: "boolean",
          },
          limit: {
            type: "number",
            description: "Max devices to return (default 50). A full page sets hasMore=true and returns a cursor.",
          },
          cursor: {
            type: "string",
            description: "Pagination cursor from a previous response's cursor field (the last device id).",
          },
        },
      },
    },
    {
      name: "ninjaone_devices_get",
      description: "Get device details by ID",
      inputSchema: {
        type: "object" as const,
        properties: {
          device_id: {
            type: "number",
          },
        },
        required: ["device_id"],
      },
    },
    {
      name: "ninjaone_devices_reboot",
      description: "Schedule device reboot (destructive action)",
      inputSchema: {
        type: "object" as const,
        properties: {
          device_id: {
            type: "number",
          },
          reason: {
            type: "string",
          },
        },
        required: ["device_id"],
      },
    },
    {
      name: "ninjaone_devices_services",
      description: "List Windows services on a device",
      inputSchema: {
        type: "object" as const,
        properties: {
          device_id: {
            type: "number",
          },
          state: {
            type: "string",
            enum: ["RUNNING", "STOPPED", "PAUSED"],
          },
        },
        required: ["device_id"],
      },
    },
    {
      name: "ninjaone_devices_alerts",
      description: "Get active alerts for a device",
      inputSchema: {
        type: "object" as const,
        properties: {
          device_id: {
            type: "number",
          },
          severity: {
            type: "string",
            enum: ["CRITICAL", "MAJOR", "MINOR", "NONE"],
          },
        },
        required: ["device_id"],
      },
    },
    {
      name: "ninjaone_devices_activities",
      description: "Get device activity log",
      inputSchema: {
        type: "object" as const,
        properties: {
          device_id: {
            type: "number",
          },
          activity_type: {
            type: "string",
          },
          limit: {
            type: "number",
          },
        },
        required: ["device_id"],
      },
    },
  ];
}

/**
 * Handle a device domain tool call
 */
async function handleCall(
  toolName: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const client = await getClient();

  switch (toolName) {
    case "ninjaone_devices_list": {
      const limit = (args.limit as number) || 50;
      const cursor = args.cursor as string | undefined;
      let organizationId = args.organization_id as number | undefined;

      // If no organization filter provided, elicit organization selection
      const hasOrgFilter = args.organization_id !== undefined;

      if (!hasOrgFilter) {
        try {
          // Fetch organizations to present as options
          const orgs = await client.organizations.list();
          if (orgs.length > 0) {
            const options = orgs.slice(0, 20).map((org) => ({
              value: String(org.id),
              label: org.name || `Organization ${org.id}`,
            }));
            options.push({ value: "all", label: "All organizations (no filter)" });

            const selection = await elicitSelection(
              "No organization filter provided. Would you like to filter devices by organization?",
              "organization",
              options
            );

            if (selection && selection !== "all") {
              organizationId = parseInt(selection, 10);
            }
          }
        } catch {
          // If org fetch fails, proceed without filter
        }
      }

      // Map the tool's online boolean onto the SDK's status filter.
      const status =
        args.online === undefined
          ? undefined
          : args.online
            ? "ONLINE"
            : "OFFLINE";

      logger.info("API call: devices.list", {
        organizationId,
        deviceClass: args.device_class,
        online: args.online,
        limit,
        cursor,
      });

      const devices = await client.devices.list({
        organizationId,
        nodeClass: args.device_class as DeviceNodeClass | undefined,
        status,
        pageSize: limit,
        cursor,
      });
      logger.debug("API response: devices.list", { deviceCount: devices.length });

      // GET /v2/devices has no total count and paginates by device id (the API's
      // `after` param returns ids greater than the cursor), so a page exactly the
      // size of the limit means results were likely truncated. Surface an explicit
      // hasMore flag and a cursor — the max id in this page, which the caller passes
      // back as `cursor` to fetch the next page. Without this, truncation is silent
      // and indistinguishable from "that's all of them".
      const hasMore = devices.length === limit;
      const nextCursor = hasMore
        ? String(Math.max(...devices.map((d) => d.id)))
        : undefined;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { devices, count: devices.length, hasMore, cursor: nextCursor },
              null,
              2
            ),
          },
        ],
      };
    }

    case "ninjaone_devices_get": {
      const deviceId = (args.device_id ?? args.deviceId ?? args.id) as number;
      if (!deviceId) {
        return {
          content: [{ type: "text", text: "Error: device_id is required" }],
          isError: true,
        };
      }
      logger.info("API call: devices.get", { deviceId });
      const device = await client.devices.get(deviceId);
      logger.debug("API response: devices.get", { device });

      return {
        content: [{ type: "text", text: JSON.stringify(device, null, 2) }],
      };
    }

    case "ninjaone_devices_reboot": {
      const deviceId = args.device_id as number;
      const reason = args.reason as string | undefined;
      logger.info("API call: devices.reboot", { deviceId, reason });
      const result = await client.devices.reboot(deviceId, reason);
      logger.debug("API response: devices.reboot", { result });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { success: true, message: "Reboot scheduled", result },
              null,
              2
            ),
          },
        ],
      };
    }

    case "ninjaone_devices_services": {
      const deviceId = args.device_id as number;
      const stateFilter = args.state as string | undefined;
      logger.info("API call: devices.getServices", { deviceId, state: stateFilter });
      let services = await client.devices.getServices(deviceId);
      if (stateFilter) {
        services = services.filter((s) => s.state === stateFilter);
      }
      logger.debug("API response: devices.getServices", { services });

      return {
        content: [{ type: "text", text: JSON.stringify(services, null, 2) }],
      };
    }

    case "ninjaone_devices_alerts": {
      const deviceId = args.device_id as number;
      const severityFilter = args.severity as string | undefined;
      logger.info("API call: alerts.listByDevice", { deviceId, severity: severityFilter });
      let alerts = await client.alerts.listByDevice(deviceId);
      if (severityFilter) {
        alerts = alerts.filter((a) => a.severity === severityFilter);
      }
      logger.debug("API response: alerts.listByDevice", { alerts });

      return {
        content: [{ type: "text", text: JSON.stringify(alerts, null, 2) }],
      };
    }

    case "ninjaone_devices_activities": {
      const deviceId = args.device_id as number;
      const limit = (args.limit as number) || 50;
      logger.info("API call: devices.getActivities", { deviceId, limit });
      const activities = await client.devices.getActivities(deviceId, {
        pageSize: limit,
      });
      logger.debug("API response: devices.getActivities", { activities });

      return {
        content: [{ type: "text", text: JSON.stringify(activities, null, 2) }],
      };
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown device tool: ${toolName}` }],
        isError: true,
      };
  }
}

export const devicesHandler: DomainHandler = {
  getTools,
  handleCall,
};
