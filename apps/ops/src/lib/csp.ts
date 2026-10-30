// SPDX-License-Identifier: AGPL-3.0-only

const CSP_NONCE = /^[A-Za-z0-9+/_=-]{16,128}$/u;

export function contentSecurityPolicy(nonce: string, development = false): string {
  if (!CSP_NONCE.test(nonce)) throw new Error("invalid CSP nonce");
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
  ].join("; ");
}
