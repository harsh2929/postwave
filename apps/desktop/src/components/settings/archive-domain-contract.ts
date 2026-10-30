import type { ArchiveCustomDomainStatus } from "../../lib/api-client";

const DOMAIN_STATES = new Set(["pending", "verified", "failed"]);
const SSL_STATES = new Set(["pending", "issuing", "issued", "failed"]);

const optionalString = (value: unknown): boolean =>
  value === undefined || typeof value === "string";

/** Validate the successful JSON envelope before Settings renders it. */
export function parseArchiveCustomDomainStatus(
  value: unknown,
): ArchiveCustomDomainStatus | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.domain !== "string" ||
    typeof row.cname_target !== "string" ||
    typeof row.verification_token !== "string" ||
    typeof row.status !== "string" ||
    !DOMAIN_STATES.has(row.status) ||
    typeof row.ssl_status !== "string" ||
    !SSL_STATES.has(row.ssl_status) ||
    !optionalString(row.last_checked_at) ||
    !optionalString(row.verified_at) ||
    !optionalString(row.last_error) ||
    !optionalString(row.ssl_last_error)
  ) {
    return null;
  }
  return row as unknown as ArchiveCustomDomainStatus;
}

export const EMPTY_ARCHIVE_CUSTOM_DOMAIN: ArchiveCustomDomainStatus = {
  domain: "",
  cname_target: "",
  verification_token: "",
  status: "pending",
  ssl_status: "pending",
};
