import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asStructuredList, type MellowClient } from "../mellow-client";

export function registerCompanyTools(server: McpServer, client: MellowClient) {
  server.tool(
    "listCompanies",
    "List all companies associated with the current user",
    {},
    { title: "List companies", readOnlyHint: true },
    async () => {
      const result = await client.get<unknown>("/customer/companies");
      return {
        structuredContent: asStructuredList(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "switchCompany",
    "Set the user's default company on the server (persists across sessions). WARNING: this mutates a shared default — for multi-company users with parallel sessions on the same account, prefer passing companyId per call (or set Props.activeCompanyId once at session start, which sends X-Company-Id per request without touching the shared default). Use this tool only for single-company long-lived integrations.",
    {
      companyId: z.number().describe("Company ID to switch to"),
    },
    { title: "Switch default company", idempotentHint: true },
    async ({ companyId }) => {
      const result = await client.post<unknown>(`/customer/companies/${companyId}/default`);
      return {
        structuredContent: result as { [key: string]: unknown },
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "getCompanyBalance",
    'Get the balance of the active company. Returns balanceAmount, holdAmount, toPayAmount (and VAT-related fields). There is no server-provided "available" — compute it as balanceAmount − holdAmount − toPayAmount. Call this before createTask, publishDraftTask, acceptTask, and payForTask — those four can refuse on insufficient funds, and createTask silently saves a draft instead of publishing when balance does not cover the task. If the available balance is insufficient, direct the user to top up at https://my.mellow.io/ → Finances → Top up balance (see mellow://domain § "Topping up the balance" for the full flow). There is no top-up tool in this MCP.',
    {},
    { title: "Get company balance", readOnlyHint: true },
    async () => {
      const result = await client.get<unknown>("/customer/balance");
      return {
        structuredContent: result as { [key: string]: unknown },
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );
}
