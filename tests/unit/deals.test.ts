import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerSecureDealTools } from "../../src/tools/f2b/deals";

// Contract tests for the Secure Deal tools: stub McpServer to capture handlers
// (+ description and Zod shape), stub MellowClient to record method/path/body
// and answer from a scripted map. Locks in paths, methods, body shapes and
// the call sequence of every composite tool.

type CapturedCall = { method: string; path: string; body?: unknown };
type Handler = (params: unknown) => Promise<unknown>;
type ToolResult = { structuredContent: Record<string, unknown>; content: Array<{ type: string; text: string }> };

function makeServerStub() {
  const tools = new Map<string, { description: string; shape: z.ZodRawShape; handler: Handler }>();
  const server = {
    tool(name: string, description: string, shape: z.ZodRawShape, _annotations: unknown, handler: Handler) {
      tools.set(name, { description, shape, handler });
    },
  } as unknown as McpServer;
  const get = (name: string) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`tool not registered: ${name}`);
    return tool;
  };
  return {
    server,
    names: () => [...tools.keys()],
    description: (name: string) => get(name).description,
    schema: (name: string) => z.object(get(name).shape),
    invoke: (name: string, params: unknown) => get(name).handler(params) as Promise<ToolResult>,
  };
}

/** Responses keyed by "<METHOD> <path-prefix>"; longest prefix wins; a function value receives the path. */
function makeClientStub(responses: Record<string, unknown>) {
  const calls: CapturedCall[] = [];
  const respond = (method: string, path: string) => {
    const key = Object.keys(responses)
      .filter((k) => {
        const [m, p] = k.split(" ");
        return m === method && path.startsWith(p);
      })
      .sort((a, b) => b.length - a.length)[0];
    if (!key) throw new Error(`no scripted response for ${method} ${path}; available: ${Object.keys(responses).join(", ")}`);
    const value = responses[key];
    return typeof value === "function" ? (value as (p: string) => unknown)(path) : value;
  };
  const record = (method: string) => async (path: string, body?: unknown) => {
    calls.push(body === undefined ? { method, path } : { method, path, body });
    return respond(method, path);
  };
  const stub = { get: record("GET"), post: record("POST"), put: record("PUT"), patch: record("PATCH"), del: record("DELETE") };
  return { stub, calls };
}

function setup(responses: Record<string, unknown>) {
  const { stub, calls } = makeClientStub(responses);
  const srv = makeServerStub();
  registerSecureDealTools(srv.server, stub as never);
  return { ...srv, calls };
}

const daysFromToday = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const FUTURE = daysFromToday(30);
const PAST = "2020-01-15";

const DEALS = "/v2/freelancer/secure-deals";

/** A DealDetail as GET /v2/freelancer/secure-deals/{id} returns it (relevant fields only). */
function dealDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: 77,
    number: "SD-0077",
    status: "new",
    source: "f2b",
    amount: 1000,
    currency: { currency: "EUR", id: 3 },
    commissionPayer: "customer",
    service: { id: 12, title: "Design" },
    serviceName: "Design",
    serviceDeadline: `${FUTURE}T23:59:59+00:00`,
    acquiringEnabled: true,
    paymentStatus: null,
    lineItems: [{ name: "Logo", quantity: 2, measure: "item", price: 500, total: 1000 }],
    possiblePayments: [{ type: "bank", received: 1000, cost: 1050 }],
    client: { id: 42, email: "client@acme.test" },
    ...overrides,
  };
}

const lineItem = { name: "Logo design", quantity: 1, measure: "item" as const, price: 800 };

