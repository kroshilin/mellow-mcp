import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asStructuredList, asStructuredObject, type MellowClient } from "../mellow-client";

export function registerDocumentTools(server: McpServer, client: MellowClient) {
  server.tool(
    "listDocuments",
    "List documents (invoices and period reports). Filter by date range and/or type. Returns INVOICE (type=6) and REPORT (type=7) entries by default.",
    {
      dateFrom: z.string().optional().describe("Filter from date (YYYY-MM-DD). Inclusive lower bound."),
      dateTo: z.string().optional().describe("Filter to date (YYYY-MM-DD). Inclusive upper bound."),
      type: z.number().optional().describe("Document type. 6 = INVOICE (top-up invoice), 7 = REPORT (period closing report)."),
      page: z.number().optional().describe("Page number"),
      size: z.number().max(500).optional().describe("Page size (max 500)"),
    },
    { title: "List documents", readOnlyHint: true },
    async (params) => {
      const result = await client.get<unknown>("/customer/documents", {
        "filter[dateFrom]": params.dateFrom,
        "filter[dateTo]": params.dateTo,
        "filter[type]": params.type?.toString(),
        page: params.page?.toString(),
        size: params.size?.toString(),
      });
      return {
        structuredContent: asStructuredList(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "downloadDocument",
    "Download a specific document by ID.",
    {
      documentId: z.number().describe("Document ID"),
    },
    { title: "Download document", readOnlyHint: true },
    async ({ documentId }) => {
      const result = await client.get<unknown>(`/customer/documents/${documentId}/download`);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );
}
