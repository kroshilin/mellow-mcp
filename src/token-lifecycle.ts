import type { Props } from "./utils";

/**
 * Lifecycle of the upstream (Mellow) token wrapped inside our MCP OAuth grant.
 *
 * Invariants:
 * 1. The MCP access token never outlives the upstream access token it wraps
 *    (expires 60 s earlier), so the client refreshes before tools would 401.
 * 2. A permanent upstream refresh failure (token revoked, e.g. by Cognito
 *    GlobalSignOut when the user logs out of a Mellow web app) surfaces to the
 *    MCP client as OAuth `invalid_grant`, which makes it re-authenticate —
 *    instead of being handed fresh MCP tokens around a dead upstream token.
 * 3. A transient upstream failure yields a short-lived (60 s) MCP token so the
 *    client retries the refresh soon, rather than an hour of failing tools.
 */

const EXPIRY_MARGIN_SECONDS = 60;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 3600;
export const TRANSIENT_FAILURE_TTL_SECONDS = 60;

export class UpstreamGrantRevokedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamGrantRevokedError";
  }
}

export type UpstreamRefreshResult =
  | { ok: true; accessToken: string; refreshToken?: string; expiresIn?: number }
  | { ok: false; permanent: boolean; status?: number; detail?: string };

/** Read `exp` (epoch seconds) from a JWT without verifying it — used only for scheduling. */
export function readJwtExp(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp : undefined;
  } catch {
    return undefined;
  }
}

/**
 * When the upstream access token stops working. The JWT `exp` wins over
 * `expires_in`: the upstream may hand over an already partly used session token.
 */
export function upstreamExpiresAt({
  accessToken,
  expiresIn,
  now,
}: {
  accessToken: string;
  expiresIn?: number;
  now: number;
}): number | undefined {
  return readJwtExp(accessToken) ?? (typeof expiresIn === "number" ? now + expiresIn : undefined);
}

export function mcpAccessTokenTtl(expiresAt: number | undefined, now: number): number | undefined {
  if (expiresAt === undefined) return undefined;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, expiresAt - now - EXPIRY_MARGIN_SECONDS));
}

type ExchangeOptions = { grantType: string; props: Props };
type ExchangeDeps = {
  refresh: (refreshToken: string) => Promise<UpstreamRefreshResult>;
  now: () => number;
};
type ExchangeResult = { newProps?: Props; accessTokenTTL?: number } | undefined;

/** Body of OAuthProvider's tokenExchangeCallback, with I/O injected for testability. */
export async function handleTokenExchange({ grantType, props }: ExchangeOptions, deps: ExchangeDeps): Promise<ExchangeResult> {
  const now = deps.now();

  if (grantType === "authorization_code") {
    const ttl = mcpAccessTokenTtl(props.accessTokenExpiresAt, now);
    return ttl === undefined ? undefined : { accessTokenTTL: ttl };
  }

  if (grantType !== "refresh_token") return undefined;

  if (!props.refreshToken) {
    throw new UpstreamGrantRevokedError("No Mellow refresh token on this connection; please reconnect.");
  }

  const refreshed = await deps.refresh(props.refreshToken);
  if (!refreshed.ok) {
    if (refreshed.permanent) {
      console.warn(`Upstream refresh rejected (${refreshed.status}); forcing re-auth. Detail: ${refreshed.detail ?? "n/a"}`);
      throw new UpstreamGrantRevokedError("Mellow session expired or was revoked; please reconnect.");
    }
    console.warn(`Upstream refresh failed transiently (${refreshed.status ?? "network"}); issuing short-lived MCP token.`);
    return { accessTokenTTL: TRANSIENT_FAILURE_TTL_SECONDS };
  }

  const accessTokenExpiresAt = upstreamExpiresAt({ accessToken: refreshed.accessToken, expiresIn: refreshed.expiresIn, now });
  const newProps: Props = {
    ...props,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? props.refreshToken,
    accessTokenExpiresAt,
  };
  const ttl = mcpAccessTokenTtl(accessTokenExpiresAt, now);
  return ttl === undefined ? { newProps } : { newProps, accessTokenTTL: ttl };
}

type FetchHandler<E> = { fetch: (request: Request, env: E, ctx: ExecutionContext) => Promise<Response> };

/**
 * The OAuth library has no try/catch around the token callback, so a thrown
 * error would become a bare 500. Translate our typed error into the standard
 * OAuth error response (RFC 6749 §5.2) that makes clients re-authenticate.
 */
export function withTokenErrorHandling<E>(inner: FetchHandler<E>): FetchHandler<E> {
  return {
    async fetch(request, env, ctx) {
      try {
        return await inner.fetch(request, env, ctx);
      } catch (error) {
        if (!(error instanceof UpstreamGrantRevokedError)) throw error;
        const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
        const origin = request.headers.get("Origin");
        if (origin) {
          headers.set("Access-Control-Allow-Origin", origin);
          headers.set("Vary", "Origin");
        }
        return new Response(JSON.stringify({ error: "invalid_grant", error_description: error.message }), { status: 400, headers });
      }
    },
  };
}
