import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asStructuredList, asStructuredObject, type MellowClient } from "../../mellow-client";
import {
  currencyToId,
  f2bClientStatusEnum,
  f2bCommissionPayerEnum,
  f2bCurrencyEnum,
  f2bLineItemSchema,
  idToCurrency,
  mapCurrencyIdToCode,
  normalizeLineItems,
  readCurrencyId,
  resolveInvoiceableClientCurrency,
  toIsoDate,
} from "./shared";

/**
 * Secure Deal (escrow) tools for freelancer mode.
 *
 * Backend facts these tools rely on (cabinet, Symfony API):
 *  - A Secure Deal is an f2b_invoices row with work_completed = 0; it shares
 *    the F2B client list with classic invoices.
 *  - Routes: Controller/Freelancer/SecureDealController.php
 *    (/api/v2/freelancer/secure-deals...), gated by the `secureDeals` flag.
 *  - Status guards: Solar/F2BInvoice/Domain/Invoice.php + Security/Voters/F2BVoter.php.
 */

const DEALS_PATH = "/v2/freelancer/secure-deals";
const DEALS_WIDGET_PATH = "/freelancer/widgets/deals";

const DEAL_STATUS = [
  "new",
  "sent",
  "in_work",
  "client_review",
  "for_payment",
  "finished",
  "rejected",
  "revision_requested",
  "waiting_deadline_decision",
  "declined_by_customer",
  "dispute_in_progress",
  "cancelled",
] as const;
const dealStatusEnum = z.enum(DEAL_STATUS);

/** F2BVoter::canUpdateInvoice / Invoice::updateDealTerms. */
const DEAL_EDITABLE_STATUSES = ["new", "sent", "rejected"];
/** F2BVoter::canCancelInvoice / Invoice::cancel. */
const DEAL_CANCELLABLE_STATUSES = ["new", "sent"];
/** Linked card payment states that freeze a deal's terms (CardPaymentTermsLock). */
const CARD_HOLD_PAYMENT_STATUSES = ["authorized", "completed"];

/** DealFetcher::mapSortField allow-list (unknown fields fall back to createdAt). */
const DEAL_SORT_FIELDS = ["createdAt", "number", "clientName", "serviceName", "amount", "status", "serviceDeadline", "id"] as const;

/** FetcherParamConverter caps size at 500 (larger values silently reset to 20). */
const SUMMARY_PAGE_SIZE = 500;
const SUMMARY_MAX_PAGES = 5;

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const FIELD_DOCS = {
  dealId: "Numeric deal id (the `id` from deal_list / deal_create — not the deal number)",
  serviceId: "Service category id from f2b_searchServices",
  serviceName: "The service category's name exactly as returned by f2b_searchServices for that serviceId",
  serviceDeadline: "Work deadline, YYYY-MM-DD, must be after today (the freelancer has until 23:59:59 that day)",
  lineItems:
    "1–10 line items; the work description goes in the item names. Sum of price*quantity is the deal amount (≤ 10 000 in client currency)",
  commissionPayer:
    "Who pays Mellow's fee: 'customer' (the client pays it on top; the freelancer receives the full amount) or 'freelancer' (the fee is deducted from the amount)",
  acquiringEnabled:
    "true lets the client pay by card as well as bank transfer (the client pays the card fee on top). The backend silently turns it off above the card-payment cap or where card payment isn't available for this client",
} as const;

type DealRecord = Record<string, unknown>;

function respond(mapped: unknown) {
  return {
    structuredContent: asStructuredObject(mapped),
    content: [{ text: JSON.stringify(mapped, null, 2), type: "text" as const }],
  };
}

