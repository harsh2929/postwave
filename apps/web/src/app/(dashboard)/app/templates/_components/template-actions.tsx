// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
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
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api";
import {
  campaignTemplateActionReason,
  campaignTemplateCapabilities,
  campaignTemplateHostedPreviewAssets,
  createCampaignFromTemplate,
  isVisualOnlyCampaignTemplate,
  type CampaignTemplate,
  type CreateCampaignTemplateDesignInput,
} from "@/lib/campaign-templates-api";
import { listLists } from "@/lib/forms-api";
import type { ListRef } from "@/lib/forms-types";
import { listSegments, type Segment } from "@/lib/segments-api";
import { cn } from "@/lib/utils";
import { useTemplateGenerationAvailability } from "@/lib/use-template-generation-availability";

import { CampaignTemplateDesignReview } from "./campaign-template-design-review";
import { CampaignTemplateReferencePicker } from "./campaign-template-reference-picker";
import { PreviewImage } from "./preview-image";
import { TemplatePreviewFrame } from "./template-preview";
import {
  describeUnfilledDraftFields,
  suppliedVariableValues,
} from "./unfilled-draft-fields";
import { useCampaignTemplateDesignWorkflow } from "./use-campaign-template-design-workflow";

interface AudienceSelection {
  segment_id?: string;
  list_id?: string | number;
}

function defaultCampaignName(name: string) {
  return `${name} campaign`;
}

type AdaptationFidelity = "close" | "balanced" | "inspired";

const FIDELITY_OPTIONS: Array<{
  value: AdaptationFidelity;
  label: string;
  description: string;
}> = [
  {
    value: "close",
    label: "Keep the layout idea",
    description:
      "Retain the broad information hierarchy with original styling and copy.",
  },
  {
    value: "balanced",
    label: "Use the general vibe",
    description: "Balance recognizable art direction with a new structure.",
  },
  {
    value: "inspired",
    label: "Loose inspiration",
    description:
      "Use the reference as one signal and create a fresh direction.",
  },
];

function useAudienceOptions(enabled: boolean) {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [lists, setLists] = useState<ListRef[]>([]);
  const [failed, setFailed] = useState({ segments: false, lists: false });
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled || loaded) return;
    let active = true;
    setLoading(true);
    void Promise.allSettled([listSegments(), listLists()]).then(
      ([segmentsResult, listsResult]) => {
        if (!active) return;
        if (segmentsResult.status === "fulfilled") {
          setSegments(segmentsResult.value);
        }
        if (listsResult.status === "fulfilled") setLists(listsResult.value);
        setFailed({
          segments: segmentsResult.status === "rejected",
          lists: listsResult.status === "rejected",
        });
        // Only a fully successful load latches. A dropped request would
        // otherwise leave the picker showing a missing optgroup for the rest
        // of the dialog's life, which reads as "this workspace has none".
        setLoaded(
          segmentsResult.status === "fulfilled" &&
            listsResult.status === "fulfilled",
        );
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [attempt, enabled, loaded]);

  return {
    segments,
    lists,
    failureMessage:
      failed.segments && failed.lists
        ? "Segments and lists could not be loaded."
        : failed.segments
          ? "Segments could not be loaded."
          : failed.lists
            ? "Lists could not be loaded."
            : null,
    retrying: loading,
    retry: () => setAttempt((current) => current + 1),
  };
}

function decodeAudience(value: string): AudienceSelection {
  if (value.startsWith("segment:")) return { segment_id: value.slice(8) };
  if (value.startsWith("list:")) return { list_id: value.slice(5) };
  return {};
}

