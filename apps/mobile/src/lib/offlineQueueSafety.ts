/**
 * lib/offlineQueueSafety.ts — which writes may be queued while offline
 * (NATIVE#1).
 *
 * Mobile's offline queue used to be a hand-written registry of exactly THREE
 * mutations (campaign subject, sequence create, sequence save). Desktop has
 * always queued generically against a table of route shapes
 * (apps/desktop/src/lib/offline-store.ts SAFE_MUTATION_PATTERNS), so a phone —
 * the device most likely to be offline — could queue less than the laptop.
 *
 * This module is the mobile port of that table. It is deliberately a PURE
 * policy with no React Native imports so every rule is unit-tested in the node
 * environment, and it is re-evaluated at REPLAY time (not just at enqueue
 * time): a queued record is persisted to disk and survives process death, so
 * the executor must never trust that the record it rehydrates was produced by
 * the current build's rules.
 *
 * Three layers, all of which must agree before a write is queueable:
 *
 *   1. VERB — only POST/PATCH/PUT. A DELETE that lands late is unrecoverable.
 *   2. ROUTE — an allowlist of low-risk entity writes, plus an explicit
 *      online-only denylist that wins over the allowlist (billing, auth, key
 *      management, sends, bulk operations).
 *   3. BODY — a route can be safe while a specific body is not. Publishing a
 *      form and scheduling a campaign both travel over an otherwise-queueable
 *      PATCH.
 *
 * Kept in step with desktop by src/lib/offlineQueueSafety.test.ts, which
 * asserts the exact route table rather than a sample of it.
 */

/**
 * Entity writes safe to replay minutes later. Mirrors desktop's
 * SAFE_MUTATION_PATTERNS minus `templates` / `campaign-templates`, which have
 * no route in the current gateway (verified against
 * apps/api/internal/apidocs/openapi.json), and minus the tag and subscriber
 * PATCHes. That second omission is a deliberate divergence: desktop persists
 * the If-Match header with each queued write (offline-store.ts storedHeaders),
 * while mobile's EntityWriteVars carries no precondition at all — so both
 * routes are online-only here (see ONLINE_ONLY_PATTERNS).
 */
const SAFE_MUTATION_PATTERNS: readonly RegExp[] = [
  /^POST \/api\/v1\/forms$/,
  /^PATCH \/api\/v1\/forms\/[^/]+$/,
  /^POST \/api\/v1\/segments$/,
  /^PATCH \/api\/v1\/segments\/[^/]+$/,
  /^POST \/api\/v1\/lists$/,
  /^PATCH \/api\/v1\/lists\/[^/]+$/,
  /^POST \/api\/v1\/tags$/,
  /^PATCH \/api\/v1\/campaigns\/[^/]+$/,
  // Adding someone to a list (AUDIENCE#33). The one audience write that is
  // unambiguously safe to replay later, and I checked the handler rather than
  // the manifest: `lists.AddSubscribers`
  // (apps/api/internal/lists/membership_write.go:111) only ever ADDS, and the
  // route comment at lists.go:176 states the property that makes this
  // queueable — "POST is idempotent by construction (re-adding an active
  // member is a counted no-op)". So a late replay can add a membership that
  // already exists, and can never remove one.
  //
  // Its sibling DELETE is excluded by the blanket `^DELETE ` rule above, which
  // is right: a removal that lands an hour later is unrecoverable.
  //
  // NOT extended to subscriber TAGGING, which travels over the subscriber
  // PATCH (online-only) as a FULL-ARRAY REPLACE. Replaying that drops any tag
  // a colleague added in the meantime — data loss, not a stale field — and
  // the v1 subscriber route has no additive tag verb to queue instead.
  /^POST \/api\/v1\/lists\/[^/]+\/subscribers$/,
  // A voice label is a training annotation on a text sample the operator has
  // already typed: nothing is sent, nobody is charged, and the idempotency key
  // makes a late replay a no-op if it raced an earlier success. Losing it
  // because a tunnel ate the request is strictly worse than replaying it.
  /^POST \/api\/v1\/voice\/labels$/,
];

/**
 * Evaluated BEFORE the allowlist and wins over it. Anything that moves money,
 * changes credentials, reaches an external provider, or sends mail to real
 * people must fail loudly while the user is present rather than succeed
 * silently an hour later.
 */
