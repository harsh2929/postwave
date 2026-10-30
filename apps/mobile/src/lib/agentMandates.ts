/**
 * lib/agentMandates.ts — ordering, state and plain-language summaries for the
 * agent-mandate screen.
 *
 * ── WHY THIS SCREEN EXISTS ─────────────────────────────────────────────────
 * A mandate is the bound a person puts on an agent: these actions, on these
 * resources, this many times, until this moment. The server is explicit that a
 * mandate an agent could issue to itself would not be a bound at all
 * (`mandate/handlers.go`), which is why the whole surface is session-only.
 *
 * Until now no client existed on ANY surface — not web, not desktop, not the
 * SDK. The governance moat was reachable only by hand-rolled HTTP. Revoke is
 * the archetypal phone verb: an agent is doing something you did not intend,
 * and you end its authority from wherever you happen to be standing.
 *
 * ── WHAT LIVES HERE AND WHY IT IS PURE ─────────────────────────────────────
 * Three judgement calls that deserve tests rather than being buried in JSX:
 *
 *  - STATE. Which single fact matters most about a mandate right now, resolved
 *    in a precedence order that is itself a decision (see `mandateState`).
 *  - ORDER. Active first, because a dead mandate is history and a live one is
 *    the thing you might need to kill.
 *  - AUTHORITY SENTENCE. "Can send campaigns and edit segments, 3 uses left"
 *    is what an operator needs at 2am; `actions` and `resources` as raw arrays
 *    are not.
 *
 * No react-native imports — this module is imported by node-run vitest.
 */

export interface AgentMandateLike {
  id: string;
  purpose: string;
  actions: readonly string[];
  resources: readonly string[];
  usesRemaining: number;
  expiresAt: string;
  lastUsedAt?: string | undefined;
  revokedAt?: string | undefined;
}

/**
 * The wire shape, as the SDK hands it over.
 *
 * `ops.ts` passes SDK types straight through rather than normalising (the same
 * choice it makes for SCIM and agency), so the snake_case→camelCase step lives
 * here where it can be tested, instead of inline in JSX where a mistyped field
 * silently renders `undefined`. Nulls are flattened to `undefined` because Go's
 * `omitempty` on a `*time.Time` produces both absence and explicit null.
 */
export interface AgentMandateWire {
  id: string;
  purpose: string;
  actions: string[];
  resources: string[];
  uses_remaining: number;
  expires_at: string;
  last_used_at?: string | null;
  revoked_at?: string | null;
}

export function toMandate(wire: AgentMandateWire): AgentMandateLike {
  return {
    id: wire.id,
    purpose: wire.purpose?.trim() || "Untitled mandate",
    actions: Array.isArray(wire.actions) ? wire.actions : [],
    resources: Array.isArray(wire.resources) ? wire.resources : [],
    // A missing count must not read as "unlimited". Absent means we do not
    // know, and an unknown budget is safest rendered as spent.
    usesRemaining:
      typeof wire.uses_remaining === "number" ? wire.uses_remaining : 0,
    expiresAt: wire.expires_at ?? "",
    ...(wire.last_used_at ? { lastUsedAt: wire.last_used_at } : {}),
    ...(wire.revoked_at ? { revokedAt: wire.revoked_at } : {}),
  };
}

function at(value: string | undefined): number {
  if (!value) return 0;
  const n = new Date(value).getTime();
  return Number.isFinite(n) ? n : 0;
}

export type AgentMandateState = "revoked" | "expired" | "exhausted" | "active";

/**
 * The single most important fact about a mandate, in precedence order.
 *
 * Revoked beats expired beats exhausted. All three mean "cannot be used", and
 * the order encodes WHY in decreasing deliberateness: somebody ended it, versus
 * the clock ended it, versus the agent used it up. That distinction is the
 * whole point of an audit read — "did we stop it, or did it simply finish?"
 *
 * `usesRemaining <= 0` is checked last because a revoked-and-exhausted mandate
 * should read as revoked: the human act is the more informative one.
 */
export function mandateState(
  mandate: AgentMandateLike,
  now: number = Date.now(),
): AgentMandateState {
  if (mandate.revokedAt) return "revoked";
  const expiry = at(mandate.expiresAt);
  if (expiry > 0 && expiry <= now) return "expired";
  if (mandate.usesRemaining <= 0) return "exhausted";
  return "active";
}

/** True when the mandate can still authorise an action right now. */
export function mandateIsLive(
  mandate: AgentMandateLike,
  now: number = Date.now(),
): boolean {
  return mandateState(mandate, now) === "active";
}