export function UseTemplateDialog({
  template,
  label = "Use template",
  variant = "default",
  size = "default",
  triggerClassName,
  open: controlledOpen,
  onOpenChange,
  showTrigger = true,
  onCloseAutoFocus,
}: {
  template: CampaignTemplate;
  label?: string;
  variant?: "default" | "outline" | "secondary" | "ghost";
  size?: "default" | "sm" | "lg";
  triggerClassName?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  showTrigger?: boolean;
  onCloseAutoFocus?: () => void;
}) {
  const router = useRouter();
  const capabilities = campaignTemplateCapabilities(template);
  const actionReason = campaignTemplateActionReason(template);
  const actionReasonID = `use-template-${encodeURIComponent(template.id)}-reason`;
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [name, setName] = useState(defaultCampaignName(template.name));
  const [subject, setSubject] = useState(template.subject);
  const subjectHasTags = /\{\{[^}]*\}\}/.test(subject);
  const [audience, setAudience] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const {
    segments,
    lists,
    failureMessage: audienceFailure,
    retrying: audienceRetrying,
    retry: retryAudienceOptions,
  } = useAudienceOptions(open);

  const submit = async () => {
    if (!name.trim() || !subject.trim()) {
      setError("Campaign name and subject are required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const campaign = await createCampaignFromTemplate({
        template_id: template.id,
        name: name.trim(),
        subject: subject.trim(),
        variables: suppliedVariableValues(template),
        ...decodeAudience(audience),
      });
      const unfilled = describeUnfilledDraftFields(
        template,
        campaign.unresolved_variables,
      );
      if (unfilled) {
        toast.warning("Campaign draft created", { description: unfilled });
      } else {
        toast.success("Campaign draft created");
      }
      setOpen(false);
      router.push(`/app/campaigns/${campaign.id}`);
    } catch (submitError) {
      setError(
        apiErrorMessage(submitError, "Could not create the campaign draft."),
      );
    } finally {
      setBusy(false);
    }
  };

  if (!capabilities.can_create_campaign) {
    if (!showTrigger) return null;
    return (
      <>
        <Button
          type="button"
          variant={variant}
          size={size}
          className={triggerClassName}
          aria-disabled="true"
          aria-describedby={actionReasonID}
        >
          Preview only
        </Button>
        <span id={actionReasonID} className="sr-only">
          {actionReason}
        </span>
      </>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {showTrigger ? (
        <DialogTrigger asChild>
          <Button
            type="button"
            variant={variant}
            size={size}
            className={triggerClassName}
          >
            {label}
          </Button>
        </DialogTrigger>
      ) : null}
      <DialogContent
        onCloseAutoFocus={(event) => {
          if (!onCloseAutoFocus) return;
          event.preventDefault();
          onCloseAutoFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Start from {template.name}</DialogTitle>
          <DialogDescription>
            This creates an editable campaign draft. Nothing is sent or
            scheduled automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-1">
          <div className="grid gap-1.5">
            <Label htmlFor={`campaign-name-${template.id}`}>
              Campaign name
            </Label>
            <Input
              id={`campaign-name-${template.id}`}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`campaign-subject-${template.id}`}>Subject</Label>
            <Input
              id={`campaign-subject-${template.id}`}
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              aria-describedby={
                subjectHasTags ? `campaign-subject-${template.id}-hint` : undefined
              }
            />
            {subjectHasTags ? (
              <p
                id={`campaign-subject-${template.id}-hint`}
                className="text-xs text-muted-foreground"
              >
                Text in {"{{ double braces }}"} is filled in when the draft is
                created, from your workspace settings and the template&apos;s
                sample text.
              </p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`campaign-audience-${template.id}`}>
              Audience (optional)
            </Label>
            <Select
              id={`campaign-audience-${template.id}`}
              value={audience}
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
            {audienceFailure ? (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs text-destructive" role="alert">
                  {audienceFailure} A missing group here is a failed request,
                  not an empty workspace — retry, or pick the audience in the
                  editor.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={audienceRetrying}
                  onClick={retryAudienceOptions}
                >
                  {audienceRetrying ? "Retrying…" : "Retry"}
                </Button>
              </div>
            ) : null}
          </div>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={busy} onClick={() => void submit()}>
            {busy ? "Creating draft…" : "Create campaign draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AdaptTemplateDialog({
  template,
  label = "Make it mine",
  size = "default",
  triggerClassName,
  open: controlledOpen,
  onOpenChange,
  showTrigger = true,
  onCloseAutoFocus,
  editorSource = false,
}: {
  template: CampaignTemplate;
  label?: string;
  size?: "default" | "sm" | "lg";
  triggerClassName?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  showTrigger?: boolean;
  onCloseAutoFocus?: () => void;
  /** Editor entry point: clarify the saved-source and new-template boundary. */
  editorSource?: boolean;
}) {
  const capabilities = campaignTemplateCapabilities(template);
  const generationAvailability = useTemplateGenerationAvailability(capabilities.can_adapt);
  const actionReason = campaignTemplateActionReason(template);
  const actionReasonID = `adapt-template-${encodeURIComponent(template.id)}-reason`;
  const visualOnly = isVisualOnlyCampaignTemplate(template);
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [showComposer, setShowComposer] = useState(true);
  const [brief, setBrief] = useState("");
  const [tone, setTone] = useState("");
  const [content, setContent] = useState("");
  const [fidelity, setFidelity] = useState<AdaptationFidelity>("balanced");
  const [audience, setAudience] = useState("");
  const [sections, setSections] = useState("");
  const [cta, setCTA] = useState("");
  const [additionalReferences, setAdditionalReferences] = useState<string[]>(
    [],
  );
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const workflow = useCampaignTemplateDesignWorkflow({
    mode: "adapt",
    sourceTemplateId: template.id,
    enabled: open,
  });

  useEffect(() => {
    if (workflow.selectedDesign) setShowComposer(false);
  }, [workflow.selectedDesign]);

  const close = () => {
    if (workflow.awaitingAcknowledgement) {
      setConfirmCloseOpen(true);
      return;
    }
    setOpen(false);
  };

  const changeOpen = (next: boolean) => {
    if (!next) {
      close();
      return;
    }
    setOpen(true);
  };

  const discard = async () => {
    const discarded = await workflow.discard();
    if (!discarded) {
      setConfirmDiscardOpen(false);
      return;
    }
    setBrief("");
    setTone("");
    setContent("");
    setFidelity("balanced");
    setAudience("");
    setSections("");
    setCTA("");
    setAdditionalReferences([]);
    setShowComposer(true);
    setConfirmDiscardOpen(false);
    setOpen(false);
  };

  const adapt = async () => {
    if (!brief.trim()) {
      workflow.setError(
        "Describe the audience, content, and changes you want.",
      );
      return;
    }
    if (workflow.designs.length) {
      workflow.setError(
        "Discard the earlier design before starting a new one, or refine the design you already have.",
      );
      return;
    }
    const requestedSections = sections
      .split(/[,\n]/)
      .map((section) => section.trim())
      .filter(Boolean)
      .slice(0, 12);
    const input: CreateCampaignTemplateDesignInput = {
      mode: "adapt",
      source_template_id: template.id,
      instructions: brief.trim(),
      tone: tone.trim() || undefined,
      fidelity,
      audience: audience.trim() || undefined,
      sections: requestedSections.length ? requestedSections : undefined,
      cta: cta.trim() || undefined,
      content: content.trim() ? { source_text: content.trim() } : undefined,
      reference_template_ids: additionalReferences,
    };
    setShowComposer(false);
    const results = await workflow.start(input);
    if (!results.length && !workflow.designs.length) setShowComposer(true);
  };

  // The asset record, not just its URL: `width`/`height` are what let the
  // browser reserve this box before the screenshot decodes. Ordered
  // desktop -> card -> mobile by campaignTemplateHostedPreviewAssets, matching
  // the preference campaignTemplatePreviewUrl applied here previously.
  const sourceHostedPreviewAsset =
    campaignTemplateHostedPreviewAssets(template)[0];
  const sourceHostedPreview = sourceHostedPreviewAsset?.url;
  const sourcePreview =
    template.template_kind !== "reference" && template.body_html?.trim() ? (
      <TemplatePreviewFrame
        html={template.body_html}
        title={`${template.name} inspiration preview`}
        compact
      />
    ) : (
      <div className="rounded-lg border bg-muted/30 p-3">
        <PreviewImage
          src={sourceHostedPreview}
          alt={`Inspiration preview of ${template.name}`}
          width={sourceHostedPreviewAsset?.width}
          height={sourceHostedPreviewAsset?.height}
          className="mx-auto max-h-[440px] max-w-full rounded border bg-white object-contain"
          wrapperClassName="min-h-72"
        />
      </div>
    );

  if (!capabilities.can_adapt) {
    if (!showTrigger) return null;
    return (
      <>
        <Button
          type="button"
          variant="outline"
          size={size}
          className={triggerClassName}
          aria-disabled="true"
          aria-describedby={actionReasonID}
        >
          {template.review_status === "pending"
            ? "Awaiting review"
            : "Preview only"}
        </Button>
        <span id={actionReasonID} className="sr-only">
          {actionReason}
        </span>
      </>
    );
  }

  if (generationAvailability !== "available" && !open) {
    if (!showTrigger) return null;
    return <Button type="button" variant="outline" size={size} className={triggerClassName} disabled>
      <Sparkles className="h-4 w-4" aria-hidden />
      {generationAvailability === "checking" ? "Checking AI…" : generationAvailability === "error" ? "AI temporarily unavailable" : "AI adaptation · Coming soon"}
    </Button>;
  }

  return (
    <>
      <Dialog open={open} onOpenChange={changeOpen}>
        {showTrigger ? (
          <DialogTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size={size}
              className={triggerClassName}
            >
              <Sparkles className="h-4 w-4" aria-hidden />
              {label}
            </Button>
          </DialogTrigger>
        ) : null}
        <DialogContent
          className="max-w-6xl"
          onCloseAutoFocus={(event) => {
            if (!onCloseAutoFocus) return;
            event.preventDefault();
            onCloseAutoFocus();
          }}
          onEscapeKeyDown={(event) => {
            if (!workflow.awaitingAcknowledgement) return;
            event.preventDefault();
            setConfirmCloseOpen(true);
          }}
          onPointerDownOutside={(event) => {
            if (!workflow.awaitingAcknowledgement) return;
            event.preventDefault();
            setConfirmCloseOpen(true);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {editorSource
                ? `Describe a change to ${template.name}`
                : `Make ${template.name} yours`}
            </DialogTitle>
            <DialogDescription>
              {editorSource
                ? "Start from your saved template, review the changes side by side, then save a new version. Your original stays intact."
                : "Use this design as inspiration, then review the result on desktop and mobile before saving it or creating a campaign draft."}
            </DialogDescription>
          </DialogHeader>

          {workflow.recoveryPersistenceAvailable === false ? (
            <Alert variant="warning" role="alert">
              <AlertTitle>This browser cannot save your place</AlertTitle>
              <AlertDescription>
                Keep this window open until Moosewave confirms your request.
                Browser privacy settings may prevent you from resuming it later.
              </AlertDescription>
            </Alert>
          ) : null}

          {workflow.recovering ? (
            <div
              className="grid min-h-[360px] place-items-center text-center"
              aria-live="polite"
            >
              <div className="space-y-2">
                <Sparkles
                  className="mx-auto h-7 w-7 animate-pulse text-primary"
                  aria-hidden
                />
                <p className="font-medium">Recovering your adaptation…</p>
                <p className="text-sm text-muted-foreground">
                  Bringing back your latest saved design.
                </p>
              </div>
            </div>
          ) : workflow.selectedDesign && !showComposer ? (
            <CampaignTemplateDesignReview
              design={workflow.selectedDesign}
              revisions={workflow.revisions}
              sourcePreview={sourcePreview}
              sourceName="Inspiration"
              working={workflow.working}
              error={workflow.error}
              onError={workflow.setError}
              onRefine={workflow.refine}
              onRetry={workflow.retry}
              onRefresh={workflow.refresh}
              onSaveExact={workflow.saveExactRevision}
              onCreateCampaignExact={workflow.createCampaignExactRevision}
              onSaved={async () => {
                await workflow.refresh();
              }}
              onCampaignCreated={async () => {
                await workflow.refresh();
              }}
              recoveryPersistenceAvailable={
                workflow.recoveryPersistenceAvailable
              }
              onBack={() => setShowComposer(true)}
              onDiscard={() => setConfirmDiscardOpen(true)}
            />
          ) : (
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
              <div className="space-y-4">
                {visualOnly ? (
                  <Alert>
                    <AlertTitle>Visual inspiration</AlertTitle>
                    <AlertDescription>
                      No editable source is exposed for this reference. Moosewave
                      uses its preview and design details to create an
                      original, editable newsletter; an exact match is not
                      expected.
                    </AlertDescription>
                  </Alert>
                ) : null}
                {workflow.designs.length ? (
                  <Alert>
                    <AlertTitle>An earlier design is available</AlertTitle>
                    <AlertDescription>
                      Return to review and refine it, or discard it before
                      starting a separate design.
                    </AlertDescription>
                  </Alert>
                ) : null}
                <div className="grid gap-1.5">
                  <Label htmlFor={`adapt-brief-${template.id}`}>
                    {editorSource
                      ? "What would you like to change?"
                      : "What should this email say?"}
                  </Label>
                  <Textarea
                    id={`adapt-brief-${template.id}`}
                    rows={4}
                    maxLength={4000}
                    placeholder={
                      editorSource
                        ? "Shorten the introduction, move the main CTA above the stories, and make the footer calmer."
                        : "Monthly AI product roundup for technical founders. Lead with the launch, include three short links, and end with one clear CTA."
                    }
                    value={brief}
                    onChange={(event) => setBrief(event.target.value)}
                  />
                </div>
                <fieldset className="grid gap-2">
                  <legend className="text-sm font-medium">
                    How closely should it follow the inspiration?
                  </legend>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {FIDELITY_OPTIONS.map((option) => (
                      <label
                        key={option.value}
                        className={cn(
                          "cursor-pointer rounded-md border p-3 text-sm transition-colors",
                          fidelity === option.value
                            ? "border-primary bg-primary/5 ring-1 ring-primary"
                            : "hover:bg-muted/40",
                        )}
                      >
                        <input
                          type="radio"
                          name={`adapt-fidelity-${template.id}`}
                          value={option.value}
                          checked={fidelity === option.value}
                          onChange={() => setFidelity(option.value)}
                          className="sr-only"
                        />
                        <span className="block font-medium">
                          {option.label}
                        </span>
                        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                          {option.description}
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="grid gap-1.5">
                  <Label htmlFor={`adapt-content-${template.id}`}>
                    Source content (optional)
                  </Label>
                  <Textarea
                    id={`adapt-content-${template.id}`}
                    rows={5}
                    placeholder="Paste notes, links, headlines, or a rough newsletter draft."
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                  />
                </div>
                <details className="rounded-md border bg-muted/20 px-4 py-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    Audience, tone, sections, and CTA
                  </summary>
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <div className="grid gap-1.5">
                      <Label htmlFor={`adapt-audience-${template.id}`}>
                        Audience
                      </Label>
                      <Input
                        id={`adapt-audience-${template.id}`}
                        maxLength={1500}
                        value={audience}
                        onChange={(event) => setAudience(event.target.value)}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor={`adapt-tone-${template.id}`}>Tone</Label>
                      <Input
                        id={`adapt-tone-${template.id}`}
                        maxLength={500}
                        value={tone}
                        onChange={(event) => setTone(event.target.value)}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor={`adapt-sections-${template.id}`}>
                        Sections
                      </Label>
                      <Textarea
                        id={`adapt-sections-${template.id}`}
                        rows={3}
                        value={sections}
                        onChange={(event) => setSections(event.target.value)}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor={`adapt-cta-${template.id}`}>
                        Primary CTA
                      </Label>
                      <Textarea
                        id={`adapt-cta-${template.id}`}
                        rows={3}
                        maxLength={1500}
                        value={cta}
                        onChange={(event) => setCTA(event.target.value)}
                      />
                    </div>
                  </div>
                </details>
                {workflow.error ? (
                  <Alert variant="destructive">
                    <AlertDescription>{workflow.error}</AlertDescription>
                  </Alert>
                ) : null}
              </div>

              <CampaignTemplateReferencePicker
                selected={additionalReferences}
                onChange={setAdditionalReferences}
                max={2}
                excludeId={template.id}
              />

              <DialogFooter className="lg:col-span-2">
                {workflow.designs.length ? (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setConfirmDiscardOpen(true)}
                    >
                      Discard this design
                    </Button>
                    <Button
                      type="button"
                      onClick={() => setShowComposer(false)}
                    >
                      Return to review
                    </Button>
                  </>
                ) : (
                  <>
                    <Button type="button" variant="ghost" onClick={close}>
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      disabled={workflow.working}
                      onClick={() => void adapt()}
                    >
                      <Sparkles className="h-4 w-4" aria-hidden />
                      {workflow.working
                        ? "Starting your design…"
                        : "Create adaptation"}
                    </Button>
                  </>
                )}
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmDiscardOpen}
        onOpenChange={setConfirmDiscardOpen}
        title="Discard this design?"
        description="It will no longer appear when you return. If it is still generating, wait for it to finish first."
        confirmLabel="Discard design"
        onConfirm={() => void discard()}
      />
      <ConfirmDialog
        open={confirmCloseOpen}
        onOpenChange={setConfirmCloseOpen}
        title={
          workflow.recoveryPersistenceAvailable === false
            ? "Keep this window open"
            : "Leave before Moosewave confirms?"
        }
        description={
          workflow.recoveryPersistenceAvailable === false
            ? "This browser cannot save your place. Leaving before confirmation may make the design hard to recover."
            : "Moosewave has not confirmed your request yet. Wait here to make sure your design is saved."
        }
        confirmLabel={
          workflow.recoveryPersistenceAvailable === false
            ? "Keep this open"
            : "Leave anyway"
        }
        cancelLabel="Keep waiting"
        onConfirm={() => {
          if (workflow.recoveryPersistenceAvailable === false) {
            setConfirmCloseOpen(false);
            return;
          }
          setOpen(false);
        }}
      />
    </>
  );
}
