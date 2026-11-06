import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asStructuredList, type MellowClient } from "../../mellow-client";
import { F2B_FIELD_DOCS } from "./invoices";
import { f2bCommissionPayerEnum, f2bLineItemSchema, mapCurrencyIdToCode, readCurrencyId, resolveInvoiceableClientCurrency } from "./shared";

// Service lookup and exact cost calculation for F2B invoices and Secure Deals.

export function registerF2bPricingTools(server: McpServer, client: MellowClient) {
  server.tool(
    "f2b_searchServices",
    "Search the Mellow service catalog for the serviceId that F2B invoices and Secure Deals require. The backend matches the search term against service titles (localized to the user's language) — there are no service descriptions, so when the user describes their work in their own words, search with 1–2 key words (e.g. 'design', 'translation', 'development'), then pick the closest title yourself and confirm it with the user. Tip: if the user has invoiced similar work before, the service of a previous invoice (f2b_listInvoices → service.id / service.title) is usually the right one — offer that first. Returns [{id, title, titleDoc}].",
    {
      search: z.string().optional().describe("Word(s) to match against service titles; omit to list the catalog"),
    },
    { title: "Search services", readOnlyHint: true },
    async ({ search }) => {
      const query = new URLSearchParams();
      if (search) query.set("filter[search]", search);
      const path = `/v2/freelancer/lookups/services${query.toString() ? `?${query.toString()}` : ""}`;
      const result = await client.get<unknown>(path);
      return {
        structuredContent: asStructuredList(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "f2b_calculateInvoiceCost",
    "Get Mellow's exact calculation for an F2B invoice or Secure Deal: what the freelancer receives ('You receive' = `received`) and what the client pays (`cost`), with the commission, VAT, sales tax and card fee split out. Returns one row per payment method (bank transfer, plus card when card payment is available). This is the ONLY source of truth for money figures — never compute commissions or 'You receive' yourself (e.g. subtracting 5%): when the freelancer pays the commission the backend uses amount / 1.05, not amount × 0.95, and rounding matters. On the card row read the money fields (received, acquiringCommission), not commissionPercent — that percent shows 5+3 even when the client bears the 3% card fee. Pass either invoiceId (existing invoice/deal) or clientId with lineItems or amount (estimate before creating).",
    {
      invoiceId: z
        .number()
        .int()
        .optional()
        .describe("Existing F2B invoice or Secure Deal id — currency and commission payer are read from it"),
      clientId: z.number().int().optional().describe("Client id for an estimate before creating — currency derives from the client"),
      commissionPayer: f2bCommissionPayerEnum.optional().describe(`${F2B_FIELD_DOCS.commissionPayer} Required for estimates.`),
      lineItems: z.array(f2bLineItemSchema).max(10).optional().describe("Line items for an estimate"),
      amount: z.number().positive().optional().describe("Total amount for an estimate (alternative to lineItems)"),
    },
    { title: "Calculate invoice cost", readOnlyHint: true },
    async (params) => {
      const body = await buildCalculateCostBody(client, params);
      const result = await client.post<unknown>("/freelancer/f2b/invoices/calculate-cost", body);
      const mapped = mapCurrencyIdToCode(result);
      return {
        structuredContent: asStructuredList(mapped),
        content: [{ text: JSON.stringify(mapped, null, 2), type: "text" as const }],
      };
    },
  );
}

type CalculateCostParams = {
  invoiceId?: number;
  clientId?: number;
  commissionPayer?: "freelancer" | "customer";
  lineItems?: z.infer<typeof f2bLineItemSchema>[];
  amount?: number;
};

async function buildCalculateCostBody(client: MellowClient, params: CalculateCostParams): Promise<Record<string, unknown>> {
  if (params.invoiceId !== undefined) {
    // The backend requires currencyId + commissionPayer even when invoiceId is
    // given; read them from the invoice so the agent only passes the id.
    const invoice = await client.get<Record<string, unknown>>(`/freelancer/f2b/invoices/${params.invoiceId}`);
    const currencyId = readCurrencyId(invoice);
    if (currencyId === undefined) {
      throw new Error(`Invoice ${params.invoiceId} response does not contain a recognisable currency.`);
    }
    return {
      invoiceId: params.invoiceId,
      currencyId,
      commissionPayer: params.commissionPayer ?? invoice.commissionPayer,
    };
  }

  if (params.clientId === undefined) {
    throw new Error("Pass invoiceId (existing invoice/deal) or clientId with lineItems or amount (estimate).");
  }
  if (!params.commissionPayer) {
    throw new Error("commissionPayer is required for an estimate — ask the user who pays the 5% commission.");
  }
  if (!params.lineItems?.length && params.amount === undefined) {
    throw new Error("An estimate needs lineItems or amount.");
  }

  const currencyId = await resolveInvoiceableClientCurrency(client, params.clientId);
  return {
    clientId: params.clientId,
    currencyId,
    commissionPayer: params.commissionPayer,
    ...(params.lineItems?.length ? { lineItems: params.lineItems } : { amount: params.amount }),
  };
}