describe("registerSecureDealTools", () => {
  it("registers exactly the agreed tool names", () => {
    const { names } = setup({});
    expect(names().sort()).toEqual(
      [
        "deal_cancel",
        "deal_create",
        "deal_duplicate",
        "deal_get",
        "deal_list",
        "deal_remind",
        "deal_send",
        "deal_summary",
        "deal_update",
        "f2b_createClientFromCompany",
        "f2b_createIndividualClient",
        "f2b_searchClients",
      ].sort(),
    );
  });

  it("client-visible and destructive tools demand confirmation restating number, client and amount", () => {
    const { description } = setup({});
    for (const tool of ["deal_send", "deal_cancel", "deal_update"]) {
      expect(description(tool)).toMatch(/confirm with the user first/i);
      expect(description(tool)).toMatch(/deal number, client and amount/);
    }
  });

  it("deal_remind demands a two-step confirmation naming the client and the email address", () => {
    const { description } = setup({});
    const text = description("deal_remind");
    expect(text).toMatch(/WITHOUT `confirmed`/);
    expect(text).toMatch(/naming the client and the email address/);
    expect(text).toMatch(/confirmed: true/);
  });

  it("deal_get points the agent at possiblePayments and rejectMessage and forbids computing fees", () => {
    const { description } = setup({});
    const text = description("deal_get");
    expect(text).toMatch(/possiblePayments/);
    expect(text).toMatch(/`received` = what the freelancer gets/);
    expect(text).toMatch(/`cost` = what the client pays/);
    expect(text).toMatch(/rejectMessage/);
    expect(text).toMatch(/NEVER compute/);
  });
});

