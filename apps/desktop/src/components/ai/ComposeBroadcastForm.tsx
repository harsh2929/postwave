/**
 * ComposeBroadcastForm — structured "one-shot" broadcast composer.
 *
 * Why this exists alongside the chat:
 *   - "Help me write a broadcast" is a known-shape task (brief → draft +
 *     subject variants). The chat composer was a poor fit because users
 *     had to learn how to phrase the prompt to get the right output
 *     shape; this form removes that guessing.
 *   - Uses the dedicated POST /api/v1/ai/compose/broadcast endpoint
 *     which fans out the draft + N subject variants in parallel server-
 *     side, so the user gets both in one round trip.
 *
 * UX choices:
 *   - Brief is the only required field.
 *   - Tone uses the shared TonePicker so values match across the AI page.
 *   - Audience is free text (the backend accepts a string descriptor —
 *     "VIP subscribers", "users on free plan that opened last 7 days").
 *   - Variant count slider is 1–4, matching the backend cap
 *     (Composer.MaxVariants = 4). Requests are clamped server-side, so a
 *     higher slider would silently return only 4 alternates.
 *   - Output renders inline: primary draft (subject + body + preview)
 *     plus a clickable variant rack. Clicking a variant swaps it into
 *     the primary subject — copies are not destructive (you can swap
 *     back). "Use as draft" hands off to Campaigns.
 */

import { type ReactElement, useEffect, useId, useRef, useState } from "react";

import {
  type AIComposeBroadcastResponse,
  type AIGenerateDraft,
  api,
} from "../../lib/api-client";
import { writeClipboardText } from "../../lib/clipboard";
import { projectAIGeneratedBodyText } from "../../lib/template-handoff";
import { toast } from "../Toast";
import { TonePicker, type Tone } from "./TonePicker";
import "../../styles-postwave-ai-compose.css";

interface Props {
  onUseDraft: (draft: AIGenerateDraft) => void;
  canMutate?: boolean;
}

const MAX_BRIEF_CHARS = 4_000;
const MAX_AUDIENCE_CHARS = 1_000;
const MAX_SUBJECT_CHARS = 500;
const MAX_DRAFT_BODY_CHARS = 200_000;
const MAX_SUBJECT_OPTIONS = 12;
const MAX_BODY_PREVIEW_CHARS = 20_000;
const BODY_PREVIEW_TRUNCATION_NOTICE =
  "[Preview truncated — the complete normalized draft is preserved for copy and handoff.]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(
  value: unknown,
  maximum: number,
  required = false,
): string | null {
  if (typeof value !== "string" || value.length > maximum) return null;
  const normalized = value.trim();
  return required && normalized === "" ? null : value;
}

function normalizeSubjectVariants(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const candidate of value) {
    const subject = boundedString(candidate, MAX_SUBJECT_CHARS, true)?.trim();
    if (!subject) continue;
    const key = subject.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(subject);
    if (output.length >= maximum) break;
  }
  return output;
}

export function normalizeBroadcastResponse(
  value: unknown,
): AIComposeBroadcastResponse | null {
  if (!isRecord(value) || !isRecord(value.primary)) return null;
  const name = boundedString(value.primary.name, 500);
  const subject = boundedString(value.primary.subject, MAX_SUBJECT_CHARS, true);
  const body = boundedString(value.primary.body, MAX_DRAFT_BODY_CHARS, true);
  const preview =
    value.primary.preview_text === undefined
      ? undefined
      : boundedString(value.primary.preview_text, 2_000);
  const safeBody = body === null ? null : projectAIGeneratedBodyText(body);
  if (
    name === null ||
    subject === null ||
    body === null ||
    !safeBody ||
    preview === null
  ) {
    return null;
  }
  const variants = normalizeSubjectVariants(
    [
      subject,
      ...(Array.isArray(value.subject_variants) ? value.subject_variants : []),
    ],
    5,
  );
  const generatedAt = boundedString(value.generated_at, 100);
  return {
    primary: {
      name,
      subject: subject.trim(),
      body: safeBody,
      ...(preview === undefined ? {} : { preview_text: preview }),
    },
    subject_variants: variants,
    ...(generatedAt ? { generated_at: generatedAt } : {}),
  };
}

