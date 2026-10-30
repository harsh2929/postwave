/**
 * SubjectLab (G11 of the campaigns 2026 pack)
 *
 * Confidence-scored subject-line variants. Operator picks an axis
 * (length / emoji / question / personalization) and a count (5-8),
 * clicks Generate; the modal calls /subject-lab/variants to produce
 * axis-conditioned variants, then /subject-lab/score to compute
 * predicted open rate + CI bands against the tenant's 180-day
 * baseline. Rows below baseline (or with thin matched_n) render
 * muted with a Low confidence pill.
 *
 * "Use" replaces draft.subject in the parent Create-Campaign form.
 * "Run top 3 as A/B" hands the top 3 rows by ci_low into the existing
 * /campaigns/ab-test flow — the bandit-policy persistence pairs with
 * the G4 dispatcher (not in this commit; the field is plumbed
 * through delivery_settings so the dispatcher can pick it up when
 * G4 lands).
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type SubjectLabScoredVariant,
  type SubjectScoreResponse,
  api,
  subjectAnalyzerApi,
} from "../lib/api-client";
import { Modal, ModalFooter } from "./Modal";
import { toast } from "./Toast";
import {
  explainSubjectAttributes,
  scoreSummaryLine,
} from "./subject-analyzer-helpers";

type Axis = "length" | "emoji" | "question" | "personalization";

export interface SubjectLabProps {
  open: boolean;
  onClose: () => void;
  /** Anchor for generation. Must be ≥10 chars for Generate to enable. */
  seedSubject: string;
  /** Optional body context — passed to the LLM as semantic anchor. */
  bodyExcerpt?: string;
  /** Editor + admin gate — Use and Run buttons hard-disable for viewers. */
  canMutate: boolean;
  /** Fired when the operator clicks Use on a row. */
  onPickVariant: (text: string) => void;
  /** Fired when the operator clicks Run top 3 as A/B. Receives top 3
   *  by ci_low descending. The parent constructs the createABTestCampaign
   *  payload so the Lab stays decoupled from campaign-specific schema. */
  onRunBandit: (top3: SubjectLabScoredVariant[]) => void;
  /** Context-specific label; campaign creation keeps the direct A/B label,
   * while non-campaign workspaces must explicitly describe staging/review. */
  banditActionLabel?: string;
  workflowDescription?: string;
}

const AXES: { id: Axis; label: string; hint: string }[] = [
  { id: "length", label: "Length", hint: "Vary short vs long" },
  { id: "emoji", label: "Emoji", hint: "Leading emoji per variant" },
  { id: "question", label: "Question", hint: "Open-ended + yes/no" },
  {
    id: "personalization",
    label: "Personalization",
    hint: "Mix in merge tags",
  },
];

interface DisplayVariant extends SubjectLabScoredVariant {
  scoreUnavailable?: boolean;
}

const PCT = (n: number): string =>
  Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "—";

function unscoredVariants(variants: string[], axis: string): DisplayVariant[] {
  return variants.map((text) => ({
    text,
    axis,
    predicted_open: Number.NaN,
    ci_low: Number.NaN,
    ci_high: Number.NaN,
    matched_n: 0,
    low_confidence: true,
    below_baseline: false,
    scoreUnavailable: true,
  }));
}

interface AnalyzerPanelProps {
  analyzer: SubjectScoreResponse | null;
  error: string | null;
  loading: boolean;
  onRetry: () => void;
}