function respondList(mapped: unknown) {
  return {
    structuredContent: asStructuredList(mapped),
    content: [{ text: JSON.stringify(mapped, null, 2), type: "text" as const }],
  };
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function isAfterToday(isoDate: string): boolean {
  return isoDate > todayIsoDate();
}

function assertDeadlineAfterToday(isoDate: string): void {
  if (!isAfterToday(isoDate)) {
    throw new Error(`serviceDeadline ${isoDate} must be after today (${todayIsoDate()}). Ask the user for a later date.`);
  }
}

function dealLabel(deal: DealRecord, dealId: number): string {
  return typeof deal.number === "string" ? `deal ${deal.number} (id ${dealId})` : `deal id ${dealId}`;
}

async function loadDeal(client: MellowClient, dealId: number): Promise<DealRecord> {
  return client.get<DealRecord>(`${DEALS_PATH}/${dealId}`);
}

/** Re-read a deal after a successful write; a failed read must not mask the write. */
async function refreshDeal(client: MellowClient, dealId: number): Promise<DealRecord | undefined> {
  try {
    return await loadDeal(client, dealId);
  } catch (err) {
    console.warn(`Secure deal ${dealId} refresh failed:`, err);
    return undefined;
  }
}

function assertDealStatus(deal: DealRecord, dealId: number, allowed: readonly string[], action: string): string {
  const status = typeof deal.status === "string" ? deal.status : "unknown";
  if (!allowed.includes(status)) {
    throw new Error(
      `Cannot ${action} ${dealLabel(deal, dealId)}: its status is '${status}', allowed only in ${allowed.map((s) => `'${s}'`).join(", ")}.`,
    );
  }
  return status;
}

function clientOf(deal: DealRecord): DealRecord {
  return deal.client && typeof deal.client === "object" ? (deal.client as DealRecord) : {};
}

function reminderRecipient(deal: DealRecord): { name: string | null; email: string | null } {
  const party = clientOf(deal);
  const pick = (...values: unknown[]) => values.find((v): v is string => typeof v === "string" && v.length > 0) ?? null;
  return {
    name: pick(party.companyName, party.fullName, deal.clientName),
    email: pick(party.email, deal.clientEmail),
  };
}

type DuplicateParams = {
  dealId: number;
  serviceDeadline: string;
  clientId?: number;
  lineItems?: z.infer<typeof f2bLineItemSchema>[];
  commissionPayer?: z.infer<typeof f2bCommissionPayerEnum>;
  serviceId?: number;
  serviceName?: string;
  acquiringEnabled?: boolean;
};

/**
 * The cabinet's Duplicate (COR-1622 duplicate-as-prefill) opens the create
 * form prefilled from the source: client, service, currency, fee payer and
 * line items — but NOT the deadline and NOT the card-payment flag. We build
 * the same create payload; the user supplies the new deadline.
 */
function buildDuplicateBody(source: DealRecord, params: DuplicateParams, currencyId: number): Record<string, unknown> {
  assertServicePair(params);
  const service = source.service && typeof source.service === "object" ? (source.service as DealRecord) : {};
  const body = {
    clientId: params.clientId ?? clientOf(source).id,
    currencyId,
    commissionPayer: params.commissionPayer ?? source.commissionPayer,
    serviceId: params.serviceId ?? service.id,
    serviceName: params.serviceName ?? source.serviceName,
    serviceDeadline: params.serviceDeadline,
    lineItems: params.lineItems ?? normalizeLineItems(source.lineItems),
    acquiringEnabled: params.acquiringEnabled ?? false,
  };
  const missing = Object.entries(body)
    .filter(([, value]) => value === undefined || value === null || (Array.isArray(value) && value.length === 0))
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`Deal ${params.dealId} lacks ${missing.join(", ")}; pass them explicitly to build the copy.`);
  }
  return body;
}

/** serviceId and serviceName describe one category: change both or neither. */
function assertServicePair(params: { serviceId?: number; serviceName?: string }): void {
  if ((params.serviceId === undefined) !== (params.serviceName === undefined)) {
    throw new Error("Pass serviceId and serviceName together (both from the same f2b_searchServices row).");
  }
}

type UpdateParams = {
  dealId: number;
  lineItems?: z.infer<typeof f2bLineItemSchema>[];
  commissionPayer?: z.infer<typeof f2bCommissionPayerEnum>;
  serviceId?: number;
  serviceName?: string;
  serviceDeadline?: string;
  acquiringEnabled?: boolean;
};

const UPDATABLE_FIELDS = ["lineItems", "commissionPayer", "serviceId", "serviceName", "serviceDeadline", "acquiringEnabled"] as const;

/**
 * UpdateDealCommand requires the full payload (every field NotBlank), so the
 * user's changes are merged onto the stored deal. Client and currency are not
 * part of the command; currencyId must stay the client's (SameCurrency).
 */
function buildUpdateBody(deal: DealRecord, params: UpdateParams): Record<string, unknown> {
  if (!UPDATABLE_FIELDS.some((field) => params[field] !== undefined)) {
    throw new Error(`Nothing to update: pass at least one of ${UPDATABLE_FIELDS.join(", ")}.`);
  }
  assertServicePair(params);
  const service = deal.service && typeof deal.service === "object" ? (deal.service as Record<string, unknown>) : {};
  const body = {
    dealId: params.dealId,
    lineItems: params.lineItems ?? normalizeLineItems(deal.lineItems),
    currencyId: readCurrencyId(deal),
    commissionPayer: params.commissionPayer ?? deal.commissionPayer,
    serviceId: params.serviceId ?? service.id,
    serviceName: params.serviceName ?? deal.serviceName,
    serviceDeadline: params.serviceDeadline ?? toIsoDate(deal.serviceDeadline),
    acquiringEnabled: params.acquiringEnabled ?? deal.acquiringEnabled === true,
  };
  const missing = Object.entries(body)
    .filter(([, value]) => value === undefined || value === null || (Array.isArray(value) && value.length === 0))
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`Deal ${params.dealId} response lacks ${missing.join(", ")}; cannot build the full update payload.`);
  }
  if (!isAfterToday(body.serviceDeadline as string)) {
    throw new Error(
      params.serviceDeadline !== undefined
        ? `serviceDeadline ${body.serviceDeadline} must be after today (${todayIsoDate()}).`
        : `The deal's current deadline ${body.serviceDeadline} is not after today and the backend re-validates it on every edit. Ask the user for a new serviceDeadline and pass it in this call.`,
    );
  }
  return body;
}

