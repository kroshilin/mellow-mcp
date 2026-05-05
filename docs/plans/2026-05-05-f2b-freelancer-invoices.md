# F2B Freelancer Invoices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 9 F2B (freelancer-to-business) MCP tools that let an authenticated freelancer manage F2B clients (create/list/update/archive) and invoices (createDraft → sendDraft, get/list/cancel) end-to-end, with composite client+invoice creation and a mandatory show-before-send invariant.

**Architecture:**

- One probe `GET /api/profile` in `MellowHandler` callback determines `userRole: 'customer' | 'freelancer'`, persisted in `Props`.
- `MyMCP.init()` registers tools conditionally — customer tools for `customer`, F2B tools (this PR) for `freelancer`.
- New `src/tools/f2b/` module: `clients.ts` (4 tools), `invoices.ts` (5 tools), `shared.ts` (currency mapping, enums, helpers).
- `MellowClient` improved to surface `X-Trace-Id` / `cf-ray` in error messages — affects all tools, not only F2B.
- New MCP resource `mellow://freelancer-guide` (source `docs/FREELANCER_GUIDE.md`).
- `AGENT_PRIMER` gets an opening-behavior section so the agent asks role at session start.

**Tech Stack:** TypeScript, Cloudflare Workers, MCP SDK (`@modelcontextprotocol/sdk`), Zod, Hono, OAuth Provider for Workers.

**Verification:** Project has no test framework. Each task is verified via `npm run type-check` (mandatory) plus optional manual smoke-test in MCP Inspector (`npm run dev` → `http://localhost:8788/sse`).

**Spec:** `/Users/vladimir/Dev/Mellow/product-department/04_products/mcp/mellow-mcp-f2b-freelancer-invoices-design.md`

---

## File Structure

**New files in `mcp_mellow`:**

- `src/tools/f2b/shared.ts` — currency mapping, status enums, measure enum, common Zod schemas
- `src/tools/f2b/clients.ts` — `registerF2bClientTools(server, client)` exporting 4 client tools
- `src/tools/f2b/invoices.ts` — `registerF2bInvoiceTools(server, client)` exporting 5 invoice tools
- `docs/FREELANCER_GUIDE.md` — domain guide for freelancer-mode agents

**Modified files in `mcp_mellow`:**

- `src/mellow-client.ts` — read `X-Trace-Id` and `cf-ray` on error, include in throw message
- `src/utils.ts` — add `userRole?: 'customer' | 'freelancer'` to `Props`
- `src/mellow-handler.ts` — probe `GET /api/profile` after `/userinfo`, set `userRole` in props
- `src/index.ts` — conditional `registerF2bClientTools` + `registerF2bInvoiceTools` based on `userRole`; register `mellow://freelancer-guide` resource
- `src/agent-primer.ts` — append opening-behavior section

---

## Task 1: Trace-id propagation in MellowClient

**Files:**

- Modify: `src/mellow-client.ts:74-77`

- [ ] **Step 1: Update `request()` to read trace headers on non-2xx**

Replace lines 74-77 in `src/mellow-client.ts`:

```ts
if (!response.ok) {
  const text = await response.text();
  const traceId = response.headers.get("x-trace-id");
  const cfRay = response.headers.get("cf-ray");
  const traceSuffix = traceId ? ` [trace=${traceId}]` : cfRay ? ` [cf-ray=${cfRay}]` : "";
  throw new Error(`Mellow API ${method} ${path} failed (${response.status})${traceSuffix}: ${text}`);
}
```

- [ ] **Step 2: Run type check**

```bash
npm run type-check
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/mellow-client.ts
git commit -m "feat(client): surface X-Trace-Id and cf-ray in error messages"
```

---

## Task 2: Add `userRole` to Props and probe in OAuth callback

**Files:**

- Modify: `src/utils.ts:139-151` (`Props` type)
- Modify: `src/mellow-handler.ts:170-196` (`/callback` handler)

- [ ] **Step 1: Add `userRole` field to `Props`**

Replace the `Props` type at the bottom of `src/utils.ts` (lines 139-151):

```ts
// Context from the auth process, encrypted & stored in the auth token
// and provided to the DurableMCP as this.props
export type Props = {
  sub: string;
  name: string;
  email: string;
  accessToken: string;
  refreshToken?: string;
  /**
   * Optional active company context for multi-company users.
   * When set, MellowClient sends `X-Company-Id: <activeCompanyId>` on every request.
   * Per-tool `companyId` parameters override this on individual calls.
   */
  activeCompanyId?: number;
  /**
   * Mellow account role determined by one-time probe to GET /api/profile during
   * OAuth callback. `customer` (default) → existing CoR/Scout tool surface.
   * `freelancer` → F2B + future freelancer-side tools. Defaults to 'customer'
   * if probe fails (preserves current behavior).
   */
  userRole?: "customer" | "freelancer";
};
```

- [ ] **Step 2: Add profile probe in `/callback`**

In `src/mellow-handler.ts`, replace lines 169-196 (after the `/userinfo` block, before `completeAuthorization`):

```ts
// Fetch the user info from Mellow
const userResponse = await fetch(`${c.env.MELLOW_BASE_URL}/userinfo`, {
  headers: {
    Authorization: `Bearer ${tokens.accessToken}`,
  },
});
if (!userResponse.ok) {
  return c.text("Failed to fetch user info with JWT " + tokens.accessToken, 500);
}
const { sub, name, email } = (await userResponse.json()) as { sub: string; name: string; email: string };

// Probe Mellow API to determine account role. JWT does not carry the
// customer/freelancer distinction — we have to ask the API. On any
// failure, default to 'customer' to preserve existing behavior.
let userRole: "customer" | "freelancer" = "customer";
try {
  const profileResponse = await fetch(`${c.env.MELLOW_API_BASE_URL}/profile`, {
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      Accept: "application/json",
    },
  });
  if (profileResponse.ok) {
    const profile = (await profileResponse.json()) as { type?: string };
    if (profile.type === "freelancer" || profile.type === "customer") {
      userRole = profile.type;
    }
  } else {
    console.warn(`/api/profile probe returned ${profileResponse.status}; defaulting role to 'customer'`);
  }
} catch (err) {
  console.warn(`/api/profile probe failed; defaulting role to 'customer':`, err);
}

// Return back to the MCP client a new token
const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
  metadata: {
    label: name,
  },
  // This will be available on this.props inside MyMCP
  props: {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    email,
    name,
    sub,
    userRole,
  } as Props,
  request: oauthReqInfo,
  scope: oauthReqInfo.scope,
  userId: sub,
});
```

