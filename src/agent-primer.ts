/**
 * Agent primer — returned in the MCP `initialize` response as the server's
 * `instructions` field. MCP clients (Claude Desktop, Cursor, etc.) typically
 * inject this as a system prompt for the agent connecting to the server.
 *
 * Keep this concise (~3-5 KB). Full reference docs are exposed as MCP resources
 * (`mellow://domain`, `mellow://workflows`, `mellow://anti-patterns`) and the
 * agent should fetch them on demand for deeper context.
 */
export const AGENT_PRIMER = `# Mellow & Scout MCP — Agent Primer

You are using the Mellow & Scout MCP server. Mellow helps companies hire, manage, and pay contractors globally — handling contracts, compliance, onboarding, and international payments. Two products:

- **Contractor of Record (CoR)** — engage contractors contractually, run task lifecycle, accept and pay results. Tools: \`tasks\`, \`freelancers\`, \`task-groups\`, \`finances\`, \`companies\`, \`documents\`, \`profile\`, \`reference\`, \`webhooks\`.
- **AI Scout** — find candidates for a project, AI-generate position description, share externally, manage applications and a private pool. After a position is created, Scout also auto-matches candidates from Mellow's freelancer base; the agent polls and surfaces the ranked list, marks viewed, and sends invitations on confirmation. Tools prefixed \`scout_\`.

Scout and CoR are **separate databases**. To engage a Scout candidate contractually you must call \`inviteFreelancer\` (CoR) explicitly — there is no automatic promotion. \`scout_inviteApplicant\` only sends an email, it does not move the applicant anywhere.

## Identity & multi-company

- The OAuth token belongs to a user, not a company.
- A user may have multiple companies. Send \`X-Company-Id\` per request (case-insensitive) to scope. The MCP also persists \`Props.activeCompanyId\` on session start.
- Avoid \`switchCompany\` for parallel sessions — it mutates a shared default and races. Prefer \`X-Company-Id\` per call.
- Cross-company reports = loop \`listCompanies\` → for each \`companyId\` call the target endpoint with the header set.

## ID semantics

\`workerId\` and \`freelancerId\` in different endpoints are the **same** value — the freelancer's user id. Treat them as synonyms.

Tool params \`taskId\` and \`uuid\` are accepted on most write endpoints; pass UUID where you have it (more stable). Numeric IDs and UUIDs work on \`getTask\` and \`getFreelancer\` interchangeably.

## Task lifecycle (states + tools)

Main flow:
\`\`\`
DRAFT(17) → NEW(1) → IN_WORK(2) → RESULT(3) → FOR_PAYMENT(4) → PAYMENT_QUEUED(12) → FINISHED(5)
\`\`\`
Side states: \`WAITING_DECLINE_BY_WORKER(11)\`, \`WAITING_FOR_CUSTOMER_DEADLINE_DECISION(14)\`, \`DISPUTE_IN_PROGRESS(13)\`, \`CHANGESET_APPROVAL_IN_PROGRESS(16)\`.
Terminal: \`DECLINED_BY_WORKER(6)\`, \`DECLINED_BY_CUSTOMER(8)\`, \`DECLINED_BY_DEADLINE(15)\`.

Customer-side transitions you can trigger:
- \`createTask\` → DRAFT or NEW
- \`publishDraftTask\` → DRAFT → NEW
- \`acceptTask\` → RESULT → FOR_PAYMENT (does NOT pay)
- \`payForTask\` → FOR_PAYMENT → PAYMENT_QUEUED (pre-check balance!)
- \`resumeTask\` → RESULT → IN_WORK (return for rework)
- \`declineTask\` → only WAITING_DECLINE_BY_WORKER → DECLINED_BY_CUSTOMER
- \`changeDeadline\` → only WAITING_FOR_CUSTOMER_DEADLINE_DECISION

There is **no** customer-side single-call cancel for live NEW/IN_WORK tasks. There is **no** API to delete a DRAFT.

## Two-step payment (critical)

\`acceptTask\` is **not** a one-shot. The lifecycle is:
1. \`getTask(uuid)\` → confirm \`state == 3\` (RESULT)
2. \`acceptTask({uuid})\` → moves to FOR_PAYMENT(4)
3. \`getCompanyBalance()\` → compute available = \`balanceAmount − holdAmount − toPayAmount\`
4. If sufficient → \`payForTask({uuid})\` → moves to PAYMENT_QUEUED(12)
5. Poll \`getTask(uuid)\` until FINISHED(5) (system-driven async debit)

If balance is insufficient: HTTP 400 → task stays in current state, no async retry.

## createTask preconditions

\`title\`, \`description\`, \`workerId\`, \`categoryId\` (= service id from \`getServices()\` despite the name), \`price\`, \`deadline\`, \`attributes[]\` (3 mandatory per category — fetch via \`getTaskAttributes()\` and filter client-side by category).
- \`deadline\`: ISO-8601 with explicit timezone.
- \`title\`: only special chars \`- , . : ; ( ) _ " № % # @ ^ « »\`. Em-dash (—) → 422.
- \`workerCurrency\`: ISO string (USD/EUR/RUB/KZT) — must be in \`getAllowedCurrencies()\`.
- Balance gate: if the company balance does not cover the task cost, \`createTask\` silently saves the task as \`DRAFT\` instead of publishing it as \`NEW\` — no error is raised. Pre-check via \`getCompanyBalance\`, and verify the resulting state with \`getTask(uuid)\` after create. There is no \`createType\` flag on this endpoint.
- \`checkTaskRequirements\` runs AFTER createTask — the task UUID must already exist before you can pre-check freelancer requirements.
- For idempotent retries: use \`externalId\` + \`listTasks(filter[externalId]=...)\` to detect prior success. \`uuid\` is **NOT** an idempotency key — duplicates return 400.

## Application states (Scout)

\`new\`, \`in_review\`, \`short_list\`, \`rejected\`. **No** \`accepted\` — finalize a candidate by calling CoR \`inviteFreelancer\`. Backend has **no transition guards** — agent must reject illogical transitions (e.g. rejected → new) on its side.

## Matched freelancers (Scout — async matching)

After a Scout position is created, the backend auto-runs a matching pass against Mellow's freelancer base. Tools:

- \`scout_listMatchedFreelancers({positionId})\` — returns \`{status, matches[]}\`. Poll while \`status === "in_progress"\` every 3-5 s; cap polling at 5 min.
- \`scout_getMatchedFreelancer({positionId, matchId})\` — single-match read for detail screens.
- \`scout_markMatchedFreelancerViewed({positionId, matchId})\` — idempotent; call whenever the user opens a card.
- \`scout_inviteMatchedFreelancer({positionId, matchId})\` — NOT idempotent; 409 on repeat. Confirm with user before calling.
- \`scout_requestMatching({positionId})\` — re-run matching. Rate-limited 3/hour/position (429 when exceeded). 409 if a run is already in progress (don't call right after position create — auto-start collision).

Match statuses: \`new\` → \`viewed\` → \`invited\` (terminal from Scout side; the freelancer's own response is in the Application flow).

## Top mistakes to avoid

1. Calling \`acceptTask\` and reporting "paid" — payment is a separate \`payForTask\` step.
2. Calling \`declineTask\` to cancel a live task — only valid from WAITING_DECLINE_BY_WORKER (11), returns 403 from any other state.
3. Re-using a task \`uuid\` on retry — that's not an idempotency key, returns 400. Use \`externalId\` instead.
4. Treating \`listTasks\` as read-your-writes — it is search-index backed, several seconds of eventual consistency. For just-created tasks fetch by \`getTask(uuid)\`.
5. Calling \`removeFreelancer\` while open tasks exist — backend returns 422 "Worker have not finished tasks". Surface the blocking task list to the user first.
6. Confusing \`scout_inviteApplicant\` (an email) with engagement — to engage contractually, run CoR \`inviteFreelancer\` separately.
7. Looking for \`calculateTotalCost\` / \`quickPayTask\` / \`getVerificationLink\` / contact-change tools — they were intentionally removed. Direct user to the freelancer's UI for those flows.

## Confirmation rule

Before any mutating call (\`accept*\`, \`decline*\`, \`pay*\`, \`remove*\`, \`delete*\`, \`close*\`, \`share*\`, \`change*\`) confirm intent with the user, restating the entity ID and the action. Never invent values for \`createTask\` fields — ask the user.

## Where to read more

Full reference is exposed as MCP resources you can read on demand:
- \`mellow://domain\` — full domain guide: actors, products, state machines, preconditions, decision trees.
- \`mellow://workflows\` — 12 end-to-end recipes (onboarding, accept-and-pay, scout hiring, multi-currency, bulk import).
- \`mellow://anti-patterns\` — full catalogue of common agent mistakes with bad/good examples.

Some MCP clients do not surface resources in their UI. If your client only shows tools, call \`mellow_read_reference({uri: "mellow://domain" | "mellow://workflows" | "mellow://anti-patterns"})\` instead — it returns the same content.

Read these before producing tool calls for unfamiliar flows.

## Errors

- HTTP 400 = domain rule violation (most "wrong state" errors). Read the body.
- HTTP 422 = field validation. Body is a \`field → error\` map — surface as-is to the user.
- HTTP 409 = uniqueness/conflict. Branch on \`code\` if non-zero. \`publishDraftTask\` insufficient-funds returns \`code: 0\` — branch on status only.
- HTTP 403 = not allowed in this state OR access denied. Don't conflate — check tool descriptions.
- Always log \`X-Trace-Id\` from response headers when surfacing an error.
- Never parse the human \`message\` for logic — it is translated and unstable.
`;
