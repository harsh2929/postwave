/**
 * subscriberSelection — the policy behind long-press-to-select on the
 * subscribers list, and the three bulk verbs a phone should actually offer.
 *
 * The server mounts fourteen bulk verbs. Thirteen of them are desk work
 * (custom-field patches, merge-field patches, consent-provenance envelopes,
 * CSV export by segment). Three are the ones an operator needs while holding
 * a phone, and they are the three modelled here:
 *
 *   tag           POST /api/v1/subscribers/bulk/tag          { subscriber_ids, tag }
 *   add-to-list   POST /api/v1/subscribers/bulk/add-to-list  { subscriber_ids, list_id }
 *   unsubscribe   POST /api/v1/subscribers/bulk/unsubscribe  { subscriber_ids }
 *
 * AUTHORIZATION, read off the handler rather than the manifest: all three are
 * mounted with `apikeys.RequireScope(apikeys.ScopeAdmin)`
 * (apps/api/internal/subscribers/bulk_operations.go MountBulkRoutes). On the
 * session path ScopeAdmin is NOT in `readOnlyScopes` and NOT in
 * `editorWriteScopes` (apps/api/internal/apikeys/middleware.go:291,332), so
 * `sessionRoleAllowsScopes` admits owner|admin ONLY. An editor — who may edit
 * a single subscriber via write:subscribers — cannot run a bulk verb. That is
 * why `minimumRole` below is "admin" and not "editor": showing an editor a
 * selection bar whose every button 403s is worse than not showing it.
 *
 * REVERSIBILITY is not uniform, and the UI must not pretend it is:
 *   - tag is reversible (bulk/untag with the same ids), so it gets an undo
 *     toast and no pre-confirm.
 *   - add-to-list is idempotent and additive (ON CONFLICT DO NOTHING), so it
 *     needs neither.
 *   - unsubscribe is deliberately IRREVERSIBLE server-side — the handler
 *     comment states "restoring marketing permission requires the separately
 *     reviewed BulkResubscribe evidence flow"
 *     (apps/api/internal/subscribers/bulk_unsubscribe_safety.go:28-31). It
 *     therefore gets a typed-phrase confirm and NO undo affordance.
 *
 * Import-free (no react-native, no expo) so every rule above is unit-tested.
 */
import { num, plural } from "@/lib/format";


/**
 * Ceiling on one bulk call from a phone. The server's own cap is
 * `MaxBulkIDs = 10_000`, but a phone list materialises 25 rows a page and a
 * selection is assembled by thumb: past a few hundred the user has lost track
 * of what they picked, and the honest control is a segment on desktop. The cap
 * is enforced at SELECT time so a user is told before they have built a
 * selection they cannot submit.
 */
export const MAX_BULK_SELECTION = 500;

/** The verbs the phone surfaces. Order is the order they appear in the bar. */
export const BULK_VERBS = [
  "tag",
  "add-to-list",
  "validate",
  "unsubscribe",
] as const;
export type BulkVerb = (typeof BULK_VERBS)[number];

/** Minimum role for every verb here — see the module doc. */
export const BULK_MINIMUM_ROLE = "admin";

export interface BulkVerbSpec {
  verb: BulkVerb;
  /** Button label. */
  label: string;
  /** Spoken label; must name the count at the call site. */
  verbNoun: string;
  /** True when the server can undo it, so the UI may offer an undo. */
  reversible: boolean;
  /** True when the action needs a pre-confirm before it runs. */
  confirms: boolean;
  destructive: boolean;
}

export const BULK_VERB_SPECS: Readonly<Record<BulkVerb, BulkVerbSpec>> = {
  tag: {
    verb: "tag",
    label: "Tag",
    verbNoun: "Tag",
    reversible: true,
    confirms: false,
    destructive: false,
  },
  "add-to-list": {
    verb: "add-to-list",
    label: "Add to list",
    verbNoun: "Add to list",
    reversible: true,
    confirms: false,
    destructive: false,
  },
  // Surface validation (email-validation/check-batch): reads, writes nothing,
  // so no confirm and nothing to undo. Sits before the destructive verb so
  // "check first, act second" is the order the bar suggests.
  validate: {
    verb: "validate",
    label: "Validate",
    verbNoun: "Validate emails",
    reversible: false,
    confirms: false,
    destructive: false,
  },
  unsubscribe: {
    verb: "unsubscribe",
    label: "Unsubscribe",
    verbNoun: "Unsubscribe",
    // The server mints no recovery token for this verb.
    reversible: false,
    confirms: true,
    destructive: true,
  },
};

/* ------------------------------------------------------------------ *
 * Selection set algebra
 * ------------------------------------------------------------------ */

export interface SelectionState {
  /** Selection mode is ON. Empty + active is legal: the bar stays up. */
  active: boolean;
  ids: readonly string[];
}

export const EMPTY_SELECTION: SelectionState = { active: false, ids: [] };

/**
 * Toggle one row. Selecting past the ceiling is REFUSED rather than silently
 * truncated — a truncated selection would run the verb against a different
 * audience than the one on screen.
 */
export function toggleSelection(
  state: SelectionState,
  id: string,
): { next: SelectionState; refused: boolean } {
  if (!id) return { next: state, refused: false };
  if (state.ids.includes(id)) {
    return {
      next: { active: true, ids: state.ids.filter((x) => x !== id) },
      refused: false,
    };
  }
  if (state.ids.length >= MAX_BULK_SELECTION) {
    return { next: state, refused: true };
  }
  return { next: { active: true, ids: [...state.ids, id] }, refused: false };
}

