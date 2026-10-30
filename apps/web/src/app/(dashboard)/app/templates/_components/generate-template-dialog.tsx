// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Bookmark, History, Sparkles, X } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useId, useMemo, useRef, useState } from "react";

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
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useVerifiedAuthScopeOptional } from "@/lib/auth-scope";
import type {
  CampaignTemplateDesignDraft,
  CampaignTemplateSummary,
  CreateCampaignTemplateDesignInput,
} from "@/lib/campaign-templates-api";
import {
  pushRecentTemplateBrief,
  readRecentTemplateBriefs,
  readSavedTemplateBriefs,
  removeSavedTemplateBrief,
  saveTemplateBrief,
} from "@/lib/recent-template-briefs";

import { CampaignTemplateDesignReview } from "./campaign-template-design-review";
import { CampaignTemplateReferencePicker } from "./campaign-template-reference-picker";
import { useCampaignTemplateDesignWorkflow } from "./use-campaign-template-design-workflow";

const TemplateAssetPicker = dynamic(() => import("./template-asset-picker").then((module) => module.TemplateAssetPicker), { ssr: false });

export function GenerateTemplateDialog({
  open,
  onOpenChange,
  templates,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: CampaignTemplateSummary[];
}) {
  const [brief, setBrief] = useState("");
  const [tone, setTone] = useState("");
  const [audience, setAudience] = useState("");
  const [sections, setSections] = useState("");
  const [cta, setCTA] = useState("");
  const [approvedFacts, setApprovedFacts] = useState("");
  const [approvedURLs, setApprovedURLs] = useState("");
  const [approvedAssets, setApprovedAssets] = useState<Array<{ url: string; alt: string }>>([]);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [kind, setKind] = useState<"newsletter" | "promo" | "announcement">(
    "newsletter",
  );
  const [fidelity, setFidelity] = useState<"close" | "balanced" | "inspired">(
    "balanced",
  );
  const [references, setReferences] = useState<string[]>([]);
  const [variations, setVariations] = useState(1);
  const [variationChosen, setVariationChosen] = useState(false);
  const [showComposer, setShowComposer] = useState(true);
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [recentBriefs, setRecentBriefs] = useState<string[]>([]);
  const [savedBriefs, setSavedBriefs] = useState<string[]>([]);
  const [briefError, setBriefError] = useState<string | null>(null);
  const briefRef = useRef<HTMLTextAreaElement>(null);
  const briefErrorID = `${useId()}-brief-error`;
  const verifiedScope = useVerifiedAuthScopeOptional();
  const briefStorageScope = useMemo(
    () =>
      verifiedScope
        ? {
            tenantId: verifiedScope.tenantId,
            userId: verifiedScope.userId,
          }
        : null,
    [verifiedScope],
  );
  const briefStorageScopeKey = briefStorageScope
    ? `${briefStorageScope.tenantId}:${briefStorageScope.userId}`
    : "";
  const previousBriefStorageScopeKey = useRef(briefStorageScopeKey);
  const workflow = useCampaignTemplateDesignWorkflow({
    mode: "generate",
    enabled: open,
  });

  useEffect(() => {
    const scopeChanged =
      previousBriefStorageScopeKey.current !== briefStorageScopeKey;
    previousBriefStorageScopeKey.current = briefStorageScopeKey;
    // A workspace/account transition must never carry draft text or local
    // suggestions into the next identity, even if the surrounding provider
    // remains mounted during an auth refresh.
    if (scopeChanged) {
      setBrief("");
      setTone("");
      setAudience("");
      setSections("");
      setCTA("");
      setApprovedFacts("");
      setApprovedURLs("");
      setApprovedAssets([]);
      setReferences([]);
      setRecentBriefs([]);
      setSavedBriefs([]);
    }
    if (!open || !briefStorageScope) {
      if (!briefStorageScope) {
        setRecentBriefs([]);
        setSavedBriefs([]);
      }
      return;
    }
    setRecentBriefs(readRecentTemplateBriefs(briefStorageScope));
    setSavedBriefs(readSavedTemplateBriefs(briefStorageScope));
  }, [briefStorageScope, briefStorageScopeKey, open]);

  useEffect(() => {
    if (workflow.selectedDesign) setShowComposer(false);
  }, [workflow.selectedDesign]);

  const close = () => {
    if (workflow.awaitingAcknowledgement) {
      setConfirmCloseOpen(true);
      return;
    }
    onOpenChange(false);
  };

  const changeOpen = (next: boolean) => {
    if (!next) {
      close();
      return;
    }
    onOpenChange(next);
  };

  const discard = async () => {
    const discarded = await workflow.discard();
    if (!discarded) {
      setConfirmDiscardOpen(false);
      return;
    }
    setBrief("");
    setTone("");
    setAudience("");
    setSections("");
    setCTA("");
    setApprovedFacts("");
    setApprovedURLs("");
    setApprovedAssets([]);
    setKind("newsletter");
    setFidelity("balanced");
    setReferences([]);
    setVariations(1);
    setVariationChosen(false);
    setShowComposer(true);
    setConfirmDiscardOpen(false);
    onOpenChange(false);
  };

  const generate = async () => {
    if (!brief.trim()) {
      setBriefError(
        "Describe the newsletter, audience, sections, and main CTA.",
      );
      briefRef.current?.focus();
      return;
    }
    setBriefError(null);
    const facts = approvedFacts.split("\n").map((fact) => fact.trim()).filter(Boolean);
    const urls = approvedURLs.split("\n").map((url) => url.trim()).filter(Boolean);
    if (facts.length > 20 || facts.some((fact) => fact.length > 500)) {
      setBriefError("Provide at most 20 approved facts, each 500 characters or less.");
      return;
    }
    if (urls.length > 20 || urls.some((url) => {
      try {
        const parsed = new URL(url);
        return url.length > 2048 || parsed.protocol !== "https:" || !parsed.hostname || Boolean(parsed.username || parsed.password);
      } catch { return true; }
    })) {
      setBriefError("Provide at most 20 valid HTTPS source or destination URLs, one per line.");
      return;
    }
    const requestedSections = sections
      .split(/[,\n]/)
      .map((section) => section.trim())
      .filter(Boolean)
      .slice(0, 12);
    const input: CreateCampaignTemplateDesignInput = {
      mode: "generate",
      brief: brief.trim(),
      kind,
      tone: tone.trim() || undefined,
      fidelity,
      audience: audience.trim() || undefined,
      sections: requestedSections.length ? requestedSections : undefined,
      cta: cta.trim() || undefined,
      goal:
        kind === "promo"
          ? "promotional"
          : kind === "announcement"
            ? "announcement"
            : "newsletter",
      reference_template_ids: references,
      content: facts.length || urls.length || approvedAssets.length ? {
        approved_facts: facts,
        approved_urls: urls,
        approved_assets: approvedAssets,
      } : undefined,
    };
    setShowComposer(false);
    setVariationChosen(variations === 1);
    const results = await workflow.start(input, variations);
    if (!results.length && !workflow.designs.length) setShowComposer(true);
    if (briefStorageScope) {
      setRecentBriefs(pushRecentTemplateBrief(briefStorageScope, brief.trim()));
    }
  };

  const selectVariation = (draft: CampaignTemplateDesignDraft) => {
    workflow.select(draft.id);
    setVariationChosen(true);
    setShowComposer(false);
  };

  const selected = workflow.selectedDesign;
  const readyVariations = workflow.designs.filter(
    (draft) =>
      draft.status === "ready" ||
      draft.status === "saved" ||
      draft.status === "campaign_created",
  );
  const showVariationPicker =
    (variations > 1 || workflow.designs.length > 1) &&
    readyVariations.length > 1 &&
    !variationChosen;

  return (
    <>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent
          className="max-w-6xl [&_button]:min-h-11 [&_button]:min-w-11 sm:[&_button]:min-h-9"
          onOpenAutoFocus={(event) => {
            if (!briefRef.current || !showComposer) return;
            event.preventDefault();
            briefRef.current.focus();
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
            <DialogTitle>Generate a newsletter design</DialogTitle>
            <DialogDescription>
              Describe what you want to send. Review the design before you save
              it as a template or turn it into a campaign draft. Nothing is sent
              automatically.
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
                <p className="font-medium">Recovering your design…</p>
                <p className="text-sm text-muted-foreground">
                  Bringing back your latest saved design.
                </p>
              </div>
            </div>
          ) : showVariationPicker ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {readyVariations.length} design options are ready. Choose one to
                review and refine; you can return to them later.
              </p>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {readyVariations.map((draft, index) => (
                  <div
                    key={draft.id}
                    className="flex flex-col rounded-lg border p-4"
                  >
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Variation {index + 1}
                    </p>
                    <p className="mt-1 font-medium">
                      {draft.revision?.output.name || "Generated newsletter"}
                    </p>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {draft.revision?.output.subject}
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      className="mt-4"
                      onClick={() => selectVariation(draft)}
                    >
                      Review this variation
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ) : selected && !showComposer ? (
            <CampaignTemplateDesignReview
              design={selected}
              revisions={workflow.revisions}
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
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
              <div className="space-y-4">
                {workflow.designs.length ? (
                  <Alert>
                    <AlertTitle>Resumable design available</AlertTitle>
                    <AlertDescription>
                      Your earlier design is still available. Starting again
                      creates a separate option.
                    </AlertDescription>
                  </Alert>
                ) : null}
                <div className="grid gap-1.5">
                  <Label htmlFor="template-generation-brief">
                    Design brief
                  </Label>
                  <Textarea
                    ref={briefRef}
                    autoFocus
                    id="template-generation-brief"
                    rows={7}
                    maxLength={8000}
                    value={brief}
                    placeholder="A sharp weekly AI newsletter for product leaders. Open with one editorial story, follow with a three-link roundup, then a sponsor block and one CTA."
                    aria-invalid={Boolean(briefError)}
                    aria-describedby={briefError ? briefErrorID : undefined}
                    onChange={(event) => {
                      setBrief(event.target.value);
                      if (briefError && event.target.value.trim()) {
                        setBriefError(null);
                      }
                    }}
                  />
                  {briefError ? (
                    <p
                      id={briefErrorID}
                      role="alert"
                      className="text-xs text-destructive"
                    >
                      {briefError}
                    </p>
                  ) : null}
                  {recentBriefs.length ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <History className="h-3.5 w-3.5" aria-hidden />
                        Recent
                      </span>
                      {recentBriefs.map((recent) => (
                        <button
                          key={recent}
                          type="button"
                          title={recent}
                          onClick={() => setBrief(recent)}
                          className="min-h-11 max-w-[220px] truncate rounded-full border px-3 py-1 text-xs text-muted-foreground hover:bg-muted sm:min-h-8"
                        >
                          {recent}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      disabled={
                        !briefStorageScope ||
                        !brief.trim() ||
                        savedBriefs.some(
                          (saved) =>
                            saved.trim().toLowerCase() ===
                            brief.trim().toLowerCase(),
                        )
                      }
                      onClick={() => {
                        if (!briefStorageScope) return;
                        setSavedBriefs(
                          saveTemplateBrief(briefStorageScope, brief),
                        );
                      }}
                      className="inline-flex min-h-11 items-center gap-1 rounded-full border px-3 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50 sm:min-h-8"
                    >
                      <Bookmark className="h-3.5 w-3.5" aria-hidden />
                      Save brief
                    </button>
                    {savedBriefs.map((saved) => (
                      <span
                        key={saved}
                        className="inline-flex min-h-11 max-w-[260px] items-center gap-1 rounded-full border bg-muted/40 pl-3 text-xs sm:min-h-8"
                      >
                        <button
                          type="button"
                          title={saved}
                          onClick={() => setBrief(saved)}
                          className="min-h-11 truncate sm:min-h-8"
                        >
                          {saved}
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove saved brief: ${saved}`}
                          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8 sm:w-8"
                          onClick={() => {
                            if (!briefStorageScope) return;
                            setSavedBriefs(
                              removeSavedTemplateBrief(
                                briefStorageScope,
                                saved,
                              ),
                            );
                          }}
                        >
                          <X className="h-3 w-3" aria-hidden />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor="template-generation-kind">Format</Label>
                    <Select
                      id="template-generation-kind"
                      value={kind}
                      onChange={(event) =>
                        setKind(
                          event.target.value as
                            | "newsletter"
                            | "promo"
                            | "announcement",
                        )
                      }
                    >
                      <option value="newsletter">Editorial newsletter</option>
                      <option value="promo">Promotional newsletter</option>
                      <option value="announcement">Announcement</option>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="template-generation-tone">Tone</Label>
                    <Input
                      id="template-generation-tone"
                      maxLength={500}
                      value={tone}
                      placeholder="Editorial, confident, warm"
                      onChange={(event) => setTone(event.target.value)}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="template-generation-audience">
                      Audience
                    </Label>
                    <Input
                      id="template-generation-audience"
                      maxLength={1500}
                      value={audience}
                      placeholder="Product leaders at growing SaaS companies"
                      onChange={(event) => setAudience(event.target.value)}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="template-generation-fidelity">
                      Reference fidelity
                    </Label>
                    <Select
                      id="template-generation-fidelity"
                      value={fidelity}
                      onChange={(event) =>
                        setFidelity(
                          event.target.value as
                            | "close"
                            | "balanced"
                            | "inspired",
                        )
                      }
                    >
                      <option value="close">Close direction</option>
                      <option value="balanced">Balanced</option>
                      <option value="inspired">Loose inspiration</option>
                    </Select>
                  </div>
                </div>

                <details className="rounded-md border bg-muted/20 px-4 py-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    Sections and CTA
                  </summary>
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <div className="grid gap-1.5">
                      <Label htmlFor="template-generation-sections">
                        Sections
                      </Label>
                      <Textarea
                        id="template-generation-sections"
                        rows={3}
                        value={sections}
                        placeholder="Hero, three stories, sponsor, footer"
                        onChange={(event) => setSections(event.target.value)}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="template-generation-cta">
                        Primary CTA
                      </Label>
                      <Textarea
                        id="template-generation-cta"
                        rows={3}
                        maxLength={1500}
                        value={cta}
                        placeholder="Read the launch notes"
                        onChange={(event) => setCTA(event.target.value)}
                      />
                    </div>
                  </div>
                </details>

                <details className="rounded-md border bg-muted/20 px-4 py-3">
                  <summary className="cursor-pointer text-sm font-medium">Approved facts and links</summary>
                  <div className="mt-4 space-y-4">
                    <p className="text-xs text-muted-foreground">Only enter facts your team has verified. URLs are passed as references; Moosewave does not fetch or verify their contents.</p>
                    <div className="grid gap-1.5">
                      <Label htmlFor="template-generation-facts">Approved facts · one per line</Label>
                      <Textarea id="template-generation-facts" rows={4} maxLength={10000} value={approvedFacts}
                        placeholder="Our event starts on 12 October.\nThe early-bird price is $49."
                        onChange={(event) => setApprovedFacts(event.target.value)} />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="template-generation-urls">Approved HTTPS links · one per line</Label>
                      <Textarea id="template-generation-urls" rows={3} maxLength={5000} value={approvedURLs}
                        placeholder="https://example.com/event"
                        onChange={(event) => setApprovedURLs(event.target.value)} />
                    </div>
                    {verifiedScope?.tenantId ? <div className="space-y-2">
                      <p className="text-xs font-medium">Approved workspace images</p>
                      {approvedAssets.length ? <ul className="space-y-1 text-xs">
                        {approvedAssets.map((asset) => <li key={asset.url} className="flex items-center justify-between gap-2 rounded-md border p-2">
                          <span className="min-w-0 truncate">{asset.alt} · {asset.url}</span>
                          <Button type="button" size="sm" variant="ghost" aria-label={`Remove ${asset.alt}`} onClick={() => setApprovedAssets((current) => current.filter((item) => item.url !== asset.url))}>Remove</Button>
                        </li>)}
                      </ul> : <p className="text-xs text-muted-foreground">No images selected.</p>}
                      <Button type="button" size="sm" variant="outline" disabled={approvedAssets.length >= 10} onClick={() => setAssetPickerOpen(true)}>Choose workspace image</Button>
                      {assetPickerOpen ? <TemplateAssetPicker tenantId={verifiedScope.tenantId} open={assetPickerOpen} onOpenChange={setAssetPickerOpen}
                        onInsert={(url, alt) => setApprovedAssets((current) => current.some((item) => item.url === url) ? current : [...current, { url, alt }].slice(0, 10))} /> : null}
                    </div> : null}
                  </div>
                </details>

                {workflow.error ? (
                  <Alert variant="destructive">
                    <AlertDescription>{workflow.error}</AlertDescription>
                  </Alert>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  Verify claims, links, merge fields, accessibility, and legal
                  footer content before sending. Generation never saves or
                  creates a campaign implicitly.
                </p>
              </div>

              <CampaignTemplateReferencePicker
                selected={references}
                onChange={setReferences}
                initialTemplates={templates}
                max={3}
              />

              <DialogFooter className="lg:col-span-2 sm:items-center">
                <label className="mr-auto flex items-center gap-2 text-xs text-muted-foreground">
                  Variations
                  <Select
                    aria-label="Number of variations to generate"
                    className="h-8 w-16"
                    value={String(variations)}
                    disabled={workflow.working}
                    onChange={(event) =>
                      setVariations(Number(event.target.value))
                    }
                  >
                    <option value="1">1</option>
                    <option value="2">2</option>
                    <option value="3">3</option>
                  </Select>
                </label>
                {workflow.designs.length ? (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setConfirmDiscardOpen(true)}
                    >
                      Discard these designs
                    </Button>
                    <Button
                      type="button"
                      onClick={() => {
                        setVariationChosen(workflow.designs.length === 1);
                        setShowComposer(false);
                      }}
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
                      onClick={() => void generate()}
                    >
                      <Sparkles className="h-4 w-4" aria-hidden />
                      {workflow.working
                        ? "Starting your design…"
                        : variations > 1
                          ? `Generate ${variations} variations`
                          : "Generate design"}
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
        title="Discard these designs?"
        description="This removes the options from your active list. If one is still generating, wait for it to finish first."
        confirmLabel="Discard designs"
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
          onOpenChange(false);
        }}
      />
    </>
  );
}
