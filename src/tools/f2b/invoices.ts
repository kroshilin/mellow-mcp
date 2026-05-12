import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asStructuredList, asStructuredObject, type MellowClient } from "../../mellow-client";
import { f2bCommissionPayerEnum, f2bInvoiceStatusEnum, f2bLineItemSchema, mapCurrencyIdToCode } from "./shared";

/**
 * Read the backend's currencyId from a client response, handling both shapes
 * the backend uses across endpoints:
 *   - flat: `{ currencyId: 3, ... }` (older style; some legacy fields)
 *   - nested: `{ currency: { currency: "EUR", id: 3 }, ... }` (current F2B style)
 *
 * Returns undefined if neither shape matches.
 */
function readClientCurrencyId(rawClient: unknown): number | undefined {
  if (!rawClient || typeof rawClient !== "object") return undefined;
  const c = rawClient as Record<string, unknown>;
  if (typeof c.currencyId === "number") return c.currencyId;
  if (c.currency && typeof c.currency === "object") {
    const cur = c.currency as Record<string, unknown>;
    if (typeof cur.id === "number") return cur.id;
  }
  return undefined;
}

export function registerF2bInvoiceTools(server: McpServer, client: MellowClient) {
  server.tool(
    "f2b_createInvoiceDraft",
    "Create an F2B invoice in draft status (`new`). Email is NOT sent to the client at this step — this is the preview half of the mandatory two-step send. Currency is derived from the target client (set at f2b_createClient time). Composite under the hood: GET client → POST /v2/invoices. Backend returns the breakdown (subtotal, commissionPercent, commissionAmount, salesTax, total, payable) so you can show the user the cost decomposition before f2b_sendInvoiceDraft. Backend limits: ≤ 10 line items, total amount ≤ 10 000 in client currency, invoiceDate must be ≤ today. Public payment URL does NOT exist until f2b_sendInvoiceDraft is called.",
    {
      clientId: z.number().int().describe("Numeric client id (currency derives from this client)"),
      serviceId: z.number().int().describe("Service catalog id from Mellow service taxonomy"),
      serviceName: z.string().min(1).max(1024).describe("Service description, no HTML; appears as the invoice's main service title"),
      serviceStartDate: z.string().describe("ISO date YYYY-MM-DD — start of the period covered"),
      serviceEndDate: z
        .string()
        .describe("ISO date — end of the service period; doubles as de-facto due date since API has no separate dueDate field"),
      invoiceDate: z.string().describe("ISO date — issuance date; backend rejects future dates with 422"),
      lineItems: z
        .array(f2bLineItemSchema)
        .min(1)
        .max(10)
        .describe("1–10 line items; sum of price*quantity must be ≤ 10 000 in client currency"),
      commissionPayer: f2bCommissionPayerEnum.describe(
        "'freelancer' (commission deducted from payable) or 'customer' (commission added to total)",
      ),
      acquiringEnabled: z
        .boolean()
        .optional()
        .describe(
          "false (default) → bank transfer only (5% commission). true → client picks bank (5%) or card (5%+3%=8%) on the payment page.",
        ),
    },
    { title: "Create F2B invoice draft" },
    async (params) => {
      // Step 1: load the target client to derive currencyId and pre-validate
      // status. Surfacing the pre-validation here gives the agent a clearer
      // error than a raw 422 back-end response would.
      const rawClient = await client.get<unknown>(`/freelancer/f2b/clients/${params.clientId}`);
      const status =
        rawClient && typeof rawClient === "object" && "status" in rawClient ? (rawClient as { status?: string }).status : undefined;
      if (status === "archived" || status === "suspended") {
        throw new Error(
          `F2B client ${params.clientId} is in status '${status}'; cannot create invoice. Pick a different client or restore via Mellow UI.`,
        );
      }
      const currencyId = readClientCurrencyId(rawClient);
      if (currencyId === undefined) {
        throw new Error(`F2B client ${params.clientId} response does not contain a recognisable currency. Cannot create invoice.`);
      }

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
    "Send a previously created F2B invoice draft to the client. Triggers email to client.email and exposes the public paymentUrl in the response. Transitions invoice status from 'new' → 'sent'. Backend returns 422 if the invoice is not in 'new', or if client.status is in {archived, suspended}. AGENT confirmation rule applies: confirm subtotal/total/client/dueDate with the user before calling — once this returns, the email is in the client's inbox and the only recovery is f2b_cancelInvoice (which the client also gets notified of).",
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
    "Cancel an F2B invoice. Allowed only when status is 'new' or 'sent'. Backend returns 422 for any other status (paid, cancelled, payment_queued — i.e., acquiring inflight). Cancellation cannot be undone — for a corrected version, cancel and create a new draft. The API does NOT accept a 'reason' field; record reasons in the conversation log only.",
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
