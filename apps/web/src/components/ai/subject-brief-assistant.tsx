// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * "Start from a brief" subject-line assistant (desktop SubjectLineAssistant
 * parity): describe the email, pick a tone and audience, and get candidates
 * — each graded by the subject analyzer against this workspace's history —
 * beside the attribute buckets ("what works on your list") and the last 90
 * days' top performers.
 *
 * Differs from the rail's "Subject ideas", which polish the subject already
 * typed: this one needs no subject at all.
 *
 * Server gates, mirrored so nothing 403s by surprise: generating and the
 * per-candidate analyzer are owner/admin; buckets and top performers are any
 * signed-in role. An analyzer expectation with no matched history is shown as
 * "no basis to predict", never as a 0% forecast.
 */
import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";

import { AI_DISCLOSURE_TEXT } from "@postwave/ai-disclosure";

import { AI_TONE_OPTIONS, isAiTone, type AiTone } from "@/components/ai/TonePicker";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  AI_UNAVAILABLE_MESSAGE,
  generateSubjectLines,
  getTopPerformingSubjects,
} from "@/lib/ai-compose-api";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import {
  getSubjectBuckets,
  subjectEmptiness,
  type SubjectBucket,
} from "@/lib/content-quality-api";
import {
  expectationsUnfounded,
  scoreSubject,
  type SubjectScore,
} from "@/lib/preflight-api";
import { base, qk, STALE, type RoleKey } from "@/lib/query-keys";
import { roleCanWrite } from "@/lib/use-admin-gate";

const MIN_BRIEF = 3;

