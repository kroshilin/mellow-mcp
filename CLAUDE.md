# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm install` — install deps
- `npm run dev` / `npx wrangler dev` — run locally on `http://localhost:8788` (requires `.dev.vars`)
- `npm run type-check` — `tsc --noEmit`, primary correctness gate
- `npm test` — vitest unit-test suite under `tests/unit/*.test.ts`. Tests stub `MellowClient` + `McpServer` at the module boundary (no real HTTP) and lock in handler contract: path, method, body shape, call sequence, response wrapping.
- `npm run cf-typegen` — regenerate `worker-configuration.d.ts` from `wrangler.jsonc` bindings
- `npm run deploy` / `npx wrangler deploy` — deploy to Cloudflare
- `npx wrangler secret put <NAME>` — set `MELLOW_CLIENT_ID`, `MELLOW_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY`
- `npx @modelcontextprotocol/inspector@latest` — manual smoke test; connect to `http://localhost:8788/mcp` (Streamable HTTP, preferred). The legacy `/sse` endpoint is still served but deprecated for new integrations.

## Architecture

Single-Worker MCP server deployed on Cloudflare Workers. Acts as an OAuth proxy: exposes OAuth 2.1 to MCP clients while delegating user auth to Mellow (`wlcm.mellow.io`). The same Mellow access token is used against the Mellow API (`my.mellow.io`) and the Scout API (`aiscout-api.mellow.io`) — via two separately-constructed clients inside one `McpAgent`. Three product surfaces exposed: **CoR** + **AI Scout** (company mode), **F2B invoicing** (freelancer mode) — registered conditionally by `userRole`.

### Request flow

1. `src/index.ts` exports `OAuthProvider` (from `@cloudflare/workers-oauth-provider`) as the Worker entrypoint. It routes `/mcp` to `MyMCP.serve`, and `/authorize` + `/callback` + `/register` + `/token` to `MellowHandler`.
2. `src/mellow-handler.ts` (Hono app) renders the approval dialog, redirects to Mellow's `/authorize`, then handles `/callback` — exchanging the code for an access token, fetching `/userinfo`, and completing authorization with `OAUTH_PROVIDER.completeAuthorization`. User identity + upstream tokens are stored as **`props`** in the issued MCP token.
3. When an MCP client calls a tool, `MyMCP.init()` runs with `this.props.accessToken` available. It constructs two `MellowClient`s (one per base URL) and calls every `register*Tools(server, client)` function.
4. Refresh: `OAuthProvider.tokenExchangeCallback` in `src/index.ts` intercepts `refresh_token` grants, calls `refreshUpstreamToken`, and rotates the stored `accessToken`/`refreshToken` in `props` transparently.

### Durable Object + KV

- `MyMCP` is registered as a SQLite-backed Durable Object (`durable_objects.bindings` in `wrangler.jsonc`, migration tag `v1`). Each MCP session gets its own DO instance; access token lives in `props`, not in the DO itself.
- `OAUTH_KV` stores OAuth state tokens, approved-client cookies, and session bindings. The namespace ID in `wrangler.jsonc` is the live production one — do not change without a `wrangler kv namespace create`.

### Tool registration pattern

Every module under `src/tools/`, `src/tools/scout/`, `src/tools/f2b/` exports one `registerXxxTools(server, client)` function that calls `server.tool(name, description, zodSchema, handler)`. CoR tools use unprefixed names; Scout tools are prefixed `scout_`; F2B tools are prefixed `f2b_`. `src/index.ts` conditionally registers Scout + CoR when `userRole === "customer"`, and F2B + profile when `userRole === "freelancer"`. Adding a tool = add a `server.tool(...)` call in the right module; wiring in `src/index.ts` is only needed when creating a **new module**.

### Agent surface (primer + resources)

The MCP server delivers three layers of context to any agent that connects:

1. **`AGENT_PRIMER`** in `src/agent-primer.ts` — a ~16 KB markdown string passed as `McpServer({...}, { instructions })`. Returned in the `initialize` response and auto-injected as system prompt by clients (Claude Desktop, Cursor, Inspector). Two halves: user-facing (what Mellow does for company vs freelancer, how to answer "what can you do?" in workflow terms) and operational (mode-detection, state machines, two-step invariants, error semantics). Aim ≤ 20 KB. Update when a _behavioural_ expectation changes (e.g. accept-and-pay, F2B two-step send), not for every tool description tweak.
2. **MCP resources** registered in `src/index.ts` via `this.server.registerResource(...)`:
   - `mellow://domain` → `docs/DOMAIN.md`
   - `mellow://workflows` → `docs/WORKFLOWS.md`
   - `mellow://anti-patterns` → `docs/ANTI_PATTERNS.md`
3. **Tool descriptions** — every `server.tool(name, description, ...)` call. The description is the primary contract for that tool. Surface preconditions, error semantics, and known-bug warnings inline.

The three markdown files are imported as strings via Wrangler's text loader (`wrangler.jsonc → rules`). The ambient declaration `declare module "*.md"` is provided by `wrangler types` (in `worker-configuration.d.ts`).

Backend bugs / tickets we file against the Mellow backend are tracked in the external issue tracker (Jira/Linear), not in this repo. When a tool description includes a "known backend bug" note, the source of truth is the linked external ticket; update the description when the backend ships a fix.

### Multi-company `X-Company-Id` plumbing

`Props.activeCompanyId` (optional, in `src/utils.ts`) is read by `MyMCP.init()` and passed to `createMellowClient(baseUrl, accessToken, activeCompanyId)`. When set, every outbound HTTP request from `mellow-client.ts` carries `X-Company-Id: <id>`. This is the recommended path for multi-company users; `switchCompany` mutates a server-side default and races across parallel sessions.

### Mellow API client

`src/mellow-client.ts` is intentionally thin: a closure over `{baseUrl, accessToken}` returning `{get, post, put, patch, del}`. It throws on non-2xx with the response body included — tool handlers let errors propagate and the MCP SDK surfaces them to the client. Query string filters for list endpoints use the bracketed form `filter[key]=value` (see `src/tools/tasks.ts` for the canonical example) — match this when adding new list tools.

### OAuth security model

`src/workers-oauth-utils.ts` implements:

- **CSRF**: double-submit cookie on the approval form
- **State binding**: `createOAuthState` stores the `AuthRequest` in KV keyed by a random token; `bindStateToSession` sets a `__Host-CONSENTED_STATE` cookie; `validateOAuthState` on `/callback` requires both KV lookup **and** cookie match. This defeats state-token injection where an attacker substitutes their own state into a victim's flow.
- **Approved clients**: once a user consents for a `clientId`, an encrypted cookie skips the approval dialog on subsequent authorizations.

Do not loosen these checks without understanding the injection attack they prevent.

## Conventions

- **2-space indentation** per `.prettierrc` (`useTabs: false`). Run `npx prettier --write <file>` before commit if unsure.
- Vitest is configured for unit tests under `tests/unit/*.test.ts`. `npm run type-check` + `npm test` are the two automated gates.
- `worker-configuration.d.ts` is generated — never hand-edit. Regenerate after changing bindings or vars in `wrangler.jsonc`. Secret bindings (`MELLOW_CLIENT_ID`, `MELLOW_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY`) are not picked up by `wrangler types`; they are declared in `src/types/env-secrets.d.ts` instead.
- `Props` type in `src/utils.ts` is the contract between `MellowHandler` and `MyMCP`; adding a field requires updating both.
- Secrets live in Wrangler secrets in prod and `.dev.vars` locally — never in `wrangler.jsonc`.
- Markdown imports (`docs/*.md`) inside `src/` rely on Wrangler's text loader rule. New `.md` resources should be wired up in `src/index.ts` via `this.server.registerResource(...)` and (if exposed to agents) referenced from `AGENT_PRIMER`.

## Known backend bugs

Active backend bugs that affect MCP tools are tracked in the external issue tracker (Jira/Linear). Tool descriptions inline a brief note about ongoing issues when the workaround needs to be agent-visible. When a backend fix lands, update the tool description and close the external ticket.
