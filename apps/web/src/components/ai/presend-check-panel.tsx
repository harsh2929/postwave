// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Standalone advisory pre-send review for a pasted draft (desktop
 * PresendCheckPanel parity): subject, sender, and body go to the unified
 * verdict, and the three checks — content quality (EQ), voice alignment, and
 * predicted placement — render with their own status. A result is labelled
 * current only while the fields still hold the exact values it graded, and an
 * incomplete run never reads as a pass.
 */
import { useId, useRef, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api";
import {
  runPresendDraftVerdict,
  type PresendComponentName,
  type PresendDraftComponent,
  type PresendDraftVerdict,
} from "@/lib/presend-draft-api";

const SENDER_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u;

interface Snapshot {
  key: string;
  subject: string;
  sender: string;
  bodyLength: number;
  result: PresendDraftVerdict;
}

function draftKey(subject: string, sender: string, body: string): string {
  return JSON.stringify([subject.trim(), sender.trim().toLowerCase(), body]);
}

/** Shared with the campaign-bound verdict in the Copilot rail. */
export const LABELS: Record<PresendComponentName, string> = {
  eq_score: "Content quality",
  voice_drift: "Voice alignment",
  placement: "Primary placement",
};

export function statusLabel(status: PresendDraftComponent["status"]): string {
  switch (status) {
    case "ok":
      return "Completed";
    case "warn":
      return "Needs review";
    case "critical":
      return "Critical";
    case "error":
      return "Unavailable";
    case "skipped":
      return "Not run";
    default:
      return "Unknown";
  }
}

export function scoreLabel(component: PresendDraftComponent): string {
  if (component.score === undefined) return "—";
  return component.name === "placement"
    ? `${Math.round(component.score * 100)}%`
    : `${Math.round(component.score)} / 100`;
}

function presentation(result: PresendDraftVerdict): {
  label: string;
  variant: "destructive" | "warning" | "success" | "secondary";
  summary: string;
} {
  const critical =
    result.verdict === "critical" ||
    result.components.some((component) => component.status === "critical");
  const warn =
    result.verdict === "warn" ||
    result.components.some((component) => component.status === "warn");
  if (critical) {
    return {
      label: "Critical issues",
      variant: "destructive",
      summary: result.complete
        ? "At least one advisory check found a critical issue. Review the details before moving this draft forward."
        : "Critical issues were found, and one or more checks did not complete. Treat this draft as unverified.",
    };
  }
  if (!result.complete) {
    return {
      label: "Incomplete review",
      variant: "secondary",
      summary:
        "One or more advisory checks were unavailable or returned an unknown result. Their absence is not a pass; run the review again before relying on it.",
    };
  }
  if (warn) {
    return {
      label: "Review suggested",
      variant: "warning",
      summary:
        "At least one advisory check found something to review before moving this draft forward.",
    };
  }
  return {
    label: "Checks completed",
    variant: "success",
    summary: "All three advisory checks completed without warnings.",
  };
}

export function PresendCheckPanel({
  canRun,
  blockedReason,
}: {
  /** write:campaigns — owner, admin, or editor outside viewer mode. */
  canRun: boolean;
  /** Why the check cannot run, in the host page's words. */
  blockedReason?: string | null;
}) {
  const id = useId();
  const [subject, setSubject] = useState("");
  const [sender, setSender] = useState("");
  const [body, setBody] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const mutation = useMutation({
    mutationFn: (input: { subject: string; from: string; body: string }) =>
      runPresendDraftVerdict(input),
  });

  const senderValid = SENDER_RE.test(sender.trim());
  const draftReady = subject.trim() !== "" && senderValid && body.trim() !== "";
  const currentKey = draftKey(subject, sender, body);
  const isRunning = mutation.isPending;
  const current =
    snapshot !== null && snapshot.key === currentKey && !isRunning && !error;

  function edit(setter: (value: string) => void, value: string) {
    // Editing retires any in-flight run: its answer would describe old text.
    generation.current += 1;
    setError(null);
    setter(value);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canRun || !draftReady || isRunning) return;
    const token = ++generation.current;
    const submitted = {
      subject: subject.trim(),
      from: sender.trim(),
      body,
    };
    const key = draftKey(submitted.subject, submitted.from, body);
    setError(null);
    mutation.mutate(submitted, {
      onSuccess: (result) => {
        if (token !== generation.current) return;
        setSnapshot({
          key,
          subject: submitted.subject,
          sender: submitted.from,
          bodyLength: body.length,
          result,
        });
      },
      onError: (cause) => {
        if (token !== generation.current) return;
        setError(
          apiErrorMessage(
            cause,
            "The pre-send check couldn't be completed. Your draft was kept; try again.",
          ),
        );
      },
    });
  }

  const shown = snapshot ? presentation(snapshot.result) : null;

  return (
    <section
      aria-labelledby={`${id}-title`}
      aria-busy={isRunning}
      className="rounded-lg border p-4 sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id={`${id}-title`} className="text-base font-medium">
            Pre-send check for a draft
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Content quality, voice alignment, and predicted placement for the
            exact subject, sender, and body below.
          </p>
        </div>
        <Badge variant="outline">Advisory only</Badge>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        This review does not authorize a send. Verify sender identity, consent,
        suppressions, approvals, links, and final campaign settings in the
        campaign workflow.
      </p>

      <form noValidate className="mt-4 space-y-4" onSubmit={submit}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor={`${id}-subject`}>Subject</Label>
            <Input
              id={`${id}-subject`}
              className="mt-2"
              autoComplete="off"
              value={subject}
              onChange={(event) => edit(setSubject, event.target.value)}
            />
          </div>
          <div>
            <Label htmlFor={`${id}-sender`}>Sender email</Label>
            <Input
              id={`${id}-sender`}
              className="mt-2"
              type="email"
              inputMode="email"
              autoComplete="off"
              spellCheck={false}
              value={sender}
              aria-invalid={sender.trim() !== "" && !senderValid}
              aria-describedby={`${id}-sender-hint`}
              onChange={(event) => edit(setSender, event.target.value)}
            />
            <p id={`${id}-sender-hint`} className="mt-1 text-xs text-muted-foreground">
              {sender.trim() !== "" && !senderValid
                ? "Enter a complete sender email address."
                : "The From address; its domain's authentication is graded."}
            </p>
          </div>
        </div>
        <div>
          <Label htmlFor={`${id}-body`}>Message body</Label>
          <Textarea
            id={`${id}-body`}
            className="mt-2"
            rows={7}
            value={body}
            placeholder="Paste the full HTML or plain-text body."
            onChange={(event) => edit(setBody, event.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            loading={isRunning}
            disabled={!canRun || !draftReady}
            aria-describedby={`${id}-submit-hint`}
          >
            {isRunning ? "Running checks…" : "Run pre-send check"}
          </Button>
          <span id={`${id}-submit-hint`} className="text-xs text-muted-foreground">
            {!canRun
              ? (blockedReason ??
                "Owner, admin, or editor access outside viewer mode is required to run this review.")
              : draftReady
                ? "Results apply only to the current draft values."
                : "Complete all three fields with a valid sender email."}
          </span>
        </div>
      </form>

      <div aria-live="polite" className="mt-4 space-y-3">
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Review unavailable</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {snapshot && shown ? (
          <article className="rounded-lg border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-medium">
                {current
                  ? shown.label
                  : `Previous result — was ${shown.label.toLowerCase()}`}
              </h3>
              <Badge variant={current ? shown.variant : "outline"}>
                {current ? "Current draft" : isRunning ? "Rechecking" : "Draft changed"}
              </Badge>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              {current
                ? shown.summary
                : "Retained for comparison only. It does not describe the draft currently in the fields above."}
            </p>
            <p className="mt-2 text-sm">{snapshot.result.summary}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              {snapshot.result.complete
                ? "3 of 3 checks completed"
                : "Incomplete — do not infer a pass"}{" "}
              · based on “{snapshot.subject}” from {snapshot.sender} ·{" "}
              {snapshot.bodyLength.toLocaleString()} body characters · computed{" "}
              {new Date(snapshot.result.computedAt).toLocaleString()}
            </p>
            <ul
              aria-label="Pre-send check results"
              className="mt-3 divide-y rounded-lg border"
            >
              {snapshot.result.components.map((component) => (
                <li
                  key={component.name}
                  className="flex flex-col gap-1 p-3 text-sm sm:flex-row sm:items-start sm:justify-between sm:gap-4"
                >
                  <div className="min-w-0">
                    <p className="font-medium">{LABELS[component.name]}</p>
                    <p className="mt-0.5 break-words text-muted-foreground">
                      {component.error ||
                        component.message ||
                        (component.received
                          ? "No additional guidance was returned."
                          : "This expected check was missing from the response.")}
                    </p>
                  </div>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {statusLabel(component.status)} · {scoreLabel(component)}
                  </span>
                </li>
              ))}
            </ul>
          </article>
        ) : null}
      </div>
    </section>
  );
}
