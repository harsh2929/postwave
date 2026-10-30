// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Landing-page editor (LAND-005). Authors the hero heading/body, add/remove/
// reorder feature blocks (Content tab), the SEO metadata the public page emits
// (SEO tab — LAND-007), and template/custom-domain/name (Settings tab), then
// persists via PATCH /api/v1/landing-pages/{id}. The Preview tab renders the
// draft in a sandboxed iframe (sandbox="" + srcDoc) so a page can be reviewed
// before publishing without ever going public (LAND-008). All content is fed
// to `serializeContent`, which emits the COMPLETE block list so a save can
// never drop blocks (PATCH-replace footgun). Downstream links to acquired
// subscribers and a welcome flow close the capture funnel (LAND-025).

import Link from "next/link";
import dynamic from "next/dynamic";
import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Archive,
  ArchiveRestore,
  Copy,
  ExternalLink,
  History,
  Plus,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { AI_DISCLOSURE_TEXT } from "@postwave/ai-disclosure";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  PageHeaderSkeleton,
  TableSkeleton,
} from "@/components/dashboard/skeletons";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { ApiError } from "@/lib/api";

// Public-URL slug shape, mirrors the create form + backend validateSlug.
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
import { copyToClipboard } from "@/lib/clipboard";
import {
  moveItem,
  newFeature,
  parseContent,
  parseSeo,
  publicLandingUrl,
  serializeContent,
  serializeSeo,
  validateSeo,
  type FeatureContent,
  type LandingContent,
  type SeoFields,
} from "@/lib/landing-page-content";
import { statusLabel } from "@/lib/landing-list-helpers";
import {
  landingPagesApi,
  type LandingPage,
  type LandingPageUpdateInput,
  type LandingPageStatus,
} from "@/lib/landing-pages-api";
import {
  canAdminLandingPages,
  confirmFreshLandingPageAdminAuthority,
  LANDING_PAGE_ADMIN_ONLY_MESSAGE,
} from "@/lib/landing-page-authority";
import { base, qk, STALE } from "@/lib/query-keys";
import { useAppOrigin } from "@/lib/use-app-origin";
import { useLandingPageEditorTab } from "./tab-url-state";

const VariantsTab = dynamic(
  () => import("./variants-tab").then((mod) => mod.VariantsTab),
  {
    ssr: false,
    loading: () => <DeferredLandingPanel label="A/B variants" />,
  },
);

const HistoryTab = dynamic(
  () => import("./history-tab").then((mod) => mod.HistoryTab),
  {
    ssr: false,
    loading: () => <DeferredLandingPanel label="version history" />,
  },
);

const PreviewTab = dynamic(
  () => import("./preview-tab").then((mod) => mod.PreviewTab),
  {
    ssr: false,
    loading: () => <DeferredLandingPanel label="private preview" />,
  },
);

const LandingSecondaryEditorTab = dynamic(
  () =>
    import("./secondary-editor-tabs").then(
      (module) => module.LandingSecondaryEditorTab,
    ),
  {
    ssr: false,
    loading: () => <DeferredLandingPanel label="editor settings" />,
  },
);

function DeferredLandingPanel({ label }: { label: string }) {
  return (
    <div
      className="min-h-32 animate-pulse rounded-md border bg-muted/30 motion-reduce:animate-none"
      role="status"
      aria-live="polite"
      aria-label={`Loading ${label}`}
    >
      <span className="sr-only">Loading {label}…</span>
    </div>
  );
}

interface EditorModel {
  name: string;
  slug: string;
  template: string;
  domain: string;
  content: LandingContent;
  seo: SeoFields;
  // LAND-038: datetime-local strings ("" = unscheduled).
  publishAt: string;
  unpublishAt: string;
}

