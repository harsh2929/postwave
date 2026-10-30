/**
 * Duplicates — the candidate-pair review queue.
 *
 * MONITOR PLUS ONE VERB, AND THE VERB IS THE POINT. Everything about DEFINING
 * duplicates stays on the desktop: the confidence threshold, the merge-field
 * schema, the bulk-select toolbar in `apps/desktop/src/components/subscribers/
 * DuplicatesModal.tsx` (1,084 lines). A phone is the wrong device for deciding
 * what counts as the same person. Approving one pair the server has already
 * justified is not — it is one decision with two named outcomes, which is the
 * shape a phone is best at.
 *
 * TWO ROUTES, TWO FLOORS, BOTH READ OFF BOTH GUARDS.
 *   READ  `GET /api/v1/subscribers/duplicates` and `.../duplicate-scans/{id}/
 *         pairs` — `RequireScope(ScopeReadReports)` (subscriber_dedupe.go:
 *         34-39), a read-only scope that admits any session role, and
 *         `session_minimum_role: viewer` in the generated manifest. VIEWER.
 *   MERGE `POST /api/v1/merge/apply` — `RequireScope(ScopeWriteSubscribers)`
 *         (merge/handlers.go:39-40), which on the session path would admit an
 *         EDITOR, but the manifest row is `session_minimum_role: admin` and
 *         `routeauth.Middleware` evaluates it independently
 *         (routeauth/middleware.go:60-66). OWNER/ADMIN — the stricter guard
 *         decides, so the screen is readable by everyone and mergeable by
 *         admins, and it says which permission is missing rather than
 *         rendering a button that can only 403.
 *
 * WHY `/merge/apply` AND NOT `/api/v1/subscribers/merge`. The latter demands
 * `primary_version` + `duplicate_version` and answers 428 without them
 * (subscribers/merge.go:126-129); the scan carries `updated_at` instants, not
 * revisions, so a phone would have to re-read both records first and race the
 * write it is about to make. `/merge/apply` binds to the scan's own instants
 * (apply.go:269-299) and returns a fingerprinted dry-run plan the real apply
 * must replay — which is also what lets the confirmation state what will
 * happen to these two people instead of describing merges in general.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { DuplicatesScreen } from "@/components/duplicates/DuplicatesScreen";

/**
 * Route-scoped boundary. This screen renders arbitrary custom-field values
 * inside the conflict list, so an unexpected shape must cost this tab and not
 * the whole app shell.
 */
export { AppErrorBoundary as ErrorBoundary };

export default function SubscriberDuplicates() {
  return <DuplicatesScreen />;
}
