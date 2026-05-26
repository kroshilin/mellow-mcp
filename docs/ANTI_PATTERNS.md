# Mellow — Agent Anti-patterns

> Catalog of common mistakes LLM agents make when driving the MCP, with corrected patterns. Read before producing tool calls. Each entry: **Bad** (what agents naively do) → **Why** (what breaks) → **Good** (the correct shape).
>
> Cross-reference with `docs/DOMAIN.md` (concepts) and `docs/WORKFLOWS.md` (recipes). All examples use only public MCP tools and observable HTTP behavior.

---

## A. Task lifecycle traps

### A1 — Treating `acceptTask` as a one-shot pay

**Bad**

```
acceptTask({uuid})   // expecting the task to land in FINISHED
```

**Why** — `acceptTask` only moves `RESULT (3)` → `FOR_PAYMENT (4)`. Payment is a separate explicit step. The task will sit in `FOR_PAYMENT` indefinitely if `payForTask` is never called.

**Good**

```
acceptTask({uuid})              // → FOR_PAYMENT
getCompanyBalance()             // verify available ≥ task cost
payForTask({uuid})              // → PAYMENT_QUEUED
poll getTask(uuid) until FINISHED
```

---

### A2 — Refusing to cancel a NEW or DRAFT task (false negative)

**Bad**

```
// Task is in NEW or DRAFT; user says "cancel this".
// Agent: "Mellow doesn't support cancelling tasks via API."
```

**Why** — `declineTask` IS the customer-side soft cancel and it works directly from `DRAFT (17)` and `NEW (1)` — single call, transitions to `DECLINED_BY_CUSTOMER (8)`. The agent that refuses here is hallucinating a non-existent limitation. (The limitation is real for `IN_WORK` and later, where the freelancer must initiate the decline first — but not for NEW/DRAFT.)

**Good**

- For `NEW` or `DRAFT`: confirm intent with the user, then `declineTask({uuid})`. One call.
- For `IN_WORK (2)` / `RESULT (3)` / `FOR_PAYMENT (4)`: ask the freelancer to start a decline (their side moves the task to `WAITING_DECLINE_BY_WORKER (11)`) → then `declineTask` confirms. Or open a dispute (out of MCP).
- For `WAITING_DECLINE_BY_WORKER (11)`: `declineTask` confirms what the freelancer initiated.
- Always tell the user that cancellation is **soft** — the task stays visible in `listTasks` with `state: 8 DECLINED_BY_CUSTOMER`. There is no hard-delete API.

---

### A3 — Calling `resumeTask` from non-RESULT states

**Bad**

```
// Task is in IN_WORK; user says "resume" / "restart".
resumeTask({taskId})
```

**Why** — `resumeTask` is specifically `RESULT (3)` → `IN_WORK (2)`. Other states return HTTP 400.

**Good** — read state first; only call when `state === 3`. If user says "restart" but the task isn't in `RESULT`, ask them what they actually want.

---

### A4 — Calling `changeDeadline` from arbitrary states

**Bad**

```
// Task is in NEW or IN_WORK; user says "extend the deadline".
changeDeadline({uuid, deadline: '2026-06-01T00:00:00Z'})
```

**Why** — `changeDeadline` is legal **only** from `WAITING_FOR_CUSTOMER_DEADLINE_DECISION (14)`, with the previous active state in `{NEW, IN_WORK}`, and the new deadline in the future. From any other state → HTTP 400. Shortening is not supported.

**Good** — read state first. If `state !== 14`, tell the user the deadline cannot be moved through this MCP until the soft deadline triggers and the task lands in deadline-decision state.

---

### A5 — Confusing soft cancel with hard delete

**Bad**

```
// User says "delete this task" or "discard this draft".
// Agent: "Mellow doesn't support deleting tasks via API." (refuses)
// Or worse: agent calls declineTask and reports "task deleted".
```

