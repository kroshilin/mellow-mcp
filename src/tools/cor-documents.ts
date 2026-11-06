import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FILE_LINK_MAX_BYTES, type FileLinkPublisher } from "../file-links";
import { asStructuredList, asStructuredObject, MellowApiError, type MellowClient } from "../mellow-client";

/**
 * Freelancer-side CoR documents: invoices and acts (period reports) for work
 * done for companies through Mellow (Contractor of Record). NOT F2B invoices —
 * those have their own tools (f2b_downloadInvoicePdf).
 *
 * Backend (cabinet, Controller/Freelancer/DocumentsController.php):
 *  - GET /api/freelancer/documents — list; filter[type] 6 (invoice) | 7 (act),
 *    filter[dateFrom] / filter[dateTo] (YYYY-MM-DD), page/size. Row `id` is the
 *    file id, `status` the file status (3/4 = ready).
 *  - GET /api/files/{id} — one PDF.
 *  - GET /api/freelancer/documents/download — same filters; queues a ZIP of
 *    all matching documents and emails it to the freelancer when ready
 *    (CreateZipCommand → ArchiveFileCreated → templated email). 404 when
 *    nothing matches.
 */

const DOCUMENT_TYPE_IDS = { invoice: 6, act: 7 } as const;
const documentTypeEnum = z.enum(["invoice", "act"]);
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const FILTER_SHAPE = {
  type: documentTypeEnum.optional().describe("'invoice' = invoices for completed work, 'act' = acts (period reports). Omit for both."),
  dateFrom: isoDateSchema.optional().describe("From date, YYYY-MM-DD (inclusive)"),
  dateTo: isoDateSchema.optional().describe("To date, YYYY-MM-DD (inclusive)"),
};

type DocumentFilters = { type?: keyof typeof DOCUMENT_TYPE_IDS; dateFrom?: string; dateTo?: string };

function filterParams(filters: DocumentFilters): Record<string, string | undefined> {
  return {
    "filter[type]": filters.type ? String(DOCUMENT_TYPE_IDS[filters.type]) : undefined,
    "filter[dateFrom]": filters.dateFrom,
    "filter[dateTo]": filters.dateTo,
  };
}

const TYPE_NAMES: Record<number, string> = { 6: "invoice", 7: "act" };

/** Add a readable `typeName` next to the numeric type on each row. */
function labelDocumentTypes(result: unknown): unknown {
  if (!result || typeof result !== "object" || !Array.isArray((result as { items?: unknown }).items)) return result;
  const page = result as { items: unknown[] };
  return {
    ...page,
    items: page.items.map((row) =>
      row && typeof row === "object" ? { ...row, typeName: TYPE_NAMES[Number((row as { type?: unknown }).type)] ?? "other" } : row,
    ),
  };
}

function respond(value: unknown, list = false) {
  return {
    structuredContent: list ? asStructuredList(value) : asStructuredObject(value),
    content: [{ text: JSON.stringify(value, null, 2), type: "text" as const }],
  };
}

export function registerCorDocumentTools(server: McpServer, client: MellowClient, files: FileLinkPublisher) {
  server.tool(
    "cor_listDocuments",
    "List the freelancer's CoR documents — invoices and acts for work done for companies through Mellow (the cabinet's Documents section). These are NOT F2B invoices to the freelancer's own clients (use f2b_listInvoices / f2b_downloadInvoicePdf for those). Filters: type ('invoice' | 'act'), dateFrom / dateTo (YYYY-MM-DD); paginated (page, size ≤ 500). Each row: id (use it with cor_downloadDocument), type (6 invoice, 7 act) + typeName, reportNumber, period, createdAt, amount, currency id, status (file status; 3 or 4 = ready to download). After listing, offer the user a choice: download PDFs one by one (cor_downloadDocument) or get all matching documents as one ZIP archive by email (cor_emailDocumentsArchive).",
    {
      ...FILTER_SHAPE,
      page: z.number().int().min(1).optional().describe("Page number (default 1)"),
      size: z.number().int().min(1).max(500).optional().describe("Page size (default 20, max 500)"),
    },
    { title: "List CoR documents", readOnlyHint: true },
    async (params) => {
      const result = await client.get<unknown>("/freelancer/documents", {
        ...filterParams(params),
        page: params.page?.toString(),
        size: params.size?.toString(),
      });
      return respond(labelDocumentTypes(result), true);
    },
  );

  server.tool(
    "cor_downloadDocument",
    "Download one CoR document (an invoice or act from cor_listDocuments) as a PDF. Returns a short-lived download link (download.url, valid 15 minutes) — show it to the user as a clickable link; for several documents call it once per document, or offer cor_emailDocumentsArchive for a single ZIP. Composite: GET /files/{documentId}.",
    {
      documentId: z.number().int().describe("The row `id` from cor_listDocuments"),
      filename: z.string().min(1).max(150).optional().describe("Optional file name to suggest, e.g. 'act-2026-10.pdf'"),
    },
    { title: "Download CoR document", readOnlyHint: true },
    async ({ documentId, filename }) => {
      let file;
      try {
        file = await client.getFile(`/files/${documentId}`, { maxBytes: FILE_LINK_MAX_BYTES });
      } catch (err) {
        if (err instanceof MellowApiError && (err.status === 403 || err.status === 404)) {
          throw new Error(`Document ${documentId} is not available to this account. Use an id from cor_listDocuments.`);
        }
        throw err;
      }
      const download = await files.publish({
        bytes: file.bytes,
        filename: filename ?? file.filename ?? `mellow-document-${documentId}.pdf`,
        // CoR documents are PDFs; never relay whatever type the upstream claims.
        contentType: "application/pdf",
      });
      return respond({
        download,
        documentId,
        notes: [
          `Give the user download.url as a clickable link (it expires in ${download.expiresInMinutes} minutes; if it has expired, call this tool again).`,
        ],
      });
    },
  );

  server.tool(
    "cor_emailDocumentsArchive",
    "Email the freelancer a ZIP archive of all their CoR documents matching the filters (type, dateFrom, dateTo — the same as cor_listDocuments). The archive is built in the background and sent to the email address of the freelancer's Mellow account, usually within a few minutes; it is not returned in the chat. Tell the user to check their inbox. Each call sends another email: call it once per user request, never retry on your own. Fails when no documents match the filters. Composite: GET /freelancer/documents/download.",
    FILTER_SHAPE,
    { title: "Email CoR documents as ZIP" },
    async (params) => {
      try {
        await client.get<unknown>("/freelancer/documents/download", filterParams(params));
      } catch (err) {
        if (err instanceof MellowApiError && err.status === 404) {
          throw new Error("No CoR documents match these filters, so there is nothing to archive. Widen the dates or drop the type filter.");
        }
        throw err;
      }
      return respond({
        queued: true,
        filters: params,
        notes: ["The ZIP archive is being prepared and will be emailed to the user's Mellow account email in a few minutes."],
      });
    },
  );
}
