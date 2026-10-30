// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FlaskConical,
  LayoutTemplate,
  Plus,
} from "lucide-react";

import { SubjectBriefAssistantForSession } from "@/components/ai/subject-brief-assistant";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { AI_DISCLOSURE_TEXT } from "@postwave/ai-disclosure";

export interface CampaignCreateDraft {
  name: string;
  subject: string;
  bodyHtml?: string;
  previewText?: string;
}

export function CampaignCreateDialog({
  canWrite,
  draft,
  onCreate,
  onCreateABTest,
  onDraftChange,
  onOpenChange,
  onRetryAudiences,
  onRetrySuggestions,
  onSubjectChange,
  open,
  readOnlyMessage,
  abCreateError,
  audienceError,
  audienceLoading,
  audienceSegments,
  creatingABTest,
  suggestions,
  suggestError,
  suggestLoading,
  suggestUnavailable = false,
}: {
  abCreateError: string | null;
  audienceError: boolean;
  audienceLoading: boolean;
  audienceSegments: readonly { id: string; name: string }[];
  creatingABTest: boolean;
  canWrite: boolean;
  draft: CampaignCreateDraft;
  /** Resolves when the create settles, so the dialog can hold its own gate. */
  onCreate: () => void | Promise<void>;
  onCreateABTest: (segmentId: string) => void;
  onDraftChange: (draft: CampaignCreateDraft) => void;
  onOpenChange: (open: boolean) => void;
  onRetryAudiences: () => void;
  /** Ask for suggestions again after the AI service was unavailable. */
  onRetrySuggestions?: () => void;
  onSubjectChange: (subject: string) => void;
  open: boolean;
  readOnlyMessage: string;
  suggestions: readonly string[];
  suggestError: string | null;
  suggestLoading: boolean;
  /**
   * The AI service failed for this dialog session. Suggestions stop being
   * requested on every keystroke; one quiet line says so, with a way to try
   * again. Creating the campaign never depends on them.
   */
  suggestUnavailable?: boolean;
}) {
  const [submitted, setSubmitted] = useState(false);
  const [creating, setCreating] = useState(false);
  // POST /api/v1/campaigns carries no idempotency key, so a second submit that
  // lands before the first settles creates a second campaign. State alone is
  // too late — the duplicate click arrives before React re-renders with the
  // disabled button — so the ref is the gate and `creating` only paints it.
  const createInFlightRef = useRef(false);
  const [abAudienceId, setAbAudienceId] = useState("");
  // "Start from a brief" (desktop SubjectLineAssistant): collapsed until
  // asked for, so opening the dialog costs no history reads.
  const [briefOpen, setBriefOpen] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const subjectInputRef = useRef<HTMLInputElement>(null);
  const nameError =
    submitted && !draft.name.trim() ? "Name is required." : null;
  const subjectError =
    submitted && !draft.subject.trim() ? "Subject is required." : null;
  const selectedAudienceId = audienceSegments.some(
    (segment) => segment.id === abAudienceId,
  )
    ? abAudienceId
    : (audienceSegments[0]?.id ?? "");
  const abActionLabel =
    suggestions.length === 3
      ? "A/B test all three"
      : suggestions.length === 2
        ? "A/B test both"
        : `A/B test all ${suggestions.length}`;

  const handleSubmit = async () => {
    if (!canWrite || createInFlightRef.current) return;
    setSubmitted(true);
    if (!draft.name.trim()) {
      nameInputRef.current?.focus();
      return;
    }
    if (!draft.subject.trim()) {
      subjectInputRef.current?.focus();
      return;
    }
    setSubmitted(false);
    createInFlightRef.current = true;
    setCreating(true);
    try {
      await onCreate();
    } finally {
      // Released on failure too: the parent reports the error and leaves the
      // dialog open, so the operator must be able to try again.
      createInFlightRef.current = false;
      setCreating(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next && !canWrite) return;
        if (!next && creatingABTest) return;
        if (!next) setSubmitted(false);
        onOpenChange(next);
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          data-tour="dashboard-new-campaign"
          disabled={!canWrite}
          title={!canWrite ? readOnlyMessage : undefined}
        >
          <Plus className="h-4 w-4" />
          New campaign
        </Button>
      </DialogTrigger>
      <DialogContent aria-busy={creatingABTest} closeDisabled={creatingABTest}>
        <DialogHeader>
          <DialogTitle>New campaign</DialogTitle>
          <DialogDescription>
            Name it and draft a subject to get started — you&apos;ll build the
            email next.
          </DialogDescription>
        </DialogHeader>
        {!canWrite ? (
          <p
            className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground"
            role="note"
          >
            {readOnlyMessage}
          </p>
        ) : null}
        <form
          className="grid gap-4 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="campaign-name">Name</Label>
            <Input
              ref={nameInputRef}
              id="campaign-name"
              value={draft.name}
              disabled={!canWrite || creatingABTest}
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? "campaign-name-error" : undefined}
              onChange={(e) =>
                onDraftChange({ ...draft, name: e.target.value })
              }
            />
            {nameError ? (
              <p id="campaign-name-error" className="text-xs text-destructive">
                {nameError}
              </p>
            ) : null}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="campaign-subject">Subject</Label>
            <Input
              ref={subjectInputRef}
              id="campaign-subject"
              value={draft.subject}
              disabled={!canWrite || creatingABTest}
              aria-invalid={subjectError ? true : undefined}
              aria-describedby={
                subjectError ? "campaign-subject-error" : undefined
              }
              onChange={(e) => {
                onDraftChange({ ...draft, subject: e.target.value });
                onSubjectChange(e.target.value);
              }}
            />
            {subjectError ? (
              <p
                id="campaign-subject-error"
                className="text-xs text-destructive"
              >
                {subjectError}
              </p>
            ) : null}
          </div>
          {suggestUnavailable ? (
            <p
              data-testid="ai-subject-suggestions-unavailable"
              className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground"
              role="status"
            >
              <span>
                AI suggestions are unavailable right now. You can still create
                the campaign.
              </span>
              {onRetrySuggestions ? (
                <button
                  type="button"
                  className="inline-flex min-h-8 items-center font-medium text-primary underline-offset-2 hover:underline focus-visible:underline"
                  onClick={onRetrySuggestions}
                >
                  Try suggestions again
                </button>
              ) : null}
            </p>
          ) : suggestions.length > 0 || suggestLoading || suggestError ? (
            <div
              data-testid="ai-subject-suggestions"
              className="rounded-md border bg-muted/30 p-3 text-sm"
            >
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                AI suggestions
              </div>
              <p role="note" className="mb-2 text-xs text-muted-foreground">
                {AI_DISCLOSURE_TEXT}
              </p>
              <ul className="space-y-1.5">
                {suggestLoading ? (
                  <li className="text-xs text-muted-foreground">Thinking...</li>
                ) : suggestError ? (
                  <li className="text-xs text-muted-foreground">
                    {suggestError}
                  </li>
                ) : (
                  suggestions.map((suggestion, index) => (
                    <li key={`${index}-${suggestion}`}>
                      <button
                        type="button"
                        disabled={!canWrite || creatingABTest}
                        className="inline-flex min-h-8 items-center text-left text-sm hover:underline"
                        onClick={() => {
                          onDraftChange({ ...draft, subject: suggestion });
                          onSubjectChange(suggestion);
                        }}
                      >
                        {suggestion}
                      </button>
                    </li>
                  ))
                )}
              </ul>
              {!suggestLoading && !suggestError && suggestions.length >= 2 ? (
                <div className="mt-3 grid gap-2 border-t pt-3">
                  <Label htmlFor="campaign-ab-audience">Test audience</Label>
                  <Select
                    id="campaign-ab-audience"
                    value={selectedAudienceId}
                    disabled={
                      !canWrite ||
                      creatingABTest ||
                      audienceLoading ||
                      audienceSegments.length === 0
                    }
                    aria-invalid={audienceError || undefined}
                    aria-describedby={
                      audienceError
                        ? "campaign-ab-guidance campaign-ab-audience-error"
                        : "campaign-ab-guidance"
                    }
                    onChange={(event) => setAbAudienceId(event.target.value)}
                  >
                    {audienceLoading ? (
                      <option value="">Loading saved segments…</option>
                    ) : audienceSegments.length === 0 ? (
                      <option value="">No saved segments available</option>
                    ) : (
                      audienceSegments.map((segment) => (
                        <option key={segment.id} value={segment.id}>
                          {segment.name}
                        </option>
                      ))
                    )}
                  </Select>
                  {audienceError ? (
                    <div
                      id="campaign-ab-audience-error"
                      className="flex flex-col items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive sm:flex-row sm:items-center sm:justify-between"
                      role="alert"
                    >
                      <span>Couldn&apos;t load saved segment audiences.</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!canWrite}
                        onClick={onRetryAudiences}
                      >
                        Retry audiences
                      </Button>
                    </div>
                  ) : !audienceLoading && audienceSegments.length === 0 ? (
                    <p className="text-xs text-muted-foreground" role="note">
                      Create a saved segment first so every variant has an
                      explicit, identical audience.
                    </p>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    disabled={
                      !canWrite ||
                      creatingABTest ||
                      // A plain create already in flight is an unfinished write
                      // of the same draft; starting the A/B variant now would
                      // land a second set of campaigns from one draft.
                      creating ||
                      audienceLoading ||
                      audienceError ||
                      !selectedAudienceId
                    }
                    aria-describedby="campaign-ab-guidance"
                    onClick={() => onCreateABTest(selectedAudienceId)}
                  >
                    <FlaskConical className="h-4 w-4" />
                    {creatingABTest ? "Creating A/B test…" : abActionLabel}
                  </Button>
                  {abCreateError ? (
                    <p
                      className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive"
                      role="alert"
                    >
                      {abCreateError}
                    </p>
                  ) : null}
                  <p
                    id="campaign-ab-guidance"
                    className="text-[11px] leading-relaxed text-muted-foreground"
                  >
                    Creates one draft test with these subjects and the selected
                    audience. If Name is blank, the current subject names the
                    draft. Nothing sends until you review and launch it.
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}
          {/* Submit lives inside the form so Enter in either field submits. */}
          <button
            type="submit"
            className="sr-only"
            aria-hidden
            tabIndex={-1}
            disabled={!canWrite || creatingABTest || creating}
          >
            Create
          </button>
        </form>
        {/* Outside the form: the assistant has its own form, and a nested
            submit must never reach the campaign create above. */}
        <div className="rounded-md border p-3">
          <button
            type="button"
            className="flex w-full items-center gap-2 text-left text-sm font-medium"
            aria-expanded={briefOpen}
            aria-controls="campaign-create-brief-assistant"
            onClick={() => setBriefOpen((value) => !value)}
          >
            {briefOpen ? (
              <ChevronDown className="h-4 w-4" aria-hidden />
            ) : (
              <ChevronRight className="h-4 w-4" aria-hidden />
            )}
            Start from a brief
          </button>
          <div
            id="campaign-create-brief-assistant"
            hidden={!briefOpen}
            className="mt-3"
          >
            {briefOpen ? (
              <SubjectBriefAssistantForSession
                onUseSubject={
                  canWrite && !creatingABTest
                    ? (subject) => {
                        onDraftChange({ ...draft, subject });
                        onSubjectChange(subject);
                      }
                    : undefined
                }
              />
            ) : null}
          </div>
        </div>
        <DialogFooter className="sm:justify-between">
          <Button asChild variant="ghost" type="button">
            <Link
              href="/app/templates"
              aria-disabled={!canWrite || creatingABTest}
              title={!canWrite ? readOnlyMessage : undefined}
              tabIndex={!canWrite || creatingABTest ? -1 : undefined}
              onClick={(event) => {
                if (!canWrite || creatingABTest) event.preventDefault();
              }}
            >
              <LayoutTemplate className="h-4 w-4" />
              Start from a template
            </Link>
          </Button>
          <div className="flex gap-2">
            <DialogClose asChild>
              <Button variant="ghost" type="button" disabled={creatingABTest}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={!canWrite || creatingABTest || creating}
              title={!canWrite ? readOnlyMessage : undefined}
            >
              {creating ? "Creating…" : "Create"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
