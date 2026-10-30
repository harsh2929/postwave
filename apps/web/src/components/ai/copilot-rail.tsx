// SPDX-License-Identifier: AGPL-3.0-only
//
// CopilotRail — the web campaign editor's AI compose panel (Apple-level
// integration dim 12, AI-feature parity). Desktop has a unified Copilot rail;
// web previously had only a single inline "AI subject suggestions" affordance
// in the create dialog. This brings the *rail* to web: a dedicated, extensible
// panel of AI compose tools. It composes web's EXISTING AI surface (subject
// generation via /api/v1/voice/generate) — no new data source — and is
// structured so more tools (body rewrite, tone) slot in as new sections.
//
// Results are ephemeral component state (never cached/persisted). Every
// AI-authored section carries the Art. 50(1) disclosure via @postwave/
// ai-disclosure, consistent with the rest of the app.
//
// With a campaignId the rail also carries the campaign-bound sections
// (desktop composer/CopilotRail): the pre-send verdict on the saved campaign,
// the Subject Lab hand-off, and the "start from a brief" assistant — see
// ./campaign-copilot-sections.tsx.
"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Sparkles, Wand2 } from "lucide-react";

import { AI_DISCLOSURE_TEXT } from "@postwave/ai-disclosure";

import { CampaignCopilotSections } from "@/components/ai/campaign-copilot-sections";
import { Button } from "@/components/ui/button";
import { copyToClipboard, isClipboardAvailable } from "@/lib/clipboard";
import {
  previewContentOptimizer,
  type ContentOptimizerPreview,
} from "@/lib/content-optimizer-api";
import { generateSubjectSuggestions } from "@/lib/voice-api";

export interface CopilotRailProps {
  /** The current draft subject — seeds subject-idea generation. */
  subject: string;
  /** Apply a chosen subject back into the editor (renders an Apply action). */
  onApplySubject?: (subject: string) => void;
  /** Injectable generator (defaults to the live voice-api call) — for tests. */
  generate?: (subject: string, signal?: AbortSignal) => Promise<string[]>;
  /**
   * When set, renders the content-optimizer allocation section (CAMP-045) and
   * the campaign-bound verdict / Subject Lab / brief sections.
   */
  campaignId?: string;
  /** Injectable optimizer preview (defaults to the live call) — for tests. */
  previewOptimizer?: (
    campaignId: string,
    signal?: AbortSignal,
  ) => Promise<ContentOptimizerPreview>;
  className?: string;
}

type GenState =
  | { status: "idle" }
  | { status: "loading"; subject: string }
  | { status: "ready"; subject: string; ideas: string[] }
  | { status: "error"; subject: string; message: string };

type OptState =
  | { status: "idle" }
  | { status: "loading"; campaignId: string }
  | {
      status: "ready";
      campaignId: string;
      preview: ContentOptimizerPreview;
    }
  | { status: "error"; campaignId: string; message: string };