- [ ] **Step 3: Run type check**

```bash
npm run type-check
```

Expected: no errors. (`MELLOW_API_BASE_URL` is already in `worker-configuration.d.ts` per `wrangler.jsonc`.)

- [ ] **Step 4: Commit**

```bash
git add src/utils.ts src/mellow-handler.ts
git commit -m "feat(auth): probe /api/profile and persist userRole in Props"
```

---

## Task 3: F2B shared module — currency mapping, enums, schemas

**Files:**

- Create: `src/tools/f2b/shared.ts`

- [ ] **Step 1: Create `src/tools/f2b/shared.ts`**

```ts
import { z } from "zod";

/**
 * F2B currency mapping. The backend speaks numeric `currencyId`, MCP exposes
 * ISO codes to the agent for clarity. Only EUR and USD are supported by F2B.
 */
export const F2B_CURRENCY_BY_ID: Record<number, "EUR" | "USD"> = {
  3: "EUR",
  2: "USD",
};

export const F2B_CURRENCY_TO_ID: Record<"EUR" | "USD", number> = {
  EUR: 3,
  USD: 2,
};

export function currencyToId(currency: "EUR" | "USD"): number {
  return F2B_CURRENCY_TO_ID[currency];
}

export function idToCurrency(currencyId: number): "EUR" | "USD" | undefined {
  return F2B_CURRENCY_BY_ID[currencyId];
}

/**
 * Recursively replace `currencyId: number` with `currency: 'EUR' | 'USD'` in
 * any backend response shape. Mutates a structural clone — does not touch the
 * input. Unknown currency ids are passed through untouched.
 */
export function mapCurrencyIdToCode<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => mapCurrencyIdToCode(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "currencyId" && typeof v === "number") {
        out.currency = idToCurrency(v) ?? v;
      } else {
        out[k] = mapCurrencyIdToCode(v);
      }
    }
    return out as unknown as T;
  }
  return value;
}

// Backend client status (exact strings from Mellow F2B API)
export const F2B_CLIENT_STATUS = [
  "not_verified",
  "verification_in_progress",
  "verification_failed",
  "active",
  "archived",
  "suspended",
] as const;
export type F2bClientStatus = (typeof F2B_CLIENT_STATUS)[number];

// Backend invoice status
export const F2B_INVOICE_STATUS = ["new", "sent", "payment_queued", "paid", "cancelled"] as const;
export type F2bInvoiceStatus = (typeof F2B_INVOICE_STATUS)[number];

// Acquiring transaction status (only meaningful when acquiringEnabled = true)
export const F2B_ACQUIRING_STATUS = ["notInitiated", "initiated", "completed", "failed"] as const;

// Line item measure (10 fixed values)
export const F2B_MEASURE = ["item", "hour", "day", "week", "month", "kg", "ton", "liter", "cubic_meter", "km"] as const;

// Reusable Zod schemas
export const f2bCurrencyEnum = z.enum(["EUR", "USD"]);
export const f2bClientStatusEnum = z.enum(F2B_CLIENT_STATUS);
export const f2bInvoiceStatusEnum = z.enum(F2B_INVOICE_STATUS);
export const f2bMeasureEnum = z.enum(F2B_MEASURE);
export const f2bCommissionPayerEnum = z.enum(["freelancer", "customer"]);

export const f2bLineItemSchema = z.object({
  name: z.string().min(1).max(1024).describe("Line item label, no HTML, 1–1024 chars"),
  quantity: z.number().positive().describe("Must be > 0"),
  measure: f2bMeasureEnum.describe("One of: item, hour, day, week, month, kg, ton, liter, cubic_meter, km"),
  price: z.number().positive().describe("Unit price in client currency, must be > 0"),
});

export type F2bLineItem = z.infer<typeof f2bLineItemSchema>;
```

- [ ] **Step 2: Run type check**

```bash
npm run type-check
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/tools/f2b/shared.ts
git commit -m "feat(f2b): add shared module — currency mapping, status enums, line item schema"
```

---

## Task 4: f2b_createClient tool

**Files:**

- Create: `src/tools/f2b/clients.ts`

- [ ] **Step 1: Create `src/tools/f2b/clients.ts` with `f2b_createClient` only**

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asStructuredList, asStructuredObject, type MellowClient } from "../../mellow-client";
import { currencyToId, f2bClientStatusEnum, f2bCurrencyEnum, mapCurrencyIdToCode } from "./shared";