**Why** — there is no **hard-delete** API anywhere (confirmed by backend). But `declineTask` works as a **soft cancel** from `DRAFT (17)` and `NEW (1)` (single call) and from `WAITING_DECLINE_BY_WORKER (11)` (confirming a freelancer-initiated decline). The task moves to `DECLINED_BY_CUSTOMER (8)` — a terminal state — and stays visible in `listTasks` with that state.

**Good**

- If the user really wants the task gone from listings: explain that hard delete is not exposed; their best option is `declineTask`, which terminates the task but leaves the record. For full removal they'd need a backend support ticket.
- If the user wants to "cancel" or "discard": call `declineTask` on `DRAFT` / `NEW` directly. Confirm with the user that the record will remain visible in listings as `DECLINED_BY_CUSTOMER`.
- Don't report "deleted" — report "cancelled (soft); record stays in listings".

---

### A6 — Editing price / currency after publish without checking config

**Bad**

```
// Task is in IN_WORK; user wants to change the price.
// Agent assumes the edit endpoint will work.
```

**Why** — price / `workerCurrency` editing is allowed only in `DRAFT`, `NEW`, `DISPUTE_IN_PROGRESS`, plus `IN_WORK` / `RESULT` **only** when the company has the escrow setting enabled. Otherwise → HTTP 400.

**Good** — for live tasks without escrow, explain to the user: dispute → changeset → approve, or `resumeTask` → mutual decline → recreate. Don't promise an edit that will fail.

---

## B. `createTask` traps

### B1 — Inventing values for missing fields

**Bad**

```
// User said "create a task for John for $500".
// Agent fills in description, deadline, categoryId, attributes from thin air.
createTask({title: 'Task', description: 'TBD', categoryId: 1, deadline: 'next week', ...})
```

**Why** — invented values become contractual reality once the task is published. `categoryId` is part of the closing documents. Wrong attributes appear in invoices.

**Good** — recommendation mode: ask the user for each missing required field one at a time. Show `getServices()` results to pick `categoryId`, `getTaskAttributes()` (filtered by category client-side) to pick the 3 mandatory attributes. Don't proceed until the set is complete.

---

### B2 — Treating `uuid` as an idempotency key

**Bad**

```
// Network blip on createTask. Retry with the same uuid.
createTask({uuid: existingUuid, ...})
// Expecting either success or "already exists, here it is".
```

**Why** — duplicate `uuid` returns HTTP 400 (`UniqueUuid` violation), **not** the existing task. The retry just fails harder.

**Good** — generate a stable `externalId` client-side. Before retrying, query `listTasks({externalId: ...})` to see if the prior request actually succeeded.

---

### B3 — Skipping `categoryId`

**Bad**

```
createTask({title, description, workerId, price, deadline, attributes, ...})
// no categoryId
```

**Why** — backend requires `categoryId`. The Zod schema now also marks it required. Calling without it → HTTP 400.

**Good** — call `getServices()` once, present the list (or top matches) to the user, get explicit confirmation, then pass `categoryId`.

---

### B4 — Passing `deadline` without timezone

**Bad**

```
createTask({deadline: '2026-05-01 15:00:00', ...})
```

**Why** — without an explicit TZ the server assumes UTC. If the user meant local time, the task gets a deadline that's hours off.

**Good** — pass ISO-8601 with explicit offset: `'2026-05-01T15:00:00+03:00'`. If the user gave a date in a non-UTC zone, render the offset before sending.

---

### B5 — Confusing `workerCurrency` ISO string with currency ID

**Bad**

```
// User said EUR. Agent has 3 (numeric Currency enum value for EUR).
createTask({workerCurrency: 3, ...})
```

**Why** — `workerCurrency` on `createTask` is a **string** (`'USD'`, `'EUR'`, `'RUB'`, `'KZT'`). Numeric IDs are used in some other places (filters, `Currency` field in transactions) — mixing them up causes either a Zod validation error or a backend "unknown currency" 400.

**Good** — pass the ISO string in `createTask`. Numeric IDs only inside list filters where the schema expects a number.

