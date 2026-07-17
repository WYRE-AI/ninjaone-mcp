## [Unreleased]

### Added

- **Interactive alert card via MCP Apps (SEP-1865).** A new `ninjaone_alerts_get`
  tool fetches a single alert by UID, and its results render as an interactive
  card in MCP Apps hosts (Claude Desktop/web, and other hosts advertising the
  `io.modelcontextprotocol/ui` extension), instead of a wall of JSON. The card
  shows the alert title (subject/source), severity, status, device and
  organization (label-resolved server-side via the existing `devices.get` /
  `organizations.get` lookups), source type, timestamp, and message — and
  includes a working "Reset alert" round-trip that calls the existing
  `ninjaone_alerts_reset` tool from inside the card. Non-App hosts are
  unaffected: the tool's JSON payload is the raw alert plus a new `_card` field.
  - The two renderable tools (`ninjaone_alerts_get`, `ninjaone_alerts_reset`)
    advertise the UI via `_meta` (`ui/resourceUri`, plus the nested
    `ui.resourceUri` form) pointing at a new `ui://ninjaone/alert-card.html`
    resource served as `text/html;profile=mcp-app`. The server now declares the
    `resources` capability and answers `resources/list` / `resources/read` for
    the card.
  - The card is **neutral by default** and brandable via `window.__BRAND__`
    injection or `MCP_BRAND_*` environment variables (`MCP_BRAND_NAME`,
    `MCP_BRAND_LOGO_URL`, `MCP_BRAND_PRIMARY_COLOR`, `MCP_BRAND_ACCENT_COLOR`,
    `MCP_BRAND_BG`, `MCP_BRAND_TEXT`), applied at serve time by replacing the
    card's `BRAND_INJECT` marker. No branding configured = the HTML is served
    unchanged and the card renders with no brand identity.
  - The card HTML is a self-contained vite single-file bundle embedded at build
    time (`src/generated/alert-card-html.ts`, committed), so it serves
    identically from stdio, Node HTTP, and the fs-less Cloudflare Workers
    runtime. Rebuild with `npm run build:ui`; plain `npm run build` and CI do
    not need vite.

### Changed

