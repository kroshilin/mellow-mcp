# Post-release test cases — F2B slice 1 (PR #7)

**What shipped:** `userRole` probe, conditional tool registration, trace-id in MellowClient errors, two F2B tools — `f2b_createClient` and `f2b_listClients`.

**Where to test:** production MCP `https://mcp.mellow.io/mcp` (or dev/stage if available). Connect via Claude Desktop / Code / Inspector — any MCP client.

**Two accounts needed:** one customer (any working one), one freelancer (request a test one from backend, or use an existing freelancer Mellow account).

---

## Group 1 — Backward compatibility (customer flow not broken)

### 1.1 Customer sees the full pre-release tool surface

**Steps:**

1. Connect to MCP under a customer account.
2. List tools (via `/mcp` initialize).

**Expected:**

- Familiar customer tools present: `listTasks`, `getTask`, `createTask`, `inviteFreelancer`, `listFreelancers`, `getCompanyBalance`, all `scout_*`, etc. (everything that existed before slice 1).
- F2B tools NOT visible: neither `f2b_createClient` nor `f2b_listClients`.

**Fail if:** F2B tools appeared, or any pre-existing customer tool disappeared.

### 1.2 Customer runs a typical scenario — listTasks

**Steps:**

1. "Show me my in-progress tasks."

**Expected:** agent calls `listTasks` with state=2 filter, returns a real list, no behavior change vs baseline.

---

## Group 2 — Freelancer mode (new scope)

### 2.1 Freelancer sees ONLY F2B + profile

**Steps:**

1. Connect under a freelancer account (fresh OAuth session so the `/api/profile` probe runs on a fresh token).
2. List tools.

**Expected (exact list):**

- `f2b_createClient`
- `f2b_listClients`
- `getUserProfile`
- `changeLanguage`
- (any other tools registered by `registerProfileTools` — may include 1–2 more profile tools)

**MUST NOT be visible:** `listTasks`, `createTask`, `inviteFreelancer`, any `scout_*`, `listCompanies`, `getCompanyBalance`.

**Fail if:** customer or Scout tools visible — `userRole` probe didn't work.

### 2.2 Probe fallback to 'customer' on error

**Hard to simulate manually** (backend has to return non-2xx on `/api/profile`). If possible — ask backend to temporarily 500 on `/api/profile`, then reconnect:

**Expected:** agent sees customer tools (fallback); `wrangler tail` log contains `/api/profile probe returned 500; defaulting role to 'customer'`.

If not possible — skip; this gets a proper timeout in slice 2 (Important issue I-2 from review).

---

## Group 3 — `f2b_createClient`

### 3.1 Happy path: minimal legal client in EUR

**Steps:**

1. Under freelancer: "Create an F2B client, email `test+slice1@example.com`, country Cyprus, currency EUR."

**Expected:**

- Agent calls `f2b_createClient({email: 'test+slice1@example.com', country: 'CY', currency: 'EUR'})`.
- Response: `{clientId: <number>, type: 'legal', currency: 'EUR', status: 'not_verified', ...}`.
- Client visible in the freelancer's Mellow UI cabinet (open it to verify).

**Fail if:** response contains `currencyId: 3` instead of `currency: 'EUR'` — mapping didn't run.

### 3.2 Full field set

**Steps:**

1. "Create a client: Acme Ltd, Cyprus, EUR, email billing@acme.test, reg number CY12345678, VAT CY99887766, address Limassol 123, city Limassol, postal 3000."

**Expected:** all optional fields make it into the body (verify by checking the response — they should round-trip back). Status again `not_verified`.

### 3.3 Zod validation

**Steps:**

1. "Create a client with email `not-an-email`, country `XYZ`, currency `RUB`."

**Expected:** agent does NOT call the tool (Zod on MCP side rejects) — either re-asks the user or returns an error. Specifically:

- email — must pass `z.string().email()`;
- country — must pass `z.string().length(2)` (XYZ length 3 → fail; OR passes Zod but backend returns 422);
- currency — `RUB` not in `['EUR','USD']` enum — Zod blocks.

**Fail if:** the request reaches the backend with invalid data.

### 3.4 currency is fixed forever

**Steps:**

1. Create a client in EUR.
2. "Change its currency to USD."

**Expected:** agent should say "can't, currency is fixed at creation". If it tries `f2b_updateClient` — that tool doesn't exist in slice 1, should return "no such tool".

---

## Group 4 — `f2b_listClients`

### 4.1 List without filter

**Steps:**

1. "Show my F2B clients."

**Expected:**

- Calls `f2b_listClients({})` (no status).
- Response: `{items: [...], pagination: {...}}`, each `items[i].currency` is `'EUR'` or `'USD'` (not `currencyId`).
- Includes clients created in group 3.

### 4.2 Single status filter

**Steps:**

1. "Show only not-verified F2B clients."

**Expected:**

- Calls `f2b_listClients({status: 'not_verified'})`.
- All items in response have `status: 'not_verified'`.
- Group 3 clients in the result.

### 4.3 Multi-value status (OR semantics)

**Steps:**

1. "Show active and not-verified F2B clients."

**Expected:**

- Calls with `status: ['active', 'not_verified']`.
- Response contains clients of both statuses.
- Backend received URL `?filter[status][]=active&filter[status][]=not_verified` (if you can — check backend logs).

**Fail if:** only the last status was sent, or URL has no bracket notation.

### 4.4 Pagination

**Steps:**

1. "Show 5 clients on page 1, then 5 on page 2."

**Expected:** two calls with `page=1, limit=5` and `page=2, limit=5`. Pagination shows `total`, `pages`.

---

## Group 5 — trace-id in errors

### 5.1 Backend error contains a trace

**Repro:** trigger a 4xx/5xx from backend. Easiest:

1. Under customer: dispatch something that returns 422. E.g., "create a task with `categoryId: 999999`" (non-existent service).

**Expected:** agent's error includes `[trace=...]` or `[cf-ray=...]`, formatted like:

```
Mellow API POST /customer/tasks failed (422) [cf-ray=abc123-DME]: {"categoryId":"Service is not available"}
```

**Fail if:** error has no trace suffix.

### 5.2 Backend can find the log by trace

**Steps:** take the trace from 5.1, ask backend team to find it in Sentry/Kibana.

**Expected:** backend finds it — that's the whole point of the change.

---

## Group 6 — End-to-end roundtrip

### 6.1 Under freelancer: "send an invoice to a new client"

**This is a negative test for slice 1 — invoices don't exist yet.**

**Steps:**

1. Under freelancer: "Send an invoice for 1000 EUR to Acme Ltd."

**Expected:**

- Agent creates the client (if not yet) via `f2b_createClient`.
- Then hits a wall: there is no `f2b_createInvoiceDraft` in slice 1. Should tell the user "invoices aren't available yet, coming in the next release" or similar.

**Fail if:** agent hallucinates the tool or invents a workaround through customer tools (which are also not in scope here).

---

## Short checklist (if you're running short on time)

Minimum smoke:

- [ ] Under customer: see `listTasks`, don't see `f2b_*`. (group 1.1)
- [ ] Under freelancer: see `f2b_createClient`/`f2b_listClients`, don't see `listTasks`. (group 2.1)
- [ ] `f2b_createClient` creates a real client, visible in Mellow UI. (group 3.1)
- [ ] `f2b_listClients` shows it with `currency: 'EUR'`. (group 4.1)
- [ ] Any backend error contains `[trace=...]` or `[cf-ray=...]`. (group 5.1)

5 items — enough to know "the slice is alive". The remaining groups are detailed regression.

---

If anything fails — share the error (with trace-id) and we'll dig in. Findings from this round feed slice 2 design and the vitest setup test corpus.