describe("deal_create (composite)", () => {
  const responses = {
    "GET /freelancer/f2b/clients/42": { id: 42, status: "not_verified", currency: { currency: "USD", id: 2 } },
    [`POST ${DEALS}`]: { id: 77, number: "SD-0077", status: "new" },
    [`GET ${DEALS}/77`]: dealDetail(),
  };
  const input = {
    clientId: 42,
    serviceId: 12,
    serviceName: "Design",
    serviceDeadline: FUTURE,
    lineItems: [lineItem],
    commissionPayer: "customer",
  };

  it("GET client → POST deal with the client's currency → GET the new deal's breakdown", async () => {
    const { invoke, calls } = setup(responses);
    const result = await invoke("deal_create", input);

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /freelancer/f2b/clients/42", `POST ${DEALS}`, `GET ${DEALS}/77`]);
    expect(calls[1].body).toEqual({
      clientId: 42,
      currencyId: 2,
      commissionPayer: "customer",
      serviceId: 12,
      serviceName: "Design",
      serviceDeadline: FUTURE,
      lineItems: [lineItem],
      acquiringEnabled: false,
    });
    const deal = result.structuredContent.deal as Record<string, unknown>;
    expect(deal.possiblePayments).toEqual([{ type: "bank", received: 1000, cost: 1050 }]);
    expect(deal.currency).toBe("EUR");
    expect(result.structuredContent.notes).toEqual(expect.arrayContaining([expect.stringMatching(/deal_send/)]));
  });

  it("forwards promoCode and acquiringEnabled only when given", async () => {
    const { invoke, calls } = setup(responses);
    await invoke("deal_create", { ...input, promoCode: "SPRING", acquiringEnabled: true });
    const body = calls[1].body as Record<string, unknown>;
    expect(body.promoCode).toBe("SPRING");
    expect(body.acquiringEnabled).toBe(true);
  });

  it("rejects a deadline that is not after today before any HTTP call", async () => {
    const { invoke, calls } = setup(responses);
    await expect(invoke("deal_create", { ...input, serviceDeadline: PAST })).rejects.toThrow(/after today/);
    expect(calls).toHaveLength(0);
  });

  it("refuses an archived client without POSTing", async () => {
    const { invoke, calls } = setup({
      ...responses,
      "GET /freelancer/f2b/clients/42": { id: 42, status: "archived", currency: { currency: "EUR", id: 3 } },
    });
    await expect(invoke("deal_create", input)).rejects.toThrow(/archived/);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("still returns the created deal when the breakdown read fails", async () => {
    const { invoke } = setup({
      ...responses,
      [`GET ${DEALS}/77`]: () => {
        throw new Error("boom");
      },
    });
    const result = await invoke("deal_create", input);
    expect((result.structuredContent.deal as Record<string, unknown>).id).toBe(77);
    expect(result.structuredContent.notes).toEqual(expect.arrayContaining([expect.stringMatching(/deal_get/)]));
  });

  it("schema: 1–10 line items, YYYY-MM-DD deadline, no currency/clientType fields", () => {
    const { schema } = setup({});
    const s = schema("deal_create");
    expect(s.safeParse(input).success).toBe(true);
    expect(s.safeParse({ ...input, lineItems: Array(11).fill(lineItem) }).success).toBe(false);
    expect(s.safeParse({ ...input, lineItems: [] }).success).toBe(false);
    expect(s.safeParse({ ...input, serviceDeadline: "15.01.2027" }).success).toBe(false);
    expect(Object.keys(s.shape)).not.toContain("currency");
  });
});

describe("deal_send", () => {
  it("GET (status new) → POST /send with {} → GET refreshed deal", async () => {
    const detail = { ...dealDetail(), status: "sent" };
    const { invoke, calls } = setup({
      [`GET ${DEALS}/77`]: (() => {
        let n = 0;
        return () => (n++ === 0 ? dealDetail() : detail);
      })(),
      [`POST ${DEALS}/77/send`]: [],
    });
    const result = await invoke("deal_send", { dealId: 77 });
    expect(calls).toEqual([
      { method: "GET", path: `${DEALS}/77` },
      { method: "POST", path: `${DEALS}/77/send`, body: {} },
      { method: "GET", path: `${DEALS}/77` },
    ]);
    expect((result.structuredContent.deal as Record<string, unknown>).status).toBe("sent");
  });

  it("refuses a deal that is not new", async () => {
    const { invoke, calls } = setup({ [`GET ${DEALS}/77`]: dealDetail({ status: "sent" }) });
    await expect(invoke("deal_send", { dealId: 77 })).rejects.toThrow(/status is 'sent'/);
    expect(calls).toHaveLength(1);
  });
});

describe("deal_update (composite merge)", () => {
  it("GET → PUT full payload merged from the stored deal → GET", async () => {
    const { invoke, calls } = setup({
      [`GET ${DEALS}/77`]: dealDetail(),
      [`PUT ${DEALS}/77`]: [],
    });
    const newDeadline = daysFromToday(60);
    await invoke("deal_update", { dealId: 77, serviceDeadline: newDeadline });

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${DEALS}/77`, `PUT ${DEALS}/77`, `GET ${DEALS}/77`]);
    expect(calls[1].body).toEqual({
      dealId: 77,
      lineItems: [{ name: "Logo", quantity: 2, measure: "item", price: 500 }], // stored `total` stripped
      currencyId: 3, // from the deal's nested currency
      commissionPayer: "customer",
      serviceId: 12, // from deal.service.id
      serviceName: "Design",
      serviceDeadline: newDeadline,
      acquiringEnabled: true,
    });
  });

  it("keeps the stored deadline as YYYY-MM-DD when not changed and replaces line items wholesale", async () => {
    const { invoke, calls } = setup({ [`GET ${DEALS}/77`]: dealDetail(), [`PUT ${DEALS}/77`]: [] });
    await invoke("deal_update", { dealId: 77, lineItems: [lineItem], commissionPayer: "freelancer" });
    const body = calls[1].body as Record<string, unknown>;
    expect(body.serviceDeadline).toBe(FUTURE);
    expect(body.lineItems).toEqual([lineItem]);
    expect(body.commissionPayer).toBe("freelancer");
  });

  it("explains the client email when editing a sent deal and the resend when editing a rejected one", async () => {
    const sent = setup({ [`GET ${DEALS}/77`]: dealDetail({ status: "sent" }), [`PUT ${DEALS}/77`]: [] });
    const sentResult = await sent.invoke("deal_update", { dealId: 77, acquiringEnabled: false });
    expect(JSON.stringify(sentResult.structuredContent.notes)).toMatch(/client is emailed/);

    const rejected = setup({ [`GET ${DEALS}/77`]: dealDetail({ status: "rejected" }), [`PUT ${DEALS}/77`]: [] });
    const rejectedResult = await rejected.invoke("deal_update", { dealId: 77, acquiringEnabled: false });
    expect(JSON.stringify(rejectedResult.structuredContent.notes)).toMatch(/deal_send/);
  });

  it.each([
    ["status in_work", dealDetail({ status: "in_work" }), { acquiringEnabled: false }, /status is 'in_work'/],
    ["card hold authorized", dealDetail({ status: "sent", paymentStatus: "authorized" }), { acquiringEnabled: false }, /locked/],
    ["serviceId without serviceName", dealDetail(), { serviceId: 99 }, /serviceName/],
    ["nothing to change", dealDetail(), {}, /Nothing to update/],
    [
      "stale stored deadline",
      dealDetail({ serviceDeadline: `${PAST}T23:59:59+00:00` }),
      { acquiringEnabled: false },
      /new serviceDeadline/,
    ],
  ])("refuses without PUT: %s", async (_label, detail, change, error) => {
    const { invoke, calls } = setup({ [`GET ${DEALS}/77`]: detail, [`PUT ${DEALS}/77`]: [] });
    await expect(invoke("deal_update", { dealId: 77, ...change })).rejects.toThrow(error);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  it("schema: client and currency are not editable", () => {
    const { schema } = setup({});
    const keys = Object.keys(schema("deal_update").shape);
    expect(keys).not.toContain("clientId");
    expect(keys).not.toContain("currency");
    expect(keys).not.toContain("promoCode");
  });
});

describe("deal_duplicate (cabinet-style prefill)", () => {
  const NEW_DEADLINE = daysFromToday(45);

  it("GET original → GET client → POST a new deal without the old deadline or card flag → GET the copy", async () => {
    const { invoke, calls } = setup({
      [`GET ${DEALS}/77`]: dealDetail(),
      ["GET /freelancer/f2b/clients/42"]: { id: 42, status: "active", currency: { id: 3 } },
      [`POST ${DEALS}`]: { id: 78, number: "SD-0078", status: "new" },
      [`GET ${DEALS}/78`]: dealDetail({ id: 78, number: "SD-0078", serviceDeadline: `${NEW_DEADLINE}T23:59:59+00:00` }),
    });
    const result = await invoke("deal_duplicate", { dealId: 77, serviceDeadline: NEW_DEADLINE });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET ${DEALS}/77`,
      "GET /freelancer/f2b/clients/42",
      `POST ${DEALS}`,
      `GET ${DEALS}/78`,
    ]);
    expect(calls[2].body).toEqual({
      clientId: 42,
      currencyId: 3,
      commissionPayer: "customer",
      serviceId: 12,
      serviceName: "Design",
      serviceDeadline: NEW_DEADLINE,
      lineItems: [{ name: "Logo", quantity: 2, measure: "item", price: 500 }],
      acquiringEnabled: false,
    });
    expect(calls.some((c) => c.path.endsWith("/duplicate"))).toBe(false);
    expect((result.structuredContent.deal as Record<string, unknown>).id).toBe(78);
    expect(JSON.stringify(result.structuredContent.notes)).toMatch(/original is unchanged/);
  });

  it("requires a new deadline: the schema rejects a call without one and the handler rejects a past date before any HTTP", async () => {
    const { invoke, calls, schema } = setup({});
    expect(schema("deal_duplicate").safeParse({ dealId: 77 }).success).toBe(false);
    await expect(invoke("deal_duplicate", { dealId: 77, serviceDeadline: PAST })).rejects.toThrow(/must be after today/);
    expect(calls).toHaveLength(0);
  });

  it("applies overrides: another client (its currency), new items, fee payer and card flag", async () => {
    const { invoke, calls } = setup({
      [`GET ${DEALS}/77`]: dealDetail(),
      ["GET /freelancer/f2b/clients/50"]: { id: 50, status: "not_verified", currency: { id: 2 } },
      [`POST ${DEALS}`]: { id: 79 },
      [`GET ${DEALS}/79`]: dealDetail({ id: 79 }),
    });
    await invoke("deal_duplicate", {
      dealId: 77,
      serviceDeadline: NEW_DEADLINE,
      clientId: 50,
      lineItems: [lineItem],
      commissionPayer: "freelancer",
      acquiringEnabled: true,
    });
    expect(calls[2].body).toMatchObject({
      clientId: 50,
      currencyId: 2,
      commissionPayer: "freelancer",
      lineItems: [lineItem],
      acquiringEnabled: true,
    });
  });

  it("rejects serviceName without serviceId (and vice versa) before creating anything", async () => {
    const { invoke, calls } = setup({ [`GET ${DEALS}/77`]: dealDetail(), ["GET /freelancer/f2b/clients/42"]: { id: 42, status: "active", currency: { id: 3 } } });
    await expect(invoke("deal_duplicate", { dealId: 77, serviceDeadline: NEW_DEADLINE, serviceName: "Copywriting" })).rejects.toThrow(
      /serviceId and serviceName together/,
    );
    await expect(invoke("deal_duplicate", { dealId: 77, serviceDeadline: NEW_DEADLINE, serviceId: 5 })).rejects.toThrow(/together/);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("notes when the new client has a different currency", async () => {
    const { invoke } = setup({
      [`GET ${DEALS}/77`]: dealDetail(),
      ["GET /freelancer/f2b/clients/50"]: { id: 50, status: "active", currency: { id: 2 } },
      [`POST ${DEALS}`]: { id: 80 },
      [`GET ${DEALS}/80`]: dealDetail({ id: 80 }),
    });
    const result = await invoke("deal_duplicate", { dealId: 77, serviceDeadline: NEW_DEADLINE, clientId: 50 });
    expect(JSON.stringify(result.structuredContent.notes)).toMatch(/different currency \(USD instead of EUR\)/);
  });

  it("description says the deadline and the card flag are not copied", () => {
    const { description } = setup({});
    const text = description("deal_duplicate");
    expect(text).toMatch(/NOT copied/);
    expect(text).toMatch(/never reuse the old one/);
  });
});

describe("deal_get / deal_list", () => {
  it("deal_get GETs the deal and flattens currency", async () => {
    const { invoke, calls } = setup({ [`GET ${DEALS}/77`]: dealDetail() });
    const result = await invoke("deal_get", { dealId: 77 });
    expect(calls).toEqual([{ method: "GET", path: `${DEALS}/77` }]);
    expect(result.structuredContent.currency).toBe("EUR");
  });

  it("deal_list builds repeated filter[status][] plus search, paging and sort", async () => {
    const { invoke, calls } = setup({ [`GET ${DEALS}`]: { items: [], pagination: { total: 0 } } });
    await invoke("deal_list", {
      status: ["sent", "in_work"],
      search: "SD-0077",
      page: 2,
      size: 50,
      sort: "amount",
      direction: "asc",
    });
    const url = new URL(`https://x${calls[0].path}`);
    expect(url.pathname).toBe(DEALS);
    expect(url.searchParams.getAll("filter[status][]")).toEqual(["sent", "in_work"]);
    expect(url.searchParams.get("filter[search]")).toBe("SD-0077");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("size")).toBe("50");
    expect(url.searchParams.get("sort")).toBe("amount");
    expect(url.searchParams.get("direction")).toBe("asc");
  });

  it("deal_list without params sends no query string; size is capped at 500 by the schema", async () => {
    const { invoke, calls, schema } = setup({ [`GET ${DEALS}`]: { items: [] } });
    await invoke("deal_list", {});
    expect(calls[0].path).toBe(DEALS);
    expect(schema("deal_list").safeParse({ size: 501 }).success).toBe(false);
  });
});

describe("deal_remind / deal_cancel", () => {
  it("deal_remind without confirmed: previews the recipient and sends nothing", async () => {
    const { invoke, calls } = setup({
      [`GET ${DEALS}/77`]: dealDetail({ status: "sent", client: { id: 42, email: "client@acme.test", companyName: "Acme Ltd" } }),
    });
    const result = await invoke("deal_remind", { dealId: 77 });
    expect(calls).toEqual([{ method: "GET", path: `${DEALS}/77` }]);
    expect(result.structuredContent).toMatchObject({
      sent: false,
      preview: { number: "SD-0077", amount: 1000, currency: "EUR", recipient: { name: "Acme Ltd", email: "client@acme.test" } },
    });
    expect(JSON.stringify(result.structuredContent.notes)).toMatch(/Acme Ltd at client@acme.test/);
  });

  it("deal_remind confirmed with a recipient that no longer matches is refused without sending", async () => {
    const { invoke, calls } = setup({ [`GET ${DEALS}/77`]: dealDetail({ status: "sent" }) });
    await expect(invoke("deal_remind", { dealId: 77, confirmed: true, recipientEmail: "old@acme.test" })).rejects.toThrow(
      /does not match the deal's current client email \(client@acme.test\)/,
    );
    await expect(invoke("deal_remind", { dealId: 77, confirmed: true })).rejects.toThrow(/does not match/);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("deal_remind with confirmed: true and the previewed email → GET (sent) → POST /remind with {}", async () => {
    const { invoke, calls } = setup({ [`GET ${DEALS}/77`]: dealDetail({ status: "sent" }), [`POST ${DEALS}/77/remind`]: [] });
    const result = await invoke("deal_remind", { dealId: 77, confirmed: true, recipientEmail: "Client@Acme.test" });
    expect(calls).toEqual([
      { method: "GET", path: `${DEALS}/77` },
      { method: "POST", path: `${DEALS}/77/remind`, body: {} },
    ]);
    expect(result.structuredContent).toMatchObject({ sent: true, number: "SD-0077", recipient: { email: "client@acme.test" } });
  });

  it("deal_remind refuses a draft even when confirmed", async () => {
    const { invoke, calls } = setup({ [`GET ${DEALS}/77`]: dealDetail({ status: "new" }) });
    await expect(invoke("deal_remind", { dealId: 77, confirmed: true, recipientEmail: "client@acme.test" })).rejects.toThrow(/status is 'new'/);
    expect(calls).toHaveLength(1);
  });

  it("deal_cancel: GET (new|sent) → POST /cancel with {}; client is not notified", async () => {
    const { invoke, calls } = setup({ [`GET ${DEALS}/77`]: dealDetail({ status: "sent" }), [`POST ${DEALS}/77/cancel`]: [] });
    const result = await invoke("deal_cancel", { dealId: 77 });
    expect(calls).toEqual([
      { method: "GET", path: `${DEALS}/77` },
      { method: "POST", path: `${DEALS}/77/cancel`, body: {} },
    ]);
    expect(result.structuredContent).toMatchObject({ previousStatus: "sent", status: "cancelled", clientNotified: false });
  });

  it("deal_cancel refuses a funded deal", async () => {
    const { invoke, calls } = setup({ [`GET ${DEALS}/77`]: dealDetail({ status: "in_work" }) });
    await expect(invoke("deal_cancel", { dealId: 77 })).rejects.toThrow(/status is 'in_work'/);
    expect(calls).toHaveLength(1);
  });
});

describe("deal_summary (composite)", () => {
  const row = (status: string | null, amount: number, currencyId: number, source = "f2b") => ({
    status,
    amount,
    currency: { currency: currencyId === 3 ? "EUR" : currencyId === 2 ? "USD" : "RUB", id: currencyId },
    source,
  });

  it("combines widget counts with per-currency totals paged from the list", async () => {
    const pages: Record<string, unknown> = {
      "1": { items: [row("sent", 100, 3), row("in_work", 50.5, 2), row(null, 999, 1, "offer")], pagination: { total: 4, pages: 2 } },
      "2": { items: [row("sent", 200.25, 3)], pagination: { total: 4, pages: 2 } },
    };
    const { invoke, calls } = setup({
      "GET /freelancer/widgets/deals": [
        { status: "sent", count: 2 },
        { status: "in_work", count: 1 },
      ],
      [`GET ${DEALS}?`]: (path: string) => pages[new URL(`https://x${path}`).searchParams.get("page") ?? ""],
    });
    const result = await invoke("deal_summary", {});

    expect(calls.map((c) => c.path)).toEqual(["/freelancer/widgets/deals", `${DEALS}?page=1&size=500`, `${DEALS}?page=2&size=500`]);
    const s = result.structuredContent;
    expect(s.totalDeals).toBe(3);
    expect(s.totalsByCurrency).toEqual({ EUR: { count: 2, amount: 300.25 }, USD: { count: 1, amount: 50.5 } });
    expect(s.byStatus).toEqual({
      sent: { count: 2, totalsByCurrency: { EUR: 300.25 } },
      in_work: { count: 1, totalsByCurrency: { USD: 50.5 } },
    });
    expect(s.legacyOffers).toEqual({ count: 1, totalsByCurrency: { RUB: 999 } });
    expect(s.scanned).toEqual({ rows: 4, totalRows: 4, pagesFetched: 2, complete: true });
  });

  it("stops after 5 pages and reports the scan as incomplete", async () => {
    const { invoke, calls } = setup({
      "GET /freelancer/widgets/deals": [],
      [`GET ${DEALS}?`]: { items: [row("sent", 1, 3)], pagination: { total: 4000, pages: 8 } },
    });
    const result = await invoke("deal_summary", {});
    expect(calls.filter((c) => c.path.startsWith(DEALS))).toHaveLength(5);
    expect(result.structuredContent.scanned).toMatchObject({ pagesFetched: 5, complete: false });
  });
});

describe("client tools", () => {
  it("f2b_createIndividualClient POSTs fullName/email/country/currencyId", async () => {
    const { invoke, calls } = setup({
      "POST /freelancer/f2b/clients/individual": { id: 9, type: "individual", currency: { currency: "EUR", id: 3 } },
    });
    const result = await invoke("f2b_createIndividualClient", {
      fullName: "Jane Doe",
      email: "jane@example.test",
      country: "DE",
      currency: "EUR",
    });
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/freelancer/f2b/clients/individual",
        body: { fullName: "Jane Doe", email: "jane@example.test", country: "DE", currencyId: 3 },
      },
    ]);
    expect(result.structuredContent.currency).toBe("EUR");
  });

  it("f2b_searchClients queries the unified list and maps currencyId", async () => {
    const { invoke, calls } = setup({
      "GET /freelancer/f2b/clients/unified": {
        items: [{ entryType: "company", id: null, companyId: 5, currencyId: 2, needsCreate: true }],
        pagination: { total: 1 },
      },
    });
    const result = await invoke("f2b_searchClients", { search: "acme", status: ["active", "not_verified"], size: 10 });
    const url = new URL(`https://x${calls[0].path}`);
    expect(url.pathname).toBe("/freelancer/f2b/clients/unified");
    expect(url.searchParams.get("filter[search]")).toBe("acme");
    expect(url.searchParams.getAll("filter[status][]")).toEqual(["active", "not_verified"]);
    expect(url.searchParams.get("size")).toBe("10");
    expect((result.structuredContent.items as Array<Record<string, unknown>>)[0].currency).toBe("USD");
  });

  it("f2b_searchClients description explains needsCreate → f2b_createClientFromCompany", () => {
    const { description } = setup({});
    expect(description("f2b_searchClients")).toMatch(/needsCreate=true.*f2b_createClientFromCompany/);
  });

  it("f2b_createClientFromCompany POSTs {companyId}", async () => {
    const { invoke, calls } = setup({ "POST /freelancer/f2b/clients/from-company": { id: 11, status: "active" } });
    await invoke("f2b_createClientFromCompany", { companyId: 5 });
    expect(calls).toEqual([{ method: "POST", path: "/freelancer/f2b/clients/from-company", body: { companyId: 5 } }]);
  });
});