export function registerF2bClientTools(server: McpServer, client: MellowClient) {
  server.tool(
    "f2b_createClient",
    "Create a new F2B (freelancer-to-business) legal client. Currency (EUR or USD) is fixed at creation and cannot be changed later. Required: email, country (ISO-3166 alpha-2), currency. All other fields optional. Status starts as 'not_verified' — this does NOT block invoicing; verification triggers on the client's first payment attempt. The freelancer can immediately create and send invoices to a not_verified client. There is no contactName/phone in the F2B model — do not invent these fields.",
    {
      email: z.string().email().describe("Email where the invoice link will be sent"),
      country: z.string().length(2).describe("ISO-3166 alpha-2 country code, e.g. CY, US, DE"),
      currency: f2bCurrencyEnum.describe("EUR or USD. Fixed at creation — invoices to this client must be in this currency."),
      companyName: z.string().optional().describe("Legal company name"),
      regNumber: z.string().max(30).optional().describe("Company registration number, ≤ 30 chars"),
      vat: z.string().optional().describe("VAT id (string identifier, not a percent rate)"),
      tin: z.string().optional().describe("Taxpayer identification number"),
      address: z.string().optional(),
      city: z.string().optional(),
      region: z.string().optional().describe("State/region. For country=US, must be a valid 2-letter state code."),
      postalCode: z.string().optional(),
    },
    { title: "Create F2B client" },
    async (params) => {
      const body = {
        email: params.email,
        country: params.country,
        currencyId: currencyToId(params.currency),
        companyName: params.companyName,
        regNumber: params.regNumber,
        vat: params.vat,
        tin: params.tin,
        address: params.address,
        city: params.city,
        region: params.region,
        postalCode: params.postalCode,
      };
      const result = await client.post<unknown>("/freelancer/f2b/clients/legal", body);
      const mapped = mapCurrencyIdToCode(result);
      return {
        structuredContent: asStructuredObject(mapped),
        content: [{ text: JSON.stringify(mapped, null, 2), type: "text" as const }],
      };
    },
  );
}
```

> **Note on path prefix:** existing tools use paths like `/customer/freelancers` — `MellowClient` does not prepend `/api`. The base URL `https://my.mellow.io/api` already contains it. So our F2B paths use `/freelancer/f2b/...`, NOT `/api/freelancer/f2b/...`.

- [ ] **Step 2: Run type check**

```bash
npm run type-check
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/tools/f2b/clients.ts
git commit -m "feat(f2b): add f2b_createClient tool"
```

---

## Task 5: f2b_listClients tool

**Files:**

- Modify: `src/tools/f2b/clients.ts` (add new `server.tool` block)

- [ ] **Step 1: Append `f2b_listClients` to `registerF2bClientTools`**

Inside the `registerF2bClientTools` function in `src/tools/f2b/clients.ts`, after the `f2b_createClient` block, add:

```ts
server.tool(
  "f2b_listClients",
  "List F2B clients of the freelancer. Backend supports filtering by status[] only — search by name and date filters are NOT supported by the API; for search the agent must page through results and filter MCP-side by companyName. Returns clients with currency mapped to ISO code (EUR/USD).",
  {
    status: z
      .union([f2bClientStatusEnum, z.array(f2bClientStatusEnum)])
      .optional()
      .describe("Filter by client status. Pass a single value or an array (OR semantics)."),
    page: z.number().optional().describe("Page number (default: 1)"),
    limit: z.number().optional().describe("Page size (backend default if omitted)"),
  },
  { title: "List F2B clients", readOnlyHint: true },
  async (params) => {
    const queryParams: Record<string, string | undefined> = {
      page: params.page?.toString(),
      limit: params.limit?.toString(),
    };
    const statuses = Array.isArray(params.status) ? params.status : params.status ? [params.status] : [];
    for (const s of statuses) {
      // Bracketed multi-value query param convention used across this MCP
      // Each push overwrites the same key; backend-side filter[status][]= works.
      // We collect them as separate URLSearchParams via `MellowClient`.
      // Workaround: encode each unique key suffix.
      // Simpler: rely on URLSearchParams.append by passing an array via repeated key.
      // MellowClient.get takes Record<string, string|undefined> which uses .set()
      // — set() overwrites. So we use an indexed key form that the bracket
      // filter parser accepts the LAST value, which is wrong for OR.
      // Fix: build the URL manually for multi-status. See implementation below.
      void s;
    }
    // For multi-value filter[status][], MellowClient's params object can't
    // express duplicate keys (it uses .set()). Build query string manually.
    const search = new URLSearchParams();
    if (params.page !== undefined) search.set("page", params.page.toString());
    if (params.limit !== undefined) search.set("limit", params.limit.toString());
    for (const s of statuses) {
      search.append("filter[status][]", s);
    }
    const path = `/freelancer/f2b/clients${search.toString() ? `?${search.toString()}` : ""}`;
    const result = await client.get<unknown>(path);
    const mapped = mapCurrencyIdToCode(result);
    return {
      structuredContent: asStructuredList(mapped),
      content: [{ text: JSON.stringify(mapped, null, 2), type: "text" as const }],
    };
  },
);
```

- [ ] **Step 2: Run type check**

```bash
npm run type-check
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/tools/f2b/clients.ts
git commit -m "feat(f2b): add f2b_listClients tool with status[] filter support"
```

---

## Task 6: f2b_updateClient tool

**Files:**

- Modify: `src/tools/f2b/clients.ts`

- [ ] **Step 1: Append `f2b_updateClient` to `registerF2bClientTools`**

After `f2b_listClients`:

```ts
server.tool(
  "f2b_updateClient",
  "Update an existing F2B client. The client's currency and type are immutable — the backend has no field for them in PUT. All address fields, email, country, companyName, regNumber, vat, tin are mutable.",
  {
    clientId: z.number().int().describe("Numeric client ID returned by f2b_createClient"),
    email: z.string().email().optional(),
    country: z.string().length(2).optional().describe("ISO-3166 alpha-2"),
    companyName: z.string().optional(),
    regNumber: z.string().max(30).optional(),
    vat: z.string().optional(),
    tin: z.string().optional(),
    address: z.string().optional(),
    city: z.string().optional(),
    region: z.string().optional(),
    postalCode: z.string().optional(),
  },
  { title: "Update F2B client" },
  async (params) => {
    const body: Record<string, unknown> = { clientId: params.clientId };
    for (const [k, v] of Object.entries(params)) {
      if (k !== "clientId" && v !== undefined) body[k] = v;
    }
    const result = await client.put<unknown>("/freelancer/f2b/clients/legal", body);
    const mapped = mapCurrencyIdToCode(result);
    return {
      structuredContent: asStructuredObject(mapped),
      content: [{ text: JSON.stringify(mapped, null, 2), type: "text" as const }],
    };
  },
);
```

