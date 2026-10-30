/**
 * suppressionSelection — the policy behind multi-select on the suppressions
 * list and the ONE bulk verb a phone should offer there.
 *
 * The workflow this exists for: forty bounced addresses land after a bad
 * import and the operator has to release the ones that were collateral. Doing
 * that one swipe at a time is forty round trips; desktop has had
 * `useSuppressionSelection` + a BulkActionsMenu since the A4 audit.
 *
 * WHY ONLY ONE VERB. The server mounts three bulk routes
 * (apps/api/internal/suppressions/bulk.go MountX1BulkRoutes):
 *
 *   POST /api/v1/suppressions/bulk-import  — needs a pasted CSV; desk work.
 *   POST /api/v1/suppressions/bulk-action  — multiplexes delete /
 *        change_reason / export. `change_reason` is a compliance edit that
 *        wants the full reason taxonomy and an audit narrative, and `export`
 *        already has a header button on this screen.
 *   POST /api/v1/suppressions/bulk-delete  — release the selected addresses.
 *
 * Only the last is a phone action, so it is the only one modelled here.
 *
 * AUTHORIZATION, read off the mount and not the manifest: main.go:3369 wraps
 * MountX1BulkRoutes in `apikeys.RequireScope(apikeys.ScopeAdmin)`. ScopeAdmin
 * is NOT in `readOnlyScopes` and NOT in `editorWriteScopes`
 * (apps/api/internal/apikeys/middleware.go), so `sessionRoleAllowsScopes`
 * admits owner|admin ONLY — the same boundary the screen's existing swipe-to-
 * un-suppress already uses (`canAccessMinimumRole("admin", …)`).
 *
 * REVERSIBILITY IS PARTIAL, AND THE RECEIPT MUST SAY SO. The handler drops
 * rows whose reason is not reversible (hard bounce, DSAR deletion) and returns
 * them under `blocked`, alongside `deleted_count` and per-row `errors`.
 * Folding those into a single "40 released" is the exact way a user comes to
 * believe a compliance write landed on rows it never touched.
 *
 * The generic set algebra (toggle / select-all / ceiling) is reused from
 * src/lib/subscriberSelection.ts rather than duplicated: it is entity-
 * agnostic, already unit-tested, and two divergent implementations of a
 * selection ceiling is how one of them silently truncates.
 *
 * Import-free so every rule above is unit-tested.
 */
import { MAX_BULK_SELECTION } from "@/lib/subscriberSelection";
import { num, plural } from "@/lib/format";

export {
  beginSelection,
  EMPTY_SELECTION,
  isSelected,
  selectAllLoaded,
  toggleSelection,
  type SelectionState,
} from "@/lib/subscriberSelection";

/**
 * The server's own per-request ceiling is `bulkActionMaxIDs` = 500
 * ("max 500 identifiers per request", validateBulkSelection in bulk.go), and
 * MAX_BULK_SELECTION is already 500 — so the phone cap and the server cap
 * agree and a selection built here can always be submitted in one call.
 */
export const MAX_SUPPRESSION_SELECTION = MAX_BULK_SELECTION;

export interface SuppressionBulkAvailability {
  enabled: boolean;
  /** Rendered as visible text beside the button, not only as a dim state. */
  reason?: string;
}

/**
 * Whether the Release button may fire. Ordering mirrors `bulkAvailability`:
 * the most durable reason wins, so a viewer who is also offline hears about
 * their role — which will still be true when the signal returns.
 */
export function suppressionBulkAvailability(input: {
  count: number;
  /** canAccessMinimumRole("admin", role, mode). */
  hasAdminRole: boolean;
  online: boolean;
  /** True when the session is restored-but-unvalidated. */
  gated: boolean;
}): SuppressionBulkAvailability {
  if (!input.hasAdminRole) {
    return {
      enabled: false,
      reason:
        "Releasing suppressions needs an owner or admin role. You can still see why each address is suppressed.",
    };
  }
  if (input.gated) {
    return {
      enabled: false,
      reason: "Reconnect this session before releasing suppressions.",
    };
  }
  if (!input.online) {
    return {
      enabled: false,
      // Never queued: a compliance write resolved against a stale selection
      // is the wrong set of people, not a delayed one.
      reason:
        "You're offline. Releasing suppressions isn't queued — it needs a connection.",
    };
  }
  if (input.count === 0) {
    return { enabled: false, reason: "Select at least one address." };
  }
  return { enabled: true };
}

