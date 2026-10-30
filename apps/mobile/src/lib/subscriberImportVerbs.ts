/**
 * lib/subscriberImportVerbs.ts — WHEN the phone may confirm or cancel an
 * import job, and what it says while doing it. Import-free (no React Native),
 * so the whole decision table runs in the node vitest environment.
 *
 * WHY THIS IS A SEPARATE MODULE FROM THE PARSER. Reading a job is a shape
 * problem; deciding whether a verb is legal is a POLICY problem, and this
 * particular policy is unusually load-bearing because the server's Confirm
 * handler is one of the strictest in the codebase. It refuses, with a 409, when
 * any of these is true (subscriber_import.go::Confirm):
 *
 *   - the row is not in `preview`                    → not_in_preview
 *   - `source_fingerprint` is empty or a legacy scheme → source_fingerprint_missing
 *   - the exhaustive preflight is missing/mismatched  → preflight_required
 *   - `preflight_expires_at` is in the past           → preflight_expired
 *   - subscriber or custom-field state moved since it → preflight_required
 *   - `on_existing` is not skip|update|error          → invalid_on_existing
 *   - the consent contract is partial                 → invalid_consent_contract
 *
 * A phone cannot FIX any of those — every one of them is repaired by re-running
 * the preflight in the desktop wizard against the uploaded bytes. So the honest
 * mobile behaviour is to detect the ones that are visible in `GET /{id}` and
 * refuse locally with the real reason, rather than firing a POST that is
 * already known to fail and surfacing a raw 409 code.
 *
 * Cancel is the opposite shape and that is why it is worth having on a phone:
 * `Deps.Cancel` accepts exactly `status IN ('queued','running')` and answers
 * 409 `not_cancellable` for anything else. Nothing about a phone makes that
 * decision worse, and "stop the import that is chewing through the wrong file"
 * is the archetypal away-from-desk emergency.
 */
import {
  isActiveImport,
  type SubscriberImportJob,
  type SubscriberImportJobDetail,
} from "@/lib/subscriberImportJobs";

export interface SubscriberImportAccess {
  /** May the LIST read be attempted at all. */
  canRead: boolean;
  /** May confirm / cancel be offered. */
  canWrite: boolean;
  /** Why not, as a full sentence, or null when nothing is withheld. */
  notice: string | null;
}

/**
 * Who may use this surface — READS INCLUDED.
 *
 * This is the unusual bit and it is the reason the policy is a tested function
 * rather than an inline `isAdmin &&`. `subscriber_import.go::MountRoutes` opens
 * with `admin := apikeys.RequireScope(apikeys.ScopeAdmin)` and wraps every
 * route in it, the GET list included. `ScopeAdmin` is absent from
 * `readOnlyScopes`, so `RequireScope` runs its session role check, and
 * `sessionRoleAllowsScopes` admits owner|admin only — `editor` is allowed just
 * `write:subscribers` / `write:campaigns`. Running the real middleware per role
 * confirms it: viewer, member and editor all receive
 * `403 insufficient_role` on `GET /api/v1/subscriber-imports`.
 *
 * The generated `routeauth/manifest.json` claims `session_minimum_role:
 * "viewer"` for that route. It is wrong. Gating the LIST here means a viewer
 * gets a sentence instead of a broken screen.
 *
 * API-KEY MODE IS DENIED, and not because the key necessarily lacks the scope.
 * The mobile login response never exposes an API key's scopes, and these routes
 * need the literal `admin` scope (`read:subscribers` is refused — the same run
 * shows `403 insufficient_scope`). Guessing "probably allowed" would render a
 * Confirm button whose only possible outcome is a 403 on the most consequential
 * write this app can issue.
 */
export function subscriberImportAccess(options: {
  isAdmin: boolean;
  mode: "api_key" | "session" | null;
  online: boolean;
}): SubscriberImportAccess {
  if (options.mode === "api_key") {
    return {
      canRead: false,
      canWrite: false,
      notice:
        "Import jobs need an API key with the admin scope, and this app can't see which scopes your key carries. Sign in with your workspace account to manage imports.",
    };
  }
  if (!options.isAdmin) {
    return {
      canRead: false,
      canWrite: false,
      notice:
        "Import jobs are admin-only on this workspace — the server requires the admin scope to even list them. Ask an owner or admin, or open the import wizard on desktop.",
    };
  }
  if (!options.online) {
    return {
      canRead: true,
      canWrite: false,
      notice:
        "You're offline. Import jobs aren't cached, and confirming or stopping one is never queued for later.",
    };
  }
  return { canRead: true, canWrite: true, notice: null };
}

