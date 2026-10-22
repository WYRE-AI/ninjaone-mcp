// MCP Prompt Handlers for NinjaOne MCP Server
// Exposes pre-baked prompt templates via ListPrompts and GetPrompt handlers

import { Server } from "@modelcontextprotocol/server";

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
        description: 'Find devices with critical/important OS or software patches missing or failing',
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
          description: 'Find devices with critical/important OS or software patches missing or failing',
          messages: [
            {
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text: [
                  `Find devices with critical or important patches missing${args?.org_name ? ` in ${args.org_name}` : ' across all organizations'}. Use only these read-only NinjaOne tools:`,
                  '',
                  '1. Scope: if an organization is named, get its id from ninjaone_organizations_list and pass',
                  '   organization_id to every call below.',
                  '2. Missing OS patches: ninjaone_patches_os_list with severity CRITICAL, then IMPORTANT. Page with',
                  '   cursor while hasMore is true. If both return zero rows, run it once with no severity filter',
                  '   before calling anything compliant, because a filter value NinjaOne does not recognise can',
                  '   come back empty. Treat REJECTED rows as deliberately declined by policy and list them separately.',
                  '3. Failed OS installs: ninjaone_patches_os_installs_list with status FAILED.',
                  '4. Third-party software: ninjaone_patches_software_list with impact CRITICAL, and',
                  '   ninjaone_patches_software_installs_list with status FAILED.',
                  '5. Device names and OS: patch rows carry only deviceId. Join them against',
                  '   ninjaone_organizations_devices (or ninjaone_devices_list across all organizations).',
                  '   Use ninjaone_devices_get for individual devices only.',
                  '6. Stale patching: ninjaone_patches_os_installs_list with status INSTALLED and installed_after',
                  "   set to 30 days ago. Report devices with no row as 'no successful OS patch install in 30 days',",
                  '   and note this can also mean nothing was pending.',
                  '',
                  'Report only what the tools returned. If a tool errors or is unavailable, say so and do not',
                  'estimate counts.',
                  '',
                  'Present as a patch compliance report:',
                  '- Summary: total devices checked, compliant count, non-compliant count',
                  '- Table of non-compliant devices (device name, organization, OS, missing patch count, most',
                  '  severe patches), sorted by severity, then missing patch count; group by organization for',
                  '  multi-org views',
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
