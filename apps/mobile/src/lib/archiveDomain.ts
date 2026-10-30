/**
 * lib/archiveDomain.ts — the pure half of the archive custom-domain card.
 *
 * Desktop's ArchiveDomainSection (apps/desktop/src/components/settings/
 * ArchiveDomainSection.tsx) owns the whole vanity-host lifecycle; mobile had
 * none of it, which mattered because "did my CNAME propagate yet / has the
 * cert issued yet" is a waiting-on-DNS question people check from a phone.
 *
 * WIRE SHAPES
 *   GET  /api/v1/admin/archive/domain            (admin) → CustomDomainStatus
 *   POST /api/v1/admin/archive/domain/verify     (admin) → CustomDomainStatus
 *        400 no_domain      "no custom archive domain configured; set
 *                            archive_domain first"
 *        400 invalid_domain  ValidateArchiveDomain's own sentence
 *        409 domain_taken    "that domain is already claimed by another
 *                            publication"
 *   DELETE /api/v1/admin/archive/domain          (admin) → 204, clears the
 *        verification row (the archive_domain column is left alone).
 *   PUT  /api/v1/admin/archive/tenant-settings   (admin) → TenantSettings,
 *        PATCH-style: only `archive_domain` is sent, an empty string clears it.
 *
 * The GET always answers a full envelope (`LookupCustomDomain` returns the
 * zero-value row with the CNAME target when nothing is configured), so there
 * is no 404 to special-case.
 *
 * Import-free so it runs under node vitest.
 */

export type ArchiveVerificationStatus = "pending" | "verified" | "failed";
export type ArchiveSslStatus = "pending" | "issuing" | "issued" | "failed";

export interface ArchiveDomainStatus {
  /** The operator-configured archive_domain; "" when none is set. */
  domain: string;
  /** The host operators add as the CNAME value. */
  cnameTarget: string;
  /** The TXT alternative for providers that will not CNAME; "" when absent. */
  verificationToken: string;
  status: ArchiveVerificationStatus;
  sslStatus: ArchiveSslStatus;
  /** RFC3339, "" when never checked / never verified / no error. */
  lastCheckedAt: string;
  verifiedAt: string;
  lastError: string;
  sslLastError: string;
}

/** The tenant's archive_domain column as PUT tenant-settings echoes it back. */
export interface ArchiveDomainSettings {
  archiveDomain: string;
}

const VERIFICATION_STATUSES = new Set(["pending", "verified", "failed"]);
const SSL_STATUSES = new Set(["pending", "issuing", "issued", "failed"]);

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The wire envelope → a status, or null when the payload is not an object or
 * carries an enum value this client does not know. An unknown status is not
 * coerced to "pending": telling an operator their domain is pending when the
 * server said something else is the one lie this card must not tell.
 */
export function normalizeArchiveDomainStatus(
  payload: unknown,
): ArchiveDomainStatus | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const raw = payload as Record<string, unknown>;
  const status = str(raw.status);
  const sslStatus = str(raw.ssl_status);
  if (!VERIFICATION_STATUSES.has(status) || !SSL_STATUSES.has(sslStatus)) {
    return null;
  }
  return {
    domain: str(raw.domain).toLowerCase(),
    cnameTarget: str(raw.cname_target),
    verificationToken: str(raw.verification_token),
    status: status as ArchiveVerificationStatus,
    sslStatus: sslStatus as ArchiveSslStatus,
    lastCheckedAt: str(raw.last_checked_at),
    verifiedAt: str(raw.verified_at),
    lastError: str(raw.last_error),
    sslLastError: str(raw.ssl_last_error),
  };
}

/** True for a value already shaped as a status (a shared cache holds anything). */
export function isArchiveDomainStatus(
  value: unknown,
): value is ArchiveDomainStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.domain === "string" &&
    typeof v.cnameTarget === "string" &&
    typeof v.status === "string" &&
    VERIFICATION_STATUSES.has(v.status) &&
    typeof v.sslStatus === "string" &&
    SSL_STATUSES.has(v.sslStatus)
  );
}

/** The archive_domain column off a PUT /admin/archive/tenant-settings answer. */
export function normalizeArchiveDomainSettings(
  payload: unknown,
): ArchiveDomainSettings | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const raw = payload as Record<string, unknown>;
  if (!("archive_domain" in raw)) return null;
  return { archiveDomain: str(raw.archive_domain).toLowerCase() };
}

/**
 * The server's own hostname rule, mirrored exactly:
 * apps/api/internal/archive/custom_domain.go `domainHostRe` +
 * `reservedDomainSuffixes` + the ≤253 length bound in ValidateArchiveDomain.
 */
const DOMAIN_HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const RESERVED_SUFFIXES = [".moosewave.com", ".postwave.dev", ".postwave.io"];

/**
 * The two sentences ValidateArchiveDomain returns. The handler echoes them
 * verbatim as `invalid_domain`, so the local pre-check says exactly what the
 * server would have said rather than a second, different wording.
 */
