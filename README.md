# NinjaOne MCP Server

A Model Context Protocol (MCP) server for interacting with NinjaOne, featuring a decision tree architecture for efficient tool loading.


## One-Click Deployment

> [!IMPORTANT]
> **Before you click:** this server depends on `@wyre-technology/node-ninjaone`,
> which is hosted on the **GitHub Packages** npm registry. GitHub Packages has no
> anonymous access — even though the package is public, every `npm install` needs a
> token. The cloud builder runs `npm install` for you, so you must give it one, or
> the build fails with `npm error 401 Unauthorized ... npm.pkg.github.com`.
>
> 1. Create a GitHub **Personal Access Token** with the `read:packages` scope
>    ([classic token](https://github.com/settings/tokens/new?scopes=read:packages&description=ninjaone-mcp%20deploy)).
>    Any GitHub account works — you do **not** need to be a member of the
>    `wyre-technology` org to read its public packages.
> 2. Add it as a build variable when prompted by the deploy flow:
>    - **Cloudflare Workers** → set a build variable named **`NODE_AUTH_TOKEN`** to your PAT
>      (Workers → Settings → Build → Variables and Secrets).
>    - **DigitalOcean App Platform** → set an encrypted env var named **`GITHUB_TOKEN`**
>      with scope **Build Time** to your PAT (the `.do/app.yaml` already declares it).

[![Deploy to DO](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/wyre-technology/ninjaone-mcp/tree/main)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wyre-technology/ninjaone-mcp)

> [!NOTE]
> Both targets run the **full** MCP server. DigitalOcean builds the Docker image and
> serves it over HTTP; Cloudflare Workers serves the same server via the SDK's Web
> Standard Streamable HTTP transport (`src/worker.ts`). After deploying, set your
> NinjaOne credentials as secrets — `NINJAONE_CLIENT_ID`, `NINJAONE_CLIENT_SECRET`,
> and optionally `NINJAONE_REGION` — or set `AUTH_MODE=gateway` to take credentials
> per-request from `X-Ninja-*` headers. The MCP endpoint is `/mcp`; `/health` is an
> unauthenticated liveness probe.

## Architecture

This MCP server uses a **hierarchical tool loading approach** instead of exposing all tools upfront:

1. **Navigation Phase**: Initially exposes only a navigation tool (`ninjaone_navigate`)
2. **Domain Selection**: User selects a domain (devices, organizations, alerts, tickets)
3. **Domain Tools**: Server exposes domain-specific tools after selection
4. **Lazy Loading**: Domain handlers and the NinjaOne client are loaded on-demand

This architecture provides:
- Reduced cognitive load (fewer tools to choose from)
- Faster initial load times
- Better organization of related operations
- Clear navigation state

## Installation

This package is published to the **GitHub Packages** npm registry, which requires a
token even for public packages. Authenticate once, then install:

```bash
# Authenticate npm to GitHub Packages (token needs the read:packages scope)
export NODE_AUTH_TOKEN=$(gh auth token)   # or a PAT with read:packages

npm install @wyre-technology/ninjaone-mcp
```

The repo's `.npmrc` already points the `@wyre-technology` scope at GitHub Packages and
reads the token from `NODE_AUTH_TOKEN`, so no further config is needed. The same applies
to `npx @wyre-technology/ninjaone-mcp` below. Prefer a zero-setup option? Use the prebuilt
container image (`ghcr.io/wyre-technology/ninjaone-mcp`) or the `.mcpb` bundle attached to
each [release](https://github.com/wyre-technology/ninjaone-mcp/releases).

## Configuration

Set the following environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `NINJAONE_CLIENT_ID` | Yes | OAuth 2.0 Client ID |
| `NINJAONE_CLIENT_SECRET` | Yes | OAuth 2.0 Client Secret |
| `NINJAONE_REGION` | No | Region: `us` (default), `eu`, or `oc` |

### NinjaOne API Regions

| Region | Base URL |
|--------|----------|
| `us` | `https://app.ninjarmm.com` |
| `eu` | `https://eu.ninjarmm.com` |
| `oc` | `https://oc.ninjarmm.com` |

## Usage

### Running Standalone

```bash
# Set credentials
export NINJAONE_CLIENT_ID="your-client-id"
export NINJAONE_CLIENT_SECRET="your-client-secret"
export NINJAONE_REGION="us"

# Run the server
npx @wyre-technology/ninjaone-mcp
```

### Claude Desktop Configuration

Add to your Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ninjaone": {
      "command": "npx",
      "args": ["@wyre-technology/ninjaone-mcp"],
      "env": {
        "NINJAONE_CLIENT_ID": "your-client-id",
        "NINJAONE_CLIENT_SECRET": "your-client-secret",
        "NINJAONE_REGION": "us"
      }
    }
  }
}
```

### Docker

```bash
docker build -t ninjaone-mcp .
docker run -e NINJAONE_CLIENT_ID=xxx -e NINJAONE_CLIENT_SECRET=xxx -e NINJAONE_REGION=us ninjaone-mcp
```

## Available Domains

### Devices
Manage endpoints, reboot devices, view services and alerts.

Tools:
- `ninjaone_devices_list` - List devices, filterable by organization, device class, and online status. Paginated: a full page returns `hasMore: true` and a `cursor` to pass back for the next page.
- `ninjaone_devices_get` - Get device details
- `ninjaone_devices_reboot` - Schedule a device reboot
- `ninjaone_devices_services` - List Windows services on a device
- `ninjaone_devices_alerts` - Get device-specific alerts
- `ninjaone_devices_activities` - View device activity log

### Organizations
Manage customer organizations and their resources.

Tools:
- `ninjaone_organizations_list` - List organizations
- `ninjaone_organizations_get` - Get organization details
- `ninjaone_organizations_create` - Create a new organization
- `ninjaone_organizations_locations` - List organization locations
- `ninjaone_organizations_devices` - List devices for an organization

### Alerts
View and manage alerts across all devices.

Tools:
- `ninjaone_alerts_list` - List alerts with filters
- `ninjaone_alerts_reset` - Reset/dismiss a single alert
- `ninjaone_alerts_reset_all` - Reset all alerts for a device or organization
- `ninjaone_alerts_summary` - Get alert count summary

### Tickets
Manage service tickets.

Tools:
- `ninjaone_tickets_list` - List tickets from a board (requires `board_id`, see note below)
- `ninjaone_tickets_get` - Get ticket details
- `ninjaone_tickets_create` - Create a new ticket
- `ninjaone_tickets_update` - Update an existing ticket
- `ninjaone_tickets_add_comment` - Add a comment to a ticket
- `ninjaone_tickets_comments` - Get ticket comments
- `ninjaone_tickets_boards_list` - List ticket boards (to discover `board_id` values)

> **Note:** NinjaOne queries tickets per board, and board IDs vary by tenant —
> board 1 is *not* always the "All Tickets" board, so `ninjaone_tickets_list`
> requires an explicit `board_id` rather than silently guessing one. Discover
> IDs with `ninjaone_tickets_boards_list`; on tenants where that endpoint
> returns 404, read the numeric ID from the board link's URL in the NinjaOne
> web UI (e.g. the "All tickets" sidebar link).

## Navigation Tools

Always available:
- `ninjaone_navigate` - Select a domain to work with
- `ninjaone_status` - Show current state and credential status
- `ninjaone_back` - Return to main menu (when in a domain)

## Example Workflow

```
User: Check my devices
Claude: [calls ninjaone_navigate with domain="devices"]
       -> Navigated to devices domain. Available tools: ...

User: List all Windows servers
Claude: [calls ninjaone_devices_list with device_class="WINDOWS_SERVER"]
       -> [device list results]

User: Now show me alerts
Claude: [calls ninjaone_back]
       -> Navigated back to main menu.
       [calls ninjaone_navigate with domain="alerts"]
       -> Navigated to alerts domain.
```

## Authentication

NinjaOne uses OAuth 2.0 for authentication. You need to:

1. Log in to your NinjaOne dashboard
2. Go to Administration > Apps > API
3. Create a new API application
4. Note the Client ID and Client Secret
5. Configure the environment variables

The client library handles token refresh automatically.

## License

Apache-2.0