/**
 * Cancel is legal for `queued` and `running` only. A row whose cancellation
 * was ALREADY requested is excluded: the flag is idempotent server-side, but
 * offering the button again implies the first press did not take.
 */
export function canCancelImport(
  job: Pick<SubscriberImportJob, "status" | "cancelRequested">,
): boolean {
  return isActiveImport(job.status) && !job.cancelRequested;
}

export interface ConfirmGate {
  allowed: boolean;
  /** Why not — a full sentence for the operator, or null when allowed. */
  reason: string | null;
}

/**
 * Whether `POST /{id}/confirm` can succeed, judged from the detail payload.
 *
 * `preflight_required` is computed server-side as
 * `status == "preview" && !classification_authoritative` (subscriber_import.go
 * :1626), and `classification_authoritative` folds in the source fingerprint,
 * the preflight fingerprint match, the row-count match AND the expiry. So the
 * two flags together are the same predicate the handler will apply moments
 * later — this is not a guess at the server's mind, it is the server's own
 * published verdict.
 */
export function confirmGate(
  job: SubscriberImportJobDetail | null,
  options: { canWrite: boolean; online: boolean; now?: number },
): ConfirmGate {
  const now = options.now ?? Date.now();
  if (!job) return { allowed: false, reason: null };
  if (job.status.trim().toLowerCase() !== "preview") {
    return {
      allowed: false,
      reason: "Only a staged import can be confirmed.",
    };
  }
  if (!options.canWrite) {
    return {
      allowed: false,
      reason:
        "Confirming an import needs an admin role on this workspace. Ask an admin, or run it from the desktop app.",
    };
  }
  if (!options.online) {
    return {
      allowed: false,
      reason:
        "You're offline. An import is never queued to send later — the file it reads may have changed by then.",
    };
  }
  if (!job.sourceFingerprint) {
    return {
      allowed: false,
      reason:
        "This preview isn't bound to the uploaded file. Upload it again in the desktop import wizard.",
    };
  }
  if (job.preflightRequired || !job.classificationAuthoritative) {
    return {
      allowed: false,
      reason:
        "This import needs a fresh preflight before it can run. The preflight re-reads the whole file against current subscribers, and only the desktop import wizard can do it.",
    };
  }
  if (
    job.preflightExpiresAt !== null &&
    Date.parse(job.preflightExpiresAt) <= now
  ) {
    return {
      allowed: false,
      reason:
        "The preflight for this import has expired. Re-run it in the desktop import wizard.",
    };
  }
  if (job.consentContractState === "incomplete") {
    return {
      allowed: false,
      reason:
        "The consent evidence on this import is incomplete. Finish or clear it in the desktop import wizard.",
    };
  }
  return { allowed: true, reason: null };
}

export interface ImportConfirmCopy {
  title: string;
  message: string;
  consequence: string;
  confirmLabel: string;
  destructive: boolean;
}

/**
 * Confirming is not reversible by any endpoint this app has: the worker starts
 * writing subscribers and the only lever afterwards is Cancel, which stops it
 * partway rather than undoing it. That is exactly the shape ConfirmSheet exists
 * for, and exactly the shape an undo toast would lie about.
 */
export function confirmImportCopy(
  job: SubscriberImportJobDetail,
  describeRows: (value: number | null) => string,
): ImportConfirmCopy {
  const onExisting = job.onExisting.trim().toLowerCase();
  return {
    title: `Import ${job.filename}?`,
    message:
      "The import worker starts writing subscribers immediately. Cancelling later stops it partway — rows already written stay written.",
    consequence:
      onExisting === "update"
        ? `${describeRows(job.rowsTotal)} rows will be processed, and subscribers who already exist will be OVERWRITTEN with this file's values.`
        : onExisting === "error"
          ? `${describeRows(job.rowsTotal)} rows will be processed, and any row matching an existing subscriber fails the import.`
          : `${describeRows(job.rowsTotal)} rows will be processed. Existing subscribers are left untouched.`,
    confirmLabel: "Start import",
    destructive: onExisting === "update",
  };
}

