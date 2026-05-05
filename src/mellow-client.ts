export type MellowClient = ReturnType<typeof createMellowClient>;

/**
 * Normalize a Mellow API response into an MCP `structuredContent` object.
 * Mellow list endpoints return either `{items, pagination}` (paginated lists)
 * or a bare array (lookups). MCP `structuredContent` must be an object —
 * arrays/scalars are wrapped as `{items: ...}` while existing object shapes
 * pass through unchanged so clients reading `structuredContent.items` /
 * `structuredContent.pagination` see the real backend shape.
 */
export function asStructuredList(result: unknown): { [key: string]: unknown } {
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    return result as { [key: string]: unknown };
  }
  return { items: result };
}

/**
 * Normalize a Mellow API response into an MCP `structuredContent` object
 * for non-list endpoints. MCP `structuredContent` must be an object — but
 * Mellow mutating endpoints sometimes return a plain string ("ok"), an
 * empty array (`[]`), or `null` (no body). We wrap these into a stable
 * `{ ok: true, raw: <value> }` envelope so the MCP client schema validator
 * accepts them. Existing object shapes pass through unchanged.
 */
export function asStructuredObject(result: unknown): { [key: string]: unknown } {
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    return result as { [key: string]: unknown };
  }
  return { ok: true, raw: result };
}

export function createMellowClient(baseUrl: string, accessToken: string, activeCompanyId?: number) {
  async function request<T>(
    method: string,
    path: string,
    opts?: { body?: object; params?: Record<string, string | undefined> },
  ): Promise<T> {
    const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${base}${normalizedPath}`);

    if (opts?.params) {
      for (const [key, value] of Object.entries(opts.params)) {
        if (value !== undefined) {
          url.searchParams.set(key, value);
        }
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    };

    // Multi-company context: when an activeCompanyId is set, send it on every
    // request as `X-Company-Id`.
    if (activeCompanyId !== undefined) {
      headers["X-Company-Id"] = activeCompanyId.toString();
    }

    let requestBody: string | undefined;
    if (opts?.body) {
      headers["Content-Type"] = "application/json";
      requestBody = JSON.stringify(opts.body);
    }

    const response = await fetch(url.toString(), {
      method,
      headers,
      body: requestBody,
    });

    if (!response.ok) {
      const text = await response.text();
      const traceId = response.headers.get("x-trace-id");
      const cfRay = response.headers.get("cf-ray");
      const traceSuffix = traceId ? ` [trace=${traceId}]` : cfRay ? ` [cf-ray=${cfRay}]` : "";
      throw new Error(`Mellow API ${method} ${path} failed (${response.status})${traceSuffix}: ${text}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return response.json() as Promise<T>;
    }

    return response.text() as unknown as T;
  }

  return {
    get: <T>(path: string, params?: Record<string, string | undefined>) => request<T>("GET", path, { params }),
    post: <T>(path: string, body?: object) => request<T>("POST", path, { body }),
    put: <T>(path: string, body?: object) => request<T>("PUT", path, { body }),
    patch: <T>(path: string, body?: object) => request<T>("PATCH", path, { body }),
    del: <T>(path: string, body?: object) => request<T>("DELETE", path, { body }),
  };
}
