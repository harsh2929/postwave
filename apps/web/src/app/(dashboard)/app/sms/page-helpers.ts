import type { BadgeProps } from "@/components/ui/badge";
import type {
  SmsCampaign,
  SmsComplianceStatus,
  SmsList,
  SmsPilotReadiness,
  SmsPilotReadinessItem,
  SmsSenderProfile,
} from "@/lib/sms-api";

// Option label for a list <select>: name plus opted-in recipient count so you
// never pick a target list blind (audit SMS-025).
export function listOptionLabel(list: SmsList): string {
  if (typeof list.recipient_count === "number") {
    return `${list.name} (${list.recipient_count.toLocaleString()})`;
  }
  return list.name;
}

// SMS dispatch currently supports canonical US/Canada +1 numbers only. The
// area-code and exchange leading digits cannot be 0 or 1, matching the
// backend/DB contract.
export const E164_PATTERN = "^\\+1[2-9][0-9]{2}[2-9][0-9]{6}$";

export function isE164(value: string): boolean {
  return new RegExp(E164_PATTERN).test(value.trim());
}

// Hard cap on a single SMS/MMS body the composer enforces via maxLength.
export const SMS_BODY_MAX = 1400;

export function smsSegments(body: string): number {
  const text = body.trim();
  if (!text) return 0;
  // Code points decide the encoding: an astral character reads as a surrogate
  // here (> 127), which correctly forces UCS-2.
  const gsmLike = [...text].every((char) => char.charCodeAt(0) <= 127);
  const single = gsmLike ? 160 : 70;
  const concat = gsmLike ? 153 : 67;
  // …but the LENGTH is billed in UTF-16 code units, not code points. Counting
  // [...text] here made an emoji (a surrogate pair) score 1 instead of 2, so a
  // message of 70 emoji was previewed as one segment when it sends as two.
  const units = text.length;
  if (units <= single) return 1;
  return Math.ceil(units / concat);
}

export function smsCredits(body: string, mediaUrl?: string): number {
  const textCredits = Math.max(1, smsSegments(body));
  return textCredits + (mediaUrl?.trim() ? 2 : 0);
}

export function appendSentence(body: string, sentence: string): string {
  const trimmedBody = body.trim();
  if (!trimmedBody) return sentence;
  const separator = /[.!?]$/.test(trimmedBody) ? " " : ". ";
  return `${trimmedBody}${separator}${sentence}`;
}

export function campaignActionLabel(
  action: "pause" | "resume" | "cancel" | "schedule",
): string {
  return {
    pause: "paused",
    resume: "resumed",
    cancel: "cancelled",
    schedule: "scheduled",
  }[action];
}

export function senderServicePlaceholder(
  provider: SmsSenderProfile["provider"],
): string {
  if (provider === "telnyx") return "Messaging Profile ID";
  if (provider === "bandwidth") return "Application ID";
  return "MG...";
}

export function providerBrandPlaceholder(
  provider: SmsSenderProfile["provider"],
): string {
  if (provider === "telnyx") return "Telnyx Brand ID";
  if (provider === "bandwidth") return "Bandwidth Brand ID";
  return "BN...";
}

export function providerCampaignPlaceholder(
  provider: SmsSenderProfile["provider"],
): string {
  if (provider === "telnyx") return "Telnyx Campaign ID";
  if (provider === "bandwidth") return "Bandwidth Campaign ID";
  return "QE...";
}

export function senderQuietHours(metadata: SmsSenderProfile["metadata"]): {
  enabled: boolean;
  timezone: string;
  start: string;
  end: string;
} {
  const quietHours = objectValue(metadata?.quiet_hours);
  return {
    enabled:
      typeof metadata?.quiet_hours === "object" &&
      metadata.quiet_hours !== null,
    timezone: stringValue(quietHours.timezone) || "America/New_York",
    start: stringValue(quietHours.start) || "20:00",
    end: stringValue(quietHours.end) || "08:00",
  };
}

