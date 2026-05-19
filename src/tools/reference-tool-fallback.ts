import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerReferenceFallbackTool(server: McpServer, docs: { domain: string; workflows: string; antiPatterns: string }) {
  const map: Record<"mellow://domain" | "mellow://workflows" | "mellow://anti-patterns", string> = {
    "mellow://domain": docs.domain,
    "mellow://workflows": docs.workflows,
    "mellow://anti-patterns": docs.antiPatterns,
  };

  server.tool(
    "mellow_read_reference",
    "Read one of the Mellow reference documents. Use this when the client doesn't surface MCP resources directly. Available URIs: mellow://domain (full domain guide — actors, state machines, decision trees), mellow://workflows (12 end-to-end recipes), mellow://anti-patterns (common agent mistakes catalogue).",
    {
      uri: z.enum(["mellow://domain", "mellow://workflows", "mellow://anti-patterns"]).describe("Reference document URI to read."),
    },
    { title: "Read Mellow reference doc", readOnlyHint: true },
    async ({ uri }) => {
      const text = map[uri];
      return {
        // Hand-built object literal — already a record, no asStructuredObject wrap needed.
        structuredContent: { uri, mimeType: "text/markdown", text } as { [key: string]: unknown },
        content: [{ type: "text" as const, text }],
      };
    },
  );
}
