# Mellow & Scout — Domain Guide for Agents

> Read this **before** calling any tool. Describes only what an agent observes via the MCP tools and the public API.

---

## 1. Actors

| Role | Where | Notes |
|---|---|---|
| **Customer (Admin)** | CoR | Full permissions: invite freelancers, create/pay tasks, configure webhooks. |
| **Customer (Member)** | CoR | Restricted subset. Treat any 403 as "this user cannot do this". |
| **Freelancer** | CoR | Contractor the company engages. Receives payouts. Logs in via the same OAuth but uses freelancer-only endpoints (out of scope for this MCP). |
| **Applicant** | Scout | Candidate who responded to a contractor request. Inside Scout only until invited into CoR. |
| **Pool Freelancer** | Scout | Contractor uploaded by the company into its private pool. |

**ID synonyms:** `workerId` and `freelancerId` in different endpoints are the **same value** — the freelancer's user ID. Treat them as synonyms.

---

## 2. Multi-company

- One email = one user = possibly many companies. Common scenario, not edge case.
- No cross-company endpoint. For cross-company reports: loop `listCompanies` → call each endpoint with `X-Company-Id: {companyId}`.

Two ways to set the company context:

1. **`X-Company-Id` request header** (preferred) — per-request override. Case-insensitive. Wired through `Props.activeCompanyId`. 403 if user doesn't belong.
2. **Server-side default** via `switchCompany` (`POST /api/customer/companies/{companyId}/default`). Persists across sessions. **Avoid for parallel sessions** — mutates a shared default and races.

| Scenario | Use |
|---|---|
| Long-lived single-company integration | `switchCompany` once, rely on default |
| Parallel sessions / multiple companies | `X-Company-Id` per request, never `switchCompany` |
| Mixed UI + API on same account | `X-Company-Id` per request to avoid clobbering UI default |

---

## 3. Scout ↔ CoR boundary

- **Separate databases.** A Scout Applicant is **not** automatically a CoR Freelancer.
- To engage a Scout candidate contractually → call `inviteFreelancer` (CoR side). Creates a new CoR record.
- `scout_inviteApplicant` only sends an email with hirer's contact — does **not** add to Pool, **does not** change application status, **is not** a CoR invite.

---

## 4. Glossary

### CoR

- **Task** — agreement between customer and contractor (description, deadline, price). Multi-currency supported (rate locked at creation; balance debited in company currency, contractor receives task currency, closing docs stay in company currency). Default pair: €/$.
- **Task Group** — organizational container (project / department) for document export segmentation. No financial/state effect.
- **Service** (param `categoryId` in `createTask` — wire-name is V1 legacy) — required leaf-level service id from `getServices()`. Catalog has 1000+ entries. Passing a parent category id → 422 "Service is not available".
- **Service Attribute** — `[{id, value}]` pairs, captured at task creation. Up to 8 available; **3 mandatory per category**. Values appear in closing documents.
- **Specialization** — freelancer attribute (skill label), not a task attribute.
- **Acceptance Document** — NDAs and similar required before working. Retrieved via `getAcceptanceDocuments`. Adding to the catalog is a support operation.

### Scout

- **Position** — contractor request. Top-level Scout object. Synonyms: "request", "contractor request".
- **Application** — candidate's response to a Position. One candidate may apply to many positions.
- **Pool** — company's private candidate database (per-company). Same freelancer can be in multiple pools independently.
- **Promo Post** — AI-generated social text for sharing a Position. **Async**: `POST /api/positions/{id}/promo-post` triggers generation, `GET` polls for results. Re-posting overwrites.

### Money

- **Transaction** — line in the company ledger. `type`: `1` top-up, `2` debit, `3` correction, `4` tax. Company-scoped. Payout-related fields (`payoutStatus`, `payoutAmount`, `payoutCommission`, `payoutCurrency`, `rate`, `tax`) populated only on payout-type lines.
  - **Currency values** (`filter[currency]` and `currency` field): `1 RUB`, `2 USD`, `3 EUR`, `4 KZT`.
  - **Payout sub-status** (`filter[payoutStatus]`): `0 UNKNOWN`, `1 IN_PROCESS`, `2 DONE`, `3 DECLINE`, `4 DECLINE_NOT_FINISH`, `5 PARTIALLY_FINISHED`, `10 NEW`, `11 COMPLIANCE`.