function readOperationError(error: unknown, fallback: string): string {
  if (!error || typeof error !== "object") return fallback;
  const record = error as Record<string, unknown>;
  const status = typeof record.status === "number" ? record.status : null;
  if (status === 401 || status === 403) {
    return "Your current role cannot run this AI operation.";
  }
  if (status === 408 || status === 504) {
    return "The AI operation timed out before producing a complete result.";
  }
  if (status === 429) {
    return "The AI workspace is at its current request limit. Wait a moment, then retry.";
  }
  if (status !== null && status >= 500) {
    return "The AI service is temporarily unavailable. Retry when it has recovered.";
  }
  return fallback;
}

function useComposeIds() {
  const prefix = useId();
  return {
    brief: `${prefix}-brief`,
    briefCount: `${prefix}-brief-count`,
    audience: `${prefix}-audience`,
    audienceGuidance: `${prefix}-audience-guidance`,
    audienceCount: `${prefix}-audience-count`,
    variants: `${prefix}-variants`,
    guidance: `${prefix}-guidance`,
  };
}

export function ComposeBroadcastForm({
  onUseDraft,
  canMutate = true,
}: Props): ReactElement {
  const [brief, setBrief] = useState<string>("");
  const [tone, setTone] = useState<Tone>("");
  const [audience, setAudience] = useState<string>("");
  const [variantCount, setVariantCount] = useState<number>(3);

  const [result, setResult] = useState<AIComposeBroadcastResponse | null>(null);
  const [activeSubject, setActiveSubject] = useState<string>("");
  const [operation, setOperation] = useState<"compose" | "variants" | null>(
    null,
  );
  const [copyBusy, setCopyBusy] = useState(false);
  const [discardedResponse, setDiscardedResponse] = useState(false);
  const [resultStale, setResultStale] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const operationRef = useRef(false);
  const requestRef = useRef(0);
  const copyRef = useRef(false);
  const onUseDraftRef = useRef(onUseDraft);
  onUseDraftRef.current = onUseDraft;
  const ids = useComposeIds();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  function invalidateRequest(): void {
    requestRef.current += 1;
    if (operationRef.current) setDiscardedResponse(true);
    if (result) setResultStale(true);
    setErr(null);
  }

  async function onSubmit(): Promise<void> {
    if (!canMutate || !brief.trim() || operationRef.current) return;
    operationRef.current = true;
    const requestId = ++requestRef.current;
    const submittedBrief = brief.trim();
    const submittedTone = tone;
    const submittedAudience = audience.trim();
    const submittedVariantCount = variantCount;
    setOperation("compose");
    setDiscardedResponse(false);
    setResultStale(false);
    setErr(null);
    setResult(null);
    let r: Awaited<ReturnType<typeof api.aiComposeBroadcast>>;
    try {
      r = await api.aiComposeBroadcast({
        brief: submittedBrief,
        tone: submittedTone || undefined,
        audience: submittedAudience || undefined,
        variant_count: submittedVariantCount,
      });
    } catch (error) {
      if (mountedRef.current && requestRef.current === requestId) {
        setErr(readOperationError(error, "The compose request failed."));
      }
      return;
    } finally {
      operationRef.current = false;
      if (mountedRef.current) setOperation(null);
    }
    if (!mountedRef.current || requestRef.current !== requestId) return;
    if (r.error) {
      setErr(readOperationError(r.error, "The compose request failed."));
      return;
    }
    const normalized = normalizeBroadcastResponse(r.data);
    if (!normalized) {
      setErr("The AI service returned an incomplete draft. Retry this brief.");
      return;
    }
    setResult(normalized);
    setResultStale(false);
    setActiveSubject(normalized.primary.subject);
  }

  async function onMoreVariants(): Promise<void> {
    if (
      !canMutate ||
      !result ||
      resultStale ||
      result.subject_variants.length >= MAX_SUBJECT_OPTIONS ||
      operationRef.current
    ) {
      return;
    }
    operationRef.current = true;
    const requestId = ++requestRef.current;
    const sourceResult = result;
    setOperation("variants");
    setErr(null);
    let r: Awaited<ReturnType<typeof api.aiComposeVariants>>;
    try {
      r = await api.aiComposeVariants({
        subject: activeSubject || sourceResult.primary.subject,
        body: sourceResult.primary.body,
        variant_count: 3,
      });
    } catch (error) {
      if (mountedRef.current && requestRef.current === requestId) {
        setErr(readOperationError(error, "The variants request failed."));
      }
      return;
    } finally {
      operationRef.current = false;
      if (mountedRef.current) setOperation(null);
    }
    if (!mountedRef.current || requestRef.current !== requestId) return;
    if (r.error) {
      setErr(readOperationError(r.error, "The variants request failed."));
      return;
    }
    const returned = normalizeSubjectVariants(r.data?.subject_variants, 3);
    if (returned.length === 0) {
      setErr("No additional subject variants were returned. Retry when ready.");
      return;
    }
    const merged = normalizeSubjectVariants(
      [...sourceResult.subject_variants, ...returned],
      MAX_SUBJECT_OPTIONS,
    );
    setResult({ ...sourceResult, subject_variants: merged });
  }

  function useAsDraft(): void {
    if (!canMutate || !result || resultStale) return;
    onUseDraftRef.current({
      name: result.primary.name,
      subject: activeSubject || result.primary.subject,
      body: result.primary.body,
      preview_text: result.primary.preview_text,
    });
  }

  async function copyDraft(): Promise<void> {
    if (!result || copyRef.current) return;
    copyRef.current = true;
    setCopyBusy(true);
    try {
      const copyResult = await writeClipboardText(
        `${activeSubject || result.primary.subject}\n\n${result.primary.body}`,
        { contentClass: "personal", label: "AI broadcast draft" },
      );
      if (!mountedRef.current) return;
      if (copyResult.ok) toast.success("Broadcast draft copied");
      else toast.error(copyResult.message);
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          readOperationError(error, "The broadcast draft couldn't be copied."),
        );
      }
    } finally {
      copyRef.current = false;
      if (mountedRef.current) setCopyBusy(false);
    }
  }

  return (
    <div className="card ai-compose-card">
      <ComposeBroadcastHeader />

      <ComposeInputFields
        ids={ids}
        brief={brief}
        tone={tone}
        audience={audience}
        variantCount={variantCount}
        onBriefChange={(value) => {
          invalidateRequest();
          setBrief(value);
        }}
        onToneChange={(value) => {
          invalidateRequest();
          setTone(value);
        }}
        onAudienceChange={(value) => {
          invalidateRequest();
          setAudience(value);
        }}
        onVariantCountChange={(value) => {
          invalidateRequest();
          setVariantCount(value);
        }}
      />

      <div className="ai-compose-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void onSubmit()}
          disabled={operation !== null || !canMutate}
          aria-disabled={!brief.trim() || !canMutate ? true : undefined}
          aria-describedby={ids.guidance}
        >
          {operation === "compose" ? "Composing…" : "Compose"}
        </button>
        {result ? (
          <>
            <button
              type="button"
              className="btn"
              onClick={() => void onMoreVariants()}
              disabled={
                operation !== null ||
                resultStale ||
                !canMutate ||
                result.subject_variants.length >= MAX_SUBJECT_OPTIONS
              }
              aria-describedby={ids.guidance}
            >
              {operation === "variants"
                ? "Generating variants…"
                : result.subject_variants.length >= MAX_SUBJECT_OPTIONS
                  ? "Variant limit reached"
                  : "+ More subject variants"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                invalidateRequest();
                setResult(null);
                setActiveSubject("");
                setErr(null);
                setResultStale(false);
              }}
            >
              Reset
            </button>
          </>
        ) : null}
      </div>

      <ComposeOperationStatus
        id={ids.guidance}
        operation={operation}
        discardedResponse={discardedResponse}
        resultStale={resultStale}
        hasBrief={brief.trim().length > 0}
        canMutate={canMutate}
      />

      {err ? (
        <div role="alert" className="ai-compose-error">
          <span>
            <strong>AI operation failed</strong>
            {err}
          </span>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => void (result ? onMoreVariants() : onSubmit())}
            disabled={!canMutate}
          >
            Retry
          </button>
        </div>
      ) : null}

      {result ? (
        <BroadcastDraftResult
          result={result}
          activeSubject={activeSubject}
          copyBusy={copyBusy}
          stale={resultStale}
          canMutate={canMutate}
          handoffGuidanceId={`${ids.guidance}-handoff`}
          onSubjectChange={setActiveSubject}
          onUseDraft={useAsDraft}
          onCopy={() => void copyDraft()}
        />
      ) : null}
    </div>
  );
}

