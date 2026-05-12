import { describe, it, expect } from "vitest";
import { currencyToId, idToCurrency, mapCurrencyIdToCode } from "../../src/tools/f2b/shared";

// Proof-of-life tests for the F2B currency helpers. Two purposes:
//   1. Verify the vitest + Workers pool setup actually runs.
//   2. Lock in the current currencyToId / idToCurrency contract so any
//      future change (e.g., backend adds GBP) surfaces here, not in prod.
//
// The recursive mapCurrencyIdToCode helper has more edge cases (nested objects,
// the {currency, id} backend shape from Bug 1) — those tests land alongside
// each new F2B tool in slice 2, when MSW is also added.

describe("F2B currency helpers", () => {
  it("currencyToId maps EUR=3, USD=2", () => {
    expect(currencyToId("EUR")).toBe(3);
    expect(currencyToId("USD")).toBe(2);
  });

  it("idToCurrency reverses currencyToId, undefined on unknown id", () => {
    expect(idToCurrency(3)).toBe("EUR");
    expect(idToCurrency(2)).toBe("USD");
    expect(idToCurrency(999)).toBeUndefined();
  });

  it("mapCurrencyIdToCode replaces currencyId with currency in flat object", () => {
    const input = { clientId: 42, currencyId: 3, status: "active" };
    const output = mapCurrencyIdToCode(input);
    expect(output).toEqual({ clientId: 42, currency: "EUR", status: "active" });
    // Source untouched
    expect(input).toEqual({ clientId: 42, currencyId: 3, status: "active" });
  });
});