export function senderMetadata(
  base: SmsSenderProfile["metadata"],
  sender: {
    quiet_hours_enabled: boolean;
    quiet_hours_timezone: string;
    quiet_hours_start: string;
    quiet_hours_end: string;
  },
): Record<string, unknown> {
  const metadata = { ...objectValue(base) };
  delete metadata.quiet_hours;
  if (sender.quiet_hours_enabled) {
    metadata.quiet_hours = {
      timezone: sender.quiet_hours_timezone.trim(),
      start: sender.quiet_hours_start.trim(),
      end: sender.quiet_hours_end.trim(),
    };
  }
  return metadata;
}

export function senderPaused(sender: SmsSenderProfile): boolean {
  const metadata = sender.metadata ?? {};
  const sending = objectValue(metadata.sending);
  return (
    truthy(metadata.paused) ||
    truthy(metadata.sender_paused) ||
    truthy(sending.paused) ||
    truthy(sending.kill_switch)
  );
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function truthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
  }
  return false;
}

export function statNumber(
  stats: Record<string, unknown>,
  key: string,
): number {
  const value = stats[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0%";
  return `${Math.round(value * 1000) / 10}%`;
}

export function formatMicros(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  return `$${(value / 1_000_000).toFixed(4)}`;
}

// Aggregate/report totals read as ordinary currency (2 dp) rather than the
// 4-dp per-message precision `formatMicros` keeps for tiny estimates. Avoids
// trailing-zero currency like "$12.3400" on billing-adjacent report totals.
export function formatMicrosAggregate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  return `$${(value / 1_000_000).toFixed(2)}`;
}

// Map the internal credit ledger_mode enum to customer-facing copy so the
// credit line never leaks a raw system identifier like "message_cost_ledger".
export function ledgerModeLabel(mode: string): string {
  const key = mode.trim().toLowerCase();
  const labels: Record<string, string> = {
    message_cost_ledger: "Metered credits",
    included_only: "Included credits",
    prepaid: "Prepaid credits",
    postpaid: "Billed monthly",
    unlimited: "Unlimited",
  };
  if (labels[key]) return labels[key];
  if (!key) return "";
  // Humanize any unmapped enum ("some_new_mode" -> "Some new mode").
  const spaced = key.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// Pilot-readiness status -> badge variant + humanized label so hard blockers
// read as urgent (destructive) and warnings distinct from neutral state.
export function pilotBadge(status: SmsPilotReadinessItem["status"]): {
  variant: BadgeProps["variant"];
  label: string;
} {
  switch (status) {
    case "pass":
      return { variant: "success", label: "Pass" };
    case "warning":
      return { variant: "warning", label: "Warning" };
    case "blocker":
      return { variant: "destructive", label: "Blocker" };
    default:
      return { variant: "secondary", label: String(status) };
  }
}

// Curated IANA zones covering US/CA sending plus common merchant HQs. The
// quiet-hours picker offers these; `isValidIanaTimeZone` still accepts any
// zone the runtime recognizes so an approved value is never rejected.
export const SMS_TIMEZONES: readonly string[] = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Toronto",
  "America/Vancouver",
  "America/Halifax",
  "America/St_Johns",
  "America/Mexico_City",
  "Europe/London",
  "Europe/Paris",
  "UTC",
];

