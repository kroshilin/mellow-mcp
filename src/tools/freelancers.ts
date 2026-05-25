import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asStructuredList, asStructuredObject, type MellowClient } from "../mellow-client";

export function registerFreelancerTools(server: McpServer, client: MellowClient) {
  server.tool(
    "listFreelancers",
    "List freelancers in the active company. Excluded freelancers are NOT returned. The response has no `agree` field — distinguish active vs invited via `isRegistered` and `actualRegDate`. Default sort: id desc. size cap 500 (silent fallback to 20 above).",
    {
      taxationStatusId: z.number().optional().describe("Filter by taxation status ID"),
      isVerified: z.boolean().optional().describe("Filter by verification status"),
      isRegistered: z.boolean().optional().describe("Filter by registration status (has the freelancer activated their account?)"),
      isInviteEmailSent: z.boolean().optional().describe("Filter by invite email sent status"),
      dateInvitedFrom: z.string().optional().describe("Filter by invite date from"),
      dateInvitedTo: z.string().optional().describe("Filter by invite date to"),
      dateRegisteredFrom: z.string().optional().describe("Filter by registration date from"),
      dateRegisteredTo: z.string().optional().describe("Filter by registration date to"),
      dateVerifiedFrom: z.string().optional().describe("Filter by verification date from"),
      dateVerifiedTo: z.string().optional().describe("Filter by verification date to"),
      workerCategoryId: z.array(z.number()).optional().describe("Filter by worker category IDs (OR)"),
      country: z.array(z.string()).optional().describe("Filter by country codes (OR)"),
      search: z.string().optional().describe("Search across email, name, phone, id, uuid"),
      note: z.string().optional().describe("Filter by note text"),
      id: z.number().optional().describe("Filter by freelancer ID"),
      uuid: z.string().optional().describe("Filter by freelancer UUID"),
      email: z.string().optional().describe("Filter by exact email"),
      sort: z
        .enum(["id", "dateVerified", "actualRegDate", "inviteSentAt", "email", "name"])
        .optional()
        .describe("Sort field (default: id)"),
      direction: z.enum(["asc", "desc"]).optional().describe("Sort direction (default: desc)"),
      page: z.number().optional().describe("Page number"),
      size: z.number().max(500).optional().describe("Page size (max 500). Values > 500 silently default to 20."),
    },
    { title: "List freelancers", readOnlyHint: true },
    async (params) => {
      // Backend filter expects int (1/0), not the JS-stringified "true"/"false"
      // — without this coercion it 422s with "must be one of int, string given".
      const bool = (v: boolean | undefined): string | undefined => (v === undefined ? undefined : v ? "1" : "0");
      const queryParams: Record<string, string | undefined> = {
        "filter[taxationStatusId]": params.taxationStatusId?.toString(),
        "filter[isVerified]": bool(params.isVerified),
        "filter[isRegistered]": bool(params.isRegistered),
        "filter[isInviteEmailSent]": bool(params.isInviteEmailSent),
        "filter[dateInvitedFrom]": params.dateInvitedFrom,
        "filter[dateInvitedTo]": params.dateInvitedTo,
        "filter[dateRegisteredFrom]": params.dateRegisteredFrom,
        "filter[dateRegisteredTo]": params.dateRegisteredTo,
        "filter[dateVerifiedFrom]": params.dateVerifiedFrom,
        "filter[dateVerifiedTo]": params.dateVerifiedTo,
        "filter[search]": params.search,
        "filter[note]": params.note,
        "filter[id]": params.id?.toString(),
        "filter[uuid]": params.uuid,
        "filter[email]": params.email,
        sort: params.sort,
        direction: params.direction,
        page: params.page?.toString(),
        size: params.size?.toString(),
      };

      if (params.workerCategoryId?.length) {
        for (const cid of params.workerCategoryId) {
          queryParams[`filter[workerCategoryId][]`] = cid.toString();
        }
      }
      if (params.country?.length) {
        for (const c of params.country) {
          queryParams[`filter[country][]`] = c;
        }
      }

      const result = await client.get<unknown>("/customer/freelancers", queryParams);
      return {
        structuredContent: asStructuredList(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "getFreelancer",
    "Get one freelancer card from the active company. Accepts numeric ID or UUID — UUID preferred. Returns the same shape as one row of listFreelancers (no nested tax/payout/agreement blocks — those are separate endpoints). 404 covers both 'not found' and 'wrong company' (security-by-obscurity); excluded freelancers also return 404.",
    {
      freelancerId: z.string().describe("Freelancer ID (numeric) or UUID. UUID preferred."),
    },
    { title: "Get freelancer", readOnlyHint: true },
    async ({ freelancerId }) => {
      const result = await client.get<unknown>(`/customer/freelancers/${freelancerId}`);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "inviteFreelancer",
    "Invite a freelancer to the active company by email. Creates the user if they don't exist, then adds membership. Returns {uuid, freelancerId}. Idempotency: re-inviting an already-active membership → HTTP 422 'already in team'; concurrent invites on the same email → HTTP 423 (brief backend lock). For new users name/address/birthdate apply at creation; for existing freelancers only `note` and `specialization` are saved, the rest is ignored. `phone` is silently ignored if the company doesn't have phone-feature enabled.",
    {
      email: z.string().describe("Freelancer email address"),
      phone: z.string().optional().describe("Phone number (silently ignored if company doesn't have phone-feature)"),
      firstName: z.string().optional().describe("First name (applied only at user creation)"),
      lastName: z.string().optional().describe("Last name (applied only at user creation)"),
      middleName: z.string().optional().describe("Middle name (applied only at user creation)"),
      citizenship: z.string().optional().describe("Citizenship country code (applied only at user creation)"),
      address: z.string().optional().describe("Address (applied only at user creation)"),
      postalCode: z.string().optional().describe("Postal code (applied only at user creation)"),
      city: z.string().optional().describe("City (applied only at user creation)"),
      state: z.string().optional().describe("State/region (applied only at user creation)"),
      country: z.string().optional().describe("Country code (applied only at user creation)"),
      birthdate: z.string().optional().describe("Birth date (applied only at user creation)"),
      birthCountry: z.string().optional().describe("Birth country code (applied only at user creation)"),
      specialization: z
        .number()
        .optional()
        .describe("Specialization ID (numeric) from getSpecializations(). Saved per-freelancer globally."),
      note: z.string().optional().describe("Per-company note about the freelancer"),
      inEnglish: z
        .boolean()
        .optional()
        .describe("If true, forces English for the new user's profile language and the invitation email. Only EN/RU supported here."),
      sendEmail: z
        .boolean()
        .optional()
        .describe(
          "Whether to send the invitation email (default: true). Pass false for bulk import / custom onboarding / pre-creating membership without email.",
        ),
      redirectUrl: z.string().optional().describe("Redirect URL after the freelancer accepts the invite"),
    },
    { title: "Invite freelancer", openWorldHint: true },
    async (params) => {
      const result = await client.post<unknown>("/customer/freelancers", params);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "findFreelancerByEmail",
    "Find a freelancer in the active company by email. Returns the same shape as getFreelancer. Case-sensitive — pass lowercase.",
    {
      email: z.string().describe("Email address to search (lowercase recommended)"),
    },
    { title: "Find freelancer by email", readOnlyHint: true },
    async ({ email }) => {
      const result = await client.get<unknown>(`/customer/freelancer-by-email/${encodeURIComponent(email)}`);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "findFreelancerByPhone",
    "Find a freelancer in the active company by phone. Pass DIGITS ONLY — no '+', spaces, or dashes (those return 404). Phone uniqueness is global at the user level, but visibility is per-company. Returns HTTP 403 if the company doesn't have the phone-search feature enabled (contact Mellow support to enable it).",
    {
      phone: z.string().describe("Phone number — digits only, no '+', spaces, or dashes"),
    },
    { title: "Find freelancer by phone", readOnlyHint: true },
    async ({ phone }) => {
      const result = await client.get<unknown>(`/customer/freelancer-by-phone/${encodeURIComponent(phone)}`);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "editFreelancer",
    "Edit per-company alias fields of a freelancer: firstName, lastName, note, specialization. WARNING: PUT semantics — fields not passed are reset to empty string. Always pass all four fields, or use a read-then-write pattern. firstName/lastName here are the per-company alias used in agreement/payslip templates, NOT the freelancer's KYC name. Email/phone/address/birthdate cannot be edited via this tool.",
    {
      freelancerId: z.number().describe("Freelancer ID. Provide this OR freelancerUuid."),
      freelancerUuid: z.string().optional().describe("Freelancer UUID. Provide this OR freelancerId."),
      firstName: z.string().optional().describe("Per-company alias first name. Will be cleared if not passed."),
      lastName: z.string().optional().describe("Per-company alias last name. Will be cleared if not passed."),
      note: z.string().optional().describe("Per-company note. Will be cleared if not passed."),
      specialization: z.number().optional().describe("Specialization ID from getSpecializations(). Saved globally."),
    },
    { title: "Edit freelancer alias", idempotentHint: true },
    async (params) => {
      const result = await client.put<unknown>("/customer/freelancers", params);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "editFreelancerProfile",
    "Patch the GLOBAL profile of a freelancer BEFORE they activate or pass KYC. PATCH semantics — partial updates are safe (fields not passed are preserved). After activation/verification the entire profile is read-only and any field edit returns HTTP 409 (lock is bulk, not per-field).",
    {
      freelancerId: z.number().optional().describe("Freelancer ID. Provide this OR freelancerUuid."),
      freelancerUuid: z.string().optional().describe("Freelancer UUID. Provide this OR freelancerId."),
      firstName: z.string().optional().describe("First name"),
      lastName: z.string().optional().describe("Last name"),
      middleName: z.string().optional().describe("Middle name"),
      residenceCountry: z.string().optional().describe("Residence country code"),
      citizenship: z.string().optional().describe("Citizenship country code"),
      birthDate: z.string().optional().describe("Birth date (ISO 8601)"),
      birthCountry: z.string().optional().describe("Birth country code"),
      city: z.string().optional().describe("City"),
      address: z.string().optional().describe("Address"),
      postalCode: z.string().optional().describe("Postal code"),
      state: z.string().optional().describe("State/region"),
      language: z
        .enum(["EN", "RU", "ES", "PT"])
        .optional()
        .describe("Profile language (UI, emails, templates). Supported: EN, RU, ES, PT."),
    },
    { title: "Edit freelancer profile", idempotentHint: true },
    async (params) => {
      const result = await client.patch<unknown>("/customer/freelancers/profile", params);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "removeFreelancer",
    "Soft-delete the freelancer's membership in the active company. Backend BLOCKS the delete with HTTP 422 'Worker have not finished tasks' if any task is in a non-terminal state in this company — so no task-zombies. The DELETE is async — HTTP 200 returns before the status flip is fully reflected. Re-invite reactivates the same membership record (per-company note + specialization survive). Idempotent on already-excluded freelancers.",
    {
      freelancerId: z.number().describe("Freelancer ID to remove"),
    },
    { title: "Remove freelancer", destructiveHint: true, idempotentHint: true },
    async ({ freelancerId }) => {
      const result = await client.del<unknown>(`/customer/freelancers/${freelancerId}`);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "getFreelancerTaxInfo",
    "Get tax metadata for a freelancer (5 fields: taxResidenceCountry, type/taxDocumentType, taxNumber, vatNumber, regNumber). Backend returns 200 with all fields set to null when the freelancer has not filled in tax data — DO NOT treat null fields as the request failing. Only the customer of the active company can read; switch company to read for another. taxationStatusId is on the regular getFreelancer response, not here.",
    {
      freelancerId: z.number().describe("Freelancer ID"),
    },
    { title: "Get freelancer tax info", readOnlyHint: true },
    async ({ freelancerId }) => {
      const result = await client.get<unknown>(`/customer/freelancers/tax-info/${freelancerId}`);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );
}
