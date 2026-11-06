import { describe, expect, it, vi } from "vitest";
import {
  UpstreamGrantRevokedError,
  handleTokenExchange,
  mcpAccessTokenTtl,
  readJwtExp,
  upstreamExpiresAt,
  withTokenErrorHandling,
} from "../../src/token-lifecycle";

// Backlog row "MCP disconnects daily". Root cause: when the upstream (Mellow)
// refresh failed, the token callback returned undefined, so the OAuth library
// kept issuing fresh MCP tokens that wrapped a dead upstream token. Tools then
// failed with upstream 401s while the connector looked healthy, and Claude
// never re-authenticated. These tests lock in the corrected lifecycle.

const NOW = 1_800_000_000;

function jwtWithExp(exp: number): string {
  const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64url({ alg: "RS256" })}.${b64url({ exp, sub: "u1" })}.sig`;
}

const baseProps = {
  sub: "u1",
  name: "U",
  email: "u@x.io",
  accessToken: "old-access",
  refreshToken: "old-refresh",
  userRole: "freelancer" as const,
};

describe("readJwtExp / upstreamExpiresAt", () => {
  it("reads exp from a JWT payload", () => {
    expect(readJwtExp(jwtWithExp(NOW + 1234))).toBe(NOW + 1234);
  });

  it("returns undefined for opaque or malformed tokens", () => {
    expect(readJwtExp("opaque-token")).toBeUndefined();
    expect(readJwtExp("a.%%%.c")).toBeUndefined();
  });

  it("prefers the JWT exp over expires_in (upstream may hand over a partly used token)", () => {
    expect(upstreamExpiresAt({ accessToken: jwtWithExp(NOW + 600), expiresIn: 3600, now: NOW })).toBe(NOW + 600);
  });

  it("falls back to expires_in for opaque tokens", () => {
    expect(upstreamExpiresAt({ accessToken: "opaque", expiresIn: 3600, now: NOW })).toBe(NOW + 3600);
  });
});

describe("mcpAccessTokenTtl", () => {
  it("expires the MCP token a minute before the upstream token", () => {
    expect(mcpAccessTokenTtl(NOW + 600, NOW)).toBe(540);
  });

  it("is clamped to [60, 3600]", () => {
    expect(mcpAccessTokenTtl(NOW + 10, NOW)).toBe(60);
    expect(mcpAccessTokenTtl(NOW + 86_400, NOW)).toBe(3600);
  });

  it("is undefined when the upstream expiry is unknown (library default applies)", () => {
    expect(mcpAccessTokenTtl(undefined, NOW)).toBeUndefined();
  });
});

describe("handleTokenExchange — authorization_code", () => {
  it("aligns the first MCP token TTL with the upstream token expiry", async () => {
    const refresh = vi.fn();
    const result = await handleTokenExchange(
      { grantType: "authorization_code", props: { ...baseProps, accessTokenExpiresAt: NOW + 900 } },
      { refresh, now: () => NOW },
    );
    expect(result).toEqual({ accessTokenTTL: 840 });
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("handleTokenExchange — refresh_token", () => {
  it("on success rotates upstream tokens into props and aligns the TTL", async () => {
    const newAccess = jwtWithExp(NOW + 3600);
    const refresh = vi.fn().mockResolvedValue({ ok: true, accessToken: newAccess, refreshToken: "new-refresh", expiresIn: 3600 });

    const result = await handleTokenExchange({ grantType: "refresh_token", props: baseProps }, { refresh, now: () => NOW });

    expect(refresh).toHaveBeenCalledWith("old-refresh");
    expect(result).toEqual({
      newProps: { ...baseProps, accessToken: newAccess, refreshToken: "new-refresh", accessTokenExpiresAt: NOW + 3600 },
      accessTokenTTL: 3540,
    });
  });

  it("keeps the old upstream refresh token when the upstream does not rotate it", async () => {
    const refresh = vi.fn().mockResolvedValue({ ok: true, accessToken: "opaque-new", expiresIn: 3600 });
    const result = await handleTokenExchange({ grantType: "refresh_token", props: baseProps }, { refresh, now: () => NOW });
    expect((result as { newProps: { refreshToken: string } }).newProps.refreshToken).toBe("old-refresh");
  });

  it("on a permanent upstream rejection throws UpstreamGrantRevokedError (forces clean re-auth)", async () => {
    const refresh = vi.fn().mockResolvedValue({ ok: false, permanent: true, status: 400, detail: '{"error":"invalid_grant"}' });
    await expect(handleTokenExchange({ grantType: "refresh_token", props: baseProps }, { refresh, now: () => NOW })).rejects.toBeInstanceOf(
      UpstreamGrantRevokedError,
    );
  });

  it("with no upstream refresh token at all also forces re-auth", async () => {
    const refresh = vi.fn();
    const props = { ...baseProps, refreshToken: undefined };
    await expect(handleTokenExchange({ grantType: "refresh_token", props }, { refresh, now: () => NOW })).rejects.toBeInstanceOf(
      UpstreamGrantRevokedError,
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it("on a transient upstream failure issues a 60s MCP token so the client retries soon", async () => {
    const refresh = vi.fn().mockResolvedValue({ ok: false, permanent: false, status: 503 });
    const result = await handleTokenExchange({ grantType: "refresh_token", props: baseProps }, { refresh, now: () => NOW });
    expect(result).toEqual({ accessTokenTTL: 60 });
  });
});

describe("withTokenErrorHandling", () => {
  const request = new Request("https://mcp.example/token", { method: "POST", headers: { Origin: "https://claude.ai" } });

  it("turns UpstreamGrantRevokedError into an OAuth invalid_grant response", async () => {
    const handler = withTokenErrorHandling({
      fetch: async () => {
        throw new UpstreamGrantRevokedError("revoked");
      },
    });

    const response = await handler.fetch(request, {} as never, {} as never);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_grant", error_description: "revoked" });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://claude.ai");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rethrows unrelated errors", async () => {
    const handler = withTokenErrorHandling({
      fetch: async () => {
        throw new Error("boom");
      },
    });
    await expect(handler.fetch(request, {} as never, {} as never)).rejects.toThrow("boom");
  });

  it("passes successful responses through untouched", async () => {
    const ok = new Response("ok");
    const handler = withTokenErrorHandling({ fetch: async () => ok });
    expect(await handler.fetch(request, {} as never, {} as never)).toBe(ok);
  });
});