export function isValidIanaTimeZone(value: string): boolean {
  const zone = value.trim();
  if (!zone) return false;
  // UTC is valid in both the Go send gate and Intl.DateTimeFormat, but some
  // runtimes omit this canonical fixed zone from supportedValuesOf().
  if (zone === "UTC") return true;
  // Prefer the canonical zone registry — it excludes legacy abbreviation
  // aliases (EST, GMT, PST) that Intl.DateTimeFormat otherwise accepts but
  // the send gate's IANA lookup cannot honor.
  const supported = (
    Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  ).supportedValuesOf;
  if (typeof supported === "function") {
    try {
      return supported("timeZone").includes(zone);
    } catch {
      // fall through to the structural check
    }
  }
  // Fallback (older runtimes): require the Area/Location form (or UTC) AND
  // that the runtime can actually construct a formatter for it.
  if (zone !== "UTC" && !/^[A-Za-z]+\/[A-Za-z0-9._+-]+$/.test(zone)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// Client-side filter/search over the full campaign list (the API returns all
// campaigns; the card only rendered the first 8). Case-insensitive match over
// name + body; status "all" disables the status gate.
export function filterCampaigns(
  campaigns: SmsCampaign[],
  opts: { query?: string; status?: string },
): SmsCampaign[] {
  const q = (opts.query ?? "").trim().toLowerCase();
  const status = (opts.status ?? "all").trim();
  return campaigns.filter((campaign) => {
    if (status && status !== "all" && campaign.status !== status) return false;
    if (!q) return true;
    return (
      campaign.name.toLowerCase().includes(q) ||
      campaign.body.toLowerCase().includes(q)
    );
  });
}

// Sample merge values for the phone preview so operators see how a message
// renders instead of literal {{tags}}. Mirrors applySmsTemplate's fallbacks.
export const SMS_PREVIEW_SAMPLE: Record<string, string> = {
  discount_code: "SAVE20",
  product_name: "your favorite item",
  event_name: "your event",
  time: "tomorrow",
  date: "Friday",
  link: "https://example.com/x",
  first_name: "Alex",
  name: "Alex",
};

// Substitute {{merge}} tags with sample values for the composer preview.
// Unknown tags collapse to a readable placeholder rather than leaking braces.
export function renderSmsPreview(
  body: string,
  sample: Record<string, string> = SMS_PREVIEW_SAMPLE,
): string {
  return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, rawKey: string) => {
    const key = rawKey.trim().toLowerCase();
    if (sample[key]) return sample[key];
    return rawKey.replace(/[._]/g, " ");
  });
}

export interface ParsedConsentRow {
  phone_e164: string;
  subscriber_email?: string;
  proof_text?: string;
}

export interface ParsedConsentImport {
  rows: ParsedConsentRow[];
  errors: string[];
}

// Parse pasted / uploaded consent rows: one recipient per line, comma or tab
// separated as `phone[, email[, proof]]`. A leading header row (phone/email)
// is skipped. Invalid phones are reported, not silently dropped, so the
// operator can correct them before recording legally-sensitive consent.
export function parseConsentImport(text: string): ParsedConsentImport {
  const rows: ParsedConsentRow[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    const cells = line.split(/[,\t]/).map((cell) => cell.trim());
    const phone = cells[0] ?? "";
    // Skip an obvious header row.
    if (index === 0 && /^phone/i.test(phone)) return;
    if (!isE164(phone)) {
      errors.push(`Line ${index + 1}: "${phone}" is not a valid E.164 number`);
      return;
    }
    if (seen.has(phone)) return;
    seen.add(phone);
    const email = cells[1] ?? "";
    const proof = cells.slice(2).join(", ");
    rows.push({
      phone_e164: phone,
      subscriber_email: email || undefined,
      proof_text: proof || undefined,
    });
  });
  return { rows, errors };
}

// Where a blocked setup item is remediated. On-page items switch tabs;
// Settings-bound items (callback URL, webhook verification) link out.
export type SmsRemediation =
  | "registration"
  | "audience"
  | "overview"
  | "settings"
  | null;

export function remediationFor(key: string, label: string): SmsRemediation {
  const text = `${key} ${label}`.toLowerCase();
  if (text.includes("callback") || text.includes("webhook")) return "settings";
  if (text.includes("kill switch") || text.includes("paused"))
    return "overview";
  if (
    text.includes("consent") ||
    text.includes("opt-in") ||
    text.includes("opted") ||
    text.includes("subscription")
  ) {
    return "audience";
  }
  if (
    text.includes("sender") ||
    text.includes("brand") ||
    text.includes("campaign registration") ||
    text.includes("a2p") ||
    text.includes("messaging service") ||
    text.includes("number") ||
    text.includes("registration")
  ) {
    return "registration";
  }
  return null;
}

export type SmsChecklistState = "done" | "blocker" | "warning" | "todo";

export interface SmsChecklistItem {
  key: string;
  label: string;
  state: SmsChecklistState;
  detail?: string;
  remediation: SmsRemediation;
}

/**
 * The compliance and pilot APIs intentionally describe different checks with
 * a few shared machine keys (for example, registration approved versus an
 * approved *active* sender). The label is therefore part of the UI identity;
 * using the machine key alone makes React reuse or omit legitimate rows.
 */
