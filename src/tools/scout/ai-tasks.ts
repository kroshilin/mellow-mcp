import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asStructuredObject, type MellowClient } from "../../mellow-client";

export function registerScoutAiTaskTools(server: McpServer, client: MellowClient) {
  server.tool(
    "scout_generatePosition",
    "Generate a position description using AI. Returns a task ID to poll for results.",
    {
      request: z.string().min(5).max(1000).describe("Prompt describing the position to generate"),
    },
    { title: "Scout: AI-generate position" },
    async ({ request }) => {
      const result = await client.post<unknown>("/ai/tasks/generate-position", { request, source: "app" });
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "scout_getGeneratePositionTask",
    "Get the status and result of an AI position generation task",
    {
      taskId: z.string().uuid().describe("AI task UUID returned by scout_generatePosition"),
    },
    { title: "Scout: get AI generation task", readOnlyHint: true },
    async ({ taskId }) => {
      const result = await client.get<unknown>(`/ai/tasks/generate-position/${taskId}`);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );
}
