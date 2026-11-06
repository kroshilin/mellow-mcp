import { describe, expect, it, vi } from "vitest";
import type { FileLinkPublisher, PublishableFile } from "../../src/file-links";
import { MellowApiError } from "../../src/mellow-client";
import { registerCorDocumentTools } from "../../src/tools/cor-documents";
import { registerF2bDocumentTools } from "../../src/tools/f2b/documents";
import { makeClientStub, makeServerStub, parsedText } from "./helpers/stubs";

// Backlog rows "Скачивание файла инвойса", "Скачивание файла инвойса у сделки"
// and "Скачать акты и инвойсы о выполненной работе" (CoR). Product answers
// (2026-11): backend conditions for invoice/deal PDFs are final (sent / paid /
// finished; deals sent / finished; verified company clients only); files may
// go to the chat directly; CoR documents one by one or as a ZIP.

const pdf = (): PublishableFile["bytes"] => new TextEncoder().encode("%PDF").buffer as ArrayBuffer;

function makePublisher() {
  const published: PublishableFile[] = [];
  const files: FileLinkPublisher = {
    async publish(file) {
      published.push(file);
      return {
        url: `https://mcp.test/files/${"t".repeat(43)}/${encodeURIComponent(file.filename)}`,
        filename: file.filename,
        contentType: file.contentType,
        sizeBytes: file.bytes.byteLength,
        expiresAt: "2026-11-06T12:15:00.000Z",
        expiresInMinutes: 15,
      };
    },
  };
  return { files, published };
}

const verifiedCompany = { id: 42, type: "legal", status: "active", email: "ap@acme.test" };

function setupF2b(responses: Record<string, unknown>) {
  const { stub, calls } = makeClientStub(responses);
  const srv = makeServerStub();
  const { files, published } = makePublisher();
  const sleep = vi.fn().mockResolvedValue(undefined);
  registerF2bDocumentTools(srv.server, stub as never, { files, sleep });
  return { ...srv, calls, published, sleep };
}

