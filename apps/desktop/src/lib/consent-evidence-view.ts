import type { ConsentReceipt } from "./api-client";

export type ConsentOutcomeGroup = "opt-in" | "opt-out" | "pending" | "other";

const POSITIVE_STATES = new Set(["granted", "subscribed"]);
const NEGATIVE_STATES = new Set(["unsubscribed", "withdrawn"]);
const PENDING_STATES = new Set(["pending"]);

export function consentOutcomeGroup(
  state: string | undefined,
): ConsentOutcomeGroup {
  const normalized = (state ?? "").trim().toLowerCase();
  if (POSITIVE_STATES.has(normalized)) return "opt-in";
  if (NEGATIVE_STATES.has(normalized)) return "opt-out";
  if (PENDING_STATES.has(normalized)) return "pending";
  return "other";
}

export function evidenceKindLabel(kind: ConsentReceipt["kind"]): string {
  return kind === "proof" ? "Structured proof" : "State-change receipt";
}

export function consentOutcomeLabel(receipt: ConsentReceipt): string {
  switch (consentOutcomeGroup(receipt.new_state)) {
    case "opt-in":
      return "Opt-in";
    case "opt-out":
      return "Opt-out";
    case "pending":
      return "Pending";
    case "other":
      return receipt.new_state || "Unknown recorded state";
  }
}

export function consentOutcomeTone(receipt: ConsentReceipt): string {
  return "is-" + consentOutcomeGroup(receipt.new_state);
}

export function consentReceiptIdentity(receipt: ConsentReceipt): string {
  return receipt.kind + ":" + receipt.id;
}

export function validConsentTimestamp(
  value: string | undefined,
): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatConsentTimestamp(value: string | undefined): string {
  const parsed = validConsentTimestamp(value);
  if (parsed === null) return "Timestamp not verified";
  return new Date(parsed).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function exactConsentTimestamp(
  value: string | undefined,
): string | null {
  const parsed = validConsentTimestamp(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

export function relativeConsentTimestamp(
  value: string | undefined,
): string | null {
  const parsed = validConsentTimestamp(value);
  if (parsed === null) return null;
  const elapsed = Date.now() - parsed;
  const future = elapsed < 0;
  const absolute = Math.abs(elapsed);
  const suffix = future ? "from now" : "ago";
  if (absolute < 60_000) return future ? "within a minute" : "just now";
  if (absolute < 3_600_000) {
    return String(Math.floor(absolute / 60_000)) + "m " + suffix;
  }
  if (absolute < 86_400_000) {
    return String(Math.floor(absolute / 3_600_000)) + "h " + suffix;
  }
  return String(Math.floor(absolute / 86_400_000)) + "d " + suffix;
}

export function truncateConsentValue(
  value: string | undefined,
  max: number,
): string {
  const normalized = value?.trim();
  if (!normalized) return "Not recorded";
  return normalized.length <= max
    ? normalized
    : normalized.slice(0, Math.max(1, max - 1)) + "…";
}
