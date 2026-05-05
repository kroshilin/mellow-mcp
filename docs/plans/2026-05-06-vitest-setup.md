# Vitest + Workers Pool + MSW Setup Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bootstrap an automated test layer for `mcp_mellow` so each new tool, helper, and tool descriptor change can be verified in CI without manual MCP Inspector runs. Uses Vitest as the runner, `@cloudflare/vitest-pool-workers` to execute tests in the Workers runtime (so `fetch`, `URL`, and Workers-specific globals match production), and MSW (Mock Service Worker) to intercept outbound HTTP to `my.mellow.io` / `aiscout-api.mellow.io` for integration tests.

**Architecture:**

- **Vitest** as runner (TS-native, fast, watch mode).
- **`@cloudflare/vitest-pool-workers`** — runs tests inside `workerd`, the same V8 isolate runtime Cloudflare Workers use in prod. Catches Workers-only bugs (e.g. missing globals, isolate cold-start state issues, KV/Durable Object semantics).
- **MSW** — intercepts `fetch()` to mock backend responses. Lets us write integration tests like "agent calls `f2b_createInvoiceDraft` → MCP makes 3 sequential fetches with these bodies" without hitting a live backend.
- **Two test layers:**
  - **Unit tests** (`tests/unit/`): pure helpers, no I/O. Fast, run on every save. Examples: `currencyToId`, `mapCurrencyIdToCode`, Zod schema validation.
  - **Integration tests** (`tests/integration/`): one MCP tool end-to-end with MSW-mocked backend. Examples: "calling `f2b_listClients({status: ['active']})` results in a single `GET` to `https://my.mellow.io/api/freelancer/f2b/clients?filter[status][]=active`".
- **No live-backend tests in this PR.** Live integration belongs to Фаза 0 of the product plan (simulation harness with real stage backend).

**Tech Stack:** Vitest 2.x, `@cloudflare/vitest-pool-workers`, `msw` 2.x, TypeScript 5.9+.

**Verification:** `npm run test` (one-shot), `npm run test:watch` (TDD loop). All existing `npm run type-check` / `npm run dev` flows untouched.

---

## File Structure

**New files:**

- `vitest.config.ts` — Vitest config with Workers pool + path resolution.
- `tests/setup.ts` — global MSW server start/stop hooks.
- `tests/unit/shared.currency.test.ts` — currency mapping helpers (5 tests).
- `tests/unit/shared.schemas.test.ts` — Zod schemas validation (5 tests).
- `tests/unit/mellow-client.error.test.ts` — trace-id propagation (3 tests).
- `tests/integration/f2b-clients.test.ts` — `f2b_createClient` + `f2b_listClients` integration (4 tests).
- `tests/_msw/handlers.ts` — shared MSW handlers (per-test overrides supported).
- `tests/_msw/server.ts` — `setupServer(...handlers)` instance.

**Modified files:**

- `package.json` — add `test`, `test:watch`, `test:ui` scripts; add devDeps.
- `tsconfig.json` — extend `include` to cover `tests/`, add Vitest types.
- `.gitignore` — add Vitest cache (`node_modules/.vitest`, `coverage/`).

---

## Task 1: Install dependencies

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Install Vitest, Workers pool, MSW**

```bash
npm install -D vitest @cloudflare/vitest-pool-workers msw @types/node
```

Pin to current major versions; Workers pool tracks Vitest 2.x.

- [ ] **Step 2: Verify install**

```bash
npx vitest --version
```

