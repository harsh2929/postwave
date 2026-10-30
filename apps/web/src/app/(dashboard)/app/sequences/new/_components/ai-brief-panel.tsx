// SPDX-License-Identifier: AGPL-3.0-only
//
// Brief-driven sequence creation (desktop parity rows automation-61/62):
// describe the sequence, then either
//   - Generate with AI  → POST /voice/sequences/draft (non-persisting preview), or
//   - Quick match (no AI) → local keyword match against the starter library,
// review the drafted steps, and accept them through the ordinary
// POST /voice/sequences create path. Nothing created here activates delivery.
//
// The AI path's two known refusals each name their no-AI fallback: 429 (tenant
// AI quota) and 503 (no LLM configured on this server) both point at Quick
// match, which is instant and consumes no quota.
"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Sparkles, Wand2 } from "lucide-react";
import { toast } from "sonner";

import { apiErrorMessage } from "@/lib/api";
import { whoami } from "@/lib/auth-api";
import { canWriteCampaigns } from "@/lib/campaign-write-authority";
import { STALE, qk } from "@/lib/query-keys";
import {
  AI_BRIEF_EXAMPLES,
  draftStepsToCanvasSteps,
  formatDraftDelay,
  generateSequenceFromBrief,
  parseDraftStepCount,
  renumberSteps,
  type AiBriefDraft,
} from "@/lib/sequence-ai-brief";
import {
  DRAFT_BRIEF_MAX_LENGTH,
  DRAFT_STEP_COUNT_MAX,
  DRAFT_TONE_MAX_LENGTH,
  classifyDraftError,
  draftSequence,
  type SequenceDraftResponse,
} from "@/lib/sequence-settings-api";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import { createSequence } from "@/lib/voice-api";
import type { SequenceStoredStep } from "@/lib/voice-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export const SEQUENCE_CREATE_READ_ONLY_MESSAGE =
  "Creating sequences is read-only for this session. Owner, admin, or editor access outside viewer mode is required to draft or create a sequence.";

const NO_MATCH_MESSAGE =
  "No close template match yet. Try one of the examples or start from a template.";

type Phase = "idle" | "drafting" | "creating";

function excerpt(body: string, max = 160): string {
  return body.length > max ? `${body.slice(0, max)}…` : body;
}

