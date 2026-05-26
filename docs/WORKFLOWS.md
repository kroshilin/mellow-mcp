# Mellow — End-to-End Workflows

> Real user-goal recipes built on top of the decision trees in `DOMAIN.md` §9. Each recipe assumes the agent has read the rest of `DOMAIN.md` and knows the state machines, preconditions, and error-handling rules.
>
> Format per recipe: **Goal** → **Preconditions** → **Steps** (concrete MCP tool calls with branches) → **Error handling** → **Done when**.
>
> All recipes use only public MCP tools and observable HTTP behavior — no backend internals.

---

## Recipe 1 — First task with a brand-new freelancer

**User goal:** "I want to start working with a new contractor. Onboard them and assign their first task."

**Preconditions:**

- Customer is logged in to MCP.
- Customer knows the freelancer's email at minimum (other personal fields are nice-to-have).
- Customer has clarified what the task is — title, description, price, deadline, category.

**Steps:**

1. **Skip if already known.** `findFreelancerByEmail(email)` — if returns 200, jump to step 3.
2. **Invite.** `inviteFreelancer({email, firstName?, lastName?, phone?, specialization?, sendEmail: true})`.
   - Response carries the new `freelancerId`.
   - Tell the user: "Invitation email sent." (No need to wait for KYC before assigning — the task can be created and published right away. KYC and other freelancer-side requirements only block the freelancer from accepting the task on their side, not the customer from creating it.)
