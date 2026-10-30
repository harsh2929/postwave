/**
 * DiagnosticianCard — #44 of the 2026-06-11 wiring backlog.
 *
 * "Diagnose" panel: pick a campaign → POST /api/v1/diagnose/{id}
 * (proxied to the deliverability service, LLM-backed, 60s budget via
 * LLM_REQUEST_OPTS) → render the structured diagnosis: the markdown
 * analysis split into sections (placement / reputation / engagement /
 * … — whatever headings the model emitted), the ranked fix list, and
 * the predicted-impact figures.
 *
 * Honest states:
 *   while running → explicit "up to 60 seconds" progress copy (single
 *     attempt, no silent retry);
 *   429 → rate-limited copy with the server's retry-after;
 *   503 → "service not configured / LLM not wired" notice — NOT an
 *     empty state.
 */

import { useEffect, useRef, useState, type ReactElement } from "react";

import {
  authChecksApi,
  type CampaignDiagnosis,
  type DiagnoseSignalsInput,
  diagnosticianApi,
  inboxRealityCampaignsApi,
} from "../../lib/api-client";
import { CampaignSelect } from "./CampaignSelect";
import { parseAuthCheckMatrix } from "./auth-matrix-helpers";
import {
  fixActionLabel,
  formatImpact,
  predictedImpactRows,
  sortFixesByImpact,
  splitDiagnosisSections,
} from "./diagnosis-helpers";
import { describeServiceError, type ServiceErrorView } from "./service-status";
import {
  parseCampaignDiagnosis,
  parsePlacementReport,
} from "./diagnostics-response-contract";

interface DiagnosisEvidence {
  authentication: boolean;
  placement: boolean;
}

