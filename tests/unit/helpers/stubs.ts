import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Shared test doubles for tool-handler contract tests.
//
// - makeServerStub captures every registered tool's handler AND its Zod shape,
//   so tests can assert both the HTTP contract and the input schema the agent
//   sees (required vs optional fields, fields that must not exist).
// - makeClientStub records method/path/body of every MellowClient call and
//   answers from a scripted map keyed by "<METHOD> <path-prefix>".

export type CapturedCall = { method: string; path: string; body?: unknown };

type Handler = (params: unknown) => Promise<unknown>;
type RegisteredTool = { description: string; shape: z.ZodRawShape; handler: Handler };

export function makeServerStub() {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    tool(name: string, description: string, shape: z.ZodRawShape, _annotations: unknown, handler: Handler) {
      tools.set(name, { description, shape, handler });
    },
  } as unknown as McpServer;

  const get = (name: string): RegisteredTool => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`tool not registered: ${name}`);
    return tool;
  };

  return {
    server,
    names: () => [...tools.keys()],
    description: (name: string) => get(name).description,
    schema: (name: string) => z.object(get(name).shape),
    invoke: (name: string, params: unknown) => get(name).handler(params),
  };
}

export function makeClientStub(responses: Record<string, unknown>) {
  const calls: CapturedCall[] = [];
  const respond = (method: string, path: string) => {
    // Longest matching prefix wins, so "GET /a/1" beats "GET /a".
    const key = Object.keys(responses)
      .filter((k) => {
        const [m, p] = k.split(" ");
        return m === method && path.startsWith(p);
      })
      .sort((a, b) => b.length - a.length)[0];
    if (!key) {
      throw new Error(`no scripted response for ${method} ${path}; available: ${Object.keys(responses).join(", ")}`);
    }
    const value = responses[key];
    return typeof value === "function" ? (value as (p: string) => unknown)(path) : value;
  };
  const record = (method: string) => async (path: string, body?: unknown) => {
    calls.push(body === undefined ? { method, path } : { method, path, body });
    return respond(method, path);
  };
  const stub = {
    get: record("GET"),
    post: record("POST"),
    put: record("PUT"),
    patch: record("PATCH"),
    del: record("DELETE"),
  };
  return { stub, calls };
}

export function parsedText(result: unknown): unknown {
  const r = result as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0].text);
}