---

### B6 — Treating `validateOnly` as a no-op preview

**Bad**

```
// Agent runs validateOnly, sees it succeeds, assumes the task exists.
createTask({validateOnly: true, ...})
listTasks({externalId: ...})    // expecting to find it
```

**Why** — `validateOnly: true` runs validators but writes nothing. There is no resulting task.

**Good** — use `validateOnly` for dry runs (preflight checks). For real creation, drop the flag or pass `false`.

---

## C. Read-your-writes traps

### C1 — Listing tasks immediately after creating one

**Bad**

```
createTask({...})
listTasks({externalId: ...})    // expecting the new task
// Empty result — agent thinks the create failed.
```

**Why** — `listTasks` is search-index-backed with eventual consistency (~seconds after writes). Newly created tasks may not appear in `listTasks` for several seconds.

**Good** — when you need read-your-writes, fetch by `getTask(uuid)` instead. Reserve `listTasks` for batch / discovery queries.

---

### C2 — Polling `listTasks` for status changes

**Bad**

```
loop {
  listTasks({state: [3]})    // wait for RESULT
  sleep 2s
}
```

**Why** — same eventual consistency. A state change can land in the index late or out of order. You may also miss tasks that briefly transition through a state.

**Good** — poll `getTask(uuid)` for a specific task. Use `listTasks` for snapshots, not change detection.

---

## D. Multi-company traps

### D1 — `switchCompany` in parallel sessions

**Bad**

```
// Two MCP sessions for the same user, both servicing different companies.
// Each calls switchCompany at the start.
session A: switchCompany({companyId: 42})
session B: switchCompany({companyId: 17})
session A: listTasks()   // gets company 17's tasks if B's switch landed last
```

**Why** — `switchCompany` mutates a server-side default that's shared across all sessions for the same user. Race condition.

**Good** — pass `companyId` per call (where supported, e.g., `listTasks({companyId})`). Or rely on the `X-Company-Id` header per request once that's wired up. Reserve `switchCompany` for long-lived single-company integrations.

---

### D2 — Aggregating across companies without iterating

**Bad**

```
// User: "show me all my open tasks across all companies".
listTasks({state: [1, 2, 3]})
// Returns only the active company's tasks.
```

**Why** — there is no cross-company endpoint. Every list/aggregate is scoped to the active company.

**Good**

```
companies = listCompanies()
for c in companies:
  switchCompany({companyId: c.id})    // or pass companyId per call
  tasks_for_c = listTasks(...)
aggregate client-side.
```

---

## E. Money traps

### E0 — `createTask` without balance pre-check (silent DRAFT downgrade)

**Bad**

```
createTask({title, description, workerId, ...})
// Agent reports: "task created, the freelancer will see it"
// Reality: task is in DRAFT — the freelancer cannot see it
```

**Why** — `createTask` does not fail when the company balance is too low. Without `createAsDraft`, it silently saves the task as DRAFT instead of publishing it. No error or warning is returned. The agent reports success to the user; the user comes back hours or days later asking why the freelancer never responded — because the task was never actually published.

**Good**

1. **Decide the intent first.** Did the user say "save as draft / let me review first" or "publish to the freelancer"?
   - **Draft on purpose** → pass `createAsDraft: true`. Balance is NOT checked — the task lands as DRAFT every time.
   - **Publish** → omit `createAsDraft`; pre-check `getCompanyBalance` to predict whether the balance gate will downgrade to DRAFT.
2. If publishing and the balance does not cover the task cost, tell the user to top up at https://my.mellow.io/ → Finances → Top up balance (full flow in `mellow://domain` § "Topping up the balance"). Stop — do not call `createTask` until the top-up clears.
3. `createTask({..., createAsDraft?})`.
4. **Always** call `getTask(uuid)` after create to read the actual state — never trust the create call alone. Tell the user what landed:
   - **NEW** — published; freelancer can see and accept.
   - **DRAFT** — either the user asked for it (intentional, `createAsDraft: true`) or the balance gate caught it (unintentional — say so explicitly and recommend top-up + `publishDraftTask`).

