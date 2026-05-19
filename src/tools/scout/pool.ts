import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asStructuredList, asStructuredObject, type MellowClient } from "../../mellow-client";

export function registerScoutPoolTools(server: McpServer, client: MellowClient) {
  server.tool(
    "scout_getPool",
    "Get the current user's private freelancer pool",
    {},
    { title: "Scout: get pool", readOnlyHint: true },
    async () => {
      const result = await client.get<unknown>("/private-pools/");
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "scout_listPoolFreelancers",
    "List freelancers in a private pool with search, pagination and sorting",
    {
      poolId: z.string().uuid().describe("Pool UUID"),
      search: z.string().optional().describe("Search by name, email, or expertise area"),
      page: z.number().optional().describe("Page number (default: 1)"),
      limit: z.number().max(100).optional().describe("Items per page (max 100, default: 20)"),
      sortDirection: z.enum(["ASC", "DESC"]).optional().describe("Sort direction (default: DESC)"),
    },
    { title: "Scout: list pool freelancers", readOnlyHint: true },
    async ({ poolId, ...params }) => {
      const result = await client.get<unknown>(`/private-pools/${poolId}/freelancers/`, {
        search: params.search,
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
    "scout_getPoolFreelancer",
    "Get details of a specific freelancer in a pool",
    {
      poolId: z.string().uuid().describe("Pool UUID"),
      freelancerId: z.string().uuid().describe("Freelancer UUID"),
    },
    { title: "Scout: get pool freelancer", readOnlyHint: true },
    async ({ poolId, freelancerId }) => {
      const result = await client.get<unknown>(`/private-pools/${poolId}/freelancers/${freelancerId}`);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "scout_createPoolFreelancer",
    "Add a freelancer to a private pool",
    {
      poolId: z.string().uuid().describe("Pool UUID"),
      firstName: z.string().describe("First name"),
      lastName: z.string().describe("Last name"),
      email: z.string().email().describe("Email address"),
      expertiseArea: z.string().describe("Area of expertise"),
      experienceYears: z.number().min(0).optional().describe("Years of experience (increments of 0.5)"),
      cvFileId: z.string().uuid().optional().describe("Uploaded CV attachment UUID"),
      notes: z.string().max(5000).optional().describe("Notes about the freelancer"),
      portfolioLinks: z.array(z.string().url()).max(4).optional().describe("Portfolio URLs (max 4)"),
      residenceCountry: z.string().optional().describe("ISO country code"),
    },
    { title: "Scout: add freelancer to pool", openWorldHint: true },
    async ({ poolId, ...body }) => {
      const result = await client.post<unknown>(`/private-pools/${poolId}/freelancers/`, body);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "scout_editPoolFreelancer",
    "Edit a freelancer in a private pool. PUT semantics — fields not passed are reset to null. Pass every field you want to keep, including residenceCountry, notes, cvFileId, portfolioLinks.",
    {
      poolId: z.string().uuid().describe("Pool UUID"),
      freelancerId: z.string().uuid().describe("Freelancer UUID"),
      firstName: z.string().describe("First name"),
      lastName: z.string().describe("Last name"),
      email: z.string().email().describe("Email address"),
      expertiseArea: z.string().describe("Area of expertise"),
      experienceYears: z.number().min(0).describe("Years of experience (increments of 0.5)"),
      cvFileId: z.string().uuid().optional().describe("Uploaded CV attachment UUID"),
      notes: z.string().max(5000).optional().describe("Notes about the freelancer"),
      portfolioLinks: z.array(z.string().url()).max(4).optional().describe("Portfolio URLs (max 4)"),
      residenceCountry: z.string().optional().describe("ISO country code"),
    },
    { title: "Scout: edit pool freelancer", idempotentHint: true },
    async ({ poolId, freelancerId, ...body }) => {
      const result = await client.put<unknown>(`/private-pools/${poolId}/freelancers/${freelancerId}`, body);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "scout_deletePoolFreelancer",
    "Remove a freelancer from a private pool",
    {
      poolId: z.string().uuid().describe("Pool UUID"),
      freelancerId: z.string().uuid().describe("Freelancer UUID"),
    },
    { title: "Scout: remove freelancer from pool", destructiveHint: true, idempotentHint: true },
    async ({ poolId, freelancerId }) => {
      const result = await client.del<unknown>(`/private-pools/${poolId}/freelancers/${freelancerId}`);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "scout_deletePoolFreelancersBatch",
    "Remove multiple freelancers from a private pool at once. WARNING: backend has no batch-size cap — a single call can empty the entire pool. Confirm with the user explicitly when ids.length > 10. Irreversible.",
    {
      poolId: z.string().uuid().describe("Pool UUID"),
      ids: z.array(z.string().uuid()).describe("Array of freelancer UUIDs to delete"),
    },
    { title: "Scout: batch remove pool freelancers", destructiveHint: true },
    async ({ poolId, ids }) => {
      const result = await client.del<unknown>(`/private-pools/${poolId}/freelancers/`, { ids });
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );
}
