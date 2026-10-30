// SPDX-License-Identifier: AGPL-3.0-only

const APPROVAL_PREFIX = "approved:";
const MIN_REFERENCE_LENGTH = 6;

/**
 * Return the release-record reference only when the public-site launch has
 * been explicitly approved. The default is deliberately closed: source being
 * deployed is not evidence that legal, product, provider, and operations
 * qualification has finished.
 */
export function publicReleaseApprovalReference(
  raw = process.env.POSTWAVE_PUBLIC_RELEASE_APPROVAL,
): string | null {
  const value = raw?.trim() ?? "";
  if (!value.startsWith(APPROVAL_PREFIX)) return null;
  const reference = value.slice(APPROVAL_PREFIX.length).trim();
  return reference.length >= MIN_REFERENCE_LENGTH ? reference : null;
}

export function publicReleaseApproved(
  raw = process.env.POSTWAVE_PUBLIC_RELEASE_APPROVAL,
): boolean {
  return publicReleaseApprovalReference(raw) !== null;
}
