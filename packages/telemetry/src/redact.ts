/**
 * Pure, SDK-free PII/secret redaction for Sentry events + breadcrumbs.
 *
 * The single source of truth for the scrub rules every Moosewave surface
 * claims to apply (apps/api observability/sentry.go, web, desktop, mobile).
 * The audit found these had diverged — desktop redacted breadcrumb URLs but
 * web + mobile did not. Consumers wire `redactEvent` into `beforeSend` and
 * `redactBreadcrumb` into `beforeBreadcrumb` so the rules can't drift.
 */

export interface RedactableEvent {
  request?: {
    data?: unknown;
    cookies?: unknown;
    headers?: Record<string, string>;
    query_string?: unknown;
    url?: unknown;
  };
  breadcrumbs?: RedactableBreadcrumb[];
  contexts?: unknown;
  exception?: {
    values?: Array<{ value?: unknown; [key: string]: unknown }>;
  };
  extra?: unknown;
  fingerprint?: unknown;
  logentry?: {
    formatted?: unknown;
    message?: unknown;
    params?: unknown;
    [key: string]: unknown;
  };
  message?: unknown;
  tags?: Record<string, unknown>;
  user?: unknown;
  [key: string]: unknown;
}

export interface RedactableBreadcrumb {
  data?: Record<string, unknown>;
  message?: unknown;
  [key: string]: unknown;
}

const SENSITIVE_QUERY_KEY_PARTS = [
  "api_key",
  "token",
  "key",
  "secret",
  "password",
  "passwd",
  "pwd",
  "signature",
  "sig",
  "hmac",
  "authorization",
  "auth",
  "code",
  "state",
  "session",
  "cursor",
  "email",
  "e-mail",
  "subscriber",
  "recipient",
  "address",
];

/** Request headers stripped entirely (matched case-insensitively). */
const SENSITIVE_HEADERS = ["authorization", "cookie", "x-postwave-token"];
const SAFE_REQUEST_HEADERS = ["accept", "content-type"];
const SAFE_TAG_KEYS = new Set([
  "boundary",
  "environment",
  "error_code",
  "handled",
  "operation",
  "platform",
  "release",
  "runtime",
  "status",
]);
const SAFE_BREADCRUMB_DATA_KEYS = new Set([
  "duration",
  "from",
  "method",
  "status",
  "status_code",
  "to",
  "type",
  "url",
]);
const SAFE_STRUCTURED_VALUE_RE = /^[A-Za-z0-9_.:/ -]{1,80}$/;
const REDACTED_MESSAGE = "[redacted message]";

export function isSensitiveQueryKey(key: string): boolean {
  const lower = key.toLowerCase();
  // Search boxes routinely carry a phone, email, or pasted message. Keep the
  // one-letter key exact: substring-matching "q" would also redact benign
  // structural names such as "sequence".
  return lower === "q" || SENSITIVE_QUERY_KEY_PARTS.some((part) => lower.includes(part));
}

/** Matches an email address embedded as (or within) a path segment. */
const EMAIL_RE = /[^/@\s]+@[^/@\s]+\.[^/@\s]+/;
/**
 * Matches a path segment that looks like an opaque secret/token rather than a
 * human-readable route word: long, high-entropy-ish runs of token characters.
 * Examples: reset/password tokens, signed links, JWT-ish blobs, raw hex/base64.
 * Plain route words ("subscribers", "settings") and short numeric ids stay.
 */
const SECRETISH_SEGMENT_RE = /^[A-Za-z0-9._~+/=-]{24,}$/;
/** A long hex run (e.g. a 32+ char token) even if shorter than 24 mixed chars. */
const HEX_TOKEN_RE = /^[0-9a-fA-F]{32,}$/;
/** A UUID — frequently a token-like identifier worth scrubbing from paths. */
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** A JWT (three base64url segments separated by dots). */
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const PUBLIC_PREFERENCE_CAPABILITY_PREFIX = "/api/public/preferences/";
const LOCALE_PATH_SEGMENT_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
const E164_PATH_SEGMENT_RE = /^\+[1-9]\d{7,14}$/;

function decodedPathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Phone numbers are identifiers, but a +1 number is much shorter than the
 * generic opaque-token threshold. Only scrub it in the two SMS path shapes
 * that deliberately carry a recipient number so ordinary numeric route ids
 * remain useful diagnostics.
 */
function isSmsPhonePathSegment(parts: readonly string[], index: number): boolean {
  if (!E164_PATH_SEGMENT_RE.test(decodedPathSegment(parts[index] ?? ""))) return false;
  const previous = parts[index - 1];
  if (previous === "sms" || previous === "sms-inbox") return true;
  return previous === "conversations" && parts[index - 2] === "sms";
}

