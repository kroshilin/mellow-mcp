# Mellow & Scout MCP Server

Remote [Model Context Protocol (MCP)](https://modelcontextprotocol.io/introduction) server for **Mellow** and **AI Scout**, deployed on Cloudflare Workers with Mellow OAuth.

Mellow helps freelancers, companies that hire them, and the work between — handling contracts, compliance, onboarding, and international payments. The server exposes both sides:

- **Contractor of Record (CoR)** — for companies. Engage contractors, run task lifecycle (draft → publish → accept → pay), collect closing documents.
- **AI Scout** — for companies. Find candidates, AI-generate position descriptions, share externally, manage applications, review auto-matched candidates, maintain a private pool.
- **F2B (freelancer-to-business invoicing)** — for freelancers. Manage external clients and issue invoices through Mellow as the legal intermediary.

The two sides are **mutually exclusive per session** — the server registers the right tool set based on the authorized user's role.

## What an agent gets at install time

When any MCP client (Claude Desktop, Cursor, MCP Inspector, ChatGPT) connects, the server returns three things:

1. **Tools** — registered conditionally on user role:
   - **Company mode (CoR + Scout):** 82 tools.
   - **Freelancer mode (F2B):** 10 tools.

   Every tool description spells out preconditions, error semantics, and known-bug warnings — the description is the contract the agent reads at runtime.

2. **`instructions`** (~16 KB primer) — auto-injected as system prompt by most clients. Two halves:
   - **User-facing** — what Mellow does for a company vs a freelancer, how to answer "what can you do?" in workflow terms (not tool listings).
   - **Operational** — mode-detection rule, state machines (task lifecycle, application states, invoice/client lifecycles, matched-freelancer states), ID semantics (`workerId` ≡ `freelancerId`), multi-company via `X-Company-Id`, two-step accept-and-pay, two-step F2B send invariant, confirmation rule, error semantics (400/422/409/403 disambiguation), top traps to avoid.

3. **Resources** — three on-demand reference documents the agent can read by URI:
   - `mellow://domain` — full domain guide (actors, products, state machines, preconditions, decision trees)
   - `mellow://workflows` — 13 end-to-end recipes (onboarding, accept-and-pay, Scout hiring + matched-freelancer flow, multi-currency, bulk import)
   - `mellow://anti-patterns` — common agent mistakes with bad/good examples

The primer is engineered so that an agent who reads it **before** the first tool call already knows the non-obvious rules — for example, that `acceptTask` does not pay (a separate `payForTask` step is required), and that `declineTask` is not a generic cancel.

## Architecture

The server acts as an OAuth proxy:

- **OAuth Server** to MCP clients (Claude, Cursor, etc.)
- **OAuth Client** to Mellow's auth service (`wlcm.mellow.io`)

All three product surfaces share the same auth flow and access token. The server creates two HTTP clients (`my.mellow.io` for CoR + F2B, `aiscout-api.mellow.io` for Scout) and registers a different tool set depending on the authorized user's role (`customer` → CoR + Scout; `freelancer` → F2B + profile). A per-session `X-Company-Id` header (driven by `Props.activeCompanyId`) handles multi-company users in company mode.

### Stack

- [Cloudflare Workers](https://developers.cloudflare.com/workers/) + Durable Objects
- [`workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) for OAuth 2.1
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/sdk) for MCP protocol
- [Hono](https://hono.dev/) for the OAuth callback handler
- [Zod](https://zod.dev/) for tool input validation

## Tools

### Company mode — Mellow (CoR), 49 tools

| Module                 | Tools                                                                                                                                                                                                                                                         | Description                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tasks (15)             | `listTasks`, `getTask`, `createTask`, `publishDraftTask`, `changeTaskStatus`, `changeDeadline`, `acceptTask`, `payForTask`, `declineTask`, `resumeTask`, `getTaskMessages`, `addTaskMessage`, `addTaskFiles`, `checkTaskRequirements`, `getAllowedCurrencies` | Task lifecycle. Accept-and-pay is two-step: `acceptTask` → `payForTask`. `createTask` silently saves as `DRAFT` when balance is insufficient — pre-check `getCompanyBalance`. |
| Task Groups (4)        | `listTaskGroups`, `createTaskGroup`, `renameTaskGroup`, `deleteTaskGroup`                                                                                                                                                                                     | Project / discipline grouping for document exports.                                                                                                                           |
| Freelancers (9)        | `listFreelancers`, `getFreelancer`, `inviteFreelancer`, `findFreelancerByEmail`, `findFreelancerByPhone`, `editFreelancer`, `editFreelancerProfile`, `removeFreelancer`, `getFreelancerTaxInfo`                                                               | Per-company contractor management. KYC / contact change / taxation status are handled by the freelancer in their own UI, not via this MCP.                                    |
| Transactions (1)       | `listTransactions`                                                                                                                                                                                                                                            | Company financial ledger (top-ups, debits, corrections, taxes).                                                                                                               |
| Companies (3)          | `listCompanies`, `switchCompany`, `getCompanyBalance`                                                                                                                                                                                                         | Multi-company support. Prefer `X-Company-Id` per request over `switchCompany` for parallel sessions.                                                                          |
| Documents (2)          | `listDocuments`, `downloadDocument`                                                                                                                                                                                                                           | Closing documents (invoices type 6, period reports type 7).                                                                                                                   |
| Profile (1)            | `getUserProfile`                                                                                                                                                                                                                                              | Current user info.                                                                                                                                                            |
| Reference (9)          | `getCurrencies`, `getExchangeRate`, `getTaxStatuses`, `getServices`, `getTaskAttributes`, `getAcceptanceDocuments`, `getTaxDocumentTypes`, `getSpecializations`, `getCountries`                                                                               | Lookups for catalog values.                                                                                                                                                   |
| Reference fallback (1) | `mellow_read_reference`                                                                                                                                                                                                                                       | Returns one of the `mellow://*` resources as a tool call — for clients that don't surface MCP resources.                                                                      |
| Webhooks (3)           | `getWebhook`, `createOrUpdateWebhook`, `deleteWebhook`                                                                                                                                                                                                        | Webhook configuration. `getWebhook` returns 404 with empty body when no webhook is configured — that's the "no webhook yet" signal, not an error.                             |
| ChatGPT bridge (2)     | `search`, `fetch`                                                                                                                                                                                                                                             | Cross-entity search across tasks and freelancers.                                                                                                                             |

### Company mode — AI Scout (`scout_` prefix), 33 tools

| Module                               | Tools                                                                                                                                                                                               | Description                                                                                                                                                                                                                                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Positions (7)                        | `scout_listPositions`, `scout_getPosition`, `scout_createPosition`, `scout_updatePosition`, `scout_closePosition`, `scout_openPosition`, `scout_sharePosition`                                      | Contractor request lifecycle. Two states: `active` ↔ `closed`. Always pass `company.id` from `scout_listCompanies` — backend does not dedupe by (name, website).                                                                                                                                                |
| Applications (5)                     | `scout_listApplications`, `scout_listPositionApplications`, `scout_getApplication`, `scout_changeApplicationStatus`, `scout_inviteApplicant`                                                        | Candidate pipeline (applicants who replied to the open position). Backend has no transition guards — the agent must enforce sensible status flow. `scout_inviteApplicant` is an email, not a CoR engagement.                                                                                                    |
| Matched Freelancers (5)              | `scout_listMatchedFreelancers`, `scout_getMatchedFreelancer`, `scout_markMatchedFreelancerViewed`, `scout_inviteMatchedFreelancer`, `scout_requestMatching`                                         | Async auto-matching pipeline. Backend matches Mellow's freelancer base against a new position; agent polls `scout_listMatchedFreelancers` until `status: completed`, then `markViewed` on card open and `inviteMatchedFreelancer` on confirmation. `requestMatching` re-runs the matcher (rate-limited 3/hour). |
| AI Tasks (2)                         | `scout_generatePosition`, `scout_getGeneratePositionTask`                                                                                                                                           | Async AI generation of position description.                                                                                                                                                                                                                                                                    |
| Promo Posts (2)                      | `scout_createPromoPosts`, `scout_getPromoPosts`                                                                                                                                                     | Async social-media post generation for sharing positions.                                                                                                                                                                                                                                                       |
| Pool (7)                             | `scout_getPool`, `scout_listPoolFreelancers`, `scout_getPoolFreelancer`, `scout_createPoolFreelancer`, `scout_editPoolFreelancer`, `scout_deletePoolFreelancer`, `scout_deletePoolFreelancersBatch` | Private contractor database per company. `scout_deletePoolFreelancersBatch` has no backend size cap — confirm with the user for large batches.                                                                                                                                                                  |
| Attachments / Companies / Lookup (4) | `scout_getAttachmentMetadata`, `scout_listCompanies`, `scout_getCountries`, `scout_getShortLink`                                                                                                    | Misc Scout reference / metadata.                                                                                                                                                                                                                                                                                |

### Freelancer mode — F2B invoicing (`f2b_` prefix), 10 tools

| Module       | Tools                                                                                                       | Description                                                                                                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clients (4)  | `f2b_createClient`, `f2b_listClients`, `f2b_updateClient`, `f2b_archiveClient`                              | External legal-entity clients (EUR or USD, fixed per client at creation; no individuals). `f2b_updateClient` is PATCH-like via MCP-side GET→merge→PUT→GET.                                              |
| Invoices (5) | `f2b_createInvoiceDraft`, `f2b_sendInvoiceDraft`, `f2b_getInvoice`, `f2b_listInvoices`, `f2b_cancelInvoice` | **Two-step send is mandatory:** `createInvoiceDraft` → user confirms breakdown → `sendInvoiceDraft`. After send, only recovery is `cancelInvoice` (notifies client). Bank transfer only; 5% commission. |
| Profile (1)  | `getUserProfile`                                                                                            | Current user info (same tool as company mode, conditionally registered).                                                                                                                                |

For full per-tool semantics, fetch the `mellow://workflows` and `mellow://anti-patterns` resources at runtime, or read [`docs/DOMAIN.md`](docs/DOMAIN.md) and [`docs/WORKFLOWS.md`](docs/WORKFLOWS.md) at design time.

## Documentation

Three docs are bundled into the worker and served as MCP resources:

- [`docs/DOMAIN.md`](docs/DOMAIN.md) — domain guide: products, actors, ID semantics, multi-company, state machines, preconditions, decision trees. Served as `mellow://domain`.
- [`docs/WORKFLOWS.md`](docs/WORKFLOWS.md) — 13 end-to-end recipes with concrete tool sequences and error handling. Served as `mellow://workflows`.
- [`docs/ANTI_PATTERNS.md`](docs/ANTI_PATTERNS.md) — catalogue of common agent mistakes (Bad → Why → Good). Served as `mellow://anti-patterns`.

`CLAUDE.md` at the repo root is the project-instructions file used by Claude Code when editing this repository.

## Setup

### Prerequisites

- Node.js 20+
- Cloudflare account with Workers enabled
- Mellow OAuth app credentials

### Install

```bash
npm install
```

### Secrets

Set via Wrangler (one-time):

```bash
npx wrangler secret put MELLOW_CLIENT_ID
npx wrangler secret put MELLOW_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY  # openssl rand -hex 32
```

### Environment variables

Non-secret config lives in `wrangler.jsonc`:

| Variable              | Value                               |
| --------------------- | ----------------------------------- |
| `MELLOW_API_BASE_URL` | `https://my.mellow.io/api`          |
| `MELLOW_BASE_URL`     | `https://wlcm.mellow.io`            |
| `SCOUT_API_BASE_URL`  | `https://aiscout-api.mellow.io/api` |

### KV namespace

The OAuth KV namespace is already configured in `wrangler.jsonc`. If setting up a fresh deployment:

```bash
npx wrangler kv namespace create "OAUTH_KV"
```

Update the `id` in `wrangler.jsonc` with the returned namespace ID.

## Development

```bash
npx wrangler dev
```

Server starts at `http://localhost:8788`. Create a `.dev.vars` file for local OAuth credentials:

```
MELLOW_CLIENT_ID=your_dev_client_id
MELLOW_CLIENT_SECRET=your_dev_client_secret
COOKIE_ENCRYPTION_KEY=your_random_hex_string
```

### Type check + tests

- `npm run type-check` — TypeScript correctness (primary gate).
- `npm test` — vitest unit-test suite. Tests stub `MellowClient` and `McpServer` at the module boundary (no real HTTP) and lock in handler contract: path, method, body shape, call sequence, response wrapping.

### Regenerate Cloudflare types

After modifying `wrangler.jsonc` bindings or vars:

```bash
npm run cf-typegen
```

Note: secret bindings are _not_ picked up by `wrangler types`. They are declared manually in `src/types/env-secrets.d.ts` to keep the source typed.

### Testing with MCP Inspector

```bash
npx @modelcontextprotocol/inspector@latest
```

Enter `http://localhost:8788/mcp` (Streamable HTTP, recommended) and connect. After the OAuth flow you should see:

- The agent primer in the **Server Info / Instructions** view
- 82 tools (company mode) or 10 tools (freelancer mode) listed in **Tools**
- 3 resources listed in **Resources** (`mellow://domain`, `mellow://workflows`, `mellow://anti-patterns`)

The legacy SSE endpoint at `http://localhost:8788/sse` is still served for backward compatibility but should not be used by new integrations.

## Deployment

```bash
npx wrangler deploy
```

## Connecting MCP clients

All examples below use the **Streamable HTTP** endpoint at `/mcp` (the current MCP transport standard per Cloudflare). The legacy `/sse` endpoint is kept live for older clients but is **deprecated** — point new integrations at `/mcp`.

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "mellow": {
      "command": "npx",
      "args": ["mcp-remote", "https://mcp.it-dep-271.workers.dev/mcp"]
    }
  }
}
```

### Cursor

Type: **Command**, Command: `npx mcp-remote https://mcp.it-dep-271.workers.dev/mcp`

### ChatGPT (via mcp-remote)

Same pattern as Claude Code — the client connects, completes OAuth, then has access to tools, instructions, and resources.

## Adding a tool

1. Write the registration in the appropriate `src/tools/<module>.ts`. Use `server.tool(name, description, zodSchema, handler)` and let `MellowClient` handle HTTP via `client.get/post/put/patch/del`.
2. If the description teaches the agent something non-obvious about state, errors, or known bugs — say so explicitly. Agent system prompts and tool descriptions are the primary contract.
3. Wire-up in `src/index.ts` is only needed when creating a _new_ module file.
4. Run `npm run type-check`, then `npx wrangler deploy --dry-run` for a build sanity check.

For broader edits to the agent surface (primer, resources), see `src/agent-primer.ts` and the `registerResource()` calls in `src/index.ts`.