function AnalyzerPanel({
  analyzer,
  error,
  loading,
  onRetry,
}: AnalyzerPanelProps): ReactElement {
  return (
    <div
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        padding: "8px 10px",
        marginBottom: 12,
        display: "grid",
        gap: 4,
      }}
    >
      <div
        style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}
      >
        <span style={{ fontWeight: 600 }}>Subject analyzer</span>
        {loading ? (
          <span className="muted" role="status">
            Scoring…
          </span>
        ) : analyzer ? (
          <span className="muted">{scoreSummaryLine(analyzer)}</span>
        ) : null}
        {error ? (
          <>
            <span className="muted" role="alert">
              Unavailable: {error}
            </span>
            <button type="button" className="btn btn-sm" onClick={onRetry}>
              Retry
            </button>
          </>
        ) : null}
      </div>
      {analyzer ? (
        <div className="muted" style={{ fontSize: 11 }}>
          {explainSubjectAttributes(analyzer.attributes).join(" · ")}
        </div>
      ) : null}
      {analyzer && analyzer.suggestions.length > 0 ? (
        <ul
          className="muted"
          style={{ margin: 0, paddingLeft: 16, fontSize: 11 }}
        >
          {analyzer.suggestions.map((suggestion, index) => (
            <li key={`${index}-${suggestion}`}>{suggestion}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface VariantTableProps {
  canMutate: boolean;
  onPickVariant: (text: string) => void;
  rows: DisplayVariant[];
}

function VariantTable({
  canMutate,
  onPickVariant,
  rows,
}: VariantTableProps): ReactElement | null {
  const viewerReasonId = useId();
  if (rows.length === 0) return null;
  return (
    <>
      {!canMutate ? (
        <div
          id={viewerReasonId}
          className="muted small"
          style={{ marginBottom: 6 }}
        >
          Viewer access can review variants but cannot replace the draft
          subject.
        </div>
      ) : null}
      <div
        className="subject-lab-table"
        style={{
          border: "1px solid var(--pw-border)",
          borderRadius: 6,
          overflowX: "auto",
        }}
      >
        <table
          style={{
            width: "100%",
            minWidth: 640,
            borderCollapse: "collapse",
            fontSize: 12,
          }}
        >
          <caption className="visually-hidden">
            Generated subject variants and predicted performance
          </caption>
          <thead>
            <tr>
              <th scope="col">Rank</th>
              <th scope="col">Subject</th>
              <th scope="col">Axis</th>
              <th scope="col">Predicted open</th>
              <th scope="col">Confidence</th>
              <th scope="col">
                <span className="visually-hidden">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const muted =
                row.scoreUnavailable ||
                row.low_confidence ||
                row.below_baseline;
              return (
                <tr
                  key={`${row.text}-${index}`}
                  data-confidence={muted ? "low" : "standard"}
                >
                  <td className="muted tabular">{index + 1}</td>
                  <td style={{ minWidth: 180, fontWeight: 500 }}>{row.text}</td>
                  <td
                    className="muted"
                    style={{ fontFamily: "ui-monospace, monospace" }}
                  >
                    {row.axis}
                  </td>
                  <td className="tabular">
                    <strong>{PCT(row.predicted_open)}</strong>
                    <div className="muted" style={{ fontSize: 10 }}>
                      {row.scoreUnavailable
                        ? "Score unavailable"
                        : `90% CI ${PCT(row.ci_low)}–${PCT(row.ci_high)}`}
                    </div>
                  </td>
                  <td className="muted">
                    {row.scoreUnavailable
                      ? "Unscored"
                      : row.low_confidence
                        ? "Low confidence"
                        : `Matched n=${row.matched_n}`}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-disabled={!canMutate || undefined}
                      aria-describedby={!canMutate ? viewerReasonId : undefined}
                      onClick={() => {
                        if (!canMutate) return;
                        onPickVariant(row.text);
                        const preview =
                          row.text.length > 40
                            ? `${row.text.slice(0, 40)}…`
                            : row.text;
                        toast.success(`Subject updated to "${preview}"`);
                      }}
                    >
                      Use
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

interface LabControlsProps {
  axis: Axis;
  count: number;
  generateUnavailableReason: string | null;
  generating: boolean;
  onAxisChange: (axis: Axis) => void;
  onCountChange: (count: number) => void;
  onGenerate: () => void;
}

function LabControls({
  axis,
  count,
  generateUnavailableReason,
  generating,
  onAxisChange,
  onCountChange,
  onGenerate,
}: LabControlsProps): ReactElement {
  const axisHintId = useId();
  const generateReasonId = useId();
  const selectedAxis = AXES.find((item) => item.id === axis) ?? AXES[0]!;
  return (
    <div style={{ display: "grid", gap: 6, marginBottom: 8 }}>
      <div
        className="row"
        style={{ display: "flex", flexWrap: "wrap", gap: 8 }}
      >
        <div
          role="group"
          aria-label="Variant axis"
          aria-describedby={axisHintId}
          aria-busy={generating || undefined}
          style={{ display: "flex", gap: 4, flexWrap: "wrap" }}
        >
          {AXES.map((item) => (
            <button
              key={item.id}
              type="button"
              className="btn btn-sm"
              aria-pressed={axis === item.id}
              aria-disabled={generating || undefined}
              onClick={() => {
                if (!generating) onAxisChange(item.id);
              }}
              style={{
                background: axis === item.id ? "var(--pw-fg)" : "transparent",
                color: axis === item.id ? "var(--pw-bg)" : "var(--pw-fg-muted)",
                fontWeight: axis === item.id ? 600 : 400,
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <label htmlFor="lab-count" className="muted" style={{ fontSize: 12 }}>
            Count
          </label>
          <input
            id="lab-count"
            type="number"
            min={5}
            max={8}
            value={count}
            disabled={generating}
            onChange={(event) =>
              onCountChange(
                Math.max(5, Math.min(8, Number(event.target.value) || 6)),
              )
            }
            style={{ width: 56 }}
          />
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            if (!generateUnavailableReason) onGenerate();
          }}
          aria-disabled={generateUnavailableReason ? "true" : undefined}
          aria-busy={generating || undefined}
          aria-describedby={
            generateUnavailableReason ? generateReasonId : undefined
          }
          style={{ marginLeft: "auto" }}
        >
          {generating ? "Generating…" : "Generate"}
        </button>
      </div>
      <div id={axisHintId} className="muted small">
        {selectedAxis.label}: {selectedAxis.hint}.
      </div>
      {generateUnavailableReason ? (
        <div
          id={generateReasonId}
          className="muted small"
          role="status"
          aria-live="polite"
        >
          {generateUnavailableReason}
        </div>
      ) : null}
    </div>
  );
}

export function SubjectLab({
  open,
  onClose,
  seedSubject,
  bodyExcerpt,
  canMutate,
  onPickVariant,
  onRunBandit,
  banditActionLabel = "Run top 3 as A/B",
  workflowDescription = "Generate axis-conditioned variants, score them against your last 180 days, and hand the top 3 to A/B.",
}: SubjectLabProps): ReactElement {
  const [axis, setAxis] = useState<Axis>("length");
  const [count, setCount] = useState(6);
  const [generating, setGenerating] = useState(false);
  const [rows, setRows] = useState<DisplayVariant[]>([]);
  const [baseline, setBaseline] = useState<number | null>(null);
  const [windowDays, setWindowDays] = useState(180);
  const [err, setErr] = useState<string | null>(null);

  // Full-surface wiring #8: heuristic subject-analyzer verdict for the
  // SEED subject (POST /subject-analyzer/score). Generated variants
  // already carry their own predicted_open from /subject-lab/score; the
  // analyzer panel explains how the seed itself projects against the
  // tenant's history, attribute by attribute.
  const [analyzer, setAnalyzer] = useState<SubjectScoreResponse | null>(null);
  const [analyzerErr, setAnalyzerErr] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  // G11 follow-up: pre-fetch the tenant's active brand-voice profile id
  // when the Lab opens so generated variants are conditioned on the
  // authored voice (the /variants endpoint accepts voice_profile_id;
  // the composer binds it once G10's refactor lands). Best-effort — a
  // missing profile just means unconditioned generation.
  const [voiceProfileId, setVoiceProfileId] = useState<string | null>(null);
  /** The subject is keystroke-bound while the score call is slow —
   *  guard against an older response clobbering a newer one. */
  const analyzeSeq = useRef(0);
  const generationSeq = useRef(0);
  const activeRef = useRef(true);
  const generatingRef = useRef(false);
  const analyzingRef = useRef(false);
  const banditReasonId = useId();

  // Re-sort on every render is fine — at most 8 rows. ci_low desc puts
  // the most-likely-good-bet first; below-baseline rows sink to the
  // bottom because their ci_low is necessarily lower.
  const sorted = useMemo(
    () =>
      [...rows].sort((left, right) => {
        if (!!left.scoreUnavailable !== !!right.scoreUnavailable) {
          return left.scoreUnavailable ? 1 : -1;
        }
        return right.ci_low - left.ci_low;
      }),
    [rows],
  );
  const banditCandidates = sorted.filter((row) => !row.scoreUnavailable);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      analyzeSeq.current += 1;
      generationSeq.current += 1;
      analyzingRef.current = false;
      generatingRef.current = false;
    };
  }, []);

  // Reset on close so a fresh open starts clean. Skip the work when
  // the modal is already closed (useEffect cleanup handles the rest).
  useEffect(() => {
    if (!open) {
      analyzeSeq.current += 1;
      generationSeq.current += 1;
      analyzingRef.current = false;
      generatingRef.current = false;
      setAnalyzing(false);
      setGenerating(false);
      setRows([]);
      setBaseline(null);
      setErr(null);
    }
  }, [open]);

  useEffect(() => {
    generationSeq.current += 1;
    generatingRef.current = false;
    setGenerating(false);
    setRows([]);
    setBaseline(null);
    setErr(null);
  }, [bodyExcerpt, seedSubject]);

  // Pre-fetch the active brand-voice profile id on open. Best-effort:
  // any error (no profile, viewer scope) leaves voiceProfileId null and
  // generation proceeds unconditioned.
  useEffect(() => {
    if (!open) {
      setVoiceProfileId(null);
      return;
    }
    let live = true;
    void (async () => {
      try {
        const response = await api.getBrandVoiceProfile();
        if (live && response.data?.is_active) {
          setVoiceProfileId(response.data.id);
        }
      } catch {
        // Voice conditioning is best-effort; generation remains available.
      }
    })();
    return () => {
      live = false;
    };
  }, [open]);

  const seedOk = seedSubject.trim().length >= 10;
  const generateUnavailableReason = generating
    ? "Wait for the current generation to finish."
    : !canMutate
      ? "Viewer access can analyze subjects but cannot generate variants."
      : !seedOk
        ? "Enter at least 10 subject characters before generating variants."
        : null;

  const analyzeSeed = useCallback(async (): Promise<void> => {
    if (!open || !seedOk || analyzingRef.current) return;
    const seq = ++analyzeSeq.current;
    analyzingRef.current = true;
    setAnalyzing(true);
    setAnalyzerErr(null);
    try {
      const res = await subjectAnalyzerApi.score(seedSubject.trim());
      if (!activeRef.current || seq !== analyzeSeq.current) return;
      if (res.error || !res.data) {
        setAnalyzer(null);
        setAnalyzerErr(res.error?.message ?? "Analyzer returned no score.");
        return;
      }
      setAnalyzer(res.data);
    } catch (error) {
      if (activeRef.current && seq === analyzeSeq.current) {
        setAnalyzer(null);
        setAnalyzerErr(
          error instanceof Error ? error.message : "Analyzer unavailable.",
        );
      }
    } finally {
      if (activeRef.current && seq === analyzeSeq.current) {
        analyzingRef.current = false;
        setAnalyzing(false);
      }
    }
  }, [open, seedOk, seedSubject]);

  // Score the seed when the lab opens (and when the seed changes while
  // open). Heuristic endpoint — cheap, not LLM-backed.
  useEffect(() => {
    if (!open || !seedOk) {
      analyzeSeq.current++; // invalidate any in-flight score
      analyzingRef.current = false;
      setAnalyzing(false);
      setAnalyzer(null);
      setAnalyzerErr(null);
      return;
    }
    analyzeSeq.current += 1;
    analyzingRef.current = false;
    void analyzeSeed();
  }, [analyzeSeed, open, seedOk]);

  const generate = async (): Promise<void> => {
    if (!open || !seedOk || !canMutate || generatingRef.current) return;
    const requestId = ++generationSeq.current;
    const requestAxis = axis;
    const requestSeed = seedSubject.trim();
    generatingRef.current = true;
    setGenerating(true);
    setErr(null);
    setRows([]);
    setBaseline(null);
    try {
      const vRes = await api.generateSubjectLabVariants({
        seed_subject: requestSeed,
        axis: requestAxis,
        count,
        body_excerpt: bodyExcerpt?.slice(0, 2000),
        ...(voiceProfileId ? { voice_profile_id: voiceProfileId } : {}),
      });
      if (!activeRef.current || requestId !== generationSeq.current) return;
      if (vRes.error || !vRes.data) {
        setErr(vRes.error?.message ?? "Generate failed");
        return;
      }
      const generated = vRes.data;
      if (generated.variants.length === 0) {
        setErr("The generator returned no subject variants.");
        return;
      }
      const sRes = await api.scoreSubjectVariants({
        subjects: generated.variants,
      });
      if (!activeRef.current || requestId !== generationSeq.current) return;
      if (sRes.error || !sRes.data || sRes.data.variants.length === 0) {
        // Score failed but we still have variants — surface them
        // unscored so the operator can at least Use one.
        setRows(unscoredVariants(generated.variants, generated.axis));
        setBaseline(null);
        const reason =
          sRes.error?.message ??
          (sRes.data
            ? "the scorer returned no variants"
            : "the scorer returned an empty response");
        setErr(`Score unavailable (${reason})`);
        return;
      }
      // Stamp axis on each row from the generator's response so the
      // score-only fallback above stays consistent.
      const stamped: SubjectLabScoredVariant[] = sRes.data.variants.map(
        (variant) => ({ ...variant, axis: generated.axis }),
      );
      setRows(stamped);
      setBaseline(sRes.data.baseline_open);
      setWindowDays(sRes.data.window_days);
    } catch (e) {
      if (activeRef.current && requestId === generationSeq.current) {
        setErr(e instanceof Error ? e.message : "Network error");
      }
    } finally {
      if (activeRef.current && requestId === generationSeq.current) {
        generatingRef.current = false;
        setGenerating(false);
      }
    }
  };

  const runBandit = (): void => {
    if (generating) return;
    if (!canMutate) {
      toast.error("Viewer role can't create A/B tests");
      return;
    }
    if (banditCandidates.length < 3) return;
    onRunBandit(banditCandidates.slice(0, 3));
  };
  const banditUnavailableReason = generating
    ? "Wait for subject generation to finish."
    : !canMutate
      ? "Viewer access cannot create A/B tests."
      : banditCandidates.length < 3
        ? rows.some((row) => row.scoreUnavailable)
          ? "Scoring must succeed before starting an A/B test."
          : "Generate at least three scored variants first."
        : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Subject Lab"
      description={workflowDescription}
    >
      {!seedOk ? (
        <div className="notice" style={{ marginBottom: 12 }}>
          Type at least 10 characters of subject in the draft, then come back to
          seed the lab.
        </div>
      ) : null}

      {seedOk ? (
        <AnalyzerPanel
          analyzer={analyzer}
          error={analyzerErr}
          loading={analyzing}
          onRetry={() => void analyzeSeed()}
        />
      ) : null}

      <LabControls
        axis={axis}
        count={count}
        generateUnavailableReason={generateUnavailableReason}
        generating={generating}
        onAxisChange={setAxis}
        onCountChange={setCount}
        onGenerate={() => void generate()}
      />

      {err ? (
        <div
          className="muted"
          role="alert"
          style={{ fontSize: 12, marginBottom: 8, color: "var(--pw-warning)" }}
        >
          {err}
        </div>
      ) : null}

      {baseline != null && rows.length > 0 ? (
        <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
          Tenant baseline open rate: <strong>{PCT(baseline)}</strong> over the
          last {windowDays} days. Variants with thin matched samples are flagged
          Low confidence.
        </div>
      ) : null}

      <VariantTable
        canMutate={canMutate}
        onPickVariant={onPickVariant}
        rows={sorted}
      />

      <ModalFooter>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
        {banditUnavailableReason ? (
          <span id={banditReasonId} className="muted small" role="status">
            {banditUnavailableReason}
          </span>
        ) : null}
        <button
          type="button"
          className="btn btn-primary"
          aria-disabled={banditUnavailableReason ? "true" : undefined}
          aria-describedby={
            banditUnavailableReason ? banditReasonId : undefined
          }
          onClick={() => {
            if (!banditUnavailableReason) runBandit();
          }}
        >
          {banditActionLabel}
        </button>
      </ModalFooter>
    </Modal>
  );
}
