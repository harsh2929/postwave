/**
 * components/agency/agencyCardStyle.ts — the card surface the Agency cards
 * share, and the locale-aware formatters that go with them.
 *
 * `card()` was duplicated inline in `app/(tabs)/agency.tsx`. Lifting it here
 * is what let the screen's cards move into their own files without each one
 * re-declaring the surface it sits on.
 *
 * There is deliberately no section-heading factory here. Agency's headings
 * are the shared <SectionLabel> (GOVERNANCE#55, CQ-8): the private
 * `sectionLabel(t)` that used to live here had drifted from it (fgSubtle
 * instead of fgMuted, letterSpacing 0.5 instead of 0.6), so a change to the
 * shell heading never reached this screen.
 */
import { compactNum, date, money, num, percent } from "@/lib/format";
import type { useTheme } from "@/lib/theme";

type Theme = ReturnType<typeof useTheme>["t"];

function safeNum(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** The surface every agency row sits on. */
export const card = (t: Theme) =>
  ({
    backgroundColor: t.surface,
    borderColor: t.borderSubtle,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginBottom: 8,
  }) as const;

/**
 * Counts, compact send volumes, dates, currency and markups all route through
 * `src/lib/format.ts` so this screen agrees with the rest of the app on
 * grouping separators, compact suffixes, month names and the reader's locale.
 * The reimplementations these replaced used a bare `Intl.NumberFormat()` with
 * no shared locale override, a hand-rolled `k`/`M` ladder that disagreed with
 * `compactNum`'s `K`/`M`, a `toLocaleDateString` that ignored
 * `setFormatLocale`, and a hard-coded `"$" + toFixed(2)` — the only place in
 * the product that ignored the reader's currency.
 */
export function formatUsd(value: number, currency = "USD"): string {
  return money(safeNum(value), currency);
}

export function formatCount(value: number): string {
  return num(safeNum(value));
}

export function formatSends(value: number): string {
  return compactNum(safeNum(value));
}

/** Empty (not an em-dash) when absent — call sites hide the whole line. */
export function formatDate(value: string | undefined): string {
  return date(value, "");
}

/** Basis points → a locale-formatted percentage. 250 bps → `2.5%`. */
export function formatMarkup(bps: number): string {
  return percent(safeNum(bps) / 10_000);
}

/**
 * Only a 6-digit hex colour reaches a `backgroundColor`. A server-sent
 * brand colour is content, and RN will throw on a malformed colour string
 * rather than ignore it.
 */
export function normalizeHexColor(value: string | undefined): string | null {
  if (!value) return null;
  const hex = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : null;
}