function ComposeBroadcastHeader(): ReactElement {
  return (
    <div className="ai-compose-header">
      <div>
        <span className="ai-compose-kicker">Structured generation</span>
        <div className="section-title">Compose broadcast</div>
      </div>
      <div className="muted ai-compose-intro">
        Give a one-line brief. Moosewave AI returns a complete draft and subject
        variants.
      </div>
    </div>
  );
}

function ComposeInputFields({
  ids,
  brief,
  tone,
  audience,
  variantCount,
  onBriefChange,
  onToneChange,
  onAudienceChange,
  onVariantCountChange,
}: {
  ids: ReturnType<typeof useComposeIds>;
  brief: string;
  tone: Tone;
  audience: string;
  variantCount: number;
  onBriefChange: (value: string) => void;
  onToneChange: (value: Tone) => void;
  onAudienceChange: (value: string) => void;
  onVariantCountChange: (value: number) => void;
}): ReactElement {
  return (
    <>
      <Field label="Brief" required>
        <textarea
          id={ids.brief}
          rows={3}
          value={brief}
          maxLength={MAX_BRIEF_CHARS}
          onChange={(event) => onBriefChange(event.target.value)}
          aria-describedby={`${ids.guidance} ${ids.briefCount}`}
          placeholder="e.g. Announce our Series B and invite the first 100 customers to an AMA next Wednesday."
          spellCheck
          className="ai-compose-textarea"
        />
        <small
          id={ids.briefCount}
          className="ai-compose-character-count tabular"
        >
          {brief.length.toLocaleString()} / {MAX_BRIEF_CHARS.toLocaleString()}
        </small>
      </Field>

      <div className="ai-compose-input-grid">
        <Field label="Tone">
          <TonePicker value={tone} onChange={onToneChange} />
        </Field>
        <Field label="Audience (optional)">
          <input
            id={ids.audience}
            type="text"
            value={audience}
            maxLength={MAX_AUDIENCE_CHARS}
            onChange={(event) => onAudienceChange(event.target.value)}
            placeholder="e.g. VIPs who opened in last 30d"
            className="ai-compose-input"
            aria-describedby={`${ids.audienceGuidance} ${ids.audienceCount}`}
          />
          <span className="ai-compose-field-meta">
            <small id={ids.audienceGuidance} className="ai-compose-field-hint">
              Describe a cohort; do not paste subscriber records or address
              lists.
            </small>
            <small
              id={ids.audienceCount}
              className="ai-compose-character-count tabular"
            >
              {audience.length.toLocaleString()} /{" "}
              {MAX_AUDIENCE_CHARS.toLocaleString()}
            </small>
          </span>
        </Field>
      </div>

      <Field label={`Variants: ${variantCount}`}>
        <input
          id={ids.variants}
          type="range"
          min={1}
          max={4}
          value={variantCount}
          onChange={(event) =>
            onVariantCountChange(Number.parseInt(event.target.value, 10))
          }
          className="ai-compose-range"
        />
        <span className="ai-compose-range-meta" aria-hidden="true">
          <span>1 focused option</span>
          <span>4 broader options</span>
        </span>
      </Field>
    </>
  );
}

