// SPDX-License-Identifier: AGPL-3.0-only
//
// Subscriber consent + send-preference contracts that sit beside the profile
// panels and are NOT covered by subscriber-profile-api.ts:
//
//   - tracking consent (open-pixel / click-rewrite eligibility)
//       GET   /api/v1/subscribers/{id}/tracking-consent
//       PATCH /api/v1/subscribers/{id}/tracking-consent      (If-Match)
//   - send-frequency preference (default / weekly / monthly / paused)
//       PATCH /api/v1/subscribers/{id}                        (If-Match)
//   - jurisdiction re-confirmation evidence (SUB-055)
//       PATCH /api/v1/subscribers/{id}/jurisdiction-reconfirm
//   - Global Privacy Platform sections (SUB-120, read-only)
//       GET   /api/v1/subscribers/{id}/gpp
//
// Backend: apps/api/internal/consent/tracking.go,
// apps/api/internal/subscribers/{handlers,jurisdiction,gpp,channel_consent_canonical}.go.
//
// Every write here is a consent or eligibility decision, so each one is bound
// to the exact revision the operator reviewed (If-Match / expected version),
// refuses to be queued offline, and verifies the committed response before
// the panel renders any new state.

import { api } from "@/lib/api";
import {
  isExactSubscriberVersion,
  updateSubscriber,
  type Subscriber,
} from "@/lib/subscribers-api";

const enc = encodeURIComponent;

export class SubscriberConsentContractError extends Error {
  readonly code = "subscriber_consent_contract_error";

  constructor(
    message = "The subscriber consent service returned an invalid response.",
  ) {
    super(message);
    this.name = "SubscriberConsentContractError";
  }
}

export class SubscriberConsentInputError extends Error {
  readonly code = "subscriber_consent_input_error";

  constructor(message: string) {
    super(message);
    this.name = "SubscriberConsentInputError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const sameId = (candidate: unknown, id: string): boolean =>
  typeof candidate === "string" &&
  candidate.trim().toLowerCase() === id.trim().toLowerCase();

const isTimestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

const isOptionalTimestamp = (value: unknown): boolean =>
  value == null || isTimestamp(value);

/**
 * Strong, quoted entity tag. The tracking write path refuses `*`, weak (`W/`)
 * and list forms (apps/api/internal/consent/tracking.go hasExactTrackingIfMatch),
 * so a client that would send one of those must fail before the request.
 */
const STRONG_ETAG_RE = /^"[^"]+"$/;

export function isStrongEntityTag(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 256 &&
    value.trim() === value &&
    STRONG_ETAG_RE.test(value)
  );
}