---

### E1 — `acceptTask` without balance pre-check

**Bad**

```
// Under "hold on accept" company config.
acceptTask({uuid})
// 400 — task stays in RESULT, no auto-retry.
```

**Why** — under that hold policy the balance check happens at accept. Insufficient → HTTP 400, task doesn't move.

**Good** — always pre-check: `getCompanyBalance()` → `available = balanceAmount − holdAmount − toPayAmount`. If short, tell the user to top up before accept.

---

### E2 — `payForTask` without balance pre-check

**Bad**

```
payForTask({uuid})
// 400 if balance is short — task stays in FOR_PAYMENT.
```

**Why** — same fundamental issue. Under "no hold" / "hold after accept" the balance check happens at pay.

**Good** — pre-check before `payForTask` regardless of suspected hold policy. Cheaper than a 400 round trip.

---

### E3 — Forgetting `payForTask` after `acceptTask`

**Bad**

```
acceptTask({uuid})
// Agent reports "paid!" to the user.
```

**Why** — task is in `FOR_PAYMENT`, not `FINISHED`. The freelancer has not been paid.

**Good** — always chain `acceptTask` → balance check → `payForTask` → poll `getTask` until `FINISHED`. Don't claim "paid" until the state is terminal.

---

### E4 — Multi-currency: assuming the rate is fresh at pay time

**Bad**

```
calculateTotalCost(...)    // (now removed from MCP, but conceptually)
// or: read getExchangeRate
... days pass ...
createTask(...)            // user thinks the rate they saw still applies
```

**Why** — the exchange rate is locked **at task creation time**, not earlier. Showing a quote and then creating the task days later means the user sees a different number.

**Good** — for a "lock the rate" UX, create a `DRAFT` immediately after showing the rate; publish later. The DRAFT carries the locked rate.

---

## F. Scout traps (backend permissive, agent must guard)

### F1 — Silent illogical status transitions

**Bad**

```
// User clicks "shortlist" on an already-rejected application.
scout_changeApplicationStatus({applicationId, status: 'short_list'})
// Backend accepts it. User has no idea they "un-rejected" them.
```

**Why** — backend has **no transition guards**. `rejected → short_list → new` are all accepted. The current `status` is overwritten without warning.

**Good** — read the current `status` first. If the transition seems wrong (e.g., `rejected → anything`, `short_list → new`), confirm with the user before calling. Treat the API as a setter, not a workflow engine.

---

### F2 — Sharing a closed or un-moderated position

**Bad**

```
scout_sharePosition({positionId, shareTarget: 'linkedin'})
// Position is CLOSED. Backend posts the share anyway.
```

**Why** — backend doesn't block sharing closed or `moderatedAt: null` positions. The promo will go out for a position that nobody can apply to.

**Good** — `scout_getPosition({positionId})` first; only share when `status === 'active'`. If un-moderated, warn the user the position may not look complete to viewers.

---

### F3 — `scout_deletePoolFreelancersBatch` without confirming size

**Bad**

```
// User says "clean up the pool".
scout_deletePoolFreelancersBatch({ids: [...allPoolIds]})
```

**Why** — there is no backend cap on batch size. One call can wipe the entire pool.

**Good** — for any batch > 10, show the count to the user and ask explicit confirmation. Echo back at least the count and a few sample names.

---

### F4 — Confusing `scout_inviteApplicant` with engagement

**Bad**

```
scout_inviteApplicant({applicationId})
// Agent says "they're now in your team".
```

**Why** — `scout_inviteApplicant` only sends an email with hirer's contact info. It does **not** change the application's status, **does not** add the candidate to any pool, and does **not** create a CoR freelancer. Second call → 409 (irreversible).

**Good** — to actually engage a candidate contractually, call `inviteFreelancer({email: candidate.email, ...})` (CoR-side) **separately**.