export function smsChecklistIdentity(
  item: Pick<SmsChecklistItem, "key" | "label">,
): string {
  return JSON.stringify([
    item.key.trim(),
    item.label.trim().replace(/\s+/g, " ").toLowerCase(),
  ]);
}

const CHECKLIST_ORDER: Record<SmsChecklistState, number> = {
  blocker: 0,
  todo: 1,
  warning: 2,
  done: 3,
};

// Merge the compliance checklist and pilot-readiness items into ONE ordered,
// deduplicated setup checklist (kills the two near-identical grids — SMS-021)
// with a "start here" order (blockers first, done last — SMS-044) and a
// remediation target per row (SMS-024).
export function buildSetupChecklist(
  compliance: SmsComplianceStatus | null,
  pilot: SmsPilotReadiness | null,
): SmsChecklistItem[] {
  const byLabel = new Map<string, SmsChecklistItem>();
  const normalize = (label: string) => label.trim().toLowerCase();

  for (const item of Array.isArray(compliance?.items)
    ? compliance?.items
    : []) {
    byLabel.set(normalize(item.label), {
      key: item.key,
      label: item.label,
      state: item.complete ? "done" : "todo",
      detail: item.detail,
      remediation: remediationFor(item.key, item.label),
    });
  }
  for (const item of Array.isArray(pilot?.items) ? pilot?.items : []) {
    const norm = normalize(item.label);
    const existing = byLabel.get(norm);
    const pilotState: SmsChecklistState =
      item.status === "pass"
        ? "done"
        : item.status === "blocker"
          ? "blocker"
          : "warning";
    if (existing) {
      // Pilot's pass/warning/blocker is more specific than compliance's
      // done/todo; upgrade unless compliance already proved it done.
      const state: SmsChecklistState =
        existing.state === "done" || pilotState === "done"
          ? "done"
          : pilotState;
      existing.state = state;
      existing.detail = existing.detail ?? item.detail;
    } else {
      byLabel.set(norm, {
        key: item.key,
        label: item.label,
        state: pilotState,
        detail: item.detail,
        remediation: remediationFor(item.key, item.label),
      });
    }
  }

  return [...byLabel.values()].sort(
    (a, b) => CHECKLIST_ORDER[a.state] - CHECKLIST_ORDER[b.state],
  );
}

export function checklistBadge(state: SmsChecklistState): {
  variant: BadgeProps["variant"];
  label: string;
} {
  switch (state) {
    case "done":
      return { variant: "success", label: "Done" };
    case "blocker":
      return { variant: "destructive", label: "Blocker" };
    case "warning":
      return { variant: "warning", label: "Warning" };
    default:
      return { variant: "secondary", label: "Needed" };
  }
}

// The most relevant timestamp for a campaign row: when a scheduled send fires,
// otherwise when a sent one went out, otherwise when it was created.
export function campaignTimestamp(
  campaign: SmsCampaign,
): { label: string; iso: string } | null {
  if (campaign.status === "scheduled" && campaign.scheduled_at) {
    return { label: "Sends", iso: campaign.scheduled_at };
  }
  if (campaign.sent_at) return { label: "Sent", iso: campaign.sent_at };
  if (campaign.created_at)
    return { label: "Created", iso: campaign.created_at };
  return null;
}

// A datetime-local `min` value (local now, seconds trimmed) so the schedule
// picker cannot select a past instant. Returns "" server-side.
export function datetimeLocalNow(now: Date = new Date()): string {
  if (Number.isNaN(now.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}`
  );
}

export function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Seed variants for an A/B SMS draft. This lives here, not in
// sms-campaign-drafts-card, so the page can build a blank draft without a
// static import of the (largest on the route) drafts-card module — that import
// would pull the whole Campaigns tab into the page chunk and defeat its lazy
// load.
export interface SmsAbVariantSeed {
  label: string;
  body: string;
  weight: string;
}

export const DEFAULT_AB_VARIANTS: SmsAbVariantSeed[] = [
  { label: "A", body: "", weight: "50" },
  { label: "B", body: "", weight: "50" },
];
