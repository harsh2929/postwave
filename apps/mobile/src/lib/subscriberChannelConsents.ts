/**
 * subscriberChannelConsents — per-CHANNEL consent state (SUB-042) on a phone.
 *
 * The profile's status pill answers "may we email this person AT ALL"; the
 * topics card answers "which subjects did they pick". Neither answers the
 * support-call question this module exists for: "which CHANNELS — email, SMS,
 * push, WhatsApp, RCS — has this person consented to, and on what evidence?"
 * Desktop renders that in ChannelConsentsPanel; mobile dropped the whole axis.
 *
 * The server stores one row per (profile, channel) that HAS a recorded state
 * (`GET /subscribers/{id}/channel-consents` → {items}). A channel with no row
 * is genuinely UNRECORDED — not opted out — and this module keeps that
 * distinction: `mergeChannelConsentRows` presents all five channels and labels
 * the missing ones "No consent recorded", because collapsing "we never asked"
 * into "they said no" is wrong in both compliance directions.
 *
 * Import-free so every rule runs in the node vitest suite.
 */

/** Mirrors the server's ChannelConsentChannels (channel_consents.go). */
export const CHANNEL_CONSENT_CHANNELS = [
  "email",
  "sms",
  "push",
  "whatsapp",
  "rcs",
] as const;

const CHANNEL_LABELS: Record<string, string> = {
  email: "Email",
  sms: "SMS",
  push: "Push",
  whatsapp: "WhatsApp",
  rcs: "RCS",
};

/** Mirrors the migration-0488 CHECK vocabulary. */
const STATUS_LABELS: Record<string, string> = {
  opted_in: "Opted in",
  opted_out: "Opted out",
  pending: "Pending",
  unknown: "Unknown",
};

export interface ChannelConsentRow {
  channel: string;
  /** opted_in | opted_out | pending | unknown — or "" for "no row exists". */
  status: string;
  consentTimestamp: string | null;
  consentSource: string;
  frequencyCapUntil: string | null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Rows from the GET response body ({items: [...]}). Unknown shapes → []. */
export function parseChannelConsents(payload: unknown): ChannelConsentRow[] {
  const items =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { items?: unknown }).items
      : payload;
  if (!Array.isArray(items)) return [];
  const rows: ChannelConsentRow[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const channel = str(rec.channel).toLowerCase();
    if (!channel) continue;
    rows.push({
      channel,
      status: str(rec.status),
      consentTimestamp: str(rec.consent_timestamp) || null,
      consentSource: str(rec.consent_source),
      frequencyCapUntil: str(rec.frequency_cap_until) || null,
    });
  }
  return rows;
}

/**
 * All five channels in canonical order, existing rows merged in, absent ones
 * carried as status "" so the card can say "No consent recorded" — which is a
 * different fact from opted_out. A server row for a channel this build does
 * not know is APPENDED rather than dropped: hiding a recorded consent state
 * because the phone is older than the vocabulary would misreport the ledger.
 */
export function mergeChannelConsentRows(
  rows: readonly ChannelConsentRow[],
): ChannelConsentRow[] {
  const byChannel = new Map(rows.map((row) => [row.channel, row]));
  const merged: ChannelConsentRow[] = CHANNEL_CONSENT_CHANNELS.map(
    (channel) =>
      byChannel.get(channel) ?? {
        channel,
        status: "",
        consentTimestamp: null,
        consentSource: "",
        frequencyCapUntil: null,
      },
  );
  for (const row of rows) {
    if (!CHANNEL_CONSENT_CHANNELS.includes(row.channel as never)) {
      merged.push(row);
    }
  }
  return merged;
}

export function channelConsentChannelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

/** "" (no row) reads as unrecorded, never as a refusal. */
export function channelConsentStatusLabel(status: string): string {
  if (!status) return "No consent recorded";
  return STATUS_LABELS[status] ?? status;
}

/**
 * The one state-changing verb each row offers, or null for a row that should
 * offer none. Only a recorded opt-in can be revoked; everything else (absent,
 * opted_out, pending, unknown) can be granted THROUGH an evidence review.
 * A grant demands a durable artifact; a revoke records the envelope but not
 * an opt-in artifact — mirroring buildChannelConsentBody.
 */
export function channelConsentAction(
  status: string,
): { nextStatus: "opted_in" | "opted_out"; label: string } | null {
  if (status === "opted_in") {
    return { nextStatus: "opted_out", label: "Opt out" };
  }
  return { nextStatus: "opted_in", label: "Opt in" };
}

/** The provenance fragment under a row: source, never invented. */
export function channelConsentProvenance(row: ChannelConsentRow): string {
  if (!row.status) {
    return "This channel has never had a consent decision recorded.";
  }
  const parts: string[] = [];
  if (row.consentSource) parts.push(`via ${row.consentSource}`);
  return parts.join(" · ");
}
