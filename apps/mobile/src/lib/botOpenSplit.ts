/**
 * lib/botOpenSplit.ts — how much of the open rate is machines, said in the
 * server's own numbers.
 *
 * `GET /api/v1/bot-opens/stats` (apps/api/internal/bot_open_filter/
 * bot_open_filter.go:222) returns four integers and a window:
 * `total_opens`, `bot_opens`, `human_opens`, `since`, plus a `by_signature`
 * breakdown carrying the LABEL of each detection signature that matched.
 *
 * IT RETURNS NO PERCENTAGE, AND NEITHER DOES THIS MODULE. A machine share is
 * a claim about how much of a number a reader is already looking at can be
 * trusted; rounding one client-side turns 4 machine opens in 5,000 into
 * "0% machines" and 4,996 in 5,000 into "100% human is 0%" — the two readings
 * a reader would act on most. The counts are the claim, and they are printed
 * as the server sent them.
 *
 * The classification vocabulary is the server's too: `by_signature` labels are
 * rendered verbatim (they name real detectors — "Apple MPP", "GoogleImageProxy"
 * — and a client-side rewording would describe a detector that does not exist).
 *
 * Import-free by construction apart from `format` — node-testable.
 */
import { dateTime, num } from "@/lib/format";

export interface BotOpenSplitStats {
  totalOpens: number;
  botOpens: number;
  humanOpens: number;
  /** RFC3339 window start, as the handler formatted it. */
  since: string;
  bySignature: readonly { label: string; opens: number }[];
}

/** No opens at all in the window: there is no split to report. */
export const BOT_OPEN_SPLIT_EMPTY =
  "No opens recorded in this window, so there is no machine/human split to report yet.";

/** Where the signature list is edited — this card is read-only by design. */
export const BOT_OPEN_SPLIT_SIGNATURE_NOTE =
  "Detection signatures are added and removed on the Deliverability screen.";

export const BOT_OPEN_SPLIT_SUBTITLE =
  "Opens matched against the detection signatures, counted by the server.";

export const BOT_OPEN_SPLIT_UNAVAILABLE =
  "The machine/human split couldn't be read. This is not a reading of zero machine opens.";

/**
 * The window sentence. `since` is echoed as a readable date; an unparseable
 * value is printed verbatim rather than silently dropped, because the window
 * is what makes the counts mean anything.
 */
export function botOpenSplitWindow(since: string): string {
  const raw = (since ?? "").trim();
  if (!raw) return "Window not reported by the server.";
  // Empty fallback, not the default em-dash: an unparseable `since` is echoed
  // verbatim so the reader sees what the server actually said.
  const readable = dateTime(raw, "");
  return `Opens recorded since ${readable || raw}.`;
}

/**
 * The headline: three server counts, no arithmetic of our own.
 *
 * The handler computes `human_opens = total - bots`, so the parts normally sum
 * to the total. When a payload says otherwise this does NOT silently correct
 * it — a corrected total would hide the very drift a reader needs to see.
 */
export function botOpenSplitHeadline(stats: BotOpenSplitStats): string {
  const total = Math.max(0, Math.trunc(stats.totalOpens));
  if (total === 0) return BOT_OPEN_SPLIT_EMPTY;
  const bots = Math.max(0, Math.trunc(stats.botOpens));
  const humans = Math.max(0, Math.trunc(stats.humanOpens));
  return `${num(total)} opens: ${num(bots)} matched a machine signature, ${num(humans)} did not.`;
}

/**
 * "" unless the server's own parts disagree with its total — then it says so
 * instead of presenting either number as settled.
 */
export function botOpenSplitDiscrepancy(stats: BotOpenSplitStats): string {
  const total = Math.max(0, Math.trunc(stats.totalOpens));
  const bots = Math.max(0, Math.trunc(stats.botOpens));
  const humans = Math.max(0, Math.trunc(stats.humanOpens));
  if (total === 0 || bots + humans === total) return "";
  return `The machine and human counts don't add up to the total the server reported (${num(bots)} + ${num(humans)} ≠ ${num(total)}); read them as reported, not as a split.`;
}

export interface BotOpenSignatureLine {
  key: string;
  /** The server's own label — never re-worded. */
  label: string;
  value: string;
  spoken: string;
}

/**
 * One line per matching signature, in the server's order, capped for the
 * phone. Rows with an empty label are dropped: an unnamed detector cannot be
 * acted on, and rendering it as "Unknown" would invent a classification.
 */
export function botOpenSignatureLines(
  stats: BotOpenSplitStats,
  limit = 5,
): BotOpenSignatureLine[] {
  const rows = Array.isArray(stats.bySignature) ? stats.bySignature : [];
  const out: BotOpenSignatureLine[] = [];
  for (const row of rows) {
    if (out.length >= Math.max(0, Math.trunc(limit))) break;
    const label = (row?.label ?? "").trim();
    if (!label) continue;
    const opens = Math.max(0, Math.trunc(row.opens));
    out.push({
      key: `${label}-${out.length}`,
      label,
      value: num(opens),
      spoken: `${label}, ${num(opens)} opens`,
    });
  }
  return out;
}

/** Says how many signatures were not shown, or "" when all of them were. */
export function botOpenSignatureOverflow(
  stats: BotOpenSplitStats,
  shown: number,
): string {
  const rows = Array.isArray(stats.bySignature) ? stats.bySignature : [];
  const named = rows.filter((row) => (row?.label ?? "").trim() !== "").length;
  const hidden = named - Math.max(0, Math.trunc(shown));
  if (hidden <= 0) return "";
  return `${num(hidden)} more signature${hidden === 1 ? "" : "s"} matched — the full list is on Deliverability.`;
}