function ComposeOperationStatus({
  id,
  operation,
  discardedResponse,
  resultStale,
  hasBrief,
  canMutate,
}: {
  id: string;
  operation: "compose" | "variants" | null;
  discardedResponse: boolean;
  resultStale: boolean;
  hasBrief: boolean;
  canMutate: boolean;
}): ReactElement {
  const message = !canMutate
    ? "View-only access. Ask a workspace editor or admin to run AI generation and hand off a draft."
    : operation === "compose"
      ? "Generating a draft from the submitted brief. Editing inputs discards that response."
      : operation === "variants"
        ? "Generating additional subjects for the current draft."
        : discardedResponse
          ? "Inputs changed while AI was working, so its stale response was discarded. Compose again when ready."
          : resultStale
            ? "Inputs changed after this draft was generated. The preserved result reflects earlier inputs; compose again before handoff."
            : hasBrief
              ? "Ready to compose. Nothing is created or sent until you choose Use as draft."
              : "Add a brief before composing. Nothing is created or sent until you choose Use as draft.";
  return (
    <div
      id={id}
      className="muted ai-compose-status"
      role="status"
      aria-live="polite"
      data-tone={!canMutate ? "permission" : resultStale ? "stale" : undefined}
    >
      {message}
    </div>
  );
}