function redactPublicPreferenceCapabilityPath(path: string): string {
  if (!path.startsWith(PUBLIC_PREFERENCE_CAPABILITY_PREFIX)) return path;
  const remainder = path.slice(PUBLIC_PREFERENCE_CAPABILITY_PREFIX.length);
  if (!remainder) return path;
  const slash = remainder.indexOf("/");
  const capability = slash === -1 ? remainder : remainder.slice(0, slash);
  if (!capability) return path;
  return `${PUBLIC_PREFERENCE_CAPABILITY_PREFIX}[redacted]${remainder.slice(capability.length)}`;
}

/**
 * True when a single URL path segment looks like a secret or PII (an email,
 * an opaque token, a UUID, a long hex/base64 blob, or a JWT) and should be
 * replaced with `[redacted]`. Ordinary route words and short ids are kept so
 * the URL stays useful for debugging.
 */
export function isSensitivePathSegment(segment: string): boolean {
  if (!segment) return false;
  const decoded = decodedPathSegment(segment);
  if (EMAIL_RE.test(decoded)) return true;
  if (UUID_RE.test(decoded)) return true;
  if (JWT_RE.test(decoded)) return true;
  if (HEX_TOKEN_RE.test(decoded)) return true;
  if (SECRETISH_SEGMENT_RE.test(decoded)) return true;
  return false;
}

/**
 * Scrub sensitive PATH segments (e.g. `/reset/<token>`, `/subscribers/<email>`)
 * by replacing each secret-looking segment with `[redacted]`. Operates on the
 * path portion of a URL string; preserves leading/trailing slashes and the
 * route words around the secrets. Returns the original string when no segment
 * looks sensitive.
 */
export function redactPath(path: string): string {
  const capabilitySafePath = redactPublicPreferenceCapabilityPath(path);
  let touched = capabilitySafePath !== path;
  const parts = capabilitySafePath.split("/");
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (parts[index] !== "preferences" || !parts[index + 1]) continue;
    if (
      index === 1 ||
      (index === 2 && LOCALE_PATH_SEGMENT_RE.test(parts[1] ?? ""))
    ) {
      parts[index + 1] = "[redacted]";
      touched = true;
    }
  }
  const scrubbed = parts
    .map((seg, index) => {
      if (isSmsPhonePathSegment(parts, index) || isSensitivePathSegment(seg)) {
        touched = true;
        return "[redacted]";
      }
      return seg;
    })
    .join("/");
  return touched ? scrubbed : path;
}

/**
 * A query VALUE that is personal data regardless of which parameter carries it.
 *
 * The key rule below is a deny-list, and a deny-list of parameter names cannot
 * be completed: `?query=` (the list-members search) and `?actor_label=` (the
 * audit filter) both carried email addresses to Sentry verbatim, because
 * neither name contains any listed part and neither is the exact key "q". The
 * product tells operators on its own Privacy screen that "No subscriber data,
 * email content, or names are ever sent", so the value shape must be checked
 * as well as the name.
 */
function isSensitiveQueryValue(value: string): boolean {
  if (!value) return false;
  const decoded = decodedPathSegment(value);
  return EMAIL_RE.test(decoded) || E164_PATH_SEGMENT_RE.test(decoded);
}

export function redactQueryString(qs: string): string {
  try {
    const params = new URLSearchParams(qs);
    let touched = false;
    for (const k of Array.from(params.keys())) {
      if (isSensitiveQueryKey(k)) {
        params.set(k, "[redacted]");
        touched = true;
        continue;
      }
      // The name did not give it away; the value still can.
      if (params.getAll(k).some(isSensitiveQueryValue)) {
        params.set(k, "[redacted]");
        touched = true;
      }
    }
    return touched ? params.toString() : qs;
  } catch {
    return qs;
  }
}

