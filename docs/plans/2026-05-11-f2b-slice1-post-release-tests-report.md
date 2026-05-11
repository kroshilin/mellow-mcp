# Post-release test report — F2B slice 1 (PR #7)

**Source plan:** [`2026-05-06-f2b-slice1-post-release-tests.md`](./2026-05-06-f2b-slice1-post-release-tests.md)

**Environment:** production MCP `https://mcp.it-dep-271.workers.dev/sse` (no `mcp.mellow.io` custom domain yet).

**Account used:** freelancer (`volodyach9494@gmail.com`, id=884198, type=`freelancer`, country=CY, verified=true).

**Scope of this run:** freelancer-side groups only (2, 3, 4, 5.1, 6.1). Customer groups (1, 5.2) require a different OAuth session and backend log access — skipped with reason below.

---

## Summary

| Group | Title | Result |
|---|---|---|
| 1.1 | Customer sees full pre-release surface | ⏭ skipped — no customer session |
| 1.2 | Customer listTasks | ⏭ skipped |
| 2.1 | Freelancer sees ONLY F2B + profile | ⚠ pass with deviation (plan was inaccurate) |
| 2.2 | Probe fallback to customer | ⏭ skipped — needs backend to 5xx |
| 3.1 | Happy path: minimal legal client EUR | ✓ pass |
| 3.2 | Full field set | ✓ pass |
| 3.3 | Zod validation | ✓ pass (3/3) |
| 3.4 | Currency immutable | ✓ pass (no updateClient tool) |
| 4.1 | List without filter | ⚠ pass with bug (currency shape) |
| 4.2 | Single status filter | ✓ pass |
| 4.3 | Multi-value status (OR semantics) | ✓ pass |
| 4.4 | Pagination | ✗ fail — `limit` param ignored by backend |
| 5.1 | Backend error contains a trace | ✓ pass |
| 5.2 | Backend can find log by trace | ⏭ skipped — needs backend team |
| 6.1 | Invoice negative test | ✓ pass (no `f2b_createInvoiceDraft` exists) |