- [ ] **Step 2: Run type check**

```bash
npm run type-check
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/tools/f2b/clients.ts
git commit -m "feat(f2b): add f2b_updateClient tool (currency immutable)"
```

---

## Task 7: f2b_archiveClient tool

**Files:**

- Modify: `src/tools/f2b/clients.ts`

- [ ] **Step 1: Append `f2b_archiveClient` to `registerF2bClientTools`**

After `f2b_updateClient`:

```ts
  server.tool(
    "f2b_archiveClient",
    "Soft-delete (archive) an F2B client. New invoices to an archived client are rejected (422). Previously sent invoices continue to work. There is no API to un-archive — re-create the client if needed.",
    {
      clientId: z.number().int().describe("Numeric client ID"),
    },
    { title: "Archive F2B client" },
    async ({ clientId }) => {
      const result = await client.del<unknown>("/freelancer/f2b/clients", {
        clientId,
      });
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );
}
```

> **Note:** the closing `}` above is the closing brace of `registerF2bClientTools`. Ensure no second closing brace remains from the earlier skeleton.

- [ ] **Step 2: Run type check**

```bash
npm run type-check
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/tools/f2b/clients.ts
git commit -m "feat(f2b): add f2b_archiveClient tool"
```

---

## Task 8: f2b_createInvoiceDraft tool (composite)

**Files:**

- Create: `src/tools/f2b/invoices.ts`

- [ ] **Step 1: Create `src/tools/f2b/invoices.ts` with `f2b_createInvoiceDraft`**

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asStructuredList, asStructuredObject, type MellowClient } from "../../mellow-client";
import { f2bCommissionPayerEnum, f2bInvoiceStatusEnum, f2bLineItemSchema, mapCurrencyIdToCode } from "./shared";

