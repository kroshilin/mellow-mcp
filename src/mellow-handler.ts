import { env } from "cloudflare:workers";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { fetchUpstreamAuthToken, getUpstreamAuthorizeUrl, type Props } from "./utils";
import {
  addApprovedClient,
  bindStateToSession,
  createOAuthState,
  generateCSRFProtection,
  isClientApproved,
  OAuthError,
  renderApprovalDialog,
  validateCSRFToken,
  validateOAuthState,
} from "./workers-oauth-utils";

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

app.get("/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const { clientId } = oauthReqInfo;
  if (!clientId) {
    return c.text("Invalid request", 400);
  }

  // Check if client is already approved
  if (await isClientApproved(c.req.raw, clientId, env.COOKIE_ENCRYPTION_KEY)) {
    // Skip approval dialog but still create secure state and bind to session
    const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
    const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);
    return redirectToMellow(c.req.raw, stateToken, { "Set-Cookie": sessionBindingCookie });
  }

  // Generate CSRF protection for the approval form
  const { token: csrfToken, setCookie } = generateCSRFProtection();

  return renderApprovalDialog(c.req.raw, {
    client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
    csrfToken,
    server: {
      description: "MCP Remote Server using Mellow for authentication.",
      name: "Mellow MCP Server",
    },
    setCookie,
    state: { oauthReqInfo },
  });
});

app.post("/authorize", async (c) => {
  try {
    // Read form data once
    const formData = await c.req.raw.formData();

    // Validate CSRF token
    validateCSRFToken(formData, c.req.raw);

    // Extract state from form data
    const encodedState = formData.get("state");
    if (!encodedState || typeof encodedState !== "string") {
      return c.text("Missing state in form data", 400);
    }

    let state: { oauthReqInfo?: AuthRequest };
    try {
      state = JSON.parse(atob(encodedState));
    } catch (_e) {
      return c.text("Invalid state data", 400);
    }

    if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
      return c.text("Invalid request", 400);
    }

    // Add client to approved list
    const approvedClientCookie = await addApprovedClient(c.req.raw, state.oauthReqInfo.clientId, c.env.COOKIE_ENCRYPTION_KEY);

    // Create OAuth state and bind it to this user's session
    const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
    const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);

    // Set both cookies: approved client list + session binding
    const headers = new Headers();
    headers.append("Set-Cookie", approvedClientCookie);
    headers.append("Set-Cookie", sessionBindingCookie);

    return redirectToMellow(c.req.raw, stateToken, Object.fromEntries(headers));
  } catch (error: any) {
    if (error instanceof OAuthError) {
      return error.toResponse();
    }
    // Unexpected non-OAuth error
    return c.text(`Internal server error: ${error.message}`, 500);
  }
});

async function redirectToMellow(request: Request, stateToken: string, headers: Record<string, string> = {}) {
  return new Response(null, {
    headers: {
      ...headers,
      location: getUpstreamAuthorizeUrl({
        client_id: env.MELLOW_CLIENT_ID,
        redirect_uri: new URL("/callback", request.url).href,
        scope: "openid profile email",
        state: stateToken,
        upstream_url: `${env.MELLOW_BASE_URL}/authorize`,
      }),
    },
    status: 302,
  });
}

/**
 * OAuth Callback Endpoint
 *
 * This route handles the callback from Mellow after user authentication.
 * It exchanges the temporary code for an access token, then stores some
 * user metadata & the auth token as part of the 'props' on the token passed
 * down to the client. It ends by redirecting the client back to _its_ callback URL
 *
 * SECURITY: This endpoint validates that the state parameter from Mellow
 * matches both:
 * 1. A valid state token in KV (proves it was created by our server)
 * 2. The __Host-CONSENTED_STATE cookie (proves THIS browser consented to it)
 *
 * This prevents CSRF attacks where an attacker's state token is injected
 * into a victim's OAuth flow.
 */
app.get("/callback", async (c) => {
  // Validate OAuth state with session binding
  // This checks both KV storage AND the session cookie
  let oauthReqInfo: AuthRequest;
  let clearSessionCookie: string;

  try {
    const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
    oauthReqInfo = result.oauthReqInfo;
    clearSessionCookie = result.clearCookie;
  } catch (error: any) {
    if (error instanceof OAuthError) {
      return error.toResponse();
    }
    // Unexpected non-OAuth error
    return c.text("Internal server error", 500);
  }

  if (!oauthReqInfo.clientId) {
    return c.text("Invalid OAuth request data", 400);
  }

  // Exchange the code for an access token
  const [tokens, errResponse] = await fetchUpstreamAuthToken({
    client_id: c.env.MELLOW_CLIENT_ID,
    client_secret: c.env.MELLOW_CLIENT_SECRET,
    code: c.req.query("code"),
    redirect_uri: new URL("/callback", c.req.url).href,
    upstream_url: `${c.env.MELLOW_BASE_URL}/token`,
  });

  if (errResponse) return errResponse;

  // Fetch identity + role from Mellow's /api/profile.
  //
  // Replaces the previous /userinfo path which is a customer-only Mellow
  // endpoint and returns non-2xx for freelancer accounts. /api/profile is
  // role-aware and returns the same shape (ProfileWithSettings) for both
  // customer and freelancer (only the values differ — `type` is the
  // discriminator). uuid here equals the Cognito JWT `sub` claim.
  //
  // 5s timeout closes review feedback I-2 (slice 1 had no timeout on this
  // probe, so a hung Mellow API would stall the OAuth interactive flow).
  type MellowProfile = {
    uuid?: string;
    id?: number;
    email?: string;
    firstName?: string | null;
    lastName?: string | null;
    name?: string;
    type?: string;
  };

  let profile: MellowProfile;
  try {
    const profileResponse = await fetch(`${c.env.MELLOW_API_BASE_URL}/profile`, {
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!profileResponse.ok) {
      const body = await profileResponse.text().catch(() => "");
      return c.text(`Failed to fetch /api/profile (${profileResponse.status}): ${body}`, 500);
    }
    profile = (await profileResponse.json()) as MellowProfile;
  } catch (err) {
    return c.text(`Failed to fetch /api/profile: ${String(err)}`, 500);
  }

  if (!profile.uuid) {
    return c.text("Mellow /api/profile returned no uuid; cannot complete OAuth", 500);
  }

  const sub = profile.uuid;
  const email = profile.email ?? "";
  // `name` is a backend-computed getter that may return strings with trailing
  // whitespace ("Petrova Anna "). Trim, fallback to firstName + lastName.
  const name = profile.name?.trim() || [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim() || "Mellow User";
  // `type` enum: "customer" | "freelancer" | "administrator" | "".
  // Anything other than "freelancer" defaults to "customer" — administrator
  // and unknown are not expected to use this MCP, but customer flow is the
  // safer default if they do (existing behavior, no extra surface).
  const userRole: "customer" | "freelancer" = profile.type === "freelancer" ? "freelancer" : "customer";

  // Return back to the MCP client a new token
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    metadata: {
      label: name,
    },
    // This will be available on this.props inside MyMCP
    props: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      email,
      name,
      sub,
      userRole,
    } as Props,
    request: oauthReqInfo,
    scope: oauthReqInfo.scope,
    userId: sub,
  });

  // Clear the session binding cookie (one-time use) by creating response with headers
  const headers = new Headers({ Location: redirectTo });
  if (clearSessionCookie) {
    headers.set("Set-Cookie", clearSessionCookie);
  }

  return new Response(null, {
    status: 302,
    headers,
  });
});

export { app as MellowHandler };
