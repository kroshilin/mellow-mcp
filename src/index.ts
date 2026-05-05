import { env } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { AGENT_PRIMER } from "./agent-primer";
import DOMAIN_MD from "../docs/DOMAIN.md";
import WORKFLOWS_MD from "../docs/WORKFLOWS.md";
import ANTI_PATTERNS_MD from "../docs/ANTI_PATTERNS.md";
import { createMellowClient } from "./mellow-client";
import { MellowHandler } from "./mellow-handler";
import { registerChatGptTools } from "./tools/chatgpt";
import { registerCompanyTools } from "./tools/companies";
import { registerDocumentTools } from "./tools/documents";
import { registerFinanceTools } from "./tools/finances";
import { registerFreelancerTools } from "./tools/freelancers";
import { registerProfileTools } from "./tools/profile";
import { registerReferenceTools } from "./tools/reference";
import { registerReferenceFallbackTool } from "./tools/reference-tool-fallback";
import { registerTaskGroupTools } from "./tools/task-groups";
import { registerTaskTools } from "./tools/tasks";
import { registerWebhookTools } from "./tools/webhooks";
import { registerScoutAiTaskTools } from "./tools/scout/ai-tasks";
import { registerScoutApplicationTools } from "./tools/scout/applications";
import { registerScoutAttachmentTools } from "./tools/scout/attachments";
import { registerScoutCompanyTools } from "./tools/scout/companies";
import { registerScoutLookupTools } from "./tools/scout/lookup";
import { registerScoutPoolTools } from "./tools/scout/pool";
import { registerScoutPositionTools } from "./tools/scout/positions";
import { registerScoutPromoPostTools } from "./tools/scout/promo-posts";
import { registerF2bClientTools } from "./tools/f2b/clients";
import { refreshUpstreamToken, type Props } from "./utils";

export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer(
    {
      name: "Mellow & Scout MCP Server",
      version: "1.1.0",
    },
    {
      // Returned in the MCP `initialize` response and typically injected as
      // a system prompt by clients (Claude Desktop, Cursor, Inspector). Full
      // reference docs are exposed as resources (mellow://domain etc.).
      instructions: AGENT_PRIMER,
    },
  );

  async init() {
    try {
      const userRole = this.props?.userRole ?? "customer";
      const client = createMellowClient(this.env.MELLOW_API_BASE_URL, this.props!.accessToken, this.props!.activeCompanyId);

      if (userRole === "customer") {
        registerTaskTools(this.server, client);
        registerTaskGroupTools(this.server, client);
        registerFreelancerTools(this.server, client);
        registerFinanceTools(this.server, client);
        registerCompanyTools(this.server, client);
        registerDocumentTools(this.server, client);
        registerReferenceTools(this.server, client);
        registerWebhookTools(this.server, client);
        registerProfileTools(this.server, client);
        registerChatGptTools(this.server, client);

        registerReferenceFallbackTool(this.server, {
          domain: DOMAIN_MD,
          workflows: WORKFLOWS_MD,
          antiPatterns: ANTI_PATTERNS_MD,
        });

        const scoutClient = createMellowClient(this.env.SCOUT_API_BASE_URL, this.props!.accessToken, this.props!.activeCompanyId);

        registerScoutPositionTools(this.server, scoutClient);
        registerScoutApplicationTools(this.server, scoutClient);
        registerScoutAiTaskTools(this.server, scoutClient);
        registerScoutPromoPostTools(this.server, scoutClient);
        registerScoutPoolTools(this.server, scoutClient);
        registerScoutAttachmentTools(this.server, scoutClient);
        registerScoutCompanyTools(this.server, scoutClient);
        registerScoutLookupTools(this.server, scoutClient);
      }

      if (userRole === "freelancer") {
        // F2B (freelancer-to-business invoicing). First slice: client management.
        // Invoice tools and other freelancer-side surface land in subsequent PRs.
        registerF2bClientTools(this.server, client);
        registerProfileTools(this.server, client);
      }

      // MCP resources — full reference docs the agent can read on demand.
      // Pointers to these are in AGENT_PRIMER (returned via `instructions`).
      this.server.registerResource(
        "mellow-domain-guide",
        "mellow://domain",
        {
          title: "Mellow Domain Guide",
          description:
            "Full domain reference for agents working with the Mellow & Scout MCP: actors, products (CoR + AI Scout), state machines, preconditions, decision trees. Read before producing tool calls for unfamiliar flows.",
          mimeType: "text/markdown",
        },
        async (uri) => ({
          contents: [{ uri: uri.href, mimeType: "text/markdown", text: DOMAIN_MD }],
        }),
      );

      this.server.registerResource(
        "mellow-workflows",
        "mellow://workflows",
        {
          title: "Mellow Workflows (12 end-to-end recipes)",
          description:
            "End-to-end recipes: onboarding + first task, accept-and-pay (two-step), Scout hire, multi-currency, bulk invite, bulk task creation, etc. Each recipe lists preconditions, concrete tool sequence, error handling, and 'done when' criteria.",
          mimeType: "text/markdown",
        },
        async (uri) => ({
          contents: [{ uri: uri.href, mimeType: "text/markdown", text: WORKFLOWS_MD }],
        }),
      );

      this.server.registerResource(
        "mellow-anti-patterns",
        "mellow://anti-patterns",
        {
          title: "Mellow Anti-patterns (common agent mistakes)",
          description:
            "Catalogue of common agent mistakes when driving the MCP, with corrected patterns. Bad / Why / Good per entry. 12 categories: state-machine traps, createTask traps, read-your-writes, multi-company, money, Scout permissive backend, bulk import, errors, schema confusion, confirmation/safety, and removed tools.",
          mimeType: "text/markdown",
        },
        async (uri) => ({
          contents: [{ uri: uri.href, mimeType: "text/markdown", text: ANTI_PATTERNS_MD }],
        }),
      );
    } catch (error) {
      console.error("MCP init failed:", error);
      throw error;
    }
  }
}

export default new OAuthProvider({
  apiHandler: MyMCP.serve("/mcp"),
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  defaultHandler: MellowHandler as any,
  tokenEndpoint: "/token",
  refreshTokenTTL: 2592000, // 30 days
  async tokenExchangeCallback({ grantType, props }) {
    if (grantType !== "refresh_token" || !props.refreshToken) {
      return;
    }

    const refreshed = await refreshUpstreamToken({
      client_id: env.MELLOW_CLIENT_ID,
      client_secret: env.MELLOW_CLIENT_SECRET,
      refresh_token: props.refreshToken,
      upstream_url: `${env.MELLOW_BASE_URL}/token`,
    });

    if (!refreshed) {
      return;
    }

    return {
      newProps: {
        ...props,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? props.refreshToken,
      },
    };
  },
});
