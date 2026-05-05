import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asStructuredList, asStructuredObject, type MellowClient } from "../../mellow-client";
import { currencyToId, f2bClientStatusEnum, f2bCurrencyEnum, mapCurrencyIdToCode } from "./shared";

export function registerF2bClientTools(server: McpServer, client: MellowClient) {
  server.tool(
    "f2b_createClient",
    "Create a new F2B (freelancer-to-business) legal client. Currency (EUR or USD) is fixed at creation and cannot be changed later. Required: email, country (ISO-3166 alpha-2), currency. All other fields optional. Status starts as 'not_verified' — this does NOT block invoicing; verification triggers on the client's first payment attempt. The freelancer can immediately create and send invoices to a not_verified client. There is no contactName/phone in the F2B model — do not invent these fields.",
    {
      email: z.string().email().describe("Email where the invoice link will be sent"),
      country: z.string().length(2).describe("ISO-3166 alpha-2 country code, e.g. CY, US, DE"),
      currency: f2bCurrencyEnum.describe("EUR or USD. Fixed at creation — invoices to this client must be in this currency."),
      companyName: z.string().optional().describe("Legal company name"),
      regNumber: z.string().max(30).optional().describe("Company registration number, ≤ 30 chars"),
      vat: z.string().optional().describe("VAT id (string identifier, not a percent rate)"),
      tin: z.string().optional().describe("Taxpayer identification number"),
      address: z.string().optional(),
      city: z.string().optional(),
      region: z.string().optional().describe("State/region. For country=US, must be a valid 2-letter state code."),
      postalCode: z.string().optional(),
    },
    { title: "Create F2B client" },
    async (params) => {
      const body = {
        email: params.email,
        country: params.country,
        currencyId: currencyToId(params.currency),
        companyName: params.companyName,
        regNumber: params.regNumber,
        vat: params.vat,
        tin: params.tin,
        address: params.address,
        city: params.city,
        region: params.region,
        postalCode: params.postalCode,
      };
      const result = await client.post<unknown>("/freelancer/f2b/clients/legal", body);
      const mapped = mapCurrencyIdToCode(result);
      return {
        structuredContent: asStructuredObject(mapped),
        content: [{ text: JSON.stringify(mapped, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "f2b_listClients",
    "List F2B clients of the freelancer. Backend supports filter[status][] only — search by name and date filters are NOT supported by the API; for search the agent must page through results and filter MCP-side by companyName. Returns clients with currency mapped to ISO code (EUR/USD).",
    {
      status: z
        .union([f2bClientStatusEnum, z.array(f2bClientStatusEnum)])
        .optional()
        .describe("Filter by client status. Pass a single value or an array (OR semantics)."),
      page: z.number().optional().describe("Page number (default: 1)"),
      limit: z.number().optional().describe("Page size (backend default if omitted)"),
    },
    { title: "List F2B clients", readOnlyHint: true },
    async (params) => {
      // Backend expects filter[status][]= repeated for OR semantics.
      // MellowClient.params uses URLSearchParams.set() which can't represent
      // duplicate keys — build the query string manually.
      const search = new URLSearchParams();
      if (params.page !== undefined) search.set("page", params.page.toString());
      if (params.limit !== undefined) search.set("limit", params.limit.toString());
      const statuses = Array.isArray(params.status) ? params.status : params.status ? [params.status] : [];
      for (const s of statuses) {
        search.append("filter[status][]", s);
      }
      const path = `/freelancer/f2b/clients${search.toString() ? `?${search.toString()}` : ""}`;
      const result = await client.get<unknown>(path);
      const mapped = mapCurrencyIdToCode(result);
      return {
        structuredContent: asStructuredList(mapped),
        content: [{ text: JSON.stringify(mapped, null, 2), type: "text" as const }],
      };
    },
  );
}
