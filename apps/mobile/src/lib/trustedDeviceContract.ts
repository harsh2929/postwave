/**
 * trustedDeviceContract — the client half of AUTH#48 "remember this device".
 *
 * ── THE OWNER'S CONSTRAINT ─────────────────────────────────────────────────
 * A trusted device is remembered for EXACTLY 30, 90 or 180 days. 180 is the
 * maximum. There is no custom entry, no "forever" and no longer option. The
 * server enforces this three times over (a handler check, a Go guard in the
 * repository, and a CHECK constraint on `auth_trusted_devices.trust_days`), so
 * this module is NOT the enforcement — it exists so the phone never has to ask
 * for something the server would refuse, and so the rule is a value the picker
 * is BUILT FROM rather than three magic numbers typed into JSX.
 *
 * ── WHY WE STILL VALIDATE ON A CLIENT THAT CANNOT BE TRUSTED ───────────────
 * `trustRequestFields` refuses to put an unapproved duration on the wire. Not
 * as a security control — a modified client posts whatever it likes and gets a
 * 400 — but because a request the server will certainly reject is a request
 * that costs the user a round trip on the MFA screen, which is the worst place
 * in the product to be handed an error.
 *
 * ── NEVER WIDEN FROM THE SERVER EITHER ─────────────────────────────────────
 * `GET /api/v1/auth/trusted-devices` returns `allowed_durations` so the picker
 * can follow the server rather than hard-code. `resolveTrustDurations`
 * INTERSECTS that list with the set below instead of adopting it: a server
 * that started offering 365 — through a bug, a rollback, or a hostile
 * response — must not be able to make this app offer it. The wire can narrow
 * the choice; it can never widen it.
 *
 * Deliberately import-free (no react-native, no expo), like `passwordPolicy`
 * and `sessionExpiryNotice`, so the node vitest environment can exercise every
 * boundary here — and the boundaries ARE the feature.
 */

/**
 * The complete set of trust durations, in the order the picker shows them.
 * Shortest first: the safe option should be the one the thumb reaches.
 */
export const TRUST_DURATIONS = [30, 90, 180] as const;

export type TrustDurationDays = (typeof TRUST_DURATIONS)[number];

/** The ceiling, restated so a reader need not infer it from the tuple. */
export const MAX_TRUST_DAYS: TrustDurationDays = 180;

/**
 * Preselected. The SHORTEST option, on purpose: this feature's entire job is
 * to enforce MFA less often, so its default should give away the least.
 */
export const DEFAULT_TRUST_DAYS: TrustDurationDays = 30;

export function isTrustDurationDays(value: unknown): value is TrustDurationDays {
  return (
    typeof value === "number" &&
    (TRUST_DURATIONS as readonly number[]).includes(value)
  );
}

/**
 * Reconcile the server's advertised durations with the set this build knows.
 *
 * Returns the intersection, in the client's order, and falls back to the full
 * client set when the server said nothing usable — an unreadable policy must
 * not leave the user with an empty picker and no way to proceed.
 */
export function resolveTrustDurations(
  serverAllowed: unknown,
): TrustDurationDays[] {
  if (!Array.isArray(serverAllowed)) return [...TRUST_DURATIONS];
  const offered = serverAllowed.filter(isTrustDurationDays);
  if (offered.length === 0) return [...TRUST_DURATIONS];
  return TRUST_DURATIONS.filter((days) => offered.includes(days));
}

/**
 * The longest window actually on offer — the number the devices screen states
 * out loud, so the ceiling is something the user is told rather than something
 * they infer from three chips on a different screen.
 */
export function trustCeilingDays(
  available: readonly TrustDurationDays[],
): TrustDurationDays {
  if (available.length === 0) return MAX_TRUST_DAYS;
  return available.reduce((a, b) => (b > a ? b : a));
}