function BroadcastDraftResult({
  result,
  activeSubject,
  copyBusy,
  stale,
  canMutate,
  handoffGuidanceId,
  onSubjectChange,
  onUseDraft,
  onCopy,
}: {
  result: AIComposeBroadcastResponse;
  activeSubject: string;
  copyBusy: boolean;
  stale: boolean;
  canMutate: boolean;
  handoffGuidanceId: string;
  onSubjectChange: (subject: string) => void;
  onUseDraft: () => void;
  onCopy: () => void;
}): ReactElement {
  return (
    <section
      className="ai-compose-result"
      aria-label="Generated broadcast draft"
    >
      <div className="ai-compose-result-header">
        <div>
          <span className="badge accent">AI-generated</span>
          <strong>Review before using</strong>
        </div>
        <span className={stale ? "badge warning" : "badge success"}>
          {stale ? "Earlier inputs" : "Current inputs"}
        </span>
      </div>
      <fieldset className="ai-compose-subjects">
        <legend>Subject — choose one variant</legend>
        {result.subject_variants.map((subject, index) => {
          const selected = activeSubject === subject;
          return (
            <button
              key={`${index}-${subject}`}
              type="button"
              className="chip ai-compose-subject"
              onClick={() => onSubjectChange(subject)}
              aria-pressed={selected}
              data-selected={selected ? "true" : undefined}
            >
              {index === 0 ? "Primary: " : ""}
              {subject}
            </button>
          );
        })}
      </fieldset>
      {result.primary.preview_text ? (
        <div>
          <div className="muted ai-compose-output-label">Preview text</div>
          <div className="ai-compose-preview">
            {result.primary.preview_text}
          </div>
        </div>
      ) : null}
      <div>
        <div className="muted ai-compose-output-label">
          Body preview · formatting normalized for safety
        </div>
        <div className="ai-compose-body">
          {emailBodyPreview(result.primary.body)}
        </div>
        <p className="ai-compose-safety-note">
          AI-authored markup, links, images, forms, and active elements are
          removed before campaign handoff. Add verified destinations and final
          formatting in Campaigns.
        </p>
      </div>
      <div className="ai-card-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={onUseDraft}
          disabled={!canMutate || stale}
          aria-describedby={stale ? handoffGuidanceId : undefined}
        >
          Use as draft → Campaigns
        </button>
        <button
          type="button"
          className="btn"
          onClick={onCopy}
          disabled={copyBusy}
        >
          {copyBusy ? "Copying…" : "Copy"}
        </button>
        {stale ? (
          <span id={handoffGuidanceId} className="ai-compose-action-note">
            Compose again to hand off a result bound to the current inputs.
          </span>
        ) : null}
      </div>
    </section>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}): ReactElement {
  return (
    <label className="ai-compose-field">
      <span className="ai-compose-field-label">
        {label}
        {required ? <span className="ai-compose-required"> *</span> : null}
      </span>
      {children}
    </label>
  );
}

function boundBodyPreview(value: string): string {
  if (value.length <= MAX_BODY_PREVIEW_CHARS) return value;
  return `${value.slice(0, MAX_BODY_PREVIEW_CHARS).trimEnd()}\n\n${BODY_PREVIEW_TRUNCATION_NOTICE}`;
}

/**
 * Bounded plain-text projection for model-authored email HTML.
 *
 * Result normalization, copy, campaign handoff, and this preview all use this
 * inert-text boundary. The preview adds only a display length cap and never
 * injects model HTML into the DOM.
 */
export function emailBodyPreview(value: string): string {
  return boundBodyPreview(projectAIGeneratedBodyText(value));
}
