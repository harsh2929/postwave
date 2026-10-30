/**
 * subscriberFederation — SUB-023 cross-workspace identity links, on the
 * phone's Data cluster.
 *
 * An agency parent workspace holds MASTER identities; a child workspace's
 * subscriber can be linked to one. The list response carries the profile's
 * own strong revision (`subscriber_version`), and BOTH writes are
 * conditional on exactly that token — the decision binds to the state the
 * operator saw, and a concurrent change 412s honestly.
 *
 * Import-free so every rule runs in the node vitest suite.
 */

export interface FederationLinkRow {
  id: string;
  parentTenantId: string;
  masterSubscriberId: string;
  /** email | external_id | manual — the link's provenance. */
  matchType: string;
  matchKey: string;
  createdAt: string;
}

export interface FederationView {
  links: FederationLinkRow[];
  /** The profile revision every write must echo as If-Match. */
  subscriberVersion: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Desktop's provenance vocabulary; unknowns pass through. */
export function federationMatchLabel(matchType: string): string {
  switch (matchType) {
    case "email":
      return "Matched by email";
    case "external_id":
      return "Matched by external id";
    case "manual":
      return "Linked manually";
    default:
      return matchType;
  }
}

/** The GET {items, subscriber_version} body, defensively. */
export function parseFederationLinks(payload: unknown): FederationView {
  const rec =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const links: FederationLinkRow[] = Array.isArray(rec.items)
    ? rec.items.flatMap((row): FederationLinkRow[] => {
        if (!row || typeof row !== "object") return [];
        const r = row as Record<string, unknown>;
        const id = str(r.id);
        if (!id) return [];
        return [
          {
            id,
            parentTenantId: str(r.parent_tenant_id),
            masterSubscriberId: str(r.master_subscriber_id),
            matchType: str(r.match_type) || "manual",
            matchKey: str(r.match_key),
            createdAt: str(r.created_at),
          },
        ];
      })
    : [];
  return { links, subscriberVersion: str(rec.subscriber_version) };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Why a manual link cannot be created right now, or null. */
export function createLinkProblem(input: {
  parentTenantId: string;
  masterSubscriberId: string;
}): string | null {
  if (!UUID_RE.test(input.parentTenantId.trim())) {
    return "Enter the parent workspace's id (a UUID).";
  }
  if (!UUID_RE.test(input.masterSubscriberId.trim())) {
    return "Enter the master subscriber's id (a UUID).";
  }
  return null;
}

/** POST body — CreateFederationLinkInput; manual provenance from a phone. */
export function buildCreateLinkBody(input: {
  parentTenantId: string;
  masterSubscriberId: string;
}): Record<string, string> {
  return {
    parent_tenant_id: input.parentTenantId.trim(),
    master_subscriber_id: input.masterSubscriberId.trim(),
    match_type: "manual",
  };
}