/** The duration to preselect given whatever the server actually offers. */
export function defaultTrustDuration(
  available: readonly TrustDurationDays[],
): TrustDurationDays {
  if (available.includes(DEFAULT_TRUST_DAYS)) return DEFAULT_TRUST_DAYS;
  return available[0] ?? DEFAULT_TRUST_DAYS;
}

export interface TotpChallengeInput {
  code?: string | undefined;
  recovery_code?: string | undefined;
  /**
   * Opt-in only. Trust is never requested implicitly — a feature that weakens
   * MFA has to be something the user ticked on the screen where they can read
   * what it does.
   */
  trust_device?: boolean | undefined;
  trust_days?: number | undefined;
}

/** The 200 body of `POST /api/v1/auth/totp/challenge`. */
export interface TotpChallengeResult {
  mfa_satisfied: boolean;
  already?: boolean;
  /**
   * The SERVER's answer to "did you remember me", not an echo of the request.
   * Always present on a 200, and always what the UI reports: issuance can fail
   * after a successful challenge (the code is already spent, so the server
   * returns a degraded 200 rather than a 500), and in that case the user must
   * be told they were not remembered.
   */
  device_trusted?: boolean;
  trust_expires_at?: string;
  trust_days?: number;
  /** Set when trust issuance failed on an otherwise successful challenge. */
  trust_error?: string;
}

/**
 * The trust half of the challenge body — `{}` unless the user opted in AND the
 * duration is one of the three approved values.
 *
 * Silently omitting rather than coercing is deliberate: coercing 365 down to
 * 180 would remember a device the user never agreed to remember for that long,
 * and coercing UP is unthinkable. Omission asks for no trust at all, and the
 * response's `device_trusted:false` then tells the truth.
 */
export function trustRequestFields(
  trustDevice: boolean,
  trustDays: unknown,
): { trust_device: true; trust_days: TrustDurationDays } | Record<string, never> {
  if (!trustDevice) return {};
  if (!isTrustDurationDays(trustDays)) return {};
  return { trust_device: true, trust_days: trustDays };
}

/**
 * Build the whole wire body. Empty strings are dropped so a blank field is
 * never sent as a present-but-empty credential.
 */
export function totpChallengeBody(
  input: TotpChallengeInput,
): Record<string, string | number | boolean> {
  const body: Record<string, string | number | boolean> = {};
  const code = input.code?.trim();
  const recovery = input.recovery_code?.trim();
  if (code) body.code = code;
  if (recovery) body.recovery_code = recovery;
  return {
    ...body,
    ...trustRequestFields(input.trust_device === true, input.trust_days),
  };
}

/** "30 days" / "90 days" / "180 days". */
export function trustDurationLabel(days: TrustDurationDays): string {
  return `${days} days`;
}

/**
 * What the toggle promises, spelled out. The picker's numbers alone do not say
 * what is being given up, and this line is the only place the user reads it.
 */
