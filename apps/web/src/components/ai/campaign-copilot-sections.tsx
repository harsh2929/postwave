// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * The campaign-bound sections of the Copilot rail (desktop composer/CopilotRail
 * parity): a pre-send verdict on the SAVED campaign, the Subject Lab hand-off
 * (use a variant, or start an A/B test — all subjects, or the top three as a
 * bandit), and the "start from a brief" subject assistant. Each section
 * expands and collapses; nothing that costs a model call runs until asked.
 *
 * Advisory only: the verdict never gates a send. It grades what is saved —
 * when the editor's subject differs from the one graded, the result says so.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";

import {
  LABELS as PRESEND_LABELS,
  scoreLabel,
  statusLabel,
} from "@/components/ai/presend-check-panel";
import { SubjectBriefAssistantForSession } from "@/components/ai/subject-brief-assistant";
import { SubjectLabDialog } from "@/components/ai/subject-lab-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import {
  campaignTestBlocker,
  createSubjectTestFromCampaign,
  loadSavedCampaignForCopilot,
  resolveSubjectLabEnabled,
  runCampaignPresendVerdict,
  verdictBlocker,
  type CampaignPresendVerdict,
  type SavedCampaignForCopilot,
} from "@/lib/campaign-copilot-api";
import { canWriteCampaigns } from "@/lib/campaign-write-authority";
import { base, qk, STALE } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";

type SectionId = "verdict" | "lab" | "brief";

const SECTIONS: Record<SectionId, { title: string; blurb: string }> = {
  verdict: {
    title: "Pre-send verdict",
    blurb: "Content quality, voice, placement and Campaign Assurance on the saved campaign.",
  },
  lab: {
    title: "Subject Lab",
    blurb: "Scored subject variants, and an A/B or bandit test from them.",
  },
  brief: {
    title: "Start from a brief",
    blurb: "Subject lines from a description, graded against your history.",
  },
};

function assuranceScore(score: number | undefined): string {
  if (score === undefined) return "—";
  return score <= 1 ? `${Math.round(score * 100)}%` : `${Math.round(score)} / 100`;
}

function headline(result: CampaignPresendVerdict): {
  label: string;
  variant: "destructive" | "warning" | "success" | "secondary";
} {
  const statuses = [
    ...result.base.components.map((component) => component.status),
    result.assurance.status,
  ];
  if (result.verdict === "critical" || statuses.includes("critical")) {
    return { label: "Critical issues", variant: "destructive" };
  }
  if (!result.complete) return { label: "Incomplete — not a pass", variant: "secondary" };
  if (result.verdict === "warn" || statuses.includes("warn")) {
    return { label: "Review suggested", variant: "warning" };
  }
  return { label: "All four checks passed", variant: "success" };
}

