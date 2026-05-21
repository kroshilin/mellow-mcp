import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asStructuredObject, type MellowClient } from "../../mellow-client";

/**
 * MatchedFreelancers tools — Scout-side hiring flow.
 *
 * Lives on the existing Scout backend (aiscout-api.mellow.io). Reuses the
 * scoutClient already constructed in src/index.ts.
 *
 * Lifecycle: position created (outside this MCP) → backend auto-starts matching →
 * agent polls list until status='completed' → user reviews matches → markViewed
 * on open → invite on confirm. requestMatching only when user explicitly asks
 * (rate-limited 3/hour/position).
 *
 * Spec sourced from aihr_service/.claude/tasks/MCP-Matched-Freelancers.md.
 */
export function registerMatchedFreelancersTools(server: McpServer, client: MellowClient) {
  server.tool(
    "scout_listMatchedFreelancers",
    "List candidates matched to a position. Returns {status, matches[]}. status='in_progress' means matching is still running — poll every 3-5s, up to 5 min total. 'completed' means matches[] is final, sorted by score DESC. 'failed' means the run errored — suggest scout_requestMatching to retry. Each match has matchId (use in get/markViewed/invite), score, optional explanation, status (new|viewed|invited), and a full profile (name, email, expertise area, country, experience, portfolio, CV, referral rate). Call this after a position is created, after the user reopens the matches screen, and after a manual requestMatching.",
    {
      positionId: z.string().uuid().describe("Position UUID — id of the position to list matches for"),
    },
    { title: "Scout: list matched freelancers", readOnlyHint: true },
    async ({ positionId }) => {
      const result = await client.get<unknown>(`/positions/${positionId}/matched-freelancers`);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "scout_getMatchedFreelancer",
    "Get one matched freelancer in the context of a specific position. Returns the same match object as one element of scout_listMatchedFreelancers' matches[] — including matchId, score, explanation, status, full profile. Use this when the user opens a detail screen separately from the list, or when you need the freshest status (the cached list may be stale).",
    {
      positionId: z.string().uuid().describe("Position UUID"),
      matchId: z.string().uuid().describe("Match UUID — from scout_listMatchedFreelancers matches[].matchId"),
    },
    { title: "Scout: get matched freelancer", readOnlyHint: true },
    async ({ positionId, matchId }) => {
      const result = await client.get<unknown>(`/positions/${positionId}/matched-freelancers/${matchId}`);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "scout_markMatchedFreelancerViewed",
    "Mark a matched freelancer as viewed by the hirer. Backend sets viewedAt on first call; status transitions new → viewed. Idempotent — call every time the user opens a candidate's card; repeated calls do not overwrite the first viewedAt. Returns wrapped 'Ok' envelope ({ok: true, raw: 'Ok'}).",
    {
      positionId: z.string().uuid().describe("Position UUID"),
      matchId: z.string().uuid().describe("Match UUID"),
    },
    { title: "Scout: mark matched freelancer viewed" },
    async ({ positionId, matchId }) => {
      const result = await client.post<unknown>(`/positions/${positionId}/matched-freelancers/${matchId}/view`);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "scout_inviteMatchedFreelancer",
    "Send the matched freelancer an email inviting them to apply to the position. Backend creates an invitation record and transitions match status (new|viewed) → invited. NOT idempotent — a second invite for the same matchId returns 409 'alreadyInvited'. CONFIRM with the user before calling — once this returns, the email is in the freelancer's inbox; there is no un-invite. Returns wrapped 'Ok' envelope.",
    {
      positionId: z.string().uuid().describe("Position UUID"),
      matchId: z.string().uuid().describe("Match UUID"),
    },
    { title: "Scout: invite matched freelancer", openWorldHint: true },
    async ({ positionId, matchId }) => {
      const result = await client.post<unknown>(`/positions/${positionId}/matched-freelancers/${matchId}/invitation`);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "scout_requestMatching",
    "Ask the backend to re-run matching for a position. Async — returns immediately with status='in_progress' and matches=[]; poll scout_listMatchedFreelancers for results. Use ONLY when (a) the user updated the position and wants fresh candidates, (b) the previous run is in 'failed' state, or (c) the user explicitly asks to refresh. Do NOT call right after creating a position — matching auto-starts on create, calling again returns 409. Rate-limited 3 requests/hour/position; 429 if exceeded. 409 also fires if a run is already in progress or the previous results are still valid.",
    {
      positionId: z.string().uuid().describe("Position UUID"),
    },
    { title: "Scout: request matching re-run", openWorldHint: true },
    async ({ positionId }) => {
      const result = await client.post<unknown>(`/positions/${positionId}/matched-freelancers`);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );
}
