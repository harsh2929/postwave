/** Local release-hold boundaries for Agency operations; none may transport. */
import type { AgencyBrandingWire } from "@/lib/agencyWire";

export class AgencyReleaseHeldError extends Error {
  readonly status = 503;
  readonly code: string;
  readonly retryable = false;
  readonly ambiguous = false;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AgencyReleaseHeldError";
    this.code = code;
  }
}

export interface CreateAgencyChildInput {
  slug: string;
  name: string;
  tier: string;
  billingMode: string;
  resellerMarkupBps: number;
}

const LIFECYCLE_HOLD =
  "Agency child lifecycle changes are release-held until owner, onboarding, and payer handoff can complete atomically.";

export async function createAgencyChild(
  _input: CreateAgencyChildInput,
): Promise<never> {
  throw new AgencyReleaseHeldError(
    "agency_child_create_release_hold",
    LIFECYCLE_HOLD,
  );
}

export async function unlinkAgencyChild(_id: string): Promise<never> {
  throw new AgencyReleaseHeldError(
    "agency_child_unlink_release_hold",
    LIFECYCLE_HOLD,
  );
}

export async function setAgencyBillingMode(_input: {
  targetTenantId: string;
  mode: string;
  reason: string;
}): Promise<never> {
  throw new AgencyReleaseHeldError(
    "agency_billing_mode_release_hold",
    "Agency billing-owner transitions are release-held until the invoicing and payer handoff is complete.",
  );
}

export interface UpdateAgencyBrandingInput {
  payload: Readonly<Record<string, unknown>>;
  /** Exact branding state that seeded the editor. */
  current: AgencyBrandingWire;
}

/** Fail locally; no branding editor or publisher is shipped in this release. */
export async function updateAgencyBranding({
  payload: _payload,
  current: _current,
}: UpdateAgencyBrandingInput): Promise<never> {
  throw new AgencyReleaseHeldError(
    "agency_branding_update_release_hold",
    "Audit-portal branding publishing is release-held. The stored branding values were not changed.",
  );
}