3. **Confirm task fields with the user** (recommendation mode — don't invent values):
   - title, description, price, deadline (ISO-8601 with timezone)
   - `categoryId` from `getServices()` — pick one with the user. **Note:** despite the name, this expects a **service ID**, not a parent category ID. `getServices()` returns the right kind of IDs.
   - `getTaskAttributes()` — fetch the catalog and filter client-side by category to find the 3 mandatory attributes.
   - currency: if non-default, `getAllowedCurrencies()` to verify it's permitted.
   - **Title character whitelist:** only `- , . : ; ( ) _ " № % # @ ^ « »` are allowed as special characters. Em-dash (`—`), en-dash (`–`), and other Unicode punctuation are rejected with HTTP 422. Replace with a hyphen-minus before sending.
4. **Create the task.** `createTask({title, description, workerId, categoryId, price, deadline, attributes, workerCurrency?, externalId?, createAsDraft?})` returns `{uuid}` only.
   - **Default (no `createAsDraft`)** — balance gate: `NEW (1)` if `available ≥ priceWithCommission`, otherwise **silently** downgraded to `DRAFT (17)` (no warning).
   - **`createAsDraft: true`** — explicit DRAFT regardless of balance; balance is NOT checked. Use this when the user asked to review before publishing on a funded company.
   - **Always** call `getTask(uuid)` next to read the actual `state` and tell the user honestly which scenario landed (especially important without `createAsDraft` — the silent downgrade is the canonical source of "why didn't the freelancer see it" confusion).
5. **Pre-check requirements** (now possible because the task exists):
   `checkTaskRequirements({taskUuid, freelancerUuid})`.
   - Empty list → freelancer can accept right away.
   - Non-empty list → surface to the user; see Recipe 10 for `name → data` shapes. The task can still be published — the freelancer just won't be able to accept it until they fix their side (KYC, agreement, profile, etc.).
6. **Pre-check the company balance before publishing.** `publishDraftTask` requires `balanceAmount ≥ task.priceWithCommission` even though no debit happens at publish — confirmed backend behavior. Call `getCompanyBalance()`. If the available balance is below the task cost, tell the user "top up first" and stop. Do not call `publishDraftTask`.
7. On user confirmation: `publishDraftTask({uuid})` (`companyId` optional — defaults to active company).
   - 409 "Top-up your balance" if step 6 was skipped or the balance dropped between checks.
   - On success the task moves `DRAFT (17) → NEW (1)` and the freelancer is notified.
8. The freelancer now sees the task in their UI. Periodically `getTask(uuid)` to read `state`:
   - `NEW (1)` → not yet accepted (waiting for freelancer)
   - `IN_WORK (2)` → accepted, working
   - `RESULT (3)` → submitted, ready for customer review
9. **Review the result.** Show the user the deliverables (chat via `getTaskMessages`; files/timeline are not exposed via this MCP yet).
10. **Accept and pay** — see Recipe 3.

**Error handling:**

- `inviteFreelancer` returns HTTP 422 "already in team" — they're already active in this company. Skip to step 3.
- `inviteFreelancer` returns HTTP 423 — concurrent invite on the same email (short backend lock). Retry after a short pause.
- `findFreelancerByEmail` may return HTTP 422 for emails containing `+` aliasing. Workaround: skip the existence check and call `inviteFreelancer` directly — it will return HTTP 422 "already in team" if duplicate.
- `createTask` returns 422 with violations — check `categoryId` (must be a service ID, not a category ID), `workerCurrency` (must be in `getAllowedCurrencies`), `title` (special-char whitelist), required attributes. Re-ask the user, retry.
- Step 8 stalls indefinitely (state stuck at `NEW`) — re-run `checkTaskRequirements`. If non-empty, the freelancer is blocked on KYC / agreement / profile.

**Done when:** task is `FINISHED (5)` (after Recipe 3 completes).

---

## Recipe 2 — Hire through Scout, then engage in CoR

**User goal:** "I need a designer for a project. Help me find one and start working with them."

**Preconditions:**

- Customer is logged in.
- Customer has a brief — what they need, ideal candidate profile, budget.

**Steps:**

1. **Create the contractor request.** From the user's perspective this is one action; the agent chains:
   - `scout_generatePosition({request: brief})` → returns `{taskId}` for AI generation. (The MCP parameter name is `request`, not `brief`.)
   - poll `scout_getGeneratePositionTask({taskId})` until ready → returns AI-drafted fields the agent can pre-fill.
   - Show to user, refine if needed.
   - `scout_createPosition({...})` requires a fairly large body — the agent must collect or derive each field:
     - `title`, `description`, `company: {name, website, id?}` (company info; `id` if there's an existing Scout company entry)
     - `workModel: 'remote' | 'onsite'` (`location` becomes required if `onsite`)
     - `projectType: 'ongoing' | 'one-time'`
     - `workload`: must match `projectType` — for `ongoing`: one of `under_20_hrs_per_week / between_20_30_hrs_per_week / over_30_hrs_per_week`; for `one-time`: one of `few_days / one_two_weeks / more_two_weeks`
     - `experienceLevel: 1..4` (1 junior → 4 top-tier)
     - `skills: string[]` (1–20 unique tags) — this replaces the older "specialization" notion
     - `isBudgetNegotiable: boolean`. If `false`, also pass `paymentType ('hourly'|'monthly'|'fixed')`, `currency ('eur'|'usd')`, and one of: `budget`, or `budgetFrom`+`budgetTo`.
     - Optional: `summary`, `languages`, `timezone`, `aiTaskId` (link back to the AI generation task).
   - Returns `{positionId}` on success.
2. **(Optional) Share the position externally.** If the user wants more reach beyond Mellow's pool:
   - `scout_createPromoPosts({positionId})` → kicks off async social-text generation
   - poll `scout_getPromoPosts({positionId})` until texts appear
   - `scout_sharePosition({positionId, shareTarget: 'linkedin' | 'twitter' | 'facebook' | ...})` — `shareTarget` is required (the social network identifier).
   - **Pre-check on the agent side:** `scout_getPosition({positionId})` → status must be `active`. Backend won't block sharing of `closed` or un-moderated positions, but it's rarely what the user wants.
3. **Wait for applications** (typically ~48 hours). Periodically `scout_listPositionApplications({positionId})`. Show new entries to the user.
4. **Triage.** For each application:
   - `scout_getApplication({applicationId})` for full details (CV, etc.)
   - `scout_changeApplicationStatus({applicationId, status: 'short_list' | 'rejected' | 'in_review'})` based on user's call.
   - **Agent-side guard:** don't silently flip `rejected → short_list → new`. Backend allows it, but the user rarely means it — confirm.
5. **Reach out to a candidate.** For shortlisted ones the user wants to talk to:
   `scout_inviteApplicant({applicationId})` — sends an email with the hirer's contact info.
   - **Important:** this does NOT change the application status or move them anywhere. It's just a "let's talk" email.
   - Second call → HTTP 409, irreversible. Don't retry.
6. **Convert chosen candidate into a CoR freelancer.** Scout and CoR are separate databases — no automatic promotion. Take the candidate's email from the Scout application and run **Recipe 1** from step 2 (`inviteFreelancer`) onwards.
7. **Optional: save other strong applicants to the company's pool** for future projects:
   - `scout_getPool()` first → grab the company's `poolId` (UUID).
   - For each candidate: `scout_createPoolFreelancer({poolId, firstName, lastName, email, expertiseArea, experienceYears?, notes?, portfolioLinks?, residenceCountry?, cvFileId?})`.
8. **(Optional) Close the position** when filled:
   `scout_closePosition({positionId})`.
   - This **does not** auto-reject the remaining applications — they stay as-is. Agent should iterate and `scout_changeApplicationStatus(rejected)` for any still in `new` / `in_review` if the user wants a clean slate.

**Error handling:**

- AI generation polling never returns ready → fall back to `scout_createPosition` with user-provided text.
- `scout_inviteApplicant` returns 409 → already invited, no-op for the user.
- Step 6 fails because the candidate's email is already an active customer in another company → tell the user, this is an edge case requiring support.

**Done when:** the converted freelancer has a finished task in CoR.

---

## Recipe 3 — Accept and pay (the two-step flow)

**User goal:** "The freelancer submitted the work. Accept and pay them."

**Preconditions:**

- Task exists, was assigned to a known freelancer.
- Task is in state `3 RESULT` (or one of the special states `11 WAITING_DECLINE_BY_WORKER`, `14 WAITING_FOR_CUSTOMER_DEADLINE_DECISION` that `acceptTask` also handles).

**Steps:**

1. **Read state.** `getTask(uuid)` → confirm `state == 3 RESULT`.
   - If `4 FOR_PAYMENT`: skip to step 4 (already accepted, just need to pay).
   - If `12 PAYMENT_QUEUED`: payment already in progress; tell the user, nothing to do.
   - If `5 FINISHED`: already paid; tell the user.
   - If anything else: the task isn't ready for accept — tell the user.
2. **Show deliverables** to the user. Use `getTaskMessages(taskId)` for the chat history.
3. **Accept.** On user's confirmation:
   `acceptTask({uuid})` → state moves to `4 FOR_PAYMENT`.
   - Under the company's "hold on accept" policy, this may also reserve the funds. Returns 400 if the balance is insufficient — see Error handling below.
4. **Pre-check balance.** `getCompanyBalance()`. Compute `available = balanceAmount − holdAmount − toPayAmount`. Compare to the task's `priceInCustomerCurrency` (visible in `getTask`).
   - If available ≥ task cost → step 5.
   - If not → tell the user "balance is insufficient, top up first" and stop. The task remains in `4 FOR_PAYMENT`.
5. **Trigger payout.** `payForTask({uuid})` → state moves to `12 PAYMENT_QUEUED`.
6. The system finishes the task asynchronously. Poll `getTask(uuid)` until `state == 5 FINISHED` (or back to `4 FOR_PAYMENT` on error). Typically seconds to minutes.

**Error handling:**

- `acceptTask` 400 with insufficient-funds reason — task stays in `RESULT`. Pre-check balance, top up, retry. Or use a different hold policy company-wide (out of MCP).
- `acceptTask` 400 with "open changeset / dispute / unsigned agreement" — surface to the user; resolution is out of MCP scope.
- `payForTask` 400 with insufficient-funds — same as above.
- Task lingers in `12 PAYMENT_QUEUED` for >1 hour — log `X-Trace-Id` from any prior responses, escalate to support.

**Done when:** `state == 5 FINISHED`.

---

## Recipe 4 — Return for rework, then accept

**User goal:** "The submission isn't quite right. Send it back for changes."

**Preconditions:**

- Task in state `3 RESULT`.

**Steps:**

1. `getTask(uuid)` → confirm state.
2. (Optional) Tell the freelancer what to change via `addTaskMessage({taskId, message})`.
3. **Return.** `resumeTask({taskId})` → state moves back to `2 IN_WORK`.
   - Note: the deadline is **not** auto-extended. If the original deadline already passed, the task may bounce into `14 WAITING_FOR_CUSTOMER_DEADLINE_DECISION` later.
4. Wait for the freelancer to resubmit (state `3 RESULT` again).
5. Run **Recipe 3** to accept and pay.

**Error handling:**

- `resumeTask` 400 — task isn't in `RESULT`. Re-read the state and explain to the user.
- The task hits the soft deadline before the freelancer resubmits → see Recipe 6.

**Done when:** task is `5 FINISHED` after the resubmission cycle.

---

## Recipe 5 — Freelancer wants out (mutual cancellation)

**User goal:** "The freelancer can't do this task. Confirm their decline so we both walk away cleanly."

**Preconditions:**

- The freelancer has already requested to decline on their side. The task is in state `11 WAITING_DECLINE_BY_WORKER`.

**Steps:**

1. `getTask(uuid)` → confirm state is `11`.
2. Show the user the freelancer's reason if available (likely in chat — `getTaskMessages`).
3. **Confirm the decline.** On user's confirmation:
   `declineTask({taskId})` (or equivalently `changeTaskStatus({taskId, state: 8})`) → state moves to `8 DECLINED_BY_CUSTOMER`. Any held funds are released automatically.

**Error handling:**

- If the task is in `1 NEW` or `17 DRAFT`, this recipe doesn't apply — use Recipe 17 (direct soft cancel) instead. `declineTask` works from those states without freelancer involvement.
- If the task is in `2 IN_WORK` / `3 RESULT` / `4 FOR_PAYMENT`: the customer cannot decline directly; backend returns 403 "wrong state". The freelancer must start the decline first (their side moves it to `11`) — then this recipe applies. Or open a dispute (out of MCP).

**Done when:** task is `8 DECLINED_BY_CUSTOMER`.

---

## Recipe 6 — Soft deadline hit, decide what to do

**User goal:** "The task ran past its deadline. The system is asking me to decide."

**Preconditions:**

- Task is in state `14 WAITING_FOR_CUSTOMER_DEADLINE_DECISION`.
- The previous active state (before the deadline trigger) was `1 NEW` or `2 IN_WORK`.

**Steps:**

1. `getTask(uuid)` → confirm state is `14`.
2. Surface the situation to the user with two options:
   - **Extend the deadline** (continue the task).
   - **Let it close** (system will move it to `15 DECLINED_BY_DEADLINE` after a timeout).
3. If the user picks extend:
   - Get a new deadline from them, ISO-8601 with TZ, must be in the future.
   - `changeDeadline({uuid, deadline})` → state returns to whatever it was before (`NEW` or `IN_WORK`).
4. If the user picks let it close: do nothing. The system will close the task automatically when its timer expires.

**Error handling:**

- `changeDeadline` 400 — reasons include the new deadline being in the past, or the previous active state not being `NEW`/`IN_WORK`. Re-ask the user for a future deadline.

**Done when:** task is back in an active state (`1`/`2`) or has been auto-closed to `15 DECLINED_BY_DEADLINE`.

---

## Recipe 7 — Multi-currency task

**User goal:** "I have a USD balance but want to pay this task in EUR."

**Preconditions:**

- Customer is logged in.
- Company balance currency is known (one per company; from `getCompanyBalance`).
- Worker / category are decided.

**Steps:**

1. `getCompanyBalance()` → note `currency` (the company's balance currency).
2. `getAllowedCurrencies()` → confirm the desired worker currency (e.g., EUR) is in the list.
   - If not: tell the user. Multi-currency availability depends on per-company settings; resolution is out of MCP.
3. (Optional) `getExchangeRate()` to show the current rate to the user.
4. Run **Recipe 1 step 4 onwards** to confirm fields, but pass `workerCurrency: 'EUR'` (ISO string).
5. **Important:** the FX rate at task creation is locked into the task — that's the rate that will be used at payout. Subsequent rate changes don't move the locked amount.
6. **VAT.** Task pricing carries VAT separately (e.g. 19% in EU). VAT is computed on top of `priceWithCommission` and **is included in the total** debited from the company balance. The freelancer receives `amountForWorker` in the worker currency; the company is debited `total` in the company currency.
7. Continue: draft → publish → freelancer accepts → submits → **Recipe 3** for accept + pay.

**Error handling:**

- `createTask` 400 with currency violation — the chosen `workerCurrency` isn't in the company's allowed list. Re-check with `getAllowedCurrencies`.
- At `payForTask` time: hold/debit happens in the **company's balance currency** (USD), converted from the task currency (EUR) at the locked rate. If `available` (in USD) is below the converted amount, payment fails. Top up.

**Done when:** task is `5 FINISHED`. The freelancer was paid in EUR; the company was debited in USD.

---

## Recipe 8 — Quarterly closing documents

> Note: `REPORT (type 7)` documents only appear after a closing period with completed tasks. A fresh account with only top-ups will see only `INVOICE (type 6)` entries. If `downloadDocument` returns 404, surface the `fileId` from `listDocuments` and tell the user to download via the web UI.

**User goal:** "Give me my invoices and acts for Q1."

**Preconditions:**

- Customer is logged in.
- Period is defined (start, end).

**Steps:**

1. `listDocuments({dateFrom: '2026-01-01', dateTo: '2026-03-31'})`.
   - Returns two types: `6 INVOICE` (top-up invoices) and `7 REPORT` (period closing reports). Both are bundled with attached file references.
2. Optionally narrow to a single type: `listDocuments({dateFrom, dateTo, type: 6})` for invoices only, or `type: 7` for reports only.
3. For each document the user wants, `downloadDocument({documentId})`.
   - This kicks off **asynchronous** ZIP packaging. The file isn't returned synchronously; it arrives later via notifications or a separate file-fetch path.
   - Tell the user: "Preparing the archive — you'll receive it shortly."

**Error handling:**

- Empty list → tell the user no documents in that period; check the date range.
- 403 → user's role can't list documents. Surface as-is; do not parse `required_role` from the response.

**Done when:** the user has the documents they asked for (delivery is async; agent confirms only that the request was queued).

---

## Recipe 9 — Multi-company report sweep

**User goal:** "Show me a single dashboard of tasks/balance across all my companies."

**Preconditions:**

- Customer's account has more than one company.

**Steps:**

1. `listCompanies()` → list of `{companyId, name, ...}`.
2. For each `companyId`, `switchCompany({companyId})` first, then run the per-company calls. (Or rely on per-request `X-Company-Id` if the session was opened with `Props.activeCompanyId` set.)
3. Per company:
   - `getCompanyBalance()` → balance snapshot
   - `listTasks({state: [1,2,3,4]})` → active tasks count
   - `listTransactions({dateFrom, dateTo})` → period activity
4. Aggregate client-side, present to the user.

**Error handling:**

- 403 on a specific company — user lost access to that company. Skip and tell the user.
- A parallel agent session causes the active company to drift mid-loop (race) — the data may be wrong. Fix is to send `X-Company-Id` per request once that's wired up.

**Done when:** aggregate report shown to the user.

---

## Recipe 10 — Worker can't accept (requirements gap)

**User goal:** "I tried to assign a task and the freelancer says they can't accept it. Why?"

**Preconditions:**

- Task is `1 NEW` (assigned but not accepted).
- The freelancer told the user something is blocking them.

**Steps:**

1. `checkTaskRequirements({taskUuid, freelancerUuid})` → list of unmet requirement names.
2. Translate each name for the user:
   - `verification` — they need to complete KYC. Done in their UI.
   - `agreementRequired` — they need to sign the offer agreement. Done in their UI.
   - `profileNotCompleted` — they need to fill missing profile fields (phone, address, etc.). Done in their UI.
   - `taxInfoRequired` — they need to set their taxation status. Done in their UI.
   - `ageRestriction` — age policy issue. Resolution is support-only.
   - `withdrawFundsRequired` — they need a payout method. Done in their UI.
   - `correctiveDocument` — a corrective document is required. Resolution is support-only.
   - `acceptanceFiles` — they need to confirm the company's NDA/onboarding documents. Done in their UI.

   **Data payload shapes** (each requirement carries different `data`):

   | name                                                                                                   | `data` shape                                                                                            |
   | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
   | `agreementRequired`                                                                                    | `{url, templateUuid, seller, code, reason}` (HTML in `reason` — use `url` to surface to the freelancer) |
   | `profileNotCompleted`                                                                                  | `string[]` — list of missing field names (e.g. `["country","phone","city"]`)                            |
   | `taxInfoRequired`                                                                                      | `string[]` — often empty                                                                                |
   | `verification` / `ageRestriction` / `withdrawFundsRequired` / `correctiveDocument` / `acceptanceFiles` | shape not yet observed in test data — handle defensively                                                |

3. Tell the user **which side fixes what** — none of these are fixable from this MCP. The freelancer fixes the freelancer items; support fixes the support items.
4. Periodically re-run `checkTaskRequirements` until the list is empty.

**Error handling:**

- The list is empty but the freelancer still can't accept — there's a state-machine reason instead. `getTask(uuid)` and check `state`. If it's already terminal (`5 FINISHED`, `6/8/15 DECLINED_*`), tell the user.
- The list never empties — escalate to support, share the freelancer ID and `X-Trace-Id`.

**Done when:** the list is empty AND the freelancer accepts (state moves to `2 IN_WORK`).

---

## Recipe 11 — Bulk invite freelancers from a file

**User goal:** "Here's a list of contractors — invite them all at once."

**Preconditions:**

- Customer is logged in.
- User provides a file with the freelancer list. The agent must accept multiple formats: **CSV, TSV, XLSX, JSON** (and gracefully ask to convert if it's something else like PDF or a screenshot).
- File contains at minimum an `email` column. Optional columns: `firstName`, `lastName`, `phone`, `specialization`, `inEnglish`, `note`.

**Steps:**

1. **Parse the file** (agent-side, on the client). Normalize column names (trim, lowercase, strip diacritics). Output a list of records:

   ```
   [{rowNumber, email, firstName?, lastName?, phone?, specialization?, inEnglish?, note?}, ...]
   ```

   - If the file format is unsupported or parsing fails, tell the user the supported formats and ask for a re-export.

2. **Validate each row** locally:
   - `email` is present and looks like an email.
   - `phone` (if present) looks like a phone number.
   - `specialization` (if present) — soft-check against `getSpecializations()` later.
   - Mark each row as `valid` or `invalid` with a reason.

3. **Show a summary to the user** before any API calls:
   - Total rows, valid rows, invalid rows (with the per-row reasons).
   - List of unique emails, count of duplicates within the file (collapse).
   - **Ask for confirmation** before proceeding.

4. **Resolve duplicates already in this company.** For each unique valid email, `findFreelancerByEmail(email)`. Keep one of three buckets:
   - `existing_active` — already in this company. Skip on invite.
   - `existing_in_other_company` — same email belongs to a freelancer user in another company. Invite still works (creates new membership in this company; reuses the same user ID).
   - `new` — not seen anywhere yet. Standard invite.

5. **Process invites row by row.** For each entry in `existing_in_other_company` and `new`:

   ```
   inviteFreelancer({email, firstName?, lastName?, phone?, specialization?: number, inEnglish?, sendEmail: true})
   ```

   Note: `specialization` is a numeric ID, not a string. If the user's file has free-form text, resolve it via `getSpecializations()` before invite (mark unresolved as `needs_specialization_match` and ask the user, or omit the field).
   - On success: record `{rowNumber, email, freelancerId, status: 'invited'}`.
   - On 400 "already in team": record `{... status: 'skipped_already_active'}`.
   - On 400 with field violations: record `{... status: 'failed', reason: <field violations>}`.
   - On 5xx: retry once with backoff; if still fails, record as `failed`.
   - Pace requests modestly (e.g., one per 200–500ms) — rate limits are token-shared.

6. **Aggregate report** at the end:
   - `invited: N`, `skipped (already active): M`, `failed: K` (with per-row reasons).
   - Show as a table to the user. Offer to export the report as a follow-up file.
   - Provide the list of new `freelancerId`s if the user wants to chain into Recipe 12 (bulk task creation).

**Error handling:**

- **Partial-failure semantics.** This recipe is NOT atomic — earlier successful invites stay even if later rows fail. Retry only the `failed` rows.
- **File too large.** If > 500 rows, warn the user about runtime and pacing. Consider chunking with explicit user confirmation between chunks.
- **`getSpecializations()` mismatch.** If a row's `specialization` doesn't match the catalog, either pass the closest match or omit the field. Don't silently invent.

**Done when:** the user has the report. Each row landed in one of three terminal buckets (invited / skipped / failed).

---

## Recipe 12 — Bulk task creation via file import

**User goal:** "Here's a spreadsheet of tasks I want to assign — create them all."

**Preconditions:**

- Customer is logged in.
- Companies and freelancers already exist (or are about to be created via Recipe 11 — chain if needed).
- User provides a file with the task list in CSV / TSV / XLSX / JSON.

**Expected columns** (case-insensitive, agent normalizes):

| Column                                                                    | Required                        | Notes                                                                                                                                                                                      |
| ------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `title`                                                                   | yes                             | Task title                                                                                                                                                                                 |
| `description`                                                             | yes                             | Plain text                                                                                                                                                                                 |
| `workerEmail` or `workerId`                                               | yes                             | Email is more user-friendly; agent resolves to `workerId`                                                                                                                                  |
| `categoryId` or `categoryName`                                            | yes                             | If `categoryName`, agent resolves via `getServices()`                                                                                                                                      |
| `price`                                                                   | yes                             | Number; minor units NOT used here (pass major units as the user wrote them)                                                                                                                |
| `deadline`                                                                | yes                             | ISO-8601 with timezone preferred; agent reformats if needed                                                                                                                                |
| `workerCurrency`                                                          | optional                        | ISO string (USD/EUR/...). Defaults to company currency if absent.                                                                                                                          |
| `attribute1Id`, `attribute1Value`, ..., `attributeNId`, `attributeNValue` | yes (3+ rows of these per task) | Agent stitches them into `[{id, value}]`. Mandatory count depends on the category. Use `getTaskAttributes()` once and filter by `categoryId` client-side.                                  |
| `externalId`                                                              | optional but recommended        | Stable client-side ID for idempotency                                                                                                                                                      |
| `taskGroupId`                                                             | optional                        | If grouping into a project. Pass to `createTask` as `editGroup: [taskGroupId]` (legacy plural; single-element array). Resolve task group IDs via `listTaskGroups`/`createTaskGroup` first. |
| `copyright`, `needReport`                                                 | optional booleans               | Defaults: false                                                                                                                                                                            |
| `shareCommission`                                                         | optional                        | Default: false                                                                                                                                                                             |

**Steps:**

1. **Parse and normalize the file** (agent-side). Output a list of task records.
   - If parse fails, ask for re-export in a supported format.

2. **First-pass validation per row** (local, no API):
   - All required columns present and non-empty.
   - `price` numeric and > 0.
   - `deadline` parseable as a future date.
   - `workerEmail` looks like an email OR `workerId` is numeric.
   - Attribute pairs are well-formed.
   - Mark each row valid/invalid with reasons.

3. **Resolve references** (one round of API calls, deduplicated):
   - For each unique `workerEmail` → `findFreelancerByEmail(email)` → store `{email, workerId}` map. If not found: mark all rows with that email as `unresolved_worker` with hint "missing from this company; use Recipe 11 first or invite manually".
   - For each unique `categoryName` → look up in cached `getServices()` result → store `{categoryName, categoryId}`. If not found: mark rows with that name as `unresolved_category` with the closest matches as hints.
   - For each unique `categoryId` → `getTaskAttributes(categoryId)` → check that the row's attribute IDs are valid for that category and that **3 mandatory attributes are filled**. Mark `missing_attributes` if not.
   - If multi-currency rows present: `getAllowedCurrencies()` once → check each row's `workerCurrency` belongs.

4. **Show a comprehensive pre-flight summary** to the user. Group rows by status:
   - **Ready** — N rows, will be created.
   - **Issues** — M rows, with per-row reasons (`unresolved_worker`, `unresolved_category`, `missing_attributes`, `invalid_currency`, `invalid_deadline`, etc.).
   - For "Issues" rows, ask the user:
     - Fix in the file and re-submit, OR
     - Skip these rows and proceed with the "Ready" subset, OR
     - Bulk-edit interactively (agent walks the user through the missing fields row by row).

5. **Optional pre-publish guard.** For each "Ready" row, `checkTaskRequirements(rowGeneratedTaskUuid, freelancerUuid)`. The list is recommended-not-required (the task can still be created; the freelancer just won't be able to accept it until they fix their side). Bucket rows as `freelancer_not_ready` for visibility.

6. **Generate stable `externalId` per row** if not provided. Format suggestion: `bulk-{batchId}-row{rowNumber}`. This makes retry safe.

7. **Create tasks row by row** (no bulk API in MCP — agent loops):

   ```
   for each ready row:
     uuid = client-generated UUID v4
     createTask({
       uuid,
       title, description,
       workerId,           // from resolved map
       categoryId,         // from resolved map
       price,
       deadline,
       attributes: [{id, value}, ...],
       workerCurrency?,
       externalId,
       copyright?, needReport?, shareCommission?, editGroup: [taskGroupId]?
     })
     // Rows land in NEW (1) if balance ≥ priceWithCommission, else DRAFT (17) silently.
     // For "review before publish" bulk imports: leave company balance below the
     // batch total so all rows land in DRAFT, then publishDraftTask per row after review.
   ```

   - Pace at 1 request per 200–500ms (token-shared rate limits).
   - On 400 with field violations: record `{rowNumber, status: 'failed', reason: <violations>}` and continue.
   - On 5xx: retry once. Permanent fail → record.
   - On success: record `{rowNumber, taskUuid, taskId, status: 'created_draft'}`.

8. **Per-batch report**: ready / created / skipped / failed counts, with per-row error reasons. Show as a table.

9. **Review and publish.** Show the user the created drafts. On confirmation:
   - **Pre-check the company balance.** `publishDraftTask` requires `balanceAmount ≥ Σ priceWithCommission` of all tasks to be published — same backend behavior as Recipe 1. Call `getCompanyBalance()` once before the publish loop. If the available balance is below the cumulative cost of the planned batch, tell the user "top up first" and stop the publish loop.
   - Loop `publishDraftTask({uuid: taskUuid})` for each created draft (same pacing). `companyId` is optional — defaults to the active company.
   - On HTTP 409 "Top-up your balance" mid-loop: stop, surface what published vs what didn't, ask the user to top up and resume the loop on the remaining drafts.
   - The user may reject some drafts before publishing (skip from the publish loop). To discard a draft, use `declineTask({uuid})` — moves it to `DECLINED_BY_CUSTOMER (8)` (Recipe 17). Hard delete is not exposed.

10. **Final confirmation.** Tell the user:
    - N tasks published (now visible to freelancers in `NEW` state).
    - M drafts kept (can publish later via `publishDraftTask`, or cancel via `declineTask` — Recipe 17).
    - K rows failed (with reasons).

**Error handling:**

- **Partial-failure semantics.** Bulk import is NOT atomic. Earlier successes are real. Use the per-row report to retry only failed rows (idempotent thanks to `externalId` — re-running for the same `externalId` will be detected by `listTasks(filter[externalId]=...)` and skipped if already created).
- **OpenSearch lag.** Right after a bulk create, `listTasks` may not show all tasks immediately. For verification, fetch each by `getTask(uuid)`.
- **Discarding drafts.** Use `declineTask({uuid})` to soft-cancel a draft (moves it to `DECLINED_BY_CUSTOMER (8)`; record persists in listings). Hard delete is not exposed by the API.
- **Mixed-currency batches.** Different `workerCurrency` per row is fine; the locked-rate semantics (Recipe 7) apply per task.
- **There are no bulk-import endpoints on the backend.** Confirmed by the API team. Row-by-row is the canonical path — agents should not try to find a `POST .../import` endpoint.

**Done when:** the user has the per-row report and either all "Ready" rows have moved to `NEW` (or to `DRAFT` deliberately).

---

## Recipe 13 — Hire via AI matching (Scout)

**Goal:** the user creates a position, lets Mellow surface candidates, picks one and sends an invite.

**Preconditions:** Scout enabled for the company; a position already exists (this recipe starts at the matches step).

**Sequence:**

1. `scout_listMatchedFreelancers({positionId})` → check `status`.
2. If `status === "in_progress"` → wait 3-5 s, retry from step 1. Cap at 5 min.
3. If `status === "failed"` → tell the user matching errored; offer to retry via `scout_requestMatching`.
4. If `status === "completed"` and `matches.length > 0` → render the top 5-10 by score (already sorted DESC). For each: name, expertise, country, experience, score, explanation.
5. User opens a card → call `scout_markMatchedFreelancerViewed({positionId, matchId})` (idempotent; safe to spam).
6. User confirms invite → call `scout_inviteMatchedFreelancer({positionId, matchId})`. If 409 `alreadyInvited` → tell the user this candidate was already invited; suggest another.
7. If the user wants a re-run later → `scout_requestMatching({positionId})`. Handle 409 (in progress) and 429 (rate limit). After the re-run is accepted → back to step 1.

**Done when:** the user either invites a candidate (success), exhausts matches (offer to widen the position), or matching failed (retry available).

---

## Recipe 14 — F2B: add an external client and issue the first invoice (freelancer mode)

**User goal:** "I just finished a job for an external company. Let me bill them through Mellow."

**Preconditions:**

- Session is in freelancer mode (`f2b_*` tools registered; `tasks`/`scout_*` not).
- Freelancer has completed their own Mellow onboarding (agreement signed).
- Freelancer knows the client's company email at minimum (other fields nice-to-have).

**Sequence:**

1. **Skip if already known.** `f2b_listClients({})` → if the company is already in the list, jump to step 4 with that `clientId`.
2. **Confirm fields with the user** (recommendation mode — don't invent):
   - `email` (where the payment link goes), `country` (ISO-3166 alpha-2), `currency` (`EUR` or `USD`).
   - Optional: `companyName`, `regNumber`, `vat`, `tin`, address fields.
3. **`f2b_createClient({email, country, currency, companyName?, ...})`**. Returns the new client object. Record `clientId`. State starts `not_verified` — that does **not** block invoicing.
4. **Collect invoice inputs from the user:**
   - `serviceId` (from Mellow's service taxonomy — pass the leaf service id).
   - `serviceName` (short, no HTML), `serviceStartDate` + `serviceEndDate` (ISO).
   - `invoiceDate` (must be ≤ today).
   - `lineItems[]` (1-10 items, each `{name, quantity, measure, price}`; total ≤ 10 000 in client currency).
   - `commissionPayer` (`freelancer` deducts from payable; `customer` adds to total).
5. **`f2b_createInvoiceDraft({clientId, ...})`** — draft only, NO email sent. Response includes `breakdown: {subtotal, commissionPercent, commissionAmount, total, payable}`. Record `invoiceId`.
6. **Show the breakdown to the user.** Restate: who, how much subtotal, commission %, who pays it, total, payable. Get an explicit "yes".
7. On confirmation: **`f2b_sendInvoiceDraft({invoiceId})`** — backend emails the client + exposes the public `paymentUrl`. Status moves `new → sent`.

**Error handling:** see DOMAIN §8.1 for generic error semantics and ANTI_PATTERNS §M for F2B-specific traps. 422 bodies carry a field→error map — render as-is. On a network blip between create-draft and send, never re-create the draft as a retry (would duplicate) — call `f2b_getInvoice({invoiceId})` to confirm the existing draft's status first.

**Done when:** `f2b_getInvoice({invoiceId})` reports `status: sent` with a populated `paymentUrl`. Tell the user the email is in their client's inbox.

---

## Recipe 15 — F2B: track payment status

**User goal:** "Did my client pay invoice #N yet?"

**Preconditions:** invoice exists in `sent` / `payment_queued` / `paid`.

**Sequence:**

1. `f2b_getInvoice({invoiceId})` — read `status`:
   - `sent` — email delivered; client has not initiated payment yet (or is still in 10-15 min verification on first payment).
   - `payment_queued` — client kicked off the payment; settlement in flight.
   - `paid` — funds on the freelancer's Mellow balance.
2. If user wants to see all open invoices for the client: `f2b_listInvoices({status: ['sent', 'payment_queued']})` and MCP-side filter by `clientId` (backend doesn't support a `clientId` filter).

**"How do I withdraw?"** — out of scope. Direct user to https://my.mellow.io/ → Finances → Withdraw.

**Done when:** the user knows the current status.

---

## Recipe 16 — F2B: cancel a sent invoice

**User goal:** "I sent the wrong invoice — cancel it and let me re-issue."

**Preconditions:** invoice is in `new` or `sent`. Any other state → 422.

**Sequence:**

1. **Pre-check.** `f2b_getInvoice({invoiceId})` — confirm `status in {new, sent}`. If not, tell the user it can't be cancelled (paid invoices need a refund flow outside this MCP).
2. **Confirm with the user explicitly.** State the invoice id, client name, total, and that the client will get a cancellation email. Get a "yes".
3. **`f2b_cancelInvoice({invoiceId})`** — backend sets `status: cancelled` + sends cancellation email to client.
4. (Optional) re-issue: jump to Recipe 14 step 4 with a corrected line-item set.

**Error handling:**

- 422 on wrong state — tell the user the current `status` and that cancellation is not possible from this state.

**Done when:** `f2b_getInvoice` shows `status: cancelled` and the user has decided whether to re-issue.

---

## Recipe 17 — Cancel a task (NEW or DRAFT) — direct soft cancel

**User goal:** "I changed my mind / made it by mistake — cancel this task before the freelancer engages."

**Preconditions:**

- Task is in state `1 NEW` or `17 DRAFT`. (For `IN_WORK` / `RESULT` / `FOR_PAYMENT`: use Recipe 5 instead — the freelancer must initiate the decline first.)
- The agent has the task's `uuid` (or numeric `taskId`).

**Sequence:**

1. `getTask({uuid})` → confirm `state in {1, 17}`. If not, point the user at Recipe 5 (decline confirmation) or tell them cancellation is not available from this state.
2. Show the user what they're about to cancel — title, freelancer, price, current state. Get explicit confirmation. Mention that the cancel is **soft**: the task moves to `DECLINED_BY_CUSTOMER (8)` and stays visible in `listTasks` with that state. There is no hard-delete.
3. On confirmation: `declineTask({uuid})` → state moves to `8 DECLINED_BY_CUSTOMER`. Any held funds are released automatically (no funds held for NEW/DRAFT in the first place).
4. Read `getTask({uuid})` to verify the state actually moved. Report the new state honestly.

**Error handling:**

- 422 / 403 on `declineTask`: the backend's `canBeDeclinedByCustomer` flag was false (rare edge case, e.g. task already terminal). Re-read `getTask` and reconcile.

**Done when:** task is `8 DECLINED_BY_CUSTOMER` and the user knows the record persists in listings.

---

## Cross-recipe rules

These apply to every recipe above:

- **Idempotency for task creation.** If the agent retries `createTask` after a network blip, do NOT pass the same `uuid` again — that returns HTTP 400. Use a stable client-generated `externalId`, then `listTasks(filter[externalId]=...)` to detect prior success before creating.
- **OpenSearch lag.** `listTasks` is search-backed and has eventual consistency. Within a few seconds of a write, results may be stale. For read-your-writes, fetch by `uuid` via `getTask`.
- **Pagination.** Every `list*` accepts `size` capped at 500 (values > 500 silently drop to 20). For large sweeps, paginate with `page`.
- **Errors.**
  - Branch on `code` for 409 only — but verify it's non-zero. Some 409 responses (e.g. `publishDraftTask` "Top-up your balance") return `code: 0` and only the human-readable `error` string; for those, branch on the HTTP status alone.
  - For 422, render the `field → error` map to the user as-is.
  - Never parse `message` (or `error`) for logic — it's translated and unstable.
  - Always log `X-Trace-Id` from response headers for support (note: not currently exposed by this MCP — backlog item).
- **Mutating actions need user confirmation.** Before any `accept*`, `decline*`, `pay*`, `remove*`, `delete*`, `close*`, `share*` — confirm with the user with the concrete entity ID and the action name.
- **No invented values.** When a required field is missing from the user's input, ask. Don't fill in placeholders.
