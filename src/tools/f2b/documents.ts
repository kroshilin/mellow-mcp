import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FILE_LINK_MAX_BYTES, type FileLinkPublisher } from "../../file-links";
import { asStructuredObject, MellowApiError, type MellowClient } from "../../mellow-client";

/**
 * Payment-invoice PDF downloads for F2B invoices and Secure Deals.
 *
 * Backend (cabinet): GET /api/freelancer/f2b/invoices/{id}/download-payment-invoice
 * renders (or reuses) the PDF and answers {fileId, statusId}; the bytes then
 * come from GET /api/files/{fileId}. One endpoint serves invoices and deals
 * (both live in f2b_invoices). F2BVoter::canDownloadPaymentInvoice allows it
 * only for statuses sent / paid / finished and only when the client is a
 * verified legal entity (type legal, status active). Product decision
 * (backlog, 2026-11): these backend conditions are final — no PDF for
 * individuals, none before the record is sent.
 *
 * The file reaches the user as a short-lived link (see src/file-links.ts):
 * claude.ai tool results cannot carry a PDF.
 */

const INVOICES_PATH = "/freelancer/f2b/invoices";
const DEALS_PATH = "/v2/freelancer/secure-deals";

export const INVOICE_PDF_STATUSES = ["sent", "paid", "finished"] as const;
/** Product wording for deals: Sent or Finished (a deal never reaches `paid`). */
export const DEAL_PDF_STATUSES = ["sent", "finished"] as const;

/** api\Solar\Common\Enum\FileStatus */
const FILE_STATUS_READY = [3, 4];
const FILE_STATUS_ERROR = 5;
const PDF_POLL_ATTEMPTS = 8;
const PDF_POLL_DELAY_MS = 1500;

type RecordView = Record<string, unknown>;
type Sleep = (ms: number) => Promise<void>;

export type F2bDocumentToolDeps = { files: FileLinkPublisher; sleep?: Sleep };

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function label(kind: "invoice" | "deal", record: RecordView, id: number): string {
  return typeof record.number === "string" ? `${kind} ${record.number} (id ${id})` : `${kind} id ${id}`;
}

function clientOf(record: RecordView): RecordView {
  return record.client && typeof record.client === "object" ? (record.client as RecordView) : {};
}

/**
 * Mirror F2BVoter::canDownloadPaymentInvoice so the agent gets a clear reason
 * instead of a bare 403. Fields the response lacks are left to the backend.
 */
export function assertPaymentPdfAvailable(
  kind: "invoice" | "deal",
  record: RecordView,
  id: number,
  allowedStatuses: readonly string[],
): void {
  const what = label(kind, record, id);
  const status = typeof record.status === "string" ? record.status : undefined;
  if (status !== undefined && !allowedStatuses.includes(status)) {
    throw new Error(
      `No payment-invoice PDF for ${what}: its status is '${status}'. The PDF exists only in statuses ${allowedStatuses.map((s) => `'${s}'`).join(", ")}${status === "new" ? " — send it to the client first" : ""}.`,
    );
  }
  const client = clientOf(record);
  if (typeof client.type === "string" && client.type !== "legal") {
    throw new Error(`No payment-invoice PDF for ${what}: the client is an individual. Mellow issues the PDF only for company clients.`);
  }
  if (typeof client.status === "string" && client.status !== "active") {
    throw new Error(
      `No payment-invoice PDF for ${what} yet: the client is not verified (client status '${client.status}'). The PDF becomes available once the client confirms their company details on the payment page and passes verification.`,
    );
  }
}

type PdfTicket = { fileId?: unknown; statusId?: unknown };

/** Ask the backend for the PDF and wait (briefly) until it is rendered. */
async function resolvePdfFileId(client: MellowClient, id: number, what: string, sleep: Sleep): Promise<number> {
  for (let attempt = 1; attempt <= PDF_POLL_ATTEMPTS; attempt += 1) {
    let ticket: PdfTicket;
    try {
      ticket = await client.get<PdfTicket>(`${INVOICES_PATH}/${id}/download-payment-invoice`);
    } catch (err) {
      if (err instanceof MellowApiError && err.status === 403) {
        throw new Error(
          `Mellow refused the PDF for ${what}: it is available only in statuses sent, paid or finished and only when the client is a verified company.`,
        );
      }
      throw err;
    }
    const statusId = Number(ticket?.statusId);
    if (typeof ticket?.fileId === "number" && FILE_STATUS_READY.includes(statusId)) return ticket.fileId;
    if (statusId === FILE_STATUS_ERROR) {
      throw new Error(`Mellow failed to generate the PDF for ${what}. Ask the user to retry later or download it in the cabinet.`);
    }
    if (attempt < PDF_POLL_ATTEMPTS) await sleep(PDF_POLL_DELAY_MS);
  }
  throw new Error(`The PDF for ${what} is still being generated. Call this tool again in a minute.`);
}

