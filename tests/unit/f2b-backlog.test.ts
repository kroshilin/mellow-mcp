import { describe, expect, it } from "vitest";
import { registerF2bClientTools } from "../../src/tools/f2b/clients";
import { registerF2bInvoiceTools } from "../../src/tools/f2b/invoices";
import { registerF2bInvoiceEditTools } from "../../src/tools/f2b/invoice-edit";
import { registerF2bPricingTools } from "../../src/tools/f2b/pricing";
import { registerFreelancerFinanceTools } from "../../src/tools/freelancer-finance";
import { makeClientStub, makeServerStub, parsedText } from "./helpers/stubs";

// Contract tests for the freelancer backlog (Google Sheet "MCP F2B CoR", 2026-11).
// Each describe block names the sheet row it covers.

const SOURCE_INVOICE = {
  id: 900,
  number: "INV-900",
  status: "sent",
  client: { id: 42, status: "active", type: "legal" },
  currency: { currency: "EUR", id: 3 },
  service: { id: 7, title: "Consulting" },
  serviceName: "Consulting for ACME",
  serviceStartDate: "2026-10-01T00:00:00+00:00",
  serviceEndDate: "2026-10-31T00:00:00+00:00",
  invoiceDate: "2026-11-01T00:00:00+00:00",
  commissionPayer: "freelancer",
  acquiringEnabled: true,
  lineItems: [{ name: "Work", quantity: 10, measure: "hour", price: 50, total: 500 }],
};