export function trustConsentLine(days: TrustDurationDays): string {
  return `This device won't ask for a code again for ${days} days. You can undo this any time in Settings.`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TrustedDeviceLines {
  /** "Trusted for 90 days" — the duration the user actually chose. */
  readonly duration: string;
  /** "Expires in 12 days", or "Expired" for a record past its window. */
  readonly expiry: string;
  /**
   * "Last used 3 days ago", or an EM DASH when the record has never been used.
   * ABSENCE IS NOT ZERO: a trust record that has never satisfied MFA has no
   * last-use measurement, and rendering that as "used just now" — or as an
   * epoch date — would be a lie on a security screen.
   */
  readonly lastUsed: string;
}

/**
 * Render one trusted-device row's three lines.
 *
 * Every input is treated as untrusted wire data: a malformed or missing
 * timestamp degrades to an em dash rather than to a fabricated date.
 */
export function trustedDeviceLines(
  row: {
    trust_days?: unknown;
    expires_at?: unknown;
    last_used_at?: unknown;
  },
  nowMs: number,
): TrustedDeviceLines {
  return {
    duration: isTrustDurationDays(row.trust_days)
      ? `Trusted for ${trustDurationLabel(row.trust_days)}`
      : "Trusted device",
    expiry: expiryLine(row.expires_at, nowMs),
    lastUsed: lastUsedLine(row.last_used_at, nowMs),
  };
}

function expiryLine(expiresAt: unknown, nowMs: number): string {
  const ms = parseTime(expiresAt);
  if (ms === null || !Number.isFinite(nowMs)) return "—";
  const remaining = ms - nowMs;
  if (remaining <= 0) return "Expired";
  // Round DOWN, then floor at 1: promising more trust-free time than remains
  // is the error that surprises a user, and "expires in 0 days" is not a
  // sentence anyone can act on.
  const days = Math.floor(remaining / DAY_MS);
  if (days < 1) return "Expires today";
  return `Expires in ${days} ${days === 1 ? "day" : "days"}`;
}

function lastUsedLine(lastUsedAt: unknown, nowMs: number): string {
  const ms = parseTime(lastUsedAt);
  // The whole point of this branch: never used is not "used at time zero".
  if (ms === null) return "Not used yet";
  if (!Number.isFinite(nowMs)) return "—";
  const elapsed = nowMs - ms;
  if (elapsed < 0) return "Last used just now";
  const days = Math.floor(elapsed / DAY_MS);
  if (days < 1) return "Last used today";
  return `Last used ${days} ${days === 1 ? "day" : "days"} ago`;
}

function parseTime(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Mirrors `trustedDeviceInfo` in device_trust_handlers.go. */
export interface TrustedDeviceInfo {
  id: string;
  trust_days: number;
  issued_at: string;
  expires_at: string;
  /**
   * OMITTED, not zeroed, when the record has never satisfied MFA. Absence is
   * not a timestamp — see `trustedDeviceLines`.
   */
  last_used_at?: string;
  ip?: string;
  user_agent?: string;
  /** The record belonging to THIS phone, so its row can say so. */
  current: boolean;
  /** Server-derived device identity (`DeviceIdentity`), when present. */
  label?: string;
}

export interface TrustedDevicesPolicy {
  devices: TrustedDeviceInfo[];
  /**
   * The workspace's `allow_trusted_devices` setting. When false the list is
   * still returned — turning the policy off must not hide credentials that
   * already exist — but no new trust can be issued.
   */
  allowed: boolean;
  /** Narrowed against this build's known set; never widened. */
  allowedDurations: TrustDurationDays[];
}

/**
 * Parse `GET /api/v1/auth/trusted-devices`.
 *
 * A malformed row is DROPPED rather than rendered. On this screen an
 * unidentifiable row would be a credential the user can see but cannot act on,
 * which is the precise failure the visibility requirement exists to prevent —
 * and the revoke-all button still reaches whatever was dropped.
 *
 * `allowed` is true only when the server SAID true. An absent or unparseable
 * policy field must not read as permission for an MFA weakener.
 */
export function parseTrustedDevicesPayload(raw: unknown): TrustedDevicesPolicy {
  const body = (raw ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(body.trusted_devices)
    ? (body.trusted_devices as unknown[]).filter(isTrustedDeviceInfo)
    : [];
  return {
    devices: rows,
    allowed: body.allowed === true,
    allowedDurations: resolveTrustDurations(body.allowed_durations),
  };
}

function isTrustedDeviceInfo(value: unknown): value is TrustedDeviceInfo {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    row.id.length > 0 &&
    typeof row.trust_days === "number" &&
    typeof row.issued_at === "string" &&
    typeof row.expires_at === "string" &&
    typeof row.current === "boolean" &&
    (row.last_used_at === undefined || typeof row.last_used_at === "string") &&
    (row.ip === undefined || typeof row.ip === "string") &&
    (row.label === undefined || typeof row.label === "string") &&
    (row.user_agent === undefined || typeof row.user_agent === "string")
  );
}
