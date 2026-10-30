/**
 * @postwave/errors — the one API error-envelope parser + message renderer.
 *
 * The Go gateway emits a stable envelope: `{"error":{"code","message",
 * "request_id"}}` (httperror.go), sometimes with top-level `request_id` and,
 * for RFC-7807 responses, flattened fields — plus an `x-request-id` response
 * header. Web and desktop each hand-rolled a parser + a request-id message
 * suffix; the SDK has its own richer `PostwaveError`. They agree on the wire
 * shape but drifted in code. This module is the single, framework-free source
 * so a field rename or a render tweak happens in exactly one place.
 *
 * It also owns the DENIAL vocabulary (`apps/api/internal/entitlement`) — the
 * machine-readable class that tells a role refusal from a paywall from a
 * quota window. See the block above `DENIAL_REASONS`.
 */

/** The normalized shape every surface reads. All fields optional — a given
 *  error only carries what the server sent. */
export interface NormalizedApiError {
  code?: string;
  message?: string;
  requestId?: string;
  retryAfterSeconds?: number;
  fields?: Array<{ path: string; message: string }>;
  region?: string;
  correctEndpoint?: string;
  /** Unknown (non-framing) keys lifted out of a nested error envelope, so a
   *  surface can read server-supplied context (e.g. `min_opens` for a cold-state
   *  copy) without intercepting fetch. Context may be carried inside `error` or
   *  as a top-level sibling such as a request-bound `fire_id`. */
  details?: Record<string, unknown>;
  /** The structured refusal, when the server sent one (see `ApiDenial`).
   *  Present only for a body carrying a KNOWN `reason` — an unrecognised class
   *  is left out rather than guessed at. */
  denial?: ApiDenial;
}

/** Framing keys the parser surfaces as typed fields — excluded from `details`. */
const RESERVED_ERROR_KEYS = new Set([
  "code",
  "message",
  "request_id",
  "requestId",
  "retry_after_seconds",
  "retryAfterSeconds",
  "region",
  "correct_endpoint",
  "correctEndpoint",
  "fields",
]);

/* ------------------------------------------------------------------ *
 * The denial vocabulary.
 *
 * `apps/api/internal/entitlement` is the server's ONE shape for "you cannot do
 * this, and here is why". Its whole reason to exist is that a refusal carries a
 * machine-readable CLASS: "your plan does not include this", "your role does
 * not permit this", "wait for the window to reset" and "this is switched off
 * for your workspace" need four different affordances, and a client holding
 * only prose cannot tell them apart — which is how a paywall gets shown to
 * someone whose workspace already paid.
 *
 * It was parsed by apps/web alone. Desktop lifted the fields into an untyped
 * `details` bag and rendered the sentence unchanged; mobile dropped them at the
 * SDK boundary and branched on bare HTTP status, so `role`, `flag` and `policy`
 * — three refusals with three different remedies — collapsed into one 403
 * string. The classification lives here, next to the parser that already reads
 * the same envelope for web and desktop, so all three surfaces classify a
 * refusal identically even where their copy differs.
 * ------------------------------------------------------------------ */

/** The closed reason vocabulary, mirroring `entitlement.Reason` (denial.go).
 *  A new value is a client-visible contract change on BOTH sides. */
export const DENIAL_REASONS = [
  "plan",
  "role",
  "flag",
  "quota",
  "policy",
  "runtime",
] as const;

export type DenialReason = (typeof DENIAL_REASONS)[number];

/** `entitlement.RemedyUpgradePlan` — a ceiling a tenant can buy past. The
 *  server withholds it on the top tier, so a client must never re-derive it. */
export const REMEDY_UPGRADE_PLAN = "upgrade_plan";
/** `entitlement.RemedyContactWorkspaceAdmin` — only a workspace administrator
 *  can change this. */
export const REMEDY_CONTACT_WORKSPACE_ADMIN = "contact_workspace_admin";