- **Balance** — company funds in Mellow, available to settle tasks. Topped up via the web cabinet (see "Topping up the balance" below). **One currency per company**, fixed at company creation.
- **Allowed Currencies** (per company) — subset for multi-currency tasks. USD/EUR always included; rest depend on company config.
- **Exchange Rate** — Mellow's internal FX rates (`{base, target, rate}` triples) used by multi-currency tasks.

### Topping up the balance

Mellow does not expose a top-up API — there is no MCP tool for it. When the agent detects the company balance is insufficient (via `getCompanyBalance`, or after a 409 / silent-DRAFT signal from `publishDraftTask` / `createTask`), direct the user to the web cabinet:

1. Open https://my.mellow.io/ → log in with the same account.
2. Pick the company that needs funding (top-left switcher if multi-company).
3. Go to **Finances → Top up balance**.
4. Choose the amount; currency is fixed to the company's balance currency.
5. The system generates a top-up invoice (it will later appear in `listDocuments` as `type=6 INVOICE`).
6. The user wires the funds to the IBAN on that invoice. **SEPA: 1–3 business days. SWIFT: up to 5.**
7. Mellow credits the balance automatically once funds clear. No manual confirmation needed.

If the user is stuck or the wire doesn't show up after the expected window — Mellow support: support@mellow.io.

Tool descriptions for `createTask`, `publishDraftTask`, `acceptTask`, and `payForTask` carry the `https://my.mellow.io/` pointer inline for fast recovery — this section is the fuller reference if the user wants detail.

### Documents

`listDocuments` returns two kinds: `type=6 INVOICE` (top-up invoices) and `type=7 REPORT` (period closing reports). Each entry carries `fileId` plus optional `sfsFileId` (invoice factura) and `taxFileId` (REPORT only). Contracts, passports, per-task acts — not here. `downloadDocument` packages results into a ZIP **asynchronously** — delivered via notifications.

### Taxation status

Freelancer's regulatory classification (individual / self-employed / entrepreneur / …). Affects available payout channels. Visible in `getFreelancer` as `taxationStatus`.

---

## 5. Task lifecycle

### 5.1 States

14 values visible in the `state` field. Pass numeric IDs to `PUT /api/customer/tasks/{id}`. (Gaps 7/9/10 are historical — never seen.)

| ID | Name | Group | Meaning |
|---|---|---|---|
| 17 | `DRAFT` | active | Created, not published. Freelancer doesn't see it. |
| 1 | `NEW` | active | Published. Awaiting freelancer accept. |
| 2 | `IN_WORK` | active | Freelancer accepted and working. |
| 3 | `RESULT` | active | Result submitted. Customer reviews. |
| 4 | `FOR_PAYMENT` | active | Customer accepted. Awaiting payout call. |
| 12 | `PAYMENT_QUEUED` | transient | Payout being debited (system). |
| 5 | `FINISHED` | terminal | Closed and paid. |
| 6 | `DECLINED_BY_WORKER` | terminal | Freelancer declined. |
| 8 | `DECLINED_BY_CUSTOMER` | terminal | Customer confirmed freelancer's decline. (No single-call cancel for live `NEW`/`IN_WORK` — see §5.6.) |
| 15 | `DECLINED_BY_DEADLINE` | terminal | System-closed after customer didn't decide on soft deadline. |
| 11 | `WAITING_DECLINE_BY_WORKER` | side | Freelancer requested decline; awaiting customer confirm. |
| 14 | `WAITING_FOR_CUSTOMER_DEADLINE_DECISION` | side | Soft deadline reached; customer must extend or cancel. |
| 13 | `DISPUTE_IN_PROGRESS` | side | Dispute opened. Work paused. |
| 16 | `CHANGESET_APPROVAL_IN_PROGRESS` | side | Change to terms proposed; awaiting other side. |

