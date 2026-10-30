/**
 * SubjectLineAssistant — Klaviyo-style "AI Subject Line Assistant" drawer
 * for the campaign compose form. Implements gap
 * `sto-ai-copywriter-subject-lines`.
 *
 * Three sections, top → bottom:
 *
 *   1. Brief input (prompt + tone + target_audience).
 *      Operator describes what they're promoting in 1-2 sentences plus
 *      optional tone and recipient cohort. Submitting POSTs to the
 *      new /api/v1/ai/subject-lines/generate endpoint.
 *
 *   2. Generated candidates (default 3).
 *      Each candidate has "Use this" (set as primary subject) and
 *      "Auto-populate A/B" (replace all candidates as the A/B variant
 *      set on the parent form). The "Auto-populate A/B" button only
 *      shows when the parent passed an onAutoPopulateAB callback.
 *
 *   3. Top performers panel (last 90 days).
 *      Lazy-loaded from /api/v1/ai/subject-lines/top-performers. The
 *      operator can "Use this" any historical subject to reuse the
 *      pattern that worked on their own list. Loads on first mount of
 *      this component (cheap GET, single tenant-scoped query).
 *
 * Differs from the existing SubjectLineSuggestions component:
 *   - SubjectLineSuggestions streams variants from an existing typed
 *     subject in the input box (inline, in-form). It's "polish what
 *     I typed" UX.
 *   - SubjectLineAssistant takes a free-form BRIEF (no seed subject
 *     required) and surfaces top-performers as inspiration. It's
 *     "start from scratch" UX — same pattern Klaviyo / Mailchimp
 *     Subject Line Helper / Braze AI Copywriting ship.
 *
 * Honest-fallback policy: when the generate endpoint returns
 * fallback=true the assistant renders an unobtrusive note that the
 * operator should review the brief-derived placeholders before sending.
 * Top-performers errors degrade gracefully — the panel hides itself
 * rather than blocking the generate flow.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  type AISubjectLinesGenerateResponse,
  type AISubjectLinesTopPerformer,
  type SubjectBucketsResponse,
  type SubjectScoreResponse,
  api,
  subjectAnalyzerApi,
} from "../lib/api-client";
import { TonePicker, type Tone } from "./ai/TonePicker";
import {
  bucketValueLabel,
  formatRate,
  groupSubjectBuckets,
  scoreSummaryLine,
} from "./subject-analyzer-helpers";

interface Props {
  /** Called when the operator picks a single candidate (or top-performer).
   *  The parent applies the text to the subject input. */
  onPickSubject: (subject: string) => void;
  /** Optional: called with the full candidate set when the operator
   *  clicks "Auto-populate A/B". When omitted, the button is hidden
   *  (older callers stay backwards compatible). The parent decides how
   *  to wire it into the A/B test create flow — see Campaigns.tsx. */
  onAutoPopulateAB?: (variants: string[]) => void;
  /** Optional close handler — when set, renders an "x" close button in
   *  the header so the assistant can live in a dismissable drawer. */
  onClose?: () => void;
}

const MAX_VARIANTS = 5;
const MIN_PROMPT_CHARS = 3;

function readOperationError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}

function CandidateScore({
  score,
}: {
  score: SubjectScoreResponse;
}): ReactElement {
  return (
    <div className="muted ai-subject-score" style={{ fontSize: 10 }}>
      <span>{scoreSummaryLine(score)}</span>
      {score.suggestions.length > 0 ? (
        <ul aria-label="Subject analyzer suggestions">
          {score.suggestions.map((suggestion, index) => (
            <li key={`${index}-${suggestion}`}>{suggestion}</li>
          ))}
        </ul>
      ) : (
        <span>No analyzer changes suggested.</span>
      )}
    </div>
  );
}