/** The server's structured refusal, field-for-field with `entitlement.Denial`. */
export interface ApiDenial {
  /** The machine-readable class. Always a known value — see `parseDenial`. */
  reason: DenialReason;
  /** Specific code within the reason, e.g. `plan_limit_exceeded`. */
  code?: string;
  /** What was refused — a resource or operation name. */
  subject?: string;
  /** The ONE action that resolves this. Absent means the caller cannot
   *  self-serve, which is itself worth saying rather than inventing a button. */
  remedy?: string;
  /** For a `role` denial, the role that WOULD be permitted. */
  requiredRole?: string;
  /** The plan that produced a `plan` denial. */
  tier?: string;
  /** The metered resource, and its ceiling, when there is a numeric one. */
  resource?: string;
  limit?: number;
  current?: number;
  /** For a `quota` denial, how long until the window resets. */
  retryAfterSeconds?: number;
}

/** Narrow an arbitrary value to the closed reason vocabulary. */
export function isDenialReason(value: unknown): value is DenialReason {
  return (
    typeof value === "string" &&
    (DENIAL_REASONS as readonly string[]).includes(value)
  );
}

/**
 * Read the denial out of an already-normalized error.
 *
 * Returns undefined unless the body carried a KNOWN `reason`. An unrecognised
 * class is deliberately dropped rather than passed through: every consumer
 * switches on this to choose an affordance, and a value outside the vocabulary
 * would fall through every arm to whatever the default happens to be. Dropping
 * it degrades to the surface's ordinary status-based handling, which is the
 * behaviour those surfaces have today.
 *
 * `retryAfterSeconds` comes from the normalized field rather than `details`
 * because `retry_after_seconds` is a framing key the parser already types.
 */
export function parseDenial(err: NormalizedApiError): ApiDenial | undefined {
  const d = err.details;
  if (!d || !isDenialReason(d.reason)) return undefined;
  const out: ApiDenial = { reason: d.reason };
  if (err.code) out.code = err.code;
  const subject = str(d.subject);
  if (subject) out.subject = subject;
  const remedy = str(d.remedy);
  if (remedy) out.remedy = remedy;
  // snake_case is what the Go struct tags emit; camelCase is accepted for the
  // same reason the rest of this parser accepts it — a hand-built envelope or a
  // proxy that re-serialises should not silently lose the actionable half.
  const requiredRole = str(d.required_role) ?? str(d.requiredRole);
  if (requiredRole) out.requiredRole = requiredRole;
  const tier = str(d.tier);
  if (tier) out.tier = tier;
  const resource = str(d.resource);
  if (resource) out.resource = resource;
  const limit = num(d.limit);
  if (limit !== undefined) out.limit = limit;
  const current = num(d.current);
  if (current !== undefined) out.current = current;
  if (err.retryAfterSeconds !== undefined) {
    out.retryAfterSeconds = err.retryAfterSeconds;
  }
  return out;
}

/** The loose shape `denialGuidance` needs. Accepts a parsed `ApiDenial` and the
 *  hand-assembled bag surfaces built before one existed. */
export interface DenialGuidanceInput {
  reason?: string;
  remedy?: string;
  requiredRole?: string;
  retryAfterSeconds?: number;
}

/**
 * Turn a server denial into guidance the reader can act on.
 *
 * Keyed on the REASON and the REMEDY the server sent, never on the code string
 * or the status. Only cases the server can substantiate are handled: a `flag`
 * or `policy` denial gets the message alone on purpose, because neither money
 * nor permissions resolve them and inventing an action would be worse than
 * offering none.
 */
export function denialGuidance(
  message: string,
  details: DenialGuidanceInput | undefined,
): string {
  if (!details) return message;
  if (details.reason === "role") {
    return details.requiredRole
      ? `${message} Ask a workspace ${details.requiredRole} to do this for you.`
      : `${message} Ask a workspace administrator to grant you access.`;
  }
  if (details.remedy === REMEDY_UPGRADE_PLAN) {
    return `${message} Upgrade your plan or reduce usage before retrying.`;
  }
  if (details.remedy === REMEDY_CONTACT_WORKSPACE_ADMIN) {
    return `${message} A workspace administrator can raise this allowance.`;
  }
  // A quota window RESETS, and the server says when. That is the one refusal
  // where waiting is the remedy, and a client that omits the number leaves the
  // reader to guess between "try in a second" and "try tomorrow".
  if (
    details.reason === "quota" &&
    typeof details.retryAfterSeconds === "number" &&
    details.retryAfterSeconds > 0
  ) {
    return `${message} Try again in ${formatRetryDelay(details.retryAfterSeconds)}.`;
  }
  return message;
}

