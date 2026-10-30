/**
 * Map an API error code from POST /api/v1/approvals/{id}/decision to
 * a user-facing toast message. Unrecognised codes use bounded local copy;
 * backend messages can contain reflected notes, resource identifiers, or
 * implementation detail and must never reach an operator surface.
 *
 * Codes pinned here:
 *   - self_approval (403)      — two-person rule; the requester
 *                                tried to decide their own approval.
 *   - token_already_used (409) — public one-click link replayed;
 *                                only surfaces on the public decide
 *                                path in practice, but kept here so
 *                                the dashboard helper is one source
 *                                of truth for approvals errors.
 *   - not_pending (409)        — already decided by someone else
 *                                between page load and click.
 *   - expired (410)            — TTL elapsed.
 *   - forbidden (403)          — admin-role gate.
 *
 * Extracted from Approvals.tsx so it can be unit-tested without a
 * JSX-aware test transform (the test env loads .ts cleanly but
 * .tsx requires a JSX plugin).
 */
export function decisionErrorMessage(
  decision: "approve" | "reject",
  code: string | undefined,
  _serverMessage?: unknown,
  requestReference?: unknown,
): string {
  const verb = decision === "approve" ? "Approve" : "Reject";
  switch (code) {
    case "self_approval":
      return "You can't decide an approval you requested. Ask another owner or admin to review.";
    case "token_already_used":
      return "This approval link has already been used. Open the approvals list to see the current status.";
    case "not_pending":
      return "Already decided by someone else — refreshing the list.";
    case "expired":
      return "This approval expired. The requester needs to re-submit it.";
    case "forbidden":
      return "You need owner or admin role to decide approvals.";
    default: {
      const safeReference =
        typeof requestReference === "string" &&
        requestReference.length > 0 &&
        requestReference.length <= 96 &&
        /^[A-Za-z0-9._:-]+$/u.test(requestReference)
          ? requestReference
          : null;
      return `${verb} failed. The approval service could not complete the decision.${safeReference ? ` Reference: ${safeReference}.` : ""}`;
    }
  }
}
