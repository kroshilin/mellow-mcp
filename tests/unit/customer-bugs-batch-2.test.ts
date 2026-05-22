import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFreelancerTools } from "../../src/tools/freelancers";
import { registerTaskTools } from "../../src/tools/tasks";

// Coverage for the fixes in docs/qa/2026-05-21-customer-prod-tests-results.md →
// "Поток A" mechanical fixes:
//  - NEW-A: listFreelancers must convert boolean filters to "1"/"0"
//  - NEW-C: addTaskMessage must resolve uuid → numeric taskId
//  - Bug #3: getAllowedCurrencies must default companyId from session
//  - NEW-B: createTask must reject removed fields with a helpful error

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

function makeClientStub(responses: Record<string, unknown>, activeCompanyId?: number) {
  const calls: CapturedCall[] = [];
  const respond = (method: string, path: string) => {
    const key = Object.keys(responses).find((k) => {
      const [m, p] = k.split(" ");
      return m === method && path.startsWith(p);
    });
    if (!key) throw new Error(`no scripted response for ${method} ${path}; available: ${Object.keys(responses).join(", ")}`);
    return responses[key];
  };
  const stub = {
    get: async (path: string, _params?: Record<string, string | undefined>) => {
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
    activeCompanyId,
  };
  return { stub, calls };
}

describe("listFreelancers boolean filter coercion (NEW-A)", () => {
  it("sends '1'/'0' for boolean filters, not 'true'/'false'", async () => {
    // MellowClient.get records params in a separate arg; the existing stub
    // only records path. Patch the stub locally so we can inspect query params.
    const recorded: Array<Record<string, string | undefined> | undefined> = [];
    const stub = {
      get: async (_path: string, params?: Record<string, string | undefined>) => {
        recorded.push(params);
        return { items: [] };
      },
      post: async () => undefined,
      put: async () => undefined,
      patch: async () => undefined,
      del: async () => undefined,
      activeCompanyId: undefined as number | undefined,
    };
    const { server, invoke } = makeServerStub();
    registerFreelancerTools(server, stub as never);

    await invoke("listFreelancers", { isRegistered: true, isVerified: false });

    expect(recorded).toHaveLength(1);
    const params = recorded[0]!;
    expect(params["filter[isRegistered]"]).toBe("1");
    expect(params["filter[isVerified]"]).toBe("0");
    // Sanity: not the old broken "true"/"false" form
    expect(params["filter[isRegistered]"]).not.toBe("true");
    expect(params["filter[isVerified]"]).not.toBe("false");
  });

  it("leaves undefined boolean filters unset (no spurious '0')", async () => {
    const recorded: Array<Record<string, string | undefined> | undefined> = [];
    const stub = {
      get: async (_path: string, params?: Record<string, string | undefined>) => {
        recorded.push(params);
        return { items: [] };
      },
      post: async () => undefined,
      put: async () => undefined,
      patch: async () => undefined,
      del: async () => undefined,
      activeCompanyId: undefined as number | undefined,
    };
    const { server, invoke } = makeServerStub();
    registerFreelancerTools(server, stub as never);

    await invoke("listFreelancers", { size: 5 });

    const params = recorded[0]!;
    expect(params["filter[isRegistered]"]).toBeUndefined();
    expect(params["filter[isVerified]"]).toBeUndefined();
    expect(params["filter[isInviteEmailSent]"]).toBeUndefined();
  });
});

describe("addTaskMessage uuid → taskId resolution (NEW-C)", () => {
  it("looks up numeric taskId when only uuid is provided", async () => {
    const { stub, calls } = makeClientStub({
      "GET /customer/tasks/d90c2bd9-eaab-4df0-8190-ed6c71e47bcc": { id: 6695221, uuid: "d90c2bd9-..." },
      "POST /tasks/messages": [],
    });
    const { server, invoke } = makeServerStub();
    registerTaskTools(server, stub as never);

    await invoke("addTaskMessage", { uuid: "d90c2bd9-eaab-4df0-8190-ed6c71e47bcc", message: "hello" });

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /customer/tasks/d90c2bd9-eaab-4df0-8190-ed6c71e47bcc",
      "POST /tasks/messages",
    ]);
    // Body sent to backend MUST carry numeric taskId, NOT uuid (the cause of 422 in prod).
    expect(calls[1].body).toEqual({ taskId: 6695221, message: "hello" });
  });

  it("skips lookup and sends numeric taskId directly when provided", async () => {
    const { stub, calls } = makeClientStub({
      "POST /tasks/messages": [],
    });
    const { server, invoke } = makeServerStub();
    registerTaskTools(server, stub as never);

    await invoke("addTaskMessage", { taskId: 42, message: "hi" });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ taskId: 42, message: "hi" });
  });

  it("throws a friendly error when neither taskId nor uuid is provided", async () => {
    const { stub } = makeClientStub({});
    const { server, invoke } = makeServerStub();
    registerTaskTools(server, stub as never);

    await expect(invoke("addTaskMessage", { message: "hi" })).rejects.toThrow(/either taskId or uuid is required/);
  });
});

