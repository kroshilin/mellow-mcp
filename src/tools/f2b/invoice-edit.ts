import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asStructuredObject, type MellowClient } from "../../mellow-client";
import { F2B_FIELD_DOCS } from "./invoices";
import {
  F2B_EDITABLE_INVOICE_STATUSES,
  f2bCommissionPayerEnum,
  f2bLineItemSchema,
  mapCurrencyIdToCode,
  normalizeLineItems,
  readCurrencyId,
  resolveInvoiceableClientCurrency,
  toIsoDate,
} from "./shared";

// Edit-in-place and duplicate for F2B invoices. Both are composites because
// the backend has no duplicate endpoint and PUT /v2/invoices needs the full
// payload, while the agent should only have to pass the fields that change.

type InvoiceView = Record<string, unknown> & {
  status?: string;
  number?: string;
  client?: { id?: number };
  service?: { id?: number };
};

type InvoiceFields = {
  serviceId?: number;
  serviceName?: string;
  serviceStartDate?: string;
  serviceEndDate?: string;
  invoiceDate?: string;
  lineItems?: z.infer<typeof f2bLineItemSchema>[];
  commissionPayer?: "freelancer" | "customer";
  acquiringEnabled?: boolean;
};

const editableFieldsShape = {
  serviceId: z.number().int().optional().describe(F2B_FIELD_DOCS.serviceId),
  serviceName: z.string().min(1).max(1024).optional().describe(F2B_FIELD_DOCS.serviceName),
  serviceStartDate: z.string().optional().describe(F2B_FIELD_DOCS.serviceStartDate),
  serviceEndDate: z.string().optional().describe(F2B_FIELD_DOCS.serviceEndDate),
  lineItems: z.array(f2bLineItemSchema).min(1).max(10).optional().describe("Replaces ALL line items when given"),
  commissionPayer: f2bCommissionPayerEnum.optional().describe(F2B_FIELD_DOCS.commissionPayer),
  acquiringEnabled: z.boolean().optional().describe(F2B_FIELD_DOCS.acquiringEnabled),
};

/** Merge the user's changes over the stored invoice into the write payload shared by PUT and POST. */
function mergeInvoiceFields(source: InvoiceView, changes: InvoiceFields) {
  return {
    commissionPayer: changes.commissionPayer ?? source.commissionPayer,
    serviceId: changes.serviceId ?? source.service?.id,
    serviceName: changes.serviceName ?? source.serviceName,
    serviceStartDate: changes.serviceStartDate ?? toIsoDate(source.serviceStartDate),
    serviceEndDate: changes.serviceEndDate ?? toIsoDate(source.serviceEndDate),
    invoiceDate: changes.invoiceDate ?? toIsoDate(source.invoiceDate),
    acquiringEnabled: changes.acquiringEnabled ?? source.acquiringEnabled === true,
    lineItems: changes.lineItems ?? normalizeLineItems(source.lineItems),
  };
}

function respond(value: unknown) {
  const mapped = mapCurrencyIdToCode(value);
  return {
    structuredContent: asStructuredObject(mapped),
    content: [{ text: JSON.stringify(mapped, null, 2), type: "text" as const }],
  };
}

export function registerF2bInvoiceEditTools(server: McpServer, client: MellowClient) {
  server.tool(
    "f2b_updateInvoice",
    "Edit an existing F2B invoice IN PLACE — the same invoice, same number; do NOT cancel and re-create to change an invoice. Allowed while the invoice is 'new' or 'sent' (and no card payment is authorized); the client cannot be changed. If the invoice is already 'sent', the client automatically receives an 'invoice updated' email — tell the user and get their confirmation before calling. Pass only the fields that change; the tool reads the invoice and sends the full payload. Returns the updated invoice. Afterwards use f2b_calculateInvoiceCost({invoiceId}) if amounts changed.",
    {
      invoiceId: z.number().int().describe("Numeric invoice id"),
      ...editableFieldsShape,
      invoiceDate: z.string().optional().describe(F2B_FIELD_DOCS.invoiceDate),
    },
    { title: "Update F2B invoice" },
    async ({ invoiceId, ...changes }) => {
      const path = `/freelancer/f2b/invoices/${invoiceId}`;
      const source = await client.get<InvoiceView>(path);
      if (!F2B_EDITABLE_INVOICE_STATUSES.includes(source.status as (typeof F2B_EDITABLE_INVOICE_STATUSES)[number])) {
        throw new Error(
          `Invoice ${source.number ?? invoiceId} is '${source.status}'; only 'new' or 'sent' invoices can be edited. Offer f2b_duplicateInvoice to issue a corrected copy instead.`,
        );
      }
      const currencyId = readCurrencyId(source);
      if (currencyId === undefined) {
        throw new Error(`Invoice ${invoiceId} response does not contain a recognisable currency.`);
      }

      await client.put<unknown>("/freelancer/f2b/v2/invoices", {
        invoiceId,
        currencyId,
        ...mergeInvoiceFields(source, changes),
      });
      return respond(await client.get<unknown>(path));
    },
  );

  server.tool(
    "f2b_duplicateInvoice",
    "Create a NEW draft invoice (status 'new', nothing emailed) from an existing invoice, optionally changing fields — client, line items, amounts, service, work period. The original invoice is left exactly as it is: never cancel it unless the user explicitly asks for that separately. Use this for 'duplicate', 'same as last time', 'copy invoice X for another client', or creating several similar invoices. Changing clientId re-derives the currency from the new client. invoiceDate defaults to today. Then follow the normal flow: f2b_calculateInvoiceCost → show the user → f2b_sendInvoiceDraft after a clear 'yes'.",
    {
      invoiceId: z.number().int().describe("Id of the invoice to copy"),
      clientId: z.number().int().optional().describe("Send the copy to a different client (currency follows that client)"),
      ...editableFieldsShape,
      invoiceDate: z.string().optional().describe(`${F2B_FIELD_DOCS.invoiceDate}. Defaults to today.`),
    },
    { title: "Duplicate F2B invoice" },
    async ({ invoiceId, clientId, invoiceDate, ...changes }) => {
      const source = await client.get<InvoiceView>(`/freelancer/f2b/invoices/${invoiceId}`);
      const targetClientId = clientId ?? source.client?.id;
      if (targetClientId === undefined) {
        throw new Error(`Invoice ${invoiceId} response has no client id; pass clientId explicitly.`);
      }
      const currencyId = await resolveInvoiceableClientCurrency(client, targetClientId);

      const created = await client.post<unknown>("/freelancer/f2b/v2/invoices", {
        clientId: targetClientId,
        currencyId,
        ...mergeInvoiceFields(source, { ...changes, invoiceDate: invoiceDate ?? new Date().toISOString().slice(0, 10) }),
      });
      return respond(created);
    },
  );
}