const ONLINE_ONLY_PATTERNS: readonly RegExp[] = [
  /^DELETE /,
  / \/api\/v1\/billing\b/,
  / \/api\/v1\/auth\b/,
  / \/api\/v1\/api-keys\b/,
  / \/api\/v1\/privacy\b/,
  / \/api\/v1\/settings\/privacy\b/,
  / \/api\/v1\/settings\/email-compliance\b/,
  / \/api\/v1\/migrations\b/,
  /\/oauth\b/,
  / \/api\/v1\/campaigns\/[^/]+\/(send|send-now|test-send|test|schedule|unschedule|resume|duplicate-send|ab-test)\b/,
  / \/api\/v1\/campaigns\/ab-test\b/,
  / \/api\/v1\/subscribers\/bulk\b/,
  / \/api\/v1\/subscribers\/merge\b/,
  // The scan-bound merge route the duplicates queue uses. It is already
  // outside the allowlist, but "not listed" and "explicitly refused" are
  // different guarantees and this one destroys a profile: it re-points a
  // person's events, suppressions and consent onto another row and disables
  // theirs (merge/apply.go:355-405). A replay an hour later would apply a
  // plan whose fingerprint the server has already invalidated, so the only
  // thing queuing could produce is a confusing late failure.
  / \/api\/v1\/merge\/apply\b/,
  / \/api\/v1\/subscribers\/identify\b/,
  / \/api\/v1\/subscribers\/[^/]+\/.+/,
  / \/api\/v1\/subscriber-imports\b/,
  // Durable draft checkpoints (ECO-03). An OPTIMISTIC-CONCURRENCY write: the
  // PUT carries the version it was built on, and the server refuses it with
  // 409 the moment that version is not the current one
  // (apps/api/internal/editorcheckpoint). Replayed from the queue an hour
  // later it is a guaranteed conflict, arriving with no editor open and nobody
  // to resolve it — and if it did land, it would overwrite the newer draft
  // whoever picked up the laptop has since written. The route is not on the
  // allowlist above, so this is belt-and-braces; it is here so a later
  // allowlist growth cannot quietly make a versioned write queueable.
  / \/api\/v1\/editor\/checkpoints\b/,
  // Tag and subscriber edits. Both handlers answer 428 precondition_required,
  // before touching anything, to a write without a strong If-Match
  // (apps/api/internal/subscribers/handlers.go, apps/api/internal/tags/tags.go),
  // and a queued record carries none — so a replay is a guaranteed 428 with
  // nobody there to act on it. Carrying a token captured at enqueue time would
  // only turn that into a 412 after any later edit. The online paths send the
  // record's token while the person is present (api/subscriberConditionalWrite.ts
  // reads it just before the write; api/tagsManage.ts sends the row's etag).
  // Listed here, not merely left off the allowlist, so a later allowlist growth
  // cannot quietly re-admit them.
  /^(?:PATCH|PUT) \/api\/v1\/subscribers\/[^/]+$/,
  /^(?:PATCH|PUT) \/api\/v1\/tags\/[^/]+$/,
];

const QUEUEABLE_VERBS = new Set(["POST", "PATCH", "PUT"]);
/** A queued path is persisted and replayed verbatim; keep it bounded. */
const MAX_PATH_CHARS = 512;

/**
 * Normalise a path for matching, or return null when the record is not
 * replayable at all.
 *
 * ABSOLUTE URLs ARE REJECTED OUTRIGHT — not reduced to their pathname the way
 * desktop's stripOrigin does. The SDK always resolves a queued write against
 * the session's baseUrl, so an absolute URL in a persisted record can only
 * ever be a corrupted or tampered one; accepting its pathname would let
 * `https://evil.example/api/v1/tags/1` pass the allowlist. (This exact hole
 * was caught by src/lib/offlineEntityWrite.test.ts.)
 */