/**
 * Whether retrying this refusal can ever succeed without something changing.
 *
 * Read off the server's OWN status mapping rather than guessed. In
 * `entitlement.Reason.httpStatus` (denial.go) `quota` is 429 and `runtime` is
 * 503 — the two the server itself classes as "this may work later" — while
 * `plan`, `role`, `flag` and `policy` are 402/403, states that hold until a
 * human changes something. Offering "Try again" on those four is a button that
 * is a lie for as long as the denial holds.
 *
 * `runtime` is retryable because of what actually emits it: the highest-traffic
 * one is `internal/rbacresolve`'s `permission_check_failed`, raised when the
 * grant store cannot be read and the gate fails closed. The server's comment
 * there says classifying it is "what lets a client say try again shortly".
 * Reading `runtime` as permanent turned a transient outage into a dead end with
 * no recovery — and on mobile it was a REGRESSION, since a 503 previously fell
 * to the generic 5xx arm and did offer a retry.
 *
 * The permanent "switched off in this deployment" case is a different envelope:
 * `internal/runtimecapability` carries an explicit `retryable: false` on the
 * wire. A client must take that claim from there, where the server asserts it,
 * rather than inferring it from a reason that does not.
 */
export function denialRetryable(denial: ApiDenial | undefined): boolean {
  return denial?.reason === "quota" || denial?.reason === "runtime";
}

/** Human delay for a retry-after, kept coarse: a caller does not need "3601
 *  seconds", and rounding up never promises the window has reopened early. */