// datetime-local (local wall-clock, no tz) ⇄ ISO instant helpers.
function isoToLocalInput(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function localInputToIso(local: string): string | null {
  if (!local.trim()) return null;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function toModel(page: LandingPage): EditorModel {
  return {
    name: page.name,
    slug: page.slug,
    template: page.template || "signup",
    domain: page.domain ?? "",
    content: parseContent(page.blocks),
    seo: parseSeo(page.seo),
    publishAt: isoToLocalInput(page.publish_at),
    unpublishAt: isoToLocalInput(page.unpublish_at),
  };
}

// Structural snapshot for dirty-tracking (feature client ids excluded).
function snapshot(m: EditorModel): string {
  return JSON.stringify({
    name: m.name.trim(),
    slug: m.slug.trim(),
    template: m.template,
    domain: m.domain.trim(),
    hero: m.content.hero,
    features: m.content.features.map((f) => ({
      heading: f.heading,
      body: f.body,
    })),
    seo: serializeSeo(m.seo),
    publishAt: m.publishAt,
    unpublishAt: m.unpublishAt,
  });
}

export default function LandingPageEditor() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const [activeTab, changeTab] = useLandingPageEditorTab(
    searchParams.get("tab"),
  );
  const queryClient = useQueryClient();
  const origin = useAppOrigin();

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = meQuery.data;
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  // Effective role (View-as-Viewer preview) — the server gates on
  // EffectiveRoleOrDurable(), so the publish/edit controls must too.
  const role = identity ? effectiveAuthRole(identity) : null;
  const viewerMode = identity?.viewer_mode === true;
  const canAdmin = canAdminLandingPages(identity);
  const landingScopeKey = useMemo(
    () => base("landing-pages", tenantId, role),
    [role, tenantId],
  );
  const landingBaseKey = useMemo(
    () =>
      [...landingScopeKey, identity?.user_id ?? "anon", viewerMode] as const,
    [identity?.user_id, landingScopeKey, viewerMode],
  );
  const detailKey = useMemo(
    () => [...landingBaseKey, "detail", id] as const,
    [landingBaseKey, id],
  );

  const pageQuery = useQuery({
    queryKey: detailKey,
    queryFn: () => landingPagesApi.get(id),
    enabled: meQuery.isSuccess,
    staleTime: STALE.detail,
  });
  const page = pageQuery.data ?? null;

  const [model, setModel] = useState<EditorModel | null>(null);
  const [modelScope, setModelScope] = useState("");
  const [baseline, setBaseline] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const writeInFlightRef = useRef(false);
  const [confirmArchive, setConfirmArchive] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [confirmStatus, setConfirmStatus] = useState<{
    id: string;
    next: LandingPageStatus;
    verb: string;
    label: string;
  } | null>(null);
  // LAND-036: AI hero-copy generation state.
  const [aiBrief, setAiBrief] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const aiInFlightRef = useRef(false);

  const identityStamp = identity
    ? `${identity.user_id}\u0000${identity.tenant_id}\u0000${role ?? ""}\u0000${viewerMode}`
    : "anon";
  const editorScope = `${identityStamp}\u0000${id}`;

  // Retire the prior role/workspace/viewer-mode cache on transition. The
  // identity discriminator already isolates new reads; removal ensures a
  // previous admin's detail/history/variant data is not retained afterwards.
  const previousIdentityRef = useRef<{
    stamp: string;
    baseKey: readonly unknown[];
  } | null>(null);
  useEffect(() => {
    if (!identity) return;
    const previous = previousIdentityRef.current;
    if (previous && previous.stamp !== identityStamp) {
      void queryClient
        .cancelQueries({ queryKey: previous.baseKey, exact: false })
        .then(() =>
          queryClient.removeQueries({
            queryKey: previous.baseKey,
            exact: false,
          }),
        );
    }
    previousIdentityRef.current = {
      stamp: identityStamp,
      baseKey: landingBaseKey,
    };
  }, [identity, identityStamp, landingBaseKey, queryClient]);

  useEffect(() => {
    if (!meQuery.isSuccess || canAdmin) return;
    writeInFlightRef.current = false;
    aiInFlightRef.current = false;
    setSaving(false);
    setStatusBusy(false);
    setAiBusy(false);
    setConfirmArchive(null);
    setConfirmStatus(null);
  }, [canAdmin, meQuery.isSuccess]);

  // Seed the editable model once the record loads (or after an external
  // refetch that isn't a local edit).
  useEffect(() => {
    if (page && modelScope !== editorScope) {
      const m = toModel(page);
      setModel(m);
      setBaseline(snapshot(m));
      setModelScope(editorScope);
    }
  }, [editorScope, modelScope, page]);

  const modelIsCurrent = model !== null && modelScope === editorScope;
  const dirty = modelIsCurrent && snapshot(model) !== baseline;
  // Latest model, readable after an await. Only the Save button is disabled
  // while a save runs — all 15 editor inputs stay live — so the operator can
  // keep typing, and every patch helper spreads into a fresh object, making
  // reference identity an exact "did they edit" signal.
  const modelRef = useRef(model);
  useEffect(() => {
    modelRef.current = model;
  }, [model]);
  const editorScopeRef = useRef(editorScope);
  editorScopeRef.current = editorScope;
  const seoErrors = model ? validateSeo(model.seo) : {};
  const seoInvalid = Object.keys(seoErrors).length > 0;
  // LAND-038: publish must precede auto-unpublish when both are set.
  const scheduleInvalid = !!(
    model &&
    model.publishAt &&
    model.unpublishAt &&
    model.publishAt >= model.unpublishAt
  );
  // The server trims the name without checking it for emptiness, so a cleared
  // Settings field saves as "" and the record loses its only human label: the
  // header falls back to "Untitled page" and the list row renders an empty
  // link with an empty tooltip. The create form already refuses a blank name.
  const nameMissing = !!model && model.name.trim().length === 0;
  const saveBlocked = seoInvalid || scheduleInvalid || nameMissing;
  const saveBlockedReasons = [
    nameMissing ? "enter a name for this page" : null,
    seoInvalid ? "fix the highlighted SEO fields" : null,
    scheduleInvalid
      ? "put the publish time before the auto-unpublish time"
      : null,
  ].filter((reason): reason is string => reason !== null);

  const invalidate = () =>
    void queryClient.invalidateQueries({
      queryKey: landingBaseKey,
      exact: false,
    });

  function beginWrite(): boolean {
    if (!canAdmin || !identity) {
      toast.error(LANDING_PAGE_ADMIN_ONLY_MESSAGE);
      return false;
    }
    if (writeInFlightRef.current) return false;
    writeInFlightRef.current = true;
    return true;
  }

  function finishWrite() {
    writeInFlightRef.current = false;
  }

  function patchModel(patch: Partial<EditorModel>) {
    if (!canAdmin || !modelIsCurrent) return;
    setModel((m) => (m ? { ...m, ...patch } : m));
  }
  function patchContent(patch: Partial<LandingContent>) {
    if (!canAdmin || !modelIsCurrent) return;
    setModel((m) => (m ? { ...m, content: { ...m.content, ...patch } } : m));
  }

  // LAND-036: generate hero copy from a brief and fill the fields (still
  // editable + flows through the normal dirty-tracking + save).
  async function onGenerateHero() {
    if (!model || !modelIsCurrent || !canAdmin || !identity) {
      toast.error(LANDING_PAGE_ADMIN_ONLY_MESSAGE);
      return;
    }
    if (aiInFlightRef.current) return;
    aiInFlightRef.current = true;
    setAiBusy(true);
    const scopeIntent = editorScope;
    const briefIntent = aiBrief.trim();
    const heroIntent = structuredClone(model.content.hero);
    try {
      const { generateLandingCopy } = await import("@/lib/voice-api");
      await confirmFreshLandingPageAdminAuthority(identity);
      const copy = await generateLandingCopy(briefIntent);
      if (editorScopeRef.current !== scopeIntent) return;
      patchContent({
        hero: {
          ...heroIntent,
          heading: copy.heading || heroIntent.heading,
          body: copy.body || heroIntent.body,
        },
      });
      toast.success("Draft hero copy generated — edit it before saving.");
    } catch {
      toast.error("Could not generate copy. Try again in a moment.");
    } finally {
      aiInFlightRef.current = false;
      setAiBusy(false);
    }
  }
  function patchSeo(patch: Partial<SeoFields>) {
    if (!canAdmin || !modelIsCurrent) return;
    setModel((m) => (m ? { ...m, seo: { ...m.seo, ...patch } } : m));
  }

  // --- feature block ops ---------------------------------------------------
  function updateFeature(index: number, patch: Partial<FeatureContent>) {
    if (!canAdmin || !modelIsCurrent) return;
    setModel((m) => {
      if (!m) return m;
      const features = m.content.features.map((f, i) =>
        i === index ? { ...f, ...patch } : f,
      );
      return { ...m, content: { ...m.content, features } };
    });
  }
  function addFeature() {
    if (!canAdmin || !modelIsCurrent) return;
    setModel((m) =>
      m
        ? {
            ...m,
            content: {
              ...m.content,
              features: [...m.content.features, newFeature()],
            },
          }
        : m,
    );
  }
  function removeFeature(index: number) {
    if (!canAdmin || !modelIsCurrent) return;
    setModel((m) =>
      m
        ? {
            ...m,
            content: {
              ...m.content,
              features: m.content.features.filter((_, i) => i !== index),
            },
          }
        : m,
    );
  }
  function reorderFeature(index: number, dir: -1 | 1) {
    if (!canAdmin || !modelIsCurrent) return;
    setModel((m) =>
      m
        ? {
            ...m,
            content: {
              ...m.content,
              features: moveItem(m.content.features, index, index + dir),
            },
          }
        : m,
    );
  }

  // --- save / status -------------------------------------------------------
  async function save() {
    if (!model || !page || !modelIsCurrent) return;
    if (!canAdmin || !identity) {
      toast.error(LANDING_PAGE_ADMIN_ONLY_MESSAGE);
      return;
    }
    if (seoInvalid) {
      toast.error("Fix the SEO fields before saving.");
      return;
    }
    if (!model.name.trim()) {
      toast.error("Enter a name for this page.");
      return;
    }
    if (!SLUG_PATTERN.test(model.slug.trim())) {
      toast.error(
        "Slug must start with a letter and use only lowercase letters, numbers, and hyphens.",
      );
      return;
    }
    const publishIso = localInputToIso(model.publishAt);
    const unpublishIso = localInputToIso(model.unpublishAt);
    if (publishIso && unpublishIso && publishIso >= unpublishIso) {
      toast.error("Publish time must be earlier than the auto-unpublish time.");
      return;
    }
    const sent = model;
    const modelIntent = structuredClone(model);
    const pageIntent = {
      id: page.id,
      blocks: structuredClone(page.blocks),
    };
    const updateIntent: LandingPageUpdateInput = {
      name: modelIntent.name.trim(),
      slug: modelIntent.slug.trim(),
      template: modelIntent.template,
      domain: modelIntent.domain.trim(),
      blocks: serializeContent(modelIntent.content, pageIntent.blocks),
      seo: serializeSeo(modelIntent.seo),
      publish_at: publishIso,
      unpublish_at: unpublishIso,
    };
    if (!beginWrite()) return;
    setSaving(true);
    try {
      // Send the COMPLETE block list (PATCH-replace footgun) plus SEO + settings.
      // Schedule fields are always sent (null clears) so the tri-state PATCH
      // reflects exactly what the inputs show.
      await confirmFreshLandingPageAdminAuthority(identity);
      const updated = await landingPagesApi.update(pageIntent.id, updateIntent);
      queryClient.setQueryData(detailKey, updated);
      invalidate();
      const nextModel = toModel(updated);
      // Adopt the server's copy only if nothing was typed while the request
      // was open; writing it back unconditionally reverted those edits. The
      // baseline always moves to what the server now holds, so `dirty` stays
      // correctly armed for anything newer.
      if (modelRef.current === sent) setModel(nextModel);
      setBaseline(snapshot(nextModel));
      toast.success("Saved.");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.error(
          "That slug is already taken. Choose a different public URL.",
        );
      } else {
        toast.error(err instanceof Error ? err.message : "Save failed.");
      }
    } finally {
      setSaving(false);
      finishWrite();
    }
  }

  async function setStatus(
    pageId: string,
    next: LandingPageStatus,
    verb: string,
  ) {
    if (!canAdmin || !identity) {
      toast.error(LANDING_PAGE_ADMIN_ONLY_MESSAGE);
      return;
    }
    const intent = { pageId, next, verb } as const;
    if (!beginWrite()) return;
    setStatusBusy(true);
    try {
      await confirmFreshLandingPageAdminAuthority(identity);
      const updated = await landingPagesApi.update(intent.pageId, {
        status: intent.next,
      });
      queryClient.setQueryData(detailKey, updated);
      invalidate();
      toast.success(`Page ${intent.verb}.`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : `Could not ${verb} page.`,
      );
    } finally {
      setStatusBusy(false);
      finishWrite();
    }
  }

  // A status change sends only {status} — it never carries the editor's draft.
  // With unsaved edits on screen, publishing puts the LAST SAVED copy in front
  // of visitors while the editor keeps showing the newer one next to a green
  // "Published" badge, so the operator has to be told which version goes live
  // before the transition runs.
  function requestStatus(
    pageId: string,
    next: LandingPageStatus,
    verb: string,
    label: string,
  ) {
    if (dirty) {
      setConfirmStatus({ id: pageId, next, verb, label });
      return;
    }
    void setStatus(pageId, next, verb);
  }

  async function copyUrl() {
    if (!page) return;
    const result = await copyToClipboard(publicLandingUrl(origin, page.slug));
    if (result === "copied") toast.success("Public URL copied.");
    else if (result === "unavailable")
      toast.error("Clipboard unavailable — copy the URL manually.");
    else toast.error("Could not copy the URL.");
  }

  // --- render --------------------------------------------------------------
  if (pageQuery.isError || meQuery.error) {
    const message =
      pageQuery.error instanceof Error
        ? pageQuery.error.message
        : meQuery.error instanceof Error
          ? meQuery.error.message
          : "Could not load this landing page — this is a failed request, not a page with no content.";

    return (
      <div className="mx-auto w-full min-w-0 max-w-4xl space-y-3 px-4 py-5 sm:px-6 sm:py-6 md:p-8">
        <Link
          href="/app/landing-pages"
          className="inline-flex min-h-8 items-center text-sm text-muted-foreground hover:text-foreground"
        >
          ← Landing pages
        </Link>
        <h1 className="text-xl font-semibold">
          Couldn&apos;t load landing page
        </h1>
        <p role="alert" className="text-sm text-muted-foreground">
          {message}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void meQuery.refetch();
            void pageQuery.refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (!page || !model || !modelIsCurrent) {
    return (
      <div className="mx-auto w-full min-w-0 max-w-4xl space-y-6 px-4 py-5 sm:px-6 sm:py-6 md:p-8">
        <PageHeaderSkeleton />
        <TableSkeleton rows={6} columns={["w-40", "w-full"]} />
      </div>
    );
  }

  const url = publicLandingUrl(origin, page.slug);
  const writeBusy = saving || statusBusy;

  return (
    <div className="mx-auto w-full min-w-0 max-w-4xl space-y-6 px-4 py-5 sm:p-6">
      <div>
        <Link
          href="/app/landing-pages"
          className="inline-flex min-h-8 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Landing pages
        </Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="min-w-0 truncate font-display text-2xl font-semibold tracking-tight">
              {model.name || "Untitled page"}
            </h1>
            <Badge
              className="shrink-0"
              variant={
                page.status === "published"
                  ? "success"
                  : page.status === "draft"
                    ? "secondary"
                    : "outline"
              }
            >
              {statusLabel(page.status)}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            <span className="break-all font-mono">/landing/{page.slug}</span>
            {" · edited "}
            <RelativeTime iso={page.updated_at} />
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {page.status === "published" ? (
            <Button variant="outline" size="sm" asChild>
              <a href={url} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4" />
                View
              </a>
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => void copyUrl()}>
            <Copy className="h-4 w-4" />
            Copy URL
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href={`/app/landing-pages/${page.id}/submissions`}>
              <Users className="h-4 w-4" />
              Leads
            </Link>
          </Button>
          {page.status === "published" ? (
            <Button
              variant="outline"
              size="sm"
              disabled={!canAdmin || writeBusy}
              title={!canAdmin ? LANDING_PAGE_ADMIN_ONLY_MESSAGE : undefined}
              onClick={() =>
                requestStatus(page.id, "draft", "unpublished", "Unpublish")
              }
            >
              Unpublish
            </Button>
          ) : page.status === "draft" ? (
            <Button
              variant="outline"
              size="sm"
              disabled={!canAdmin || writeBusy}
              title={!canAdmin ? LANDING_PAGE_ADMIN_ONLY_MESSAGE : undefined}
              onClick={() =>
                requestStatus(page.id, "published", "published", "Publish")
              }
            >
              Publish
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={!canAdmin || writeBusy}
              title={!canAdmin ? LANDING_PAGE_ADMIN_ONLY_MESSAGE : undefined}
              onClick={() =>
                requestStatus(page.id, "draft", "restored", "Restore")
              }
            >
              <ArchiveRestore className="h-4 w-4" />
              Restore
            </Button>
          )}
          {page.status !== "archived" ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={!canAdmin || writeBusy}
              title={!canAdmin ? LANDING_PAGE_ADMIN_ONLY_MESSAGE : undefined}
              onClick={() =>
                setConfirmArchive({ id: page.id, name: model.name })
              }
            >
              <Archive className="h-4 w-4" />
              Archive
            </Button>
          ) : null}
          <Button
            onClick={() => void save()}
            disabled={!canAdmin || writeBusy || !dirty || saveBlocked}
            title={!canAdmin ? LANDING_PAGE_ADMIN_ONLY_MESSAGE : undefined}
            aria-describedby={
              saveBlocked ? "landing-page-save-blocked" : undefined
            }
          >
            {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
          </Button>
        </div>
      </header>

      {!canAdmin ? (
        <p
          role="status"
          className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
        >
          {LANDING_PAGE_ADMIN_ONLY_MESSAGE} Preview, public links, page metrics,
          variants, and version snapshots remain available to review.
        </p>
      ) : null}

      {saveBlockedReasons.length > 0 ? (
        <p
          id="landing-page-save-blocked"
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-foreground"
        >
          Save blocked:{" "}
          {saveBlockedReasons.length > 1
            ? `${saveBlockedReasons.slice(0, -1).join(", ")} and ${saveBlockedReasons[saveBlockedReasons.length - 1]}`
            : saveBlockedReasons[0]}
          .
        </p>
      ) : null}

      <Tabs value={activeTab} onValueChange={changeTab}>
        <TabsList aria-label="Landing page editor section">
          <TabsTrigger value="content">Content</TabsTrigger>
          <TabsTrigger value="seo">SEO</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
          <TabsTrigger value="variants">A/B variants</TabsTrigger>
          <TabsTrigger value="history">
            <History className="h-3.5 w-3.5" />
            History
          </TabsTrigger>
        </TabsList>

        {/* Content --------------------------------------------------------- */}
        <TabsContent value="content" className="space-y-6">
          <section className="rounded-md border bg-card p-4 space-y-4">
            <h2 className="text-sm font-semibold">Hero</h2>
            <div>
              <Label
                htmlFor="hero-heading"
                className="mb-1 block text-muted-foreground"
              >
                Heading
              </Label>
              <Input
                id="hero-heading"
                disabled={!canAdmin}
                value={model.content.hero.heading}
                onChange={(e) =>
                  patchContent({
                    hero: { ...model.content.hero, heading: e.target.value },
                  })
                }
                placeholder={model.name || "Your headline"}
              />
            </div>
            <div>
              <Label
                htmlFor="hero-body"
                className="mb-1 block text-muted-foreground"
              >
                Body
              </Label>
              <Textarea
                id="hero-body"
                disabled={!canAdmin}
                value={model.content.hero.body}
                onChange={(e) =>
                  patchContent({
                    hero: { ...model.content.hero, body: e.target.value },
                  })
                }
                placeholder="Explain what visitors get when they subscribe."
                rows={3}
              />
            </div>

            {/* LAND-036: AI hero-copy generation. */}
            <div className="rounded-md border border-dashed p-3 space-y-2">
              <Label
                htmlFor="hero-ai-brief"
                className="block text-muted-foreground"
              >
                Generate with AI
              </Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id="hero-ai-brief"
                  disabled={!canAdmin}
                  value={aiBrief}
                  onChange={(e) => setAiBrief(e.target.value)}
                  placeholder="What is this page offering? e.g. a weekly AI newsletter for founders"
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={!canAdmin || aiBusy || aiBrief.trim().length === 0}
                  title={
                    !canAdmin ? LANDING_PAGE_ADMIN_ONLY_MESSAGE : undefined
                  }
                  aria-describedby="hero-ai-hint"
                  onClick={() => void onGenerateHero()}
                >
                  <Sparkles className="h-4 w-4" />
                  {aiBusy ? "Generating…" : "Generate"}
                </Button>
              </div>
              <p
                id="hero-ai-hint"
                className="text-[11px] leading-tight text-muted-foreground"
              >
                Describe the offer before generating. {AI_DISCLOSURE_TEXT}
              </p>
            </div>
          </section>

          <section className="rounded-md border bg-card p-4 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold">Feature blocks</h2>
                <p className="text-xs text-muted-foreground">
                  Up to three appear on the public page.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canAdmin}
                title={!canAdmin ? LANDING_PAGE_ADMIN_ONLY_MESSAGE : undefined}
                onClick={addFeature}
              >
                <Plus className="h-4 w-4" />
                Add feature
              </Button>
            </div>
            {model.content.features.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No feature blocks yet. Add one to highlight a benefit.
              </p>
            ) : (
              <ul className="space-y-3">
                {model.content.features.map((f, i) => (
                  <li key={f.id} className="rounded-md border p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-muted-foreground">
                        Feature {i + 1}
                      </span>
                      <div className="flex items-center gap-1">
                        <IconButton
                          aria-label={`Move feature ${i + 1} up`}
                          size="sm"
                          disabled={!canAdmin || i === 0}
                          title={
                            !canAdmin
                              ? LANDING_PAGE_ADMIN_ONLY_MESSAGE
                              : undefined
                          }
                          onClick={() => reorderFeature(i, -1)}
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </IconButton>
                        <IconButton
                          aria-label={`Move feature ${i + 1} down`}
                          size="sm"
                          disabled={
                            !canAdmin || i === model.content.features.length - 1
                          }
                          title={
                            !canAdmin
                              ? LANDING_PAGE_ADMIN_ONLY_MESSAGE
                              : undefined
                          }
                          onClick={() => reorderFeature(i, 1)}
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </IconButton>
                        <IconButton
                          aria-label={`Remove feature ${i + 1}`}
                          size="sm"
                          disabled={!canAdmin}
                          title={
                            !canAdmin
                              ? LANDING_PAGE_ADMIN_ONLY_MESSAGE
                              : undefined
                          }
                          onClick={() => removeFeature(i)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </IconButton>
                      </div>
                    </div>
                    <Input
                      aria-label={`Feature ${i + 1} heading`}
                      disabled={!canAdmin}
                      value={f.heading}
                      onChange={(e) =>
                        updateFeature(i, { heading: e.target.value })
                      }
                      placeholder="Feature heading"
                    />
                    <Textarea
                      aria-label={`Feature ${i + 1} body`}
                      disabled={!canAdmin}
                      value={f.body}
                      onChange={(e) =>
                        updateFeature(i, { body: e.target.value })
                      }
                      placeholder="Feature description"
                      rows={2}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </TabsContent>

        {/* SEO and secondary settings stay off the content editor's critical path. */}
        <TabsContent value="seo" className="space-y-4">
          {activeTab === "seo" ? (
            <LandingSecondaryEditorTab
              kind="seo"
              model={model}
              seoErrors={seoErrors}
              url={url}
              scheduleInvalid={scheduleInvalid}
              readOnly={!canAdmin}
              onPatchSeo={patchSeo}
              onPatchModel={patchModel}
              onCopyUrl={() => void copyUrl()}
            />
          ) : null}
        </TabsContent>

        <TabsContent value="settings" className="space-y-4">
          {activeTab === "settings" ? (
            <LandingSecondaryEditorTab
              kind="settings"
              model={model}
              seoErrors={seoErrors}
              url={url}
              scheduleInvalid={scheduleInvalid}
              readOnly={!canAdmin}
              onPatchSeo={patchSeo}
              onPatchModel={patchModel}
              onCopyUrl={() => void copyUrl()}
            />
          ) : null}
        </TabsContent>
        {/* Preview --------------------------------------------------------- */}
        <TabsContent value="preview" className="space-y-3">
          {activeTab === "preview" ? (
            <PreviewTab
              content={model.content}
              template={model.template}
              name={model.name}
            />
          ) : null}
        </TabsContent>

        {/* History (LAND-039) --------------------------------------------- */}
        <TabsContent value="variants">
          {activeTab === "variants" ? (
            <VariantsTab
              pageId={page.id}
              currentBlocks={page.blocks ?? []}
              baseKey={landingBaseKey}
              identity={identity}
              canAdmin={canAdmin}
            />
          ) : null}
        </TabsContent>

        <TabsContent value="history">
          {activeTab === "history" ? (
            <HistoryTab
              pageId={page.id}
              baseKey={landingBaseKey}
              identity={identity}
              canAdmin={canAdmin}
              onRestored={(updated) => {
                queryClient.setQueryData(detailKey, updated);
                invalidate();
                const nextModel = toModel(updated);
                setModel(nextModel);
                setBaseline(snapshot(nextModel));
              }}
            />
          ) : null}
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={confirmArchive !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmArchive(null);
        }}
        title="Archive landing page?"
        description={`"${confirmArchive?.name ?? model.name}" will be unpublished and hidden from its public URL. You can restore it to draft afterwards.${dirty ? " Archiving does not save the edits open in the editor — they stay unsaved." : ""}`}
        confirmLabel="Archive"
        confirmVariant="destructive"
        onConfirm={async () => {
          if (confirmArchive) {
            await setStatus(confirmArchive.id, "archived", "archived");
          }
          setConfirmArchive(null);
        }}
      />

      {confirmStatus ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirmStatus(null);
          }}
          title={
            confirmStatus.next === "published"
              ? "Publish the last saved version?"
              : `${confirmStatus.label} without saving?`
          }
          description={
            confirmStatus.next === "published"
              ? `${url} will serve the last saved version of this page. The edits open in the editor are not part of it — cancel and save first if visitors should see them.`
              : "This changes the page status only. The edits open in the editor are not saved by it and stay on screen."
          }
          confirmLabel={
            confirmStatus.next === "published"
              ? "Publish saved version"
              : confirmStatus.label
          }
          confirmVariant="default"
          onConfirm={async () => {
            const intent = confirmStatus;
            await setStatus(intent.id, intent.next, intent.verb);
            setConfirmStatus(null);
          }}
        />
      ) : null}
    </div>
  );
}
