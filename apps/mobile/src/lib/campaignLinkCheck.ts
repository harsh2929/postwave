/**
 * lib/campaignLinkCheck.ts — the pure reading of
 * POST /api/v1/campaigns/{id}/check-links.
 *
 * A broken link in a campaign is unrecoverable: once the send starts, every
 * recipient gets the dead URL and there is no edit. The gateway has always
 * been able to answer "do all the links in this body resolve?"
 * (apps/api/internal/link_checker) and no client asked before sending from a
 * phone — the surface where a link is least likely to have been clicked
 * through by a human first.
 *
 * The wire is a bare ARRAY of `{url, status, ok, error?}`; a `status` of 0
 * with an `error` means the request never completed (DNS, TLS, timeout) which
 * is a different — and usually worse — fact than a 404.
 */
import { plural } from "@/lib/format";

export interface LinkCheckWireResult {
  url?: string;
  status?: number;
  ok?: boolean;
  error?: string;
}

export interface LinkCheckRow {
  key: string;
  url: string;
  ok: boolean;
  /** "200", "404", or "Unreachable" when the request never completed. */
  statusLabel: string;
  detail: string | null;
}

export interface LinkCheckReading {
  rows: LinkCheckRow[];
  total: number;
  brokenCount: number;
  /** True when the body contains no links at all. */
  noLinks: boolean;
  headline: string;
}

function statusLabel(result: LinkCheckWireResult): string {
  const status = Number(result.status);
  if (Number.isFinite(status) && status > 0) return String(status);
  return "Unreachable";
}

export function readLinkCheck(raw: unknown): LinkCheckReading {
  const list = Array.isArray(raw) ? (raw as LinkCheckWireResult[]) : [];
  const rows: LinkCheckRow[] = [];
  for (const [i, result] of list.entries()) {
    if (!result || typeof result !== "object") continue;
    const url = typeof result.url === "string" ? result.url : "";
    if (!url) continue;
    const ok = result.ok === true;
    rows.push({
      key: `${url}-${i}`,
      url,
      ok,
      statusLabel: statusLabel(result),
      detail:
        !ok && typeof result.error === "string" && result.error.trim()
          ? result.error.trim()
          : null,
    });
  }
  // Broken links first: the whole point is to see the problem, not to scroll
  // past twelve working links looking for it.
  rows.sort((a, b) => Number(a.ok) - Number(b.ok));
  const brokenCount = rows.filter((r) => !r.ok).length;
  const total = rows.length;
  return {
    rows,
    total,
    brokenCount,
    noLinks: total === 0,
    headline:
      total === 0
        ? "No links found in this campaign's body."
        : brokenCount === 0
          ? `All ${plural(total, "link")} resolved.`
          : `${plural(brokenCount, "link")} of ${total} didn't resolve.`,
  };
}

/** The consequence line for the send confirmation when links are broken. */
export function linkCheckConsequence(
  reading: LinkCheckReading | null | undefined,
): string | null {
  if (!reading || reading.brokenCount === 0) return null;
  const worst = reading.rows.filter((r) => !r.ok).slice(0, 3);
  return `${plural(reading.brokenCount, "link")} didn't resolve: ${worst
    .map((r) => r.url)
    .join(", ")}${reading.brokenCount > worst.length ? "…" : ""}`;
}
