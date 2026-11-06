import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asStructuredList, type MellowClient } from "../mellow-client";

/** Registered in both company and freelancer mode — /exchanges is not role-gated. */
export function registerExchangeRateTool(server: McpServer, client: MellowClient) {
  server.tool(
    "getExchangeRate",
    "Get Mellow's current currency exchange rates — the same rates the Mellow cabinet shows. Returns an array of {base, target, rate} triples. Quote rates from this tool; never use rates from memory or the web when the user asks about Mellow's rates.",
    {},
    { title: "Get exchange rates", readOnlyHint: true },
    async () => {
      const result = await client.get<unknown>("/exchanges");
      return {
        structuredContent: asStructuredList(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );
}

export function registerReferenceTools(server: McpServer, client: MellowClient) {
  server.tool("getCurrencies", "Get list of available currencies", {}, { title: "Get currencies", readOnlyHint: true }, async () => {
    const result = await client.get<unknown>("/lookups/currencies");
    return {
      structuredContent: asStructuredList(result),
      content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
    };
  });

  registerExchangeRateTool(server, client);

  server.tool(
    "getTaxStatuses",
    "Get list of available tax statuses",
    {},
    { title: "Get taxation statuses", readOnlyHint: true },
    async () => {
      const result = await client.get<unknown>("/lookups/taxation-statuses");
      return {
        structuredContent: asStructuredList(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool("getServices", "Get list of services and works", {}, { title: "Get service catalog", readOnlyHint: true }, async () => {
    const result = await client.get<unknown>("/customer/lookups/services");
    return {
      structuredContent: asStructuredList(result),
      content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
    };
  });

  server.tool(
    "getTaskAttributes",
    "Get the catalog of task attributes (with types and options). The endpoint returns the global catalog; pass categoryId to filter client-side after fetching, or rely on the agent to scope by category from the response.",
    {
      categoryId: z
        .number()
        .optional()
        .describe(
          "Optional category ID for client-side filtering. The endpoint always returns the full catalog — agent should filter the result by categoryId where each attribute belongs.",
        ),
    },
    { title: "Get task attributes catalog", readOnlyHint: true },
    async () => {
      const result = await client.get<unknown>("/customer/lookups/service-attributes");
      return {
        structuredContent: asStructuredList(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "getAcceptanceDocuments",
    "Get list of additional documents for task acceptance",
    {},
    { title: "Get acceptance document templates", readOnlyHint: true },
    async () => {
      const result = await client.get<unknown>("/customer/lookups/acceptance-files");
      return {
        structuredContent: asStructuredList(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "getTaxDocumentTypes",
    "Returns possible tax-document types and their validation regexes. Pass `taxResidenceCountry` (alpha-2, e.g. RU, US, KZ) to scope the list to one country — strongly recommended, otherwise the response is the full cross-country catalogue. Use the result to validate `taxNumber` shape before calling tax-info update endpoints. Pair with `getFreelancerTaxInfo.taxResidenceCountry` to scope correctly.",
    {
      taxResidenceCountry: z
        .string()
        .optional()
        .describe(
          "Alpha-2 country code (e.g. RU, US, KZ). Optional but recommended — without it the response includes types across all countries. Returns 422 if the code is not a valid alpha-2.",
        ),
    },
    { title: "Get tax document types", readOnlyHint: true },
    async ({ taxResidenceCountry }) => {
      const result = await client.get<unknown>("/customer/freelancers/tax-document-types", {
        taxResidenceCountry,
      });
      return {
        structuredContent: asStructuredList(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "getSpecializations",
    "Get list of freelancer specializations",
    {},
    { title: "Get freelancer specializations", readOnlyHint: true },
    async () => {
      const result = await client.get<unknown>("/lookups/specializations");
      return {
        structuredContent: asStructuredList(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool("getCountries", "Get list of country codes", {}, { title: "Get countries", readOnlyHint: true }, async () => {
    const result = await client.get<unknown>("/lookups/countries");
    return {
      structuredContent: asStructuredList(result),
      content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
    };
  });
}
