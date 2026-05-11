import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerF2bInvoiceTools } from "../../src/tools/f2b/invoices";

// Unit + lightweight integration tests for the 5 F2B invoice tools.
//
// Strategy: stub the McpServer to capture registered handlers, stub the
// MellowClient to capture method/path/body and return scripted responses.
// This is enough to lock in:
//   - the sequence of HTTP calls a composite tool makes
//   - the path / method / body shape of each call
//   - the currency mapping on read paths
//   - the public-payment-status branch in f2b_getInvoice
//
// Full HTTP-level integration with MSW lands when we need to test fetch
// semantics (timeouts, headers, error parsing). For tool-handler contract
// tests, the MellowClient stub is sufficient and a lot faster.

type CapturedCall = { method: string; path: string; body?: unknown };

function makeServerStub() {
  type Handler = (params: unknown) => Promise<unknown>;
  const tools = new Map<string, Handler>();
  const server = {
    tool(name: string, _description: string, _schema: unknown, _annotations: unknown, handler: Handler) {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  return {
    server,
    invoke: (name: string, params: unknown) => {
      const handler = tools.get(name);
      if (!handler) throw new Error(`tool not registered: ${name}`);
      return handler(params);
    },
  };
}

/**
 * MellowClient stub that records calls and returns scripted responses keyed
 * by `<METHOD> <path-prefix>`. Path matching is prefix-based to keep tests
 * resilient to query strings.
 */
function makeClientStub(responses: Record<string, unknown>) {
  const calls: CapturedCall[] = [];
  const respond = (method: string, path: string) => {
    const key = Object.keys(responses).find((k) => {
      const [m, p] = k.split(" ");
      return m === method && path.startsWith(p);
    });
    if (!key) {
      throw new Error(`no scripted response for ${method} ${path}; available: ${Object.keys(responses).join(", ")}`);
    }
    return responses[key];
  };
  const stub = {
    get: async (path: string) => {
      calls.push({ method: "GET", path });
      return respond("GET", path);
    },
    post: async (path: string, body?: object) => {
      calls.push({ method: "POST", path, body });
      return respond("POST", path);
    },
    put: async (path: string, body?: object) => {
      calls.push({ method: "PUT", path, body });
      return respond("PUT", path);
    },
    patch: async (path: string, body?: object) => {
      calls.push({ method: "PATCH", path, body });
      return respond("PATCH", path);
    },
    del: async (path: string, body?: object) => {
      calls.push({ method: "DELETE", path, body });
      return respond("DELETE", path);
    },
  };
  return { stub, calls };
}

describe("f2b_createInvoiceDraft (composite)", () => {
  it("loads client first, then POSTs invoice with derived currencyId", async () => {
    const { stub, calls } = makeClientStub({
      "GET /freelancer/f2b/clients/42": {
        id: 42,
        type: "legal",
        status: "active",
        currency: { currency: "EUR", id: 3 },
      },
      "POST /freelancer/f2b/v2/invoices": {
        invoiceId: 555,
        uuid: "abc-uuid",
        status: "new",
        currencyId: 3,
        breakdown: { subtotal: 100, total: 105, payable: 100, commissionPercent: 5 },
      },
    });

    const { server, invoke } = makeServerStub();
    registerF2bInvoiceTools(server, stub as never);

    await invoke("f2b_createInvoiceDraft", {
      clientId: 42,
      serviceId: 7,
      serviceName: "Consulting",
      serviceStartDate: "2026-05-01",
      serviceEndDate: "2026-05-31",
      invoiceDate: "2026-05-11",
      lineItems: [{ name: "Work", quantity: 1, measure: "hour", price: 100 }],
      commissionPayer: "freelancer",
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ method: "GET", path: "/freelancer/f2b/clients/42" });
    expect(calls[1].method).toBe("POST");
    expect(calls[1].path).toBe("/freelancer/f2b/v2/invoices");
    const body = calls[1].body as Record<string, unknown>;
    expect(body.clientId).toBe(42);
    expect(body.currencyId).toBe(3); // derived from client.currency.id
    expect(body.commissionPayer).toBe("freelancer");
    expect(body.acquiringEnabled).toBe(false); // default
  });

  it("supports the flat currencyId shape on the client response", async () => {
    const { stub, calls } = makeClientStub({
      "GET /freelancer/f2b/clients/1": { id: 1, status: "active", currencyId: 2 }, // flat
      "POST /freelancer/f2b/v2/invoices": { invoiceId: 1, status: "new" },
    });
    const { server, invoke } = makeServerStub();
    registerF2bInvoiceTools(server, stub as never);

    await invoke("f2b_createInvoiceDraft", {
      clientId: 1,
      serviceId: 1,
      serviceName: "X",
      serviceStartDate: "2026-05-01",
      serviceEndDate: "2026-05-01",
      invoiceDate: "2026-05-01",
      lineItems: [{ name: "x", quantity: 1, measure: "item", price: 1 }],
      commissionPayer: "customer",
    });

    const body = calls[1].body as Record<string, unknown>;
    expect(body.currencyId).toBe(2); // USD, picked up from flat shape
  });

  it("throws a friendly error when client is archived (skips POST)", async () => {
    const { stub, calls } = makeClientStub({
      "GET /freelancer/f2b/clients/99": { id: 99, status: "archived", currency: { currency: "EUR", id: 3 } },
    });
    const { server, invoke } = makeServerStub();
    registerF2bInvoiceTools(server, stub as never);

    await expect(
      invoke("f2b_createInvoiceDraft", {
        clientId: 99,
        serviceId: 1,
        serviceName: "X",
        serviceStartDate: "2026-05-01",
        serviceEndDate: "2026-05-01",
        invoiceDate: "2026-05-01",
        lineItems: [{ name: "x", quantity: 1, measure: "item", price: 1 }],
        commissionPayer: "freelancer",
      }),
    ).rejects.toThrow(/archived/);

    // Only the GET happened — POST was skipped.
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
  });
});

describe("f2b_sendInvoiceDraft", () => {
  it("POSTs to /send with invoiceId in body", async () => {
    const { stub, calls } = makeClientStub({
      "POST /freelancer/f2b/invoices/send": { invoiceId: 555, status: "sent", paymentUrl: "https://..." },
    });
    const { server, invoke } = makeServerStub();
    registerF2bInvoiceTools(server, stub as never);

    await invoke("f2b_sendInvoiceDraft", { invoiceId: 555 });

    expect(calls).toEqual([{ method: "POST", path: "/freelancer/f2b/invoices/send", body: { invoiceId: 555 } }]);
  });
});

describe("f2b_getInvoice", () => {
  it("fetches invoice; skips payment-status when acquiringEnabled is false", async () => {
    const { stub, calls } = makeClientStub({
      "GET /freelancer/f2b/invoices/77": {
        invoiceId: 77,
        uuid: "abc",
        status: "sent",
        acquiringEnabled: false,
      },
    });
    const { server, invoke } = makeServerStub();
    registerF2bInvoiceTools(server, stub as never);

    const result = (await invoke("f2b_getInvoice", { invoiceId: 77 })) as {
      structuredContent: Record<string, unknown>;
    };

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/freelancer/f2b/invoices/77");
    expect(result.structuredContent).not.toHaveProperty("paymentStatus");
  });

  it("fetches payment-status when acquiringEnabled and status is 'sent'", async () => {
    const { stub, calls } = makeClientStub({
      "GET /freelancer/f2b/invoices/77": {
        invoiceId: 77,
        uuid: "abc-uuid",
        status: "sent",
        acquiringEnabled: true,
      },
      "GET /f2b/invoices/payment-status/abc-uuid": { state: "initiated" },
    });
    const { server, invoke } = makeServerStub();
    registerF2bInvoiceTools(server, stub as never);

    const result = (await invoke("f2b_getInvoice", { invoiceId: 77 })) as {
      structuredContent: Record<string, unknown>;
    };

    expect(calls).toHaveLength(2);
    expect(calls[0].path).toBe("/freelancer/f2b/invoices/77");
    expect(calls[1].path).toBe("/f2b/invoices/payment-status/abc-uuid");
    expect(result.structuredContent.paymentStatus).toEqual({ state: "initiated" });
  });
});

describe("f2b_listInvoices", () => {
  it("uses `size` query param (not `limit`) for page size — Mellow API convention", async () => {
    const { stub, calls } = makeClientStub({
      "GET /freelancer/f2b/invoices": { items: [], pagination: { page: 1, size: 5, total: 0 } },
    });
    const { server, invoke } = makeServerStub();
    registerF2bInvoiceTools(server, stub as never);

    await invoke("f2b_listInvoices", { page: 1, size: 5 });

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toContain("page=1");
    expect(calls[0].path).toContain("size=5");
    expect(calls[0].path).not.toContain("limit=");
  });

  it("multi-value status emits repeated filter[status][] entries", async () => {
    const { stub, calls } = makeClientStub({
      "GET /freelancer/f2b/invoices": { items: [] },
    });
    const { server, invoke } = makeServerStub();
    registerF2bInvoiceTools(server, stub as never);

    await invoke("f2b_listInvoices", { status: ["sent", "paid"] });

    // URLSearchParams encodes [ and ] — assert on the encoded form.
    expect(calls[0].path).toContain("filter%5Bstatus%5D%5B%5D=sent");
    expect(calls[0].path).toContain("filter%5Bstatus%5D%5B%5D=paid");
  });
});

describe("f2b_cancelInvoice", () => {
  it("DELETEs /invoices with invoiceId in body", async () => {
    const { stub, calls } = makeClientStub({
      "DELETE /freelancer/f2b/invoices": { invoiceId: 99, status: "cancelled" },
    });
    const { server, invoke } = makeServerStub();
    registerF2bInvoiceTools(server, stub as never);

    await invoke("f2b_cancelInvoice", { invoiceId: 99 });

    expect(calls).toEqual([{ method: "DELETE", path: "/freelancer/f2b/invoices", body: { invoiceId: 99 } }]);
  });
});
