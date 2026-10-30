// SPDX-License-Identifier: AGPL-3.0-only

import { redactPath } from "@postwave/telemetry";

function scrubURL(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    // Secrets also live in PATH segments — the preference-center capability
    // token (/{locale}/preferences/<token>) is a bearer URL, so a violation
    // report from that page would otherwise log a working credential.
    const path = redactPath(url.pathname);
    if (path === url.pathname) return url.toString().slice(0, 1_024);
    // `[redacted]` would be percent-encoded by the pathname setter, so
    // reassemble by hand (same reconstruction redactUrl() uses). Opaque
    // origins (data:, blob:) report `origin === "null"`; for those the
    // serialization is scheme + path.
    const prefix = url.origin === "null" ? url.protocol : url.origin;
    return `${prefix}${path}`.slice(0, 1_024);
  } catch {
    const path = value.split(/[?#]/, 1)[0];
    return path === undefined ? undefined : redactPath(path).slice(0, 1_024);
  }
}

function safeString(value: unknown, max = 256): string | undefined {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

export function sanitizeCSPReport(input: unknown): Record<string, unknown>[] {
  const reports = Array.isArray(input) ? input : [input];
  return reports.slice(0, 20).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const wrapper = entry as Record<string, unknown>;
    const raw =
      wrapper["csp-report"] && typeof wrapper["csp-report"] === "object"
        ? (wrapper["csp-report"] as Record<string, unknown>)
        : wrapper.body && typeof wrapper.body === "object"
          ? (wrapper.body as Record<string, unknown>)
          : wrapper;
    return [
      {
        document_uri: scrubURL(raw["document-uri"] ?? raw.documentURL),
        blocked_uri: scrubURL(raw["blocked-uri"] ?? raw.blockedURL),
        source_file: scrubURL(raw["source-file"] ?? raw.sourceFile),
        effective_directive: safeString(
          raw["effective-directive"] ?? raw.effectiveDirective,
        ),
        violated_directive: safeString(
          raw["violated-directive"] ?? raw.violatedDirective,
        ),
        disposition: safeString(raw.disposition, 32),
        status_code:
          typeof raw["status-code"] === "number"
            ? raw["status-code"]
            : typeof raw.statusCode === "number"
              ? raw.statusCode
              : undefined,
      },
    ];
  });
}
