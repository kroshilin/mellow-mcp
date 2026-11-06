import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { asStructuredList, type MellowClient } from "../mellow-client";
import { registerExchangeRateTool } from "./reference";

// Freelancer-side finance: own balance and Mellow's exchange rates.

export function registerFreelancerFinanceTools(server: McpServer, client: MellowClient) {
  server.tool(
    "getBalance",
    "Get the freelancer's current Mellow balance, one row per currency (amount, last transaction date, auto-payout endpoint) — the balance shown in the cabinet's Finance section. Withdrawals are NOT possible through this MCP; for payouts direct the user to https://my.mellow.io/.",
    {},
    { title: "Get my balance", readOnlyHint: true },
    async () => {
      const result = await client.get<unknown>("/profile/balance");
      return {
        structuredContent: asStructuredList(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  registerExchangeRateTool(server, client);
}
