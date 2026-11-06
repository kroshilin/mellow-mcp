import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerF2bClientTools } from "../../src/tools/f2b/clients";
import { MellowApiError } from "../../src/mellow-client";

// Unit tests for f2b_updateClient and f2b_archiveClient — the two tools added
// by slice 2 client management. We intercept the MellowClient call (not the
// underlying fetch) and assert on the path, method, and body shape sent to the
// backend. This is enough to lock in the contract; integration with a real
// fetch mock (MSW) lands when the first composite invoice tool needs it.

type Capture = {
  method?: string;
  path?: string;
  body?: unknown;
};

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

function makeClientStub(capture: Capture, response: unknown = { ok: true }) {
  return {
    get: async (path: string) => {
      capture.method = "GET";
      capture.path = path;
      return response;
    },
    post: async (path: string, body?: object) => {
      capture.method = "POST";
      capture.path = path;
      capture.body = body;
      return response;
    },
    put: async (path: string, body?: object) => {
      capture.method = "PUT";
      capture.path = path;
      capture.body = body;
      return response;
    },
    patch: async (path: string, body?: object) => {
      capture.method = "PATCH";
      capture.path = path;
      capture.body = body;
      return response;
    },
    del: async (path: string, body?: object) => {
      capture.method = "DELETE";
      capture.path = path;
      capture.body = body;
      return response;
    },
  };
}

describe("f2b_updateClient", () => {
  it("PUTs to /freelancer/f2b/clients/legal with clientId and only defined fields", async () => {
    const capture: Capture = {};
    const { server, invoke } = makeServerStub();
    registerF2bClientTools(server, makeClientStub(capture) as never);

    await invoke("f2b_updateClient", {
      clientId: 42,
      companyName: "Acme Updated",
      // VAT/TIN/regNumber/address are client-entered on the payment page
      // (backlog row 5) — leaked here to prove the whitelist drops them.
      vat: "CY77777777",
    });

    expect(capture.method).toBe("PUT");
    expect(capture.path).toBe("/freelancer/f2b/clients/legal");
    expect(capture.body).toEqual({
      clientId: 42,
      companyName: "Acme Updated",
    });
  });

  it("never forwards currency or type to the body, even if Zod is bypassed", async () => {
    const capture: Capture = {};
    const { server, invoke } = makeServerStub();
    registerF2bClientTools(server, makeClientStub(capture) as never);

    // Zod strips unknown keys at the MCP boundary in production. Stub server
    // here does NOT run Zod — we leak both immutable keys to verify the
    // handler's whitelist also drops them (defense in depth).
    await invoke("f2b_updateClient", {
      clientId: 7,
      companyName: "Acme",
      currency: "USD" as never,
      type: "individual" as never,
    });

    const body = capture.body as Record<string, unknown>;
    // Mutable fields make it through.
    expect(body.clientId).toBe(7);
    expect(body.companyName).toBe("Acme");
    // Immutable fields must NOT make it through, Zod or no Zod.
    expect(body).not.toHaveProperty("currency");
    expect(body).not.toHaveProperty("currencyId");
    expect(body).not.toHaveProperty("type");
  });
});

describe("f2b_archiveClient", () => {
  it("DELETEs /freelancer/f2b/clients with clientId in the body", async () => {
    const capture: Capture = {};
    const { server, invoke } = makeServerStub();
    // One canned answer serves every call: the client lookup (has an email),
    // both activity lists (no items) and the DELETE itself.
    registerF2bClientTools(server, makeClientStub(capture, { id: 100, status: "active", email: "x@y.test", items: [] }) as never);

    await invoke("f2b_archiveClient", { clientId: 100 });

    expect(capture.method).toBe("DELETE");
    expect(capture.path).toBe("/freelancer/f2b/clients");
    expect(capture.body).toEqual({ clientId: 100 });
  });
});

