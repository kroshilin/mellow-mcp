import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asStructuredObject, type MellowClient } from "../../mellow-client";

export function registerScoutLookupTools(server: McpServer, client: MellowClient) {
  server.tool(
    "scout_getCountries",
    "Get list of available countries. Returns `items: [{code, name}]` — the backend sends a bare map (`{AF: 'Afghanistan', ...}`); this MCP transforms it to a list for consistency with every other list endpoint. The original map is preserved under `raw` for power users.",
    {},
    { title: "Scout: get countries", readOnlyHint: true },
    async () => {
      const result = await client.get<Record<string, string>>("/lookup/countries");
      const items = Object.entries(result).map(([code, name]) => ({ code, name }));
      const structured = { items, raw: result };
      return {
        structuredContent: structured,
        content: [{ text: JSON.stringify(structured, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "scout_getShortLink",
    "Get a short link by reference type and ID",
    {
      referenceType: z.string().describe("Reference type (e.g. POSITION)"),
      referenceId: z.string().uuid().describe("Reference UUID"),
    },
    { title: "Scout: get short link", readOnlyHint: true },
    async ({ referenceType, referenceId }) => {
      // Backend Symfony validator expects snake_case query keys —
      // camelCase 422s on `reference_id`. Keep camelCase on the agent surface.
      const result = await client.get<unknown>("/short-link/", {
        reference_type: referenceType,
        reference_id: referenceId,
      });
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );
}
