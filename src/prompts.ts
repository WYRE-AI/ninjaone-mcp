import { Server } from "@modelcontextprotocol/server";

// MCP Prompt Handlers for NinjaOne MCP Server
// Exposes pre-baked prompt templates via ListPrompts and GetPrompt handlers

export function registerPromptHandlers(server: Server): void {
  server.setRequestHandler('prompts/list', async () => ({
    prompts: [
      {
        name: 'device-health-summary',
        description: 'Summarize device health across one or all organizations',
        arguments: [
          {
            name: 'org_name',
            description: 'Filter to a specific organization (optional — checks all orgs if omitted)',
            required: false,
          },
        ],
      },
      {
        name: 'patch-gaps',
        description: 'Find devices with critical patches missing',
        arguments: [
          {
            name: 'org_name',
            description: 'Filter to a specific organization (optional)',
            required: false,
          },
        ],
      },
      {
        name: 'offline-devices',
        description: "Identify devices that haven't checked in recently",
        arguments: [
          {
            name: 'org_name',
            description: 'Filter to a specific organization (optional)',
            required: false,
          },
        ],
      },
    ],
  }));

  server.setRequestHandler('prompts/get', async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case 'device-health-summary':
        return {
          description: 'Device health summary across organizations',
          messages: [
            {
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text: [
                  `Summarize device health${args?.org_name ? ` for ${args.org_name}` : ' across all organizations'} in NinjaOne.`,
                  '',
                  'Use the available NinjaOne tools to:',
                  '1. Navigate to the organizations domain to identify the target org(s),',
                  '2. Navigate to the devices domain and retrieve devices for those org(s),',
                  '3. Categorize devices by health status (healthy, warning, critical, unknown),',
                  '4. Identify devices with active alerts,',
                  '5. Highlight devices that have open critical or high severity conditions,',
                  '6. Provide a count of devices by OS type and version where available.',
                  '',
                  'Present as a health dashboard: overall summary counts, then a breakdown',
                  'of devices requiring attention ordered by severity.',
                ].join('\n'),
              },
            },
          ],
        };

      case 'patch-gaps':
        return {
          description: 'Find devices with critical patches missing',
          messages: [
            {
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text: [
                  `Find devices with critical patches missing${args?.org_name ? ` in ${args.org_name}` : ' across all organizations'}.`,
                  '',
                  'Use the available NinjaOne tools to:',
                  '1. Navigate to the devices domain and retrieve device list,',
                  '2. Filter for devices that have pending or failed critical/important patches,',
                  '3. For each device, note: device name, organization, OS, number of missing patches,',
                  '   and the most critical patch(es) missing,',
                  '4. Group by organization for multi-org views,',
                  '5. Identify devices that have not had a successful patch run in 30+ days.',
                  '',
                  'Present as a patch compliance report:',
                  '- Summary: total devices checked, compliant count, non-compliant count',
                  '- Table of non-compliant devices sorted by missing patch count (most critical first)',
                  '- Recommendations for any devices that need immediate attention.',
                ].join('\n'),
              },
            },
          ],
        };

      case 'offline-devices':
        return {
          description: "Identify devices that haven't checked in recently",
          messages: [
            {
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text: [
                  `Identify devices that haven't checked in recently${args?.org_name ? ` in ${args.org_name}` : ' across all organizations'}.`,
                  '',
                  'Use the available NinjaOne tools to:',
                  '1. Navigate to the devices domain and retrieve all devices with their last-seen timestamps,',
                  '2. Flag devices offline for: 24+ hours (warn), 3+ days (concern), 7+ days (critical),',
                  '3. For each offline device, note: device name, org, device type, last seen timestamp,',
                  '4. Separate expected offline devices (servers vs workstations) if device type is available,',
                  '5. Check if offline devices have any associated open alerts.',
                  '',
                  'Present as an offline device report:',
                  '- Summary counts by offline duration bucket',
                  '- Critical (7+ days) list first, then concern (3-7 days), then warnings (1-3 days)',
                  '- Recommend which devices to investigate first and suggested investigation steps.',
                ].join('\n'),
              },
            },
          ],
        };

      default:
        throw new Error(`Unknown prompt: ${name}`);
    }
  });
}