---

### F5 — Looking for `accepted` status on an application

**Bad**

```
scout_changeApplicationStatus({applicationId, status: 'accepted'})
// Zod rejects: 'accepted' is not in the enum.
```

**Why** — the `ApplicationStatus` enum is `new | in_review | short_list | rejected`. There is no `accepted`. Finalizing a candidate is a separate domain-crossing step (Scout → CoR).

**Good** — to "accept" a candidate, mark them `short_list` (or leave as `in_review`), then move them into CoR via `inviteFreelancer({email})`.

---

### F6 — Forgetting `poolId` when adding pool freelancers

**Bad**

```
scout_createPoolFreelancer({firstName, lastName, email, ...})
// Zod rejects: poolId required.
```

**Why** — the company's pool has its own UUID. Pool tools require it.

**Good**

```
pool = scout_getPool()
scout_createPoolFreelancer({poolId: pool.id, ...})
```

---

## G. Bulk import traps

### G1 — Hunting for a non-existent bulk endpoint

**Bad**

```
// Agent searches the schema or guesses tool names like
// `bulkInviteFreelancers`, `tasksImport`, `bulkCreateTasks`.
```

**Why** — there are **no** bulk endpoints on the backend. Confirmed by the API team. Recipes 11 / 12 use row-by-row loops.

**Good** — go straight to the canonical row-by-row loop with pacing. Don't waste a turn looking for the magic endpoint.

---

### G2 — Treating bulk operations as atomic

**Bad**

```
// All 100 invites/tasks succeed-or-fail together in one transaction.
// Agent rolls back state on partial failure.
```

**Why** — bulk operations are inherently non-atomic in this MCP. Earlier successful rows are real. There is no rollback.

**Good** — collect a per-row report. Retry only failed rows. Use `externalId` to make per-row creation idempotent.

---

### G3 — Reusing `externalId` without checking

**Bad**

```
// Retrying after a crash.
for row in failed_rows:
  createTask({externalId: row.externalId, ...})
// Some rows had succeeded last time → now duplicate violation.
```

**Why** — `externalId` is unique per `(companyId, externalId)`. Naive retry hits collisions.

**Good**

```
existing = listTasks({externalId: row.externalId})
if existing.length > 0:
  skip   // already created
else:
  createTask({externalId: row.externalId, ...})
```

---

### G4 — No pacing on bulk loops

**Bad**

```
for row in 500 rows:
  createTask(row)    // back-to-back
```

**Why** — token-shared rate limits. Sustained burst can hit 429.

**Good** — pace at 1 request per ~200–500ms. For large batches, chunk and confirm with the user between chunks.

---

## H. Error / observability traps

### H1 — Branching on the `message` field

**Bad**

```
if response.error.message.contains("insufficient"):
  ...
```

**Why** — `message` is translated by `Accept-Language` and changes between releases.

**Good** — branch on `code` for HTTP 409 (stable enough). For 422, render the `field → error` map; don't try to derive a uniform error code from text.

---

### H2 — Branching on HTTP status alone

**Bad**

```
if status === 409:  // assume conflict
if status === 422:  // assume validation
if status === 400:  // assume "client error" generic
```

**Why** — most domain errors come back as HTTP 400 (e.g., wrong task state, insufficient funds). Status alone is too coarse.

**Good** — combine status with `code` (when present). Read the body. Log `X-Trace-Id` regardless.

---

### H3 — Not surfacing `X-Trace-Id`

**Bad**

```
catch (err) { tellUser("Something went wrong.") }
```

**Why** — without a trace ID, support can't diagnose. The user is stuck.

**Good** — capture `X-Trace-Id` from response headers; show it to the user (or attach to support context) on any 4xx/5xx.

---

## I. Schema confusion

### I1 — Assuming `getTaskAttributes(categoryId)` filters server-side

**Bad**

```
attrs = getTaskAttributes({categoryId: 42})
// Agent uses the response as if it's already category-scoped.
```