- **Breaking:** `ninjaone_tickets_list` now requires `board_id` instead of
  silently falling back to board 1 ([#54](https://github.com/wyre-technology/ninjaone-mcp/issues/54)).
  Board IDs are tenant-specific — on multi-board tenants the old fallback could
  return a near-empty queue (1 ticket instead of ~1,400 in the reported case)
  with no indication anything was wrong. Omitting `board_id` now returns an
  actionable error pointing at `ninjaone_tickets_boards_list`.
- `ninjaone_tickets_boards_list` now returns actionable guidance when the
  underlying endpoint (`GET /api/v2/ticketing/trigger/board`) responds 404,
  which some tenants do — including how to find a board ID via the NinjaOne
  web UI instead of a bare "Resource not found" error.

### Fixed

- An unresolved MCPB/DXT config placeholder in `NINJAONE_REGION` (e.g. the
  literal `${user_config.ninjaone_region}` that Claude Desktop injects when the
  optional region field is left blank) no longer makes `getCredentials()` return
  `null` — which surfaced as "No API credentials provided" on **every** tool call
  and misdirected users to their (correct) credentials. A blank, whitespace, or
  placeholder region now falls back to `us`, aligning the stdio env path with the
  already-graceful gateway-header and Worker paths (`isValidRegion(x) ? x : "us"`).
  Mirrors itglue-mcp #73.
- `ninjaone_tickets_list` no longer throws a generic `Bad request` when a
  `status`, `organization_id`, or `device_id` filter is supplied
  ([#61](https://github.com/wyre-technology/ninjaone-mcp/issues/61),
  [#60](https://github.com/wyre-technology/ninjaone-mcp/issues/60)). NinjaOne's
  board-run endpoint cannot filter tickets by those fields server-side (the SDK
  sent a filter body the API rejects, and the 400 was indistinguishable from an
  auth failure — a silent-failure that reported *zero* open tickets across live
  client accounts). The handler now fetches the board page **without** those
  filters and matches them client-side (status against each ticket's status
  display name, organization against `clientId`, device against `nodeId`). The
  response separates `count` (matches in this page) from `scanned` and includes
  `hasMore`/`cursor`, so a single page's matches can never be mistaken for a
  board-wide total.
- `ninjaone_devices_list` now filters by `organization_id` reliably
  ([#60](https://github.com/wyre-technology/ninjaone-mcp/issues/60)). The general
  `GET /v2/devices` device filter (`df=org=<id>`) is silently dropped by NinjaOne
  often enough to be unusable — a dropped filter returned the entire fleet — so an
  organization-scoped query now routes through the dedicated
  `GET /v2/organization/{id}/devices` endpoint, which scopes by org through the
  URL path and can't be ignored. `device_class`/`online` are applied client-side
  on that path (it has no `df` support), and pagination (`hasMore`/`cursor`) is
  preserved.
- `ninjaone_devices_list` now forwards the `device_class` and `online` filters to
  the API — they were logged but never sent, so filtered calls silently returned
  the full unfiltered fleet ([#56](https://github.com/wyre-technology/ninjaone-mcp/issues/56)).
  The `device_class` enum is corrected to real NinjaOne node classes (`LINUX` and
  `VMWARE_VM` were never valid). The response now includes `count`, an explicit
  `hasMore` flag, and a `cursor` (the last device id) so the ~50-result page limit
  is detectable and paginable instead of a silent truncation.
- One-click deploys (Cloudflare Workers, DigitalOcean App Platform) no longer fail
  with `npm error 401 Unauthorized ... npm.pkg.github.com` ([#33](https://github.com/wyre-technology/ninjaone-mcp/issues/33)).
  `.npmrc` now carries an `_authToken=${NODE_AUTH_TOKEN}` line so the cloud builder
  can authenticate to GitHub Packages, and the README documents the required
  GitHub PAT (`read:packages`) build variable. `.do/app.yaml` declares a
  build-time `GITHUB_TOKEN` secret, and the Cloudflare entrypoint now bundles
  directly from `src/worker.ts`.

### Added

- **Cloudflare Workers now serves the full MCP server.** `src/worker.ts` was a
  placeholder that returned a stub response; it now uses the MCP SDK's
  `WebStandardStreamableHTTPServerTransport` to serve the complete tool set over
  `/mcp`, reusing the same `createMcpServer()` factory as the stdio and Node HTTP
  entrypoints (extracted into `src/mcp-server.ts` — no duplicated tool logic).
  Supports both env-var credentials and `AUTH_MODE=gateway` header credentials,
  plus CORS preflight and a `/health` probe. Verified end-to-end on `workerd`
  (`wrangler dev`): `initialize`, `tools/list` (24 tools), and `tools/call` all
  return correct JSON-RPC responses.

### Changed

- The package is now published to the GitHub Packages npm registry
  (`@semantic-release/npm` `npmPublish: true` + `publishConfig.registry`), so
  `npm install` / `npx @wyre-technology/ninjaone-mcp` resolve once authenticated.

- `GET /health` (and new `/healthz`) is now a shallow, unauthenticated liveness
  probe that always returns `200 {"status":"ok"}`. It no longer calls
  `getCredentials()`. In gateway mode (`AUTH_MODE=gateway`) credentials only
  arrive per-request via headers, so the previous credential check made
  `/health` always return `503`, failing the Azure Container Apps liveness
  probe and crash-looping the container.

## [1.4.2](https://github.com/wyre-technology/ninjaone-mcp/compare/v1.4.1...v1.4.2) (2026-04-07)


### Bug Fixes

* **ci:** deploy :latest tag, force revision via env var bump ([d698f40](https://github.com/wyre-technology/ninjaone-mcp/commit/d698f409cf92f55d28816c5419c0702992726ab6))

## [1.4.1](https://github.com/wyre-technology/ninjaone-mcp/compare/v1.4.0...v1.4.1) (2026-04-06)


### Bug Fixes

* per-request MCP Server+Transport for gateway compatibility ([fbe7351](https://github.com/wyre-technology/ninjaone-mcp/commit/fbe73518c5427e27129f1ee415f95cbab860709b))

# [1.4.0](https://github.com/wyre-technology/ninjaone-mcp/compare/v1.3.3...v1.4.0) (2026-03-31)


### Features

* add Canada, US2, and Federal region support ([f382a01](https://github.com/wyre-technology/ninjaone-mcp/commit/f382a0113ed61ebe4aeca450d90bffc675d16df6)), closes [#3](https://github.com/wyre-technology/ninjaone-mcp/issues/3)

## [1.3.3](https://github.com/wyre-technology/ninjaone-mcp/compare/v1.3.2...v1.3.3) (2026-03-31)


### Bug Fixes

* **deploy:** replace node_compat with nodejs_compat for Wrangler v4 ([9a2a2fe](https://github.com/wyre-technology/ninjaone-mcp/commit/9a2a2feaa659b9a375db615bc385a913a094de0e))

## [1.3.2](https://github.com/wyre-technology/ninjaone-mcp/compare/v1.3.1...v1.3.2) (2026-03-26)


### Bug Fixes

* remove unused beforeEach import in http-transport test ([802c6ad](https://github.com/wyre-technology/ninjaone-mcp/commit/802c6ad4eae00fa2cb201f6aedbce930bd08fa20))

## [1.3.1](https://github.com/wyre-technology/ninjaone-mcp/compare/v1.3.0...v1.3.1) (2026-03-26)


### Bug Fixes

* update node-ninjaone to 1.0.2 (content-type response parsing fix) ([6dce81c](https://github.com/wyre-technology/ninjaone-mcp/commit/6dce81ca27344b56e00078bd74acf9fd34d25488))

# [1.3.0](https://github.com/wyre-technology/ninjaone-mcp/compare/v1.2.4...v1.3.0) (2026-03-10)


### Features

* **elicitation:** add MCP elicitation support with graceful fallback ([#1](https://github.com/wyre-technology/ninjaone-mcp/issues/1)) ([db4d1b3](https://github.com/wyre-technology/ninjaone-mcp/commit/db4d1b32bcdc8c670bf85fd003424693958d4022))

## [1.2.4](https://github.com/wyre-technology/ninjaone-mcp/compare/v1.2.3...v1.2.4) (2026-02-24)


### Bug Fixes

* align MCP handlers with actual node-ninjaone library API ([2cd8b36](https://github.com/wyre-technology/ninjaone-mcp/commit/2cd8b367084d922617723ca118bff6b8610f864f))
* update tests to match corrected library API calls ([ad3f3e2](https://github.com/wyre-technology/ninjaone-mcp/commit/ad3f3e284f61fb5c97b04ee61b66fde047f27603))

## [1.2.3](https://github.com/wyre-technology/ninjaone-mcp/compare/v1.2.2...v1.2.3) (2026-02-23)


### Bug Fixes

* quote MCPB bundle filename to prevent shell glob expansion failure ([7b4e291](https://github.com/wyre-technology/ninjaone-mcp/commit/7b4e2910caf652f58b8e02792f4e6f8a77e8ec22))

## [1.2.2](https://github.com/wyre-technology/ninjaone-mcp/compare/v1.2.1...v1.2.2) (2026-02-21)


### Bug Fixes

* update node-ninjaone to v1.0.1 ([b1437d9](https://github.com/wyre-technology/ninjaone-mcp/commit/b1437d9b69dbd3d215c0b8621b1f3878738bed30))

## [1.2.1](https://github.com/wyre-technology/ninjaone-mcp/compare/v1.2.0...v1.2.1) (2026-02-21)


### Bug Fixes

* handle raw array responses from NinjaOne API ([bdd9a4a](https://github.com/wyre-technology/ninjaone-mcp/commit/bdd9a4abacd1931215353eb7737a0500585fed5e))

# [1.2.0](https://github.com/wyre-technology/ninjaone-mcp/compare/v1.1.3...v1.2.0) (2026-02-21)


### Features

* add comprehensive logging and fix empty response bug ([c97d547](https://github.com/wyre-technology/ninjaone-mcp/commit/c97d547d18f804b668c4f68967e5c881143b5452)), closes [#22](https://github.com/wyre-technology/ninjaone-mcp/issues/22)

## [1.1.3](https://github.com/wyre-technology/ninjaone-mcp/compare/v1.1.2...v1.1.3) (2026-02-18)


### Bug Fixes

* strip npm scope from MCPB bundle filename ([64479dc](https://github.com/wyre-technology/ninjaone-mcp/commit/64479dc93cfd7b3a441e9fc5256fbc8080dfdbca))

## [1.1.2](https://github.com/wyre-technology/ninjaone-mcp/compare/v1.1.1...v1.1.2) (2026-02-18)


### Bug Fixes

* convert pack-mcpb.js to ESM imports ([8fad901](https://github.com/wyre-technology/ninjaone-mcp/commit/8fad9016da2018a4710f0d4e930446230eaeb3b7))

## [1.1.1](https://github.com/wyre-technology/ninjaone-mcp/compare/v1.1.0...v1.1.1) (2026-02-18)


### Bug Fixes

* **ci:** fix release workflow failures ([5d315f5](https://github.com/wyre-technology/ninjaone-mcp/commit/5d315f58e2fca5859274391266eead4163b57111))

# [1.1.0](https://github.com/wyre-technology/ninjaone-mcp/compare/v1.0.2...v1.1.0) (2026-02-17)


### Features

* add MCPB bundle to release workflow ([d04a667](https://github.com/wyre-technology/ninjaone-mcp/commit/d04a667c8bf1cb0b4a651f2d33294ba6ac1ae9c2))
* add MCPB manifest for desktop installation ([15d1152](https://github.com/wyre-technology/ninjaone-mcp/commit/15d115252c3b2d2a60a50227b1b1ac72504b829e))
* add MCPB pack script ([6a4573f](https://github.com/wyre-technology/ninjaone-mcp/commit/6a4573fa7a9e212d3dc2b93b1b831f3fff486d37))

## [1.0.2](https://github.com/wyre-technology/ninjaone-mcp/compare/v1.0.1...v1.0.2) (2026-02-17)


### Bug Fixes

* **docker:** drop arm64 platform to fix QEMU build failures ([e64acd8](https://github.com/wyre-technology/ninjaone-mcp/commit/e64acd8e977c164d440d931d51923b821e37fe04))

## [1.0.1](https://github.com/wyre-technology/ninjaone-mcp/compare/v1.0.0...v1.0.1) (2026-02-17)


### Bug Fixes

* update all references from [@asachs01](https://github.com/asachs01) to [@wyre-technology](https://github.com/wyre-technology) scope ([a89a28f](https://github.com/wyre-technology/ninjaone-mcp/commit/a89a28f23c2d6cf1ab2955dfaa6da1d51e379022))

# 1.0.0 (2026-02-17)


### Bug Fixes

* **ci:** add GITHUB_TOKEN build-arg for npm auth during Docker build ([1ddf2fb](https://github.com/wyre-technology/ninjaone-mcp/commit/1ddf2fbbc0b9eec7601a28ea7c3e24fa5abe4515))
* **ci:** add npm auth for GitHub Packages, use Node 20/22, fix duplicate step IDs ([1d6252d](https://github.com/wyre-technology/ninjaone-mcp/commit/1d6252d9bd72425e4641d4b9c42e469818eb8a4e))
* **ci:** update .npmrc package scope to [@wyre-technology](https://github.com/wyre-technology) ([95dfc79](https://github.com/wyre-technology/ninjaone-mcp/commit/95dfc79c0c390fe279698b22317c2f65d45e4b35))
* **ci:** update peerDependencies scope from [@asachs01](https://github.com/asachs01) to [@wyre-technology](https://github.com/wyre-technology) ([c1b96b7](https://github.com/wyre-technology/ninjaone-mcp/commit/c1b96b71e312c514d0ccd5185ec45c4308cc542c))
* **deps:** add semantic-release plugins as devDependencies ([61ad598](https://github.com/wyre-technology/ninjaone-mcp/commit/61ad5980c629d3208a361603eb7881660a27623e))
* **docker:** simplify Dockerfile — no private deps needed ([0293033](https://github.com/wyre-technology/ninjaone-mcp/commit/0293033ccf0fea6faf002604e00d252ee7a04681))
* escape newlines in .releaserc.json message template ([46f26d0](https://github.com/wyre-technology/ninjaone-mcp/commit/46f26d060326779b05a11c69be719e3f9464c623))
* regenerate package-lock.json with semantic-release deps ([782d199](https://github.com/wyre-technology/ninjaone-mcp/commit/782d199b52633eb518668eadfdbf97f01d083a29))
* remove .npmrc — no private dependencies ([da1c5b9](https://github.com/wyre-technology/ninjaone-mcp/commit/da1c5b9b670c95e0c5abf1fbe1b1ab83d03514d7))
* remove unnecessary GitHub Packages auth from CI (no private deps) ([718ef9b](https://github.com/wyre-technology/ninjaone-mcp/commit/718ef9bd4cced5422452c523e45f8246dd95d5d0))
* remove unnecessary GITHUB_TOKEN auth from Dockerfile (no private deps) ([8ce6d63](https://github.com/wyre-technology/ninjaone-mcp/commit/8ce6d63e0621c6295e8901da57addd3179db4023))
* remove unused peerDependency on node-ninjaone (client code is inline) ([d8ef67a](https://github.com/wyre-technology/ninjaone-mcp/commit/d8ef67a076e8d18405b4267d01760268d6a0c21d))


### Features

* Add HTTP transport, Docker containers, and deployment configs ([14c28d3](https://github.com/wyre-technology/ninjaone-mcp/commit/14c28d35a5b3488d79b05bd0b4eb87a3f8ef1ffc))
* add mcpb packaging support ([22e68d5](https://github.com/wyre-technology/ninjaone-mcp/commit/22e68d5abed1a0c8431c779d747369f50df0fc51))
* add mcpb packaging support ([71c1d86](https://github.com/wyre-technology/ninjaone-mcp/commit/71c1d8682a4dac1dcfe40207e0ff17d39c90e067))
* add mcpb packaging support ([1c2b798](https://github.com/wyre-technology/ninjaone-mcp/commit/1c2b798d6bcc1b09f4459ead2f568bf7184ef440))
* add mcpb packaging support ([9d60a8d](https://github.com/wyre-technology/ninjaone-mcp/commit/9d60a8dcc9e9aac11cf8fbcffde4fa901de96387))
* add mcpb packaging support ([5036bef](https://github.com/wyre-technology/ninjaone-mcp/commit/5036bef22f75fc32a0a2110e4bdaed9062648d6f))
* add one-click deploy badges to README ([d1d6979](https://github.com/wyre-technology/ninjaone-mcp/commit/d1d6979adb702393c60990dc713dd55f3ff0908b))
* Initial release of NinjaOne MCP server ([2b1b9d4](https://github.com/wyre-technology/ninjaone-mcp/commit/2b1b9d4d2aff362b6ffca5f37e59cbee29868223))

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Structured logger utility (`src/utils/logger.ts`) with `LOG_LEVEL` env var support (`debug` | `info` | `warn` | `error`)
- API call/response logging in all domain handlers (organizations, devices, alerts, tickets)
- Response shape validation with warnings when API returns unexpected structure
- Tool call logging in `index.ts` (incoming requests, completion, errors with stack traces)
- Credential diagnostic logging in `client.ts` (warns on missing creds or invalid region)
- Enhanced `/health` endpoint with credential status, log level, and version info (returns 503 when credentials are missing)
- Startup logging with transport type, log level, and Node.js version
- Initial release of NinjaOne MCP server
- Decision tree architecture with lazy loading
- Devices domain (list, get, reboot, services, alerts, activities)
- Organizations domain (list, get, create, locations, devices)
- Alerts domain (list, reset, reset_all, summary)
- Tickets domain (list, get, create, update, add_comment, comments)
- Multi-region support (US, EU, Oceania)
- OAuth 2.0 authentication via client credentials
- Comprehensive test suite with Vitest
- HTTP Streamable transport with gateway authentication support
- Dockerfile with multi-stage build, non-root user, and OCI labels
- docker-compose.yml with production and development services
- Cloudflare Workers entry point (`src/worker.ts`) and `wrangler.json`
- DigitalOcean App Platform deployment config (`.do/app.yaml`)
- HTTP transport test suite (15 tests for health, 404, env mode, gateway auth)

### Fixed
- Empty `{}` responses from list endpoints when API returns unexpected response shape (now falls back to empty arrays via nullish coalescing)