export function formatRetryDelay(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const minutes = Math.ceil(s / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object"
    ? (v as Record<string, unknown>)
    : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Parse a server error response body (and optional response headers) into the
 * normalized shape. Accepts the nested `{error:{…}}` envelope, a flat RFC-7807
 * body, and both snake_case (`request_id`) and camelCase (`requestId`) keys.
 * Never throws — an unparseable body yields `{}`.
 */
export function parseErrorEnvelope(
  body: unknown,
  headers?:
    | { get(name: string): string | null }
    | Record<string, string>
    | null,
): NormalizedApiError {
  // A plain string body IS the message (some proxies/timeouts return raw text
  // rather than the JSON envelope). No truncation here — that's a rendering
  // choice a caller layers on; the parser reports what the server sent.
  if (typeof body === "string") return body ? { message: body } : {};

  const root = asRecord(body) ?? {};
  // The canonical envelope nests under `error`; RFC-7807 is flat at the root.
  const env = asRecord(root.error) ?? root;

  const out: NormalizedApiError = {};
  const code = str(env.code);
  if (code) out.code = code;
  // `{error:"string"}` — the error value itself is the message (via str(root.error),
  // reached only when root.error is a string, since a nested object sets env instead).
  const message =
    str(env.message) ??
    str(root.message) ??
    str(root.detail) ??
    str(root.error);
  if (message) out.message = message;

  const requestId =
    str(env.request_id) ??
    str(env.requestId) ??
    str(root.request_id) ??
    str(root.requestId) ??
    headerValue(headers, "x-request-id");
  if (requestId) out.requestId = requestId;

  // Body first — it is written next to the decision. The HEADER is the fallback
  // and it matters far more than it looks: 110 sites in apps/api set
  // `Retry-After` while only a handful also put `retry_after_seconds` in the
  // body (entitlement.Write, keyratelimit, campaigntemplates). A representative
  // case is commerce's WebhookInProgress —
  //   w.Header().Set("Retry-After", "10")
  //   httperror.Write(w, 503, "webhook_in_progress", …)
  // — where the server says exactly when to come back, in the standard HTTP
  // header this parser already receives and already reads for `x-request-id`,
  // and the client saw nothing. `denialGuidance`'s quota arm needs this number;
  // without it the reader is left to guess between "try in a second" and "try
  // tomorrow", which is the failure that arm's own comment describes.
  const retry =
    num(env.retry_after_seconds) ??
    num(env.retryAfterSeconds) ??
    num(root.retry_after_seconds) ??
    retryAfterHeaderSeconds(headers);
  if (retry !== undefined) out.retryAfterSeconds = retry;

  const region = str(env.region) ?? str(root.region);
  if (region) out.region = region;
  const correct = str(env.correct_endpoint) ?? str(env.correctEndpoint);
  if (correct) out.correctEndpoint = correct;

  const rawFields = env.fields ?? root.fields;
  if (Array.isArray(rawFields)) {
    const fields = rawFields
      .map((f) => {
        const r = asRecord(f);
        const path = str(r?.path) ?? str(r?.field);
        const msg = str(r?.message);
        return path && msg ? { path, message: msg } : null;
      })
      .filter((f): f is { path: string; message: string } => f !== null);
    if (fields.length) out.fields = fields;
  }

  // Lift any remaining (non-framing) keys from a NESTED error envelope into
  // `details` — server-supplied context beyond the reserved framing fields.
  // Some endpoints keep the canonical `{error:{code,message}}` frame while
  // returning request-bound evidence (for example `fire_id` + `state`) beside
  // it. Dropping those siblings prevents clients from proving that the error
  // belongs to the request they just made.
  const innerErr = asRecord(root.error);
  if (innerErr) {
    let details: Record<string, unknown> | undefined;
    for (const [k, v] of Object.entries(innerErr)) {
      if (RESERVED_ERROR_KEYS.has(k)) continue;
      (details ??= {})[k] = v;
    }
    for (const [k, v] of Object.entries(root)) {
      if (k === "error" || k === "detail" || RESERVED_ERROR_KEYS.has(k))
        continue;
      (details ??= {})[k] = v;
    }
    if (details) out.details = details;
  }

  // Derived last, because it reads both `details` (reason/remedy/required_role
  // are non-framing keys) and the typed `retryAfterSeconds`.
  //
  // The denial keys are deliberately NOT added to RESERVED_ERROR_KEYS: they
  // stay in `details` as well. Surfaces already read them from there, and this
  // module's contract is that `details` is everything the server sent beyond
  // the framing set — quietly removing keys from it would break readers that
  // have nothing to do with denials.
  const denial = parseDenial(out);
  if (denial) out.denial = denial;

  return out;
}

function headerValue(
  headers:
    | { get(name: string): string | null }
    | Record<string, string>
    | null
    | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    return str((headers as { get(n: string): string | null }).get(name));
  }
  const rec = headers as Record<string, string>;
  const direct = str(rec[name]) ?? str(rec[name.toLowerCase()]);
  if (direct) return direct;
  // A DOM `Headers` is case-insensitive; a plain record is not. Node lowercases
  // incoming headers, but a hand-built record, a test fixture or a client that
  // copies headers keeps the canonical spelling — `X-Request-Id` — and the
  // lookup above missed it, so the "(request <id>)" suffix silently vanished
  // and the user had no id to quote in a support report.
  //
  // @postwave/step-up's readHeader already scans this way for the same reason.
  // Two parsers in this repo read headers off the same responses; only one of
  // them handled the case that DOM Headers hides.
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(rec)) {
    if (key.toLowerCase() === wanted) {
      const found = str(value);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * `Retry-After` as whole seconds, or undefined.
 *
 * RFC 9110 allows delta-seconds OR an HTTP-date. Only delta-seconds is read,
 * deliberately: every emitter in apps/api writes an integer (`strconv.Itoa`, or
 * a literal like "10"), and interpreting a date would require a clock, making
 * this parser time-dependent and its results unreproducible. An HTTP-date is
 * ignored exactly as it was before, rather than guessed at.
 */
function retryAfterHeaderSeconds(
  headers:
    | { get(name: string): string | null }
    | Record<string, string>
    | null
    | undefined,
): number | undefined {
  const raw = headerValue(headers, "retry-after");
  if (!raw) return undefined;
  // Not `num()`: that accepts any finite numeric string, and a Retry-After of
  // "0" or a negative delta is not a wait the caller should render.
  if (!/^\d+$/.test(raw.trim())) return undefined;
  const seconds = Number(raw.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/**
 * Render a user-facing error string with the support request-id appended (the
 * `" (request <id>)"` suffix web + desktop both use), so a user can quote it in
 * a report. Falls back when the message is empty.
 */
export function formatErrorMessage(
  message: string | undefined,
  requestId?: string | undefined,
  fallback = "Something went wrong",
): string {
  // Truthy check (not trim) so this matches the existing web `err.message ||
  // fallback` and desktop `withRequestId(message, id)` semantics exactly — a
  // behaviour-preserving delegation, not a subtle change.
  const base = message ? message : fallback;
  return requestId ? `${base} (request ${requestId})` : base;
}
