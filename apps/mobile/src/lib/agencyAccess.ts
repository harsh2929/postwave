/**
 * lib/agencyAccess.ts — which 403 is this?
 *
 * The agency endpoints return three different 403s with distinct
 * machine-readable codes (apps/api/internal/agency): `not_agency` when the
 * workspace simply has no sub-accounts, `not_authorized` when the caller's
 * role or API key lost the scope, and `not_your_child` when a child id does
 * not belong to this parent.
 *
 * Mobile treated all of them as "Not an agency workspace", so an admin whose
 * permissions had just been reduced was told their agency did not exist —
 * an answer that sends someone looking in exactly the wrong place. Pure and
 * tested so the mapping cannot silently drift back.
 */

export type AgencyForbiddenKind = "not_agency" | "restricted";

/** The known agency 403 codes that mean "you lack access", not "no agency". */
const RESTRICTED_CODES = new Set(["not_authorized", "not_your_child"]);

/**
 * Classify an agency 403 by its server code. Returns null for a code we do
 * not recognise, so an unknown 403 surfaces as a real error rather than
 * being silently absorbed into a reassuring empty state.
 */
export function agencyForbiddenKind(
  code: string | undefined,
): AgencyForbiddenKind | null {
  const normalized = (code ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "not_agency") return "not_agency";
  if (RESTRICTED_CODES.has(normalized)) return "restricted";
  return null;
}

export interface AgencyEmptyCopy {
  title: string;
  description: string;
}

/** The child-tenant list's empty state, under the same distinction. */
export function agencyChildrenEmptyCopy(
  accessRestricted: boolean,
  notAgency: boolean,
): AgencyEmptyCopy {
  if (accessRestricted) {
    return {
      title: "Access restricted",
      description:
        "The child roster was refused with your current role or credential. Ask a workspace owner to verify agency read access.",
    };
  }
  if (notAgency) {
    return {
      title: "Not an agency workspace",
      description:
        "The server confirmed that this workspace does not have an agency child roster.",
    };
  }
  return {
    title: "No child workspaces",
    description:
      "No linked workspace is present in the loaded roster. Child provisioning is release-held.",
  };
}