/**
 * `${n} address` / `${n} addresses`. The plural is passed EXPLICITLY rather
 * than appending "s": the noun on this screen is "address", and the naive
 * rule produced "3 addresss" in the confirm dialog of a destructive verb.
 */
function counted(count: number, singular: string, pluralForm: string): string {
  return plural(count, singular, pluralForm);
}

/** The bar's title, and what VoiceOver reads as the selection changes. */
export function suppressionSelectionTitle(count: number): string {
  return count === 0
    ? "Select addresses"
    : `${counted(count, "address", "addresses")} selected`;
}

/** Announced when the ceiling refuses another row. */
export function suppressionCapMessage(): string {
  return `You can select up to ${num(MAX_SUPPRESSION_SELECTION)} addresses at once — the server's own per-request limit.`;
}

export interface SuppressionBulkConfirmCopy {
  title: string;
  message: string;
  confirmLabel: string;
  consequence: string;
  confirmPhrase: string;
  destructive: boolean;
}

/**
 * The pre-confirm.
 *
 * Releasing suppressions is the one write on this screen that resumes sending
 * to real people, and at bulk scale a mis-tap resumes sending to hundreds. The
 * single-row swipe stays a reversible undo-toast (re-adding is one POST); the
 * bulk verb gets a typed phrase, because the undo for four hundred rows is
 * four hundred POSTs this app will not issue.
 */
export function suppressionBulkConfirmCopy(
  count: number,
): SuppressionBulkConfirmCopy {
  return {
    title: `Release ${counted(count, "address", "addresses")}?`,
    message:
      "Moosewave can send to them again from now on. Addresses suppressed for a reason the server treats as final — hard bounces, deletion requests — are skipped and listed afterwards.",
    confirmLabel: "Release",
    consequence: `${counted(count, "person", "people")} become mailable again.`,
    confirmPhrase: "RELEASE",
    destructive: true,
  };
}

/**
 * The wire result of POST /api/v1/suppressions/bulk-delete. Every field is
 * optional because a 200 with an unexpected body must not be reported as
 * "0 released" — absence is not zero.
 */
export interface SuppressionBulkResultWire {
  deleted_count?: number;
  errors?: string[];
  blocked?: string[];
}

export interface SuppressionBulkResult {
  released: number | null;
  blocked: string[];
  errors: string[];
}

export function parseSuppressionBulkResult(
  raw: unknown,
): SuppressionBulkResult {
  const row = (raw ?? {}) as SuppressionBulkResultWire;
  const released =
    typeof row.deleted_count === "number" && Number.isFinite(row.deleted_count)
      ? row.deleted_count
      : null;
  return {
    released,
    blocked: Array.isArray(row.blocked)
      ? row.blocked.filter((x): x is string => typeof x === "string")
      : [],
    errors: Array.isArray(row.errors)
      ? row.errors.filter((x): x is string => typeof x === "string")
      : [],
  };
}

/**
 * The receipt.
 *
 * `blocked` and `errors` are surfaced VERBATIM as counts rather than folded
 * into the released figure. A user who asked for forty and got thirty-seven
 * needs to know that three are still suppressed, and why the server said so.
 */
export function suppressionBulkResultMessage(
  result: SuppressionBulkResult | null,
  requested: number,
): string {
  if (!result || result.released == null) {
    // Say what we asked for, not what we cannot prove.
    return `Release sent for ${counted(requested, "address", "addresses")}.`;
  }
  const parts = [`${counted(result.released, "address", "addresses")} released`];
  if (result.blocked.length > 0) {
    parts.push(
      `${num(result.blocked.length)} can't be released (the server treats their reason as final)`,
    );
  }
  if (result.errors.length > 0) {
    parts.push(`${num(result.errors.length)} failed`);
  }
  return parts.join(" · ");
}
