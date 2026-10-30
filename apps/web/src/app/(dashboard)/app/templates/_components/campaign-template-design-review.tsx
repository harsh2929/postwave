// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  CheckCircle2,
  Columns2,
  History,
  RefreshCw,
  RotateCcw,
  Save,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  templateSlugFromName,
  type CampaignTemplateDesignDraft,
  type CampaignTemplateDesignRevision,
  type CreateCampaignFromDesignInput,
  type SaveCampaignTemplateDesignInput,
} from "@/lib/campaign-templates-api";
import { listLists } from "@/lib/forms-api";
import type { ListRef } from "@/lib/forms-types";
import { listSegments, type Segment } from "@/lib/segments-api";
import { reviewGeneratedTemplateGrounding } from "@/lib/template-grounding";
import { cn } from "@/lib/utils";

import { TemplatePreviewFrame } from "./template-preview";
import { campaignTemplateDesignMutationErrorMessage } from "./use-campaign-template-design-workflow";

type ComparisonMode = "result" | "source" | "side-by-side";
const COMPARISON_MODES: ComparisonMode[] = ["result", "source", "side-by-side"];

function validationIcon(status: "pass" | "warn" | "fail") {
  if (status === "pass") {
    return <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />;
  }
  return (
    <TriangleAlert
      className={cn(
        "h-4 w-4",
        status === "fail" ? "text-destructive" : "text-amber-600",
      )}
      aria-hidden
    />
  );
}

