/**
 * EqScoreLookupCard — #20 of the 2026-06-11 wiring backlog.
 *
 * Synchronous heuristic Email Quality grade: enter a From address
 * (the domain feeds the auth sub-score) plus subject / HTML, POST
 * /api/v1/deliverability/eq-score, render the grade + 0-100 score +
 * the three weighted sub-scores with their reasons.
 *
 * Sender authentication and reputation come from tenant-scoped server state.
 * The response carries camelCase `skippedSubScores`; a skipped sub-score
 * renders as "not scored", never a fake zero.
 */

import { useEffect, useId, useRef, useState, type ReactElement } from "react";

import { FormField } from "../FormField";
import { type EQScoreResult, eqScoreApi } from "../../lib/api-client";
import {
  canSubmitEqScore,
  gradeBadgeClass,
  reasonBadgeClass,
  subScoreRows,
} from "./eq-score-helpers";
import { parseEqScoreResult } from "./settings-response-contract";

export function EqScoreLookupCard(): ReactElement {
  const [from, setFrom] = useState("");
  const [subject, setSubject] = useState("");
  const [html, setHtml] = useState("");
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<EQScoreResult | null>(null);
  const scoreInFlightRef = useRef(false);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const scoreReasonId = useId();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, []);

  const submittable = canSubmitEqScore({ from, subject, html });
  const scoreUnavailableReason = !submittable
    ? "Enter a From address and either a subject or HTML body before scoring."
    : running
      ? "An EQ score request is already running."
      : null;

  const score = async (): Promise<void> => {
    if (!submittable || scoreInFlightRef.current) return;
    const requestId = ++requestIdRef.current;
    scoreInFlightRef.current = true;
    setRunning(true);
    setErr(null);
    try {
      const res = await eqScoreApi.score({
        from: from.trim(),
        subject,
        html,
      });
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      if (res.error) {
        setErr(res.error.message);
        return;
      }
      const parsed = parseEqScoreResult(res.data);
      if (!parsed) {
        setErr("The EQ score service returned malformed data.");
        return;
      }
      setResult(parsed);
    } catch {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setErr("The EQ score request could not be completed.");
      }
    } finally {
      scoreInFlightRef.current = false;
      if (mountedRef.current && requestId === requestIdRef.current) {
        setRunning(false);
      }
    }
  };

  const rows = result ? subScoreRows(result) : [];

  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontWeight: 600 }}>EQ score lookup</div>
        <div className="muted" style={{ fontSize: 12 }}>
          Heuristic Email Quality grade — content, authentication, and sender
          reputation
        </div>
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        <FormField label="From address" htmlFor="eq-from" required>
          <input
            id="eq-from"
            className="input"
            type="email"
            placeholder="news@yourdomain.com"
            value={from}
            disabled={running}
            onChange={(e) => {
              setFrom(e.target.value);
              setResult(null);
              setErr(null);
            }}
          />
        </FormField>
        <FormField label="Subject" htmlFor="eq-subject">
          <input
            id="eq-subject"
            className="input"
            placeholder="Subject line to grade"
            value={subject}
            disabled={running}
            onChange={(e) => {
              setSubject(e.target.value);
              setResult(null);
              setErr(null);
            }}
          />
        </FormField>
        <FormField label="HTML body (optional)" htmlFor="eq-html">
          <textarea
            id="eq-html"
            className="input"
            rows={3}
            placeholder="<html>…</html>"
            value={html}
            disabled={running}
            onChange={(e) => {
              setHtml(e.target.value);
              setResult(null);
              setErr(null);
            }}
          />
        </FormField>
        <div>
          {scoreUnavailableReason ? (
            <span id={scoreReasonId} className="visually-hidden" role="status">
              {scoreUnavailableReason}
            </span>
          ) : null}
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              if (!submittable || running || scoreInFlightRef.current) return;
              void score();
            }}
            aria-disabled={Boolean(scoreUnavailableReason) || undefined}
            aria-describedby={
              scoreUnavailableReason ? scoreReasonId : undefined
            }
          >
            {running ? "Scoring…" : "Score"}
          </button>
        </div>
      </div>

      {err ? (
        <div className="notice" style={{ marginTop: 10 }}>
          <span>Couldn&apos;t score: {err}</span>
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginLeft: 8 }}
            onClick={() => void score()}
            disabled={running}
          >
            Retry
          </button>
        </div>
      ) : null}

      {result ? (
        <div style={{ marginTop: 14 }}>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 10,
              marginBottom: 10,
            }}
          >
            <span className={gradeBadgeClass(result.grade)}>
              {result.grade}
            </span>
            <span className="tabular" style={{ fontWeight: 700, fontSize: 22 }}>
              {result.score}
            </span>
            <span className="muted" style={{ fontSize: 12 }}>
              / 100
            </span>
          </div>

          <div style={{ display: "grid", gap: 10 }}>
            {rows.map((r) => (
              <div key={r.key}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 13,
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{r.label}</span>
                  <span className="muted" style={{ fontSize: 11 }}>
                    weight {Math.round(r.weight * 100)}%
                  </span>
                  <span
                    className="tabular"
                    style={{ marginLeft: "auto", fontWeight: 600 }}
                  >
                    {r.score == null ? "not scored" : r.score}
                  </span>
                </div>
                {r.score == null ? (
                  <div className="muted" style={{ fontSize: 12 }}>
                    Skipped — not enough history on this tenant yet.
                  </div>
                ) : r.reasons.length > 0 ? (
                  <div
                    style={{
                      display: "grid",
                      gap: 4,
                      marginTop: 4,
                      fontSize: 12,
                    }}
                  >
                    {r.reasons.map((reason) => (
                      <div
                        key={reason.code}
                        style={{
                          display: "flex",
                          gap: 8,
                          alignItems: "center",
                        }}
                      >
                        <span className={reasonBadgeClass(reason.severity)}>
                          {reason.severity}
                        </span>
                        <span className="muted">{reason.message}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
