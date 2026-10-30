// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, Download, Megaphone, Save, Users, Workflow } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { DeferredConfirmDialog } from "@/components/ui/deferred-confirm-dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip } from "@/components/ui/tooltip";
import {
  createSegment,
  deleteSegment,
  getSegmentUsage,
  listSegments,
  segmentGrowthReportCsvPath,
  updateSegment,
  type Segment,
  type SegmentNode,
} from "@/lib/segments-api";
import { fetchTextAuthed, isOfflineQueuedError } from "@/lib/api";
import { createCampaign } from "@/lib/campaigns-api";
import { downloadTextFile } from "@/lib/download";
import { base, qk, STALE } from "@/lib/query-keys";
import { whoami } from "@/lib/auth-api";

import { LiveCount } from "./live-count";
import { NodeEditor, emptyCondition } from "./node-editor";
import { NaturalLanguageCompiler } from "./nl-compiler";
import {
  SegmentTemplatesGallery,
  applyTemplate,
} from "./segment-templates-gallery";
import {
  SEGMENT_NAME_MAX,
  duplicateSegmentInput,
  restoreSegmentInput,
  seedConditionFromParams,
  blocksSegmentDelete,
  segmentDeleteDescription,
  validateName,
  validateSegment,
} from "./segment-logic";
import { useSegmentCatalogue } from "./use-segment-catalogue";
import type { SegmentChoices } from "./value-input";

export interface SegmentEditorProps {
  initial?: Segment;
}

function defaultAst(): SegmentNode {
  return { op: "and", children: [emptyCondition()] };
}

/**
 * Where the editor's segment-related queries live, so a save can mark them
 * stale. Matched by resource and tenant rather than by exact key: the list and
 * overview key by the effective role, the editor by the durable one.
 */
const SEGMENT_QUERY_RESOURCES = new Set([
  "segments",
  "segment",
  "segment-size",
  "segment-members",
  "segment-snapshots",
  "segment-defhistory",
  "segment-usage",
  // The overview's panels are computed from the definition too.
  "segment-engagement",
  "segment-decay",
  "segment-pnl",
]);

