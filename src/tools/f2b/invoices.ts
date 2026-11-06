import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asStructuredList, asStructuredObject, type MellowClient } from "../../mellow-client";
import {
  f2bCommissionPayerEnum,
  f2bInvoiceStatusEnum,
  f2bLineItemSchema,
  mapCurrencyIdToCode,
  resolveInvoiceableClientCurrency,
} from "./shared";

/** Shared descriptions so create / update / duplicate explain fields identically. */
export const F2B_FIELD_DOCS = {
  serviceId:
    "Service id from the Mellow service catalog. Find it with f2b_searchServices (search by the service name the user describes), or reuse the service of one of the user's previous invoices (f2b_listInvoices → service.id). Never tell the user to look up the id in the cabinet — the cabinet UI does not show ids.",
  serviceName: "Invoice title shown to the client (what the work is), no HTML, 1–1024 chars",
  serviceStartDate: "ISO date YYYY-MM-DD — first day of the work period (when the work was/will be done)",
  serviceEndDate:
    "ISO date YYYY-MM-DD — last day of the work period, i.e. the period during which the work was or will be performed. Printed as 'Period from … to …' on the invoice. It is NOT a payment due date.",
  invoiceDate: "ISO date YYYY-MM-DD — issuance date; the backend rejects future dates",
  commissionPayer:
    "Who pays Mellow's 5% service commission: 'freelancer' (taken out of the amount) or 'customer' (added on top for the client). Get the exact resulting figures from f2b_calculateInvoiceCost — never compute them yourself.",
  acquiringEnabled:
    "false (default) → client can pay by bank transfer only. true → client may also pay by card. The card fee (3%) is ALWAYS paid by the client on top; it never reduces what the freelancer receives. The 5% service commission is paid by whoever commissionPayer says.",
} as const;

