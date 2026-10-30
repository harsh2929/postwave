// SPDX-License-Identifier: AGPL-3.0-only
//
// Counsel approval for publishing the /legal/* drafts.
//
// Published deployments keep unapproved legal pages unavailable (see
// `(marketing)/legal/layout.tsx`). Local development can show labeled drafts
// on loopback hosts without granting approval to publish them.
//
// The problem the compliance audit found is not the gate, it is that the gate
// stands alone. The surfaces that LINK into /legal are not gated at all:
//
//   * the cookie banner's "Cookie Policy" link  → /legal/cookies
//   * the marketing footer's seven legal links
//   * the sign-in / sign-up shell's Terms and Privacy links
//   * the docs and forge layouts
//
// So the moment `POSTWAVE_PUBLIC_RELEASE_APPROVAL` is set, the site becomes
// indexable and public while every one of those links returns 404 — including
// the one a visitor follows to decide whether to accept cookies. GDPR Art.
// 4(11) and Art. 7 require consent to be *informed*, and ePrivacy Art. 5(3)
// consent inherits that standard; a notice whose policy link is a 404 does not
// inform anyone. A visitor's acceptance would still be collected and written to
// the server consent ledger.
//
// Two independent publication gates that must agree, with nothing enforcing
// agreement, is the actual defect. This module makes the legal gate an explicit
// approval record with the same shape as `public-release.ts`, so the two can be
// compared — see `assertPublicationGatesAgree` and the contract test.

const APPROVAL_PREFIX = "approved:";
const MIN_REFERENCE_LENGTH = 6;

/**
 * Return the counsel-approval reference for publishing the legal pages, or
 * null. Fail-closed by default, exactly like the public-release approval:
 * drafts existing in the repo is not evidence that counsel has cleared them.
 */
export function legalPublicationApprovalReference(
  raw = process.env.POSTWAVE_LEGAL_PUBLICATION_APPROVAL,
): string | null {
  const value = raw?.trim() ?? "";
  if (!value.startsWith(APPROVAL_PREFIX)) return null;
  const reference = value.slice(APPROVAL_PREFIX.length).trim();
  return reference.length >= MIN_REFERENCE_LENGTH ? reference : null;
}

export function legalPublicationApproved(
  raw = process.env.POSTWAVE_LEGAL_PUBLICATION_APPROVAL,
): boolean {
  return legalPublicationApprovalReference(raw) !== null;
}

/** Read existing drafts during local QA without granting publication approval. */
export function legalDraftPreviewAllowed(
  host: string | null | undefined,
  environment: string | undefined = process.env.NODE_ENV,
): boolean {
  if (environment !== "development" || !host) return false;

  const match = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/i.exec(
    host,
  );
  if (!match) return false;
  if (!match[1]) return true;
  const port = Number(match[1]);
  return port > 0 && port <= 65_535;
}

/**
 * The coupling invariant: the public site may not be published while the legal
 * pages it links to are unreachable.
 *
 * Returns an operator-facing explanation when the configuration is
 * contradictory, or null when it is coherent. The reverse direction is
 * deliberately allowed — legal approved while the site is still private is the
 * normal order of operations, and reviewing the pages before launch is exactly
 * what should happen.
 */
export function publicationGateConflict(
  releaseApproved: boolean,
  legalApproved: boolean,
): string | null {
  if (releaseApproved && !legalApproved) {
    return (
      "POSTWAVE_PUBLIC_RELEASE_APPROVAL is set but " +
      "POSTWAVE_LEGAL_PUBLICATION_APPROVAL is not. Publishing the site while " +
      "/legal/* returns 404 leaves the cookie banner, the marketing footer, " +
      "and the sign-in screens linking to missing policies, so consent " +
      "collected through the banner would not be informed. Approve the legal " +
      "pages or keep the site private."
    );
  }
  return null;
}