/** Enter selection mode seeded with one row (the long-pressed one). */
export function beginSelection(id: string): SelectionState {
  return { active: true, ids: id ? [id] : [] };
}

/**
 * "Select all" over the rows currently LOADED — never over the workspace.
 * The distinction is the whole point: an infinite list holds N of M rows, and
 * a control that claims to select M while sending N ids is a lie about the
 * audience of a write. Returns `capped` so the caller can say so.
 */
export function selectAllLoaded(loadedIds: readonly string[]): {
  next: SelectionState;
  capped: boolean;
} {
  const unique: string[] = [];
  for (const id of loadedIds) {
    if (id && !unique.includes(id)) unique.push(id);
  }
  const capped = unique.length > MAX_BULK_SELECTION;
  return {
    next: { active: true, ids: unique.slice(0, MAX_BULK_SELECTION) },
    capped,
  };
}

export function isSelected(state: SelectionState, id: string | undefined) {
  return Boolean(id) && state.ids.includes(id as string);
}

/* ------------------------------------------------------------------ *
 * Availability
 * ------------------------------------------------------------------ */

export interface BulkAvailability {
  enabled: boolean;
  /**
   * Why the bar's buttons are inert. Rendered beside them — a disabled
   * control with no explanation is the defect this replaces.
   */
  reason?: string;
}

/**
 * Whether the bulk buttons may fire. Order matters: the most durable reason
 * wins, so a viewer who is also offline is told about their role (which will
 * still be true when the signal comes back) rather than the connection.
 */
export function bulkAvailability(input: {
  count: number;
  /** canAccessMinimumRole("admin", role, mode) — see module doc. */
  hasAdminRole: boolean;
  online: boolean;
  /** True when the session is cached/stale and must not issue writes. */
  gated: boolean;
}): BulkAvailability {
  if (!input.hasAdminRole) {
    return {
      enabled: false,
      reason:
        "Bulk actions need an owner or admin role. Your role can still edit one subscriber at a time.",
    };
  }
  if (input.gated) {
    return {
      enabled: false,
      reason: "Reconnect this session before running a bulk action.",
    };
  }
  if (!input.online) {
    return {
      enabled: false,
      // Deliberately not queued offline: a bulk write resolved against a
      // stale selection is the wrong audience, not a delayed one.
      reason: "You're offline. Bulk actions aren't queued — they need a connection.",
    };
  }
  if (input.count === 0) {
    return { enabled: false, reason: "Select at least one subscriber." };
  }
  return { enabled: true };
}

/* ------------------------------------------------------------------ *
 * Copy
 * ------------------------------------------------------------------ */

function counted(count: number, singular: string): string {
  return plural(count, singular);
}

/** The bar's title, and the string VoiceOver reads when selection changes. */
export function selectionTitle(count: number): string {
  return count === 0 ? "Select subscribers" : `${counted(count, "subscriber")} selected`;
}

/** Announced when the ceiling refuses another row. */
export function selectionCapMessage(): string {
  return `You can select up to ${num(MAX_BULK_SELECTION)} subscribers at once. Use a segment on the web admin for anything larger.`;
}

export interface BulkConfirmCopy {
  title: string;
  message: string;
  confirmLabel: string;
  consequence: string;
  /** Typed-phrase gate, or undefined when the verb does not need one. */
  confirmPhrase?: string;
  destructive: boolean;
}

/**
 * Confirm copy for the verbs that need one. `unsubscribe` gates on a typed
 * phrase because it cannot be undone from this app at all — the reversal path
 * is a separate reviewed-evidence flow on the server.
 */
export function bulkConfirmCopy(
  verb: BulkVerb,
  count: number,
): BulkConfirmCopy | null {
  if (verb !== "unsubscribe") return null;
  return {
    title: `Unsubscribe ${counted(count, "subscriber")}?`,
    message:
      "They stop receiving marketing email immediately. This app cannot undo it — restoring permission needs the reviewed consent flow on the web admin.",
    confirmLabel: "Unsubscribe",
    consequence: `${counted(count, "person")} will be marked unsubscribed.`,
    confirmPhrase: "UNSUBSCRIBE",
    destructive: true,
  };
}

/**
 * The wire result of a bulk verb. Every field is optional because a server
 * that answered 200 with an unexpected body must not be reported as "0
 * affected" — absence is not zero.
 */
export interface BulkResultWire {
  affected?: number;
  skipped?: number;
  source?: string;
  exclusions?: Record<string, number>;
}

/**
 * The receipt. `skipped` is surfaced verbatim rather than folded into
 * `affected`: the server skips ids that are missing or outside the tenant,
 * and quietly reporting them as done is how a user comes to believe a write
 * landed on rows it never touched.
 */
export function bulkResultMessage(
  verb: BulkVerb,
  result: BulkResultWire | null | undefined,
  requested: number,
): string {
  const spec = BULK_VERB_SPECS[verb];
  const past =
    verb === "tag"
      ? "tagged"
      : verb === "add-to-list"
        ? "added"
        : verb === "validate"
          ? "checked" // validate reports through its own sheet, not this path
          : "unsubscribed";
  if (!result || typeof result.affected !== "number") {
    // Absence is not zero: say what we asked for, not what we cannot prove.
    return `${spec.label} sent for ${counted(requested, "subscriber")}.`;
  }
  const base = `${counted(result.affected, "subscriber")} ${past}`;
  const skipped =
    typeof result.skipped === "number" && result.skipped > 0
      ? ` · ${num(result.skipped)} skipped`
      : "";
  return `${base}${skipped}`;
}
