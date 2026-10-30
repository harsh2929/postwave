// SPDX-License-Identifier: AGPL-3.0-only
//
// Client-side hostname validation for the custom-domain add form (SETC-017),
// so a URL or bare word is caught inline instead of round-tripping to the
// server for a generic rejection.

/**
 * True when `input` is a plausible DNS hostname (e.g. `newsletter.example.com`
 * or `example.co.uk`). Rejects URLs, ports, paths, credentials, whitespace,
 * and single-label names with no TLD. Case-insensitive.
 */
export function isValidHostname(input: string): boolean {
  const host = input.trim().toLowerCase();
  if (!host || host.length > 253) return false;
  // Reject anything carrying scheme/port/path/query/fragment/credentials.
  if (/[\s/@:?#]/.test(host)) return false;
  const labels = host.split(".");
  // A usable sending/custom domain needs at least a domain + TLD.
  if (labels.length < 2) return false;
  const labelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (!labels.every((label) => labelPattern.test(label))) return false;
  // The TLD must be alphabetic and at least two characters.
  const tld = labels[labels.length - 1];
  return /^[a-z]{2,}$/.test(tld);
}