Happy path: `DRAFT → NEW → IN_WORK → RESULT → FOR_PAYMENT → PAYMENT_QUEUED → FINISHED`.

### 5.2 Transitions you can trigger

| From → To | Tool |
|---|---|
| (none) → `NEW` or `DRAFT` | `createTask` — `NEW` when balance ≥ `priceWithCommission`, `DRAFT` otherwise (silent backend downgrade; verify via `getTask(uuid).state`) |
| `DRAFT` → `NEW` | `publishDraftTask` |
| `RESULT` → `FOR_PAYMENT` | `acceptTask` (also from `WAITING_DECLINE_BY_WORKER` / `WAITING_FOR_CUSTOMER_DEADLINE_DECISION`) |
| `FOR_PAYMENT` → `PAYMENT_QUEUED` | `payForTask` |
| `RESULT` → `IN_WORK` | `resumeTask` (return for rework) |
| `WAITING_DECLINE_BY_WORKER` → `DECLINED_BY_CUSTOMER` | `declineTask` (or `changeTaskStatus(state=8)`) |
| `WAITING_FOR_CUSTOMER_DEADLINE_DECISION` → previous | `changeDeadline` |

**Not reachable via this MCP** (freelancer- or system-driven): `NEW → IN_WORK`, `IN_WORK → RESULT`, `* → DECLINED_BY_WORKER`, all dispute paths, `PAYMENT_QUEUED → FINISHED` (system async), soft-deadline triggers.

### 5.3 Mutation guards

| Tool | Legal states | Otherwise |
|---|---|---|
| `changeDeadline` | only `WAITING_FOR_CUSTOMER_DEADLINE_DECISION (14)`, with prev active state in `{NEW, IN_WORK}`, new deadline in future | 400 |
| `addTaskFiles` | everything except `FINISHED`, `PAYMENT_QUEUED` | 400 |
| `addTaskMessage` | any state | — |
| Edit price / `workerCurrency` | `DRAFT`, `NEW`, `DISPUTE_IN_PROGRESS`, plus `IN_WORK`/`RESULT` **iff** company escrow is enabled | 400 |
| Mutate after payment | `FINISHED (5)` and `PAYMENT_QUEUED (12)` are fully read-only | 400 |

### 5.4 `createTask` preconditions

Validated server-side (HTTP 400 before any row is written — applies equally to draft and direct publish):

1. `workerId` must be a known user.
2. Freelancer must not be tax-blocked: if their country is taxable, `taxationStatus` must not be the default placeholder; income/tax limits must not be hit.
3. `workerCurrency` must be in `getAllowedCurrencies()`.
4. `(company, worker)` taxation limits must not be exceeded.

**Not checked at create:** verification, offer-agreement, profile completeness. Those fail when the freelancer tries to accept — task can be created for an unverified freelancer, but they cannot accept.

**Recommended:** call `checkTaskRequirements(taskUuid, freelancerUuid)` **after** `createTask` (the endpoint requires an existing task) to surface unmet items before publishing.

### 5.5 Accept-and-pay (two-step, with hold mechanics)

Customer-side payment is **two explicit calls**:

1. `acceptTask({uuid})` → `RESULT (3)` → `FOR_PAYMENT (4)`
2. `payForTask({uuid})` → `FOR_PAYMENT (4)` → `PAYMENT_QUEUED (12)` (system asynchronously finishes to `5`)

