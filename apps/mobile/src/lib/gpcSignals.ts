/**
 * gpcSignals — are Global Privacy Control opt-outs arriving, and can they
 * be correlated to anyone?
 *
 * The pure half of the compliance screen's GPC card. Desktop derives the
 * same two facts on its Consent page (`gpcSubjectSummary`, Consent.tsx:233,
 * and the uncorrelated-rows notice at :1224) from the admin event feed
 * `GET /api/v1/consent/events`; mobile reuses the derivation over the most
 * recent page of events, and SAYS it is derived from loaded rows — a page
 * is a floor, not the ledger.
 *
 * A GPC event is one whose `preferences.gpc === true` or whose source is
 * "gpc" — the two shapes the server's honour path writes. A signal with
 * neither a stable subject id nor an email is UNCORRELATED: it proves the
 * browser sent the header, but it cannot be attached to a person, which is
 * exactly the failure an admin needs to see.
 *
 * Free of react-native imports so node-run vitest covers the derivation.
 */
import { num } from "./format";


/** The fields of consent.Event (Go) this derivation reads. */
export interface ConsentEventLike {
  subject_type: string;
  subject_id?: string | undefined;
  subject_email?: string | undefined;
  source: string;
  preferences?: Record<string, unknown> | undefined;
  /** Occurrence time (RFC3339). */
  created_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Parse the `{events: […]}` page ListEvents writes. Malformed rows are
 * dropped; a malformed body degrades to an empty list (the card hides). */
export function parseConsentEvents(raw: unknown): ConsentEventLike[] {
  if (!isRecord(raw) || !Array.isArray(raw.events)) return [];
  const out: ConsentEventLike[] = [];
  for (const entry of raw.events) {
    if (!isRecord(entry)) continue;
    out.push({
      subject_type: str(entry.subject_type),
      subject_id: str(entry.subject_id) || undefined,
      subject_email: str(entry.subject_email) || undefined,
      source: str(entry.source),
      preferences: isRecord(entry.preferences) ? entry.preferences : undefined,
      created_at: str(entry.created_at),
    });
  }
  return out;
}

/** Mirrors desktop's isGpcEvent (Consent.tsx:226). */
export function isGpcEvent(event: ConsentEventLike): boolean {
  return (
    event.preferences?.["gpc"] === true ||
    event.source.trim().toLowerCase() === "gpc"
  );
}

export const GPC_WINDOW_DAYS = 30;

export interface GpcSignalSummary {
  /** GPC-tagged rows inside the window, on the loaded page. */
  signalRows: number;
  /** Distinct correlatable subjects (stable id or email). */
  knownSubjects: number;
  /** Rows with neither — signals that cannot be attached to a person. */
  uncorrelatedRows: number;
}

/**
 * Derive the summary over the loaded events. Port of desktop's
 * `gpcSubjectSummary`, bounded to the rolling window; rows whose occurrence
 * timestamp is unparsable or in the future are excluded — a skewed clock
 * must not inflate recent activity (desktop excludes them the same way).
 */
export function summarizeGpcSignals(
  events: readonly ConsentEventLike[],
  nowMs: number,
): GpcSignalSummary {
  const floor = nowMs - GPC_WINDOW_DAYS * 86_400_000;
  const knownSubjectKeys = new Set<string>();
  let signalRows = 0;
  let uncorrelatedRows = 0;
  for (const event of events) {
    if (!isGpcEvent(event)) continue;
    const at = Date.parse(event.created_at);
    if (!Number.isFinite(at) || at > nowMs || at < floor) continue;
    signalRows += 1;
    const subjectId = event.subject_id?.trim();
    const email = event.subject_email?.trim().toLowerCase();
    const subjectKey = subjectId
      ? `${event.subject_type}:id:${subjectId}`
      : email
        ? `${event.subject_type}:email:${email}`
        : null;
    if (!subjectKey) {
      uncorrelatedRows += 1;
      continue;
    }
    knownSubjectKeys.add(subjectKey);
  }
  return {
    signalRows,
    knownSubjects: knownSubjectKeys.size,
    uncorrelatedRows,
  };
}

/** The card's headline sentence. */
export function gpcHeadline(summary: GpcSignalSummary): string {
  const signals =
    summary.signalRows === 1
      ? "1 GPC opt-out signal"
      : `${num(summary.signalRows)} GPC opt-out signals`;
  const subjects =
    summary.knownSubjects === 1
      ? "1 known subject"
      : `${num(summary.knownSubjects)} known subjects`;
  return `${signals} recorded in the last ${GPC_WINDOW_DAYS} days, from ${subjects}.`;
}

/** The warning when signals arrive but cannot be attached to anyone. */
export function gpcUncorrelatedNotice(summary: GpcSignalSummary): string | null {
  if (summary.uncorrelatedRows === 0) return null;
  const rows =
    summary.uncorrelatedRows === 1
      ? "1 of those signals has"
      : `${num(summary.uncorrelatedRows)} of those signals have`;
  return `${rows} no stable subject ID or email, so the opt-out cannot be correlated to a person here.`;
}

/** The card's scope honesty — a loaded page is a floor, not the ledger. */
export const GPC_SCOPE_NOTE =
  "Derived from the most recent consent events this device loaded. The full ledger, and per-subject correlation, live on the web admin's Consent register.";

/** What a live 403 means — a permission rule, never a generic failure. */
export const GPC_DENIED_COPY =
  "Reading the consent-event ledger needs an owner or admin session.";
