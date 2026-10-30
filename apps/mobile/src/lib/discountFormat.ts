/**
 * lib/discountFormat.ts — how a discount's value is written out.
 *
 * Pulled out of `app/(tabs)/discounts.tsx` because the original one-liner
 * (`${(cents / 100).toFixed(2)} ${currency.toUpperCase()} off`) had three
 * defects stacked in it, and only two of them are fixed by reaching for
 * `money()`:
 *
 *   1. NO CURRENCY SYMBOL. "5.00 USD off" reads like a spreadsheet dump.
 *      `Intl.NumberFormat` with style "currency" fixes it, and localises where
 *      the symbol goes.
 *   2. NO THOUSANDS SEPARATOR. "15000.00 USD off". Same fix.
 *   3. ZERO-DECIMAL CURRENCIES. This one survives the naive fix. JPY, KRW, VND
 *      and friends have no minor unit: Stripe — and therefore this API —
 *      carries their amounts in the MAJOR unit despite the field being named
 *      `amount_off_cents`. Dividing by 100 and then forcing two decimals turns
 *      a ¥500 discount into "¥5.00", which is wrong by two orders of magnitude
 *      AND wrongly punctuated.
 *
 * Pure, so the currency behaviour is unit-testable without React Native.
 */
import { EMDASH, money } from "./format";

/**
 * ISO-4217 currencies with no minor unit, matching Stripe's own zero-decimal
 * list. Amounts in these currencies are already whole units on the wire.
 */
export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

export interface DiscountAmount {
  percent_off?: number | null | undefined;
  amount_off_cents?: number | null | undefined;
  currency?: string | null | undefined;
}

/** "20% off" / "$5.00 off" / "¥500 off", or an em-dash when neither is set. */
export function formatDiscountOff(d: DiscountAmount): string {
  if (d.percent_off != null) return `${d.percent_off}% off`;
  if (d.amount_off_cents == null) return EMDASH;
  const currency = (d.currency ?? "USD").toUpperCase();
  const zeroDecimal = ZERO_DECIMAL_CURRENCIES.has(currency);
  const value = zeroDecimal ? d.amount_off_cents : d.amount_off_cents / 100;
  return `${money(value, currency, { cents: !zeroDecimal })} off`;
}