describe("row 5 — f2b_createClient asks only what the cabinet form asks", () => {
  it("requires companyName", () => {
    const { server, schema } = makeServerStub();
    registerF2bClientTools(server, makeClientStub({}).stub as never);

    const withoutName = schema("f2b_createClient").safeParse({ email: "a@b.co", country: "DE", currency: "EUR" });
    expect(withoutName.success).toBe(false);
  });

  it("does not offer VAT / TIN / reg number / address on create or update", () => {
    const { server, schema } = makeServerStub();
    registerF2bClientTools(server, makeClientStub({}).stub as never);

    for (const tool of ["f2b_createClient", "f2b_updateClient"]) {
      const keys = Object.keys(schema(tool).shape);
      for (const forbidden of ["vat", "tin", "regNumber", "address", "city", "region", "postalCode"]) {
        expect(keys, `${tool} must not expose ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("POSTs only email, country, currencyId and companyName", async () => {
    const { stub, calls } = makeClientStub({ "POST /freelancer/f2b/clients/legal": { id: 1, currencyId: 3 } });
    const { server, invoke } = makeServerStub();
    registerF2bClientTools(server, stub as never);

    await invoke("f2b_createClient", { email: "a@b.co", country: "DE", currency: "EUR", companyName: "ACME GmbH" });

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/freelancer/f2b/clients/legal",
        body: { email: "a@b.co", country: "DE", currencyId: 3, companyName: "ACME GmbH" },
      },
    ]);
  });
});

describe("row 6 — work period is not a due date", () => {
  it("f2b_createInvoiceDraft no longer describes serviceEndDate as a due date", () => {
    const { server, schema } = makeServerStub();
    registerF2bInvoiceTools(server, makeClientStub({}).stub as never);

    const endDate = schema("f2b_createInvoiceDraft").shape.serviceEndDate as { description?: string };
    const text = endDate.description ?? "";
    expect(text).not.toMatch(/doubles as|de-facto due/i);
    expect(text).toMatch(/NOT a payment due date/);
    expect(text).toMatch(/work period/i);
  });
});

describe("row 6 — f2b_searchServices", () => {
  it("GETs the v2 freelancer service lookup with filter[search]", async () => {
    const { stub, calls } = makeClientStub({
      "GET /v2/freelancer/lookups/services": [{ id: 7, title: "Consulting", titleDoc: "Consulting services" }],
    });
    const { server, invoke } = makeServerStub();
    registerF2bPricingTools(server, stub as never);

    const result = await invoke("f2b_searchServices", { search: "consult design" });

    expect(calls).toEqual([{ method: "GET", path: "/v2/freelancer/lookups/services?filter%5Bsearch%5D=consult+design" }]);
    expect(parsedText(result)).toEqual([{ id: 7, title: "Consulting", titleDoc: "Consulting services" }]);
  });

  it("omits the filter when no search term is given", async () => {
    const { stub, calls } = makeClientStub({ "GET /v2/freelancer/lookups/services": [] });
    const { server, invoke } = makeServerStub();
    registerF2bPricingTools(server, stub as never);

    await invoke("f2b_searchServices", {});

    expect(calls).toEqual([{ method: "GET", path: "/v2/freelancer/lookups/services" }]);
  });
});

describe("row 7 — f2b_calculateInvoiceCost", () => {
  it("POSTs an estimate with currencyId derived from the client", async () => {
    const { stub, calls } = makeClientStub({
      "GET /freelancer/f2b/clients/42": { id: 42, status: "active", currency: { currency: "EUR", id: 3 } },
      "POST /freelancer/f2b/invoices/calculate-cost": [{ received: 61.9, cost: 65 }],
    });
    const { server, invoke } = makeServerStub();
    registerF2bPricingTools(server, stub as never);

    await invoke("f2b_calculateInvoiceCost", {
      clientId: 42,
      commissionPayer: "freelancer",
      lineItems: [{ name: "Work", quantity: 1, measure: "item", price: 65 }],
    });

    expect(calls[0]).toEqual({ method: "GET", path: "/freelancer/f2b/clients/42" });
    expect(calls[1]).toEqual({
      method: "POST",
      path: "/freelancer/f2b/invoices/calculate-cost",
      body: {
        clientId: 42,
        currencyId: 3,
        commissionPayer: "freelancer",
        lineItems: [{ name: "Work", quantity: 1, measure: "item", price: 65 }],
      },
    });
  });

  it("for an existing invoice, reads currency and commission payer from the invoice", async () => {
    const { stub, calls } = makeClientStub({
      "GET /freelancer/f2b/invoices/900": SOURCE_INVOICE,
      "POST /freelancer/f2b/invoices/calculate-cost": [{ received: 476.19 }],
    });
    const { server, invoke } = makeServerStub();
    registerF2bPricingTools(server, stub as never);

    await invoke("f2b_calculateInvoiceCost", { invoiceId: 900 });

    expect(calls[1]).toEqual({
      method: "POST",
      path: "/freelancer/f2b/invoices/calculate-cost",
      body: { invoiceId: 900, currencyId: 3, commissionPayer: "freelancer" },
    });
  });

  it("forbids the agent from computing commissions itself", () => {
    const { server, description } = makeServerStub();
    registerF2bPricingTools(server, makeClientStub({}).stub as never);

    expect(description("f2b_calculateInvoiceCost")).toMatch(/never compute/i);
  });

  it("rejects calls with neither invoiceId nor clientId", async () => {
    const { server, invoke } = makeServerStub();
    registerF2bPricingTools(server, makeClientStub({}).stub as never);

    await expect(invoke("f2b_calculateInvoiceCost", { commissionPayer: "freelancer", amount: 10 })).rejects.toThrow(/invoiceId|clientId/);
  });
});

describe("row 8 — f2b_updateInvoice edits in place", () => {
  it("GETs, PUTs the merged full payload to /v2/invoices, then re-reads", async () => {
    const { stub, calls } = makeClientStub({
      "GET /freelancer/f2b/invoices/900": SOURCE_INVOICE,
      "PUT /freelancer/f2b/v2/invoices": [],
    });
    const { server, invoke } = makeServerStub();
    registerF2bInvoiceEditTools(server, stub as never);

    await invoke("f2b_updateInvoice", { invoiceId: 900, serviceName: "Consulting, November" });

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /freelancer/f2b/invoices/900",
      "PUT /freelancer/f2b/v2/invoices",
      "GET /freelancer/f2b/invoices/900",
    ]);
    expect(calls[1].body).toEqual({
      invoiceId: 900,
      currencyId: 3,
      commissionPayer: "freelancer",
      serviceId: 7,
      serviceName: "Consulting, November",
      serviceStartDate: "2026-10-01",
      serviceEndDate: "2026-10-31",
      invoiceDate: "2026-11-01",
      acquiringEnabled: true,
      lineItems: [{ name: "Work", quantity: 10, measure: "hour", price: 50 }],
    });
  });

  it("refuses statuses the backend cannot edit, without calling PUT or DELETE", async () => {
    const { stub, calls } = makeClientStub({ "GET /freelancer/f2b/invoices/900": { ...SOURCE_INVOICE, status: "paid" } });
    const { server, invoke } = makeServerStub();
    registerF2bInvoiceEditTools(server, stub as never);

    await expect(invoke("f2b_updateInvoice", { invoiceId: 900, serviceName: "x" })).rejects.toThrow(/paid/);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });
});

describe("row 8 — f2b_duplicateInvoice", () => {
  it("creates a new draft from the source invoice and never touches the original", async () => {
    const { stub, calls } = makeClientStub({
      "GET /freelancer/f2b/invoices/900": SOURCE_INVOICE,
      "GET /freelancer/f2b/clients/42": { id: 42, status: "active", currency: { currency: "EUR", id: 3 } },
      "POST /freelancer/f2b/v2/invoices": { id: 901, status: "new" },
    });
    const { server, invoke } = makeServerStub();
    registerF2bInvoiceEditTools(server, stub as never);

    await invoke("f2b_duplicateInvoice", { invoiceId: 900, invoiceDate: "2026-11-06" });

    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe("/freelancer/f2b/v2/invoices");
    expect(post?.body).toEqual({
      clientId: 42,
      currencyId: 3,
      commissionPayer: "freelancer",
      serviceId: 7,
      serviceName: "Consulting for ACME",
      serviceStartDate: "2026-10-01",
      serviceEndDate: "2026-10-31",
      invoiceDate: "2026-11-06",
      acquiringEnabled: true,
      lineItems: [{ name: "Work", quantity: 10, measure: "hour", price: 50 }],
    });
    expect(calls.some((c) => c.method === "DELETE" || c.method === "PUT")).toBe(false);
  });

  it("applies overrides, re-deriving currency when the client changes", async () => {
    const { stub, calls } = makeClientStub({
      "GET /freelancer/f2b/invoices/900": SOURCE_INVOICE,
      "GET /freelancer/f2b/clients/77": { id: 77, status: "not_verified", currencyId: 2 },
      "POST /freelancer/f2b/v2/invoices": { id: 902, status: "new" },
    });
    const { server, invoke } = makeServerStub();
    registerF2bInvoiceEditTools(server, stub as never);

    await invoke("f2b_duplicateInvoice", {
      invoiceId: 900,
      invoiceDate: "2026-11-06",
      clientId: 77,
      lineItems: [{ name: "Design", quantity: 1, measure: "item", price: 300 }],
    });

    const body = calls.find((c) => c.method === "POST")?.body as Record<string, unknown>;
    expect(body.clientId).toBe(77);
    expect(body.currencyId).toBe(2);
    expect(body.lineItems).toEqual([{ name: "Design", quantity: 1, measure: "item", price: 300 }]);
  });
});

describe("row 8 — cancel requires confirmation", () => {
  it("f2b_cancelInvoice description demands explicit user confirmation", () => {
    const { server, description } = makeServerStub();
    registerF2bInvoiceTools(server, makeClientStub({}).stub as never);

    expect(description("f2b_cancelInvoice")).toMatch(/confirm/i);
  });
});

describe("rows 2–3 — freelancer balance and exchange rates", () => {
  it("getBalance GETs /profile/balance", async () => {
    const { stub, calls } = makeClientStub({ "GET /profile/balance": [{ currency: "EUR", amount: 120.5 }] });
    const { server, invoke } = makeServerStub();
    registerFreelancerFinanceTools(server, stub as never);

    const result = await invoke("getBalance", {});

    expect(calls).toEqual([{ method: "GET", path: "/profile/balance" }]);
    expect(parsedText(result)).toEqual([{ currency: "EUR", amount: 120.5 }]);
  });

  it("registers getExchangeRate for freelancers", async () => {
    const { stub, calls } = makeClientStub({ "GET /exchanges": [{ base: "USD", target: "EUR", rate: 0.9 }] });
    const { server, invoke, names } = makeServerStub();
    registerFreelancerFinanceTools(server, stub as never);

    expect(names()).toContain("getExchangeRate");
    await invoke("getExchangeRate", {});
    expect(calls).toEqual([{ method: "GET", path: "/exchanges" }]);
  });
});