Expected: prints a `2.x.x` version number, no errors.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add vitest, @cloudflare/vitest-pool-workers, msw"
```

---

## Task 2: Vitest config with Workers pool

**Files:**

- Create: `vitest.config.ts`
- Modify: `tsconfig.json`

- [ ] **Step 1: Create `vitest.config.ts`**

```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    setupFiles: ["./tests/setup.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        // Don't actually bind real KV / Durable Objects in unit-level tests;
        // integration tests that need them register their own bindings.
        miniflare: {
          // Empty — bindings come from wrangler.jsonc by default.
        },
      },
    },
  },
});
```

- [ ] **Step 2: Update `tsconfig.json` to include tests + add types**

In `tsconfig.json`, find `include` (or add it if missing) and add `"tests/**/*.ts"`. In `compilerOptions.types`, add `"@cloudflare/vitest-pool-workers"` so test files can use `cloudflare:test` import.

Concretely, the file should end up like:

```jsonc
{
  "compilerOptions": {
    // ... existing options ...
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "worker-configuration.d.ts"]
}
```

(Adjust to match the actual existing shape — only add the missing pieces.)

- [ ] **Step 3: Run type check to verify config doesn't break compilation**

```bash
npm run type-check
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts tsconfig.json
git commit -m "chore(test): add Vitest config with @cloudflare/vitest-pool-workers"
```

---

## Task 3: MSW shared server + setup hooks

**Files:**

- Create: `tests/_msw/server.ts`
- Create: `tests/_msw/handlers.ts`
- Create: `tests/setup.ts`

- [ ] **Step 1: Create `tests/_msw/handlers.ts` with default handlers**

```ts
import { http, HttpResponse } from "msw";

// Default handlers — return 404 to make it loud when a test forgot to mock
// an endpoint it actually hit. Tests override these per-case via server.use().
export const handlers = [
  http.all("https://my.mellow.io/api/*", () => {
    return new HttpResponse("MSW: no handler registered for this Mellow path", { status: 404 });
  }),
  http.all("https://aiscout-api.mellow.io/api/*", () => {
    return new HttpResponse("MSW: no handler registered for this Scout path", { status: 404 });
  }),
];
```

- [ ] **Step 2: Create `tests/_msw/server.ts`**

```ts
import { setupServer } from "msw/node";
import { handlers } from "./handlers";

export const mswServer = setupServer(...handlers);
```

- [ ] **Step 3: Create `tests/setup.ts`**

```ts
import { afterAll, afterEach, beforeAll } from "vitest";
import { mswServer } from "./_msw/server";

beforeAll(() => {
  // 'error' so unhandled requests fail loudly instead of going to the network.
  mswServer.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  mswServer.resetHandlers();
});

afterAll(() => {
  mswServer.close();
});
```

- [ ] **Step 4: Run type check**

```bash
npm run type-check
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add tests/setup.ts tests/_msw/
git commit -m "chore(test): add MSW server and global setup hooks"
```

---

## Task 4: First unit test — currency mapping (proof of life)

**Files:**

- Create: `tests/unit/shared.currency.test.ts`

- [ ] **Step 1: Write the test file**

```ts
import { describe, it, expect } from "vitest";
import {
  currencyToId,
  idToCurrency,
  mapCurrencyIdToCode,
} from "../../src/tools/f2b/shared";

