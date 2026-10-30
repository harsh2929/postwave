// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Per-campaign locale variants — the web half of desktop's
 * `CampaignTranslationsPanel`. One hand-authored subject + HTML body per
 * locale, distinct from the tenant-wide AI translator at /app/translations.
 *
 * WHAT THESE ROWS DO NOT DO, said at the top of the screen and repeated here
 * so nobody wires delivery logic to them by accident: the send path does not
 * consult them. `campaign_translations.ResolveForLocale` exists and is
 * unit-tested, but nothing in the dispatch loop calls it, and the table is
 * read by no other package. Authoring a variant today would record copy for
 * review and change nothing about what recipients receive, so — exactly like
 * desktop's `CampaignTranslationsPanel` — authoring is withheld behind
 * CAMPAIGN_LOCALE_ROUTING_ENABLED until the send plan enforces per-locale
 * delivery. Existing variants stay readable. Flip the flag on BOTH clients in
 * the same change that wires ResolveForLocale into dispatch.
 *
 * The AI translation here is the same `POST /api/v1/translations/preview`
 * endpoint the tenant page uses, aimed at THIS campaign's body: it drafts the
 * variant's body rather than translating anything at send time. `skipped:
 * true` means nothing was translated, so the result is never offered as a body
 * to apply — applying it would file the English copy under a French locale.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { Route } from "next";
import { ArrowLeft, Languages, Trash2 } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { PageShell } from "@/components/dashboard/page-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { getCampaign } from "@/lib/campaigns-api";
import {
  CAMPAIGN_READ_ONLY_MESSAGE,
  canWriteCampaigns,
  confirmFreshCampaignWriteAuthority,
} from "@/lib/campaign-write-authority";
import {
  deleteCampaignTranslation,
  isValidCampaignLocale,
  listCampaignTranslations,
  normalizeCampaignLocale,
  saveCampaignTranslation,
  type CampaignTranslation,
} from "@/lib/campaign-translations-api";
import { CAMPAIGN_LOCALE_ROUTING_ENABLED } from "@/lib/campaign-locale-routing";
import { previewTranslation } from "@/lib/translations-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { qk, STALE } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";

interface VariantDraft {
  /** Empty while the editor is closed. */
  locale: string;
  subject: string;
  bodyHtml: string;
  /** The locale of the row being replaced, or null for a new variant. */
  editing: string | null;
}

interface DraftedTranslation {
  body: string;
  locale: string;
  skipped: boolean;
  dictionaryMatches: number;
}

export function CampaignTranslationsClient() {
  const params = useParams<{ id: string }>();
  const campaignId = params.id;
  const queryClient = useQueryClient();

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = meQuery.data ?? null;
  const tenantId = identity?.tenant_id ?? "anon";
  const role = identity ? effectiveAuthRole(identity) : null;
  const identityReady = meQuery.isFetched;
  const canEdit = canWriteCampaigns(identity);
  // Authoring needs both the role and per-locale routing; reading needs neither.
  const canAuthor = canEdit && CAMPAIGN_LOCALE_ROUTING_ENABLED;

  const campaignKey = useMemo(
    () => qk.campaign(tenantId, role, campaignId),
    [campaignId, role, tenantId],
  );
  const variantsKey = useMemo(
    () => [...campaignKey, "translations"],
    [campaignKey],
  );

  const campaignQuery = useQuery({
    queryKey: campaignKey,
    queryFn: () => getCampaign(campaignId),
    enabled: identityReady,
    staleTime: STALE.detail,
  });
  const variantsQuery = useQuery({
    queryKey: variantsKey,
    queryFn: () => listCampaignTranslations(campaignId),
    enabled: identityReady,
    staleTime: STALE.list,
  });

  const variants = Array.isArray(variantsQuery.data) ? variantsQuery.data : [];
  const campaign = campaignQuery.data;
  // A campaign whose name failed to load must not read as an unnamed
  // campaign; say which it is.
  const campaignName = campaignQuery.isError
    ? "Campaign (name failed to load)"
    : campaign?.name;

  const [draft, setDraft] = useState<VariantDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<CampaignTranslation | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);

  const [translating, setTranslating] = useState(false);
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [drafted, setDrafted] = useState<DraftedTranslation | null>(null);

  // A role change mid-session must close an editor the session can no longer
  // save; leaving it open invites typing that ends in a 403.
  useEffect(() => {
    if (identityReady && !canAuthor) setDraft(null);
  }, [canAuthor, identityReady]);

  function openNewVariant() {
    setSaveError(null);
    setSavedNote(null);
    setTranslationError(null);
    setDrafted(null);
    setDraft({
      locale: "",
      // Seeded from the campaign so a variant starts as the copy it localizes
      // rather than as an empty box the operator retypes from another tab.
      subject: campaignQuery.isError ? "" : (campaign?.subject ?? ""),
      bodyHtml: campaignQuery.isError ? "" : (campaign?.body_html ?? ""),
      editing: null,
    });
  }

  function openExistingVariant(variant: CampaignTranslation) {
    setSaveError(null);
    setSavedNote(null);
    setTranslationError(null);
    setDrafted(null);
    setDraft({
      locale: variant.locale,
      subject: variant.subject,
      bodyHtml: variant.body_html,
      editing: variant.locale,
    });
  }

  async function saveVariant() {
    if (saving || !draft || !canAuthor) return;
    const locale = normalizeCampaignLocale(draft.locale);
    if (!isValidCampaignLocale(locale)) {
      setSavedNote(null);
      setSaveError(
        "Locale must look like “es” or “fr-CA”: a 2–8 letter language, optionally a dash and a 2–8 character region.",
      );
      return;
    }
    // Renaming an existing row's locale would upsert a SECOND row and leave
    // the original standing — two variants where the operator sees one edit.
    if (
      draft.editing === null &&
      variants.some((row) => row.locale === locale)
    ) {
      setSavedNote(null);
      setSaveError(
        `A ${locale} variant already exists. Edit that row instead; saving here would replace its subject and body.`,
      );
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSavedNote(null);
    try {
      await confirmFreshCampaignWriteAuthority(identity);
      const saved = await saveCampaignTranslation(campaignId, locale, {
        subject: draft.subject,
        body_html: draft.bodyHtml,
      });
      await queryClient.invalidateQueries({ queryKey: variantsKey });
      setDraft(null);
      setDrafted(null);
      setSavedNote(
        `Saved the ${saved.locale} variant. Recipients still receive the campaign's default subject and body until per-locale routing ships.`,
      );
    } catch (error) {
      setSaveError(
        apiErrorMessage(error, "Could not save this language variant."),
      );
    } finally {
      setSaving(false);
    }
  }

  /**
   * Throws on failure ON PURPOSE: ConfirmDialog holds itself open and renders
   * the thrown message. Swallowing it would close the dialog on a failed
   * delete, which is indistinguishable from a successful one.
   */
  async function confirmDeleteVariant() {
    const target = deleteTarget;
    if (deleting || !target || !canAuthor) return;
    setDeleting(true);
    try {
      await confirmFreshCampaignWriteAuthority(identity);
      await deleteCampaignTranslation(campaignId, target.locale);
      await queryClient.invalidateQueries({ queryKey: variantsKey });
      setDeleteTarget(null);
      if (draft?.editing === target.locale) setDraft(null);
      setSavedNote(`Removed the ${target.locale} variant.`);
    } catch (error) {
      throw new Error(
        apiErrorMessage(error, "Could not delete this language variant."),
      );
    } finally {
      setDeleting(false);
    }
  }

  async function translateCampaignBody() {
    if (translating || !draft || !canAuthor) return;
    const locale = normalizeCampaignLocale(draft.locale);
    if (!isValidCampaignLocale(locale)) {
      setDrafted(null);
      setTranslationError(
        "Enter the target locale first — the translator needs to know which language to produce.",
      );
      return;
    }
    const source = campaignQuery.isError ? "" : (campaign?.body_html ?? "");
    if (source.trim() === "") {
      setDrafted(null);
      setTranslationError(
        "This campaign has no HTML body to translate yet. Write the default body first.",
      );
      return;
    }
    setTranslating(true);
    setTranslationError(null);
    setDrafted(null);
    try {
      await confirmFreshCampaignWriteAuthority(identity);
      const result = await previewTranslation(source, locale);
      setDrafted({
        body: result.body,
        locale: result.locale || locale,
        skipped: result.skipped,
        dictionaryMatches: result.dictionary_matches,
      });
    } catch (error) {
      setTranslationError(
        apiErrorMessage(
          error,
          "Could not translate the campaign body. Nothing has been written into this variant.",
        ),
      );
    } finally {
      setTranslating(false);
    }
  }

  function applyDraftedTranslation() {
    if (!drafted || drafted.skipped) return;
    setDraft((current) =>
      current ? { ...current, bodyHtml: drafted.body } : current,
    );
    setDrafted(null);
    setSavedNote(
      "The translated body is now in the editor. It is not saved until you save the variant.",
    );
  }

  return (
    <PageShell>
      <Breadcrumb
        items={[
          { label: "Campaigns", href: asRoute("/app/campaigns") },
          ...(campaignName
            ? [
                {
                  label: campaignName,
                  href: asRoute(`/app/campaigns/${campaignId}`) as Route,
                },
              ]
            : []),
          { label: "Languages" },
        ]}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button
          asChild
          variant="ghost"
          size="icon"
          aria-label="Back to campaign"
          title="Back to campaign"
        >
          <Link href={`/app/campaigns/${campaignId}`}>
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Language variants
          </h1>
          {campaignName ? (
            <p className="break-words text-sm text-muted-foreground">
              {campaignName}
            </p>
          ) : null}
        </div>
        {canAuthor && draft === null ? (
          <Button type="button" onClick={openNewVariant}>
            Add a language
          </Button>
        ) : null}
      </div>

      {/* The one thing an operator must know before authoring here. */}
      <Alert>
        <AlertTitle>
          Language variants are read-only until routing is available
        </AlertTitle>
        <AlertDescription>
          Existing localizations are shown for review, but recipients still
          receive this campaign&apos;s default-language subject and body.
          Adding, editing, and deleting variants is disabled until per-locale
          delivery is enforced by the send plan.
        </AlertDescription>
      </Alert>

      {meQuery.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t confirm who you are</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{apiErrorMessage(meQuery.error)}</p>
            <p>
              Language variants and their write controls were not requested.
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              loading={meQuery.isFetching}
              onClick={() => void meQuery.refetch()}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {identityReady && !canEdit ? (
        <p className="text-sm text-muted-foreground">
          {CAMPAIGN_READ_ONLY_MESSAGE}
        </p>
      ) : null}

      <section aria-labelledby="campaign-variants" className="space-y-3">
        <h2 id="campaign-variants" className="text-base font-medium">
          Authored languages
        </h2>

        {variantsQuery.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading…
          </p>
        ) : variantsQuery.isError ? (
          <Alert variant="destructive">
            <AlertTitle>Couldn&apos;t load language variants</AlertTitle>
            <AlertDescription className="space-y-3">
              {/* An empty list here would read as "none authored", which is
                  the state that invites re-authoring what already exists. */}
              <p>{apiErrorMessage(variantsQuery.error)}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                loading={variantsQuery.isFetching}
                onClick={() => void variantsQuery.refetch()}
              >
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : variants.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No language variants authored for this campaign.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border bg-card">
            {variants.map((variant) => (
              <li
                key={variant.locale}
                className="flex flex-wrap items-center gap-3 p-3 text-sm"
              >
                <Badge variant="secondary">{variant.locale}</Badge>
                <span className="min-w-0 flex-1 break-words">
                  {variant.subject || (
                    <span className="text-muted-foreground">(no subject)</span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  {formatWireTimestamp(variant.updated_at, "never saved")}
                </span>
                {canAuthor ? (
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`Edit the ${variant.locale} variant`}
                      onClick={() => openExistingVariant(variant)}
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Delete the ${variant.locale} variant`}
                      onClick={() => setDeleteTarget(variant)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                      Delete
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {savedNote ? (
          <p role="status" className="text-sm text-muted-foreground">
            {savedNote}
          </p>
        ) : null}
      </section>

      {draft ? (
        <form
          aria-labelledby="campaign-variant-editor"
          className="space-y-4 rounded-lg border p-4 sm:p-6"
          onSubmit={(event) => {
            event.preventDefault();
            void saveVariant();
          }}
        >
          <h2 id="campaign-variant-editor" className="text-base font-medium">
            {draft.editing === null
              ? "New language variant"
              : `Editing the ${draft.editing} variant`}
          </h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="variant-locale">Locale</Label>
              <Input
                id="variant-locale"
                value={draft.locale}
                placeholder="es, fr-CA, pt-BR"
                // Editing a saved row addresses it by locale, so changing this
                // would create a second row instead of renaming this one.
                disabled={saving || draft.editing !== null}
                onChange={(event) => {
                  const next = event.target.value;
                  setSaveError(null);
                  setDraft((current) =>
                    current ? { ...current, locale: next } : current,
                  );
                }}
              />
              {draft.editing !== null ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  A variant&apos;s locale is its identity. Delete this one and
                  add another to move the copy to a different locale.
                </p>
              ) : null}
            </div>
            <div>
              <Label htmlFor="variant-subject">Subject for this language</Label>
              <Input
                id="variant-subject"
                value={draft.subject}
                disabled={saving}
                onChange={(event) => {
                  const next = event.target.value;
                  setDraft((current) =>
                    current ? { ...current, subject: next } : current,
                  );
                }}
              />
            </div>
          </div>

          <div>
            <Label htmlFor="variant-body">HTML body for this language</Label>
            <Textarea
              id="variant-body"
              value={draft.bodyHtml}
              rows={10}
              disabled={saving}
              className="font-mono"
              placeholder="<p>Body HTML for this language…</p>"
              onChange={(event) => {
                const next = event.target.value;
                setDraft((current) =>
                  current ? { ...current, bodyHtml: next } : current,
                );
              }}
            />
          </div>

          <div className="rounded-md border bg-muted/30 p-3">
            <p className="text-sm font-medium">Draft it with the translator</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Runs this campaign&apos;s default HTML body through the workspace
              glossary and the LLM gateway. Nothing is written into the variant
              until you apply the result, and nothing is sent.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              disabled={translating}
              loading={translating}
              onClick={() => void translateCampaignBody()}
            >
              <Languages className="h-4 w-4" aria-hidden />
              Translate the campaign body
            </Button>
            {translationError ? (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {translationError}
              </p>
            ) : null}
            {drafted ? (
              drafted.skipped ? (
                // The endpoint returns the body unchanged when it skips. If
                // that were offered as a body to apply, the operator would
                // file their own English copy under a French locale.
                <p role="status" className="mt-3 text-sm text-muted-foreground">
                  Nothing was translated — the server returned your original
                  copy unchanged, so there is nothing to apply. Translation is
                  off for this workspace, or {drafted.locale} is the default
                  locale.
                </p>
              ) : (
                <div className="mt-3 space-y-2">
                  <p role="status" className="text-sm text-muted-foreground">
                    Translated into {drafted.locale} using{" "}
                    {drafted.dictionaryMatches} glossary term(s). Review it
                    before applying.
                  </p>
                  <pre
                    tabIndex={0}
                    role="group"
                    aria-label={`Draft ${drafted.locale} body`}
                    className="max-h-64 overflow-auto rounded-md border bg-background p-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <code>{drafted.body}</code>
                  </pre>
                  <Button
                    type="button"
                    size="sm"
                    onClick={applyDraftedTranslation}
                  >
                    Use this as the variant body
                  </Button>
                </div>
              )
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={saving} loading={saving}>
              Save variant
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => {
                setDraft(null);
                setDrafted(null);
                setSaveError(null);
                setTranslationError(null);
              }}
            >
              Cancel
            </Button>
          </div>
          {saveError ? (
            <p role="alert" className="text-sm text-destructive">
              {saveError}
            </p>
          ) : null}
        </form>
      ) : null}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
        title={`Delete the ${deleteTarget?.locale ?? ""} variant?`}
        description={`Its translated subject and HTML body are removed from this campaign and cannot be recovered. The campaign's default subject and body are unaffected.`}
        confirmLabel={deleting ? "Deleting…" : "Delete variant"}
        confirmVariant="destructive"
        onConfirm={confirmDeleteVariant}
      />
    </PageShell>
  );
}