describe("f2b_downloadInvoicePdf", () => {
  it("GET invoice → GET download-payment-invoice → GET /files/{fileId} → returns a download link", async () => {
    const { invoke, calls, published } = setupF2b({
      "GET /freelancer/f2b/invoices/9": { id: 9, number: "INV-9", status: "paid", client: verifiedCompany },
      "GET /freelancer/f2b/invoices/9/download-payment-invoice": { fileId: 555, statusId: 4 },
      "GETFILE /files/555": { bytes: pdf(), contentType: "application/pdf", filename: "INV-9.pdf" },
    });

    const result = parsedText(await invoke("f2b_downloadInvoicePdf", { invoiceId: 9 })) as Record<string, any>;

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /freelancer/f2b/invoices/9",
      "GET /freelancer/f2b/invoices/9/download-payment-invoice",
      "GETFILE /files/555",
    ]);
    expect(published[0]).toMatchObject({ filename: "INV-9.pdf", contentType: "application/pdf" });
    expect(result.download.url).toMatch(/^https:\/\/mcp\.test\/files\//);
    expect(result.invoice).toEqual({ id: 9, number: "INV-9", status: "paid" });
    expect(JSON.stringify(result.notes)).toMatch(/clickable link/);
  });

  it("waits while the PDF is being rendered, then downloads it", async () => {
    let polls = 0;
    const { invoke, sleep, calls } = setupF2b({
      "GET /freelancer/f2b/invoices/9": { id: 9, status: "sent", client: verifiedCompany },
      "GET /freelancer/f2b/invoices/9/download-payment-invoice": () => {
        polls += 1;
        return { fileId: 555, statusId: polls < 3 ? 0 : 3 };
      },
      "GETFILE /files/555": { bytes: pdf(), contentType: "application/pdf" },
    });
    await invoke("f2b_downloadInvoicePdf", { invoiceId: 9 });
    expect(polls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(calls[calls.length - 1]?.path).toBe("/files/555");
  });

  it("names the file after the invoice number when Mellow sends no filename", async () => {
    const { invoke, published } = setupF2b({
      "GET /freelancer/f2b/invoices/9": { id: 9, number: "INV-9", status: "sent", client: verifiedCompany },
      "GET /freelancer/f2b/invoices/9/download-payment-invoice": { fileId: 1, statusId: 4 },
      "GETFILE /files/1": { bytes: pdf(), contentType: "application/octet-stream" },
    });
    await invoke("f2b_downloadInvoicePdf", { invoiceId: 9 });
    expect(published[0]).toMatchObject({ filename: "invoice-INV-9.pdf", contentType: "application/pdf" });
  });

  it.each([
    [{ status: "new", client: verifiedCompany }, /status is 'new'.*send it to the client first/],
    [{ status: "payment_queued", client: verifiedCompany }, /status is 'payment_queued'/],
    [{ status: "cancelled", client: verifiedCompany }, /status is 'cancelled'/],
    [{ status: "sent", client: { ...verifiedCompany, type: "individual" } }, /individual/],
    [{ status: "sent", client: { ...verifiedCompany, status: "not_verified" } }, /not verified/],
  ])("refuses before requesting the PDF when the backend would (%j)", async (invoice, message) => {
    const { invoke, calls } = setupF2b({ "GET /freelancer/f2b/invoices/9": { id: 9, ...invoice } });
    await expect(invoke("f2b_downloadInvoicePdf", { invoiceId: 9 })).rejects.toThrow(message);
    expect(calls).toHaveLength(1);
  });

  it("translates the backend's 403 into the conditions", async () => {
    const { invoke } = setupF2b({
      "GET /freelancer/f2b/invoices/9": { id: 9, status: "sent", client: {} },
      "GET /freelancer/f2b/invoices/9/download-payment-invoice": () => {
        throw new MellowApiError("Mellow API GET ... failed (403)", 403, "GET", "/x");
      },
    });
    await expect(invoke("f2b_downloadInvoicePdf", { invoiceId: 9 })).rejects.toThrow(/verified company/);
  });

  it("reports a PDF generation error and a PDF that is still not ready", async () => {
    const failed = setupF2b({
      "GET /freelancer/f2b/invoices/9": { id: 9, status: "sent", client: verifiedCompany },
      "GET /freelancer/f2b/invoices/9/download-payment-invoice": { fileId: 1, statusId: 5 },
    });
    await expect(failed.invoke("f2b_downloadInvoicePdf", { invoiceId: 9 })).rejects.toThrow(/failed to generate/);

    const slow = setupF2b({
      "GET /freelancer/f2b/invoices/9": { id: 9, status: "sent", client: verifiedCompany },
      "GET /freelancer/f2b/invoices/9/download-payment-invoice": { fileId: 1, statusId: 0 },
    });
    await expect(slow.invoke("f2b_downloadInvoicePdf", { invoiceId: 9 })).rejects.toThrow(/still being generated/);
    expect(slow.sleep).toHaveBeenCalledTimes(7);
  });
});

describe("deal_downloadInvoicePdf", () => {
  it("checks the deal, then uses the shared F2B download endpoint", async () => {
    const { invoke, calls } = setupF2b({
      "GET /v2/freelancer/secure-deals/77": { id: 77, number: "SD-77", status: "finished", client: verifiedCompany },
      "GET /freelancer/f2b/invoices/77/download-payment-invoice": { fileId: 8, statusId: 4 },
      "GETFILE /files/8": { bytes: pdf(), contentType: "application/pdf" },
    });
    const result = parsedText(await invoke("deal_downloadInvoicePdf", { dealId: 77 })) as Record<string, any>;
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v2/freelancer/secure-deals/77",
      "GET /freelancer/f2b/invoices/77/download-payment-invoice",
      "GETFILE /files/8",
    ]);
    expect(result.deal).toEqual({ id: 77, number: "SD-77", status: "finished" });
  });

  it.each(["new", "in_work", "client_review", "for_payment", "paid"])("refuses a deal in status %s (product: sent or finished only)", async (status) => {
    const { invoke, calls } = setupF2b({ "GET /v2/freelancer/secure-deals/77": { id: 77, status, client: verifiedCompany } });
    await expect(invoke("deal_downloadInvoicePdf", { dealId: 77 })).rejects.toThrow(/sent', 'finished'/);
    expect(calls).toHaveLength(1);
  });

  it("refuses an individual client", async () => {
    const { invoke } = setupF2b({
      "GET /v2/freelancer/secure-deals/77": { id: 77, status: "sent", client: { type: "individual", status: "active" } },
    });
    await expect(invoke("deal_downloadInvoicePdf", { dealId: 77 })).rejects.toThrow(/individual/);
  });
});