export function DiagnosticianCard(): ReactElement {
  const [campaignId, setCampaignId] = useState("");
  const [running, setRunning] = useState(false);
  const [errView, setErrView] = useState<ServiceErrorView | null>(null);
  const [diagnosis, setDiagnosis] = useState<CampaignDiagnosis | null>(null);
  const [evidence, setEvidence] = useState<DiagnosisEvidence | null>(null);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const diagnoseInFlightRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      requestIdRef.current += 1;
    };
  }, []);

  const diagnose = async (): Promise<void> => {
    if (!campaignId || diagnoseInFlightRef.current) return;
    const requestId = ++requestIdRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    diagnoseInFlightRef.current = true;
    setRunning(true);
    setErrView(null);
    setEvidence(null);
    try {
      const [authSettlement, placementSettlement] = await Promise.allSettled([
        authChecksApi.matrix({ signal: controller.signal }),
        inboxRealityCampaignsApi.report(campaignId, {
          signal: controller.signal,
        }),
      ]);
      if (
        controller.signal.aborted ||
        !mountedRef.current ||
        requestId !== requestIdRef.current
      ) {
        return;
      }
      const authRows =
        authSettlement.status === "fulfilled" && !authSettlement.value.error
          ? parseAuthCheckMatrix(authSettlement.value.data)
          : null;
      const authentication = authRows?.length === 1 ? authRows[0] : null;
      const placement =
        placementSettlement.status === "fulfilled" &&
        !placementSettlement.value.error
          ? parsePlacementReport(placementSettlement.value.data, campaignId)
          : null;
      const evidenceState = {
        authentication: authentication !== null,
        placement: placement !== null,
      };
      setEvidence(evidenceState);
      if (!evidenceState.authentication && !evidenceState.placement) {
        setErrView({
          kind: "error",
          message:
            "No campaign-specific placement or unambiguous authentication evidence could be verified. The AI request was not sent.",
        });
        return;
      }
      const signals: DiagnoseSignalsInput = {
        campaign_id: campaignId,
        ...(authentication
          ? {
              domain: authentication.domain,
              auth: authentication,
            }
          : {}),
        ...(placement ? { seedlist: placement } : {}),
      };
      const res = await diagnosticianApi.diagnose(campaignId, signals, {
        signal: controller.signal,
      });
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      if (res.error) {
        setErrView(describeServiceError(res.error));
        return;
      }
      const parsed = parseCampaignDiagnosis(res.data);
      if (!parsed || parsed.campaign_id !== campaignId) {
        setErrView({
          kind: "error",
          message: "Diagnostician service returned a malformed response.",
        });
        return;
      }
      setDiagnosis(parsed);
    } catch {
      if (
        !controller.signal.aborted &&
        mountedRef.current &&
        requestId === requestIdRef.current
      ) {
        setErrView({
          kind: "error",
          message: "Moosewave couldn't complete the diagnosis.",
        });
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      diagnoseInFlightRef.current = false;
      if (mountedRef.current && requestId === requestIdRef.current) {
        setRunning(false);
      }
    }
  };

  const sections = diagnosis ? splitDiagnosisSections(diagnosis.diagnosis) : [];
  const fixes = diagnosis ? sortFixesByImpact(diagnosis.fixes ?? []) : [];
  const impacts = diagnosis
    ? predictedImpactRows(diagnosis.predicted_impact)
    : [];

  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontWeight: 600 }}>AI-assisted diagnosis</div>
        <div className="muted" style={{ fontSize: 12 }}>
          Builds a reviewable hypothesis only after fetching real placement or
          authentication evidence. Model output is not provider telemetry.
        </div>
      </div>

      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "flex-start",
          flexWrap: "wrap",
        }}
      >
        <div style={{ flex: 1, minWidth: 220 }}>
          <CampaignSelect
            id="diagnostician-campaign"
            ariaLabel="Campaign for deliverability diagnosis"
            value={campaignId}
            onChange={(id) => {
              abortRef.current?.abort();
              abortRef.current = null;
              diagnoseInFlightRef.current = false;
              requestIdRef.current += 1;
              setCampaignId(id);
              setDiagnosis(null);
              setEvidence(null);
              setErrView(null);
              setRunning(false);
            }}
            disabled={running}
          />
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void diagnose()}
          disabled={!campaignId || running}
        >
          {running ? "Diagnosing…" : "Diagnose"}
        </button>
      </div>

      {running ? (
        <div className="notice" style={{ marginTop: 10 }}>
          Verifying campaign evidence first, then consulting the model. The
          single request can take up to 60 seconds.
        </div>
      ) : null}

      {evidence ? (
        <div className="dhw-diagnosis-evidence" role="status">
          <strong>Evidence supplied to the model</strong>
          <span>
            Placement {evidence.placement ? "verified" : "unavailable"} ·
            Authentication{" "}
            {evidence.authentication ? "verified" : "unavailable"}
          </span>
          <small>
            Reputation and content evidence were not supplied by this workflow;
            treat related model claims as hypotheses requiring validation.
          </small>
        </div>
      ) : null}

      {errView ? (
        <div className="notice" style={{ marginTop: 10 }}>
          <span>{errView.message}</span>
          {errView.kind === "error" || errView.kind === "rate_limited" ? (
            <button
              type="button"
              className="btn btn-sm"
              style={{ marginLeft: 8 }}
              onClick={() => void diagnose()}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {diagnosis ? (
        <div style={{ marginTop: 14, display: "grid", gap: 14 }}>
          <div className="muted" style={{ fontSize: 12 }}>
            AI-generated {new Date(diagnosis.generated_at).toLocaleString()} ·
            review before acting
          </div>

          {/* Diagnosis sections (markdown headings → section blocks). */}
          {sections.length === 0 ? (
            <div className="muted" style={{ fontSize: 13 }}>
              The model returned no analysis text.
            </div>
          ) : (
            sections.map((s, i) => (
              <div key={`${s.heading}-${i}`}>
                {s.heading ? (
                  <div
                    className="muted"
                    style={{
                      fontSize: 11,
                      textTransform: "uppercase",
                      letterSpacing: 0.6,
                      marginBottom: 4,
                    }}
                  >
                    {s.heading}
                  </div>
                ) : null}
                <div
                  style={{
                    fontSize: 13,
                    whiteSpace: "pre-wrap",
                    lineHeight: 1.5,
                  }}
                >
                  {s.body}
                </div>
              </div>
            ))
          )}

          {/* Ranked fixes. */}
          {fixes.length > 0 ? (
            <div>
              <div
                className="muted"
                style={{
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: 0.6,
                  marginBottom: 6,
                }}
              >
                Recommended fixes
              </div>
              <div style={{ display: "grid", gap: 8 }}>
                {fixes.map((f, i) => (
                  <div
                    key={`${f.title}-${i}`}
                    style={{
                      border: "1px solid var(--pw-border)",
                      borderRadius: 8,
                      padding: "8px 10px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        flexWrap: "wrap",
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>{f.title}</span>
                      <span className="badge">{fixActionLabel(f.action)}</span>
                      <span
                        className="muted tabular"
                        style={{ marginLeft: "auto", fontSize: 12 }}
                        title="Estimated added inbox rate"
                      >
                        {formatImpact(f.estimated_impact)}
                      </span>
                    </div>
                    <div
                      className="muted"
                      style={{ fontSize: 12, marginTop: 4 }}
                    >
                      {f.detail}
                    </div>
                    {f.dns_record ? (
                      <pre
                        style={{
                          marginTop: 6,
                          marginBottom: 0,
                          fontSize: 11,
                          overflowX: "auto",
                        }}
                      >
                        {JSON.stringify(f.dns_record, null, 2)}
                      </pre>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* Predicted impact. */}
          {impacts.length > 0 ? (
            <div>
              <div
                className="muted"
                style={{
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: 0.6,
                  marginBottom: 6,
                }}
              >
                Model-estimated impact · not a forecast
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
                  gap: 8,
                  fontSize: 12,
                }}
              >
                {impacts.map((r) => (
                  <div key={r.key}>
                    <div className="muted">{r.label}</div>
                    <div className="tabular" style={{ fontWeight: 600 }}>
                      {r.value}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
