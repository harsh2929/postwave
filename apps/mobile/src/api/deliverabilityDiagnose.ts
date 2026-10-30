/**
 * api/deliverabilityDiagnose.ts — the LLM deliverability diagnostician.
 *
 *   POST /api/v1/diagnose/{campaignId}   (admin, proxied, LLM-backed)
 *
 * Desktop's DiagnosticianCard gathers evidence FIRST (the auth-check matrix
 * and the campaign's seed placement report) and refuses to send the AI request
 * when neither could be verified — an LLM diagnosing with no evidence produces
 * confident fiction. That guard is kept verbatim here: the two evidence reads
 * run tolerantly (either may 404/503), and only a request with at least one
 * verified signal goes to the model.
 *
 * PRESS-DRIVEN, single attempt, no retry: the model call is expensive and a
 * silent second attempt doubles the spend for an answer nobody is waiting for.
 * A 503 means "LLM not configured on this deployment" — a different sentence
 * from a failure.
 */
import {
  fetchAuthChecks,
  fetchPlacementReport,
  type AuthCheckRow,
  type PlacementReport,
} from "./deliverabilityEvidence";
import { rawRequest, type AIApiError } from "./request";

import { itemsOf, numberOr, str, WireShapeError } from "@/lib/deliverabilityContracts";

export class DiagnoseError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = "DiagnoseError";
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface DiagnosisFix {
  action: string;
  impact: string;
  detail: string;
}

export interface CampaignDiagnosis {
  campaignId: string;
  /** Markdown — split into sections by the view layer. */
  diagnosis: string;
  fixes: DiagnosisFix[];
  predictedImpact: Record<string, number>;
  generatedAt: string;
  /** Which evidence actually reached the model. */
  evidence: { authentication: boolean; placement: boolean };
}

function parseDiagnosis(
  value: unknown,
  campaignId: string,
  evidence: { authentication: boolean; placement: boolean },
): CampaignDiagnosis {
  if (!isRecord(value)) throw new WireShapeError("campaign diagnosis");
  const fixes: DiagnosisFix[] = [];
  for (const row of itemsOf(value.fixes ?? [], "diagnosis fixes")) {
    if (!isRecord(row)) continue;
    const action = str(row.action).trim() || str(row.title).trim();
    if (!action) continue;
    fixes.push({
      action,
      impact: str(row.impact),
      detail: str(row.detail) || str(row.description),
    });
  }
  const predictedImpact: Record<string, number> = {};
  if (isRecord(value.predicted_impact)) {
    for (const [key, raw] of Object.entries(value.predicted_impact)) {
      const n = numberOr(raw, Number.NaN);
      if (Number.isFinite(n)) predictedImpact[key] = n;
    }
  }
  return {
    campaignId: str(value.campaign_id, campaignId),
    diagnosis: str(value.diagnosis),
    fixes,
    predictedImpact,
    generatedAt: str(value.generated_at),
    evidence,
  };
}

async function settle<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

/**
 * Gather evidence, then diagnose. Throws DiagnoseError with the no-evidence
 * sentence (status 0) when neither signal could be verified — the AI request
 * is NOT sent in that case, exactly as on desktop.
 */
export async function diagnoseCampaign(
  campaignId: string,
): Promise<CampaignDiagnosis> {
  const id = campaignId.trim();
  if (!id) throw new DiagnoseError("A campaign is required.");
  const [authRows, placement] = await Promise.all([
    settle<AuthCheckRow[]>(fetchAuthChecks()),
    settle<PlacementReport | null>(fetchPlacementReport(id)),
  ]);
  // Only an UNAMBIGUOUS single-domain matrix is campaign-attributable —
  // desktop's rule (authRows?.length === 1).
  const auth = authRows && authRows.length === 1 ? authRows[0] : null;
  const evidence = {
    authentication: Boolean(auth),
    placement: Boolean(placement),
  };
  if (!evidence.authentication && !evidence.placement) {
    throw new DiagnoseError(
      "No campaign-specific placement or unambiguous authentication evidence could be verified. The AI request was not sent.",
    );
  }
  const signals: Record<string, unknown> = { campaign_id: id };
  if (auth) {
    signals.domain = auth.domain;
    // Desktop sends the matrix ROW (domain + per-check cells) — same shape.
    signals.auth = { domain: auth.domain, ...auth.checks };
  }
  if (placement) {
    signals.seedlist = {
      campaign_id: placement.campaignId,
      overall_pct: placement.overallPct,
      total_inboxes: placement.totalInboxes,
    };
  }
  const res = await rawRequest<unknown>(
    "POST",
    `/api/v1/diagnose/${encodeURIComponent(id)}`,
    signals,
  );
  if (res.error) {
    const err = res.error as AIApiError;
    throw new DiagnoseError(
      err.status === 503
        ? "The diagnosis service isn't configured on this deployment."
        : err.message || "The diagnosis could not be completed.",
      err.status,
    );
  }
  return parseDiagnosis(res.data, id, evidence);
}