function useAudienceOptions() {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [lists, setLists] = useState<ListRef[]>([]);
  // A rejected arm of the settle simply leaves its optgroup out of the picker,
  // which reads as "this workspace has none" at the moment the operator is
  // choosing one. Keep the failure so the panel can say the list is short.
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void Promise.allSettled([listSegments(), listLists()]).then(
      ([segmentResult, listResult]) => {
        if (!active) return;
        if (segmentResult.status === "fulfilled") {
          setSegments(segmentResult.value);
        }
        if (listResult.status === "fulfilled") setLists(listResult.value);
        const failed = [
          segmentResult.status === "rejected" ? "segments" : null,
          listResult.status === "rejected" ? "lists" : null,
        ].filter(Boolean);
        setError(
          failed.length ? `Could not load ${failed.join(" or ")}.` : null,
        );
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);
  return {
    segments,
    lists,
    error,
    reload: () => setAttempt((current) => current + 1),
  };
}

function audienceInput(value: string) {
  if (value.startsWith("segment:")) return { segment_id: value.slice(8) };
  if (value.startsWith("list:")) return { list_id: value.slice(5) };
  return {};
}

export function CampaignTemplateDesignReview({
  design,
  revisions,
  sourcePreview,
  sourceName,
  working,
  error,
  recoveryPersistenceAvailable,
  onError,
  onRefine,
  onRetry,
  onRefresh,
  onSaveExact,
  onCreateCampaignExact,
  onSaved,
  onCampaignCreated,
  onBack,
  onDiscard,
}: {
  design: CampaignTemplateDesignDraft;
  revisions: CampaignTemplateDesignRevision[];
  sourcePreview?: ReactNode;
  sourceName?: string;
  working: boolean;
  error: string | null;
  recoveryPersistenceAvailable: boolean | null;
  onError: (message: string | null) => void;
  onRefine: (instructions: string) => Promise<boolean>;
  onRetry: () => Promise<unknown>;
  onRefresh: () => Promise<unknown>;
  onSaveExact: (
    input: SaveCampaignTemplateDesignInput,
  ) => Promise<{ id: string }>;
  onCreateCampaignExact: (
    input: CreateCampaignFromDesignInput,
  ) => Promise<{ id: string }>;
  onSaved: (templateId: string) => void;
  onCampaignCreated: (campaignId: string) => void | Promise<void>;
  onBack: () => void;
  onDiscard: () => void;
}) {
  const latest = design.revision;
  const [viewedRevision, setViewedRevision] = useState<number>();
  const [comparison, setComparison] = useState<ComparisonMode>("result");
  const [refinement, setRefinement] = useState("");
  const [campaignName, setCampaignName] = useState("");
  const [subject, setSubject] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [audience, setAudience] = useState("");
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const tabsID = useId();
  const initializedRevision = useRef<number | undefined>(undefined);
  const {
    segments,
    lists,
    error: audienceError,
    reload: reloadAudiences,
  } = useAudienceOptions();

  useEffect(() => {
    if (!latest) return;
    if (initializedRevision.current === latest.revision) return;
    initializedRevision.current = latest.revision;
    setViewedRevision(latest.revision);
    setCampaignName(`${latest.output.name} campaign`);
    setSubject(latest.output.subject);
    setTemplateName(latest.output.name);
  }, [latest]);

  const viewed =
    revisions.find((revision) => revision.revision === viewedRevision) ??
    latest;
  const viewingLatest = Boolean(
    latest && viewed && latest.revision === viewed.revision,
  );
  const reviewNotes = useMemo(() => {
    if (!viewed) return [];
    return Array.from(
      new Set([
        ...viewed.output.warnings,
        ...viewed.output.unresolved_variables.map(
          (variable) => `Resolve merge variable: ${variable}`,
        ),
        ...viewed.warnings.map((warning) => warning.message),
        ...reviewGeneratedTemplateGrounding(
          viewed.output.body_html,
          viewed.output.subject,
          design.request.content,
        ),
      ]),
    );
  }, [viewed, design.request.content]);

  const navigateComparisonTabs = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const current = COMPARISON_MODES.indexOf(comparison);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? COMPARISON_MODES.length - 1
          : (current +
              (event.key === "ArrowRight" ? 1 : -1) +
              COMPARISON_MODES.length) %
            COMPARISON_MODES.length;
    setComparison(COMPARISON_MODES[next]);
    const tabs =
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs[next]?.focus();
  };

  const save = async () => {
    if (!latest || !viewingLatest || !templateName.trim()) {
      onError(
        !templateName.trim()
          ? "A template name is required."
          : "Switch to the newest version before saving.",
      );
      return;
    }
    setSaving(true);
    onError(null);
    try {
      const saved = await onSaveExact({
        revision: latest.revision,
        output_hash: latest.output_hash,
        slug: templateSlugFromName(templateName),
        name: templateName.trim(),
        subject: subject.trim() || latest.output.subject,
        preview_text: latest.output.preview_text,
      });
      toast.success("Saved to your template library");
      onSaved(saved.id);
    } catch (saveError) {
      const message = campaignTemplateDesignMutationErrorMessage(
        saveError,
        "This version could not be saved.",
      );
      await onRefresh();
      onError(message);
    } finally {
      setSaving(false);
    }
  };

  const createCampaign = async () => {
    if (!latest || !viewingLatest) {
      onError("Switch to the newest version before creating a campaign.");
      return;
    }
    if (!campaignName.trim() || !subject.trim()) {
      onError("Campaign name and subject are required.");
      return;
    }
    setCreating(true);
    onError(null);
    try {
      const campaign = await onCreateCampaignExact({
        revision: latest.revision,
        output_hash: latest.output_hash,
        name: campaignName.trim(),
        subject: subject.trim(),
        preview_text: latest.output.preview_text,
        variables: latest.output.variables,
        ...audienceInput(audience),
      });
      toast.success("Campaign draft created");
      await onCampaignCreated(campaign.id);
    } catch (createError) {
      const message = campaignTemplateDesignMutationErrorMessage(
        createError,
        "A campaign could not be created from this version.",
      );
      await onRefresh();
      onError(message);
    } finally {
      setCreating(false);
    }
  };

  if (design.status === "queued" || design.status === "generating") {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-busy={working}
        className="grid min-h-[420px] place-items-center rounded-lg border bg-muted/20 p-4 text-center [&_button]:min-h-11 [&_button]:min-w-11 sm:p-8 sm:[&_button]:min-h-9"
      >
        <div className="max-w-md space-y-3">
          <RefreshCw
            className="mx-auto h-8 w-8 animate-spin text-primary motion-reduce:animate-none"
            aria-hidden
          />
          <h3 className="font-semibold">Building your newsletter</h3>
          <p className="text-sm text-muted-foreground">
            {recoveryPersistenceAvailable === false
              ? "Keep this window open until your design is ready; this browser cannot save your place."
              : "You can leave and return to this design from the same browser and workspace."}
          </p>
          <p className="text-xs text-muted-foreground">
            Attempt {Math.max(1, design.attempt_count)}
          </p>
          {error ? (
            <Alert variant="warning">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {!working ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void onRefresh()}
            >
              Check status and resume polling
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (design.status === "failed") {
    return (
      <div className="space-y-4 py-2 [&_button]:min-h-11 [&_button]:min-w-11 sm:[&_button]:min-h-9">
        <Alert variant="destructive">
          <AlertTitle>Design attempt failed</AlertTitle>
          <AlertDescription>
            {design.last_error_code === "design_expired"
              ? "This design expired. Start again with the preserved brief."
              : design.last_error_message ||
                "The generator could not complete this attempt."}
          </AlertDescription>
        </Alert>
        <div className="flex flex-wrap justify-end gap-2">
          {design.capabilities.can_archive ? (
            <Button type="button" variant="ghost" onClick={onDiscard}>
              Discard attempt
            </Button>
          ) : null}
          <Button type="button" variant="ghost" onClick={onBack}>
            Edit brief
          </Button>
          <Button
            type="button"
            disabled={working || !design.capabilities.can_retry}
            onClick={() => void onRetry()}
          >
            <RotateCcw className="h-4 w-4" aria-hidden />
            {working ? "Retrying…" : "Retry attempt"}
          </Button>
        </div>
      </div>
    );
  }

  if (!viewed || !latest) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          This design is marked ready, but there is no version to review yet.
          Refresh it before continuing.
        </AlertDescription>
      </Alert>
    );
  }

  const resultPreview = (
    <TemplatePreviewFrame
      html={viewed.output.body_html}
      title={`${viewed.output.name} version ${viewed.revision} preview`}
      compact
    />
  );

  return (
    <div className="grid gap-5 [&_button]:min-h-11 [&_button]:min-w-11 sm:[&_button]:min-h-9 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-3">
        {sourcePreview ? (
          <div
            className="flex flex-wrap gap-1 rounded-md border bg-muted/40 p-1"
            role="tablist"
            aria-label="Compare inspiration and result"
            onKeyDown={navigateComparisonTabs}
          >
            {(
              [
                ["result", "Your result"],
                ["source", sourceName || "Inspiration"],
                ["side-by-side", "Side by side"],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={comparison === value ? "secondary" : "ghost"}
                role="tab"
                aria-selected={comparison === value}
                aria-controls={`${tabsID}-panel`}
                id={`${tabsID}-${value}`}
                tabIndex={comparison === value ? 0 : -1}
                onClick={() => setComparison(value)}
              >
                {value === "side-by-side" ? (
                  <Columns2 className="h-4 w-4" aria-hidden />
                ) : null}
                {label}
              </Button>
            ))}
          </div>
        ) : null}
        <div
          {...(sourcePreview
            ? {
                role: "tabpanel",
                id: `${tabsID}-panel`,
                "aria-labelledby": `${tabsID}-${comparison}`,
              }
            : {})}
        >
          {comparison === "result" || !sourcePreview ? resultPreview : null}
          {comparison === "source" ? sourcePreview : null}
          {comparison === "side-by-side" && sourcePreview ? (
            <div className="grid gap-3 md:grid-cols-2">
              <section aria-label={sourceName || "Inspiration"}>
                {sourcePreview}
              </section>
              <section aria-label="Your result">{resultPreview}</section>
            </div>
          ) : null}
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Version {viewed.revision} · Saved snapshot
            </p>
            <h3 className="mt-1 text-lg font-semibold">{viewed.output.name}</h3>
          </div>
          <Badge
            variant={
              viewed.validation.status === "pass" ? "secondary" : "outline"
            }
          >
            Validation {viewed.validation.status}
          </Badge>
        </div>

        {revisions.length > 1 ? (
          <div className="space-y-2 rounded-md border p-3">
            <p className="flex items-center gap-1.5 text-xs font-medium">
              <History className="h-3.5 w-3.5" aria-hidden />
              Version history
            </p>
            <div className="flex flex-wrap gap-1.5">
              {revisions.map((revision) => (
                <Button
                  key={revision.id}
                  type="button"
                  size="sm"
                  variant={
                    revision.revision === viewed.revision
                      ? "secondary"
                      : "outline"
                  }
                  onClick={() => setViewedRevision(revision.revision)}
                >
                  v{revision.revision} · {revision.operation}
                </Button>
              ))}
            </div>
            {!viewingLatest ? (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                Earlier versions are for comparison. Switch to version {latest.revision}{" "}
                to make changes, save, or create a campaign.
              </p>
            ) : null}
          </div>
        ) : null}

        <details className="rounded-md border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">
            Validation checks ({viewed.validation.checks.length})
          </summary>
          <ul className="mt-3 space-y-2">
            {viewed.validation.checks.map((check) => (
              <li key={check.code} className="flex gap-2 text-xs">
                {validationIcon(check.status)}
                <span>
                  <span className="font-medium">
                    {check.code
                      .replace(/[_-]+/g, " ")
                      .replace(/\b\w/g, (character) => character.toUpperCase())}
                  </span>
                  <span className="block text-muted-foreground">
                    {check.message}
                    {check.repaired ? " Repaired automatically." : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </details>

        {reviewNotes.length ? (
          <Alert variant="warning">
            <AlertTitle>Review before use</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-1 pl-4">
                {reviewNotes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-1.5">
          <Label htmlFor={`design-campaign-name-${design.id}`}>
            Campaign name
          </Label>
          <Input
            id={`design-campaign-name-${design.id}`}
            value={campaignName}
            onChange={(event) => setCampaignName(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`design-subject-${design.id}`}>Subject</Label>
          <Input
            id={`design-subject-${design.id}`}
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`design-audience-${design.id}`}>
            Audience (optional)
          </Label>
          {audienceError ? (
            <div className="grid gap-1.5">
              <p
                id={`design-audience-error-${design.id}`}
                role="alert"
                className="text-xs text-destructive"
              >
                {audienceError} The choices below are incomplete, not an empty
                workspace.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="justify-self-start"
                onClick={reloadAudiences}
              >
                <RefreshCw className="h-4 w-4" aria-hidden />
                Retry
              </Button>
            </div>
          ) : null}
          <Select
            id={`design-audience-${design.id}`}
            value={audience}
            aria-describedby={
              audienceError ? `design-audience-error-${design.id}` : undefined
            }
            onChange={(event) => setAudience(event.target.value)}
          >
            <option value="">Choose later in the editor</option>
            {segments.length ? (
              <optgroup label="Segments">
                {segments.map((segment) => (
                  <option key={segment.id} value={`segment:${segment.id}`}>
                    {segment.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {lists.length ? (
              <optgroup label="Lists">
                {lists.map((list) => (
                  <option key={list.id} value={`list:${list.id}`}>
                    {list.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`design-template-name-${design.id}`}>
            Template name
          </Label>
          <Input
            id={`design-template-name-${design.id}`}
            value={templateName}
            disabled={Boolean(design.saved_template_id)}
            onChange={(event) => setTemplateName(event.target.value)}
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor={`design-refine-${design.id}`}>
            Refine this version
          </Label>
          <Textarea
            id={`design-refine-${design.id}`}
            rows={3}
            maxLength={4000}
            value={refinement}
            placeholder="Make the hero shorter and increase spacing between stories."
            onChange={(event) => setRefinement(event.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            disabled={
              working ||
              !viewingLatest ||
              !design.capabilities.can_refine ||
              !refinement.trim()
            }
            onClick={async () => {
              try {
                const accepted = await onRefine(refinement.trim());
                if (accepted) setRefinement("");
              } catch {
                // The workflow owns the actionable error message. Retaining
                // the instructions lets the user retry or reconcile a
                // revision conflict without recreating their request.
              }
            }}
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            {working ? "Making changes…" : "Make another version"}
          </Button>
        </div>

        {design.saved_template_id ? (
          <Alert>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              <span>
                This version is saved in your template library.
              </span>
              <Button asChild type="button" size="sm" variant="outline">
                <Link href={`/app/templates/${design.saved_template_id}`}>
                  Open saved template
                </Link>
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {design.created_campaign_id ? (
          <Alert>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              <span>
                A campaign draft was created from this version.
              </span>
              <Button asChild type="button" size="sm" variant="outline">
                <Link href={`/app/campaigns/${design.created_campaign_id}`}>
                  Open campaign draft
                </Link>
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={
              saving ||
              !viewingLatest ||
              !design.capabilities.can_save ||
              viewed.validation.status === "fail"
            }
            onClick={() => void save()}
          >
            <Save className="h-4 w-4" aria-hidden />
            {design.saved_template_id
              ? "Saved as template"
              : saving
                ? "Saving this version…"
                : "Save this version as template"}
          </Button>
          <Button
            type="button"
            disabled={
              creating ||
              !viewingLatest ||
              !design.capabilities.can_create_campaign ||
              viewed.validation.status === "fail"
            }
            onClick={() => void createCampaign()}
          >
            {design.created_campaign_id
              ? "Campaign draft created"
              : creating
                ? "Creating from this version…"
                : "Create campaign draft"}
          </Button>
          <Button type="button" variant="ghost" onClick={onBack}>
            Edit instructions
          </Button>
          {design.capabilities.can_archive ? (
            <Button type="button" variant="ghost" onClick={onDiscard}>
              Discard this design
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
