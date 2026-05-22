import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asStructuredObject, type MellowClient } from "../mellow-client";

export function registerWebhookTools(server: McpServer, client: MellowClient) {
  server.tool(
    "getWebhook",
    "Get the current webhook configuration. Backend returns HTTP 404 with empty body when no webhook has been configured for the active company — this is the expected 'no webhook yet' signal, not a real error. After createOrUpdateWebhook this returns the saved config.",
    {},
    { title: "Get webhook", readOnlyHint: true },
    async () => {
      const result = await client.get<unknown>("/customer/web-hook");
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "createOrUpdateWebhook",
    "Create or update a webhook configuration. Only one webhook per company; receiver MUST be idempotent (up to 6 retries within ~30 minutes).",
    {
      url: z.string().describe("Webhook URL to receive events"),
      events: z.array(z.string()).describe("List of event types to subscribe to"),
    },
    { title: "Create or update webhook", idempotentHint: true },
    async (params) => {
      const result = await client.post<unknown>("/webhooks", params);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "deleteWebhook",
    "Delete a webhook.",
    {
      webhookId: z.number().describe("Webhook ID to delete"),
    },
    { title: "Delete webhook", destructiveHint: true, idempotentHint: true },
    async ({ webhookId }) => {
      const result = await client.del<unknown>(`/webhooks/${webhookId}`);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );
}
