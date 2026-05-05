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
 * Recursively replace `currencyId: number` with `currency: 'EUR' | 'USD'` in
 * any backend response shape. Returns a structural clone — does not mutate
 * the input. Unknown currency ids are passed through untouched.
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