Companies have one of four hold policies (per-company config, agent doesn't choose):

| Policy | Funds reserved at | Funds debited at |
|---|---|---|
| No hold | never | `PAYMENT_QUEUED` (post-hoc) |
| Hold on task create | `createTask` (non-draft) or `publishDraftTask` | `FINISHED` |
| Hold on task accept | `acceptTask` | `FINISHED` |
| Hold after task accept | async right after accept | `FINISHED` |

The balance check happens **either at `acceptTask` (hold-on-accept) or at `payForTask` (other policies)**. Insufficient funds → HTTP 400, task stays in current state, no async retry.

**Always pre-check:** `getCompanyBalance()` returns `{currency, balanceAmount, holdAmount, toPayAmount, ...VAT...}` — there is **no server-provided `available` field**. Compute `available = balanceAmount − holdAmount − toPayAmount` client-side. Multi-currency tasks convert to company currency at hold time.

### 5.6 Cancellation paths

There is **no single-call cancel** for live `NEW`/`IN_WORK` tasks. Available paths to a terminal state:

- **DRAFT (17)** — no cancel/delete API. Draft persists until published or cleaned up by support.
- **NEW / IN_WORK** — ask the freelancer to start a decline (their side) → then `declineTask` confirms → `DECLINED_BY_CUSTOMER`. Or open a dispute (out of MCP).
- **WAITING_DECLINE_BY_WORKER (11)** — `declineTask` confirms freelancer's decline.
- **WAITING_FOR_CUSTOMER_DEADLINE_DECISION (14)** — let timer expire → system sets `DECLINED_BY_DEADLINE (15)`.

Editing price/description after publish is also **not exposed** via this MCP. Workarounds: dispute → changeset (out of MCP), or `resumeTask` + decline + recreate.

---

## 6. Freelancers

### 6.1 Composite onboarding state

There is no single `isReadyToWork` field. Readiness is computed server-side; **`checkTaskRequirements` is the canonical check**.

Observable signals in `getFreelancer` / `getUserProfile`:

- **Account status** (`status_id`-style numbers): `1 DISABLED`, `2 REGISTERED`, `4 ACTIVATED`, `5 BLOCKED`, `6 DELETED`.
- **Verification type** (`isVerified` numeric): `0 NOT_VERIFIED`, `1 VERIFIED_BY_ADMIN`, `4 VERIFIED_BY_KYC`.
- **Company membership** (`agree`): `0 INVITED`, `1 ACTIVE`, `2 EXCLUDED`. Excluded freelancers are not returned by `listFreelancers` — distinguish `ACTIVE` vs `INVITED` via `isRegistered` / `actualRegDate`.
- **Taxation status**: `1 NATURAL` (placeholder, blocks taxable countries), `3 SELF_EMPLOYED`, `4 SOLE_PROPRIETOR`.

`checkTaskRequirements` returns unmet items: `verification`, `agreementRequired`, `profileNotCompleted`, `taxInfoRequired`, `ageRestriction`, `withdrawFundsRequired`, `correctiveDocument`, `acceptanceFiles`.

### 6.2 Mutations

- **`inviteFreelancer`** — upsert-idempotent on `(company, email)`. Re-inviting an active membership → 422 "already in team". 423 → concurrent invite (retry briefly). Email is globally unique — same person can be in multiple companies under one user ID. Name/address/birthdate apply only at user creation; for existing freelancers only `note` and `specialization` are saved. `phone` silently ignored if company doesn't have phone-feature. `inEnglish: true` forces English profile + email (only EN/RU here).
- **`removeFreelancer`** — soft delete on per-company membership. Re-invite reactivates the same record (per-company `note` + `specialization` survive). **Backend blocks delete if any task is non-terminal** in this company → 422 "Worker have not finished tasks". DELETE is async (200 returns before status flip).
- **`editFreelancer`** — edits per-company alias only: `firstName`, `lastName`, `note`, `specialization`. **PUT semantics, not PATCH** — fields not passed are reset to empty string. Always pass all four (or read-then-write). The aliases are used in agreement / payslip templates, not the freelancer's KYC name.
- **`editFreelancerProfile`** — patches the **global** profile, **only before activation/KYC**. After activation/verification the entire profile is read-only — any field edit returns 409 (lock is bulk, not per-field). PATCH semantics — partial updates safe. `language` supports `EN | RU | ES | PT`.
- **`getFreelancerTaxInfo`** — returns 5 fields (`taxResidenceCountry`, `type`/taxDocumentType, `taxNumber`, `vatNumber`, `regNumber`). **404 = "no tax data filled in"**, not "freelancer doesn't exist". `taxationStatusId` is on `getFreelancer`, not here.

### 6.3 Lookup

- **`findFreelancerByEmail`** — case-sensitive (lowercase first). Emails with `+` aliasing in the path return 422; if that happens, skip and call `inviteFreelancer` directly — duplicates return 422 "already in team" (existence signal).
- **`findFreelancerByPhone`** — `phone` must be **digits-only** (no `+`, spaces, dashes — those return 404). Phone is globally unique at user level but visibility is per-company. Requires the company to have phone-search feature enabled — otherwise 403.

### 6.4 Out of MCP scope

KYC link, contact-change flow, taxation status change, taxpayer ID setup, offer agreement signing — handled through the freelancer's own UI.

---

## 7. Scout

### 7.1 Position states

`status` field values: `active`, `closed`. **No drafts.** `moderatedAt` is an orthogonal flag, not a state.

Transitions:
- `null → active` on `scout_createPosition` (no verified-account / email / trial gate).
- `active → closed` via `scout_closePosition`. Removes from matching. **Does not touch Applications** — their statuses and `invitedAt` stay as-is. New applies are blocked (4xx).
- `closed → active` via `scout_openPosition`.

Close/open are **not idempotent** — repeated calls re-emit side-effects. Track current status locally.

### 7.2 Application states

`status` field values: `new`, `in_review`, `short_list`, `rejected`. **No** `accepted`, `interviewed`, `withdrawn`.

- `new` — set by system on submission.
- `new → in_review` — implicit via `GET /applications/{id}?trackStatus=true`, or explicit via `scout_changeApplicationStatus`.
- `short_list`, `rejected` — hirer-driven via `scout_changeApplicationStatus`.

**No transition guards** at backend. `rejected → short_list → new` all pass. Backend also accepts changes after position is `closed`. Agent must enforce sensible transitions.

`scout_inviteApplicant` sends an email to the applicant. **Does not** change status, **does not** add to Pool. Sets `invitedAt`. Repeat call → 409, irreversible.

### 7.3 Permissive backend — client guards

The Scout backend has minimal validation. The agent must enforce:

- **`scout_changeApplicationStatus`** — reject illogical transitions client-side (rejected → short_list → new are technically accepted but rarely intended).
- **`scout_deletePoolFreelancersBatch`** — no backend size cap. A single call can empty the pool. Confirm with user for batches > 10.
- **`scout_sharePosition`** — backend accepts `closed` and un-moderated positions. Verify `status == 'active'` client-side first.

To finalize a Scout candidate contractually: take their email from the application, run CoR `inviteFreelancer` separately. There is no `accepted` status — the engagement happens through CoR.

---

## 8. Cross-cutting

### 8.1 Errors

- **HTTP 400** — domain rule violation ("wrong task state", "action not supported", "insufficient funds"). Most common. Read the body.
- **HTTP 403** — sometimes "wrong state" (e.g. `declineTask` from non-WAITING state), sometimes actual permission denial. Don't conflate — check tool descriptions for state-driven 403s.
- **HTTP 409** — uniqueness/conflict. `code` is the most stable thing to match on **when non-zero**. Some endpoints (like `publishDraftTask` insufficient-funds) return `code: 0` — branch on status alone.
- **HTTP 422** — field validation. Body is a `field → error` map. Render per-field as `"<field>: <error>"`.
- **HTTP 423** — short backend lock (e.g. concurrent invite). Retry briefly.
- **`message` is unstable** — translated by `Accept-Language`, changes between releases. Show to user as-is, never parse for logic.
- **Always log `X-Trace-Id`** from response headers when surfacing an error.
- Treat anything beyond `code` and `X-Trace-Id` as unstable.

### 8.2 Idempotency

- No `Idempotency-Key` header at the API level.
- `uuid` on `createTask` is **not** an idempotency key — duplicate uuid returns 400, not the existing task.
- For idempotent task creation: generate a stable `externalId` client-side, then `listTasks(filter[externalId]=...)` to detect prior success.

### 8.3 Pagination

- `size` cap is 500. Values above 500 **silently fall back to default 20**, not 400. Validate client-side.
- Default `size = 20`, default `sort = id desc` (unless overridden).

### 8.4 Read-your-writes

`listTasks` is search-index-backed. Eventual consistency within seconds — a just-created task may not appear immediately. **Don't use `listTasks` for read-your-writes**. Fetch by id/uuid via `getTask` instead.

`filter[externalId]` value is auto-prefixed with the current `companyId` internally — send the raw value.

### 8.5 Roles

Exactly two: `admin` and `member`. No intermediate roles. `admin` has full permissions; `member` is restricted. Treat any 403 as "this user cannot do this"; do not parse a required role from the response.

### 8.6 Webhooks

- Exactly **one webhook per company**. `createOrUpdateWebhook` replaces the existing one.
- HTTPS not enforced. No blocklist for `localhost` / RFC1918 / `*.mellow.io`. No preflight reachability check.
- Retry policy: up to **6 attempts within ~30 minutes** on 5xx / timeout. Then dropped (no documented DLQ).
- **Receivers must be idempotent** — the same event will be delivered more than once.
- Backend support is currently incomplete (some tools return 404). Surface gracefully if calls fail.

### 8.7 Money representation

`getCompanyBalance`, `listTransactions`, `getTask` use **major units** (USD as USD, not cents). Render amounts as returned, no scaling.

---

## 9. Decision trees — user intent → tools

### 9.1 Tasks

**"Create a task for freelancer X"**
```
→ (dialog) Confirm with the user: title, description, workerId, categoryId, price, deadline,
           and the 3 mandatory attributes for the chosen category. Never invent values.
→ (pre-check) getFreelancer(X) — confirm exists and grab user ID
→ (pre-check) getServices() — pick categoryId (a leaf service id, despite the name)
→ (pre-check) getTaskAttributes() — filter client-side by category, fill 3 mandatory pairs
→ (multi-currency) getAllowedCurrencies() — verify the chosen workerCurrency is allowed
→ createTask({title, description, workerId, categoryId, price, deadline, attributes,
              workerCurrency?, externalId?})
   - balance ≥ priceWithCommission → NEW (1)
   - balance insufficient → DRAFT (17) silently; top up then publishDraftTask
   - always getTask(uuid).state to confirm
→ (recommended, post-create) checkTaskRequirements(taskUuid, freelancerUuid) — surface unmet items
```

**"Pay task Y"** — two-step
```
→ getTask(Y) — read state
   - state = RESULT (3):
       1. acceptTask({uuid: Y}) → FOR_PAYMENT (4)
       2. getCompanyBalance() — verify available ≥ task cost
       3. payForTask({uuid: Y}) → PAYMENT_QUEUED (12); poll until FINISHED
   - state = FOR_PAYMENT (4): already accepted — just steps 2+3
   - state = WAITING_DECLINE_BY_WORKER (11): user likely means "confirm decline" → declineTask
   - state = PAYMENT_QUEUED (12): payment in flight; nothing to do
   - state = FINISHED (5): already paid; tell user
   - otherwise: not in a payable state
```

**"Return for rework"** — `getTask` → if state == RESULT (3): `resumeTask({taskId})` → IN_WORK; otherwise explain.

**"Cancel the task"**
```
→ getTask(Y) — read state
   - DRAFT (17): tell user — no cancel/delete API for drafts
   - WAITING_DECLINE_BY_WORKER (11): declineTask confirms freelancer's decline
   - NEW / IN_WORK: NO direct customer-side cancel.
       Options: ask freelancer to decline → then declineTask, or open dispute (out of MCP)
   - terminal (FINISHED / DECLINED_*): nothing to cancel
```

**"Extend the deadline"** — only legal in `WAITING_FOR_CUSTOMER_DEADLINE_DECISION (14)` with prev active state in `{NEW, IN_WORK}` and new deadline in future. Otherwise 400. Shortening / editing other params after publish is **not exposed**.

**"Attach a file"** — `addTaskFiles({uuid, file: <path>, type: 5})`. Blocked in `FINISHED (5)` and `PAYMENT_QUEUED (12)`.

**"Message the freelancer"** — `addTaskMessage({taskId, message})`. No state guard.

**"Show my tasks"** — `listTasks({...filters...})`. State filter is OR (`state: [1, 2, 3]`). Sort: `date_created` / `date_end` / `date_finished` / `price`. Eventual consistency: just-created tasks may take seconds to appear. `size` capped at 500.

**"Show task card"** — `getTask(Y)` for the base view. `getTaskMessages({taskId})` for chat. Files / changesets / timeline / acceptance files are **not exposed** via this MCP.

### 9.2 Freelancers

**"Invite a freelancer"** — `inviteFreelancer({email, firstName?, lastName?, phone?, specialization?, inEnglish?, sendEmail: true})`. Email globally unique; same person across companies reuses one user ID. Already-active in this company → 422.

**"Find a freelancer"** — by email: `findFreelancerByEmail` (lowercase, no `+` aliasing). By phone: `findFreelancerByPhone` (digits-only). By description: `listFreelancers({...filters...})`.

**"Remove from team"**
```
→ (recommended pre-check) listTasks({workerId: X, state: [1, 2, 3, 4, 11, 13, 14, 16]})
   - if open tasks: warn — backend returns 422 "Worker have not finished tasks"
   - if none: removeFreelancer({freelancerId: X})  // soft delete, async flip
   ⚠ Re-invite reactivates the same record.
```

**"What's blocking the freelancer from accepting?"** — `checkTaskRequirements({taskUuid, freelancerUuid})` returns unmet items. None of them is fixable via this MCP — point user at the freelancer's UI.

**"Change contacts / KYC / taxation"** — not supported by this MCP; freelancer's own UI.

### 9.3 Money & reports

**"Balance?"** → `getCompanyBalance()` → compute `available` client-side.
**"Transactions for period"** → `listTransactions({dateFrom, dateTo, page, size})` with `filter[type]` / `filter[currency]` as needed.
**"Documents for the quarter"** → `listDocuments({dateFrom, dateTo, type?})` → `downloadDocument({documentId})` (async ZIP delivery).

### 9.4 Company / profile

**"My companies"** → `listCompanies()`.
**"Switch company"** → prefer per-call `companyId` via `X-Company-Id`. `switchCompany({companyId})` only for single-company integrations (it sets a server-side default that races across parallel sessions).
**"Who am I"** → `getUserProfile()`.

### 9.5 Scout

**"Create a contractor request"** — single user-intent, two MCP calls:
```
→ scout_generatePosition({brief}) → poll scout_getGeneratePositionTask({taskId}) until ready
→ scout_createPosition({title, description, specialization, budget, ...})
```

**"Share the position"** — verify `scout_getPosition(positionId).status == 'active'` first (backend doesn't block sharing closed/un-moderated). Then `scout_sharePosition`. For social texts: `scout_createPromoPosts` (async) → poll `scout_getPromoPosts`.

**"Show applications"** — `scout_listPositionApplications({positionId})` or `scout_listApplications({filters})` → open one with `scout_getApplication`.

**"Shortlist / reject"** — `scout_changeApplicationStatus({applicationId, status: 'short_list' | 'rejected' | 'in_review'})`. **No** `accepted` status — to "finally accept" → CoR `inviteFreelancer`. Don't silently flip rejected → short_list → new (backend allows it but it's rarely intended).

**"Invite candidate to talk"** — `scout_inviteApplicant({applicationId})`. Email only. Doesn't change status, doesn't add to Pool. Second call → 409.

**"Move to CoR"** — grab email from `scout_getApplication`, run `inviteFreelancer` (CoR side), then "Create a task". Scout and CoR are separate databases; no auto-promotion.

**"Pool"** — `scout_createPoolFreelancer` / `scout_editPoolFreelancer` (PUT semantics — pass all fields) / `scout_deletePoolFreelancer` / `scout_deletePoolFreelancersBatch` (no size cap — confirm for > 10).

### 9.6 Cross-cutting

**"Set up a webhook"** — `getWebhook` to inspect, `createOrUpdateWebhook({url, events: [...]})` to set (replaces — only one per company). Receiver must be idempotent (up to 6 retries). Backend support partial; surface gracefully on 404.

**"I got an error — what now?"** — log `X-Trace-Id` from response headers. For 409, branch on `code` (when non-zero). For 422, render the field map. Never parse `message` for logic.