export function AiBriefPanel() {
  const router = useRouter();
  const [brief, setBrief] = useState("");
  const [stepCount, setStepCount] = useState("");
  const [tone, setTone] = useState("");
  const [name, setName] = useState("");
  const [serverDraft, setServerDraft] = useState<SequenceDraftResponse | null>(
    null,
  );
  const [quickDraft, setQuickDraft] = useState<AiBriefDraft | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const briefId = useId();
  const stepCountId = useId();
  const toneId = useId();
  const nameId = useId();
  const reasonId = useId();

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const canWrite = canWriteCampaigns(meQuery.data);
  const writeUnavailableReason = meQuery.isPending
    ? "Checking write access…"
    : canWrite
      ? null
      : SEQUENCE_CREATE_READ_ONLY_MESSAGE;

  useEffect(() => () => abortRef.current?.abort(), []);

  const hasDraft = serverDraft !== null || quickDraft !== null;
  useUnsavedChangesGuard(hasDraft || phase !== "idle");

  const busy = phase !== "idle";
  const inputsDisabled = busy || !canWrite;

  const clearDrafts = () => {
    setServerDraft(null);
    setQuickDraft(null);
    setError(null);
  };

  const quickMatch = () => {
    if (!canWrite || busy) return;
    const trimmed = brief.trim();
    if (!trimmed) {
      setError("Describe the sequence you want to generate.");
      return;
    }
    const generated = generateSequenceFromBrief(trimmed);
    if (!generated) {
      setQuickDraft(null);
      setError(NO_MATCH_MESSAGE);
      return;
    }
    setError(null);
    setServerDraft(null);
    setQuickDraft(generated);
    setName(generated.proposedName);
  };

  const generateWithAi = async () => {
    if (!canWrite || busy) return;
    const trimmed = brief.trim();
    if (!trimmed) {
      setError("Describe the sequence you want to generate.");
      return;
    }
    const parsedStepCount = parseDraftStepCount(stepCount);
    if (parsedStepCount !== null && Number.isNaN(parsedStepCount)) {
      setError(
        `Email count must be a whole number between 1 and ${DRAFT_STEP_COUNT_MAX}.`,
      );
      return;
    }
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setPhase("drafting");
    setError(null);
    try {
      const generated = await draftSequence(
        {
          brief: trimmed,
          ...(parsedStepCount === null ? {} : { step_count: parsedStepCount }),
          ...(tone.trim() ? { tone: tone.trim() } : {}),
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setQuickDraft(null);
      setServerDraft(generated);
      setName((current) => generated.name || current);
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = apiErrorMessage(err, "The AI drafting request did not complete.");
      switch (classifyDraftError(err)) {
        case "quota":
          setError(
            `AI quota reached: ${message} Try again later, or use Quick match — it's instant and doesn't consume quota.`,
          );
          break;
        case "unconfigured":
          setError(
            `AI drafting isn't configured on this server (${message}). Use Quick match or a template instead.`,
          );
          break;
        default:
          setError(`Couldn't draft the sequence: ${message}`);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (!controller.signal.aborted) setPhase("idle");
    }
  };

  const cancelDrafting = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase("idle");
  };

  const create = async () => {
    if (!canWrite || busy) return;
    const steps: SequenceStoredStep[] = serverDraft
      ? draftStepsToCanvasSteps(serverDraft.steps)
      : quickDraft
        ? renumberSteps(quickDraft.steps.map((s) => s.step))
        : [];
    if (steps.length === 0) return;
    const sequenceName =
      name.trim() ||
      serverDraft?.name ||
      quickDraft?.proposedName ||
      "Untitled sequence";
    setPhase("creating");
    setError(null);
    try {
      const sequence = await createSequence({
        name: sequenceName,
        status: "draft",
        steps,
      });
      clearDrafts();
      toast.success(`Sequence "${sequenceName}" created as a draft.`);
      router.push(`/app/sequences/${sequence.id}`);
    } catch (err) {
      setError(apiErrorMessage(err, "Could not create sequence draft."));
      setPhase("idle");
    }
  };

  return (
    <div className="space-y-4 rounded-md border bg-card p-4">
      <p className="text-sm text-muted-foreground">
        Describe the sequence you want. Generate with AI drafts the subjects,
        body copy, and waits; Quick match picks the closest starter locally.
        Review the structure before it is stored — the result is an inactive
        draft either way.
      </p>

      <div className="space-y-1.5">
        <Label htmlFor={briefId}>Brief</Label>
        <Textarea
          id={briefId}
          rows={4}
          maxLength={DRAFT_BRIEF_MAX_LENGTH}
          value={brief}
          disabled={inputsDisabled}
          placeholder="4-step welcome for B2C signups, nudge first purchase by day 7"
          onChange={(e) => {
            setBrief(e.target.value);
            setError(null);
          }}
        />
        <p className="text-xs text-muted-foreground">
          {brief.length}/{DRAFT_BRIEF_MAX_LENGTH} characters
        </p>
      </div>

      <div className="flex flex-wrap gap-2" aria-label="Example briefs">
        {AI_BRIEF_EXAMPLES.map((example) => (
          <Button
            key={example}
            type="button"
            variant="outline"
            size="sm"
            disabled={inputsDisabled}
            onClick={() => {
              setBrief(example);
              setError(null);
            }}
          >
            {example}
          </Button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-[9rem_minmax(0,1fr)]">
        <div className="space-y-1.5">
          <Label htmlFor={stepCountId}>Emails (optional)</Label>
          <Input
            id={stepCountId}
            type="number"
            inputMode="numeric"
            min={1}
            max={DRAFT_STEP_COUNT_MAX}
            step={1}
            placeholder="auto"
            value={stepCount}
            disabled={inputsDisabled}
            onChange={(e) => {
              setStepCount(e.target.value);
              setError(null);
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={toneId}>Tone (optional)</Label>
          <Input
            id={toneId}
            type="text"
            maxLength={DRAFT_TONE_MAX_LENGTH}
            placeholder="friendly, no-nonsense, playful…"
            value={tone}
            disabled={inputsDisabled}
            onChange={(e) => {
              setTone(e.target.value);
              setError(null);
            }}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          disabled={inputsDisabled}
          aria-describedby={writeUnavailableReason ? reasonId : undefined}
          onClick={() => void generateWithAi()}
        >
          {phase === "drafting" ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Sparkles className="h-4 w-4" aria-hidden />
          )}
          {phase === "drafting" ? "Drafting…" : "Generate with AI"}
        </Button>
        {phase === "drafting" ? (
          <Button type="button" variant="outline" onClick={cancelDrafting}>
            Cancel
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          disabled={inputsDisabled}
          aria-describedby={writeUnavailableReason ? reasonId : undefined}
          onClick={quickMatch}
        >
          <Wand2 className="h-4 w-4" aria-hidden />
          Quick match (no AI)
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Quick match uses the curated starter library locally. It is instant and
        does not make an AI request or consume AI quota.
      </p>
      {writeUnavailableReason ? (
        <p id={reasonId} role="status" className="text-xs text-muted-foreground">
          {writeUnavailableReason}
        </p>
      ) : null}
      {phase === "drafting" ? (
        <p role="status" className="text-xs text-muted-foreground">
          Drafting with AI — a full sequence draft can take up to a minute.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {serverDraft || quickDraft ? (
        <div
          role="status"
          aria-live="polite"
          className="space-y-3 rounded-md border bg-muted/30 p-4"
        >
          <p className="text-sm font-medium">
            {serverDraft
              ? `AI draft: ${serverDraft.name || "Untitled sequence"}`
              : quickDraft?.summary}
          </p>
          <ol className="space-y-2 text-sm">
            {serverDraft
              ? serverDraft.steps.map((step, index) => (
                  <li key={`${step.position}-${index}`} className="space-y-0.5">
                    <div>
                      <span className="text-muted-foreground">
                        {formatDraftDelay(step.delay_hours)} ·{" "}
                      </span>
                      <span className="font-medium">{step.subject}</span>
                    </div>
                    <p className="whitespace-pre-line text-xs text-muted-foreground">
                      {excerpt(step.body)}
                    </p>
                  </li>
                ))
              : quickDraft?.steps?.map((entry, index) => (
                  <li key={`${entry.step.type}-${index}`} className="space-y-0.5">
                    <div>
                      <span className="text-muted-foreground">
                        {entry.step.type.replace("_", " ")}
                        {entry.step.type === "email" ? " · " : ""}
                      </span>
                      {entry.step.type === "email" ? (
                        <span className="font-medium">
                          {entry.step.email.subject}
                        </span>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {entry.rationale}
                    </p>
                  </li>
                ))}
          </ol>
          <div className="space-y-1.5">
            <Label htmlFor={nameId}>Sequence name</Label>
            <Input
              id={nameId}
              value={name}
              disabled={inputsDisabled}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Nothing is saved yet — create the sequence to accept this draft, or
            regenerate with a sharper brief.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              disabled={inputsDisabled}
              aria-describedby={writeUnavailableReason ? reasonId : undefined}
              onClick={() => void create()}
            >
              {phase === "creating" ? "Creating…" : "Create sequence"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={clearDrafts}
            >
              Discard draft
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
