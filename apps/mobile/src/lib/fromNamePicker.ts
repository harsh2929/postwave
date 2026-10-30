/**
 * lib/fromNamePicker.ts — parse GET /api/v1/from-name-picker.
 *
 * The server (apps/api/internal/from_name_picker) ranks the tenant's
 * historically best-performing sender names and already enforces its own
 * min-campaigns floor, so an empty list means "nothing has enough history",
 * never "render placeholders". Desktop shows the same rows as apply chips
 * (FromNameSuggestions.tsx); mobile mirrors that, capped at the same 5.
 *
 * Envelope: `{from_names: Row[]}` — desktop reads `res.data.from_names ?? []`.
 * A bare array is tolerated for the usual drift reason.
 */

export interface FromNameSuggestion {
  fromName: string;
  campaignsUsing: number;
  /** 0..1 — the server's open_rate fraction. */
  openRate: number | null;
  rank: number;
}

/** Desktop's MAX_CHIPS. */
export const FROM_NAME_SUGGESTION_LIMIT = 5;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseFromNameSuggestions(payload: unknown): FromNameSuggestion[] {
  const body = record(payload);
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(body["from_names"])
      ? (body["from_names"] as unknown[])
      : [];
  const out: FromNameSuggestion[] = [];
  for (const entry of rows) {
    const row = record(entry);
    const fromName =
      typeof row["from_name"] === "string" ? row["from_name"].trim() : "";
    if (!fromName) continue;
    const rawRate = row["open_rate"];
    const openRate =
      typeof rawRate === "number" && Number.isFinite(rawRate) && rawRate >= 0
        ? rawRate
        : null;
    out.push({
      fromName,
      campaignsUsing:
        typeof row["campaigns_using"] === "number" &&
        Number.isFinite(row["campaigns_using"])
          ? Math.max(0, Math.round(row["campaigns_using"]))
          : 0,
      openRate,
      rank:
        typeof row["rank"] === "number" && Number.isFinite(row["rank"])
          ? row["rank"]
          : out.length + 1,
    });
    if (out.length >= FROM_NAME_SUGGESTION_LIMIT) break;
  }
  return out;
}

/** What a screen reader hears for one chip. */
export function fromNameSuggestionLabel(row: FromNameSuggestion): string {
  const rate =
    row.openRate === null
      ? "open rate unmeasured"
      : `${Math.round(row.openRate * 1000) / 10}% open rate`;
  return `${row.fromName}, ${rate} across ${row.campaignsUsing} campaign${
    row.campaignsUsing === 1 ? "" : "s"
  }`;
}
