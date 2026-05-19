import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { asStructuredObject } from "../../src/mellow-client";
import { registerTaskGroupTools } from "../../src/tools/task-groups";

describe("asStructuredObject", () => {
  it("passes through a plain object unchanged", () => {
    const input = { uuid: "abc", status: "ok" };
    expect(asStructuredObject(input)).toEqual({ uuid: "abc", status: "ok" });
  });

  it("wraps an empty array (the Mellow success convention)", () => {
    expect(asStructuredObject([])).toEqual({ ok: true, raw: [] });
  });

  it("wraps a populated array", () => {
    expect(asStructuredObject([1, 2, 3])).toEqual({ ok: true, raw: [1, 2, 3] });
  });

  it("wraps null", () => {
    expect(asStructuredObject(null)).toEqual({ ok: true, raw: null });
  });

  it("wraps a scalar string", () => {
    expect(asStructuredObject("ok")).toEqual({ ok: true, raw: "ok" });
  });
});

// Integration: lock in that a previously broken handler now produces a
// valid MCP envelope when the backend returns []. createTaskGroup is the
// canonical reproduction case from docs/qa/2026-05-19-bug-mcp-struct-wrap.md.

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

function makeClientStub(responses: Record<string, unknown>) {
  const calls: CapturedCall[] = [];
  const respond = (method: string, path: string) => {
    const key = Object.keys(responses).find((k) => {
      const [m, p] = k.split(" ");
      return m === method && path.startsWith(p);
    });
    if (!key) throw new Error(`no scripted response for ${method} ${path}`);
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

describe("createTaskGroup with backend [] response (regression: 2026-05-19)", () => {
  it("returns a valid MCP envelope wrapping the empty array", async () => {
    const { stub } = makeClientStub({
      "POST /customer/task-groups": [], // The reproduction case from the QA report.
    });
    const { server, invoke } = makeServerStub();
    registerTaskGroupTools(server, stub as never);

    const result = (await invoke("createTaskGroup", { title: "regression test" })) as {
      structuredContent: Record<string, unknown>;
    };

    // structuredContent MUST be a non-array object (MCP SDK validator
    // requirement). Before the fix the handler put [] directly here,
    // triggering "Invalid tools/call result: expected record, received array".
    expect(Array.isArray(result.structuredContent)).toBe(false);
    expect(typeof result.structuredContent).toBe("object");
    expect(result.structuredContent).toEqual({ ok: true, raw: [] });
  });
});
