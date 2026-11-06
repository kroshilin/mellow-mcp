/**
 * Short-lived download links for files a tool fetched from Mellow (invoice
 * PDFs, CoR acts/invoices).
 *
 * Why links: claude.ai / Claude Desktop accept only text and image content in
 * MCP tool results, so a PDF cannot be handed to the user "as a file" through
 * the tool result itself. The tool downloads the file with the user's own
 * Mellow token, parks the bytes in KV for a few minutes under an unguessable
 * token, and returns a URL on this Worker. The user clicks it and gets the
 * file; no Mellow credentials are stored or exposed.
 *
 * Security model: the URL is a bearer capability — 256 bits of randomness,
 * expires after FILE_LINK_TTL_SECONDS, served with no-store / noindex headers.
 * It grants the same file the user could already download in the cabinet.
 */

export const FILE_LINK_TTL_SECONDS = 15 * 60;
/** Mellow PDFs are well under 1 MB; the cap keeps a bad upstream answer out of KV (limit 25 MiB). */
export const FILE_LINK_MAX_BYTES = 20 * 1024 * 1024;
export const FILE_LINK_PATH_PREFIX = "/files";

const KEY_PREFIX = "file-link:";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type PublishableFile = { bytes: ArrayBuffer; filename: string; contentType: string };

export type PublishedFileLink = {
  url: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  expiresAt: string;
  expiresInMinutes: number;
};

export type FileLinkPublisher = { publish(file: PublishableFile): Promise<PublishedFileLink> };

type StoredMetadata = { filename: string; contentType: string };

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Keep the name readable but safe for a URL path segment and a header value. */
export function sanitizeFilename(name: string, fallback = "document.pdf"): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  // Truncate by code points so an emoji is never split into a lone surrogate
  // (encodeURIComponent throws on those).
  const truncated = Array.from(cleaned).slice(0, 150).join("").trim();
  return truncated || fallback;
}

/**
 * Types we are willing to serve from this Worker's origin. Anything else is
 * downgraded to octet-stream so an unexpected upstream answer (e.g. HTML) can
 * never render on the origin that hosts the OAuth consent pages.
 */
const SERVABLE_CONTENT_TYPES = ["application/pdf", "application/zip"];

export function safeContentType(contentType: string): string {
  const base = contentType.split(";")[0].trim().toLowerCase();
  return SERVABLE_CONTENT_TYPES.includes(base) ? base : "application/octet-stream";
}

function contentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "_");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function createKvFileLinkPublisher(
  kv: KVNamespace,
  publicBaseUrl: string,
  now: () => number = () => Date.now(),
): FileLinkPublisher {
  const base = publicBaseUrl.replace(/\/+$/, "");
  return {
    async publish(file) {
      if (file.bytes.byteLength === 0) {
        throw new Error("Mellow returned an empty file; nothing to download. Try again in a minute.");
      }
      if (file.bytes.byteLength > FILE_LINK_MAX_BYTES) {
        throw new Error(`The file is too large to relay (${file.bytes.byteLength} bytes); download it in the Mellow cabinet.`);
      }
      const token = randomToken();
      const filename = sanitizeFilename(file.filename);
      const contentType = safeContentType(file.contentType);
      // Build the URL before writing, so a bad name cannot leave an orphan blob.
      const url = `${base}${FILE_LINK_PATH_PREFIX}/${token}/${encodeURIComponent(filename)}`;
      const metadata: StoredMetadata = { filename, contentType };
      await kv.put(`${KEY_PREFIX}${token}`, file.bytes, { expirationTtl: FILE_LINK_TTL_SECONDS, metadata });
      return {
        url,
        filename,
        contentType,
        sizeBytes: file.bytes.byteLength,
        expiresAt: new Date(now() + FILE_LINK_TTL_SECONDS * 1000).toISOString(),
        expiresInMinutes: FILE_LINK_TTL_SECONDS / 60,
      };
    },
  };
}

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
} as const;

function notFound(): Response {
  return new Response("This download link has expired or does not exist. Ask Claude for a new one.", {
    status: 404,
    headers: { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** Serve GET /files/:token/:name. The name segment is cosmetic; the token alone selects the file. */
export async function serveFileLink(kv: KVNamespace, token: string): Promise<Response> {
  if (!TOKEN_PATTERN.test(token)) return notFound();
  const stored = await kv.getWithMetadata<StoredMetadata>(`${KEY_PREFIX}${token}`, "arrayBuffer");
  if (!stored.value || !stored.metadata) return notFound();
  return new Response(stored.value, {
    status: 200,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": stored.metadata.contentType,
      "Content-Disposition": contentDisposition(stored.metadata.filename),
    },
  });
}