**Why** — the endpoint returns the **global** catalog. The `categoryId` parameter is for client-side filtering only (a recipe-level convention).

**Good** — fetch once, cache, filter the response client-side by walking the per-attribute category metadata.

---

### I2 — Mixing up `findFreelancerByEmail` semantics

**Bad**

```
result = findFreelancerByEmail(email)
// throws on 404 → agent thinks the API is broken
```

**Why** — non-2xx throws (per `mellow-client.ts` convention). A 404 means "not found in this company" — a totally normal answer for "do they exist already?"

**Good** — wrap the call: catch the throw, treat 404 as "not found", proceed with `inviteFreelancer`.

---

### I3 — Numeric `taskId` vs string UUID confusion

**Bad**

```
// Agent has only the UUID from a recent createTask.
getTaskMessages({taskId: 123})    // wrong — that's a stale numeric ID
```

**Why** — task tools were asymmetric — some required numeric `taskId`, some accepted UUID. Now they all accept either form, but agents trained on the old shapes still mismatch.

**Good** — pass `uuid` if you have it. Pass `taskId` if you have only the numeric ID. Don't fabricate one from the other.

---

## J. Confirmation & safety

### J1 — Mutating without explicit user confirmation

**Bad**

```
// User: "look at task 5".
// Agent reads it, decides it's done, calls acceptTask.
```

**Why** — mutating actions touch contractual reality. Agents should never assume intent.

**Good** — for any tool starting with `accept*`, `decline*`, `pay*`, `remove*`, `delete*`, `close*`, `share*`, `change*` — restate the action and the entity ID, then ask the user to confirm before calling.

---

### J2 — `removeFreelancer` without surfacing the backend block

**Bad**

```
removeFreelancer({freelancerId: X})
// HTTP 422 "Worker have not finished tasks" — agent surfaces a generic "removal failed" to the user
// without explaining which tasks block it.
```

**Why** — backend blocks the delete with HTTP 422 if any task is in a non-terminal state in this company. The error message ("Worker have not finished tasks") is correct but doesn't list which tasks. The agent should pre-check so it can show the user a concrete list and let them resolve those tasks first.

**Good**

```
open = listTasks({workerId: X, state: [1, 2, 3, 4, 11, 13, 14, 16]})
if open.length > 0:
  show the list to the user and explain removal is blocked until those tasks reach a terminal state.
else:
  removeFreelancer({freelancerId: X})  // async — HTTP 200 returns before status flip
```

---

### J3 — Inventing values when data is incomplete

**Bad**

```
// User: "invite Anna".
inviteFreelancer({email: "anna@example.com", firstName: "Anna", lastName: "Doe"})
// Made up the surname and email.
```

**Why** — invented contact data goes into onboarding emails and contracts. Hallucinations have permanent consequences.

**Good** — ask. "I need Anna's email to invite her — can you share it?" Don't proceed until the user provides real data.

---

## K. MCP-surface awareness

### K1 — Calling tools that no longer exist (or shouldn't)

**Bad**

```
calculateTotalCost(...)        // removed from MCP scope
quickPayTask(...)              // removed
getVerificationLink(...)       // removed
requestContactChangeCode(...)  // removed
changeTaxationStatus(...)      // removed
```

**Why** — these flows are intentionally not part of this MCP. The freelancer side fixes their own KYC/contacts/tax through their UI.

**Good** — when the user asks for those flows, explain that they're handled outside this MCP and direct them to the appropriate UI.

---

### K2 — Looking for editTask / shortenDeadline / cancelDraft

**Bad**

```
// Hunting for a generic "edit task" tool.
```

**Why** — there is no `editTask` exposed via this MCP, no shorten-deadline endpoint, no draft cancel/delete. Confirmed by the API team.

**Good** — explain to the user that those operations aren't available. For price/scope changes after publish: dispute (out of MCP) or recreate. For drafts: leave them.

---

## M. F2B traps (freelancer mode)

