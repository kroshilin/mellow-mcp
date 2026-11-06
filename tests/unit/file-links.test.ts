import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createKvFileLinkPublisher,
  FILE_LINK_MAX_BYTES,
  FILE_LINK_TTL_SECONDS,
  safeContentType,
  sanitizeFilename,
  serveFileLink,
} from "../../src/file-links";
import { createMellowClient, MellowApiError, parseContentDispositionFilename } from "../../src/mellow-client";

// Backlog: "documents can be given to the chat as a file". claude.ai tool
// results carry only text/images, so files travel as short-lived links on the
// Worker. These tests lock in the link lifecycle and its security headers.

type Stored = { value: ArrayBuffer; metadata: unknown; ttl?: number };

function makeKv() {
  const store = new Map<string, Stored>();
  const kv = {
    async put(key: string, value: ArrayBuffer, opts?: { expirationTtl?: number; metadata?: unknown }) {
      store.set(key, { value, metadata: opts?.metadata, ttl: opts?.expirationTtl });
    },
    async getWithMetadata(key: string) {
      const hit = store.get(key);
      return { value: hit?.value ?? null, metadata: hit?.metadata ?? null };
    },
  };
  return { kv: kv as unknown as KVNamespace, store };
}

const pdfBytes = () => new TextEncoder().encode("%PDF-1.7 fake").buffer as ArrayBuffer;

describe("createKvFileLinkPublisher", () => {
  it("stores the bytes under an unguessable token with a TTL and returns a link on the public origin", async () => {
    const { kv, store } = makeKv();
    const publisher = createKvFileLinkPublisher(kv, "https://mcp.example.dev/", () => Date.UTC(2026, 10, 6, 12, 0, 0));
    const link = await publisher.publish({ bytes: pdfBytes(), filename: "Invoice INV-7.pdf", contentType: "application/pdf" });

    const match = /^https:\/\/mcp\.example\.dev\/files\/([A-Za-z0-9_-]{43})\/Invoice%20INV-7\.pdf$/.exec(link.url);
    expect(match).not.toBeNull();
    const stored = store.get(`file-link:${match![1]}`)!;
    expect(stored.ttl).toBe(FILE_LINK_TTL_SECONDS);
    expect(stored.metadata).toEqual({ filename: "Invoice INV-7.pdf", contentType: "application/pdf" });
    expect(link).toMatchObject({ filename: "Invoice INV-7.pdf", sizeBytes: 13, expiresInMinutes: 15, expiresAt: "2026-11-06T12:15:00.000Z" });
  });

  it("mints a different token every time", async () => {
    const { kv } = makeKv();
    const publisher = createKvFileLinkPublisher(kv, "https://mcp.example.dev");
    const a = await publisher.publish({ bytes: pdfBytes(), filename: "a.pdf", contentType: "application/pdf" });
    const b = await publisher.publish({ bytes: pdfBytes(), filename: "a.pdf", contentType: "application/pdf" });
    expect(a.url).not.toBe(b.url);
  });

  it("refuses empty and oversized files", async () => {
    const { kv } = makeKv();
    const publisher = createKvFileLinkPublisher(kv, "https://mcp.example.dev");
    await expect(publisher.publish({ bytes: new ArrayBuffer(0), filename: "a.pdf", contentType: "application/pdf" })).rejects.toThrow(/empty/);
    await expect(
      publisher.publish({ bytes: new ArrayBuffer(FILE_LINK_MAX_BYTES + 1), filename: "a.pdf", contentType: "application/pdf" }),
    ).rejects.toThrow(/too large/);
  });
});

