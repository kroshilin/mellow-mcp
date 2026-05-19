import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asStructuredList, asStructuredObject, type MellowClient } from "../mellow-client";

export function registerTaskGroupTools(server: McpServer, client: MellowClient) {
  server.tool("listTaskGroups", "List all task groups", {}, { title: "List task groups", readOnlyHint: true }, async () => {
    const result = await client.get<unknown>("/customer/task-groups");
    return {
      structuredContent: asStructuredList(result),
      content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
    };
  });

  server.tool(
    "createTaskGroup",
    "Create a new task group",
    {
      title: z.string().describe("Group title"),
    },
    { title: "Create task group" },
    async ({ title }) => {
      const result = await client.post<unknown>("/customer/task-groups", { title });
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "renameTaskGroup",
    "Rename an existing task group",
    {
      groupId: z.number().describe("Group ID to rename"),
      title: z.string().describe("New group title"),
    },
    { title: "Rename task group", idempotentHint: true },
    async (params) => {
      const result = await client.put<unknown>("/customer/task-groups", params);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "deleteTaskGroup",
    "Delete a task group",
    {
      groupId: z.number().describe("Group ID to delete"),
    },
    { title: "Delete task group", destructiveHint: true, idempotentHint: true },
    async ({ groupId }) => {
      const result = await client.del<unknown>("/customer/task-groups", { groupId });
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );
}