async function publishPaymentPdf(
  client: MellowClient,
  deps: F2bDocumentToolDeps,
  kind: "invoice" | "deal",
  record: RecordView,
  id: number,
) {
  const what = label(kind, record, id);
  const fileId = await resolvePdfFileId(client, id, what, deps.sleep ?? defaultSleep);
  const file = await client.getFile(`/files/${fileId}`, { maxBytes: FILE_LINK_MAX_BYTES });
  const fallbackName = `${kind === "deal" ? "secure-deal" : "invoice"}-${typeof record.number === "string" ? record.number : id}.pdf`;
  const download = await deps.files.publish({
    bytes: file.bytes,
    filename: file.filename ?? fallbackName,
    contentType: file.contentType.includes("pdf") ? file.contentType : "application/pdf",
  });
  const result = {
    download,
    [kind]: { id, number: record.number, status: record.status },
    notes: [
      `Give the user download.url as a clickable link (it expires in ${download.expiresInMinutes} minutes; if it has expired, call this tool again).`,
      "The link is the payment invoice PDF itself; you cannot read its contents.",
    ],
  };
  return {
    structuredContent: asStructuredObject(result),
    content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
  };
}

export function registerF2bDocumentTools(server: McpServer, client: MellowClient, deps: F2bDocumentToolDeps) {
  server.tool(
    "f2b_downloadInvoicePdf",
    "Download the payment invoice PDF of an F2B invoice (the same file as 'Download invoice' in the Mellow cabinet). Available only when the invoice status is sent, paid or finished AND the client is a verified company (client status 'active'); never for individual clients or for drafts (status new). To find the invoice by its number, use f2b_listInvoices first and take the row's id. Returns a short-lived download link (download.url, valid 15 minutes) — show it to the user as a clickable link. Composite: GET invoice (pre-check) → GET /{id}/download-payment-invoice (waits until the PDF is rendered) → GET /files/{fileId}.",
    {
      invoiceId: z.number().int().describe("Numeric F2B invoice id (from f2b_listInvoices / f2b_getInvoice — not the invoice number)"),
    },
    { title: "Download F2B invoice PDF", readOnlyHint: true },
    async ({ invoiceId }) => {
      const invoice = await client.get<RecordView>(`${INVOICES_PATH}/${invoiceId}`);
      assertPaymentPdfAvailable("invoice", invoice, invoiceId, INVOICE_PDF_STATUSES);
      return publishPaymentPdf(client, deps, "invoice", invoice, invoiceId);
    },
  );

  server.tool(
    "deal_downloadInvoicePdf",
    "Download the payment invoice PDF of a Secure Deal. Available only when the deal status is sent or finished AND the client is a verified company (client status 'active'); not for individual clients, drafts (new) or deals in work, review or awaiting payment. To find the deal by its number, use deal_list with `search` first and take the row's id. Returns a short-lived download link (download.url, valid 15 minutes) — show it to the user as a clickable link. Composite: GET deal (pre-check) → GET /freelancer/f2b/invoices/{id}/download-payment-invoice (waits until the PDF is rendered) → GET /files/{fileId}.",
    {
      dealId: z.number().int().describe("Numeric deal id (the `id` from deal_list — not the deal number)"),
    },
    { title: "Download Secure Deal invoice PDF", readOnlyHint: true },
    async ({ dealId }) => {
      const deal = await client.get<RecordView>(`${DEALS_PATH}/${dealId}`);
      assertPaymentPdfAvailable("deal", deal, dealId, DEAL_PDF_STATUSES);
      return publishPaymentPdf(client, deps, "deal", deal, dealId);
    },
  );
}
