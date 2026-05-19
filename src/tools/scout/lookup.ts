import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asStructuredList, asStructuredObject, type MellowClient } from "../../mellow-client";

export function registerScoutLookupTools(server: McpServer, client: MellowClient) {
  server.tool(
    "scout_getCountries",
    "Get list of available countries with codes",
    {},
    { title: "Scout: get countries", readOnlyHint: true },
    async () => {
      const result = await client.get<unknown>("/lookup/countries");
      return {
        structuredContent: asStructuredList(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
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
      const result = await client.get<unknown>("/short-link/", {
        referenceType,
        referenceId,
      });
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );
}