export function redactUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    let touched = false;
    for (const k of Array.from(u.searchParams.keys())) {
      if (isSensitiveQueryKey(k)) {
        u.searchParams.set(k, "[redacted]");
        touched = true;
        continue;
      }
      // Same value-shape rule as redactQueryString. This loop is separate from
      // that function (redactUrl only delegates to it for bare paths), so a fix
      // applied there alone leaves absolute URLs — the breadcrumb case, and the
      // one that actually reaches Sentry — still leaking.
      if (u.searchParams.getAll(k).some(isSensitiveQueryValue)) {
        u.searchParams.set(k, "[redacted]");
        touched = true;
      }
    }
    // Also scrub secret/PII path segments (e.g. /reset/<token>,
    // /subscribers/<email>) — these are NOT query params and were leaking
    // verbatim before. `[redacted]` would be percent-encoded by URL, so build
    // the path manually and only assign when something changed.
    const scrubbedPath = redactPath(u.pathname);
    if (scrubbedPath !== u.pathname) {
      touched = true;
      // Reconstruct the URL so `[redacted]` isn't percent-encoded by the
      // URL setter; preserve query (already scrubbed above) + hash.
      const search = u.search;
      const hash = u.hash;
      return `${u.origin}${scrubbedPath}${search}${hash}`;
    }
    return touched ? u.toString() : rawUrl;
  } catch {
    // Not an absolute URL — could still be a bare path like
    // "/reset/<token>?x=1". Scrub the path portion best-effort.
    const qIndex = rawUrl.indexOf("?");
    const pathPart = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
    const queryAndHash = qIndex === -1 ? "" : rawUrl.slice(qIndex + 1);
    const hashIndex = queryAndHash.indexOf("#");
    const queryPart = hashIndex === -1 ? queryAndHash : queryAndHash.slice(0, hashIndex);
    const hash = hashIndex === -1 ? "" : queryAndHash.slice(hashIndex);
    const scrubbedPath = redactPath(pathPart);
    const scrubbedQuery = qIndex === -1 ? "" : redactQueryString(queryPart);
    if (scrubbedPath === pathPart && scrubbedQuery === queryPart) return rawUrl;
    return qIndex === -1
      ? scrubbedPath
      : `${scrubbedPath}?${scrubbedQuery}${hash}`;
  }
}

/** Mutates + returns the event with body/cookies/sensitive-headers/query/url
 *  scrubbed. Generic so the real Sentry ErrorEvent round-trips its type. */
export function redactEvent<T extends RedactableEvent>(event: T): T {
  // These top-level bags are arbitrary application data in Sentry. Device,
  // route and release metadata are already supplied through SDK-native fields;
  // dropping the unbounded copies is safer than maintaining a denylist.
  delete event.user;
  delete event.extra;
  delete event.contexts;
  delete event.fingerprint;
  if (typeof event.message === "string") event.message = REDACTED_MESSAGE;
  if (event.logentry) {
    delete event.logentry.formatted;
    delete event.logentry.message;
    delete event.logentry.params;
  }
  for (const exception of event.exception?.values ?? []) {
    if (typeof exception.value === "string") {
      exception.value = REDACTED_MESSAGE;
    }
  }
  if (event.tags) {
    for (const [key, value] of Object.entries(event.tags)) {
      if (!SAFE_TAG_KEYS.has(key) || !isSafeStructuredValue(value)) {
        delete event.tags[key];
      }
    }
  }
  for (const breadcrumb of event.breadcrumbs ?? []) {
    redactBreadcrumb(breadcrumb);
  }
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    if (event.request.headers) {
      for (const name of Object.keys(event.request.headers)) {
        const normalized = name.toLowerCase();
        if (
          SENSITIVE_HEADERS.includes(normalized) ||
          !SAFE_REQUEST_HEADERS.includes(normalized)
        ) {
          delete event.request.headers[name];
        }
      }
    }
    if (typeof event.request.query_string === "string") {
      event.request.query_string = redactQueryString(
        event.request.query_string,
      );
    }
    if (typeof event.request.url === "string") {
      event.request.url = redactUrl(event.request.url);
    }
  }
  return event;
}

/**
 * Redact URL fields on a fetch/xhr/navigation breadcrumb (these carry full
 * request URLs Sentry would otherwise store verbatim). The web + mobile
 * surfaces were missing this; it makes their breadcrumbs match desktop.
 */
export function redactBreadcrumb<T extends RedactableBreadcrumb>(crumb: T): T {
  // Breadcrumb messages and arbitrary data are often built from caught server
  // errors or user input. Preserve only bounded structural network/navigation
  // fields and scrub every URL-like value.
  delete crumb.message;
  const data = crumb.data;
  if (data) {
    for (const [field, value] of Object.entries(data)) {
      if (!SAFE_BREADCRUMB_DATA_KEYS.has(field)) {
        delete data[field];
      } else if (["url", "to", "from"].includes(field)) {
        if (typeof value === "string") data[field] = redactUrl(value);
        else delete data[field];
      } else if (!isSafeStructuredValue(value)) {
        delete data[field];
      }
    }
  }
  return crumb;
}

function isSafeStructuredValue(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  return typeof value === "string" && SAFE_STRUCTURED_VALUE_RE.test(value);
}
