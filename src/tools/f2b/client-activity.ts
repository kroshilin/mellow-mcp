import { MellowApiError, type MellowClient } from "../../mellow-client";
import { mapCurrencyIdToCode } from "./shared";

/**
 * "Does this F2B client still have active business?" — the MCP-side guard
 * before archiving ("deleting") a client.
 *
 * Product rule (backlog, 2026-11): a client must not be archived while it has
 * an active invoice or Secure Deal, where active = any status other than
 * Draft/New, Paid and Cancelled. `finished` is treated as the deal-side
 * equivalent of Paid (the deal is accepted and the freelancer paid out).
 * The backend currently blocks archiving only for `sent`; until it enforces
 * the full rule, MCP checks it here.
 *
 * Neither list endpoint filters by client: invoices are matched on the row's
 * clientId, deals (whose rows carry no client id) on the client's email.
 */

export const NON_BLOCKING_STATUSES = ["new", "paid", "finished", "cancelled"] as const;

const ACTIVE_INVOICE_STATUSES = ["sent", "payment_queued"];
const ACTIVE_DEAL_STATUSES = [
  "sent",
  "in_work",
  "client_review",
  "for_payment",
  "rejected",
  "revision_requested",
  "waiting_deadline_decision",
  "declined_by_customer",
  "dispute_in_progress",
];

const PAGE_SIZE = 500;
const MAX_PAGES = 10;

export type ActiveRecord = { kind: "invoice" | "deal"; id: unknown; number: unknown; status: unknown; amount: unknown; currency: unknown };

type Row = Record<string, unknown>;
type ListPage = { items?: unknown; pagination?: { pages?: number } };

function statusQuery(statuses: readonly string[]): URLSearchParams {
  const search = new URLSearchParams();
  for (const status of statuses) search.append("filter[status][]", status);
  return search;
}

async function collectRows(client: MellowClient, basePath: string, query: URLSearchParams): Promise<Row[]> {
  const fetchPage = async (page: number, collected: Row[]): Promise<Row[]> => {
    const search = new URLSearchParams(query);
    search.set("page", String(page));
    search.set("size", String(PAGE_SIZE));
    const result = await client.get<ListPage>(`${basePath}?${search.toString()}`);
    const items = Array.isArray(result?.items) ? (result.items as Row[]) : [];
    const rows = [...collected, ...items];
    const pages = result?.pagination?.pages;
    // Without pagination metadata a full page means "maybe more".
    const hasMore = items.length > 0 && (typeof pages === "number" ? page < pages : items.length >= PAGE_SIZE);
    if (!hasMore) return rows;
    // Fail closed: a truncated scan must never let an archive through.
    if (page >= MAX_PAGES) {
      throw new Error(
        `Too many records to check safely (${basePath}, over ${MAX_PAGES * PAGE_SIZE}); delete this client in the Mellow cabinet instead.`,
      );
    }
    return fetchPage(page + 1, rows);
  };
  return fetchPage(1, []);
}

function toActiveRecord(kind: ActiveRecord["kind"], row: Row): ActiveRecord {
  const mapped = mapCurrencyIdToCode(row);
  return { kind, id: mapped.id, number: mapped.number, status: mapped.status, amount: mapped.amount, currency: mapped.currency };
}

async function activeInvoices(client: MellowClient, clientId: number): Promise<ActiveRecord[]> {
  const rows = await collectRows(client, "/freelancer/f2b/invoices", statusQuery(ACTIVE_INVOICE_STATUSES));
  return rows.filter((row) => Number(row.clientId) === clientId).map((row) => toActiveRecord("invoice", row));
}

async function activeDeals(client: MellowClient, email: string | undefined): Promise<ActiveRecord[]> {
  if (!email) {
    // Deal rows can only be matched by email; without it the check would be blind.
    throw new Error("The client record has no email, so its Secure Deals cannot be checked; delete this client in the Mellow cabinet instead.");
  }
  const query = statusQuery(ACTIVE_DEAL_STATUSES);
  query.set("filter[search]", email);
  let rows: Row[];
  try {
    rows = await collectRows(client, "/v2/freelancer/secure-deals", query);
  } catch (err) {
    // The `secureDeals` flag answers 404 when off (Unleash IsEnabled default):
    // no deals section, nothing can block. Anything else fails closed.
    if (err instanceof MellowApiError && err.status === 404) return [];
    throw err;
  }
  const target = email.toLowerCase();
  // Legacy offers (source 'offer') belong to the old flow and are not linked
  // to F2B clients, so they cannot block archiving one.
  return rows
    .filter((row) => row.source !== "offer" && typeof row.clientEmail === "string" && row.clientEmail.toLowerCase() === target)
    .map((row) => toActiveRecord("deal", row));
}

export async function findActiveRecordsForClient(
  client: MellowClient,
  clientId: number,
  clientEmail: string | undefined,
): Promise<ActiveRecord[]> {
  const [invoices, deals] = await Promise.all([activeInvoices(client, clientId), activeDeals(client, clientEmail)]);
  return [...invoices, ...deals];
}

export function describeActiveRecords(records: ActiveRecord[], limit = 10): string {
  const shown = records
    .slice(0, limit)
    .map((r) => `${r.kind} ${r.number ?? `id ${r.id}`} — ${r.status}, ${r.amount ?? "?"} ${r.currency ?? ""}`.trim());
  const more = records.length > limit ? `; and ${records.length - limit} more` : "";
  return `${shown.join("; ")}${more}`;
}
