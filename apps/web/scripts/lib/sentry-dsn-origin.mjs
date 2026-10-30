// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Extract the HTTPS ingest origin from a browser Sentry DSN for CSP.
 *
 * A normal Sentry DSN carries its public key in the URL username
 * (`https://public-key@host/project`). Generic configured-origin helpers
 * intentionally reject all userinfo, so using one for a DSN silently drops
 * the ingest host from connect-src. The public key is safe to accept, but a
 * password is not. Returning URL.origin guarantees no userinfo, project path,
 * query string, or fragment reaches the policy.
 */
export function sentryDsnOrigin(rawValue) {
  if (!rawValue) return null;
  try {
    const value = new URL(rawValue);
    if (value.protocol !== "https:" || value.password) return null;
    return value.origin;
  } catch {
    return null;
  }
}
