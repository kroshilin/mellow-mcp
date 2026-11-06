import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asStructuredList, asStructuredObject, type MellowClient } from "../../mellow-client";
import { describeActiveRecords, findActiveRecordsForClient } from "./client-activity";
import { currencyToId, f2bClientStatusEnum, f2bCurrencyEnum, mapCurrencyIdToCode } from "./shared";

export function registerF2bClientTools(server: McpServer, client: MellowClient) {
  server.tool(
    "f2b_createClient",
    "Create a new F2B (freelancer-to-business) legal client (a company). Ask the user for exactly four things — the same four the Mellow cabinet form asks: company name, email, country, currency. Do NOT ask for VAT, TIN, registration number or address: the client fills those in themselves on the invoice payment page ('Confirm details'), and they drive the client's verification and tax calculation. Currency (EUR or USD) is fixed at creation and cannot be changed later — confirm it with the user. Status starts as 'not_verified' — this does NOT block invoicing; verification happens when the client confirms details / pays. Several clients can be created in one conversation by calling this tool once per client.",
    {
      companyName: z.string().min(1).describe("Client's legal company name — required, always ask the user"),
      email: z.string().email().describe("Email where the invoice link will be sent"),
      country: z.string().length(2).describe("ISO-3166 alpha-2 country code, e.g. CY, US, DE"),
      currency: f2bCurrencyEnum.describe("EUR or USD. Fixed at creation — invoices to this client must be in this currency."),
    },
    { title: "Create F2B client" },
    async (params) => {
      const body = {
        email: params.email,
        country: params.country,
        currencyId: currencyToId(params.currency),
        companyName: params.companyName,
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

  server.tool(
    "f2b_updateClient",
    "Update an existing F2B legal client — the same fields the freelancer can edit in the Mellow cabinet: company name, email, country. Currency and type are immutable. VAT / TIN / registration number / address are entered by the client on the payment page, not by the freelancer — do not offer to change them. The backend only allows edits while the client is not yet verified. Pass only the fields you want to change; omitted fields keep their current value.",
    {
      clientId: z.number().int().describe("Numeric client id (from f2b_createClient or f2b_listClients)"),
      companyName: z.string().min(1).optional().describe("Legal company name"),
      email: z.string().email().optional().describe("Email where invoice links go"),
      country: z.string().length(2).optional().describe("ISO-3166 alpha-2 country code"),
    },
    { title: "Update F2B client" },
    async (params) => {
      // Whitelist of mutable fields. currency/type are immutable on the backend
      // by design — never forward them, even if Zod somewhere lets an unknown
      // key through. Omitted fields = "no change" on backend.
      const mutable = ["email", "country", "companyName"] as const;
      const body: Record<string, unknown> = { clientId: params.clientId };
      for (const key of mutable) {
        const value = params[key];
        if (value !== undefined) body[key] = value;
      }
      const result = await client.put<unknown>("/freelancer/f2b/clients/legal", body);
      const mapped = mapCurrencyIdToCode(result);
      return {
        structuredContent: asStructuredObject(mapped),
        content: [{ text: JSON.stringify(mapped, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "f2b_archiveClient",
    "Delete a client — Mellow archives it (status → 'archived'); this is what the cabinet's 'Delete client' does, for invoice and Secure Deal clients alike. Condition: the client must have NO active invoices or Secure Deals — active means any status other than new (draft), paid, finished and cancelled. The tool checks this itself and refuses, listing the blocking invoices/deals, if any exist; tell the user to wait until they are paid/finished or cancel them first. Irreversible: there is no un-archive — to work with the client again, create a new one. ALWAYS confirm with the user first, naming the client (company or person name and email); call only after an explicit 'yes'. Composite: GET client → active invoice/deal check → DELETE /freelancer/f2b/clients.",
    {
      clientId: z.number().int().describe("Numeric client id"),
    },
    { title: "Delete (archive) F2B client", destructiveHint: true },
    async (params) => {
      const existing = mapCurrencyIdToCode(await client.get<Record<string, unknown>>(`/freelancer/f2b/clients/${params.clientId}`));
      const name = existing.companyName ?? existing.fullName ?? existing.email ?? `id ${params.clientId}`;
      if (existing.status === "archived") {
        throw new Error(`Client ${name} (id ${params.clientId}) is already deleted (archived).`);
      }
      const email = typeof existing.email === "string" ? existing.email : undefined;
      const active = await findActiveRecordsForClient(client, params.clientId, email);
      if (active.length > 0) {
        throw new Error(
          `Client ${name} (id ${params.clientId}) cannot be deleted: it has ${active.length} active invoice(s)/deal(s): ${describeActiveRecords(active)}. A client can be deleted only when all its invoices and deals are new (draft), paid, finished or cancelled.`,
        );
      }
      // Backend takes clientId in the request body (not the path).
      const result = await client.del<unknown>("/freelancer/f2b/clients", { clientId: params.clientId });
      const mapped = {
        archived: true,
        client: { id: params.clientId, name, email, previousStatus: existing.status },
        raw: mapCurrencyIdToCode(result),
      };
      return {
        structuredContent: asStructuredObject(mapped),
        content: [{ text: JSON.stringify(mapped, null, 2), type: "text" as const }],
      };
    },
  );
}