describe("serveFileLink", () => {
  it("serves the stored file as an attachment with no-store and noindex headers", async () => {
    const { kv } = makeKv();
    const link = await createKvFileLinkPublisher(kv, "https://mcp.example.dev").publish({
      bytes: pdfBytes(),
      filename: "Счёт 7.pdf",
      contentType: "application/pdf",
    });
    const token = link.url.split("/")[4];

    const response = await serveFileLink(kv, token);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("%PDF-1.7 fake");
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="____ 7.pdf"; filename*=UTF-8''${encodeURIComponent("Счёт 7.pdf")}`,
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Robots-Tag")).toMatch(/noindex/);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("answers 404 for an unknown, expired or malformed token without touching KV for malformed ones", async () => {
    const { kv } = makeKv();
    const spy = vi.spyOn(kv, "getWithMetadata");
    expect((await serveFileLink(kv, "A".repeat(43))).status).toBe(404);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await serveFileLink(kv, "../etc/passwd")).status).toBe(404);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("sanitizeFilename", () => {
  it("strips path separators and control characters, keeps unicode", () => {
    expect(sanitizeFilename('../a/b\\c:"d".pdf')).toBe(".._a_b_c_d_.pdf");
    expect(sanitizeFilename("Акт  за\nоктябрь.pdf")).toBe("Акт за_октябрь.pdf");
    expect(sanitizeFilename("   ")).toBe("document.pdf");
  });
});

describe("hardening", () => {
  it("truncates long names by code points, never splitting an emoji", () => {
    const name = `${"a".repeat(149)}😀😀.pdf`;
    const out = sanitizeFilename(name);
    expect(Array.from(out)).toHaveLength(150);
    expect(() => encodeURIComponent(out)).not.toThrow();
  });

  it("downgrades unexpected content types to octet-stream (no HTML on the Worker origin)", async () => {
    const { kv, store } = makeKv();
    const link = await createKvFileLinkPublisher(kv, "https://mcp.example.dev").publish({
      bytes: pdfBytes(),
      filename: "x.html",
      contentType: "text/html; charset=utf-8",
    });
    expect(link.contentType).toBe("application/octet-stream");
    expect([...store.values()][0].metadata).toMatchObject({ contentType: "application/octet-stream" });
    expect(safeContentType("Application/PDF; q=1")).toBe("application/pdf");
  });

  it("getFile refuses a body whose declared size exceeds maxBytes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("x".repeat(10), { status: 200, headers: { "content-length": "999999999" } })),
    );
    const client = createMellowClient("https://my.mellow.test/api", "tok");
    await expect(client.getFile("/files/1", { maxBytes: 1000 })).rejects.toThrow(/too large/);
    vi.unstubAllGlobals();
  });
});

describe("MellowClient.getFile / errors", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("downloads bytes with Accept */* and reads the filename from Content-Disposition", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("PDFDATA", {
        status: 200,
        headers: { "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="inv-7.pdf"' },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createMellowClient("https://my.mellow.test/api", "tok");

    const file = await client.getFile("/files/55");

    expect(fetchMock.mock.calls[0][0]).toBe("https://my.mellow.test/api/files/55");
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Accept: "*/*", Authorization: "Bearer tok" });
    expect(new TextDecoder().decode(file.bytes)).toBe("PDFDATA");
    expect(file).toMatchObject({ contentType: "application/pdf", filename: "inv-7.pdf" });
  });

  it("throws MellowApiError carrying the HTTP status, with the historical message shape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 403 })));
    const client = createMellowClient("https://my.mellow.test/api", "tok");
    const error = await client.get("/x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MellowApiError);
    expect((error as MellowApiError).status).toBe(403);
    expect((error as Error).message).toBe("Mellow API GET /x failed (403): nope");
  });

  it("parses plain and RFC 5987 Content-Disposition filenames", () => {
    expect(parseContentDispositionFilename('attachment; filename="a b.pdf"')).toBe("a b.pdf");
    expect(parseContentDispositionFilename("attachment; filename=plain.pdf")).toBe("plain.pdf");
    expect(parseContentDispositionFilename("attachment; filename=x.pdf; filename*=UTF-8''%D0%B0%D0%BA%D1%82.pdf")).toBe("акт.pdf");
    expect(parseContentDispositionFilename(null)).toBeUndefined();
  });
});
