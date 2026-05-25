import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { asStructuredList, type MellowClient } from "../../mellow-client";

export function registerScoutCompanyTools(server: McpServer, client: MellowClient) {
  server.tool(
    "scout_listCompanies",
    "List Scout companies for the current user. WARNING: the backend does not dedupe by (name, website) — you may see multiple entries for the same company with different UUIDs (caused by prior `scout_createPosition` calls that omitted `company.id`). Pick the most recently active one (highest `created_at` if exposed; otherwise pick any and surface the ambiguity to the user). When creating a position, always pass the chosen `company.id` to avoid auto-creating yet another duplicate.",
    {},
    { title: "Scout: list companies", readOnlyHint: true },
    async () => {
      const result = await client.get<unknown>("/companies");
      return {
        structuredContent: asStructuredList(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );
}