export function cancelImportCopy(
  job: SubscriberImportJob,
  describeRows: (value: number | null) => string,
): ImportConfirmCopy {
  const running = job.status.trim().toLowerCase() === "running";
  return {
    title: `Stop importing ${job.filename}?`,
    message: running
      ? "The worker stops between chunks. Subscribers already imported are NOT removed — this stops the rest, it does not undo what ran."
      : "This import hasn't started yet, so stopping it writes nothing at all.",
    consequence: running
      ? `${describeRows(job.rowsImported)} subscribers have already been written and will stay.`
      : "Nothing has been written yet.",
    confirmLabel: "Stop import",
    destructive: true,
  };
}

export function cancelSuccessMessage(job: SubscriberImportJob): string {
  return job.status.trim().toLowerCase() === "running"
    ? `Stopping ${job.filename}. The worker finishes its current chunk first.`
    : `Cancelled ${job.filename}.`;
}

export function confirmSuccessMessage(job: SubscriberImportJob): string {
  return `${job.filename} is queued. Progress updates here while it runs.`;
}

/**
 * Turn the server's machine-readable 409 code into a sentence. Every code below
 * is written by a `writeJSONErr` call in subscriber_import.go; anything else
 * falls through to the server's own message, which is never a raw internal
 * error (5xx bodies go through httperror.WriteInternal and carry no detail).
 */
/**
 * The sentence a failed verb shows, from a thrown error alone.
 *
 * Import-free on purpose: `codeFromError`/`statusFromError` live in
 * `api/request`, which transitively pulls the SDK and so cannot be imported by
 * a node vitest file. The two properties are read structurally here instead,
 * which is exactly what those helpers do (`checkedApiResult` re-tags `.status`
 * and `.code` onto the Error it throws).
 *
 * STATUS IS CHECKED BEFORE CODE for the three cases where the code is absent or
 * uninformative — a 401 carries no envelope worth quoting, and a network
 * failure has neither.
 */
export function subscriberImportErrorMessage(error: unknown): string {
  const shape = (error ?? {}) as { status?: unknown; code?: unknown };
  const status = typeof shape.status === "number" ? shape.status : 0;
  const code = typeof shape.code === "string" ? shape.code : undefined;
  if (status === 401) return "Your session expired. Sign in again.";
  if (status === 403) {
    return "Import jobs need an admin role on this workspace, and yours no longer has it.";
  }
  if (status === 404) return "That import no longer exists.";
  if (status === 0 && !code) {
    return "The request didn't reach the server. Check your connection and try again.";
  }
  const fallback =
    error instanceof Error && error.message ? error.message : "Please try again.";
  return importVerbErrorMessage(code, fallback);
}

export function importVerbErrorMessage(
  code: string | undefined,
  fallback: string,
): string {
  switch ((code ?? "").trim()) {
    case "not_cancellable":
      return "This import already finished, so there's nothing left to stop.";
    case "not_in_preview":
      return "This import is no longer staged — someone may have confirmed or cancelled it already.";
    case "preflight_required":
    case "preflight_stale":
      return "Subscriber or custom-field state changed since this import was reviewed. Run a fresh preflight in the desktop import wizard.";
    case "preflight_expired":
      return "The preflight for this import expired. Re-run it in the desktop import wizard.";
    case "preflight_has_conflicts":
      return "This import is set to fail on existing subscribers, and the preflight found some. Change the strategy on desktop.";
    case "source_fingerprint_missing":
    case "source_fingerprint_mismatch":
      return "The uploaded file no longer matches the one that was reviewed. Upload it again on desktop.";
    case "invalid_consent_contract":
      return "The consent evidence on this import is incomplete. Finish or clear it on desktop.";
    case "confirmation_snapshot_stale":
      return "The import's settings changed while you were looking at it. Reload and try again.";
    case "invalid_on_existing":
      return "This import's existing-subscriber strategy is invalid. Fix it on desktop.";
    case "storage_unavailable":
      return "Import storage is temporarily unavailable. Try again shortly.";
    case "invalid_csv":
      return "The uploaded file is no longer valid CSV.";
    default:
      return fallback;
  }
}
