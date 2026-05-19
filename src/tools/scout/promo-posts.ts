import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asStructuredObject, type MellowClient } from "../../mellow-client";

export function registerScoutPromoPostTools(server: McpServer, client: MellowClient) {
  server.tool(
    "scout_createPromoPosts",
    "Generate promotional social media posts for a position (async). Poll with scout_getPromoPosts for results.",
    {
      positionId: z.string().uuid().describe("Position UUID"),
    },
    { title: "Scout: generate promo posts" },
    async ({ positionId }) => {
      const result = await client.post<unknown>(`/positions/${positionId}/promo-post`);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "scout_getPromoPosts",
    "Get generated promotional posts for a position",
    {
      positionId: z.string().uuid().describe("Position UUID"),
    },
    { title: "Scout: get promo posts", readOnlyHint: true },
    async ({ positionId }) => {
      const result = await client.get<unknown>(`/positions/${positionId}/promo-post`);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );
}
