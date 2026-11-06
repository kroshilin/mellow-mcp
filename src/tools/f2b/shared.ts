import { z } from "zod";

/**
 * F2B currency mapping. The backend speaks numeric `currencyId`, MCP exposes
 * ISO codes to the agent for clarity. Only EUR and USD are supported by F2B.
 */
export const F2B_CURRENCY_BY_ID: Record<number, "EUR" | "USD"> = {
  3: "EUR",
  2: "USD",
};

export const F2B_CURRENCY_TO_ID: Record<"EUR" | "USD", number> = {
  EUR: 3,
  USD: 2,
};

export function currencyToId(currency: "EUR" | "USD"): number {
  return F2B_CURRENCY_TO_ID[currency];
}

export function idToCurrency(currencyId: number): "EUR" | "USD" | undefined {
  return F2B_CURRENCY_BY_ID[currencyId];
}

/**
 * Recursively normalize backend's currency representation to a flat ISO code.
 *
 * Mellow returns currency in two shapes depending on the endpoint:
 *  - `currencyId: number` — old style (e.g. some legacy fields)
 *  - `currency: { currency: string, id: number }` — current style for F2B
 *    clients (`/api/freelancer/f2b/clients/legal` POST/GET responses)
 *
 * Both are flattened to `currency: 'EUR' | 'USD'` so the agent always sees a
 * single string field. Returns a structural clone — does not mutate the input.
 * Unknown currency ids / shapes are passed through untouched.
 *
 * Discovered during slice 1 post-release testing 2026-05-11
 * (docs/plans/2026-05-11-f2b-slice1-post-release-tests-report.md, Bug 1):
 * the `currency` object branch was missing, so the agent saw nested objects
 * even though every tool description promised a flat ISO code.
 */
export function mapCurrencyIdToCode<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => mapCurrencyIdToCode(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "currencyId" && typeof v === "number") {
        out.currency = idToCurrency(v) ?? v;
      } else if (
        k === "currency" &&
        v !== null &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        typeof (v as Record<string, unknown>).currency === "string"
      ) {
        // Backend shape: { currency: { currency: "EUR", id: 3 } }
        // Flatten to: { currency: "EUR" }
        out.currency = (v as Record<string, unknown>).currency;
      } else {
        out[k] = mapCurrencyIdToCode(v);
      }
    }
    return out as unknown as T;
  }
  return value;
}

// Backend client status (exact strings from Mellow F2B API)
export const F2B_CLIENT_STATUS = [
  "not_verified",
  "verification_in_progress",
  "verification_failed",
  "active",
  "archived",
  "suspended",
] as const;
export type F2bClientStatus = (typeof F2B_CLIENT_STATUS)[number];

// Backend invoice status
export const F2B_INVOICE_STATUS = ["new", "sent", "payment_queued", "paid", "cancelled"] as const;
export type F2bInvoiceStatus = (typeof F2B_INVOICE_STATUS)[number];

// Acquiring transaction status (only meaningful when acquiringEnabled = true)
export const F2B_ACQUIRING_STATUS = ["notInitiated", "initiated", "completed", "failed"] as const;

// Line item measure (10 fixed values)
export const F2B_MEASURE = ["item", "hour", "day", "week", "month", "kg", "ton", "liter", "cubic_meter", "km"] as const;

// Reusable Zod schemas
export const f2bCurrencyEnum = z.enum(["EUR", "USD"]);
export const f2bClientStatusEnum = z.enum(F2B_CLIENT_STATUS);
export const f2bInvoiceStatusEnum = z.enum(F2B_INVOICE_STATUS);
export const f2bMeasureEnum = z.enum(F2B_MEASURE);
export const f2bCommissionPayerEnum = z.enum(["freelancer", "customer"]);

export const f2bLineItemSchema = z.object({
  name: z.string().min(1).max(1024).describe("Line item label, no HTML, 1–1024 chars"),
  quantity: z.number().positive().describe("Must be > 0"),
  measure: f2bMeasureEnum.describe("One of: item, hour, day, week, month, kg, ton, liter, cubic_meter, km"),
  price: z.number().positive().describe("Unit price in client currency, must be > 0"),
});

export type F2bLineItem = z.infer<typeof f2bLineItemSchema>;

/**
 * Read the backend's currencyId from a client or invoice response, handling
 * both shapes the backend uses across endpoints:
 *   - flat: `{ currencyId: 3, ... }`
 *   - nested: `{ currency: { currency: "EUR", id: 3 }, ... }`
 */
export function readCurrencyId(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  if (typeof c.currencyId === "number") return c.currencyId;
  if (c.currency && typeof c.currency === "object") {
    const cur = c.currency as Record<string, unknown>;
    if (typeof cur.id === "number") return cur.id;
  }
  return undefined;
}

type ClientReader = { get: <T>(path: string) => Promise<T> };

/**
 * Load an F2B client and return the currencyId invoices to it must use.
 * Rejects clients that cannot be invoiced (archived / suspended) with an
 * agent-readable error instead of a raw backend 422.
 */
export async function resolveInvoiceableClientCurrency(client: ClientReader, clientId: number): Promise<number> {
  const raw = await client.get<unknown>(`/freelancer/f2b/clients/${clientId}`);
  const status = raw && typeof raw === "object" && "status" in raw ? (raw as { status?: string }).status : undefined;
  if (status === "archived" || status === "suspended") {
    throw new Error(
      `F2B client ${clientId} is in status '${status}'; cannot invoice it. Pick a different client or restore it in the Mellow UI.`,
    );
  }
  const currencyId = readCurrencyId(raw);
  if (currencyId === undefined) {
    throw new Error(`F2B client ${clientId} response does not contain a recognisable currency.`);
  }
  return currencyId;
}

/** Backend dates come back as full ISO timestamps; write endpoints want YYYY-MM-DD. */
export function toIsoDate(value: unknown): string | undefined {
  return typeof value === "string" && value.length >= 10 ? value.slice(0, 10) : undefined;
}

/** Keep only the fields the write endpoints accept (stored line items carry extras such as `total`). */
export function normalizeLineItems(raw: unknown): F2bLineItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const i = item as Record<string, unknown>;
    return {
      name: String(i.name),
      quantity: Number(i.quantity),
      measure: i.measure as F2bLineItem["measure"],
      price: Number(i.price),
    };
  });
}

/** Statuses in which the backend accepts PUT /freelancer/f2b/v2/invoices. */
export const F2B_EDITABLE_INVOICE_STATUSES = ["new", "sent"] as const;