export function SubjectLineAssistant({
  onPickSubject,
  onAutoPopulateAB,
  onClose,
}: Props): ReactElement {
  const [prompt, setPrompt] = useState<string>("");
  const [tone, setTone] = useState<Tone>("");
  const [audience, setAudience] = useState<string>("");
  const [variantCount, setVariantCount] = useState<number>(3);

  const [candidates, setCandidates] = useState<string[]>([]);
  const [fallback, setFallback] = useState<boolean>(false);
  const [generating, setGenerating] = useState<boolean>(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const [topPerformers, setTopPerformers] = useState<
    AISubjectLinesTopPerformer[] | null
  >(null);
  const [topErr, setTopErr] = useState<string | null>(null);
  const [topRetryNonce, setTopRetryNonce] = useState(0);

  // Full-surface wiring #8: heuristic analyzer scores per generated
  // candidate (POST /subject-analyzer/score) keyed by candidate text,
  // plus the historical attribute buckets (GET /subject-analyzer/
  // buckets) rendered as a collapsible reference table.
  const [scores, setScores] = useState<Record<string, SubjectScoreResponse>>(
    {},
  );
  const [scoresErr, setScoresErr] = useState<string | null>(null);
  const [buckets, setBuckets] = useState<SubjectBucketsResponse | null>(null);
  const [bucketsErr, setBucketsErr] = useState<string | null>(null);
  const [bucketsOpen, setBucketsOpen] = useState(false);
  const [bucketsRetryNonce, setBucketsRetryNonce] = useState(0);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const generatingRef = useRef(false);
  const generateStatusId = useId();
  const bucketsId = useId();
  const fieldPrefix = useId();
  const promptId = `${fieldPrefix}-prompt`;
  const audienceId = `${fieldPrefix}-audience`;
  const countId = `${fieldPrefix}-count`;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      generatingRef.current = false;
    };
  }, []);

  // Lazy-load top performers on mount. Done once per component instance —
  // if the operator closes + reopens the drawer the parent unmounts/
  // remounts and we refetch (cheap GET).
  useEffect(() => {
    let cancelled = false;
    setTopErr(null);
    setTopPerformers(null);
    void (async () => {
      let r: Awaited<ReturnType<typeof api.aiSubjectLinesTopPerformers>>;
      try {
        r = await api.aiSubjectLinesTopPerformers({
          days: 90,
          limit: 8,
          min_recipients: 20,
        });
      } catch (error) {
        if (!cancelled) {
          setTopErr(readOperationError(error, "The request failed."));
          setTopPerformers([]);
        }
        return;
      }
      if (cancelled) return;
      if (r.error) {
        setTopErr(r.error.message);
        return;
      }
      setTopPerformers(r.data?.top ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [topRetryNonce]);

  // Historical attribute buckets — one cheap GET per mount.
  useEffect(() => {
    let cancelled = false;
    setBucketsErr(null);
    setBuckets(null);
    void (async () => {
      let r: Awaited<ReturnType<typeof subjectAnalyzerApi.buckets>>;
      try {
        r = await subjectAnalyzerApi.buckets();
      } catch (error) {
        if (!cancelled) {
          setBucketsErr(readOperationError(error, "The request failed."));
        }
        return;
      }
      if (cancelled) return;
      if (r.error) {
        setBucketsErr(r.error.message);
        return;
      }
      setBuckets(r.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [bucketsRetryNonce]);

  /** Score each candidate against the tenant's history. Heuristic
   *  endpoint (not LLM) so a small parallel burst is fine. Failures
   *  degrade to one inline note — scores must never block the
   *  generate flow. */
  const scoreCandidates = useCallback(
    async (texts: string[], requestId: number): Promise<void> => {
      setScores({});
      setScoresErr(null);
      if (texts.length === 0) return;
      const results = await Promise.all(
        texts.map(async (text) => {
          try {
            return await subjectAnalyzerApi.score(text);
          } catch (error) {
            return {
              error: {
                message: readOperationError(error, "Scoring failed."),
              },
            };
          }
        }),
      );
      if (!mountedRef.current || generationRef.current !== requestId) return;
      const next: Record<string, SubjectScoreResponse> = {};
      let firstErr: string | null = null;
      results.forEach((r, i) => {
        if (r.error) {
          if (!firstErr) firstErr = r.error.message;
          return;
        }
        next[texts[i]!] = r.data;
      });
      setScores(next);
      if (firstErr && Object.keys(next).length === 0) {
        setScoresErr(firstErr);
      }
    },
    [],
  );

  const canGenerate = prompt.trim().length >= MIN_PROMPT_CHARS && !generating;

  const invalidateGeneratedResponse = useCallback((): void => {
    generationRef.current += 1;
    generatingRef.current = false;
    setGenerating(false);
    setCandidates([]);
    setScores({});
    setScoresErr(null);
    setFallback(false);
    setErrMsg(null);
  }, []);

  const onGenerate = useCallback(async (): Promise<void> => {
    const trimmed = prompt.trim();
    if (trimmed.length < MIN_PROMPT_CHARS || generatingRef.current) return;
    generatingRef.current = true;
    const requestId = ++generationRef.current;
    setGenerating(true);
    setErrMsg(null);
    setCandidates([]);
    setFallback(false);
    let r: Awaited<ReturnType<typeof api.aiSubjectLinesGenerate>>;
    try {
      r = await api.aiSubjectLinesGenerate({
        prompt: trimmed,
        tone: tone || undefined,
        target_audience: audience.trim() || undefined,
        variant_count: variantCount,
      });
    } catch (error) {
      if (mountedRef.current && generationRef.current === requestId) {
        setErrMsg(readOperationError(error, "The generation request failed."));
      }
      return;
    } finally {
      if (generationRef.current === requestId) generatingRef.current = false;
      if (mountedRef.current && generationRef.current === requestId) {
        setGenerating(false);
      }
    }
    if (!mountedRef.current || generationRef.current !== requestId) return;
    if (r.error) {
      setErrMsg(r.error.message);
      return;
    }
    const d: AISubjectLinesGenerateResponse | undefined = r.data;
    const generated = Array.from(
      new Set(
        (d?.candidates ?? [])
          .map((candidate) => candidate.trim())
          .filter(Boolean),
      ),
    );
    if (generated.length === 0) {
      setErrMsg(
        "The AI service returned no usable candidates. Retry the brief.",
      );
      return;
    }
    setCandidates(generated);
    setFallback(Boolean(d?.fallback));
    void scoreCandidates(generated, requestId);
  }, [prompt, tone, audience, variantCount, scoreCandidates]);

  return (
    <section
      className="ai-subject-assistant"
      aria-label="AI subject-line assistant"
    >
      <header className="ai-suggestions-header" style={{ marginBottom: 8 }}>
        <span className="ai-banner-icon" aria-hidden="true">
          ✦
        </span>
        <span className="ai-suggestions-title">AI subject-line assistant</span>
        <span className="spacer" style={{ flex: 1 }} />
        {onClose ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={onClose}
            aria-label="Close subject-line assistant"
          >
            Close
          </button>
        ) : null}
      </header>

      <SubjectBriefForm
        prompt={prompt}
        tone={tone}
        audience={audience}
        variantCount={variantCount}
        generating={generating}
        canGenerate={canGenerate}
        error={errMsg}
        promptId={promptId}
        audienceId={audienceId}
        countId={countId}
        statusId={generateStatusId}
        onPromptChange={(value) => {
          invalidateGeneratedResponse();
          setPrompt(value);
        }}
        onToneChange={(value) => {
          invalidateGeneratedResponse();
          setTone(value);
        }}
        onAudienceChange={(value) => {
          invalidateGeneratedResponse();
          setAudience(value);
        }}
        onVariantCountChange={(value) => {
          invalidateGeneratedResponse();
          setVariantCount(value);
        }}
        onGenerate={() => void onGenerate()}
      />
      <GeneratedCandidates
        candidates={candidates}
        fallback={fallback}
        scores={scores}
        scoresError={scoresErr}
        onPickSubject={onPickSubject}
        onAutoPopulateAB={onAutoPopulateAB}
      />
      <HistoricalBuckets
        buckets={buckets}
        error={bucketsErr}
        open={bucketsOpen}
        contentId={bucketsId}
        onToggle={() => setBucketsOpen((value) => !value)}
        onRetry={() => setBucketsRetryNonce((value) => value + 1)}
      />
      <TopPerformersPanel
        rows={topPerformers}
        error={topErr}
        onPickSubject={onPickSubject}
        onRetry={() => setTopRetryNonce((value) => value + 1)}
      />
    </section>
  );
}

function SubjectBriefForm({
  prompt,
  tone,
  audience,
  variantCount,
  generating,
  canGenerate,
  error,
  promptId,
  audienceId,
  countId,
  statusId,
  onPromptChange,
  onToneChange,
  onAudienceChange,
  onVariantCountChange,
  onGenerate,
}: {
  prompt: string;
  tone: Tone;
  audience: string;
  variantCount: number;
  generating: boolean;
  canGenerate: boolean;
  error: string | null;
  promptId: string;
  audienceId: string;
  countId: string;
  statusId: string;
  onPromptChange: (value: string) => void;
  onToneChange: (value: Tone) => void;
  onAudienceChange: (value: string) => void;
  onVariantCountChange: (value: number) => void;
  onGenerate: () => void;
}): ReactElement {
  return (
    <div className="ai-subject-assistant-brief">
      <label htmlFor={promptId} className="form-label">
        What is this email about?
        <span className="muted ai-subject-label-detail">
          the brief — 1–2 sentences
        </span>
      </label>
      <textarea
        id={promptId}
        className="input"
        rows={3}
        maxLength={2048}
        placeholder="Announce our Black Friday sale — 50% off everything for 48 hours."
        value={prompt}
        onChange={(event) => onPromptChange(event.target.value)}
        aria-describedby={statusId}
      />
      <div>
        <span className="form-label">Tone</span>
        <TonePicker value={tone} onChange={onToneChange} />
      </div>
      <label htmlFor={audienceId} className="form-label">
        Target audience (optional)
      </label>
      <input
        id={audienceId}
        type="text"
        className="input"
        maxLength={300}
        placeholder="VIP subscribers, paid annual users…"
        value={audience}
        onChange={(event) => onAudienceChange(event.target.value)}
      />
      <label htmlFor={countId} className="form-label ai-subject-count-label">
        <span>Number of options</span>
        <input
          id={countId}
          type="range"
          min={1}
          max={MAX_VARIANTS}
          step={1}
          value={variantCount}
          onChange={(event) =>
            onVariantCountChange(
              Math.max(
                1,
                Math.min(MAX_VARIANTS, Number(event.target.value) || 3),
              ),
            )
          }
        />
        <span className="muted tabular">{variantCount}</span>
      </label>
      <div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onGenerate}
          disabled={generating}
          aria-disabled={!canGenerate && !generating ? true : undefined}
          aria-describedby={statusId}
        >
          {generating ? "Generating…" : "Generate"}
        </button>
      </div>
      <div
        id={statusId}
        className="muted"
        style={{ fontSize: 11 }}
        role="status"
        aria-live="polite"
      >
        {generating
          ? "Generating candidates from this exact brief, tone, and audience…"
          : prompt.trim().length < MIN_PROMPT_CHARS
            ? `Add at least ${MIN_PROMPT_CHARS} characters to the brief before generating.`
            : "Ready to generate. Your brief is sent to the configured AI service."}
      </div>
      {error ? (
        <div role="alert" className="notice" style={{ fontSize: 12 }}>
          <span>AI subject-line generation failed: {error}</span>{" "}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onGenerate}
          >
            Retry
          </button>
        </div>
      ) : null}
    </div>
  );
}

function GeneratedCandidates({
  candidates,
  fallback,
  scores,
  scoresError,
  onPickSubject,
  onAutoPopulateAB,
}: {
  candidates: string[];
  fallback: boolean;
  scores: Record<string, SubjectScoreResponse>;
  scoresError: string | null;
  onPickSubject: (subject: string) => void;
  onAutoPopulateAB?: (variants: string[]) => void;
}): ReactElement | null {
  if (candidates.length === 0) return null;
  return (
    <div
      className="ai-subject-assistant-candidates"
      role="region"
      aria-label="Generated candidates"
    >
      <div className="ai-suggestions-title">
        {candidates.length} candidate{candidates.length === 1 ? "" : "s"}
      </div>
      {fallback ? (
        <div role="note" className="muted ai-subject-fallback">
          AI partial — some candidates were derived from your brief. Review
          every candidate before sending.
        </div>
      ) : null}
      <ul className="ai-suggestions-list">
        {candidates.map((text, index) => (
          <li
            key={`${index}-${text}`}
            className="ai-suggestion-row"
            data-testid={`subject-candidate-${index}`}
          >
            <span className="ai-suggestion-index">{index + 1}.</span>
            <div className="ai-suggestion-text">
              <span>{text}</span>
              {scores[text] ? <CandidateScore score={scores[text]!} /> : null}
            </div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onPickSubject(text)}
            >
              Use this
            </button>
          </li>
        ))}
      </ul>
      {scoresError ? (
        <div className="muted" role="status" style={{ fontSize: 11 }}>
          Subject analyzer unavailable: {scoresError}. Candidate selection is
          still available.
        </div>
      ) : null}
      {onAutoPopulateAB && candidates.length >= 2 ? (
        <button
          type="button"
          className="btn btn-sm ai-subject-ab-action"
          onClick={() => onAutoPopulateAB(candidates)}
        >
          Auto-populate A/B variants ({candidates.length})
        </button>
      ) : null}
    </div>
  );
}

function HistoricalBuckets({
  buckets,
  error,
  open,
  contentId,
  onToggle,
  onRetry,
}: {
  buckets: SubjectBucketsResponse | null;
  error: string | null;
  open: boolean;
  contentId: string;
  onToggle: () => void;
  onRetry: () => void;
}): ReactElement {
  return (
    <div
      className="ai-subject-assistant-buckets"
      role="region"
      aria-label="Historical subject-line performance by attribute"
    >
      <div className="ai-suggestions-title ai-subject-section-heading">
        <span>What works on your list</span>
        {buckets && buckets.campaigns_total > 0 ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls={contentId}
          >
            {open ? "Hide details" : "Show details"}
          </button>
        ) : null}
      </div>
      {error ? (
        <div className="muted" role="status" style={{ fontSize: 11 }}>
          Historical buckets unavailable: {error}{" "}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onRetry}
          >
            Retry history
          </button>
        </div>
      ) : buckets == null ? (
        <div className="muted" role="status" style={{ fontSize: 12 }}>
          Loading history…
        </div>
      ) : buckets.campaigns_total === 0 ? (
        <div id={contentId} className="muted" style={{ fontSize: 12 }}>
          No sent campaigns in the last {buckets.window_days} days. Performance
          patterns appear after your first eligible sends.
        </div>
      ) : open ? (
        <div id={contentId} className="ai-subject-bucket-details">
          <div className="muted" style={{ fontSize: 11 }}>
            {buckets.campaigns_total} campaigns over the last{" "}
            {buckets.window_days} days, bucketed by subject attribute.
          </div>
          {groupSubjectBuckets(buckets.buckets).map((group) => (
            <div key={group.attribute} className="ai-subject-table-scroll">
              <table className="link-table">
                <caption>{group.label} subject performance</caption>
                <thead>
                  <tr>
                    <th scope="col">Attribute</th>
                    <th scope="col">Sample</th>
                    <th scope="col">Open rate</th>
                    <th scope="col">Click rate</th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((row) => (
                    <tr key={`${row.attribute}-${row.bucket}`}>
                      <th scope="row">{bucketValueLabel(row.bucket)}</th>
                      <td className="muted">
                        {row.campaigns} campaign
                        {row.campaigns === 1 ? "" : "s"}
                      </td>
                      <td className="tabular">{formatRate(row.open_rate)}</td>
                      <td className="tabular">{formatRate(row.click_rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      ) : (
        <div id={contentId} className="muted" style={{ fontSize: 12 }}>
          Open and click rates from {buckets.campaigns_total} campaigns, grouped
          by length, emoji, question, personalization, and all caps.
        </div>
      )}
    </div>
  );
}

function TopPerformersPanel({
  rows,
  error,
  onPickSubject,
  onRetry,
}: {
  rows: AISubjectLinesTopPerformer[] | null;
  error: string | null;
  onPickSubject: (subject: string) => void;
  onRetry: () => void;
}): ReactElement {
  return (
    <div
      className="ai-subject-assistant-top"
      role="region"
      aria-label="Top-performing subject lines from last 90 days"
    >
      <div className="ai-suggestions-title ai-subject-section-heading">
        Your top performers (last 90 days)
      </div>
      {error ? (
        <div className="muted" role="status" style={{ fontSize: 11 }}>
          Top performers unavailable: {error}{" "}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onRetry}
          >
            Retry top performers
          </button>
        </div>
      ) : rows === null ? (
        <div className="muted" role="status" style={{ fontSize: 12 }}>
          Loading top performers…
        </div>
      ) : rows.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>
          No sent campaigns in the last 90 days with at least 20 recipients.
          Eligible top performers appear here after you send.
        </div>
      ) : (
        <ul className="ai-suggestions-list">
          {rows.map((row) => (
            <li
              key={row.campaign_id}
              className="ai-suggestion-row"
              data-testid={`top-performer-${row.campaign_id}`}
            >
              <span className="ai-suggestion-index">
                {formatRate(row.open_rate)}
              </span>
              <span className="ai-suggestion-text">
                <span>{row.subject}</span>
                <span className="muted ai-subject-performance-detail">
                  {row.name ? `${row.name} · ` : ""}
                  {row.recipients.toLocaleString()} recipients ·{" "}
                  {formatRate(row.click_rate)} click
                </span>
              </span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => onPickSubject(row.subject)}
              >
                Use this
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
