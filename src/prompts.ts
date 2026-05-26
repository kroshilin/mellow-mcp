import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * MCP prompts — reusable workflow templates surfaced in the client UI
 * (Claude Desktop's slash menu, Cursor's command palette, etc.). Clients call
 * `prompts/get` to fetch the rendered text and seed a new conversation turn.
 *
 * Each prompt returns a single user-role message whose text walks the agent
 * through the user-intent → tool-sequence pattern from `docs/WORKFLOWS.md`,
 * with explicit references to the relevant recipes / anti-patterns.
 *
 * Mode-aware: company-mode prompts are registered when `userRole === "customer"`,
 * F2B prompts when `userRole === "freelancer"`. Mirrors the tool registration
 * scheme in `src/index.ts`.
 */
export function registerCompanyPrompts(server: McpServer) {
  server.registerPrompt(
    "create_first_task",
    {
      title: "Create the first task for a freelancer",
      description:
        "Guided onboarding for the most common CoR flow: invite (if needed), confirm task fields with the user, balance-pre-check, create, optionally publish. Follows Recipe 1 in mellow://workflows.",
      argsSchema: {
        freelancerHint: z
          .string()
          .optional()
          .describe("Optional starting context — freelancer email, name, or id if the user mentioned one."),
      },
    },
    ({ freelancerHint }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Walk me through creating the first task for a freelancer, following Recipe 1 of `mellow://workflows`.",
              freelancerHint ? `\nStarting context: ${freelancerHint}\n` : "",
              "Steps you must follow, in order:",
              "1. If the freelancer is not yet in this company, `inviteFreelancer({email, ...})` first. Otherwise jump to step 2.",
              "2. Collect task fields from me — ask one at a time, do not invent values:",
              "   - title, description, workerId, price, deadline (ISO-8601 with timezone).",
              "   - `categoryId` from `getServices()` (pick a leaf service, not a parent).",
              "   - 3 mandatory attributes from `getTaskAttributes()` filtered by the chosen category.",
              "   - currency: verify with `getAllowedCurrencies()` if non-default.",
              "3. Pre-check balance: `getCompanyBalance()` and compute `available = balanceAmount − holdAmount − toPayAmount`. If insufficient, point me to the top-up flow (DOMAIN §4 → Topping up the balance) before continuing.",
              "4. `createTask({...})` → record the returned uuid.",
              "5. `getTask(uuid)` to read the actual state — `NEW(1)` if balance covered the task, `DRAFT(17)` if it didn't (silent downgrade — see ANTI_PATTERNS E0).",
              "6. If DRAFT: tell me the balance gate caught it, recommend top-up, then `publishDraftTask({uuid})`.",
              "",
              "After every backend call, restate the action and outcome before moving on. Never call `acceptTask` or `payForTask` as part of this flow — those come later when the freelancer delivers.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "accept_and_pay",
    {
      title: "Accept a freelancer's result and pay them out",
      description:
        "Two-step accept-and-pay flow: `acceptTask` → `getCompanyBalance` → `payForTask`. Includes balance pre-check and polling. Follows Recipe 3 in mellow://workflows + ANTI_PATTERNS A1.",
      argsSchema: {
        taskUuid: z.string().uuid().optional().describe("Task UUID. If omitted, I'll ask you to provide it."),
      },
    },
    ({ taskUuid }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Accept and pay out a task following Recipe 3 of `mellow://workflows`. `acceptTask` only moves the task to `FOR_PAYMENT (4)` — payment is a separate `payForTask` call. Common mistake; see ANTI_PATTERNS A1.",
              "",
              taskUuid ? `Task UUID: ${taskUuid}` : "Ask me for the task UUID first before doing anything.",
              "",
              "Sequence:",
              "1. `getTask({uuid})` → confirm `state === 3` (RESULT). If not, tell me the current state and stop (this flow only applies to RESULT).",
              "2. Show me the task summary (title, price, freelancer) and ask for explicit confirmation to accept.",
              "3. On 'yes': `acceptTask({uuid})` → task moves to FOR_PAYMENT(4). Read `getTask(uuid)` to verify.",
              "4. `getCompanyBalance()` → compute `available = balanceAmount − holdAmount − toPayAmount`.",
              "5. If `available < taskPrice`: STOP and tell me the shortfall. Direct to top-up (DOMAIN §4) — do NOT call `payForTask`.",
              "6. If sufficient: ask for explicit confirmation to pay. On 'yes': `payForTask({uuid})` → status moves to PAYMENT_QUEUED(12).",
              "7. Poll `getTask({uuid})` every few seconds until `state === 5` (FINISHED). Report the final state.",
              "",
              "Never report 'paid' after step 3 (that's only `acceptTask`). Never silently retry on insufficient-funds 400 — wait for me to top up.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "cancel_task",
    {
      title: "Cancel a task (soft cancel, depends on state)",
      description:
        "Read state first, then take the right path: direct `declineTask` from NEW/DRAFT, two-step via WAITING_DECLINE_BY_WORKER from RESULT/FOR_PAYMENT. Follows Recipe 17 (and Recipe 5 for the two-step branch). Addresses ANTI_PATTERNS A2/A5 — agents have falsely claimed cancellation is impossible.",
      argsSchema: {
        taskUuid: z.string().uuid().optional().describe("Task UUID. If omitted, I'll ask you to provide it."),
      },
    },
    ({ taskUuid }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Cancel a task following Recipe 17 (NEW/DRAFT direct path) or Recipe 5 (two-step via WAITING_DECLINE_BY_WORKER). The cancel is ALWAYS soft — task moves to `DECLINED_BY_CUSTOMER (8)` and stays visible in listings. There is no hard-delete API. See ANTI_PATTERNS A2 / A5 — refusing this flow because 'Mellow doesn't support it' is the false-negative trap to avoid.",
              "",
              taskUuid ? `Task UUID: ${taskUuid}` : "Ask me for the task UUID first.",
              "",
              "Sequence:",
              "1. `getTask({uuid})` — read `state`. Branch:",
              "   - `1 NEW` or `17 DRAFT`: confirm intent with me (mention 'soft cancel — record stays in listings'), then `declineTask({uuid})`. Single call.",
              "   - `11 WAITING_DECLINE_BY_WORKER`: freelancer already initiated; show me their reason from `getTaskMessages` if any, confirm, then `declineTask({uuid})`.",
              "   - `2 IN_WORK` / `3 RESULT` / `4 FOR_PAYMENT`: customer cannot cancel directly. Tell me the two options: (a) ask the freelancer to start a decline (they move it to state 11, then this flow takes over), or (b) open a dispute outside this MCP.",
              "   - terminal (`5 FINISHED`, `6 DECLINED_BY_WORKER`, `8 DECLINED_BY_CUSTOMER`, `15 DECLINED_BY_DEADLINE`): nothing to cancel; tell me the current state.",
              "2. After the decline call, re-read `getTask({uuid})` and report the actual final state. If still not `8`, surface what happened.",
              "",
              "Reminder: don't report 'task deleted' — it's a soft cancel. Say 'cancelled (status DECLINED_BY_CUSTOMER); record remains in listings'.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "scout_matching_review",
    {
      title: "Review Scout-matched freelancers for a position",
      description:
        "Poll `scout_listMatchedFreelancers` until matching completes, surface the ranked candidates to the user, mark viewed on open, invite on confirm. Follows Recipe 13 in mellow://workflows.",
      argsSchema: {
        positionId: z.string().uuid().optional().describe("Position UUID. If omitted, I'll ask you for it."),
      },
    },
    ({ positionId }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Help me review matched candidates for a Scout position following Recipe 13 of `mellow://workflows`.",
              "",
              positionId ? `Position UUID: ${positionId}` : "Ask me for the position UUID first.",
              "",
              "Sequence:",
              "1. `scout_listMatchedFreelancers({positionId})` → check `status`.",
              "   - `in_progress`: wait 3-5 s, retry from step 1. Cap polling at 5 minutes — tell me if you hit the cap.",
              "   - `failed`: tell me matching errored; offer `scout_requestMatching({positionId})` to retry (rate-limited 3/hour/position).",
              "   - `completed`: continue.",
              "2. Render the top 5-10 matches (already sorted by score DESC). For each: name, expertise area, country, experience, score, explanation.",
              "3. When I open a candidate's card: `scout_markMatchedFreelancerViewed({positionId, matchId})` (idempotent — safe to spam).",
              "4. When I say 'invite this one': **confirm with me first** (this sends an email, NOT idempotent — 409 on retry). On 'yes': `scout_inviteMatchedFreelancer({positionId, matchId})`.",
              "5. If I want to refresh the list later: `scout_requestMatching({positionId})` then back to step 1. Handle 409 (already in progress) and 429 (rate limit) gracefully.",
              "",
              "Reminder: a Scout match is NOT a CoR engagement. To start contractual work after the candidate accepts, run CoR `inviteFreelancer` separately.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
}

export function registerFreelancerPrompts(server: McpServer) {
  server.registerPrompt(
    "f2b_issue_invoice",
    {
      title: "Issue an invoice to an external client (F2B)",
      description:
        "Two-step F2B invoice flow: draft → show breakdown → confirm → send. Mandatory pause between draft and send. Follows Recipe 14 in mellow://workflows + ANTI_PATTERNS M1.",
      argsSchema: {
        clientId: z.number().int().optional().describe("F2B client id (numeric). If omitted, I'll list clients first."),
      },
    },
    ({ clientId }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Issue an F2B invoice to an external client following Recipe 14 of `mellow://workflows`. Two-step send is mandatory: don't call `f2b_sendInvoiceDraft` without first showing me the breakdown from the draft response and getting an explicit 'yes' (ANTI_PATTERNS M1).",
              "",
              clientId
                ? `Client id: ${clientId}`
                : "Start with `f2b_listClients({})` and ask me to pick one (or call `f2b_createClient` first if the client isn't there yet — see Recipe 14 step 1-3 for that).",
              "",
              "Sequence (assuming client exists):",
              "1. Collect invoice inputs from me — ask one at a time, do not invent:",
              "   - `serviceId` (Mellow service taxonomy, leaf only), `serviceName`, `serviceStartDate`, `serviceEndDate` (ISO).",
              "   - `invoiceDate` (must be ≤ today).",
              "   - `lineItems[]` (1-10 items, each `{name, quantity, measure, price}`; total ≤ 10 000 in client currency).",
              "   - `commissionPayer`: `freelancer` (deducts from your payable) or `customer` (added to client's total).",
              "2. `f2b_createInvoiceDraft({clientId, ...})` → draft only, NO email sent. Response includes `breakdown: {subtotal, commissionPercent, commissionAmount, total, payable}`.",
              "3. **SHOW ME THE BREAKDOWN.** Restate: subtotal, commission % and amount, who pays it, total, payable to me. Ask 'send?' — wait for my explicit yes.",
              "4. On 'yes': `f2b_sendInvoiceDraft({invoiceId})` → backend emails the client + exposes `paymentUrl`. Status moves `new → sent`.",
              "5. Report the final `paymentUrl` and tell me the email is in the client's inbox.",
              "",
              "Reminder: commission % is in the backend response — don't hard-code it (ANTI_PATTERNS M2). Even if I say 'just send it', still pause for breakdown confirmation — that's the whole point of the two-step.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
}