export const ARCHIVE_DOMAIN_INVALID =
  "archive: domain must be a lowercase hostname (e.g. archive.example.com)";
export const ARCHIVE_DOMAIN_RESERVED =
  "archive: that domain is reserved for Moosewave's own infrastructure";

/**
 * Validate a typed domain the way the server will. An empty string is VALID —
 * it clears the column — exactly as ValidateArchiveDomain allows.
 */
export function validateArchiveDomain(
  input: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const d = input.trim().toLowerCase();
  if (d === "") return { ok: true, value: "" };
  if (d.length > 253) return { ok: false, message: ARCHIVE_DOMAIN_INVALID };
  if (!DOMAIN_HOST_RE.test(d)) {
    return { ok: false, message: ARCHIVE_DOMAIN_INVALID };
  }
  for (const suffix of RESERVED_SUFFIXES) {
    if (d.endsWith(suffix)) {
      return { ok: false, message: ARCHIVE_DOMAIN_RESERVED };
    }
  }
  return { ok: true, value: d };
}

/** True when the typed draft differs from the saved archive_domain. */
export function archiveDomainDirty(
  status: ArchiveDomainStatus,
  draft: string,
): boolean {
  return draft.trim().toLowerCase() !== status.domain.trim().toLowerCase();
}

/** The CNAME record to create, as two copyable rows. */
export function archiveDnsRecord(
  status: ArchiveDomainStatus,
): { host: string; target: string } | null {
  if (status.domain === "" || status.cnameTarget === "") return null;
  return { host: status.domain, target: status.cnameTarget };
}

/** The TXT fallback, when the server issued a verification token. */
export function archiveTxtRecord(
  status: ArchiveDomainStatus,
): { host: string; value: string } | null {
  if (status.domain === "" || status.verificationToken === "") return null;
  return {
    host: `_postwave-verify.${status.domain}`,
    value: `postwave-verify=${status.verificationToken}`,
  };
}

/** What the CNAME check is currently saying. */
export function archiveCnameSentence(status: ArchiveDomainStatus): string {
  if (status.status === "verified") {
    return "The CNAME resolves to Moosewave. This host serves your archive.";
  }
  if (status.status === "failed") {
    return (
      status.lastError ||
      "The last check could not resolve this host to Moosewave."
    );
  }
  return "Waiting for DNS propagation — tap Verify once the CNAME below exists.";
}

/**
 * The certificate sentence, in desktop's words. `failed` prefers the server's
 * own issuance error over the generic line.
 */
export function archiveSslSentence(status: ArchiveDomainStatus): string {
  if (status.sslStatus === "issued") {
    return "Let's Encrypt cert is live — HTTPS works.";
  }
  if (status.sslStatus === "issuing") {
    return "Provisioning certificate via Let's Encrypt — usually < 90 seconds after verification.";
  }
  if (status.sslStatus === "failed") {
    return (
      status.sslLastError ||
      "Cert issuance failed. Check that your DNS still points to the CNAME target."
    );
  }
  return status.status === "verified"
    ? "Cert will be issued automatically once the edge picks up this domain."
    : "SSL provisioning starts after CNAME verification succeeds.";
}

/**
 * Whether to keep re-reading. The edge writes `ssl_status` out of band, so
 * `issuing` is the only state that changes without the operator doing
 * anything — and it is the state they are sitting there waiting on.
 */
export function archiveDomainShouldPoll(
  status: ArchiveDomainStatus | null,
): boolean {
  return status?.sslStatus === "issuing";
}

/** The live public URL, or null — never a guessed host. */
export function archivePublicUrl(status: ArchiveDomainStatus): string | null {
  if (status.status !== "verified" || status.domain === "") return null;
  return `https://${status.domain}`;
}

/** What a completed verify run should say, from the row it returned. */
export function archiveVerifyOutcome(status: ArchiveDomainStatus): {
  kind: "success" | "error";
  message: string;
} {
  if (status.status === "verified") {
    return {
      kind: "success",
      message: "Domain verified! SSL is being provisioned.",
    };
  }
  return {
    kind: "error",
    message:
      status.lastError || "Verification failed. Check the CNAME record and try again.",
  };
}

/**
 * The sentence a failed write shows. 400/409 from these handlers are
 * operator-authored (`no_domain`, `invalid_domain`, `domain_taken`) and name
 * the thing at fault, so they are shown verbatim.
 */
export function archiveDomainWriteError(error: {
  status: number;
  code?: string | undefined;
  message: string;
}): string {
  if (error.status === 403) {
    return "Only workspace admins can change the archive domain.";
  }
  if (
    (error.status === 400 || error.status === 409) &&
    error.message.trim() !== ""
  ) {
    return error.message;
  }
  return error.message.trim() !== ""
    ? error.message
    : "Couldn't reach the archive-domain settings.";
}
