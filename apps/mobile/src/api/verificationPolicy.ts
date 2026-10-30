/**
 * api/verificationPolicy.ts — the pre-send verification gate's mode, and the
 * paid-credit meter behind it.
 *
 *   GET /api/v1/verification/policy    (admin — the policy states which
 *       signups the workspace refuses, an access-control-shaped fact)
 *   PUT /api/v1/verification/policy    (admin)
 *   GET /api/v1/verification/credits   (viewer)
 *
 * THE PUT IS A FULL REPLACE. `SetPolicy` decodes the whole Policy struct, so
 * sending only the changed mode would silently reset the reject-status lists
 * somebody tuned at a desk. `setVerificationMode` therefore echoes the whole
 * current policy back with one field changed — the send-window lesson.
 */
import { ApiRequestError } from "./apiRequestError";
import { rawRequest, type AIApiError } from "./request";

import { str, WireShapeError } from "@/lib/deliverabilityContracts";

class VerificationPolicyError extends ApiRequestError {
  constructor(error: AIApiError, fallback: string) {
    super(error, fallback);
    this.name = "VerificationPolicyError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export type VerificationMode = "off" | "local" | "full";

export interface VerificationPolicy {
  formsMode: string;
  formsRejectStatuses: string[];
  /** Tri-state on the wire: omitted means "default (true)". */
  formsSuggestTypos: boolean | null;
  importMode: string;
  updatedAt: string;
}

export interface VerificationPolicyEnvelope {
  policy: VerificationPolicy;
  modes: string[];
  rejectableStatuses: string[];
}

function parsePolicy(value: unknown): VerificationPolicy {
  if (!isRecord(value)) throw new WireShapeError("verification policy");
  return {
    formsMode: str(value.forms_mode, "off"),
    formsRejectStatuses: stringList(value.forms_reject_statuses),
    formsSuggestTypos:
      typeof value.forms_suggest_typos === "boolean"
        ? value.forms_suggest_typos
        : null,
    importMode: str(value.import_mode, "off"),
    updatedAt: str(value.updated_at),
  };
}

export async function fetchVerificationPolicy(): Promise<VerificationPolicyEnvelope> {
  const res = await rawRequest<unknown>("GET", "/api/v1/verification/policy");
  if (res.error) {
    throw new VerificationPolicyError(
      res.error,
      "Couldn't load the verification policy.",
    );
  }
  if (!isRecord(res.data)) throw new WireShapeError("verification policy");
  return {
    policy: parsePolicy(res.data.policy),
    modes: stringList(res.data.modes),
    rejectableStatuses: stringList(res.data.rejectable_statuses),
  };
}

/**
 * Change one gate's mode, echoing everything else back unchanged. The server
 * may attach a `warning` when full mode is enabled with no provider — the
 * exact consequence sentence, rendered verbatim.
 */
export async function setVerificationMode(
  current: VerificationPolicy,
  gate: "forms" | "import",
  mode: VerificationMode,
): Promise<{ policy: VerificationPolicy; warning: string }> {
  const body: Record<string, unknown> = {
    forms_mode: gate === "forms" ? mode : current.formsMode,
    forms_reject_statuses: current.formsRejectStatuses,
    import_mode: gate === "import" ? mode : current.importMode,
  };
  // Tri-state: only echo the flag when the server stated it, so an omitted
  // value stays "use the default" instead of becoming an explicit choice.
  if (current.formsSuggestTypos !== null) {
    body.forms_suggest_typos = current.formsSuggestTypos;
  }
  const res = await rawRequest<unknown>(
    "PUT",
    "/api/v1/verification/policy",
    body,
  );
  if (res.error) {
    throw new VerificationPolicyError(
      res.error,
      "Couldn't change the verification policy.",
    );
  }
  if (!isRecord(res.data)) throw new WireShapeError("verification policy");
  return {
    policy: parsePolicy(res.data.policy),
    warning: str(res.data.warning),
  };
}

/* ------------------------------------------------------------- credits --- */

export interface VerificationCredits {
  totals: {
    verified: number;
    creditsSpent: number;
    localFiltered: number;
    cacheHits: number;
    creditsSaved: number;
  };
  /** Empty string when no paid provider is configured (free tier only). */
  provider: string;
  /** Null when unmetered or unknown. */
  balance: number | null;
  note: string;
}

export async function fetchVerificationCredits(): Promise<VerificationCredits> {
  const res = await rawRequest<unknown>("GET", "/api/v1/verification/credits");
  if (res.error) {
    throw new VerificationPolicyError(
      res.error,
      "Couldn't load verification credits.",
    );
  }
  if (!isRecord(res.data)) throw new WireShapeError("verification credits");
  if (!isRecord(res.data.totals)) {
    throw new WireShapeError("verification credits");
  }
  const totals = res.data.totals;
  const requiredCount = (value: unknown, allowNegative = false): number => {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      !Number.isInteger(value) ||
      (!allowNegative && value < 0)
    ) {
      throw new WireShapeError("verification credits");
    }
    return value;
  };
  const rawBalance = res.data.balance;
  if (
    rawBalance !== null &&
    (typeof rawBalance !== "number" ||
      !Number.isFinite(rawBalance) ||
      !Number.isInteger(rawBalance))
  ) {
    throw new WireShapeError("verification credits");
  }
  if (res.data.provider !== null && typeof res.data.provider !== "string") {
    throw new WireShapeError("verification credits");
  }
  return {
    totals: {
      verified: requiredCount(totals.verified),
      creditsSpent: requiredCount(totals.credits_spent),
      localFiltered: requiredCount(totals.local_filtered),
      cacheHits: requiredCount(totals.cache_hits),
      creditsSaved: requiredCount(totals.credits_saved, true),
    },
    provider: str(res.data.provider),
    balance: rawBalance,
    note: str(res.data.note),
  };
}