// Backlog row "Удаление клиента" (product answer 2026-11): a client must not
// be deleted while it has an active invoice or deal — active = any status
// other than draft/new, paid and cancelled (`finished` counts as the deal
// analog of paid). The backend blocks only on `sent`, so MCP checks first.
describe("f2b_archiveClient — active invoice/deal guard", () => {
  type Call = { method: string; path: string; body?: unknown };

  function setup(responses: Record<string, unknown | ((path: string) => unknown)>) {
    const calls: Call[] = [];
    const answer = (method: string, path: string) => {
      const key = Object.keys(responses)
        .filter((k) => {
          const [m, p] = k.split(" ");
          return m === method && path.startsWith(p);
        })
        .sort((a, b) => b.length - a.length)[0];
      if (!key) throw new Error(`no scripted response for ${method} ${path}`);
      const value = responses[key];
      return typeof value === "function" ? (value as (p: string) => unknown)(path) : value;
    };
    const rec = (method: string) => async (path: string, body?: unknown) => {
      calls.push(body === undefined ? { method, path } : { method, path, body });
      return answer(method, path);
    };
    const { server, invoke } = makeServerStub();
    registerF2bClientTools(server, { get: rec("GET"), del: rec("DELETE") } as never);
    return { invoke, calls };
  }

  const clientRow = { id: 42, status: "active", companyName: "Acme Ltd", email: "AP@acme.test", currency: { id: 3 } };
  const empty = { items: [], pagination: { pages: 1 } };

  it("checks active invoices (by clientId) and deals (by client email), then archives", async () => {
    const { invoke, calls } = setup({
      "GET /freelancer/f2b/clients/42": clientRow,
      "GET /freelancer/f2b/invoices": {
        items: [
          { id: 1, clientId: 7, status: "sent" },
          { id: 2, clientId: null, status: "sent", source: "offer" },
        ],
        pagination: { pages: 1 },
      },
      "GET /v2/freelancer/secure-deals": { items: [{ id: 5, clientEmail: "other@x.test", status: "in_work" }], pagination: { pages: 1 } },
      "DELETE /freelancer/f2b/clients": [],
    });

    const result = (await invoke("f2b_archiveClient", { clientId: 42 })) as { structuredContent: Record<string, unknown> };

    const invoiceUrl = new URL(`https://x${calls[1].path}`);
    expect(invoiceUrl.pathname).toBe("/freelancer/f2b/invoices");
    expect(invoiceUrl.searchParams.getAll("filter[status][]")).toEqual(["sent", "payment_queued"]);
    expect(invoiceUrl.searchParams.get("size")).toBe("500");

    const dealUrl = new URL(`https://x${calls[2].path}`);
    expect(dealUrl.pathname).toBe("/v2/freelancer/secure-deals");
    expect(dealUrl.searchParams.get("filter[search]")).toBe("AP@acme.test");
    expect(dealUrl.searchParams.getAll("filter[status][]")).toEqual([
      "sent",
      "in_work",
      "client_review",
      "for_payment",
      "rejected",
      "revision_requested",
      "waiting_deadline_decision",
      "declined_by_customer",
      "dispute_in_progress",
    ]);

    expect(calls[calls.length - 1]).toEqual({ method: "DELETE", path: "/freelancer/f2b/clients", body: { clientId: 42 } });
    expect(result.structuredContent).toMatchObject({ archived: true, client: { id: 42, name: "Acme Ltd" } });
  });

  it("refuses and lists the blocking records; never calls DELETE", async () => {
    const { invoke, calls } = setup({
      "GET /freelancer/f2b/clients/42": clientRow,
      "GET /freelancer/f2b/invoices": {
        items: [{ id: 1, number: "INV-1", clientId: 42, status: "payment_queued", amount: 100, currency: { currency: "EUR", id: 3 } }],
        pagination: { pages: 1 },
      },
      "GET /v2/freelancer/secure-deals": {
        items: [{ id: 5, number: "SD-5", clientEmail: "ap@acme.test", status: "client_review", amount: 900, currency: { currency: "USD", id: 2 } }],
        pagination: { pages: 1 },
      },
    });
    await expect(invoke("f2b_archiveClient", { clientId: 42 })).rejects.toThrow(
      /cannot be deleted: it has 2 active.*invoice INV-1 — payment_queued, 100 EUR; deal SD-5 — client_review, 900 USD/,
    );
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("pages through long lists", async () => {
    const { invoke, calls } = setup({
      "GET /freelancer/f2b/clients/42": clientRow,
      "GET /freelancer/f2b/invoices": (path: string) =>
        new URL(`https://x${path}`).searchParams.get("page") === "1"
          ? { items: [{ id: 1, clientId: 7, status: "sent" }], pagination: { pages: 2 } }
          : { items: [{ id: 2, clientId: 42, status: "sent", number: "INV-2" }], pagination: { pages: 2 } },
      "GET /v2/freelancer/secure-deals": empty,
    });
    await expect(invoke("f2b_archiveClient", { clientId: 42 })).rejects.toThrow(/INV-2/);
    expect(calls.filter((c) => c.path.startsWith("/freelancer/f2b/invoices"))).toHaveLength(2);
  });

  it("treats a disabled Secure Deals section (403/404) as no deals", async () => {
    const { invoke, calls } = setup({
      "GET /freelancer/f2b/clients/42": clientRow,
      "GET /freelancer/f2b/invoices": empty,
      "GET /v2/freelancer/secure-deals": () => {
        throw new MellowApiError("Mellow API GET /v2/freelancer/secure-deals failed (404)", 404, "GET", "/v2/freelancer/secure-deals");
      },
      "DELETE /freelancer/f2b/clients": [],
    });
    await invoke("f2b_archiveClient", { clientId: 42 });
    expect(calls[calls.length - 1]?.method).toBe("DELETE");
  });

  it("propagates other deal-list failures instead of archiving blindly", async () => {
    const { invoke, calls } = setup({
      "GET /freelancer/f2b/clients/42": clientRow,
      "GET /freelancer/f2b/invoices": empty,
      "GET /v2/freelancer/secure-deals": () => {
        throw new MellowApiError("boom (500)", 500, "GET", "/v2/freelancer/secure-deals");
      },
    });
    await expect(invoke("f2b_archiveClient", { clientId: 42 })).rejects.toThrow(/boom/);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("fails closed when the scan would be truncated (more pages than the cap)", async () => {
    const { invoke, calls } = setup({
      "GET /freelancer/f2b/clients/42": clientRow,
      "GET /freelancer/f2b/invoices": { items: [{ id: 1, clientId: 7, status: "sent" }], pagination: { pages: 99 } },
      "GET /v2/freelancer/secure-deals": empty,
    });
    await expect(invoke("f2b_archiveClient", { clientId: 42 })).rejects.toThrow(/Too many records/);
    expect(calls.filter((c) => c.path.startsWith("/freelancer/f2b/invoices"))).toHaveLength(10);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("keeps paging when pagination metadata is missing and the page is full", async () => {
    const full = Array.from({ length: 500 }, (_, i) => ({ id: i, clientId: 7, status: "sent" }));
    const { invoke, calls } = setup({
      "GET /freelancer/f2b/clients/42": clientRow,
      "GET /freelancer/f2b/invoices": (path: string) =>
        new URL(`https://x${path}`).searchParams.get("page") === "1" ? { items: full } : { items: [{ id: 900, clientId: 42, status: "sent", number: "INV-900" }] },
      "GET /v2/freelancer/secure-deals": empty,
    });
    await expect(invoke("f2b_archiveClient", { clientId: 42 })).rejects.toThrow(/INV-900/);
    expect(calls.filter((c) => c.path.startsWith("/freelancer/f2b/invoices"))).toHaveLength(2);
  });

  it("fails closed on a 403 from the deals list (only 404 means the feature is off)", async () => {
    const { invoke, calls } = setup({
      "GET /freelancer/f2b/clients/42": clientRow,
      "GET /freelancer/f2b/invoices": empty,
      "GET /v2/freelancer/secure-deals": () => {
        throw new MellowApiError("forbidden (403)", 403, "GET", "/v2/freelancer/secure-deals");
      },
    });
    await expect(invoke("f2b_archiveClient", { clientId: 42 })).rejects.toThrow(/403/);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("refuses when the client has no email (deals could not be matched)", async () => {
    const { invoke, calls } = setup({
      "GET /freelancer/f2b/clients/42": { ...clientRow, email: undefined },
      "GET /freelancer/f2b/invoices": empty,
    });
    await expect(invoke("f2b_archiveClient", { clientId: 42 })).rejects.toThrow(/no email/);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("says so when the client is already archived", async () => {
    const { invoke, calls } = setup({ "GET /freelancer/f2b/clients/42": { ...clientRow, status: "archived" } });
    await expect(invoke("f2b_archiveClient", { clientId: 42 })).rejects.toThrow(/already deleted/);
    expect(calls).toHaveLength(1);
  });
});