/**
 * Revoking a dead mandate is a no-op the server would happily accept (it
 * answers 200 for anything), so the button is hidden rather than offered — an
 * action that cannot change anything should not be presented as if it could.
 */
export function mandateIsRevocable(
  mandate: AgentMandateLike,
  now: number = Date.now(),
): boolean {
  return !mandate.revokedAt && mandateState(mandate, now) !== "expired";
}

/**
 * Live mandates first, then the most recently used, then the soonest to expire.
 *
 * Recency-of-use beats expiry because "which of these is actually doing
 * something" is the question that brought the operator here; a mandate that
 * authorised a call a minute ago is the one worth looking at, even if another
 * expires sooner.
 */
export function sortMandates<T extends AgentMandateLike>(
  mandates: readonly T[],
  now: number = Date.now(),
): T[] {
  // Array.isArray, not a nullish guard: a TRUTHY non-array payload passes
  // `?? []` at the call site and then throws here. Reachable from a restored
  // persisted cache written by an older response shape -- the route by which
  // MaintenanceBanner shipped its "windows.find is not a function" crash and
  // api-keys shipped "Invalid attempt to spread non-iterable instance".
  // Matches sortIdempotencyKeys, which already guarded this way.
  const list: readonly T[] = Array.isArray(mandates) ? mandates : [];
  return [...list].sort((a, b) => {
    const aDead = mandateIsLive(a, now) ? 0 : 1;
    const bDead = mandateIsLive(b, now) ? 0 : 1;
    if (aDead !== bDead) return aDead - bDead;
    const used = at(b.lastUsedAt) - at(a.lastUsedAt);
    if (used !== 0) return used;
    const expiry = at(a.expiresAt) - at(b.expiresAt);
    if (expiry !== 0) return expiry;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Actions and resources as one readable clause.
 *
 * Truncation is by COUNT rather than by character budget so the sentence never
 * ends mid-identifier — "campaigns:send, segments:… " reads as a bug, whereas
 * "campaigns:send, segments:write and 2 more" reads as a summary.
 */
export function mandateScopeSentence(
  mandate: AgentMandateLike,
  maxItems = 3,
): string {
  const actions = mandate.actions.filter((a) => a.trim());
  const resources = mandate.resources.filter((r) => r.trim());
  if (actions.length === 0 && resources.length === 0) {
    // A mandate with no actions cannot authorise anything, which is worth
    // saying outright rather than rendering an empty line the reader has to
    // interpret.
    return "Grants nothing — no actions or resources are listed.";
  }
  const parts: string[] = [];
  if (actions.length > 0) parts.push(`${listWithOverflow(actions, maxItems)}`);
  if (resources.length > 0) {
    parts.push(`on ${listWithOverflow(resources, maxItems)}`);
  }
  return parts.join(" ");
}

function listWithOverflow(items: readonly string[], maxItems: number): string {
  if (items.length <= maxItems) return items.join(", ");
  const shown = items.slice(0, maxItems).join(", ");
  return `${shown} and ${items.length - maxItems} more`;
}

/**
 * The consequence line for the revoke confirmation.
 *
 * Naming the last use is what makes the decision reversible in the operator's
 * head: a mandate that has never been used is almost certainly safe to kill,
 * and one that authorised something a minute ago is a live integration whose
 * owner will notice. Revocation itself cannot be undone — a new mandate must be
 * minted, and that is desk work — so the sentence says so.
 */
export function mandateRevokeConsequence(mandate: AgentMandateLike): string {
  const uses =
    mandate.usesRemaining > 0
      ? `${mandate.usesRemaining} use${mandate.usesRemaining === 1 ? "" : "s"} remaining`
      : "no uses remaining";
  return mandate.lastUsedAt
    ? `Last used at ${mandate.lastUsedAt}; ${uses}. Revoking cannot be undone — a replacement mandate must be granted from a desk.`
    : `Never used; ${uses}. Revoking cannot be undone — a replacement mandate must be granted from a desk.`;
}

/**
 * A count for the header. Only live mandates are counted: "4 mandates" when
 * three are revoked overstates how much authority is currently delegated, and
 * that number is the one thing this screen exists to make honest.
 */
export function liveMandateCount(
  mandates: readonly AgentMandateLike[],
  now: number = Date.now(),
): number {
  return mandates.filter((m) => mandateIsLive(m, now)).length;
}