### M1 — Calling `f2b_sendInvoiceDraft` without showing the breakdown to the user

**Bad**

```
// User said "issue the invoice and send it".
f2b_createInvoiceDraft({...})
f2b_sendInvoiceDraft({invoiceId})  // immediately after create
```

**Why** — the two-step send is **mandatory** by design (see DOMAIN §10.4). The draft response carries `breakdown: {subtotal, commissionPercent, commissionAmount, total, payable}` — the agent is supposed to surface that to the user and get a confirming "yes" before sending. Once `sendInvoiceDraft` returns, the email is in the client's inbox; the only recovery is `f2b_cancelInvoice`, which also pings the client.

**Good** — even when the user says "create and send", still pause between calls. Show the breakdown ("subtotal €X, commission Y% = €Z paid by {you|client}, total €T, payable to you €P") and ask "send?" before the second call. There is **no** `f2b_createAndSendInvoice` shortcut. Do not invent one.

---

### M2 — Hard-coding the commission percentage

**Bad**

```ts
const total = subtotal * 1.05; // assume 5%
```

**Why** — commission rate is a backend-controlled value returned in `breakdown.commissionPercent` on every draft. It can change (e.g. when card-payment is re-enabled, the rate becomes payment-method-dependent). A hard-coded 5% will silently mislead users the day the rate changes.

**Good** — read `breakdown.commissionPercent` and `breakdown.commissionAmount` from the `f2b_createInvoiceDraft` response. Render those numbers verbatim.

---

### M3 — Treating `f2b_archiveClient` as a hard delete

**Bad**

```
// User said "I won't work with this client again, remove them".
f2b_archiveClient({clientId})
// then assumes the existing sent invoices stop working
```

**Why** — archive is a soft state. Already-sent invoices keep working (client can still pay). New `createInvoiceDraft` against the archived client is rejected with 422. There is **no** un-archive endpoint — to re-engage, create a brand-new client record.

**Good** — confirm with the user the asymmetric behavior: archive blocks new invoices but keeps existing ones live. Mention there's no undo.

---

### M4 — Quick wins

These come up often but don't deserve a full Bad/Why/Good walkthrough:

- **Trying to invoice an individual.** Only `type=legal` (companies) is supported. F2B does not accept payments from individuals; the schema doesn't expose `type`. Point the user at local invoicing tools instead.
- **Backend-side filters that don't exist.** `f2b_listClients` and `f2b_listInvoices` accept `status` + pagination only — no `clientId` / `email` / `companyName` / date-range filters. Page through results and filter MCP-side.

---

### M5 — Promising withdrawals, tax docs, or Offers from this MCP

**Bad**

```
// User: "Withdraw my balance to my card"
// Agent looks for a withdraw tool, finds none, hallucinates one.
```

**Why** — these are real Mellow capabilities but **not exposed by this MCP** (see DOMAIN §10.7). They live in the web cabinet only.

**Good** — direct the user to https://my.mellow.io/ for: withdrawals (bank / card / wallet / crypto), tax document downloads, and Offers (Secure Deal escrow product).

---

## L. Quick checklist (read before every mutating call)

- [ ] Did I confirm intent with the user using the entity ID and tool name?
- [ ] Did I read current state via `getTask` / `getCompanyBalance` / `scout_getPosition` / `f2b_getInvoice`?
- [ ] Is the state legal for this transition?
- [ ] If money is involved: did I pre-check the balance (company mode) or surface the breakdown (F2B send)?
- [ ] If `createTask` / `f2b_createInvoiceDraft`: are all required fields user-provided (no inventions)?
- [ ] If `f2b_sendInvoiceDraft`: did I just show the user the breakdown and get an explicit "yes"?
- [ ] If retrying: did I check `externalId` via `listTasks` first (CoR) or `f2b_getInvoice` to avoid duplicate sends (F2B)?
- [ ] If multi-company (company mode): am I sure which company is active?
- [ ] If 4xx: did I capture `X-Trace-Id`?