export function registerF2bInvoiceTools(server: McpServer, client: MellowClient) {
  server.tool(
    "f2b_createInvoiceDraft",
    "Create an F2B invoice in draft status (`new`). Email is NOT sent to the client at this step — this is the preview half of the mandatory two-step send. Currency is derived from the target client. Before calling, collect from the user: client, invoice title (serviceName), service (serviceId — see its field doc), work period, line items, who pays the commission, and whether card payment is allowed. Composite under the hood: GET client → POST /v2/invoices. After creating, call f2b_calculateInvoiceCost({invoiceId}) and show the user the exact 'You receive' (received) and client total (cost) before f2b_sendInvoiceDraft. Backend limits: ≤ 10 line items, total amount ≤ 10 000 in client currency, invoiceDate must be ≤ today. Public payment URL does NOT exist until f2b_sendInvoiceDraft is called.",
    {
      clientId: z.number().int().describe("Numeric client id (currency derives from this client)"),
      serviceId: z.number().int().describe(F2B_FIELD_DOCS.serviceId),
      serviceName: z.string().min(1).max(1024).describe(F2B_FIELD_DOCS.serviceName),
      serviceStartDate: z.string().describe(F2B_FIELD_DOCS.serviceStartDate),
      serviceEndDate: z.string().describe(F2B_FIELD_DOCS.serviceEndDate),
      invoiceDate: z.string().describe(F2B_FIELD_DOCS.invoiceDate),
      lineItems: z
        .array(f2bLineItemSchema)
        .min(1)
        .max(10)
        .describe("1–10 line items; sum of price*quantity must be ≤ 10 000 in client currency"),
      commissionPayer: f2bCommissionPayerEnum.describe(F2B_FIELD_DOCS.commissionPayer),
      acquiringEnabled: z.boolean().optional().describe(F2B_FIELD_DOCS.acquiringEnabled),
    },
    { title: "Create F2B invoice draft" },
    async (params) => {
      // Step 1: load the target client to derive currencyId and pre-validate
      // status (clearer error for the agent than a raw backend 422).
      const currencyId = await resolveInvoiceableClientCurrency(client, params.clientId);

      // Step 2: create the draft. Backend response includes the full breakdown
      // (commissionPercent, total, payable, salesTax) — that's the preview the
      // agent shows the user before f2b_sendInvoiceDraft.
      const body = {
        clientId: params.clientId,
        currencyId,
        commissionPayer: params.commissionPayer,
        serviceId: params.serviceId,
        serviceName: params.serviceName,
        serviceStartDate: params.serviceStartDate,
        serviceEndDate: params.serviceEndDate,
        invoiceDate: params.invoiceDate,
        lineItems: params.lineItems,
        acquiringEnabled: params.acquiringEnabled ?? false,
      };
      const created = await client.post<unknown>("/freelancer/f2b/v2/invoices", body);
      // mapCurrencyIdToCode handles both backend shapes (flat currencyId
      // and nested {currency, id}). No extra annotation needed — adding
      // one was clobbering the nested object and putting the whole
      // response into `currency` on unknown ids (review feedback PR #13).
      const mapped = mapCurrencyIdToCode(created);
      return {
        structuredContent: asStructuredObject(mapped),
        content: [{ text: JSON.stringify(mapped, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "f2b_sendInvoiceDraft",
    "Send a previously created F2B invoice draft to the client. Triggers email to client.email and exposes the public paymentUrl in the response. Transitions invoice status from 'new' → 'sent'. Backend returns 422 if the invoice is not in 'new', or if client.status is in {archived, suspended}. AGENT confirmation rule applies: confirm client, line items, work period, client total (cost) and 'You receive' (received, from f2b_calculateInvoiceCost) with the user before calling — once this returns, the email is in the client's inbox and the only recovery is f2b_cancelInvoice (which the client also gets notified of).",
    {
      invoiceId: z.number().int().describe("Numeric invoice id from f2b_createInvoiceDraft"),
    },
    { title: "Send F2B invoice draft" },
    async ({ invoiceId }) => {
      const result = await client.post<unknown>("/freelancer/f2b/invoices/send", { invoiceId });
      const mapped = mapCurrencyIdToCode(result);
      return {
        structuredContent: asStructuredObject(mapped),
        content: [{ text: JSON.stringify(mapped, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "f2b_getInvoice",
    "Get one F2B invoice with full details. If the invoice has acquiringEnabled=true and status is 'sent' or 'payment_queued', additionally fetches the public /payment-status endpoint to surface the acquiring transaction state ('notInitiated' | 'initiated' | 'completed' | 'failed') under `paymentStatus`. For bank-transfer-only invoices, `paymentStatus` is omitted — rely on `invoice.status`. NOTE: `paymentStatus` may also be absent when the optional acquiring fetch fails transiently (network blip, backend hiccup); if you expected it but don't see it, call this tool again to retry rather than assuming acquiring is off.",
    {
      invoiceId: z.number().int().describe("Numeric invoice id"),
    },
    { title: "Get F2B invoice", readOnlyHint: true },
    async ({ invoiceId }) => {
      const invoice = await client.get<
        {
          uuid?: string;
          status?: string;
          acquiringEnabled?: boolean;
        } & Record<string, unknown>
      >(`/freelancer/f2b/invoices/${invoiceId}`);

      let paymentStatus: unknown = undefined;
      if (
        invoice.acquiringEnabled === true &&
        typeof invoice.uuid === "string" &&
        (invoice.status === "sent" || invoice.status === "payment_queued")
      ) {
        try {
          paymentStatus = await client.get<unknown>(`/f2b/invoices/payment-status/${invoice.uuid}`);
        } catch (err) {
          // Acquiring fetch is best-effort. If it fails we still return the
          // invoice itself — the agent can re-query later.
          console.warn("F2B payment-status fetch failed:", err);
        }
      }

      const merged = paymentStatus !== undefined ? { ...invoice, paymentStatus } : invoice;
      const mapped = mapCurrencyIdToCode(merged);
      return {
        structuredContent: asStructuredObject(mapped),
        content: [{ text: JSON.stringify(mapped, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "f2b_listInvoices",
    "List F2B invoices of the freelancer. Backend supports filter[status][] only — clientId and date-range filters are NOT supported by the API and must be applied MCP-side after the fetch. Returns currency mapped to ISO code.",
    {
      status: z
        .union([f2bInvoiceStatusEnum, z.array(f2bInvoiceStatusEnum)])
        .optional()
        .describe("Filter by invoice status. Single value or array (OR semantics)."),
      page: z.number().optional().describe("Page number (default: 1)"),
      size: z
        .number()
        .optional()
        .describe("Page size (backend default if omitted). Mellow customer/freelancer list endpoints use `size`, not `limit`."),
    },
    { title: "List F2B invoices", readOnlyHint: true },
    async (params) => {
      // Multi-value filter[status][] requires manual query string assembly
      // because URLSearchParams.set() can't represent duplicate keys.
      const search = new URLSearchParams();
      if (params.page !== undefined) search.set("page", params.page.toString());
      if (params.size !== undefined) search.set("size", params.size.toString());
      const statuses = Array.isArray(params.status) ? params.status : params.status ? [params.status] : [];
      for (const s of statuses) {
        search.append("filter[status][]", s);
      }
      const path = `/freelancer/f2b/invoices${search.toString() ? `?${search.toString()}` : ""}`;
      const result = await client.get<unknown>(path);
      const mapped = mapCurrencyIdToCode(result);
      return {
        structuredContent: asStructuredList(mapped),
        content: [{ text: JSON.stringify(mapped, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "f2b_cancelInvoice",
    "Cancel (= delete) an F2B invoice. There is no hard delete — 'delete this invoice' means this tool. ALWAYS ask the user for explicit confirmation first, naming the invoice number, client and amount, and saying that a sent invoice's client gets a cancellation email; call only after a clear 'yes'. Never cancel as a side effect of another request: to correct an invoice use f2b_updateInvoice, to make a similar one use f2b_duplicateInvoice — neither requires cancelling the original. Allowed only when status is 'new' or 'sent' (422 otherwise). Cannot be undone. The API does NOT accept a 'reason' field.",
    {
      invoiceId: z.number().int().describe("Numeric invoice id"),
    },
    { title: "Cancel F2B invoice", destructiveHint: true },
    async ({ invoiceId }) => {
      const result = await client.del<unknown>("/freelancer/f2b/invoices", { invoiceId });
      const mapped = mapCurrencyIdToCode(result);
      return {
        structuredContent: asStructuredObject(mapped),
        content: [{ text: JSON.stringify(mapped, null, 2), type: "text" as const }],
      };
    },
  );
}