function updateNotes(previousStatus: string): string[] {
  if (previousStatus === "sent") {
    return [
      "The deal was already sent: the client is emailed that the terms changed (at most one email per 30 minutes) and must pay the new terms.",
    ];
  }
  if (previousStatus === "rejected") {
    return ["The rejected deal is back in 'new' (a draft the client can't see). Confirm with the user, then call deal_send to resend it."];
  }
  return ["Draft edited; nothing was sent to the client."];
}

type CurrencyTotals = Record<string, number>;
type StatusBucket = { count: number; totalsByCurrency: CurrencyTotals };
type DealsSummary = {
  totalsByCurrency: Record<string, { count: number; amount: number }>;
  byStatus: Record<string, StatusBucket>;
  legacyOffers: { count: number; totalsByCurrency: CurrencyTotals };
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

function addAmount(totals: CurrencyTotals, currency: string, amount: number): CurrencyTotals {
  return { ...totals, [currency]: round2((totals[currency] ?? 0) + amount) };
}

/** Pure fold over list rows (already currency-mapped). Currencies are never mixed. */
function summarizeDealRows(rows: DealRecord[]): DealsSummary {
  const empty: DealsSummary = { totalsByCurrency: {}, byStatus: {}, legacyOffers: { count: 0, totalsByCurrency: {} } };
  return rows.reduce<DealsSummary>((acc, row) => {
    const amount = typeof row.amount === "number" ? row.amount : Number(row.amount ?? 0);
    const currency = typeof row.currency === "string" ? row.currency : String(row.currency ?? "unknown");
    if (row.source === "offer") {
      return {
        ...acc,
        legacyOffers: {
          count: acc.legacyOffers.count + 1,
          totalsByCurrency: addAmount(acc.legacyOffers.totalsByCurrency, currency, amount),
        },
      };
    }
    const status = typeof row.status === "string" ? row.status : "unknown";
    const bucket = acc.byStatus[status] ?? { count: 0, totalsByCurrency: {} };
    const overall = acc.totalsByCurrency[currency] ?? { count: 0, amount: 0 };
    return {
      ...acc,
      totalsByCurrency: { ...acc.totalsByCurrency, [currency]: { count: overall.count + 1, amount: round2(overall.amount + amount) } },
      byStatus: {
        ...acc.byStatus,
        [status]: { count: bucket.count + 1, totalsByCurrency: addAmount(bucket.totalsByCurrency, currency, amount) },
      },
    };
  }, empty);
}

type ListPage = { items?: unknown; pagination?: { total?: number; pages?: number } };

async function fetchAllDealRows(client: MellowClient) {
  const fetchPage = async (
    page: number,
    collected: DealRecord[],
  ): Promise<{ rows: DealRecord[]; pages: number; total: number; fetched: number }> => {
    const result = await client.get<ListPage>(`${DEALS_PATH}?page=${page}&size=${SUMMARY_PAGE_SIZE}`);
    const items = Array.isArray(result?.items) ? (mapCurrencyIdToCode(result.items) as DealRecord[]) : [];
    const rows = [...collected, ...items];
    const pages = result?.pagination?.pages ?? page;
    const total = result?.pagination?.total ?? rows.length;
    if (page >= pages || page >= SUMMARY_MAX_PAGES || items.length === 0) {
      return { rows, pages, total, fetched: page };
    }
    return fetchPage(page + 1, rows);
  };
  return fetchPage(1, []);
}

export function registerSecureDealTools(server: McpServer, client: MellowClient) {
  server.tool(
    "deal_create",
    "Create a Secure Deal as a DRAFT (status `new`). Nothing is sent and the client is not notified. A Secure Deal is escrow: the client prepays, Mellow holds the money, the freelancer delivers, the client accepts, Mellow pays the freelancer. Before calling, collect from the user: the client (clientId from f2b_searchClients; create one with f2b_createClient / f2b_createClientFromCompany / f2b_createIndividualClient if needed), the service category (serviceId + serviceName from f2b_searchServices), the deadline, line items (the work description goes in the item names), who pays Mellow's fee, and whether card payment is allowed. Currency is the client's currency (fixed per client). Composite: GET client → POST /v2/freelancer/secure-deals → GET the new deal. The returned `deal.possiblePayments[]` is the backend's breakdown per payment method (type bank / acquiring=card): `received` = what the freelancer gets, `cost` = what the client pays. Show both to the user and get an explicit 'yes' before deal_send. NEVER compute fees yourself. Backend limits: ≤ 10 line items; deal amount ≤ 10 000 in client currency; an individual (non-company) client ≤ €1,000 per calendar month across all its invoices and deals; the client must not be archived or suspended; serviceDeadline must be after today.",
    {
      clientId: z.number().int().describe("F2B client id (an `id` from f2b_searchClients rows with entryType 'client')"),
      serviceId: z.number().int().describe(FIELD_DOCS.serviceId),
      serviceName: z.string().min(1).max(1024).describe(FIELD_DOCS.serviceName),
      serviceDeadline: isoDateSchema.describe(FIELD_DOCS.serviceDeadline),
      lineItems: z.array(f2bLineItemSchema).min(1).max(10).describe(FIELD_DOCS.lineItems),
      commissionPayer: f2bCommissionPayerEnum.describe(FIELD_DOCS.commissionPayer),
      acquiringEnabled: z.boolean().optional().describe(`${FIELD_DOCS.acquiringEnabled}. Default false (bank transfer only).`),
      promoCode: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Optional promo code from the user. A valid, current code lowers Mellow's fee; an unknown code is ignored (standard fee).",
        ),
    },
    { title: "Create Secure Deal draft" },
    async (params) => {
      assertDeadlineAfterToday(params.serviceDeadline);
      const currencyId = await resolveInvoiceableClientCurrency(client, params.clientId);
      const body = {
        clientId: params.clientId,
        currencyId,
        commissionPayer: params.commissionPayer,
        serviceId: params.serviceId,
        serviceName: params.serviceName,
        serviceDeadline: params.serviceDeadline,
        lineItems: params.lineItems,
        acquiringEnabled: params.acquiringEnabled ?? false,
        ...(params.promoCode !== undefined ? { promoCode: params.promoCode } : {}),
      };
      const created = await client.post<DealRecord>(DEALS_PATH, body);
      const dealId = typeof created?.id === "number" ? created.id : undefined;
      const detail = dealId !== undefined ? await refreshDeal(client, dealId) : undefined;
      const notes = [
        "Draft only — nothing was sent to the client.",
        detail
          ? "Show the user possiblePayments[].received (freelancer gets) and .cost (client pays), then get an explicit 'yes' before deal_send."
          : "Could not load the breakdown; call deal_get({dealId}) and show possiblePayments before deal_send.",
      ];
      return respond(mapCurrencyIdToCode({ deal: detail ?? created, notes }));
    },
  );

  server.tool(
    "deal_send",
    "Send a draft Secure Deal (status `new`) to the client: the status becomes `sent` and Mellow emails the client a link to review and prepay. Confirm with the user first, restating deal number, client and amount (and the received/cost figures from deal_get); call only after an explicit 'yes'. Composite: GET deal (status check) → POST /{id}/send → GET deal (`shareLink` is the client's link). Next: the client prepays (status `in_work`, Mellow holds the money) or rejects (`rejected`; read `rejectMessage` via deal_get). Recovery: deal_update (the client is emailed about changed terms) or deal_cancel.",
    {
      dealId: z.number().int().describe(FIELD_DOCS.dealId),
    },
    { title: "Send Secure Deal to client" },
    async ({ dealId }) => {
      const deal = await loadDeal(client, dealId);
      assertDealStatus(deal, dealId, ["new"], "send");
      await client.post<unknown>(`${DEALS_PATH}/${dealId}/send`, {});
      const refreshed = await refreshDeal(client, dealId);
      return respond(
        mapCurrencyIdToCode({ deal: refreshed ?? { id: dealId, status: "sent" }, notes: ["Sent: the client has been emailed."] }),
      );
    },
  );

  server.tool(
    "deal_update",
    "Edit a Secure Deal in place (same deal and number; no new deal is created). Pass only the fields to change — the tool loads the deal and sends the full payload the backend requires (composite: GET deal → PUT /{dealId} → GET deal). Allowed only in statuses `new`, `sent` and `rejected`, and not once the client's card payment is authorized. Effects: `new` — silent draft edit; `sent` — the client is emailed that the terms changed (at most one email per 30 minutes) and a payment page opened on the old terms can no longer be paid; `rejected` — the deal returns to `new` (a draft the client can't see) and must be resent with deal_send (read the client's reason in deal_get `rejectMessage` first). If the deal is `sent`, confirm with the user first, restating deal number, client and amount, because the client gets an email. The client and currency cannot be changed (create a new deal instead) and the promo code is fixed at creation. lineItems, when passed, replace ALL existing items. The backend re-validates the deadline on every edit, so a deal whose deadline is not after today needs a new serviceDeadline. Show the user the new possiblePayments figures afterwards.",
    {
      dealId: z.number().int().describe(FIELD_DOCS.dealId),
      lineItems: z.array(f2bLineItemSchema).min(1).max(10).optional().describe(`${FIELD_DOCS.lineItems}. Replaces the whole list.`),
      commissionPayer: f2bCommissionPayerEnum.optional().describe(FIELD_DOCS.commissionPayer),
      serviceId: z.number().int().optional().describe(`${FIELD_DOCS.serviceId}. Pass together with serviceName.`),
      serviceName: z.string().min(1).max(1024).optional().describe(FIELD_DOCS.serviceName),
      serviceDeadline: isoDateSchema.optional().describe(FIELD_DOCS.serviceDeadline),
      acquiringEnabled: z.boolean().optional().describe(FIELD_DOCS.acquiringEnabled),
    },
    { title: "Update Secure Deal" },
    async (params) => {
      const deal = await loadDeal(client, params.dealId);
      const previousStatus = assertDealStatus(deal, params.dealId, DEAL_EDITABLE_STATUSES, "edit");
      if (typeof deal.paymentStatus === "string" && CARD_HOLD_PAYMENT_STATUSES.includes(deal.paymentStatus)) {
        throw new Error(
          `Cannot edit ${dealLabel(deal, params.dealId)}: the client's card payment is already ${deal.paymentStatus}, so the terms are locked.`,
        );
      }
      const body = buildUpdateBody(deal, params);
      await client.put<unknown>(`${DEALS_PATH}/${params.dealId}`, body);
      const refreshed = await refreshDeal(client, params.dealId);
      return respond(mapCurrencyIdToCode({ deal: refreshed ?? { id: params.dealId }, notes: updateNotes(previousStatus) }));
    },
  );

  server.tool(
    "deal_duplicate",
    "Copy a Secure Deal into a NEW draft (status `new`, new deal number), like the cabinet's Duplicate; the original is untouched. Works from any status, including finished and cancelled. Copied from the original: client, service, currency, who pays the fee, line items. NOT copied (same as the cabinet): the deadline — always ask the user for a new serviceDeadline, never reuse the old one; the card-payment flag — ask whether card payment should be allowed (default: bank transfer only); also the promo code, delivered work and client messages. Before calling, offer to change any copied field (client, items, amounts, service, fee payer) and pass the changes; a different client must have the same currency or the copy takes that client's currency. Composite: GET original → GET client → POST /v2/freelancer/secure-deals → GET the new deal. Show the copy's possiblePayments (received / cost) and get an explicit 'yes' before deal_send.",
    {
      dealId: z.number().int().describe(`${FIELD_DOCS.dealId} of the deal to copy`),
      serviceDeadline: isoDateSchema.describe(`New ${FIELD_DOCS.serviceDeadline}. Required: the old deadline is never copied.`),
      clientId: z.number().int().optional().describe("Another F2B client id for the copy (from f2b_searchClients). Default: the original's client."),
      lineItems: z.array(f2bLineItemSchema).min(1).max(10).optional().describe(`${FIELD_DOCS.lineItems}. Replaces the copied items.`),
      commissionPayer: f2bCommissionPayerEnum.optional().describe(FIELD_DOCS.commissionPayer),
      serviceId: z.number().int().optional().describe(`${FIELD_DOCS.serviceId}. Pass together with serviceName.`),
      serviceName: z.string().min(1).max(1024).optional().describe(FIELD_DOCS.serviceName),
      acquiringEnabled: z.boolean().optional().describe(`${FIELD_DOCS.acquiringEnabled}. Not copied from the original; default false.`),
    },
    { title: "Duplicate Secure Deal" },
    async (params) => {
      assertDeadlineAfterToday(params.serviceDeadline);
      const source = await loadDeal(client, params.dealId);
      if (source.source === "offer") {
        throw new Error("Legacy offers cannot be duplicated here; send the user to https://my.mellow.io/.");
      }
      const targetClientId = params.clientId ?? Number(clientOf(source).id);
      if (!Number.isInteger(targetClientId)) {
        throw new Error(`Deal ${params.dealId} response lacks the client id; pass clientId explicitly.`);
      }
      const currencyId = await resolveInvoiceableClientCurrency(client, targetClientId);
      const body = buildDuplicateBody(source, { ...params, clientId: targetClientId }, currencyId);
      const created = await client.post<DealRecord>(DEALS_PATH, body);
      const newId = typeof created?.id === "number" ? created.id : undefined;
      const detail = newId !== undefined ? await refreshDeal(client, newId) : undefined;
      const sourceCurrencyId = readCurrencyId(source);
      const currencyChanged = sourceCurrencyId !== undefined && sourceCurrencyId !== currencyId;
      const notes = [
        `New draft copied from ${dealLabel(source, params.dealId)} with the new deadline ${params.serviceDeadline}; the original is unchanged and nothing was sent to the client.`,
        ...(currencyChanged
          ? [
              `The new client uses a different currency (${idToCurrency(currencyId) ?? currencyId} instead of ${idToCurrency(sourceCurrencyId) ?? sourceCurrencyId}): the item prices were kept as numbers. Confirm the amounts with the user before deal_send.`,
            ]
          : []),
        detail
          ? "Show the user possiblePayments[].received (freelancer gets) and .cost (client pays), then get an explicit 'yes' before deal_send."
          : "Could not load the breakdown; call deal_get({dealId}) and show possiblePayments before deal_send.",
      ];
      return respond(mapCurrencyIdToCode({ deal: detail ?? created, notes }));
    },
  );

  server.tool(
    "deal_get",
    "Get one Secure Deal with full details. Key fields: `status` (lifecycle below); `possiblePayments[]` — the backend's breakdown per payment method (`type`: bank or acquiring = card): `received` = what the freelancer gets, `cost` = what the client pays in total, plus commission, vat, salesTax, acquiringCommission, freelancerCommission — quote these and NEVER compute fees yourself; `rejectMessage` — the client's latest written reason: the rework request when status is `revision_requested`, the rejection reason when `rejected` (null if the client gave none); `resultSubmissions[]` — work delivered so far; `serviceDeadline`, `reviewDeadlineAt`; `availableActions` — what the freelancer can do now. Lifecycle: new → sent → (client prepays, Mellow holds the money) in_work → client_review → for_payment → finished. Side branches: rejected (deal_update returns it to new), revision_requested (client asked for changes), waiting_deadline_decision (deadline passed during in_work; the client extends or declines), declined_by_customer (money refunded to the client), cancelled. The payment invoice PDF: deal_downloadInvoicePdf. Finishing work and resubmitting are not available in this MCP — send the user to https://my.mellow.io/ for those.",
    {
      dealId: z.number().int().describe(FIELD_DOCS.dealId),
    },
    { title: "Get Secure Deal", readOnlyHint: true },
    async ({ dealId }) => respond(mapCurrencyIdToCode(await loadDeal(client, dealId))),
  );

  server.tool(
    "deal_list",
    "List the freelancer's Secure Deals with their statuses (newest first by default). Filters: `status` (one or several, OR), `search` (substring of deal number, client name or client email — NOT the service or line items). Paginated: page, size (default 20, max 500), sort, direction. Each row: id, number, clientName, clientEmail, serviceName, amount (the deal amount entered by the freelancer, before fees), currency, status, serviceDeadline, availableActions. To find a deal by its number, pass the number as `search`, then use the row's `id` with deal_get. Rows with `source: 'offer'` are legacy offers from the old flow: their `status` is null (see `offerStatus`) and their `id` is NOT a deal id — never pass it to deal_get or any other deal_* tool; send the user to https://my.mellow.io/ for them.",
    {
      status: z
        .union([dealStatusEnum, z.array(dealStatusEnum)])
        .optional()
        .describe("Filter by deal status. Single value or array (OR semantics)."),
      search: z.string().min(1).optional().describe("Substring of deal number, client name or client email"),
      page: z.number().int().positive().optional().describe("Page number (default 1)"),
      size: z.number().int().positive().max(500).optional().describe("Page size (default 20, max 500)"),
      sort: z.enum(DEAL_SORT_FIELDS).optional().describe("Sort field (default createdAt)"),
      direction: z.enum(["asc", "desc"]).optional().describe("Sort direction (default desc)"),
    },
    { title: "List Secure Deals", readOnlyHint: true },
    async (params) => {
      // Repeated filter[status][] keys can't go through MellowClient params
      // (URLSearchParams.set drops duplicates) — build the query manually.
      const search = new URLSearchParams();
      if (params.page !== undefined) search.set("page", params.page.toString());
      if (params.size !== undefined) search.set("size", params.size.toString());
      if (params.sort !== undefined) search.set("sort", params.sort);
      if (params.direction !== undefined) search.set("direction", params.direction);
      if (params.search !== undefined) search.set("filter[search]", params.search);
      const statuses = Array.isArray(params.status) ? params.status : params.status ? [params.status] : [];
      for (const s of statuses) {
        search.append("filter[status][]", s);
      }
      const query = search.toString();
      const result = await client.get<unknown>(`${DEALS_PATH}${query ? `?${query}` : ""}`);
      return respondList(mapCurrencyIdToCode(result));
    },
  );

  server.tool(
    "deal_remind",
    "Email the client Mellow's standard reminder (in English, Mellow's template — never write your own email) about a deal that is waiting for their review and prepayment. Allowed only in status `sent`. Two steps, always: (1) call WITHOUT `confirmed` — nothing is sent; the tool returns the recipient (client name and email), deal number and amount; ask the user to confirm, naming the client and the email address the reminder goes to; (2) only after an explicit 'yes', call again with confirmed: true and recipientEmail set to the email you showed (if the deal's recipient changed meanwhile, the tool refuses and you must ask again). There is no frequency limit by product decision — this confirmation is the guard, so never send reminders on your own initiative, on a schedule, or repeatedly. Composite: GET deal (status check) → POST /{dealId}/remind.",
    {
      dealId: z.number().int().describe(FIELD_DOCS.dealId),
      confirmed: z
        .boolean()
        .optional()
        .describe("Set true only after the user explicitly confirmed this recipient. Omit to get the preview without sending."),
      recipientEmail: z
        .string()
        .optional()
        .describe("Required with confirmed: true — the recipient email from the preview that the user confirmed."),
    },
    { title: "Remind client about Secure Deal" },
    async ({ dealId, confirmed, recipientEmail }) => {
      const deal = mapCurrencyIdToCode(await loadDeal(client, dealId));
      assertDealStatus(deal, dealId, ["sent"], "send a reminder for");
      const recipient = reminderRecipient(deal);
      if (confirmed !== true) {
        return respond({
          sent: false,
          preview: { dealId, number: deal.number ?? null, amount: deal.amount ?? null, currency: deal.currency ?? null, recipient },
          notes: [
            `Nothing was sent. Ask the user: send Mellow's reminder about deal ${deal.number ?? dealId} to ${recipient.name ?? "the client"} at ${recipient.email ?? "the client's email"}? After an explicit 'yes', call deal_remind again with confirmed: true and recipientEmail: "${recipient.email ?? ""}".`,
          ],
        });
      }
      if (!recipientEmail || !recipient.email || recipientEmail.trim().toLowerCase() !== recipient.email.toLowerCase()) {
        throw new Error(
          `Not sent: the confirmed recipient (${recipientEmail ?? "none"}) does not match the deal's current client email (${recipient.email ?? "unknown"}). Show the user the current recipient and ask again.`,
        );
      }
      await client.post<unknown>(`${DEALS_PATH}/${dealId}/remind`, {});
      return respond({ sent: true, dealId, number: deal.number ?? null, recipient });
    },
  );

  server.tool(
    "deal_cancel",
    "Cancel a Secure Deal. Allowed only in statuses `new` and `sent`, i.e. before the client has paid; later statuses cannot be cancelled. ALWAYS confirm with the user first, restating deal number, client and amount; call only after an explicit 'yes'. Irreversible. Mellow does NOT email the client about the cancellation (tell the user, so they can inform the client), the client's deal link stops working, and any card payment the client had started is voided. Never cancel as a side effect: to correct terms use deal_update, to make a similar deal use deal_duplicate. Composite: GET deal (status check) → POST /{dealId}/cancel.",
    {
      dealId: z.number().int().describe(FIELD_DOCS.dealId),
    },
    { title: "Cancel Secure Deal", destructiveHint: true },
    async ({ dealId }) => {
      const deal = await loadDeal(client, dealId);
      const previousStatus = assertDealStatus(deal, dealId, DEAL_CANCELLABLE_STATUSES, "cancel");
      await client.post<unknown>(`${DEALS_PATH}/${dealId}/cancel`, {});
      return respond({
        ok: true,
        dealId,
        number: deal.number ?? null,
        previousStatus,
        status: "cancelled",
        clientNotified: false,
      });
    },
  );

  server.tool(
    "deal_summary",
    "Summary of the freelancer's Secure Deals: count per status and total amount per currency. Composite: GET /freelancer/widgets/deals (backend counts by status; excludes legacy offers) + pages through the deal list (500 rows per page, up to 5 pages) to sum `amount` per currency, overall and per status. `amount` is the deal amount the freelancer entered (before fees), not what they receive. Currencies are never added together. Totals cover Secure Deals only; legacy offers are reported separately under `legacyOffers`. If `scanned.complete` is false, totals cover only the first 2,500 rows — say so. For an 'active' value, add up the statuses you need from `byStatus` (e.g. leave out cancelled, rejected, declined_by_customer).",
    {},
    { title: "Secure Deals summary", readOnlyHint: true },
    async () => {
      const countsByStatus = await client.get<unknown>(DEALS_WIDGET_PATH);
      const counts = Array.isArray(countsByStatus) ? (countsByStatus as Array<{ count?: unknown }>) : [];
      const { rows, pages, total, fetched } = await fetchAllDealRows(client);
      const summary = summarizeDealRows(rows);
      const result = {
        countsByStatus,
        totalDeals: counts.reduce((sum, row) => sum + (typeof row.count === "number" ? row.count : 0), 0),
        ...summary,
        scanned: { rows: rows.length, totalRows: total, pagesFetched: fetched, complete: fetched >= pages },
      };
      return respond(result);
    },
  );

  server.tool(
    "f2b_createIndividualClient",
    "Create an F2B client who is a private person (individual), not a company: fullName, email, country, currency (EUR or USD, fixed forever). For a company use f2b_createClient; ask the user which it is if unclear. Limits: an individual client can be billed at most €1,000 (EUR equivalent) per calendar month, summed over all its non-cancelled invoices and Secure Deals created that month. Caveat: the backend accepts individual clients for both invoices and Secure Deals, but Mellow's current web cabinet only creates company clients, and the client-side Secure Deal page currently tells an individual client that verification for individuals isn't available yet and to contact the freelancer — warn the user that such a client may be unable to complete payment. Status starts `not_verified`. Use the returned client's `id` as clientId.",
    {
      fullName: z.string().min(1).describe("The person's full name, no HTML"),
      email: z.string().email().describe("Email where the deal / invoice link is sent"),
      country: z.string().length(2).describe("ISO-3166 alpha-2 country code, e.g. DE, US"),
      currency: f2bCurrencyEnum.describe("EUR or USD. Fixed at creation — every deal / invoice to this client uses it."),
    },
    { title: "Create F2B individual client" },
    async (params) => {
      const body = {
        fullName: params.fullName,
        email: params.email,
        country: params.country,
        currencyId: currencyToId(params.currency),
      };
      const result = await client.post<unknown>("/freelancer/f2b/clients/individual", body);
      return respond(mapCurrencyIdToCode(result));
    },
  );

  server.tool(
    "f2b_searchClients",
    "Search the freelancer's clients for Secure Deals and invoices by name or email (`search` matches company name, person's full name, email, and company brand). The list also contains companies the freelancer already works with on Mellow that are not F2B clients yet. Each row: entryType ('client' | 'company'), id (F2B client id — use it as clientId; null on company rows), companyId, companyName, email, country, currency, status, clientType ('legal' | 'individual'), needsCreate. Rows with needsCreate=true are connected companies without an F2B client: call f2b_createClientFromCompany({companyId}) first and use the returned client's id. Archived and suspended clients are hidden unless you pass `status` explicitly; the status filter applies to client rows only (company rows always appear). Paginated: page, size.",
    {
      search: z.string().min(1).optional().describe("Name or email substring"),
      status: z
        .union([f2bClientStatusEnum, z.array(f2bClientStatusEnum)])
        .optional()
        .describe("Filter client rows by status (OR). Omit to hide archived/suspended clients."),
      page: z.number().int().positive().optional().describe("Page number (default 1)"),
      size: z.number().int().positive().max(500).optional().describe("Page size (default 20, max 500)"),
    },
    { title: "Search F2B clients", readOnlyHint: true },
    async (params) => {
      const search = new URLSearchParams();
      if (params.page !== undefined) search.set("page", params.page.toString());
      if (params.size !== undefined) search.set("size", params.size.toString());
      if (params.search !== undefined) search.set("filter[search]", params.search);
      const statuses = Array.isArray(params.status) ? params.status : params.status ? [params.status] : [];
      for (const s of statuses) {
        search.append("filter[status][]", s);
      }
      const query = search.toString();
      const result = await client.get<unknown>(`/freelancer/f2b/clients/unified${query ? `?${query}` : ""}`);
      return respondList(mapCurrencyIdToCode(result));
    },
  );

  server.tool(
    "f2b_createClientFromCompany",
    "Turn a connected company (an f2b_searchClients row with needsCreate=true) into an F2B client, or return the existing F2B client if one was already made for that company. A new client is `active` straight away (the company is already verified on Mellow) and takes the company's name, admin email, country and currency. Use the returned `id` as clientId for deal_create or f2b_createInvoiceDraft; if the returned client is archived it cannot be used. Errors: 403 if the company is not connected to the freelancer; 409 if the company's currency is not EUR/USD or it has no country — then create the client with f2b_createClient instead.",
    {
      companyId: z.number().int().positive().describe("`companyId` from an f2b_searchClients row with needsCreate=true"),
    },
    { title: "Create F2B client from connected company" },
    async ({ companyId }) => {
      const result = await client.post<unknown>("/freelancer/f2b/clients/from-company", { companyId });
      return respond(mapCurrencyIdToCode(result));
    },
  );
}