export function CopilotRail({
  subject,
  onApplySubject,
  generate = (value, signal) =>
    generateSubjectSuggestions(value, signal ? { signal } : undefined),
  campaignId,
  previewOptimizer = (id, signal) =>
    previewContentOptimizer(id, {}, signal ? { signal } : undefined),
  className,
}: CopilotRailProps) {
  const [gen, setGen] = useState<GenState>({ status: "idle" });
  const [copied, setCopied] = useState<string | null>(null);
  const [opt, setOpt] = useState<OptState>({ status: "idle" });
  const subjectRef = useRef(subject);
  const campaignIdRef = useRef(campaignId);
  const generationRequestRef = useRef(0);
  const optimizerRequestRef = useRef(0);
  const generationAbortRef = useRef<AbortController | null>(null);
  const optimizerAbortRef = useRef<AbortController | null>(null);
  const generationInFlightRef = useRef<{
    requestId: number;
    subject: string;
  } | null>(null);
  const optimizerInFlightRef = useRef<{
    campaignId: string;
    requestId: number;
  } | null>(null);

  // Request generations protect injectable clients that ignore AbortSignal.
  // Keeping the latest props in refs also closes the render-to-effect window:
  // an old request can never paint for a subject/campaign that already changed.
  subjectRef.current = subject;
  campaignIdRef.current = campaignId;

  useEffect(
    () => () => {
      generationRequestRef.current += 1;
      optimizerRequestRef.current += 1;
      generationAbortRef.current?.abort();
      optimizerAbortRef.current?.abort();
      generationInFlightRef.current = null;
      optimizerInFlightRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (generationInFlightRef.current?.subject === subject) return;
    generationRequestRef.current += 1;
    generationAbortRef.current?.abort();
    generationAbortRef.current = null;
    generationInFlightRef.current = null;
  }, [subject]);

  useEffect(() => {
    if (optimizerInFlightRef.current?.campaignId === campaignId) return;
    optimizerRequestRef.current += 1;
    optimizerAbortRef.current?.abort();
    optimizerAbortRef.current = null;
    optimizerInFlightRef.current = null;
  }, [campaignId]);

  const currentGen: GenState =
    gen.status === "idle" || gen.subject === subject ? gen : { status: "idle" };
  const currentOpt: OptState =
    opt.status === "idle" || opt.campaignId === campaignId
      ? opt
      : { status: "idle" };

  const runOptimizer = async () => {
    if (!campaignId) return;
    // React state does not disable a button synchronously. The ref prevents a
    // double click in one task from paying for and racing two identical calls.
    if (optimizerInFlightRef.current?.campaignId === campaignId) return;
    const requestedCampaignId = campaignId;
    const requestId = ++optimizerRequestRef.current;
    optimizerAbortRef.current?.abort();
    const controller = new AbortController();
    optimizerAbortRef.current = controller;
    optimizerInFlightRef.current = {
      campaignId: requestedCampaignId,
      requestId,
    };
    setOpt({ status: "loading", campaignId: requestedCampaignId });
    try {
      const preview = await previewOptimizer(
        requestedCampaignId,
        controller.signal,
      );
      if (
        optimizerRequestRef.current !== requestId ||
        campaignIdRef.current !== requestedCampaignId
      ) {
        return;
      }
      setOpt(
        preview.recommended_arms.length
          ? {
              status: "ready",
              campaignId: requestedCampaignId,
              preview,
            }
          : {
              status: "error",
              campaignId: requestedCampaignId,
              message:
                "No variants to allocate yet — add A/B content variants first.",
            },
      );
    } catch {
      if (controller.signal.aborted) return;
      if (
        optimizerRequestRef.current !== requestId ||
        campaignIdRef.current !== requestedCampaignId
      ) {
        return;
      }
      setOpt({
        status: "error",
        campaignId: requestedCampaignId,
        message: "Couldn't compute an allocation. Try again in a moment.",
      });
    } finally {
      if (optimizerInFlightRef.current?.requestId === requestId) {
        optimizerInFlightRef.current = null;
      }
      if (optimizerAbortRef.current === controller) {
        optimizerAbortRef.current = null;
      }
    }
  };

  const run = async () => {
    if (generationInFlightRef.current?.subject === subject) return;
    const requestedSubject = subject;
    const requestId = ++generationRequestRef.current;
    generationAbortRef.current?.abort();
    const controller = new AbortController();
    generationAbortRef.current = controller;
    generationInFlightRef.current = {
      requestId,
      subject: requestedSubject,
    };
    setGen({ status: "loading", subject: requestedSubject });
    try {
      const generatedIdeas = await generate(
        requestedSubject,
        controller.signal,
      );
      if (
        generationRequestRef.current !== requestId ||
        subjectRef.current !== requestedSubject
      ) {
        return;
      }
      const ideas = Array.from(
        new Set(generatedIdeas.map((idea) => idea.trim()).filter(Boolean)),
      );
      setGen(
        ideas.length
          ? { status: "ready", subject: requestedSubject, ideas }
          : {
              status: "error",
              subject: requestedSubject,
              message: "No suggestions came back — try again.",
            },
      );
    } catch {
      if (controller.signal.aborted) return;
      if (
        generationRequestRef.current !== requestId ||
        subjectRef.current !== requestedSubject
      ) {
        return;
      }
      setGen({
        status: "error",
        subject: requestedSubject,
        message: "Couldn't reach the AI service. Try again in a moment.",
      });
    } finally {
      if (generationInFlightRef.current?.requestId === requestId) {
        generationInFlightRef.current = null;
      }
      if (generationAbortRef.current === controller) {
        generationAbortRef.current = null;
      }
    }
  };

  const copy = async (idea: string) => {
    if (!isClipboardAvailable()) return;
    if (await copyToClipboard(idea)) {
      setCopied(idea);
      window.setTimeout(() => setCopied((c) => (c === idea ? null : c)), 1500);
    }
  };

  return (
    <aside
      aria-label="AI copilot"
      data-testid="copilot-rail"
      className={`flex w-full flex-col gap-3 rounded-lg border bg-card p-4 ${className ?? ""}`}
    >
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-primary" aria-hidden />
        <h3 className="text-sm font-semibold">Copilot</h3>
      </div>

      <section
        className="flex flex-col gap-2"
        aria-busy={currentGen.status === "loading"}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Subject ideas
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={run}
            disabled={currentGen.status === "loading"}
          >
            <Wand2 className="size-3.5" aria-hidden />
            {currentGen.status === "loading" ? "Generating…" : "Generate"}
          </Button>
        </div>

        {currentGen.status === "error" ? (
          <p className="text-xs text-destructive" role="status">
            {currentGen.message}
          </p>
        ) : null}

        {currentGen.status === "ready" ? (
          <ul
            className="flex flex-col gap-1.5"
            data-testid="copilot-subject-ideas"
          >
            {currentGen.ideas.map((idea) => (
              <li
                key={idea}
                className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-sm">{idea}</span>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    aria-label={`Copy "${idea}"`}
                    className="rounded p-1 text-muted-foreground hover:text-foreground"
                    onClick={() => void copy(idea)}
                  >
                    {copied === idea ? (
                      <Check className="size-3.5 text-success" aria-hidden />
                    ) : (
                      <Copy className="size-3.5" aria-hidden />
                    )}
                  </button>
                  {onApplySubject ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => onApplySubject(idea)}
                    >
                      Apply
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        {currentGen.status !== "idle" ? (
          <p className="text-[11px] leading-tight text-muted-foreground">
            {AI_DISCLOSURE_TEXT}
          </p>
        ) : null}
      </section>

      {campaignId ? (
        <section
          className="flex flex-col gap-2 border-t pt-3"
          data-testid="copilot-optimizer"
          aria-busy={currentOpt.status === "loading"}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Content optimizer
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={runOptimizer}
              disabled={currentOpt.status === "loading"}
            >
              <Wand2 className="size-3.5" aria-hidden />
              {currentOpt.status === "loading" ? "Computing…" : "Preview"}
            </Button>
          </div>
          <p className="text-[11px] leading-tight text-muted-foreground">
            Deterministic traffic allocation across your existing content
            variants — not AI-generated copy.
          </p>

          {currentOpt.status === "error" ? (
            <p className="text-xs text-destructive" role="status">
              {currentOpt.message}
            </p>
          ) : null}

          {currentOpt.status === "ready" ? (
            <ul
              className="flex flex-col gap-1.5"
              data-testid="copilot-optimizer-arms"
            >
              {currentOpt.preview.recommended_arms.map((arm) => (
                <li
                  key={arm.key}
                  className="flex flex-col gap-0.5 rounded-md border px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {arm.subject || arm.key}
                    </span>
                    <span className="shrink-0 text-sm tabular-nums text-primary">
                      {Math.round(arm.allocation_percent)}%
                    </span>
                  </div>
                  {arm.reason ? (
                    <span className="text-[11px] leading-tight text-muted-foreground">
                      {arm.reason}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {campaignId ? (
        <CampaignCopilotSections
          campaignId={campaignId}
          editorSubject={subject}
          onApplySubject={onApplySubject}
        />
      ) : null}
    </aside>
  );
}