export function registerF2bInvoiceTools(server: McpServer, client: MellowClient) {
  server.tool(
    "f2b_createInvoiceDraft",
    "Create an F2B invoice in draft status (`new`). Email is NOT sent yet — this is the 'preview' half of the mandatory two-step send pattern. Currency is derived from the client (set at f2b_createClient). Composite under the hood: GET client → POST /calculate-cost → POST /v2/invoices. Returns breakdown (subtotal, commissionPercent, commissionAmount, salesTax, total, payable). Public payment URL does NOT exist until f2b_sendInvoiceDraft. Backend limits: ≤ 10 line items, total amount ≤ 10 000 in client currency, invoiceDate ≤ today.",
    {
      clientId: z.number().int().describe("Target F2B client (currency derived from client)"),
      serviceId: z.number().int().describe("Service catalog id from Mellow service taxonomy"),
      serviceName: z.string().min(1).max(1024).describe("Service description, no HTML; appears on the invoice as the main title"),
      serviceStartDate: z.string().describe("ISO date (YYYY-MM-DD) — start of the period the service covers"),
      serviceEndDate: z
        .string()
        .describe("ISO date — end of the service period; ALSO doubles as the de-facto due date since API has no separate dueDate field"),
      invoiceDate: z.string().describe("ISO date — issuance date; must be ≤ today (backend rejects future dates with 422)"),
      lineItems: z
        .array(f2bLineItemSchema)
        .min(1)
        .max(10)
        .describe("1–10 line items; sum of price*quantity must be ≤ 10 000 in client currency"),
      commissionPayer: f2bCommissionPayerEnum.describe(
        "'freelancer' (commission deducted from payable) or 'customer' (commission added to total)",
      ),
      acquiringEnabled: z
        .boolean()
        .optional()
        .describe(
          "false (default) → bank transfer only (5% commission). true → client picks bank (5%) or card (5%+3%=8%) on the payment page.",
        ),
    },
    { title: "Create F2B invoice draft" },
    async (params) => {
      // 1. Resolve client to derive currencyId
      const clientObj = await client.get<{ currencyId: number; status: string }>(`/freelancer/f2b/clients/${params.clientId}`);
      if (clientObj.status === "archived" || clientObj.status === "suspended") {
        throw new Error(
          `F2B client ${params.clientId} is in status '${clientObj.status}'; cannot create invoice. Archive a client only AFTER all open invoices are settled.`,
        );
      }
      const currencyId = clientObj.currencyId;

      // 2. Compose request body shared by calculate-cost and POST /v2/invoices
      const baseBody = {
        currencyId,
        commissionPayer: params.commissionPayer,
        lineItems: params.lineItems,
      };

      // 3. Best-effort cost preview. If it fails we still proceed and let the
      //    create endpoint be the source of truth for the breakdown.
      let preview: unknown = null;
      try {
        preview = await client.post<unknown>("/freelancer/f2b/invoices/calculate-cost", baseBody);
      } catch (err) {
        console.warn("F2B calculate-cost preview failed:", err);
      }
      void preview;

      // 4. Create the draft. The backend response includes the full breakdown.
      const created = await client.post<unknown>("/freelancer/f2b/v2/invoices", {
        ...baseBody,
        clientId: params.clientId,
        serviceId: params.serviceId,
        serviceName: params.serviceName,
        serviceStartDate: params.serviceStartDate,
        serviceEndDate: params.serviceEndDate,
        invoiceDate: params.invoiceDate,
        acquiringEnabled: params.acquiringEnabled ?? false,
      });

      const mapped = mapCurrencyIdToCode(created);
      return {
        structuredContent: asStructuredObject(mapped),
        content: [{ text: JSON.stringify(mapped, null, 2), type: "text" as const }],
      };
    },
  );
}
```

- [ ] **Step 2: Run type check**

```bash
npm run type-check
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/tools/f2b/invoices.ts
git commit -m "feat(f2b): add f2b_createInvoiceDraft (composite: getClient → calculate-cost → v2/invoices)"
```

---

## Task 9: f2b_sendInvoiceDraft tool

**Files:**

- Modify: `src/tools/f2b/invoices.ts`

- [ ] **Step 1: Append `f2b_sendInvoiceDraft` to `registerF2bInvoiceTools`**

Inside `registerF2bInvoiceTools`, after `f2b_createInvoiceDraft`:

```ts
server.tool(
  "f2b_sendInvoiceDraft",
  "Send a previously created F2B invoice draft to the client. Triggers email to client.email and exposes the public paymentUrl. Transitions invoice from 'new' → 'sent'. Backend returns 422 if invoice is not in 'new', or if client.status ∈ {archived, suspended}. AGENT confirmation rule applies: confirm subtotal/total/client with the user before calling this — after this call the email is out and clients see the invoice.",
  {
    invoiceId: z.number().int().describe("Numeric invoice id from f2b_createInvoiceDraft"),
  },
  { title: "Send F2B invoice draft" },
  async ({ invoiceId }) => {
    const result = await client.post<unknown>("/freelancer/f2b/invoices/send", { invoiceId });
    const mapped = mapCurrencyIdToCode(result);
    return {
      structuredContent: asStructuredObject(mapped),
      content: [{ text: JSON.stringify(mapped, null, 2), type: "text" as const }],
    };
  },
);
```

- [ ] **Step 2: Run type check**

```bash
npm run type-check
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/tools/f2b/invoices.ts
git commit -m "feat(f2b): add f2b_sendInvoiceDraft tool"
```

---

## Task 10: f2b_getInvoice tool (composite, optional acquiring fetch)

**Files:**

- Modify: `src/tools/f2b/invoices.ts`

- [ ] **Step 1: Append `f2b_getInvoice` to `registerF2bInvoiceTools`**

After `f2b_sendInvoiceDraft`:

```ts
server.tool(
  "f2b_getInvoice",
  "Get one F2B invoice with full details. If acquiringEnabled = true and status ∈ {sent, payment_queued}, additionally fetches the public /payment-status endpoint to surface the acquiring transaction state ('notInitiated' | 'initiated' | 'completed' | 'failed'). For bank-transfer invoices, paymentStatus is omitted — rely on invoice.status.",
  {
    invoiceId: z.number().int().describe("Numeric invoice id"),
  },
  { title: "Get F2B invoice", readOnlyHint: true },
  async ({ invoiceId }) => {
    const invoice = await client.get<
      {
        uuid?: string;
        status?: string;
        acquiringEnabled?: boolean;
      } & Record<string, unknown>
    >(`/freelancer/f2b/invoices/${invoiceId}`);

    let paymentStatus: unknown = undefined;
    if (invoice.acquiringEnabled && invoice.uuid && (invoice.status === "sent" || invoice.status === "payment_queued")) {
      try {
        paymentStatus = await client.get<unknown>(`/f2b/invoices/payment-status/${invoice.uuid}`);
      } catch (err) {
        console.warn("F2B payment-status fetch failed:", err);
      }
    }

    const merged = paymentStatus !== undefined ? { ...invoice, paymentStatus } : invoice;
    const mapped = mapCurrencyIdToCode(merged);
    return {
      structuredContent: asStructuredObject(mapped),
      content: [{ text: JSON.stringify(mapped, null, 2), type: "text" as const }],
    };
  },
);
```

- [ ] **Step 2: Run type check**

```bash
npm run type-check
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/tools/f2b/invoices.ts
git commit -m "feat(f2b): add f2b_getInvoice with optional acquiring payment-status merge"
```

---

## Task 11: f2b_listInvoices tool

**Files:**

- Modify: `src/tools/f2b/invoices.ts`

- [ ] **Step 1: Append `f2b_listInvoices` to `registerF2bInvoiceTools`**

After `f2b_getInvoice`:

```ts
server.tool(
  "f2b_listInvoices",
  "List F2B invoices of the freelancer. Backend supports status[] filter only; clientId and date-range filters are NOT supported by the API and must be applied MCP-side after the fetch. Returns currency mapped to ISO code.",
  {
    status: z
      .union([f2bInvoiceStatusEnum, z.array(f2bInvoiceStatusEnum)])
      .optional()
      .describe("Filter by invoice status. Single value or array (OR semantics)."),
    page: z.number().optional().describe("Page number (default: 1)"),
    limit: z.number().optional().describe("Page size (backend default if omitted)"),
  },
  { title: "List F2B invoices", readOnlyHint: true },
  async (params) => {
    const search = new URLSearchParams();
    if (params.page !== undefined) search.set("page", params.page.toString());
    if (params.limit !== undefined) search.set("limit", params.limit.toString());
    const statuses = Array.isArray(params.status) ? params.status : params.status ? [params.status] : [];
    for (const s of statuses) {
      search.append("filter[status][]", s);
    }
    const path = `/freelancer/f2b/invoices${search.toString() ? `?${search.toString()}` : ""}`;
    const result = await client.get<unknown>(path);
    const mapped = mapCurrencyIdToCode(result);
    return {
      structuredContent: asStructuredList(mapped),
      content: [{ text: JSON.stringify(mapped, null, 2), type: "text" as const }],
    };
  },
);
```

- [ ] **Step 2: Run type check**

```bash
npm run type-check
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/tools/f2b/invoices.ts
git commit -m "feat(f2b): add f2b_listInvoices with status[] filter"
```

---

## Task 12: f2b_cancelInvoice tool

**Files:**

- Modify: `src/tools/f2b/invoices.ts`

- [ ] **Step 1: Append `f2b_cancelInvoice` to `registerF2bInvoiceTools`**

After `f2b_listInvoices`:

```ts
  server.tool(
    "f2b_cancelInvoice",
    "Cancel an F2B invoice. Allowed only when status ∈ {new, sent}. Backend returns 422 with the current invoice state for any other status (paid, cancelled, payment_queued). Cancellation cannot be undone — for a corrected version, cancel and create a new draft. The API does NOT accept a 'reason' field.",
    {
      invoiceId: z.number().int().describe("Numeric invoice id"),
    },
    { title: "Cancel F2B invoice" },
    async ({ invoiceId }) => {
      const result = await client.del<unknown>("/freelancer/f2b/invoices", {
        invoiceId,
      });
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );
}
```

> **Note:** the closing `}` above is the closing brace of `registerF2bInvoiceTools`.

- [ ] **Step 2: Run type check**

```bash
npm run type-check
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/tools/f2b/invoices.ts
git commit -m "feat(f2b): add f2b_cancelInvoice tool"
```

---

## Task 13: Wire F2B tools into MyMCP with conditional registration

**Files:**

- Modify: `src/index.ts:1-76` (imports + `init()`)

- [ ] **Step 1: Add F2B imports**

In `src/index.ts`, after the existing `registerScout*` imports (around line 30), add:

```ts
import { registerF2bClientTools } from "./tools/f2b/clients";
import { registerF2bInvoiceTools } from "./tools/f2b/invoices";
```

- [ ] **Step 2: Conditionally register F2B tools in `init()`**

In `src/index.ts`, replace the existing `init()` body (lines 46-76) — keep the customer registrations as-is, but add a freelancer branch BEFORE the Scout block. The final shape of the relevant section:

```ts
  async init() {
    try {
      const userRole = this.props?.userRole ?? "customer";
      const client = createMellowClient(this.env.MELLOW_API_BASE_URL, this.props!.accessToken, this.props!.activeCompanyId);

      if (userRole === "customer") {
        registerTaskTools(this.server, client);
        registerTaskGroupTools(this.server, client);
        registerFreelancerTools(this.server, client);
        registerFinanceTools(this.server, client);
        registerCompanyTools(this.server, client);
        registerDocumentTools(this.server, client);
        registerReferenceTools(this.server, client);
        registerWebhookTools(this.server, client);
        registerProfileTools(this.server, client);
        registerChatGptTools(this.server, client);

        registerReferenceFallbackTool(this.server, {
          domain: DOMAIN_MD,
          workflows: WORKFLOWS_MD,
          antiPatterns: ANTI_PATTERNS_MD,
        });

        const scoutClient = createMellowClient(this.env.SCOUT_API_BASE_URL, this.props!.accessToken, this.props!.activeCompanyId);

        registerScoutPositionTools(this.server, scoutClient);
        registerScoutApplicationTools(this.server, scoutClient);
        registerScoutAiTaskTools(this.server, scoutClient);
        registerScoutPromoPostTools(this.server, scoutClient);
        registerScoutPoolTools(this.server, scoutClient);
        registerScoutAttachmentTools(this.server, scoutClient);
        registerScoutCompanyTools(this.server, scoutClient);
        registerScoutLookupTools(this.server, scoutClient);
      }

      if (userRole === "freelancer") {
        registerF2bClientTools(this.server, client);
        registerF2bInvoiceTools(this.server, client);
        registerProfileTools(this.server, client);
      }

      // ... resource registrations stay below (mellow://domain etc.) — see Task 14
```

> **Note:** keep the existing resource registrations (`mellow-domain-guide`, `mellow-workflows`, `mellow-anti-patterns`) below, unchanged in this task. Task 14 adds the freelancer-guide resource alongside them.

- [ ] **Step 3: Run type check**

```bash
npm run type-check
```

Expected: no errors.

- [ ] **Step 4: Smoke-test (optional but recommended)**

If you have a freelancer test account (or backend can flip a test user's `profile.type`):

```bash
npm run dev
```

Open `npx @modelcontextprotocol/inspector@latest`, connect to `http://localhost:8788/sse`, complete OAuth as freelancer, verify F2B tools appear in the tool list and customer tools (e.g., `listTasks`) do NOT.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(mcp): conditional tool registration based on userRole (customer/freelancer)"
```

---

## Task 14: Add `mellow://freelancer-guide` resource and update register call

**Files:**

- Modify: `src/index.ts` (resource registration block, ~line 78–120)

- [ ] **Step 1: Add the freelancer-guide resource alongside existing ones**

In `src/index.ts`, the existing block registers three resources (`mellow-domain-guide`, `mellow-workflows`, `mellow-anti-patterns`). Note these currently sit inside the customer-only branch implicitly because they're inside `init()` but after the conditional. Per Task 13's restructure, move them OUTSIDE the role-conditional branches but BEFORE the `try` block close, so both roles can read them.

Then add the freelancer-guide resource. Final shape:

At the top of `src/index.ts`, with other markdown imports, add:

```ts
import FREELANCER_GUIDE_MD from "../docs/FREELANCER_GUIDE.md";
```

In `init()`, after the role-conditional blocks but inside the `try`, add the resource registration:

```ts
this.server.registerResource(
  "mellow-domain-guide",
  "mellow://domain",
  {
    title: "Mellow Domain Guide",
    description:
      "Full domain reference for agents working with the Mellow & Scout MCP: actors, products (CoR + AI Scout), state machines, preconditions, decision trees. Read before producing tool calls for unfamiliar flows.",
    mimeType: "text/markdown",
  },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: DOMAIN_MD }],
  }),
);

this.server.registerResource(
  "mellow-workflows",
  "mellow://workflows",
  {
    title: "Mellow Workflows (12 end-to-end recipes)",
    description:
      "End-to-end recipes: onboarding + first task, accept-and-pay (two-step), Scout hire, multi-currency, bulk invite, bulk task creation, etc. Each recipe lists preconditions, concrete tool sequence, error handling, and 'done when' criteria.",
    mimeType: "text/markdown",
  },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: WORKFLOWS_MD }],
  }),
);

this.server.registerResource(
  "mellow-anti-patterns",
  "mellow://anti-patterns",
  {
    title: "Mellow Anti-patterns (common agent mistakes)",
    description: "Catalogue of common agent mistakes when driving the MCP, with corrected patterns. Bad / Why / Good per entry.",
    mimeType: "text/markdown",
  },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: ANTI_PATTERNS_MD }],
  }),
);

if (userRole === "freelancer") {
  this.server.registerResource(
    "mellow-freelancer-guide",
    "mellow://freelancer-guide",
    {
      title: "Mellow Freelancer Guide (F2B and freelancer-side flows)",
      description:
        "Domain reference for agents operating in freelancer mode: F2B client lifecycle, invoice statuses, two-step send invariant, error semantics, and decision trees for typical flows. Read at session start when userRole=freelancer.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: FREELANCER_GUIDE_MD }],
    }),
  );
}
```

- [ ] **Step 2: Wrangler text loader**

The existing setup already loads `.md` files via Wrangler text rule (verified by working `DOMAIN_MD` etc.). No change to `wrangler.jsonc` needed. Confirm by running:

```bash
npm run cf-typegen
```

This regenerates `worker-configuration.d.ts` and the ambient `declare module "*.md"` if missing.

- [ ] **Step 3: Run type check**

Note: this step will fail if `docs/FREELANCER_GUIDE.md` does not exist yet. Task 15 creates it. Either run Task 15 first, or stub the file:

```bash
mkdir -p docs && echo "# Mellow Freelancer Guide (placeholder, see Task 15)" > docs/FREELANCER_GUIDE.md
npm run type-check
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts docs/FREELANCER_GUIDE.md
git commit -m "feat(mcp): register mellow://freelancer-guide resource for freelancer mode"
```

---

## Task 15: Write FREELANCER_GUIDE.md content

**Files:**

- Modify: `docs/FREELANCER_GUIDE.md` (replace placeholder from Task 14 with real content)

- [ ] **Step 1: Replace placeholder with full guide**

Overwrite `docs/FREELANCER_GUIDE.md` with the following:

```markdown
# Mellow Freelancer Guide

You are operating in freelancer mode (`userRole=freelancer`). The Mellow account that authorized this MCP session belongs to a freelancer / self-employed contractor. Customer-side tools (tasks, scout hiring, etc.) are NOT available; backend `/api/customer/*` endpoints would 403 anyway.

## Surface in this mode

You have F2B tools (freelancer-to-business invoicing) and the freelancer-side profile tool. F2B is for invoicing **external clients** (companies that are NOT in Mellow). The recipient of an F2B invoice does not need a Mellow account — they receive an email with a public payment link.

- **F2B client management:** `f2b_createClient`, `f2b_listClients`, `f2b_updateClient`, `f2b_archiveClient`.
- **F2B invoicing:** `f2b_createInvoiceDraft` → `f2b_sendInvoiceDraft`, plus `f2b_getInvoice`, `f2b_listInvoices`, `f2b_cancelInvoice`.

## Two-step send invariant

Issuing an invoice is always **two MCP calls**:

1. `f2b_createInvoiceDraft(...)` returns the breakdown (subtotal, commission, total, payable). Email is NOT sent. Show the breakdown to the user, get explicit confirmation.
2. `f2b_sendInvoiceDraft({invoiceId})` sends the email and exposes the public `paymentUrl`.

There is intentionally no `f2b_createAndSendInvoice` shortcut. Do not invent one.

## Currency rules

- A client's currency (EUR or USD) is **fixed at creation** in `f2b_createClient`.
- Invoices automatically inherit the client's currency. Do not ask the user for invoice currency — fetch the client first if needed.
- If the user names an amount in a currency that does not match the client's, raise it explicitly: "Acme is in EUR, you said USD — convert at today's rate, or pick a different client?"

## Status semantics

Client status (from `/freelancer/f2b/clients`):

- `not_verified` — fresh client, never paid yet. Does NOT block invoicing — verification triggers on the client's first payment attempt.
- `verification_in_progress` — client started paying, Mellow is verifying their company data (~10–15 min typical, not SLA).
- `verification_failed` — client supplied invalid data; you can still send invoices, but payment will fail again until they fix it.
- `active` — verified, repeat payments are immediate.
- `archived` — soft-deleted; new invoices rejected with 422. Existing invoices keep working.
- `suspended` — backend hold, do not invoice.

Invoice status (from `/freelancer/f2b/invoices`):

- `new` → draft, email not sent.
- `sent` → email sent, awaiting payment / verification.
- `payment_queued` → client initiated payment, settlement in flight.
- `paid` → funds on Mellow balance (90% within minutes; up to 6 business days for extra checks).
- `cancelled` → cancelled by freelancer.

Acquiring payment status (only when `acquiringEnabled = true`, surfaced by `f2b_getInvoice`): `notInitiated | initiated | completed | failed`. For bank-only invoices (`acquiringEnabled = false`), rely on `invoice.status` directly.

## Commission model

- Bank transfer: 5% (`commissionPercent`).
- Card (acquiring): 5% + 3% = 8% (`commissionPercent + acquiringCommissionPercent`).
- `commissionPayer = 'freelancer'` → commission is deducted from `payable`.
- `commissionPayer = 'customer'` → commission is added to `total`; the freelancer receives the full subtotal.

Backend returns the breakdown — never compute it locally.

## Backend limits to enforce in confirmations

- ≤ 10 line items per invoice.
- Total ≤ 10 000 in client currency.
- `invoiceDate` must be ≤ today.
- `lineItems[].name` ≤ 1024 chars, no HTML.
- `lineItems[].quantity > 0`, `price > 0`.

## Filter limitations

- `f2b_listClients` and `f2b_listInvoices` accept only `status[]` + pagination on the API. Search by name, date ranges, clientId filtering — do those MCP-side after fetching pages.

## What you cannot do here

- Issue invoices to other Mellow customers — F2B clients are external. For Mellow-internal flow ("oплати фрилансеру внутри Mellow"), the invoicing model is `Offer`, which is a separate (CoR-side) flow not yet exposed in this MCP.
- `individual` clients — product-disabled. Only `legal`.
- Update an invoice — there is no `f2b_updateInvoice`. Cancel and recreate.
- Run KYC for the client — verification happens on the client's payment page, not via API.

## Confirmation rule (recap)

Before any mutating call (`createClient`, `updateClient`, `archiveClient`, `createInvoiceDraft`, `sendInvoiceDraft`, `cancelInvoice`), restate the entity ID + parameters and get a clear "yes" from the user. `sendInvoiceDraft` is the most consequential call — once sent, the email is in the client's inbox and you can only `cancelInvoice` (which clients are also notified of).
```

- [ ] **Step 2: Run type check**

```bash
npm run type-check
```

Expected: no errors. (Markdown content is loaded via Wrangler text rule — verified by Task 14.)

- [ ] **Step 3: Commit**

```bash
git add docs/FREELANCER_GUIDE.md
git commit -m "docs(f2b): add freelancer guide with F2B domain, statuses, limits, two-step invariant"
```

---

## Task 16: AGENT_PRIMER opening behavior + freelancer-guide pointer

**Files:**

- Modify: `src/agent-primer.ts`

- [ ] **Step 1: Append opening behavior + role section**

Find the section in `src/agent-primer.ts` that explains "Where to read more" (it lists `mellow://domain`, `mellow://workflows`, `mellow://anti-patterns`). Append a new section ABOVE it (or just before "## Top mistakes to avoid", whichever fits the existing flow), and update the resources list:

Add this section near the top of the primer markdown (after the introduction but before tool-specific guidance):

```ts
## Session opening: identify operating mode

At the very first user message, the MCP session is configured for ONE Mellow role: customer or freelancer. The role is determined by a probe to /api/profile during OAuth and persisted in `userRole`. Tool surface differs by role.

If the visible tool surface includes \`f2b_*\` tools (createClient, createInvoiceDraft, etc.), you are in **freelancer mode**. Open with:

> "How will you use Mellow?
> – As a contractor: find new projects and receive global payments from your clients.
> – As a company: find, onboard, and pay contractors across borders."

If the user picks "as a contractor" — proceed in freelancer mode (F2B flows, invoice tools).
If the user picks "as a company" but you are in freelancer mode — explain: "this Mellow account is registered as a freelancer; for company features (hiring, paying contractors via tasks) reconnect MCP under a customer account."

Symmetric logic applies in customer mode.

Read \`mellow://freelancer-guide\` (in freelancer mode) for full F2B domain context — currency rules, two-step send invariant, status semantics, backend limits.
```

Update the existing "Where to read more" section to mention `mellow://freelancer-guide`:

```ts
Full reference is exposed as MCP resources you can read on demand:
- \`mellow://domain\` — full domain guide: actors, products, state machines, preconditions, decision trees.
- \`mellow://workflows\` — 12 end-to-end recipes (onboarding, accept-and-pay, scout hiring, multi-currency, bulk import).
- \`mellow://anti-patterns\` — full catalogue of common agent mistakes with bad/good examples.
- \`mellow://freelancer-guide\` — F2B and freelancer-side flows (only registered when userRole=freelancer).
```

- [ ] **Step 2: Run type check**

```bash
npm run type-check
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/agent-primer.ts
git commit -m "feat(primer): add session-opening behavior and mellow://freelancer-guide pointer"
```

---

## Self-review checklist (run after all 16 tasks)

- [ ] **Spec coverage:** All 9 F2B tools registered (4 clients + 5 invoices)? `userRole` probe wired in OAuth callback? Trace-id surfaced in errors? `mellow://freelancer-guide` resource registered? Primer opening behavior present? — Yes if all 16 tasks committed.

- [ ] **Type-check final pass:**

```bash
npm run type-check
```

- [ ] **Manual smoke test (preferred):**

```bash
npm run dev
```

Connect MCP Inspector under a freelancer account, run the 5 canonical flows from the design doc Section 4 (new client + invoice, existing client invoice, save draft + send later, status check, cancel + recreate). Each should complete without manual error correction.

- [ ] **Cross-task consistency:**

Verify these names are identical wherever they appear:

- `userRole: "customer" | "freelancer"` (Props, primer, init)
- `f2bCommissionPayerEnum` values: `"freelancer" | "customer"` (NOT `"client"`)
- F2B path prefix: `/freelancer/f2b/...` (no leading `/api`)
- Tool names: `f2b_createClient`, `f2b_listClients`, `f2b_updateClient`, `f2b_archiveClient`, `f2b_createInvoiceDraft`, `f2b_sendInvoiceDraft`, `f2b_getInvoice`, `f2b_listInvoices`, `f2b_cancelInvoice` (9 total).

- [ ] **Final commit (if needed):**

If any small fix-ups during self-review:

```bash
git add .
git commit -m "chore: self-review fixes for F2B freelancer invoices"
```

---

## Out of scope (deferred to future PRs)

These were intentionally not included — see design doc Section 1:

- `individual` F2B clients (product-disabled).
- `f2b_updateInvoice` (use cancel + recreate).
- F2B webhooks (backend doesn't publish — polling only).
- Customer-side "request invoice from freelancer" (backend has no endpoint).
- Bulk operations.
- Backend changeset for `X-Trace-Id` on 2xx responses.
- F2B PDF download wrapping (use existing `GET /api/files/{fileId}` via Кор tools).