export function normalizeQueuePath(path: string): string | null {
  if (typeof path !== "string") return null;
  const value0 = path.trim();
  if (!value0 || value0.length > MAX_PATH_CHARS) return null;
  // Any scheme, protocol-relative form, or embedded authority is refused.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value0) || value0.startsWith("//")) {
    return null;
  }
  let value = value0;
  const cut = value.search(/[?#]/);
  if (cut >= 0) value = value.slice(0, cut);
  if (!value.startsWith("/api/")) return null;
  // `..` cannot appear in a legitimate API path and is the classic way to
  // walk a replayed write onto a route the allowlist never approved.
  if (value.includes("..") || value.includes("//")) return null;
  return value;
}

/** Campaign PATCHes that actually schedule or start a send. */
function isSendLikeCampaignPatch(record: Record<string, unknown>): boolean {
  return (
    record.status === "scheduled" ||
    record.status === "sending" ||
    record.status === "sent" ||
    typeof record.scheduled_at === "string"
  );
}

/**
 * Consent and delivery state. These are not low-risk profile edits: replaying
 * a stale `status: "unsubscribed"` after the person has re-subscribed is a
 * compliance incident, not a lost keystroke.
 */
const SUBSCRIBER_ONLINE_ONLY_KEYS = [
  "status",
  "unsubscribe_reason",
  "frequency_preference",
  "paused_until",
  "clear_paused_until",
  "pause_days",
] as const;

/**
 * Body-level carve-outs for routes the allowlist already approved. Mirrors
 * desktop's isSafeQueueBody.
 */
export function isSafeQueueBody(
  method: string,
  path: string,
  body: unknown,
): boolean {
  if (method !== "PATCH" || !body || typeof body !== "object") return true;
  if (Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  if (/^\/api\/v1\/campaigns\/[^/]+$/.test(path)) {
    return !isSendLikeCampaignPatch(record);
  }
  if (/^\/api\/v1\/forms\/[^/]+$/.test(path)) {
    // Publish/unpublish changes a PUBLIC surface; draft edits stay queueable.
    return record.status === undefined;
  }
  // Defence in depth: the whole route is online-only above, but this rule
  // stays true on its own (and is what other modules cite).
  if (/^\/api\/v1\/subscribers\/[^/]+$/.test(path)) {
    return !SUBSCRIBER_ONLINE_ONLY_KEYS.some(
      (key) => record[key] !== undefined,
    );
  }
  return true;
}

/**
 * True when the DENYLIST refuses this route, whatever the allowlist says.
 *
 * Exported because "not on the allowlist" and "explicitly refused" are
 * different guarantees, and a test that can only observe the combined answer
 * cannot tell them apart: it passes identically whether a route is denied on
 * purpose or merely unlisted, so the deliberate refusal can be deleted with
 * every test still green. Anything whose refusal is load-bearing — a send, a
 * credential change, an optimistic-concurrency write — should be asserted
 * through here as well as through `isQueueableMutation`.
 */
export function isOnlineOnlyRoute(method: string, path: string): boolean {
  const verb = typeof method === "string" ? method.toUpperCase() : "";
  const normalized = normalizeQueuePath(path);
  if (normalized === null) return true;
  const key = `${verb} ${normalized}`;
  return ONLINE_ONLY_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * The single decision function. Screens call it before enqueuing; the replay
 * executor calls it again on the rehydrated record.
 */
export function isQueueableMutation(
  method: string,
  path: string,
  body?: unknown,
): boolean {
  const verb = typeof method === "string" ? method.toUpperCase() : "";
  if (!QUEUEABLE_VERBS.has(verb)) return false;
  const normalized = normalizeQueuePath(path);
  if (normalized === null) return false;
  const key = `${verb} ${normalized}`;
  if (isOnlineOnlyRoute(verb, normalized)) return false;
  if (!SAFE_MUTATION_PATTERNS.some((pattern) => pattern.test(key))) return false;
  return isSafeQueueBody(verb, normalized, body);
}

/** Exposed so the contract test can assert the table itself, not a sample. */
export const offlineQueueSafetyPolicy = {
  safeRouteCount: SAFE_MUTATION_PATTERNS.length,
  onlineOnlyCount: ONLINE_ONLY_PATTERNS.length,
  verbs: [...QUEUEABLE_VERBS],
  maxPathChars: MAX_PATH_CHARS,
  subscriberOnlineOnlyKeys: SUBSCRIBER_ONLINE_ONLY_KEYS,
} as const;