function rate(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${(value * 100).toFixed(1)}%`
    : "—";
}

function label(value: string | undefined): string {
  return (value ?? "").replace(/_/gu, " ") || "—";
}

function groupBuckets(buckets: SubjectBucket[]): Array<[string, SubjectBucket[]]> {
  const groups = new Map<string, SubjectBucket[]>();
  for (const bucket of buckets) {
    const key = bucket.attribute ?? "other";
    groups.set(key, [...(groups.get(key) ?? []), bucket]);
  }
  return [...groups.entries()];
}

type ScoreState =
  | { status: "ok"; score: SubjectScore }
  | { status: "error"; message: string };

export interface SubjectBriefAssistantProps {
  tenantId: string;
  role: RoleKey;
  /** Owner/admin outside viewer mode: generation and the analyzer. */
  canGenerate: boolean;
  generateBlockedReason: string;
  /** Replace the editor's subject. Omitted → no "Use" action is offered. */
  onUseSubject?: (subject: string) => void;
  /** Hand every candidate to an A/B variant set (create dialog). */
  onUseAllAsVariants?: (subjects: string[]) => void;
}

export function SubjectBriefAssistant({
  tenantId,
  role,
  canGenerate,
  generateBlockedReason,
  onUseSubject,
  onUseAllAsVariants,
}: SubjectBriefAssistantProps) {
  const id = useId();
  const [brief, setBrief] = useState("");
  const [tone, setTone] = useState<AiTone>("");
  const [audience, setAudience] = useState("");
  const [count, setCount] = useState(3);
  const [generating, setGenerating] = useState(false);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [fallback, setFallback] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scores, setScores] = useState<Record<string, ScoreState>>({});
  const [bucketsOpen, setBucketsOpen] = useState(false);
  const generation = useRef(0);

  const buckets = useQuery({
    queryKey: [...base("subject-analyzer-buckets", tenantId, role)],
    queryFn: getSubjectBuckets,
    staleTime: STALE.reference,
  });
  const topKey = useMemo(
    () => [...base("ai-subject-top-performers", tenantId, role), 90, 20] as const,
    [role, tenantId],
  );
  const top = useQuery({
    queryKey: topKey,
    queryFn: ({ signal }) =>
      getTopPerformingSubjects({ days: 90, limit: 8, minRecipients: 20, signal }),
    staleTime: STALE.reference,
  });

  function reset() {
    generation.current += 1;
    setGenerating(false);
    setCandidates([]);
    setFallback(false);
    setError(null);
    setScores({});
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = brief.trim();
    if (!canGenerate || prompt.length < MIN_BRIEF || generating) return;
    const token = ++generation.current;
    setGenerating(true);
    setError(null);
    setCandidates([]);
    setScores({});
    try {
      const outcome = await generateSubjectLines(prompt, {
        tone: tone || undefined,
        targetAudience: audience.trim() || undefined,
        variantCount: count,
      });
      if (token !== generation.current) return;
      if (!outcome.ok) {
        setError(AI_UNAVAILABLE_MESSAGE);
        return;
      }
      const generated = Array.from(
        new Set(outcome.value.candidates.map((line) => line.trim()).filter(Boolean)),
      );
      if (generated.length === 0) {
        setError("The AI service returned no usable candidates. Retry the brief.");
        return;
      }
      setCandidates(generated);
      setFallback(outcome.value.fallback);
      setGenerating(false);
      // Heuristic, not LLM: a small parallel burst. A failed score never
      // withdraws the candidate it was grading.
      const settled = await Promise.allSettled(
        generated.map((line) => scoreSubject(line)),
      );
      if (token !== generation.current) return;
      const next: Record<string, ScoreState> = {};
      settled.forEach((entry, index) => {
        next[generated[index]!] =
          entry.status === "fulfilled"
            ? { status: "ok", score: entry.value }
            : {
                status: "error",
                message: apiErrorMessage(entry.reason, "The analyzer did not answer."),
              };
      });
      setScores(next);
    } catch (cause) {
      if (token !== generation.current) return;
      setError(apiErrorMessage(cause, "Subject lines could not be generated."));
    } finally {
      if (token === generation.current) setGenerating(false);
    }
  }

  const promptShort = brief.trim().length < MIN_BRIEF;
  const bucketList = buckets.data?.buckets;
  const bucketRows = Array.isArray(bucketList) ? bucketList : [];
  const topList = top.data?.top;
  const topRows = Array.isArray(topList) ? topList : [];

  return (
    <div className="space-y-4" data-testid="subject-brief-assistant">
      <form noValidate className="space-y-3" onSubmit={(event) => void submit(event)}>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-brief`}>What is this email about?</Label>
          <Textarea
            id={`${id}-brief`}
            rows={3}
            maxLength={2048}
            value={brief}
            disabled={!canGenerate}
            placeholder="Announce our autumn sale — 30% off everything for 48 hours."
            aria-describedby={`${id}-status`}
            onChange={(event) => {
              reset();
              setBrief(event.target.value);
            }}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-tone`}>Tone</Label>
            <Select
              id={`${id}-tone`}
              value={tone}
              disabled={!canGenerate}
              onChange={(event) => {
                if (!isAiTone(event.target.value)) return;
                reset();
                setTone(event.target.value);
              }}
            >
              {AI_TONE_OPTIONS.map((option) => (
                <option key={option.value || "auto"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-audience`}>Audience (optional)</Label>
            <Input
              id={`${id}-audience`}
              maxLength={500}
              value={audience}
              disabled={!canGenerate}
              placeholder="VIP subscribers"
              onChange={(event) => {
                reset();
                setAudience(event.target.value);
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-count`}>Options</Label>
            <Select
              id={`${id}-count`}
              value={String(count)}
              disabled={!canGenerate}
              onChange={(event) => {
                reset();
                setCount(Number(event.target.value));
              }}
            >
              {[1, 2, 3, 4, 5].map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            size="sm"
            loading={generating}
            disabled={!canGenerate || promptShort}
            aria-describedby={`${id}-status`}
          >
            {generating ? "Generating…" : "Generate from brief"}
          </Button>
          <span id={`${id}-status`} className="text-xs text-muted-foreground">
            {!canGenerate
              ? generateBlockedReason
              : promptShort
                ? `Add at least ${MIN_BRIEF} characters to the brief.`
                : "Your brief, tone and audience are sent to the configured AI service."}
          </span>
        </div>
      </form>

      <div aria-live="polite" className="space-y-2">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {candidates.length > 0 ? (
          <>
            {fallback ? (
              <p role="note" className="text-xs text-muted-foreground">
                AI partial — some candidates were derived from your brief
                without the model. Review every candidate before sending.
              </p>
            ) : null}
            <ul
              aria-label="Subject candidates from the brief"
              className="divide-y rounded-lg border"
              data-testid="brief-candidates"
            >
              {candidates.map((line) => {
                const score = scores[line];
                return (
                  <li key={line} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium">{line}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {!score
                          ? "Scoring against your history…"
                          : score.status === "error"
                            ? `Analyzer unavailable: ${score.message}`
                            : expectationsUnfounded(score.score)
                              ? "No sent history matches this subject's attributes — no basis to predict opens or clicks."
                              : `Expected open ${rate(score.score.expected_open)} · click ${rate(score.score.expected_click)} · from ${score.score.matched_history.toLocaleString()} matching campaigns`}
                      </p>
                      {score?.status === "ok" && score.score.suggestions.length > 0 ? (
                        <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground">
                          {score.score.suggestions.map((suggestion) => (
                            <li key={suggestion}>{suggestion}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                    {onUseSubject ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-label={`Use “${line}” as the subject`}
                        onClick={() => onUseSubject(line)}
                      >
                        Use this
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {onUseAllAsVariants && candidates.length >= 2 ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onUseAllAsVariants(candidates)}
              >
                Use all {candidates.length} as A/B variants
              </Button>
            ) : null}
            <p className="text-[11px] leading-tight text-muted-foreground">
              {AI_DISCLOSURE_TEXT}
            </p>
          </>
        ) : null}
      </div>

      <section aria-labelledby={`${id}-buckets`} className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 id={`${id}-buckets`} className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            What works on your list
          </h4>
          {buckets.data && subjectEmptiness(buckets.data) === "has-buckets" ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-expanded={bucketsOpen}
              aria-controls={`${id}-bucket-details`}
              onClick={() => setBucketsOpen((open) => !open)}
            >
              {bucketsOpen ? "Hide details" : "Show details"}
            </Button>
          ) : null}
        </div>
        {buckets.isPending ? (
          <p role="status" className="text-xs text-muted-foreground">
            Loading history…
          </p>
        ) : buckets.isError ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-xs">
            <span>
              Subject history is unavailable:{" "}
              {apiErrorMessage(buckets.error, "the request failed")}.
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              loading={buckets.isFetching}
              onClick={() => void buckets.refetch()}
            >
              Retry history
            </Button>
          </div>
        ) : buckets.data && subjectEmptiness(buckets.data) === "no-campaigns" ? (
          <p className="text-xs text-muted-foreground">
            No sent campaigns in the last {buckets.data.window_days} days, so
            there is nothing to learn from yet — this is not a verdict on your
            subject lines.
          </p>
        ) : buckets.data && subjectEmptiness(buckets.data) === "no-patterns" ? (
          <p className="text-xs text-muted-foreground">
            {buckets.data.campaigns_total.toLocaleString()} campaigns analysed;
            no attribute pattern stood out.
          </p>
        ) : buckets.data ? (
          <div id={`${id}-bucket-details`}>
            {bucketsOpen ? (
              <dl className="grid gap-3 sm:grid-cols-2" data-testid="subject-buckets">
                {groupBuckets(bucketRows).map(([attribute, rows]) => (
                  <div key={attribute} className="rounded-md border p-2">
                    <dt className="text-xs font-medium capitalize">{label(attribute)}</dt>
                    {rows.map((row) => (
                      <dd
                        key={`${attribute}-${row.bucket ?? ""}`}
                        className="mt-1 flex justify-between gap-2 text-xs tabular-nums text-muted-foreground"
                      >
                        <span className="capitalize">{label(row.bucket)}</span>
                        <span>
                          {rate(row.open_rate)} open · {rate(row.click_rate)} click ·{" "}
                          {(row.campaigns ?? 0).toLocaleString()} sent
                        </span>
                      </dd>
                    ))}
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-xs text-muted-foreground">
                Open and click rates from{" "}
                {buckets.data.campaigns_total.toLocaleString()} campaigns over{" "}
                {buckets.data.window_days} days, grouped by subject attribute.
              </p>
            )}
          </div>
        ) : null}
      </section>

      <section aria-labelledby={`${id}-top`} className="space-y-2">
        <h4 id={`${id}-top`} className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Your top performers (last 90 days)
        </h4>
        {top.isPending ? (
          <p role="status" className="text-xs text-muted-foreground">
            Loading top performers…
          </p>
        ) : top.isError ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-xs">
            <span>
              Top performers are unavailable:{" "}
              {apiErrorMessage(top.error, "the request failed")}.
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              loading={top.isFetching}
              onClick={() => void top.refetch()}
            >
              Retry top performers
            </Button>
          </div>
        ) : topRows.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No campaign in the last 90 days reached 20 recipients. Top
            performers appear after eligible sends.
          </p>
        ) : (
          <ul aria-label="Top-performing subjects" className="divide-y rounded-lg border">
            {topRows.map((row) => (
              <li key={row.campaignId} className="flex items-start justify-between gap-2 p-2">
                <div className="min-w-0">
                  <p className="break-words text-sm">{row.subject}</p>
                  <p className="text-xs tabular-nums text-muted-foreground">
                    {rate(row.openRate)} open · {rate(row.clickRate)} click ·{" "}
                    {row.recipients.toLocaleString()} recipients
                    {row.name ? ` · ${row.name}` : ""}
                  </p>
                </div>
                {onUseSubject ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`Use “${row.subject}” as the subject`}
                    onClick={() => onUseSubject(row.subject)}
                  >
                    Use this
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * The assistant for the signed-in session: reads the caller's identity (the
 * shared auth-me key, so a page that already has it pays nothing) and applies
 * the server's owner/admin gate on generation. Used by the Copilot rail and
 * the new-campaign dialog.
 */
export function SubjectBriefAssistantForSession({
  onUseSubject,
  onUseAllAsVariants,
}: Pick<SubjectBriefAssistantProps, "onUseSubject" | "onUseAllAsVariants">) {
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = meQuery.data ?? null;
  if (!identity) {
    return meQuery.isError ? (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-xs">
        <span>Workspace access could not be verified, so the assistant is not loaded.</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          loading={meQuery.isFetching}
          onClick={() => void meQuery.refetch()}
        >
          Retry
        </Button>
      </div>
    ) : (
      <p role="status" className="text-xs text-muted-foreground">
        Verifying workspace access…
      </p>
    );
  }
  const role = effectiveAuthRole(identity);
  const viewerMode = identity.viewer_mode === true;
  return (
    <SubjectBriefAssistant
      tenantId={identity.tenant_id}
      role={role}
      canGenerate={!viewerMode && roleCanWrite(role)}
      generateBlockedReason={
        viewerMode
          ? "This session is in viewer mode, so subject generation is refused."
          : "Generating subject lines from a brief needs an owner or admin role."
      }
      onUseSubject={onUseSubject}
      onUseAllAsVariants={onUseAllAsVariants}
    />
  );
}