function setupCor(responses: Record<string, unknown>) {
  const { stub, calls } = makeClientStub(responses);
  const srv = makeServerStub();
  const { files, published } = makePublisher();
  registerCorDocumentTools(srv.server, stub as never, files);
  return { ...srv, calls, published };
}

describe("CoR documents (freelancer)", () => {
  it("cor_listDocuments maps type names to 6/7 and labels rows", async () => {
    const { invoke, calls } = setupCor({
      "GET /freelancer/documents": { items: [{ id: 1, type: 7 }, { id: 2, type: 6 }], pagination: { total: 2 } },
    });
    const result = parsedText(await invoke("cor_listDocuments", { type: "act", dateFrom: "2026-01-01", size: 50 })) as Record<string, any>;
    expect(calls.map((c) => c.path)).toEqual(["/freelancer/documents"]);
    expect(result.items.map((r: { typeName: string }) => r.typeName)).toEqual(["act", "invoice"]);
  });

  it("cor_listDocuments sends filter params (checked via the real query builder contract)", async () => {
    const getSpy = vi.fn().mockResolvedValue({ items: [] });
    const srv = makeServerStub();
    registerCorDocumentTools(srv.server, { get: getSpy } as never, makePublisher().files);
    await srv.invoke("cor_listDocuments", { type: "invoice", dateFrom: "2026-01-01", dateTo: "2026-03-31", page: 2, size: 50 });
    expect(getSpy).toHaveBeenCalledWith("/freelancer/documents", {
      "filter[type]": "6",
      "filter[dateFrom]": "2026-01-01",
      "filter[dateTo]": "2026-03-31",
      page: "2",
      size: "50",
    });
  });

  it("cor_downloadDocument fetches /files/{id} and returns a link", async () => {
    const { invoke, calls, published } = setupCor({
      "GETFILE /files/31": { bytes: pdf(), contentType: "application/pdf", filename: "act-31.pdf" },
    });
    const result = parsedText(await invoke("cor_downloadDocument", { documentId: 31 })) as Record<string, any>;
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GETFILE /files/31"]);
    expect(calls[0].body).toEqual({ maxBytes: 20 * 1024 * 1024 });
    expect(published[0]).toMatchObject({ filename: "act-31.pdf", contentType: "application/pdf" });
    expect(result.download.url).toMatch(/act-31\.pdf$/);
  });

  it("cor_downloadDocument turns 403/404 into a clear message", async () => {
    const { invoke } = setupCor({
      "GETFILE /files/31": () => {
        throw new MellowApiError("x", 403, "GET", "/files/31");
      },
    });
    await expect(invoke("cor_downloadDocument", { documentId: 31 })).rejects.toThrow(/not available to this account/);
  });

  it("cor_emailDocumentsArchive queues the ZIP with the same filters and says it arrives by email", async () => {
    const getSpy = vi.fn().mockResolvedValue([]);
    const srv = makeServerStub();
    registerCorDocumentTools(srv.server, { get: getSpy } as never, makePublisher().files);
    const result = parsedText(await srv.invoke("cor_emailDocumentsArchive", { type: "act", dateTo: "2026-10-31" })) as Record<string, any>;
    expect(getSpy).toHaveBeenCalledWith("/freelancer/documents/download", {
      "filter[type]": "7",
      "filter[dateFrom]": undefined,
      "filter[dateTo]": "2026-10-31",
    });
    expect(result.queued).toBe(true);
    expect(JSON.stringify(result.notes)).toMatch(/emailed/);
  });

  it("cor_emailDocumentsArchive explains an empty selection (backend 404)", async () => {
    const srv = makeServerStub();
    const get = vi.fn().mockRejectedValue(new MellowApiError("x", 404, "GET", "/freelancer/documents/download"));
    registerCorDocumentTools(srv.server, { get } as never, makePublisher().files);
    await expect(srv.invoke("cor_emailDocumentsArchive", {})).rejects.toThrow(/No CoR documents match/);
  });

  it("descriptions keep CoR documents apart from F2B invoices and offer the PDF-or-ZIP choice", () => {
    const { description } = setupCor({});
    expect(description("cor_listDocuments")).toMatch(/NOT F2B invoices/);
    expect(description("cor_listDocuments")).toMatch(/one by one.*ZIP archive by email/);
  });
});