function newIdempotencyKey(prefix: string): string {
  const random =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${random}`;
}

export interface ConsentMutationOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/* ------------------------------ Channel consent ---------------------------- */

/** All five reachability channels, in the stable display order desktop uses. */
export const CONSENT_CHANNELS = [
  "email",
  "sms",
  "push",
  "whatsapp",
  "rcs",
] as const;
export type ConsentChannelId = (typeof CONSENT_CHANNELS)[number];

export const CONSENT_CHANNEL_LABELS: Record<ConsentChannelId, string> = {
  email: "Email",
  sms: "SMS",
  push: "Push",
  whatsapp: "WhatsApp",
  rcs: "RCS",
};

/**
 * How a stored channel-consent source is named to a reader.
 *
 * The column also holds tokens that name no act anybody took: "unknown" is its
 * default before a decision exists, and "subscriber_email_terminal_v2" is the
 * marker the server writes when it folds a decision out of the exact-address
 * evidence (apps/api/internal/subscribers/channel_consent_canonical.go). Those
 * are internal bookkeeping and are not shown. Anything unmapped is spelled out
 * rather than printed as a snake_case token.
 */
const CHANNEL_CONSENT_SOURCE_LABELS: Record<string, string> = {
  double_optin: "Double opt-in confirmation",
  single_optin: "Single opt-in record",
  preference_center: "Preference center",
  signed_form: "Signed form or contract",
  direct_request: "Direct subscriber request",
  import: "Verified import evidence",
  api: "Verified API evidence",
  admin: "Recorded by an admin",
  form: "Signed form or contract",
};

const UNNAMEABLE_CONSENT_SOURCES = new Set([
  "unknown",
  "subscriber_email_terminal_v2",
]);

export function consentSourceLabel(raw: string | null | undefined): string {
  const token = (raw ?? "").trim();
  if (!token || UNNAMEABLE_CONSENT_SOURCES.has(token.toLowerCase())) return "";
  const mapped = CHANNEL_CONSENT_SOURCE_LABELS[token.toLowerCase()];
  if (mapped) return mapped;
  const spelled = token.replace(/[_-]+/g, " ").trim();
  return spelled.charAt(0).toUpperCase() + spelled.slice(1);
}

/**
 * The server accepts consent DECISIONS for the email channel only; every other
 * channel refuses a status change with this exact sentence
 * (apps/api/internal/subscribers/channel_consent_canonical.go:66). The panel
 * withholds the verb with that reason instead of sending a request it knows
 * will be refused with 422.
 */
export function channelConsentWriteBlock(channel: string): string | null {
  if (channel === "email") return null;
  return `${channel} consent cannot be mutated until its canonical delivery store is connected; frequency-cap-only edits remain available`;
}

/* ------------------------------ Tracking consent --------------------------- */

/** Mirrors consent.TrackingPrefs (apps/api/internal/consent/tracking.go). */
export interface TrackingConsent {
  /** Exact write precondition; survives the sensitive response cache boundary. */
  version?: string;
  subscriber_id: string;
  subscriber_email: string;
  open_opt_out_at?: string | null;
  click_opt_out_at?: string | null;
  /** Effective decisions also account for GPC, which suppresses both. */
  effective_open_opt_out: boolean;
  effective_click_opt_out: boolean;
  source: string;
  gpc: boolean;
  policy_version: string;
  updated_at: string;
}

export interface TrackingConsentState {
  prefs: TrackingConsent;
  /** Exact strong revision from the body (or legacy ETag) for If-Match. */
  version: string;
}

/**
 * Mirrors consent.TrackingPatchInput. Pass `true` to record an opt-out,
 * `false` to record a grant, omit to leave a dimension alone. The server
 * requires at least one of the two dimensions.
 */
export interface TrackingConsentPatch {
  open_opt_out?: boolean;
  click_opt_out?: boolean;
  source?: string;
  policy_version?: string;
}

function parseTrackingConsent(
  value: unknown,
  id: string,
  version: string | null,
): TrackingConsentState {
  const exactVersion =
    isRecord(value) && "version" in value ? value.version : version;
  if (
    !isRecord(value) ||
    !sameId(value.subscriber_id, id) ||
    typeof value.subscriber_email !== "string" ||
    value.subscriber_email.trim() === "" ||
    typeof value.effective_open_opt_out !== "boolean" ||
    typeof value.effective_click_opt_out !== "boolean" ||
    typeof value.gpc !== "boolean" ||
    typeof value.source !== "string" ||
    typeof value.policy_version !== "string" ||
    !isTimestamp(value.updated_at) ||
    !isOptionalTimestamp(value.open_opt_out_at) ||
    !isOptionalTimestamp(value.click_opt_out_at) ||
    !isStrongEntityTag(exactVersion) ||
    (version !== null && version !== exactVersion)
  ) {
    throw new SubscriberConsentContractError(
      "The tracking-consent service returned an incomplete state or no exact revision. The previous verified preferences were kept; reload before changing them.",
    );
  }
  return { prefs: value as unknown as TrackingConsent, version: exactVersion };
}

export function getTrackingConsent(
  id: string,
  signal?: AbortSignal,
): Promise<TrackingConsentState> {
  let version: string | null = null;
  return api
    .get<unknown>(`/api/v1/subscribers/${enc(id)}/tracking-consent`, {
      signal,
      onResponse: (response) => {
        version = response.headers.get("ETag");
      },
    })
    .then((value) => parseTrackingConsent(value, id, version));
}

export async function updateTrackingConsent(
  id: string,
  patch: TrackingConsentPatch,
  expectedVersion: string,
  options: ConsentMutationOptions = {},
): Promise<TrackingConsentState> {
  if (
    typeof patch.open_opt_out !== "boolean" &&
    typeof patch.click_opt_out !== "boolean"
  ) {
    throw new SubscriberConsentInputError(
      "Choose the open or click tracking decision to record.",
    );
  }
  if (!isStrongEntityTag(expectedVersion)) {
    throw new SubscriberConsentInputError(
      "Reload these tracking preferences before changing them so the latest exact revision can be verified.",
    );
  }
  const body: TrackingConsentPatch = {};
  if (typeof patch.open_opt_out === "boolean") {
    body.open_opt_out = patch.open_opt_out;
  }
  if (typeof patch.click_opt_out === "boolean") {
    body.click_opt_out = patch.click_opt_out;
  }
  if (patch.source?.trim()) body.source = patch.source.trim();
  if (patch.policy_version?.trim()) {
    body.policy_version = patch.policy_version.trim();
  }
  let version: string | null = null;
  const value = await api.patch<unknown>(
    `/api/v1/subscribers/${enc(id)}/tracking-consent`,
    body,
    {
      headers: { "If-Match": expectedVersion },
      idempotencyKey:
        options.idempotencyKey ?? newIdempotencyKey("subscriber-tracking"),
      maxAttempts: 1,
      requireOnline: true,
      signal: options.signal,
      onResponse: (response) => {
        version = response.headers.get("ETag");
      },
    },
  );
  const state = parseTrackingConsent(value, id, version);
  // The committed state must reflect the decision that was sent; anything
  // else means the response is not the write we made.
  if (
    (typeof body.open_opt_out === "boolean" &&
      Boolean(state.prefs.open_opt_out_at) !== body.open_opt_out) ||
    (typeof body.click_opt_out === "boolean" &&
      Boolean(state.prefs.click_opt_out_at) !== body.click_opt_out)
  ) {
    throw new SubscriberConsentContractError(
      "The tracking-consent service did not return the committed decision. The previous verified preferences were kept; reload before trying again.",
    );
  }
  return state;
}

/* ----------------------------- Frequency preference ------------------------ */

export const FREQUENCY_PREFERENCES = [
  "default",
  "weekly",
  "monthly",
  "paused",
] as const;
export type FrequencyPreference = (typeof FREQUENCY_PREFERENCES)[number];

export const FREQUENCY_PREFERENCE_OPTIONS: ReadonlyArray<{
  value: FrequencyPreference;
  label: string;
  hint: string;
}> = [
  { value: "default", label: "Default", hint: "No subscriber-level cap" },
  { value: "weekly", label: "Weekly", hint: "At most one send per week" },
  { value: "monthly", label: "Monthly", hint: "At most one send per month" },
  {
    value: "paused",
    label: "Paused",
    hint: "Excluded from all sends until reactivated",
  },
];

export function isFrequencyPreference(
  value: unknown,
): value is FrequencyPreference {
  return (
    typeof value === "string" &&
    (FREQUENCY_PREFERENCES as readonly string[]).includes(value)
  );
}

/**
 * The three distinct intents the send-frequency control can express. They
 * are kept as a union rather than one loose object so "set a cadence",
 * "pause until a date" and "clear the expiry" cannot be sent together — the
 * server rejects `paused_until` alongside `clear_paused_until`, and a cadence
 * other than `paused` with an expiry would be incoherent.
 */
export type FrequencyPreferenceInput =
  | { frequency_preference: FrequencyPreference }
  | { frequency_preference: "paused"; paused_until: string }
  | { clear_paused_until: true };

export async function setFrequencyPreference(
  id: string,
  input: FrequencyPreferenceInput,
  expectedVersion: string,
  options: ConsentMutationOptions = {},
): Promise<Subscriber> {
  if (!isExactSubscriberVersion(expectedVersion, id)) {
    throw new SubscriberConsentInputError(
      "Reload this subscriber before changing send frequency so the latest revision can be verified.",
    );
  }
  if ("clear_paused_until" in input) {
    return updateSubscriber(
      id,
      { clear_paused_until: true },
      {
        expectedVersion,
        idempotencyKey:
          options.idempotencyKey ?? newIdempotencyKey("subscriber-frequency"),
        signal: options.signal,
      },
    );
  }
  if (!isFrequencyPreference(input.frequency_preference)) {
    throw new SubscriberConsentInputError(
      "frequency_preference must be one of default, weekly, monthly, paused",
    );
  }
  if ("paused_until" in input) {
    const at = Date.parse(input.paused_until);
    if (!Number.isFinite(at)) {
      throw new SubscriberConsentInputError(
        "Enter a valid pause expiry date and time.",
      );
    }
    if (at <= Date.now()) {
      throw new SubscriberConsentInputError(
        "The pause expiry must be in the future; to resume sending now, choose a cadence instead.",
      );
    }
    return updateSubscriber(
      id,
      {
        frequency_preference: "paused",
        paused_until: new Date(at).toISOString(),
      },
      {
        expectedVersion,
        idempotencyKey:
          options.idempotencyKey ?? newIdempotencyKey("subscriber-frequency"),
        signal: options.signal,
      },
    );
  }
  return updateSubscriber(
    id,
    { frequency_preference: input.frequency_preference },
    {
      expectedVersion,
      idempotencyKey:
        options.idempotencyKey ?? newIdempotencyKey("subscriber-frequency"),
      signal: options.signal,
    },
  );
}

/* --------------------------- Jurisdiction re-confirm ----------------------- */

export type JurisdictionRegime = "gdpr" | "casl" | "law25" | "unknown";

/**
 * EU-27 + EEA + UK. Must stay identical to `gdprCountries` in
 * apps/api/internal/geolocation/detector.go: the server rejects a regime that
 * disagrees with its own classifier (jurisdiction_reconfirmation_regime_mismatch).
 */
const GDPR_COUNTRIES = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  "IS",
  "LI",
  "NO",
  "GB",
]);

export function regimeForJurisdiction(
  country: string | null | undefined,
  region?: string | null,
): JurisdictionRegime {
  const normalized = (country ?? "").trim().toUpperCase();
  if (!normalized) return "unknown";
  if (GDPR_COUNTRIES.has(normalized)) return "gdpr";
  if (normalized === "CA") {
    const normalizedRegion = (region ?? "").trim().toUpperCase();
    return ["QC", "QUEBEC", "QUÉBEC"].includes(normalizedRegion)
      ? "law25"
      : "casl";
  }
  return "unknown";
}

export function regulationsForJurisdiction(
  country: string | null | undefined,
  region?: string | null,
): string {
  switch (regimeForJurisdiction(country, region)) {
    case "gdpr":
      return "GDPR";
    case "casl":
      return "CASL";
    case "law25":
      return "Quebec Law 25";
    default:
      return "stricter consent rules";
  }
}

/**
 * The SUB-055 drift fields the subscriber record carries
 * (apps/api/internal/subscribers/types.go). They are read defensively because
 * the shared `Subscriber` type does not declare them yet.
 */
export interface JurisdictionDrift {
  required: boolean;
  detectedJurisdiction: string | null;
  changedAt: string | null;
  region: string | null;
  version: string | null;
}

export function readJurisdictionDrift(
  record: Subscriber | null | undefined,
): JurisdictionDrift {
  const raw: Record<string, unknown> = isRecord(record) ? record : {};
  const detected = raw.detected_jurisdiction;
  const changedAt = raw.jurisdiction_changed_at;
  const region = raw.region;
  return {
    required: raw.jurisdiction_reconfirm_required === true,
    detectedJurisdiction:
      typeof detected === "string" && detected.trim() ? detected.trim() : null,
    changedAt: isTimestamp(changedAt) ? changedAt : null,
    region: typeof region === "string" && region.trim() ? region : null,
    version: isExactSubscriberVersion(raw.version, record?.id)
      ? raw.version
      : null,
  };
}

/**
 * Evidence envelope for PATCH /api/v1/subscribers/{id}/jurisdiction-reconfirm
 * (subscribers.JurisdictionReconfirmInput). `captured_text` is the literal
 * disclosure the subject reviewed — sent verbatim, never trimmed.
 */
export interface JurisdictionReconfirmInput {
  decision: "accepted" | "declined";
  regime: Exclude<JurisdictionRegime, "unknown">;
  privacy_policy_version: string;
  captured_text: string;
  /** Raw server precision from the reviewed record — the one-time CAS key. */
  expected_jurisdiction_changed_at: string;
  expected_subscriber_version: string;
}

const POLICY_CONTROL_RE = /[\p{Cc}\p{Cf}]/u;
const CAPTURED_CONTROL_RE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}]/u;
const MAX_POLICY_VERSION = 100;
const MAX_CAPTURED_RUNES = 8192;
const MAX_CAPTURED_BYTES = 16 * 1024;

const runes = (value: string): number => Array.from(value).length;
const bytes = (value: string): number => new TextEncoder().encode(value).length;

/** Same bounds as normalizeJurisdictionReconfirmInput (jurisdiction.go). */
export function jurisdictionPolicyVersionError(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return "Enter the exact reviewed privacy-policy version.";
  if (
    runes(trimmed) > MAX_POLICY_VERSION ||
    bytes(trimmed) > MAX_POLICY_VERSION
  ) {
    return "Use no more than 100 characters and 100 UTF-8 bytes.";
  }
  if (POLICY_CONTROL_RE.test(trimmed)) {
    return "Remove control or invisible formatting characters.";
  }
  return null;
}

export function jurisdictionCapturedTextError(value: string): string | null {
  if (value.trim() === "") {
    return "Paste the exact consent copy shown to the subject.";
  }
  if (runes(value) > MAX_CAPTURED_RUNES || bytes(value) > MAX_CAPTURED_BYTES) {
    return "Use no more than 8,192 characters and 16 KiB of UTF-8 text.";
  }
  if (CAPTURED_CONTROL_RE.test(value)) {
    return "Remove control or invisible formatting characters; line breaks and tabs are allowed.";
  }
  return null;
}

export async function reconfirmJurisdiction(
  id: string,
  input: JurisdictionReconfirmInput,
  options: ConsentMutationOptions = {},
): Promise<Subscriber> {
  if (input.decision !== "accepted" && input.decision !== "declined") {
    throw new SubscriberConsentInputError(
      "decision must be 'accepted' or 'declined'",
    );
  }
  if (!["gdpr", "casl", "law25"].includes(input.regime)) {
    throw new SubscriberConsentInputError(
      "The detected jurisdiction does not map to a supported strict consent regime. Reload the profile or contact support.",
    );
  }
  const policyError = jurisdictionPolicyVersionError(
    input.privacy_policy_version,
  );
  if (policyError) throw new SubscriberConsentInputError(policyError);
  const capturedError = jurisdictionCapturedTextError(input.captured_text);
  if (capturedError) throw new SubscriberConsentInputError(capturedError);
  if (!isTimestamp(input.expected_jurisdiction_changed_at)) {
    throw new SubscriberConsentInputError(
      "The one-time jurisdiction-change timestamp is missing. Reload the profile before recording evidence.",
    );
  }
  if (!isExactSubscriberVersion(input.expected_subscriber_version, id)) {
    throw new SubscriberConsentInputError(
      "The exact subscriber revision is missing or invalid. Reload the profile before recording evidence.",
    );
  }
  let version: string | null = null;
  const value = await api.patch<Subscriber>(
    `/api/v1/subscribers/${enc(id)}/jurisdiction-reconfirm`,
    {
      decision: input.decision,
      regime: input.regime,
      privacy_policy_version: input.privacy_policy_version.trim(),
      captured_text: input.captured_text,
      expected_jurisdiction_changed_at: input.expected_jurisdiction_changed_at,
      expected_subscriber_version: input.expected_subscriber_version,
    },
    {
      idempotencyKey:
        options.idempotencyKey ?? newIdempotencyKey("subscriber-jurisdiction"),
      maxAttempts: 1,
      requireOnline: true,
      signal: options.signal,
      onResponse: (response) => {
        version = response.headers.get("ETag");
      },
    },
  );
  if (
    !isRecord(value) ||
    !sameId(value.id, id) ||
    !isExactSubscriberVersion(value.version, id) ||
    value.version !== version
  ) {
    throw new SubscriberConsentContractError(
      "The subscriber service did not return the re-confirmed profile revision. Reload the profile before trusting the shown consent state.",
    );
  }
  return value;
}

/* ---------------------------------- GPP ----------------------------------- */

/** Mirrors subscribers.GppAuditEntry (apps/api/internal/subscribers/gpp.go). */
export interface GppAuditEntry {
  id: string;
  subscriber_id: string;
  jurisdiction: string;
  section_value: string;
  source: string;
  created_at: string;
}

export interface GppSections {
  subscriber_id: string;
  /** Jurisdiction → encoded GPP string, stored verbatim (no decoding). */
  sections: Record<string, string>;
  audit: GppAuditEntry[];
}

export function gppSourceLabel(source: string): string {
  switch (source) {
    case "cmp_webhook":
      return "CMP webhook";
    case "manual_override":
      return "Admin";
    case "import":
      return "Import";
    case "api":
      return "API";
    default:
      return source;
  }
}

function parseGppSections(value: unknown, id: string): GppSections {
  if (!isRecord(value) || !sameId(value.subscriber_id, id)) {
    throw new SubscriberConsentContractError(
      "The GPP service returned sections for a different profile.",
    );
  }
  const sections: Record<string, string> = {};
  if (value.sections != null) {
    if (!isRecord(value.sections)) throw new SubscriberConsentContractError();
    for (const [jurisdiction, encoded] of Object.entries(value.sections)) {
      if (typeof encoded !== "string") {
        throw new SubscriberConsentContractError();
      }
      sections[jurisdiction] = encoded;
    }
  }
  const audit: GppAuditEntry[] = [];
  if (value.audit != null) {
    if (!Array.isArray(value.audit)) throw new SubscriberConsentContractError();
    for (const entry of value.audit) {
      if (
        !isRecord(entry) ||
        typeof entry.id !== "string" ||
        typeof entry.jurisdiction !== "string" ||
        typeof entry.section_value !== "string" ||
        typeof entry.source !== "string" ||
        !isTimestamp(entry.created_at)
      ) {
        throw new SubscriberConsentContractError();
      }
      audit.push(entry as unknown as GppAuditEntry);
    }
  }
  return { subscriber_id: value.subscriber_id as string, sections, audit };
}

export function getGppSections(
  id: string,
  signal?: AbortSignal,
): Promise<GppSections> {
  return api
    .get<unknown>(`/api/v1/subscribers/${enc(id)}/gpp`, { signal })
    .then((value) => parseGppSections(value, id));
}