**Bugs found:** 2 (one HIGH, one MEDIUM). Detail in [Bugs](#bugs).
**Deviations from plan:** 1 (group 2.1 — surface differs from plan expectation; code is the source of truth).

---

## Group 2 — Freelancer mode

### 2.1 Freelancer tool surface ⚠

Actual exposed tools (from `initialize` deferred list):

- `f2b_createClient`
- `f2b_listClients`
- `getUserProfile`

**Plan expected** additionally `changeLanguage` and "any other tools registered by `registerProfileTools`".

**Source of truth** (`src/tools/profile.ts`): `registerProfileTools` registers **only** `getUserProfile`. There is no `changeLanguage` tool in the codebase.

**Verdict:** code is correct, plan was inaccurate. Update the plan or add `changeLanguage` if it's actually wanted.

Customer/Scout tools (`listTasks`, `inviteFreelancer`, `scout_*`, `listCompanies`, `getCompanyBalance`, …) are NOT visible. ✓

### 2.2 Probe fallback ⏭

Needs backend to return 5xx on `/api/profile`. Slated for slice 2 (Important issue I-2).

---

## Group 3 — `f2b_createClient`

### 3.1 Happy path ✓

Call:

```json
{"email": "test+slice1@example.com", "country": "CY", "currency": "EUR"}
```

Response: `id=6643`, `uuid=32f6686b-894f-424c-99e6-44275011b465`, `status="not_verified"`, `type="legal"`, `country="CY"`, `createdAt="2026-05-11 12:19:21"`.

Note: response embeds currency as `{"currency": "EUR", "id": 3}` — **not** a flat ISO string. See [Bug 1](#bug-1-currency-mapping-doesnt-flatten-to-iso-string).

### 3.2 Full field set ✓

Call:

```json
{
  "email": "billing@acme.test", "country": "CY", "currency": "EUR",
  "companyName": "Acme Ltd", "regNumber": "CY12345678", "vat": "CY99887766",
  "address": "Limassol 123", "city": "Limassol", "postalCode": "3000"
}
```

Response: `id=6644`, all fields round-trip. `address` is returned as object `{address: "Limassol 123", city: "Limassol", region: "", postalCode: "3000", country: "CY"}` — backend reshapes flat input into a sub-object. Tool docs (and `BACKEND` shape) should mention this.

### 3.3 Zod validation ✓

All three invalid-input cases blocked MCP-side before reaching the backend:

| input | result |
|---|---|
| `currency: "RUB"` | `Invalid option: expected one of "EUR"\|"USD"` |
| `email: "not-an-email"` | `Invalid email address` (custom regex + format=email) |
| `country: "XYZ"` | `expected string to have <=2 characters` |

### 3.4 Currency immutable ✓

No `f2b_updateClient` tool registered in slice 1 — confirmed in `src/tools/f2b/clients.ts`. If the agent is asked to "change currency", the only available tools are `f2b_createClient` and `f2b_listClients`, neither of which mutate existing clients. Behavior matches plan.

---

## Group 4 — `f2b_listClients`

### 4.1 No filter ⚠

Call: `f2b_listClients()`.
Response: 12 items initially, total=12. After group 3 created 3 more, total=15. Pagination shape matches plan: `{count, total, perPage, page, pages}`.

**Issue:** each `items[i].currency` is `{currency: "EUR"|"USD", id: number}`, not the flat ISO string `"EUR"|"USD"` promised by the tool description ("Returns clients with currency mapped to ISO code"). See [Bug 1](#bug-1-currency-mapping-doesnt-flatten-to-iso-string).

### 4.2 Single status filter ✓

`status="active"` → 2 items, both with `status="active"` (Tratoria, FIX FREELANCER LTD). Filter applied correctly.

### 4.3 Multi-value status — OR semantics ✓

`status=["active", "verification_failed"]` → 4 items (2 active + 2 verification_failed). Tool builds the correct repeated-key form `filter[status][]=active&filter[status][]=verification_failed` (confirmed in `src/tools/f2b/clients.ts:67-69` via `URLSearchParams.append`).

### 4.4 Pagination ✗

`page=1, limit=5` → response has `perPage: 20` and 15 items (all on one page). `limit` parameter is sent (`?page=1&limit=5` in URL via `URLSearchParams.set`) but the backend ignores it.

**Hypothesis:** backend expects `per_page`, not `limit`. See [Bug 2](#bug-2-limit-query-parameter-ignored-by-backend).

---

## Group 5 — Trace-id

### 5.1 Backend 4xx error contains a trace ✓

Trigger: `f2b_createClient({email: "trace-test@example.com", country: "ZZ", currency: "EUR"})` — `ZZ` passes Zod (`length=2`) but fails backend ISO-3166 validation.

Raw error message:

```
Mellow API POST /freelancer/f2b/clients/legal failed (422) [trace=9fa1224dbcdc8b21-CDG]: {"country":"This value is not a valid country."}
```

Trace format: `9fa1224dbcdc8b21-CDG` — Cloudflare ray-id shape (`<16-hex>-<3-letter-pop>`). Backend is forwarding cf-ray under the `x-trace-id` response header (the client reads `x-trace-id` first, then falls back to `cf-ray` — see `mellow-client.ts:76-78`).

### 5.2 Backend can find log by trace ⏭

Needs Sentry/Kibana access — hand the trace `9fa1224dbcdc8b21-CDG` to the backend team to confirm they can locate the 422 in logs.

---

## Group 6 — End-to-end

### 6.1 "Send an invoice" negative test ✓

No `f2b_createInvoiceDraft` (or similar invoice tool) exists in slice 1. The freelancer surface is exactly 3 tools (see 2.1). If a user asks for an invoice, the agent must say "not available yet, coming in next slice" — there is no tool to call and no legal customer-side workaround.

---

## Bugs

### Bug 1 — currency mapping doesn't flatten to ISO string

**Severity:** MEDIUM (data contract drift, but ISO code is still recoverable from the nested object).

**Where:** `src/tools/f2b/shared.ts:30-46` (`mapCurrencyIdToCode`).

**Observed:** every response object has `"currency": {"currency": "EUR", "id": 3}` instead of `"currency": "EUR"`.

**Root cause:** `mapCurrencyIdToCode` only rewrites keys named `currencyId` (number). The backend returns a `currency` object `{currency: string, id: number}` — no `currencyId` key exists in the F2B response, so the mapper is a no-op.

**Tool description claim** (`src/tools/f2b/clients.ts:49`):
> Returns clients with currency mapped to ISO code (EUR/USD).

This is not what's happening. The agent receives `{currency: "EUR", id: 3}` and has to dig one level deeper.

**Fix options:**

1. Add a branch to `mapCurrencyIdToCode` that flattens `currency: {currency, id}` → `currency: <iso>`.
2. Update tool descriptions to reflect the actual shape.
3. Make the contract typed (Zod output schema) so the mapping is enforced.

Option 1 is the smallest diff and matches what the tool description promises.

### Bug 2 — `limit` query parameter ignored by backend

**Severity:** HIGH for slice 2 (invoices will need real pagination), MEDIUM for slice 1 (only 15 clients, fits in one page of 20).

**Where:** `src/tools/f2b/clients.ts:65` (`search.set("limit", ...)`).

**Observed:** `f2b_listClients({page: 1, limit: 5})` → response `pagination.perPage: 20`, 15 items returned (no slicing applied).

**Root cause hypothesis:** the F2B endpoint expects `per_page` (snake_case) like other Mellow list endpoints (see `src/tools/tasks.ts` for the canonical filter form). The tool sends `limit`, backend ignores unknown params.

**Verification needed:** look at the F2B backend route — does it accept `per_page`, `pageSize`, or something else? If `per_page`:

```ts
// src/tools/f2b/clients.ts:65
if (params.limit !== undefined) search.set("per_page", params.limit.toString());
```

If neither: the param needs to be removed from the Zod schema entirely so we don't lie to the agent.

---

## Skipped — with reason

| Group | Why skipped | How to unblock |
|---|---|---|
| 1.1, 1.2 | Single freelancer OAuth session in this run | Re-run with a customer account |
| 2.2 | Backend has to return 5xx on `/api/profile` | Coordinate with backend or wait for slice 2 timeout |
| 5.2 | Trace `9fa1224dbcdc8b21-CDG` needs human lookup in Sentry/Kibana | Hand trace to backend team |

---

## Test data created (cleanup notes)

Three clients created on this run, all `status=not_verified` in account 884198:

| id | uuid | email | companyName |
|---|---|---|---|
| 6640 | b3bed487-686b-4575-a768-519ff4b5033b | mcp-smoke-test@example.com | MCP Smoke Test 2026-05-11 |
| 6643 | 32f6686b-894f-424c-99e6-44275011b465 | test+slice1@example.com | (none) |
| 6644 | aa6aedd4-486a-451a-a7e1-8cf6d36a2661 | billing@acme.test | Acme Ltd |

There is no `f2b_archiveClient` tool in slice 1 — these will need to be archived via the Mellow UI cabinet or backend (or carried into slice 2 once an archive tool ships).

---

## Recommendations feeding slice 2

1. **Fix Bug 1** before any invoice tool ships — invoice payloads will embed `currency` and the contract drift compounds.
2. **Fix Bug 2** before invoice listings ship — invoice listings will need real pagination.
3. **Update the post-release test plan** to match the actual freelancer surface (drop `changeLanguage` from group 2.1).
4. **Add an archive tool** (`f2b_archiveClient`) — needed both for cleanup of test data and for the standard client lifecycle.
5. **Type the structured contracts** with Zod output schemas so future mapping bugs surface in TS rather than in agent behavior.

---

# Appendix — Customer backward compat (executed 2026-05-11)

Same MCP endpoint, switched OAuth session to a customer account.

**Account:** `v.chesnokov+93464@mellow.io`, id=1095256, `type="customer"`, regDate=2025-10-09.

## Group 1.1 — Customer sees full pre-release surface ✓

Tool surface observed via MCP deferred list. F2B tools are NOT present (correct — they're freelancer-only).

**CoR tools (present):**

- Tasks: `acceptTask`, `addTaskFiles`, `addTaskMessage`, `changeDeadline`, `changeTaskStatus`, `checkTaskRequirements`, `createTask`, `declineTask`, `getTask`, `getTaskAttributes`, `getTaskMessages`, `listTasks`, `payForTask`, `publishDraftTask`, `resumeTask`
- Task groups: `createTaskGroup`, `deleteTaskGroup`, `listTaskGroups`, `renameTaskGroup`
- Freelancers: `editFreelancer`, `editFreelancerProfile`, `findFreelancerByEmail`, `findFreelancerByPhone`, `getFreelancer`, `getFreelancerTaxInfo`, `inviteFreelancer`, `listFreelancers`, `removeFreelancer`
- Companies: `getCompanyBalance`, `listCompanies`, `switchCompany`
- Finances/docs: `listTransactions`, `getAcceptanceDocuments`, `listDocuments`, `downloadDocument`
- Webhooks: `createOrUpdateWebhook`, `deleteWebhook`, `getWebhook`
- Reference: `getAllowedCurrencies`, `getCountries`, `getCurrencies`, `getExchangeRate`, `getServices`, `getSpecializations`, `getTaxDocumentTypes`, `getTaxStatuses`, `mellow_read_reference`
- ChatGPT connector shims: `fetch`, `search`
- Profile: `getUserProfile`

**Scout tools (present):** `scout_changeApplicationStatus`, `scout_closePosition`, `scout_createPoolFreelancer`, `scout_createPosition`, `scout_createPromoPosts`, `scout_deletePoolFreelancer`, `scout_deletePoolFreelancersBatch`, `scout_editPoolFreelancer`, `scout_generatePosition`, `scout_getApplication`, `scout_getAttachmentMetadata`, `scout_getCountries`, `scout_getGeneratePositionTask`, `scout_getPool`, `scout_getPoolFreelancer`, `scout_getPosition`, `scout_getPromoPosts`, `scout_getShortLink`, `scout_inviteApplicant`, `scout_listApplications`, `scout_listCompanies`, `scout_listPoolFreelancers`, `scout_listPositionApplications`, `scout_listPositions`, `scout_openPosition`, `scout_sharePosition`, `scout_updatePosition`.

**F2B tools (absent):** ✓ `f2b_createClient`, `f2b_listClients` — neither visible. Conditional registration in `src/index.ts:82-87` is working both ways: freelancer sees ONLY F2B + profile, customer sees ONLY the legacy customer surface.

## Group 1.2 — Customer listTasks ✓

Call: `listTasks({state: [2]})` (filter for IN_WORK state).

Response: `{"items": [], "pagination": {"count": 0, "total": 0, "perPage": 20, "page": 1, "pages": 0}}`.

Empty list — this account has no in-progress tasks. The point of the test is verifying the call works end-to-end (no `Failed to fetch user info` / 403 / probe regression). ✓

## Group 2.1 — Trace-id on customer side ✓

Substituted `payForTask({taskId: 99999999})` (rejected as too risky) with read-only `getTask({taskId: 99999999})` — same goal (trigger a backend 4xx and inspect the error suffix), zero side effects.

Trigger result:

```
Mellow API GET /customer/tasks/99999999 failed (404) [trace=9fa151c3496db7cb-FRA]: {"error":"TaskItemView with ID 99999999 was not found","code":0}
```

Trace: `9fa151c3496db7cb-FRA` (cf-ray shape, served as `x-trace-id`). Hand to backend team alongside the freelancer-side trace `9fa1224dbcdc8b21-CDG` to confirm 5.2 (log lookup) in one go.

---

## Slice 1 verdict

All three blocking checks pass:

| | result |
|---|---|
| 1.1 surface (no regression, no F2B leak) | ✓ |
| 1.2 listTasks (probe didn't break customer flow) | ✓ |
| 2.1 trace-id (observability intact) | ✓ |

Combined with the freelancer-side run earlier, slice 1 is **shippable**. Two non-blocker bugs ([Bug 1](#bug-1-currency-mapping-doesnt-flatten-to-iso-string), [Bug 2](#bug-2-limit-query-parameter-ignored-by-backend)) should be fixed before slice 2 (invoices) lands, since invoice payloads will compound both issues.