function RailSection({
  id,
  open,
  onToggle,
  children,
}: {
  id: SectionId;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const bodyId = `copilot-rail-${id}`;
  const meta = SECTIONS[id];
  return (
    <section className="border-t pt-3" data-testid={`copilot-section-${id}`}>
      <button
        type="button"
        className="flex w-full items-start gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
      >
        {open ? (
          <ChevronDown className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        )}
        <span className="min-w-0">
          <span className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {meta.title}
          </span>
          <span className="block text-[11px] leading-tight text-muted-foreground">
            {meta.blurb}
          </span>
        </span>
      </button>
      <div id={bodyId} hidden={!open} className="mt-2 flex flex-col gap-2">
        {open ? children : null}
      </div>
    </section>
  );
}

export function CampaignCopilotSections({
  campaignId,
  editorSubject,
  onApplySubject,
}: {
  campaignId: string;
  /** The editor's current (possibly unsaved) subject, to flag a stale verdict. */
  editorSubject: string;
  onApplySubject?: (subject: string) => void;
}) {
  const id = useId();
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = meQuery.data ?? null;
  const role = identity ? effectiveAuthRole(identity) : null;
  const viewerMode = identity?.viewer_mode === true;
  const canWrite = canWriteCampaigns(identity);
  const writeReason = !identity
    ? "Workspace access is still being verified."
    : viewerMode
      ? "This session is in viewer mode, so the copilot's checks are read-only."
      : "Owner, admin, or editor access is required.";

  const [open, setOpen] = useState<Record<SectionId, boolean>>({
    verdict: true,
    lab: false,
    brief: false,
  });
  const toggle = (section: SectionId) =>
    setOpen((current) => ({ ...current, [section]: !current[section] }));

  // --- pre-send verdict -------------------------------------------------
  const [verdict, setVerdict] = useState<CampaignPresendVerdict | null>(null);
  const [verdictError, setVerdictError] = useState<string | null>(null);
  const [verdictNote, setVerdictNote] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const verdictRun = useRef(0);

  // --- Subject Lab -------------------------------------------------------
  const [saved, setSaved] = useState<SavedCampaignForCopilot | null>(null);
  const [labOpen, setLabOpen] = useState(false);
  const [labLoading, setLabLoading] = useState(false);
  const [labError, setLabError] = useState<string | null>(null);
  const labFlagKey = useMemo(
    () => [...base("feature-flag", identity?.tenant_id ?? "pending", role), "subject_lab"],
    [identity?.tenant_id, role],
  );
  const labFlag = useQuery({
    queryKey: labFlagKey,
    queryFn: ({ signal }) => resolveSubjectLabEnabled(signal),
    enabled: open.lab && identity !== null,
    staleTime: STALE.reference,
    retry: false,
  });

  // A different campaign invalidates everything this rail knew.
  useEffect(() => {
    verdictRun.current += 1;
    setVerdict(null);
    setVerdictError(null);
    setVerdictNote(null);
    setRunning(false);
    setSaved(null);
    setLabOpen(false);
    setLabError(null);
  }, [campaignId]);

  async function runVerdict() {
    if (!canWrite || running) return;
    const token = ++verdictRun.current;
    setRunning(true);
    setVerdictError(null);
    setVerdictNote(null);
    try {
      const fresh = await loadSavedCampaignForCopilot(campaignId);
      if (token !== verdictRun.current) return;
      setSaved(fresh);
      const blocker = verdictBlocker(fresh);
      if (blocker) {
        setVerdict(null);
        setVerdictNote(blocker);
        return;
      }
      const result = await runCampaignPresendVerdict(fresh);
      if (token !== verdictRun.current) return;
      setVerdict(result);
    } catch (cause) {
      if (token !== verdictRun.current) return;
      setVerdictError(
        apiErrorMessage(cause, "The pre-send check could not be completed. Try again."),
      );
    } finally {
      if (token === verdictRun.current) setRunning(false);
    }
  }

  async function openLab() {
    if (labLoading) return;
    setLabLoading(true);
    setLabError(null);
    try {
      // The lab seeds from, and tests are built from, the SAVED campaign.
      const fresh = await loadSavedCampaignForCopilot(campaignId);
      setSaved(fresh);
      setLabOpen(true);
    } catch (cause) {
      setLabError(apiErrorMessage(cause, "The saved campaign could not be read."));
    } finally {
      setLabLoading(false);
    }
  }

  const shown = verdict ? headline(verdict) : null;
  const staleVerdict =
    verdict !== null && editorSubject.trim() !== verdict.graded.subject;

  return (
    <div className="flex flex-col gap-3" data-testid="copilot-campaign-sections">
      <p className="text-[11px] leading-tight text-muted-foreground">
        Advisory only — nothing here blocks or starts a send.
      </p>

      <RailSection id="verdict" open={open.verdict} onToggle={() => toggle("verdict")}>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            loading={running}
            disabled={!canWrite}
            aria-describedby={canWrite ? undefined : `${id}-verdict-reason`}
            onClick={() => void runVerdict()}
          >
            {running
              ? "Running checks…"
              : verdict || verdictError || verdictNote
                ? "Re-run checks"
                : "Run pre-send check"}
          </Button>
          {!canWrite ? (
            <span id={`${id}-verdict-reason`} className="text-xs text-muted-foreground">
              {writeReason}
            </span>
          ) : null}
        </div>
        <div aria-live="polite" className="flex flex-col gap-2">
          {verdictNote ? (
            <p role="status" className="text-xs text-muted-foreground">
              {verdictNote}
            </p>
          ) : null}
          {verdictError ? (
            <Alert variant="destructive">
              <AlertDescription>{verdictError}</AlertDescription>
            </Alert>
          ) : null}
          {verdict && shown ? (
            <article className="rounded-md border p-3" data-testid="copilot-verdict">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-sm font-medium">{shown.label}</h4>
                <Badge variant={staleVerdict ? "outline" : shown.variant}>
                  {staleVerdict ? "Editor has changed" : "Saved campaign"}
                </Badge>
              </div>
              <p className="mt-1 text-xs">{verdict.summary}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {verdict.complete ? "4 of 4 checks completed" : "Incomplete — do not infer a pass"}{" "}
                · graded “{verdict.graded.subject}” from {verdict.graded.from} ·{" "}
                {verdict.graded.bodyLength.toLocaleString()} body characters
              </p>
              {staleVerdict ? (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  The subject in the editor differs from the saved one this
                  graded. Save, then re-run.
                </p>
              ) : null}
              <ul aria-label="Pre-send verdict checks" className="mt-2 divide-y rounded border">
                {verdict.base.components.map((component) => (
                  <li
                    key={component.name}
                    className="flex items-start justify-between gap-2 p-2 text-xs"
                  >
                    <span className="min-w-0">
                      <span className="block font-medium">{PRESEND_LABELS[component.name]}</span>
                      <span className="block break-words text-muted-foreground">
                        {component.error ||
                          component.message ||
                          (component.received
                            ? "No additional guidance was returned."
                            : "This expected check was missing from the response.")}
                      </span>
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {statusLabel(component.status)} · {scoreLabel(component)}
                    </span>
                  </li>
                ))}
                <li className="flex items-start justify-between gap-2 p-2 text-xs">
                  <span className="min-w-0">
                    <span className="block font-medium">Campaign Assurance</span>
                    <span className="block break-words text-muted-foreground">
                      {verdict.assurance.message ??
                        (verdict.assurance.received
                          ? "No additional guidance was returned."
                          : "This expected check was missing from the response.")}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {statusLabel(verdict.assurance.status)} ·{" "}
                    {assuranceScore(verdict.assurance.score)}
                  </span>
                </li>
              </ul>
            </article>
          ) : null}
        </div>
      </RailSection>

      <RailSection id="lab" open={open.lab} onToggle={() => toggle("lab")}>
        {labFlag.isPending ? (
          <p role="status" className="text-xs text-muted-foreground">
            Checking whether Subject Lab is on for this workspace…
          </p>
        ) : labFlag.isError ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-xs">
            <span>
              Couldn&apos;t confirm whether Subject Lab is on:{" "}
              {apiErrorMessage(labFlag.error, "the flag could not be read")}.
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              loading={labFlag.isFetching}
              onClick={() => void labFlag.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : labFlag.data === false ? (
          <p className="text-xs text-muted-foreground">
            Subject Lab is off for this workspace. An owner or admin can turn it
            on under{" "}
            <Link className="underline underline-offset-2" href={asRoute("/app/workspace-ops")}>
              Workspace operations
            </Link>{" "}
            (feature flag <code>subject_lab</code>).
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                loading={labLoading}
                onClick={() => void openLab()}
              >
                Open Subject Lab
              </Button>
            </div>
            {labError ? (
              <Alert variant="destructive">
                <AlertDescription>{labError}</AlertDescription>
              </Alert>
            ) : null}
            {saved ? (
              <SubjectLabDialog
                open={labOpen}
                onOpenChange={setLabOpen}
                seedSubject={saved.subject}
                bodyExcerpt={saved.bodyHtml.slice(0, 800)}
                canGenerate={canWrite}
                generateBlockedReason={writeReason}
                onUseVariant={onApplySubject}
                onStartTest={
                  canWrite
                    ? (subjects, bandit) =>
                        createSubjectTestFromCampaign(saved, subjects, { bandit })
                    : undefined
                }
                testBlocker={campaignTestBlocker(saved)}
              />
            ) : null}
          </>
        )}
      </RailSection>

      <RailSection id="brief" open={open.brief} onToggle={() => toggle("brief")}>
        <SubjectBriefAssistantForSession onUseSubject={onApplySubject} />
      </RailSection>
    </div>
  );
}