describe("F2B currency mapping", () => {
  it("currencyToId maps EUR to 3 and USD to 2", () => {
    expect(currencyToId("EUR")).toBe(3);
    expect(currencyToId("USD")).toBe(2);
  });

  it("idToCurrency maps 3 to EUR, 2 to USD, unknown to undefined", () => {
    expect(idToCurrency(3)).toBe("EUR");
    expect(idToCurrency(2)).toBe("USD");
    expect(idToCurrency(999)).toBeUndefined();
  });

  it("mapCurrencyIdToCode replaces currencyId with currency in flat objects", () => {
    const input = { clientId: 42, currencyId: 3, status: "active" };
    const output = mapCurrencyIdToCode(input);
    expect(output).toEqual({ clientId: 42, currency: "EUR", status: "active" });
    // Original unchanged
    expect(input).toEqual({ clientId: 42, currencyId: 3, status: "active" });
  });

  it("mapCurrencyIdToCode recurses into arrays and nested objects", () => {
    const input = {
      items: [
        { clientId: 1, currencyId: 3 },
        { clientId: 2, currencyId: 2 },
      ],
      meta: { nested: { currencyId: 3 } },
    };
    const output = mapCurrencyIdToCode(input);
    expect(output).toEqual({
      items: [
        { clientId: 1, currency: "EUR" },
        { clientId: 2, currency: "USD" },
      ],
      meta: { nested: { currency: "EUR" } },
    });
  });

  it("mapCurrencyIdToCode passes through unknown currencyId", () => {
    expect(mapCurrencyIdToCode({ currencyId: 999 })).toEqual({ currency: 999 });
  });
});
```

- [ ] **Step 2: Add `test` and `test:watch` scripts to `package.json`**

In `package.json` `"scripts"` block:

```jsonc
{
  "scripts": {
    "deploy": "wrangler deploy",
    "dev": "wrangler dev",
    "start": "wrangler dev",
    "cf-typegen": "wrangler types",
    "type-check": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 3: Run tests**

```bash
npm run test
```

Expected: 5 passing tests.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/shared.currency.test.ts package.json
git commit -m "test(f2b): unit tests for currency mapping helpers"
```

---

## Task 5: Unit tests for Zod schemas

**Files:**

- Create: `tests/unit/shared.schemas.test.ts`

- [ ] **Step 1: Write the test file**

```ts
import { describe, it, expect } from "vitest";
import {
  f2bCurrencyEnum,
  f2bClientStatusEnum,
  f2bMeasureEnum,
  f2bCommissionPayerEnum,
  f2bLineItemSchema,
} from "../../src/tools/f2b/shared";

describe("F2B Zod schemas", () => {
  it("currency enum accepts only EUR and USD", () => {
    expect(f2bCurrencyEnum.safeParse("EUR").success).toBe(true);
    expect(f2bCurrencyEnum.safeParse("USD").success).toBe(true);
    expect(f2bCurrencyEnum.safeParse("RUB").success).toBe(false);
    expect(f2bCurrencyEnum.safeParse("eur").success).toBe(false);
  });

  it("client status enum covers exactly 6 values", () => {
    const valid = [
      "not_verified",
      "verification_in_progress",
      "verification_failed",
      "active",
      "archived",
      "suspended",
    ];
    for (const v of valid) {
      expect(f2bClientStatusEnum.safeParse(v).success).toBe(true);
    }
    expect(f2bClientStatusEnum.safeParse("pending").success).toBe(false);
  });

  it("measure enum covers exactly 10 values", () => {
    const valid = [
      "item",
      "hour",
      "day",
      "week",
      "month",
      "kg",
      "ton",
      "liter",
      "cubic_meter",
      "km",
    ];
    for (const v of valid) {
      expect(f2bMeasureEnum.safeParse(v).success).toBe(true);
    }
    expect(f2bMeasureEnum.safeParse("piece").success).toBe(false);
  });

  it("commissionPayer enum: freelancer / customer only (lowercase, NOT 'client')", () => {
    expect(f2bCommissionPayerEnum.safeParse("freelancer").success).toBe(true);
    expect(f2bCommissionPayerEnum.safeParse("customer").success).toBe(true);
    expect(f2bCommissionPayerEnum.safeParse("client").success).toBe(false);
    expect(f2bCommissionPayerEnum.safeParse("Customer").success).toBe(false);
  });

  it("lineItem schema enforces backend constraints", () => {
    const valid = { name: "Design", quantity: 1, measure: "item", price: 100 };
    expect(f2bLineItemSchema.safeParse(valid).success).toBe(true);

    expect(f2bLineItemSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
    expect(f2bLineItemSchema.safeParse({ ...valid, quantity: 0 }).success).toBe(false);
    expect(f2bLineItemSchema.safeParse({ ...valid, price: -1 }).success).toBe(false);
    expect(f2bLineItemSchema.safeParse({ ...valid, measure: "piece" }).success).toBe(false);
    expect(f2bLineItemSchema.safeParse({ ...valid, name: "x".repeat(1025) }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npm run test
```

Expected: 10 passing total (5 new + 5 from Task 4).

- [ ] **Step 3: Commit**

```bash
git add tests/unit/shared.schemas.test.ts
git commit -m "test(f2b): unit tests for Zod schemas"
```

---

## Task 6: Unit test for trace-id in MellowClient errors

**Files:**

- Create: `tests/unit/mellow-client.error.test.ts`

- [ ] **Step 1: Write the test file**

```ts
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { http, HttpResponse } from "msw";
import { mswServer } from "../_msw/server";
import { createMellowClient } from "../../src/mellow-client";

describe("MellowClient error trace-id propagation", () => {
  it("includes [trace=...] when X-Trace-Id is present", async () => {
    mswServer.use(
      http.get("https://my.mellow.io/api/customer/test", () => {
        return new HttpResponse("nope", {
          status: 500,
          headers: { "X-Trace-Id": "trace-abc-123" },
        });
      }),
    );
    const client = createMellowClient("https://my.mellow.io/api", "fake-token");
    await expect(client.get("/customer/test")).rejects.toThrow(
      /\[trace=trace-abc-123\]/,
    );
  });

  it("falls back to [cf-ray=...] when only cf-ray is present", async () => {
    mswServer.use(
      http.get("https://my.mellow.io/api/customer/test", () => {
        return new HttpResponse("nope", {
          status: 502,
          headers: { "cf-ray": "789abc-DME" },
        });
      }),
    );
    const client = createMellowClient("https://my.mellow.io/api", "fake-token");
    await expect(client.get("/customer/test")).rejects.toThrow(
      /\[cf-ray=789abc-DME\]/,
    );
  });

  it("omits trace suffix when neither header is present", async () => {
    mswServer.use(
      http.get("https://my.mellow.io/api/customer/test", () => {
        return new HttpResponse("plain error", { status: 422 });
      }),
    );
    const client = createMellowClient("https://my.mellow.io/api", "fake-token");
    await expect(client.get("/customer/test")).rejects.toThrow(
      /failed \(422\): plain error$/,
    );
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npm run test
```

Expected: 13 passing total.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/mellow-client.error.test.ts
git commit -m "test(client): unit tests for trace-id propagation in error messages"
```

---

## Task 7: Integration test — `f2b_createClient` + `f2b_listClients`

**Files:**

- Create: `tests/integration/f2b-clients.test.ts`

This is the proof that Vitest + Workers pool + MSW work end-to-end on a real MCP tool path. We don't go through the MCP SDK (that requires a full server boot); we test the tool handler directly by calling its register function with a mocked `McpServer` that captures handlers.

- [ ] **Step 1: Write the test file**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { mswServer } from "../_msw/server";
import { createMellowClient } from "../../src/mellow-client";
import { registerF2bClientTools } from "../../src/tools/f2b/clients";

// Minimal McpServer stub — captures the tool handler so we can invoke it.
function makeServerStub() {
  const tools = new Map<string, (params: unknown) => Promise<unknown>>();
  return {
    tool(name: string, _desc: string, _schema: unknown, _opts: unknown, handler: (params: unknown) => Promise<unknown>) {
      tools.set(name, handler);
    },
    invoke(name: string, params: unknown) {
      const h = tools.get(name);
      if (!h) throw new Error(`Tool not registered: ${name}`);
      return h(params);
    },
  };
}

describe("F2B client tools — integration", () => {
  let server: ReturnType<typeof makeServerStub>;

  beforeEach(() => {
    server = makeServerStub();
    const client = createMellowClient("https://my.mellow.io/api", "fake-jwt");
    registerF2bClientTools(server as never, client);
  });

  it("f2b_createClient sends correct body and maps currencyId in response", async () => {
    let capturedBody: unknown = null;
    mswServer.use(
      http.post("https://my.mellow.io/api/freelancer/f2b/clients/legal", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          clientId: 42,
          type: "legal",
          currencyId: 3,
          status: "not_verified",
          email: "test@acme.com",
          country: "CY",
          companyName: "Acme",
        });
      }),
    );

    const result = (await server.invoke("f2b_createClient", {
      email: "test@acme.com",
      country: "CY",
      currency: "EUR",
      companyName: "Acme",
    })) as { structuredContent: Record<string, unknown> };

    expect(capturedBody).toMatchObject({
      email: "test@acme.com",
      country: "CY",
      currencyId: 3,
      companyName: "Acme",
    });
    expect(result.structuredContent.currency).toBe("EUR");
    expect(result.structuredContent).not.toHaveProperty("currencyId");
  });

  it("f2b_listClients with no status filter sends bare GET", async () => {
    let capturedUrl: string | null = null;
    mswServer.use(
      http.get("https://my.mellow.io/api/freelancer/f2b/clients", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ items: [], pagination: { page: 1, total: 0 } });
      }),
    );

    await server.invoke("f2b_listClients", {});

    expect(capturedUrl).toBe("https://my.mellow.io/api/freelancer/f2b/clients");
  });

  it("f2b_listClients with multi-value status sends bracketed query param", async () => {
    let capturedUrl: string | null = null;
    mswServer.use(
      http.get("https://my.mellow.io/api/freelancer/f2b/clients", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ items: [], pagination: { page: 1, total: 0 } });
      }),
    );

    await server.invoke("f2b_listClients", { status: ["active", "not_verified"] });

    expect(capturedUrl).toContain("filter%5Bstatus%5D%5B%5D=active");
    expect(capturedUrl).toContain("filter%5Bstatus%5D%5B%5D=not_verified");
  });

  it("f2b_listClients maps currencyId to currency in items", async () => {
    mswServer.use(
      http.get("https://my.mellow.io/api/freelancer/f2b/clients", () => {
        return HttpResponse.json({
          items: [
            { clientId: 1, currencyId: 3, status: "active" },
            { clientId: 2, currencyId: 2, status: "not_verified" },
          ],
          pagination: { page: 1, total: 2 },
        });
      }),
    );

    const result = (await server.invoke("f2b_listClients", {})) as {
      structuredContent: { items: Array<{ currency: string }> };
    };

    expect(result.structuredContent.items[0].currency).toBe("EUR");
    expect(result.structuredContent.items[1].currency).toBe("USD");
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npm run test
```

Expected: 17 passing total (13 unit + 4 integration).

- [ ] **Step 3: Commit**

```bash
git add tests/integration/f2b-clients.test.ts
git commit -m "test(f2b): integration tests for createClient + listClients via MSW"
```

---

## Task 8: Update .gitignore + README pointer

**Files:**

- Modify: `.gitignore`
- Modify: `CLAUDE.md` (one line in Conventions)

- [ ] **Step 1: Add Vitest cache to `.gitignore`**

Append to `.gitignore`:

```
# Vitest
node_modules/.vitest/
coverage/
```

- [ ] **Step 2: Update CLAUDE.md to mention the test layer**

In the `## Conventions` section of `CLAUDE.md`, find the line about "No test framework is configured" and replace it:

Old:

```
- No test framework is configured. `npm run type-check` is the only automated gate.
```

New:

```
- Vitest + `@cloudflare/vitest-pool-workers` is the test framework (`npm run test`, `npm run test:watch`). Tests live under `tests/` (unit + integration via MSW). `npm run type-check` is still the type gate. Live-backend tests don't exist — that's the simulation harness territory.
```

- [ ] **Step 3: Final type-check + test pass**

```bash
npm run type-check
npm run test
```

Both expected to pass.

- [ ] **Step 4: Commit**

```bash
git add .gitignore CLAUDE.md
git commit -m "docs: update CLAUDE.md to reflect Vitest test layer; add Vitest cache to gitignore"
```

---

## Self-review checklist

- [ ] **All 8 tasks committed.**
- [ ] `npm run test` green: 17 passing tests across 4 files.
- [ ] `npm run type-check` green.
- [ ] No new untracked files in `src/` (only `tests/`, `vitest.config.ts`, modified `package.json`/`tsconfig.json`/`CLAUDE.md`/`.gitignore`).
- [ ] CI integration NOT in scope here — separate PR if/when GitHub Actions is set up.

---

## What this enables for slice 2

- Each new F2B tool in slice 2 (`updateClient`, `archiveClient`, 5 invoice tools) gets:
  - 2–3 unit tests on its Zod schema in `tests/unit/`.
  - 2–3 MSW integration tests in `tests/integration/` covering happy path + 1 error path.
- The composite `f2b_createInvoiceDraft` (3 sequential fetches: getClient → calculate-cost → POST /v2/invoices) gets a test that asserts the call sequence + body shapes — without this, that composite is the most likely thing to silently regress.
- Slice 2 PR description should add `npm run test` to its verification block.

---

## Out of scope (deferred)

- **CI/CD integration** (GitHub Actions running `npm run test` on PRs) — separate PR after this lands.
- **Coverage gates** (`vitest --coverage` thresholds) — start collecting numbers, set thresholds after a few PRs once we know the baseline.
- **Live-backend integration tests** — that's the Phase 0 simulation harness in the product plan, runs against staging with real test data. Different infra.
- **End-to-end MCP protocol tests** (booting a real MCP server, calling via the SDK client) — not blocked on this, but the integration approach used here (handler-direct via mocked `McpServer`) is sufficient for tool-level regression coverage.