describe("getAllowedCurrencies companyId default (Bug #3)", () => {
  it("defaults companyId from session's active company when omitted", async () => {
    const recorded: Array<Record<string, string | undefined> | undefined> = [];
    const stub = {
      get: async (_path: string, params?: Record<string, string | undefined>) => {
        recorded.push(params);
        return { items: ["EUR", "USD"] };
      },
      post: async () => undefined,
      put: async () => undefined,
      patch: async () => undefined,
      del: async () => undefined,
      activeCompanyId: 29167,
    };
    const { server, invoke } = makeServerStub();
    registerTaskTools(server, stub as never);

    await invoke("getAllowedCurrencies", {});

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual({ companyId: "29167" });
  });

  it("prefers explicit companyId over session default", async () => {
    const recorded: Array<Record<string, string | undefined> | undefined> = [];
    const stub = {
      get: async (_path: string, params?: Record<string, string | undefined>) => {
        recorded.push(params);
        return { items: [] };
      },
      post: async () => undefined,
      put: async () => undefined,
      patch: async () => undefined,
      del: async () => undefined,
      activeCompanyId: 29167,
    };
    const { server, invoke } = makeServerStub();
    registerTaskTools(server, stub as never);

    await invoke("getAllowedCurrencies", { companyId: 11111 });

    expect(recorded[0]).toEqual({ companyId: "11111" });
  });

  it("throws a friendly error when no companyId and no session default", async () => {
    const { stub } = makeClientStub({});
    const { server, invoke } = makeServerStub();
    registerTaskTools(server, stub as never);

    await expect(invoke("getAllowedCurrencies", {})).rejects.toThrow(/companyId is required/);
  });
});

describe("createTask removed-field guard (NEW-B)", () => {
  it("rejects legacy createType with rename hint", async () => {
    const { stub } = makeClientStub({});
    const { server, invoke } = makeServerStub();
    registerTaskTools(server, stub as never);

    await expect(
      invoke("createTask", {
        title: "test",
        description: "x",
        workerId: 1,
        categoryId: 1,
        price: 1,
        deadline: "2026-12-31T00:00:00+00:00",
        createType: "draft",
      }),
    ).rejects.toThrow(/createType/);
  });

  it("rejects legacy acceptanceFileTemplateIds with rename hint", async () => {
    const { stub } = makeClientStub({});
    const { server, invoke } = makeServerStub();
    registerTaskTools(server, stub as never);

    await expect(
      invoke("createTask", {
        title: "test",
        description: "x",
        workerId: 1,
        categoryId: 1,
        price: 1,
        deadline: "2026-12-31T00:00:00+00:00",
        acceptanceFileTemplateIds: [1],
      }),
    ).rejects.toThrow(/acceptanceFileIds/);
  });
});
