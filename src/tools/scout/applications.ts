import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asStructuredList, asStructuredObject, type MellowClient } from "../../mellow-client";

export function registerScoutApplicationTools(server: McpServer, client: MellowClient) {
  server.tool(
    "scout_listApplications",
    "List all applications across all positions with pagination",
    {
      page: z.number().optional().describe("Page number (default: 1)"),
      limit: z.number().max(100).optional().describe("Items per page (max 100, default: 20)"),
      sortDirection: z.enum(["ASC", "DESC"]).optional().describe("Sort direction (default: DESC)"),
    },
    { title: "Scout: list applications", readOnlyHint: true },
    async (params) => {
      const result = await client.get<unknown>("/applications", {
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
    "scout_listPositionApplications",
    "List applications for a specific position",
    {
      positionId: z.string().uuid().describe("Position UUID"),
      page: z.number().optional().describe("Page number (default: 1)"),
      limit: z.number().max(100).optional().describe("Items per page (max 100, default: 20)"),
      sortDirection: z.enum(["ASC", "DESC"]).optional().describe("Sort direction (default: DESC)"),
    },
    { title: "Scout: list position applications", readOnlyHint: true },
    async ({ positionId, ...params }) => {
      const result = await client.get<unknown>(`/positions/${positionId}/applications`, {
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
    "scout_getApplication",
    "Get details of a specific application. If trackStatus=true, the server transitions a 'new' application to 'in_review' as a side-effect.",
    {
      applicationId: z.string().uuid().describe("Application UUID"),
      trackStatus: z.boolean().optional().describe("If true, server transitions status to in_review."),
    },
    { title: "Scout: get application", readOnlyHint: true },
    async ({ applicationId, trackStatus }) => {
      const result = await client.get<unknown>(`/applications/${applicationId}`, {
        trackStatus: trackStatus?.toString(),
      });
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "scout_changeApplicationStatus",
    "Change the status of an application. Backend has NO transition guards — any transition is accepted (e.g. rejected → short_list). Agent should reject obviously-wrong transitions before calling. Note: 'accepted' is NOT a valid status; finalize a candidate by inviting them into CoR via inviteFreelancer.",
    {
      applicationId: z.string().uuid().describe("Application UUID"),
      status: z
        .enum(["new", "in_review", "short_list", "rejected"])
        .describe("New application status (one of: new, in_review, short_list, rejected)"),
    },
    { title: "Scout: change application status", idempotentHint: true },
    async ({ applicationId, status }) => {
      const result = await client.patch<unknown>(`/applications/${applicationId}/status`, { status });
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "scout_inviteApplicant",
    "Send an email invitation with the hirer's contact info to the applicant. Does NOT change the application's status and does NOT move the applicant into any pool. Sets invitedAt. Second call returns HTTP 409 and is irreversible.",
    {
      applicationId: z.string().uuid().describe("Application UUID"),
    },
    { title: "Scout: invite applicant", openWorldHint: true },
    async ({ applicationId }) => {
      const result = await client.post<unknown>(`/applications/${applicationId}/invite`);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );
}
