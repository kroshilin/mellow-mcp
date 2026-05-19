import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asStructuredList, asStructuredObject, type MellowClient } from "../../mellow-client";

export function registerScoutPositionTools(server: McpServer, client: MellowClient) {
  server.tool(
    "scout_listPositions",
    "List hiring positions with pagination and sorting",
    {
      page: z.number().optional().describe("Page number (default: 1)"),
      limit: z.number().max(100).optional().describe("Items per page (max 100, default: 20)"),
      sortDirection: z.enum(["ASC", "DESC"]).optional().describe("Sort direction (default: DESC)"),
    },
    { title: "Scout: list positions", readOnlyHint: true },
    async (params) => {
      const result = await client.get<unknown>("/positions", {
        page: params.page?.toString(),
        limit: params.limit?.toString(),
        sortField: "createdAt",
        sortDirection: params.sortDirection,
      });
      return {
        structuredContent: asStructuredList(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "scout_getPosition",
    "Get a position by UUID or short code",
    {
      positionId: z.string().describe("Position UUID or 8-character short code"),
      trackView: z.boolean().optional().describe("Whether to track this as a view"),
    },
    { title: "Scout: get position", readOnlyHint: true },
    async ({ positionId, trackView }) => {
      const result = await client.get<unknown>(`/positions/${positionId}`, {
        trackView: trackView?.toString(),
      });
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "scout_createPosition",
    "Create a new hiring position",
    {
      title: z.string().describe("Position title"),
      summary: z.string().optional().describe("Short summary of the position"),
      description: z.string().describe("Position description"),
      company: z
        .object({
          id: z.string().uuid().optional().describe("Existing company UUID"),
          name: z.string().describe("Company name"),
          website: z.string().url().describe("Company website URL"),
        })
        .describe("Company details"),
      workModel: z.enum(["remote", "onsite"]).describe("Work model"),
      isBudgetNegotiable: z.boolean().describe("Whether budget is negotiable"),
      projectType: z.enum(["ongoing", "one-time"]).describe("Project type"),
      workload: z
        .enum([
          "under_20_hrs_per_week",
          "between_20_30_hrs_per_week",
          "over_30_hrs_per_week",
          "few_days",
          "one_two_weeks",
          "more_two_weeks",
        ])
        .describe("Workload. Must match projectType: ongoing → hrs options, one-time → days/weeks options"),
      experienceLevel: z.number().min(1).max(4).describe("Experience level: 1=junior, 2=middle, 3=senior, 4=top-tier"),
      skills: z.array(z.string()).min(1).max(20).describe("Required skills (1-20 unique strings)"),
      languages: z
        .array(z.enum(["en", "zh", "nl", "fr", "de", "id", "it", "ja", "ko", "pl", "pt", "es", "tr", "ru"]))
        .min(1)
        .max(3)
        .optional()
        .describe("Required languages (1-3, ISO codes)"),
      location: z.string().optional().describe("Location (required if onsite)"),
      timezone: z.string().optional().describe("IANA timezone (e.g. Europe/London)"),
      paymentType: z.enum(["hourly", "monthly", "fixed"]).optional().describe("Payment type (required if budget not negotiable)"),
      currency: z.enum(["eur", "usd"]).optional().describe("Currency (required if budget not negotiable)"),
      budgetFrom: z.number().optional().describe("Budget lower bound"),
      budgetTo: z.number().optional().describe("Budget upper bound"),
      budget: z.number().optional().describe("Exact budget amount"),
      aiTaskId: z.string().uuid().optional().describe("AI generation task ID that created this position"),
    },
    { title: "Scout: create position" },
    async (params) => {
      const result = await client.post<unknown>("/positions", params);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "scout_updatePosition",
    "Update an existing position",
    {
      positionId: z.string().uuid().describe("Position UUID"),
      title: z.string().describe("Position title"),
      summary: z.string().optional().describe("Short summary of the position"),
      description: z.string().describe("Position description"),
      company: z
        .object({
          id: z.string().uuid().optional().describe("Existing company UUID"),
          name: z.string().describe("Company name"),
          website: z.string().url().describe("Company website URL"),
        })
        .describe("Company details"),
      workModel: z.enum(["remote", "onsite"]).describe("Work model"),
      isBudgetNegotiable: z.boolean().describe("Whether budget is negotiable"),
      projectType: z.enum(["ongoing", "one-time"]).describe("Project type"),
      workload: z
        .enum([
          "under_20_hrs_per_week",
          "between_20_30_hrs_per_week",
          "over_30_hrs_per_week",
          "few_days",
          "one_two_weeks",
          "more_two_weeks",
        ])
        .describe("Workload. Must match projectType: ongoing → hrs options, one-time → days/weeks options"),
      experienceLevel: z.number().min(1).max(4).describe("Experience level: 1=junior, 2=middle, 3=senior, 4=top-tier"),
      skills: z.array(z.string()).min(1).max(20).describe("Required skills (1-20 unique strings)"),
      languages: z
        .array(z.enum(["en", "zh", "nl", "fr", "de", "id", "it", "ja", "ko", "pl", "pt", "es", "tr", "ru"]))
        .min(1)
        .max(3)
        .optional()
        .describe("Required languages (1-3, ISO codes)"),
      location: z.string().optional().describe("Location (required if onsite)"),
      timezone: z.string().optional().describe("IANA timezone (e.g. Europe/London)"),
      paymentType: z.enum(["hourly", "monthly", "fixed"]).optional().describe("Payment type"),
      currency: z.enum(["eur", "usd"]).optional().describe("Currency"),
      budgetFrom: z.number().optional().describe("Budget lower bound"),
      budgetTo: z.number().optional().describe("Budget upper bound"),
      budget: z.number().optional().describe("Exact budget amount"),
    },
    { title: "Scout: update position", idempotentHint: true },
    async ({ positionId, ...body }) => {
      const result = await client.put<unknown>(`/positions/${positionId}`, body);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "scout_closePosition",
    "Close a position so it no longer accepts applications",
    {
      positionId: z.string().uuid().describe("Position UUID"),
    },
    { title: "Scout: close position", idempotentHint: true },
    async ({ positionId }) => {
      const result = await client.del<unknown>(`/positions/${positionId}`);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "scout_openPosition",
    "Reopen a previously closed position",
    {
      positionId: z.string().uuid().describe("Position UUID"),
    },
    { title: "Scout: reopen position", idempotentHint: true },
    async ({ positionId }) => {
      const result = await client.post<unknown>(`/positions/${positionId}/open`);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "scout_sharePosition",
    "Share a position on a social network. Pass shareTarget = the social network identifier (e.g. 'linkedin', 'twitter', 'facebook'). Backend does not block sharing CLOSED or un-moderated positions — verify status='active' on the agent side first.",
    {
      positionId: z.string().uuid().describe("Position UUID"),
      shareTarget: z.string().describe("Social network identifier (e.g. 'linkedin', 'twitter', 'facebook')"),
    },
    { title: "Scout: share position", openWorldHint: true },
    async ({ positionId, shareTarget }) => {
      const result = await client.post<unknown>(`/positions/${positionId}/share`, { shareTarget });
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );
}