export function SegmentEditor({ initial }: SegmentEditorProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [name, setName] = React.useState(initial?.name ?? "");
  const [description, setDescription] = React.useState(
    initial?.description ?? "",
  );
  const [ast, setAst] = React.useState<SegmentNode>(
    initial?.queryAst ?? defaultAst(),
  );
  // Initialize from the loaded segment so re-opening a saved definition
  // reflects its persisted archive scope (SEG-034).
  const [includeArchived, setIncludeArchived] = React.useState(
    initial?.includeArchived ?? false,
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [nameTouched, setNameTouched] = React.useState(false);
  const [naturalLanguageSeed, setNaturalLanguageSeed] = React.useState("");

  // Seed a fresh draft from an insight the user clicked (ANL-031): the audience
  // panel links here with `?seedName=&seedDescription=`. Applied once on mount,
  // only for a brand-new pristine segment (no `initial`, empty name), so it
  // never clobbers an edit-in-progress. Read from window in an effect (not
  // useSearchParams) to avoid a Suspense/CSR-bailout requirement.
  const seededRef = React.useRef(false);
  React.useEffect(() => {
    if (seededRef.current || initial) return;
    seededRef.current = true;
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const seedName = params.get("seedName");
    const seedDescription = params.get("seedDescription");
    const seedNaturalLanguage = params.get("seedNaturalLanguage");
    if (seedName && !name.trim()) {
      setName(seedName.slice(0, SEGMENT_NAME_MAX));
      setNameTouched(true);
    }
    if (seedDescription && !description.trim()) {
      setDescription(seedDescription.slice(0, 500));
    }
    if (seedNaturalLanguage) {
      setNaturalLanguageSeed(seedNaturalLanguage.slice(0, 1_000));
    }
    // Optional pre-applied rule (e.g. contact_rating equals 4 from the Audience
    // Intelligence rating tiles) so the draft opens filter-ready, not blank.
    // Validated in segment-logic: an unrecognised comparator from the URL is
    // dropped rather than cast into the AST, where it would have saved cleanly
    // and rendered as an empty dropdown.
    const seeded = seedConditionFromParams(params);
    if (seeded) setAst(seeded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  const me = useQuery({
    queryKey: ["auth-me"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = me.data?.tenant_id ?? "anon";
  const role = me.data?.role ?? null;

  // Builder fields come from the predicate registry, which lists every
  // built-in and custom field once (see useSegmentCatalogue).
  const fieldsQuery = useSegmentCatalogue(tenantId, role, me.isFetched);
  const fields = fieldsQuery.data?.fields;
  const catalogueDegraded = fieldsQuery.data?.degraded === true;

  // Other segments a segment-of-segments rule can point at. Shares the list
  // page's cache entry; the segment being edited cannot reference itself.
  const segmentsQuery = useQuery({
    queryKey: qk.segments(tenantId, role, null),
    enabled: me.isFetched,
    staleTime: STALE.list,
    queryFn: listSegments,
  });
  const refetchSegments = segmentsQuery.refetch;
  const referenceSegments = React.useMemo<SegmentChoices>(
    () => ({
      items: Array.isArray(segmentsQuery.data)
        ? segmentsQuery.data
            .filter((s) => s.id !== initial?.id)
            .map((s) => ({ id: s.id, name: s.name }))
            .sort((a, b) => a.name.localeCompare(b.name))
        : undefined,
      failed: segmentsQuery.isError,
      retry: () => void refetchSegments(),
    }),
    [segmentsQuery.data, segmentsQuery.isError, refetchSegments, initial?.id],
  );

  // Usage (existing segments): what references this segment (SEG-010).
  const usageQuery = useQuery({
    queryKey: [...base("segment-usage", tenantId, role), initial?.id ?? ""],
    enabled: me.isFetched && Boolean(initial?.id),
    staleTime: STALE.detail,
    queryFn: () => getSegmentUsage(initial!.id),
  });
  // Memoised so the `?? []` fallback keeps a stable identity while the usage
  // query is pending — otherwise the deleteDescription memo re-ran every render.
  const dependents = React.useMemo(
    () => (Array.isArray(usageQuery.data?.items) ? usageQuery.data?.items : []),
    [usageQuery.data],
  );

  // --- Dirty tracking (SEG-001) -------------------------------------------
  const pristine = React.useRef(
    JSON.stringify({
      name: initial?.name ?? "",
      description: initial?.description ?? "",
      ast: initial?.queryAst ?? defaultAst(),
      includeArchived: initial?.includeArchived ?? false,
    }),
  );
  const dirty =
    JSON.stringify({ name, description, ast, includeArchived }) !==
    pristine.current;
  const dirtyRef = React.useRef(dirty);
  React.useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  // Warn on tab close / refresh with unsaved edits.
  React.useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const nameError = error === null && nameTouched ? validateName(name) : null;

  const leaveToList = React.useCallback(() => {
    router.push("/app/subscribers/segments");
  }, [router]);

  // Mark every segment read for this workspace stale, so the list and the
  // overview show the saved state when they mount, instead of a copy cached
  // before the save.
  const invalidateSegmentQueries = React.useCallback(
    () =>
      queryClient.invalidateQueries({
        predicate: (query) =>
          SEGMENT_QUERY_RESOURCES.has(String(query.queryKey[0])) &&
          query.queryKey[1] === tenantId,
      }),
    [queryClient, tenantId],
  );

  async function onSave() {
    setError(null);
    const v = validateSegment(name, ast);
    if (!v.valid) {
      const msg = v.nameError
        ? v.nameError
        : `Complete ${v.incompleteCount} rule${v.incompleteCount === 1 ? "" : "s"} — some are missing a value.`;
      setError(msg);
      // Client validation is already rendered as an immediate in-page alert
      // beside the form. A second persistent toast duplicates the same message
      // and, on a 320px viewport, can cover the correction / Cancel controls.
      // Reserve global toasts for async save outcomes below.
      return;
    }
    setSaving(true);
    try {
      // queryAst is always the complete AST from local state — a full replace,
      // never a partial map, so no keys are dropped on update.
      const saved = initial
        ? await updateSegment(initial.id, {
            name: name.trim(),
            description,
            queryAst: ast,
            includeArchived,
          })
        : await createSegment({
            name: name.trim(),
            description,
            queryAst: ast,
            includeArchived,
          });
      toast.success(initial ? "Segment saved." : "Segment created.");
      pristine.current = JSON.stringify({
        name,
        description,
        ast,
        includeArchived,
      });
      void invalidateSegmentQueries();
      // Land on the segment just saved: its overview is where the count and
      // the members are. The button stays disabled until the route changes,
      // so a second press cannot post the same segment twice.
      router.push(`/app/subscribers/segments/${encodeURIComponent(saved.id)}`);
    } catch (err) {
      const msg = isOfflineQueuedError(err)
        ? "Segment queued offline. It will sync after reconnecting."
        : err instanceof Error
          ? err.message
          : "Save failed.";
      setError(msg);
      if (isOfflineQueuedError(err)) toast.message(msg);
      else toast.error(msg);
      setSaving(false);
    }
  }

  // Cmd/Ctrl+Enter saves (SEG-029).
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (!saving) void onSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, description, ast, saving, initial]);

  async function onDelete() {
    if (!initial) return;
    // Capture the definition so the toast can offer a restore path (SEG-003).
    const snapshot = restoreSegmentInput(initial);
    setSaving(true);
    try {
      await deleteSegment(initial.id);
      pristine.current = JSON.stringify({
        name,
        description,
        ast,
        includeArchived,
      });
      toast.success("Segment deleted.", {
        action: {
          label: "Undo",
          onClick: () => {
            void createSegment(snapshot)
              .then(() => {
                void invalidateSegmentQueries();
                toast.success("Segment restored.");
              })
              .catch(() => toast.error("Could not restore segment."));
          },
        },
      });
      void invalidateSegmentQueries();
      router.push("/app/subscribers/segments");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Delete failed.";
      setError(msg);
      toast.error(msg);
      setSaving(false);
    }
  }

  async function onDuplicate() {
    if (!initial) return;
    setSaving(true);
    try {
      const copy = await createSegment(
        duplicateSegmentInput(initial, { description, queryAst: ast }),
      );
      toast.success("Segment duplicated.");
      void invalidateSegmentQueries();
      router.push(
        `/app/subscribers/segments/${encodeURIComponent(copy.id)}/edit`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not duplicate.");
      setSaving(false);
    }
  }

  async function onExport() {
    if (!initial) return;
    try {
      const csv = await fetchTextAuthed(segmentGrowthReportCsvPath(initial.id));
      downloadTextFile(
        `segment-${initial.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-growth.csv`,
        csv,
        "text/csv;charset=utf-8",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed.");
    }
  }

  async function onUseInCampaign() {
    if (!initial) return;
    setSaving(true);
    try {
      const campaign = await createCampaign({
        name: `Campaign for ${initial.name}`,
        // Backend requires a non-empty subject; seed an editable placeholder.
        subject: `Message to ${initial.name}`,
        segment_id: initial.id,
      });
      toast.success("Draft campaign created for this segment.");
      router.push(`/app/campaigns/${campaign.id}`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not create campaign.",
      );
      setSaving(false);
    }
  }

  const deleteDescription = React.useMemo(
    () => segmentDeleteDescription(initial?.name ?? "", dependents),
    [dependents, initial?.name],
  );
  // The API would refuse the delete (409 segment_in_use), so the dialog
  // explains what to move instead of offering an action that can only fail.
  const deleteBlocked = React.useMemo(
    () => dependents.some(blocksSegmentDelete),
    [dependents],
  );

  // Live, non-blocking match-risk warning (SEG-030): flag a definition that
  // would match the whole audience (no rules) or nobody (every rule blank).
  const liveValidation = React.useMemo(
    () => validateSegment(name, ast),
    [name, ast],
  );
  const matchWarning = liveValidation.matchAllWarning
    ? "This segment has no rules yet — it would match every contact in scope."
    : liveValidation.matchNoneWarning
      ? "Every rule is missing a value — as written this segment would match no one."
      : null;

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6 sm:py-8">
      <Breadcrumb
        items={[
          { label: "Subscribers", href: "/app/subscribers" },
          { label: "Segments", href: "/app/subscribers/segments" },
          { label: initial ? initial.name : "New" },
        ]}
      />

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            {initial ? "Edit segment" : "New segment"}
          </h1>
          <p className="text-sm text-muted-foreground">
            Build a filter from one or more rule groups. Live count updates as
            you edit.{" "}
            <kbd className="rounded border bg-muted px-1 text-[10px]">
              ⌘/Ctrl
            </kbd>
            +
            <kbd className="rounded border bg-muted px-1 text-[10px]">
              Enter
            </kbd>{" "}
            saves.
          </p>
        </div>
        <LiveCount ast={ast} includeArchived={includeArchived} />
      </div>

      {!initial ? (
        <>
          <SegmentTemplatesGallery
            onApply={(t) => {
              const applied = applyTemplate(t);
              setName((n) => n || applied.name);
              setAst(applied.ast);
            }}
          />
          <NaturalLanguageCompiler
            initialText={naturalLanguageSeed}
            onResult={({ ast: nlAst, suggestedName }) => {
              setAst(nlAst);
              if (suggestedName) setName((n) => n || suggestedName);
            }}
          />
        </>
      ) : null}

      <div className="rounded-lg border bg-card p-5 space-y-4">
        <div className="space-y-1.5">
          <label
            className="text-xs font-medium text-muted-foreground"
            htmlFor="seg-name"
          >
            Name
          </label>
          <Input
            id="seg-name"
            value={name}
            maxLength={SEGMENT_NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setNameTouched(true)}
            placeholder="Engaged readers"
            aria-invalid={Boolean(nameError) || error === "Name is required"}
            aria-describedby={nameError ? "seg-name-error" : undefined}
          />
          <div className="flex items-center justify-between">
            {nameError ? (
              <span id="seg-name-error" className="text-xs text-destructive">
                {nameError}
              </span>
            ) : (
              <span />
            )}
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {name.length}/{SEGMENT_NAME_MAX}
            </span>
          </div>
        </div>
        <div className="space-y-1.5">
          <label
            className="text-xs font-medium text-muted-foreground"
            htmlFor="seg-desc"
          >
            Description
          </label>
          <Textarea
            id="seg-desc"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional. What does this segment represent?"
          />
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center sm:gap-3">
          <h2 className="text-sm font-medium">Rules</h2>
          <label className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-input accent-primary"
            />
            {/* "in preview" understated this: the toggle is persisted with the
                definition (SEG-034) and decides whether archived contacts are
                in scope for the SAVED segment — every count, campaign audience
                and automation that uses it — not just the live count above. */}
            Include archived subscribers in this segment
          </label>
        </div>
        {catalogueDegraded && (
          <div
            role="alert"
            className="flex flex-col items-start justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground sm:flex-row sm:items-center"
          >
            <span>
              Couldn&apos;t load the full list of fields. You can still build
              rules on the basic profile, consent and engagement fields; retry
              to add predictive, event and segment rules.
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 shrink-0 sm:h-7 sm:min-h-0"
              onClick={() => void fieldsQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        )}
        {fieldsQuery.isPending ? (
          // Stored rules can't be labelled truthfully before the catalogue
          // arrives: a registry field would read as "no longer available".
          <div role="status" aria-live="polite" className="space-y-2">
            <span className="sr-only">Loading fields…</span>
            <Skeleton aria-hidden className="h-[3.25rem] w-full" />
            <Skeleton aria-hidden className="h-9 w-40" />
          </div>
        ) : (
          <NodeEditor
            node={ast}
            onChange={setAst}
            fields={fields}
            catalogueDegraded={catalogueDegraded}
            segments={referenceSegments}
          />
        )}
        {matchWarning ? (
          <div
            role="status"
            aria-live="polite"
            className="mt-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning-subtle px-3 py-2 text-sm text-warning-emphasis"
          >
            <span aria-hidden>⚠</span>
            <span>{matchWarning}</span>
          </div>
        ) : null}
      </div>

      {initial && dependents.length > 0 ? (
        <div className="rounded-lg border bg-card p-4">
          <h2 className="text-sm font-medium">Used by</h2>
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
            {dependents.slice(0, 8).map((d) => (
              <li key={`${d.kind}-${d.id}`} className="flex items-center gap-2">
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                  {d.kind.replace("_", " ")}
                </span>
                <span className="text-foreground">{d.name}</span>
                {d.status ? (
                  <span className="text-xs">· {d.status}</span>
                ) : null}
              </li>
            ))}
            {dependents.length > 8 ? (
              <li>+{dependents.length - 8} more</li>
            ) : null}
          </ul>
        </div>
      ) : null}

      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive-emphasis"
        >
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void onSave()} disabled={saving}>
          <Save className="h-4 w-4" />
          {initial ? "Save changes" : "Create segment"}
        </Button>

        {initial ? (
          <>
            <Tooltip label="Create a draft campaign targeting this segment">
              <Button
                type="button"
                variant="outline"
                onClick={() => void onUseInCampaign()}
                disabled={saving}
              >
                <Megaphone className="h-4 w-4" />
                Use in a campaign
              </Button>
            </Tooltip>
            <Button asChild variant="outline">
              <Link href="/app/flows">
                <Workflow className="h-4 w-4" />
                Use in an automation
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href={`/app/subscribers/segments/${initial.id}`}>
                <Users className="h-4 w-4" />
                Overview
              </Link>
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void onDuplicate()}
              disabled={saving}
            >
              <Copy className="h-4 w-4" />
              Duplicate
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void onExport()}
              disabled={saving}
            >
              <Download className="h-4 w-4" />
              Export
            </Button>
            {/* Both confirmations load when first opened, keeping Radix
                Dialog out of the builder's initial JavaScript (bundle
                budget). */}
            <DeferredConfirmDialog
              title={
                deleteBlocked
                  ? "This segment can't be deleted yet"
                  : "Delete segment?"
              }
              description={deleteDescription}
              confirmLabel="Delete"
              cancelLabel={deleteBlocked ? "Close" : "Cancel"}
              confirmDisabled={deleteBlocked}
              onConfirm={onDelete}
              trigger={
                <Button
                  variant="outline"
                  disabled={saving}
                  className="text-destructive hover:text-destructive"
                >
                  Delete
                </Button>
              }
            />
          </>
        ) : null}

        {dirty ? (
          <DeferredConfirmDialog
            title="Discard unsaved changes?"
            description="Your edits to this segment haven't been saved. Leaving now discards them."
            confirmLabel="Discard changes"
            cancelLabel="Keep editing"
            confirmVariant="destructive"
            onConfirm={leaveToList}
            trigger={
              <Button variant="ghost" disabled={saving}>
                Cancel
              </Button>
            }
          />
        ) : (
          <Button variant="ghost" onClick={leaveToList} disabled={saving}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
