// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Eye, Save } from "lucide-react";
import { toast } from "sonner";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RelativeTime } from "@/components/relative-time";
import {
  PageHeaderSkeleton,
  TableSkeleton,
} from "@/components/dashboard/skeletons";
import { effectiveAuthRole, whoami, whoamiFresh } from "@/lib/auth-api";
import { getForm, publicFormUrl, updateForm } from "@/lib/forms-api";
import { useFormsOrigin } from "@/lib/use-forms-origin";
import { isOfflineQueuedError } from "@/lib/api";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import type {
  Form,
  FormSettings,
  FormStatus,
  FormStructure,
} from "@/lib/forms-types";
import { base, qk, STALE } from "@/lib/query-keys";
import { enumParam } from "@/lib/table-url-state";
import { useTableUrlState } from "@/lib/use-table-url-state";
import {
  assertFreshFormAuthority,
  canAdminForms,
  canWriteForms,
  FORM_READ_ONLY_MESSAGE,
} from "@/lib/forms-authority";

import { DeferredFormPanel } from "./_deferred-form-panel";

const FormBuilder = dynamic(
  () =>
    import("@/components/forms/form-builder").then((mod) => mod.FormBuilder),
  {
    ssr: false,
    loading: () => <DeferredFormPanel label="form builder" />,
  },
);

const FormPreview = dynamic(
  () =>
    import("@/components/forms/form-preview").then((mod) => mod.FormPreview),
  {
    ssr: false,
    loading: () => <DeferredFormPanel label="form preview" />,
  },
);

const AnalyticsPanel = dynamic(
  () => import("./_analytics-panel").then((mod) => mod.AnalyticsPanel),
  {
    ssr: false,
    loading: () => <DeferredFormPanel label="form analytics" />,
  },
);

const VariantsPanel = dynamic(
  () => import("./_variants-panel").then((mod) => mod.VariantsPanel),
  {
    ssr: false,
    loading: () => <DeferredFormPanel label="form variants" />,
  },
);

const ActivityPanel = dynamic(
  () => import("./_activity-panel").then((mod) => mod.ActivityPanel),
  {
    ssr: false,
    loading: () => <DeferredFormPanel label="form activity" />,
  },
);

// The Design and Settings tab bodies are not shown on first paint (Builder is
// the default tab), and the spam-protection card / edit-conflict banner render
// only inside Settings or after a 412, so all four load on demand and stay out
// of the eager route graph (bundle budget).
const DesignPanel = dynamic(
  () => import("./_editor-panels").then((mod) => mod.DesignPanel),
  {
    ssr: false,
    loading: () => <DeferredFormPanel label="design settings" />,
  },
);

const SettingsPanel = dynamic(
  () => import("./_editor-panels").then((mod) => mod.SettingsPanel),
  {
    ssr: false,
    loading: () => <DeferredFormPanel label="form settings" />,
  },
);

const SpamProtectionCard = dynamic(
  () =>
    import("@/components/forms/spam-protection-card").then(
      (mod) => mod.SpamProtectionCard,
    ),
  {
    ssr: false,
    loading: () => (
      <DeferredFormPanel label="spam protection" className="md:col-span-2" />
    ),
  },
);

// The stale-save (412) notice carries the conflict predicate from the forms
// extras API and the reload banner; neither is needed until a save has failed,
// so both stay off the eager route graph. Non-conflict errors render nothing
// here either way, hence no placeholder.
const EditConflictNotice = dynamic(
  () => import("./_edit-conflict-notice").then((mod) => mod.EditConflictNotice),
  { ssr: false, loading: () => null },
);

const EDITOR_TABS = [
  "builder",
  "design",
  "settings",
  "analytics",
  "variants",
  "activity",
] as const;
const tabSchema = { tab: enumParam(EDITOR_TABS, "builder") } as const;

// Exactly the fields save() puts on the wire. Comparing two drafts through
// this tells whether a save still represents what is on screen.
function formPayloadSnapshot(f: Form): string {
  return JSON.stringify({
    name: f.name,
    slug: f.slug,
    optInMode: f.optInMode,
    structure: f.structure,
    settings: f.settings,
    status: f.status,
  });
}

export default function FormEditorPage() {
  const queryClient = useQueryClient();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const origin = useFormsOrigin();

  const { state: tabState, setState: setTabState } =
    useTableUrlState(tabSchema);
  const activeTab = tabState.tab;

  const [draftForm, setForm] = useState<Form | null>(null);
  // Latest draft, readable after an await. save() closes over the draft as it
  // was when the request was built; this is how it tells whether the operator
  // has typed since.
  const draftRef = useRef<Form | null>(null);
  useEffect(() => {
    draftRef.current = draftForm;
  }, [draftForm]);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // The raw failure of the last save, kept so a 412 edit conflict can offer
  // "Reload latest version" instead of only a message.
  const [saveError, setSaveError] = useState<unknown>(null);
  const [dirty, setDirty] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const previewTriggerRef = useRef<HTMLButtonElement>(null);
  const archiveTriggerRef = useRef<HTMLButtonElement>(null);

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const identity = meQuery.data;
  const role = identity ? effectiveAuthRole(identity) : null;
  const viewerMode = identity?.viewer_mode === true;
  const canWrite = canWriteForms(identity);
  const canAdmin = canAdminForms(identity);
  const formsScopeKey = useMemo(
    () => base("forms", tenantId, role),
    [role, tenantId],
  );
  const listFormsScopeKey = useMemo(
    () => base("list-forms", tenantId, role),
    [role, tenantId],
  );
  const formsBaseKey = useMemo(
    () => [...formsScopeKey, identity?.user_id ?? "anon", viewerMode] as const,
    [formsScopeKey, identity?.user_id, viewerMode],
  );
  const formDetailKey = useMemo(
    () => [...formsBaseKey, "detail", id] as const,
    [formsBaseKey, id],
  );
  const formQuery = useQuery({
    queryKey: formDetailKey,
    queryFn: ({ signal }) => getForm(id, signal),
    enabled: meQuery.isSuccess,
    staleTime: STALE.detail,
  });

  useEffect(() => {
    setForm(null);
    setDirty(false);
    setActionError(null);
    setSaveError(null);
  }, [id]);

  useEffect(() => {
    if (!formQuery.data || dirty) return;
    setForm(formQuery.data);
  }, [dirty, formQuery.data]);

  const form = draftForm?.id === id ? draftForm : null;
  const loading = meQuery.isLoading || (formQuery.isPending && !form);
  const loadError =
    formQuery.error instanceof Error
      ? formQuery.error.message
      : meQuery.error instanceof Error
        ? meQuery.error.message
        : formQuery.isError
          ? "Could not load this form — this is a failed request, not an empty form."
          : null;

  function patch<K extends keyof Form>(k: K, v: Form[K]) {
    if (!canWrite) return;
    setDirty(true);
    setForm((prev) => (prev ? { ...prev, [k]: v } : prev));
  }
  function patchSettings(p: Partial<FormSettings>) {
    if (!canWrite) return;
    setDirty(true);
    setForm((prev) =>
      prev ? { ...prev, settings: { ...prev.settings, ...p } } : prev,
    );
  }
  function setStructure(s: FormStructure) {
    if (!canWrite) return;
    setDirty(true);
    setForm((prev) => (prev ? { ...prev, structure: s } : prev));
  }

  // `override` lets a caller persist a field that was just changed in the
  // same tick without waiting for the async setForm to settle.
  const save = useCallback(
    async (override?: Partial<Form>) => {
      const current = draftForm?.id === id ? draftForm : null;
      if (!current) return;
      if (!canWrite || !identity) {
        setActionError(FORM_READ_ONLY_MESSAGE);
        return;
      }
      const next = override ? { ...current, ...override } : current;
      setSaving(true);
      setActionError(null);
      setSaveError(null);
      // Save is the only eager-path consumer of the forms-types helpers; the
      // module is loaded on demand so the editor route stays under budget.
      const { safeFormSuccessRedirectUrl, validateFormSlug } =
        await import("@/lib/forms-types");
      const slugError = validateFormSlug(next.slug);
      if (slugError) {
        setActionError(slugError);
        setSaving(false);
        return;
      }
      const safeRedirect = safeFormSuccessRedirectUrl(
        next.settings.successRedirectUrl ?? "",
      );
      if (safeRedirect === null) {
        setActionError(
          "Redirect URL must be HTTPS, localhost HTTP, or root-relative.",
        );
        setSaving(false);
        return;
      }
      // Snapshot of exactly what this request carries, so the post-await code
      // can tell an untouched draft from one the operator has since edited.
      const sentSnapshot = formPayloadSnapshot(next);
      const stillMatchesSent = () => {
        const latest = draftRef.current;
        return (
          latest?.id === next.id && formPayloadSnapshot(latest) === sentSnapshot
        );
      };

      const targetListId = next.settings.targetListId?.trim() ?? "";
      if (
        targetListId &&
        (!/^\d+$/.test(targetListId) || Number(targetListId) < 1)
      ) {
        setActionError(
          "Target list ID must be a positive Listmonk integer, such as 42.",
        );
        setSaving(false);
        return;
      }
      try {
        const fresh = await whoamiFresh();
        assertFreshFormAuthority(identity, fresh, "write");
        const updated = await updateForm(
          next.id,
          {
            name: next.name,
            slug: next.slug,
            optInMode: next.optInMode,
            structure: next.structure,
            settings: {
              ...next.settings,
              successRedirectUrl: safeRedirect || undefined,
              targetListId: targetListId || undefined,
            },
            status: next.status,
          },
          { requireOnline: true },
        );
        queryClient.setQueryData<Form>(formDetailKey, updated);
        // Only adopt the server echo when the draft still matches what was
        // sent. Writing it back unconditionally overwrote anything the
        // operator typed while the request was in flight — their edits visibly
        // reverted — and setDirty(false) then disarmed the unsaved-changes
        // guard, so the loss was silent on the way out.
        if (stillMatchesSent()) {
          setForm(updated);
          setDirty(false);
        }
        void queryClient.invalidateQueries({
          queryKey: formsScopeKey,
          exact: false,
        });
        // A list's Forms tab reads which forms target it: a save can move
        // this form off one list and onto another, or change its name and
        // status there.
        void queryClient.invalidateQueries({ queryKey: listFormsScopeKey });
        toast.success("Form saved.");
      } catch (err) {
        if (isOfflineQueuedError(err)) {
          setActionError(
            "Changes queued offline and will sync after reconnecting.",
          );
          // Only the payload that was queued is safe to call clean.
          if (stillMatchesSent()) setDirty(false);
          toast.info("Saved offline — will sync on reconnect.");
        } else {
          const msg = err instanceof Error ? err.message : "Save failed";
          setSaveError(err);
          setActionError(msg);
          toast.error(msg);
        }
      } finally {
        setSaving(false);
      }
    },
    [
      canWrite,
      draftForm,
      id,
      identity,
      queryClient,
      formDetailKey,
      formsScopeKey,
      listFormsScopeKey,
    ],
  );

  async function toggleStatus() {
    if (!form) return;
    const next: FormStatus =
      form.status === "published" ? "draft" : "published";
    patch("status", next);
    await save({ status: next });
  }

  async function archiveForm() {
    if (!form) return;
    patch("status", "archived");
    await save({ status: "archived" });
  }

  // Unsaved-changes guard (FORM-003) — intercepts in-app nav + beforeunload.
  useUnsavedChangesGuard(dirty && !saving);

  // ⌘S / Ctrl-S save (FORM-025).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (canWrite && dirty && !saving) void save();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canWrite, dirty, saving, save]);

  if (!form && loadError) {
    return (
      <div className="space-y-3 p-4 sm:p-6 lg:p-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Form unavailable
        </h1>
        <p className="text-sm text-destructive" role="alert">
          Could not load form: {loadError}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void meQuery.refetch();
            void formQuery.refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (loading || !form) {
    return (
      <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6 lg:p-8">
        <h1 className="sr-only">Loading form editor</h1>
        <PageHeaderSkeleton />
        <TableSkeleton rows={6} columns={["w-40", "w-full", "w-24"]} />
      </div>
    );
  }

  const isArchived = form.status === "archived";
  const isEditable = canWrite && !isArchived;
  const publicUrl = publicFormUrl(form.slug, origin);

  return (
    <div className="flex h-full min-h-0 flex-col [@media(pointer:coarse)]:[&_button]:min-h-11 [@media(pointer:coarse)]:[&_input:not([type=checkbox]):not([type=radio])]:min-h-11 [@media(pointer:coarse)]:[&_input:not([type=checkbox]):not([type=radio])]:text-base">
      <h1 className="sr-only">Edit form: {form.name}</h1>
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-3 border-b bg-card px-4 py-3 sm:px-6">
        <Link
          href="/app/forms"
          className="inline-flex min-h-11 items-center text-sm text-muted-foreground hover:text-foreground"
        >
          ← Forms
        </Link>
        <div className="flex basis-full items-center gap-2 sm:basis-0 sm:flex-1">
          <Input
            value={form.name}
            onChange={(e) => patch("name", e.target.value)}
            aria-label="Form name"
            placeholder="Form name"
            className="max-w-md font-medium"
            disabled={!isEditable}
          />
          <Badge
            variant={
              form.status === "published"
                ? "success"
                : form.status === "draft"
                  ? "secondary"
                  : "outline"
            }
          >
            {form.status}
          </Badge>
          {dirty ? (
            <span
              className="inline-flex items-center gap-1 text-xs text-warning-emphasis"
              title="You have unsaved changes"
            >
              <span
                className="h-2 w-2 rounded-full bg-warning-emphasis"
                aria-hidden
              />
              Unsaved
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">
              Saved <RelativeTime iso={form.updatedAt} />
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          {canAdmin ? (
            <Link
              href={`/app/forms/${form.id}/submissions`}
              className="inline-flex min-h-11 items-center px-1 text-muted-foreground hover:text-foreground"
            >
              Submissions
            </Link>
          ) : null}
          <Link
            href={`/app/forms/${form.id}/embed`}
            className="inline-flex min-h-11 items-center px-1 text-muted-foreground hover:text-foreground"
          >
            Embed
          </Link>
        </div>

        <Button
          ref={previewTriggerRef}
          variant="outline"
          size="sm"
          onClick={() => setPreviewOpen(true)}
        >
          <Eye className="h-3.5 w-3.5" />
          Preview
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={toggleStatus}
          disabled={saving || !isEditable}
          title={
            isArchived
              ? "Archived forms are read-only — duplicate to edit."
              : undefined
          }
        >
          {form.status === "published" ? "Unpublish" : "Publish"}
        </Button>
        {!isArchived ? (
          <Button
            ref={archiveTriggerRef}
            variant="ghost"
            size="sm"
            onClick={() => setArchiveOpen(true)}
            disabled={saving || !isEditable}
          >
            Archive
          </Button>
        ) : null}
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={saving || !dirty || !isEditable}
        >
          <Save className="h-3.5 w-3.5" />
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>

      {isArchived ? (
        <div className="border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground sm:px-6">
          This form is archived and read-only. To keep editing, duplicate it
          from the forms list.
        </div>
      ) : null}

      {!canWrite ? (
        <div
          role="note"
          className="border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground sm:px-6"
        >
          {FORM_READ_ONLY_MESSAGE}
        </div>
      ) : null}

      {loadError && (
        <div
          role="alert"
          className="border-b bg-destructive/10 px-4 py-2 text-xs text-destructive-emphasis sm:px-6"
        >
          Could not refresh form: {loadError}
        </div>
      )}

      {actionError && (
        <div
          role="alert"
          className="border-b bg-destructive/10 px-4 py-2 text-xs text-destructive-emphasis sm:px-6"
        >
          {actionError}
        </div>
      )}

      {saveError ? (
        <EditConflictNotice
          saveError={saveError}
          formId={form.id}
          hasUnsavedChanges={dirty}
          onReloaded={(latest) => {
            queryClient.setQueryData<Form>(formDetailKey, latest);
            setForm(latest);
            setDirty(false);
            setActionError(null);
            setSaveError(null);
          }}
        />
      ) : null}

      <div className="flex-1 min-h-0 overflow-auto">
        <Tabs
          value={activeTab}
          onValueChange={(v) =>
            setTabState({ tab: v as (typeof EDITOR_TABS)[number] })
          }
          className="px-4 py-4 sm:px-6"
        >
          <TabsList aria-label="Form editor section">
            <TabsTrigger value="builder">Builder</TabsTrigger>
            <TabsTrigger value="design">Design</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
            <TabsTrigger value="analytics">Analytics</TabsTrigger>
            <TabsTrigger value="variants">A/B</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>

          <TabsContent value="builder" className="mt-4">
            <div className="grid grid-cols-12 gap-4">
              <div className="col-span-12 lg:col-span-8">
                {isEditable ? (
                  <FormBuilder form={form} onChange={setStructure} />
                ) : (
                  <div className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
                    The builder is read-only for this session. Use the live
                    preview to review the saved form.
                  </div>
                )}
              </div>
              <div className="col-span-12 lg:col-span-4">
                <h3 className="text-xs font-semibold uppercase text-muted-foreground tracking-wide mb-2">
                  Live preview
                </h3>
                <FormPreview form={form} height={520} />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="design" className="mt-4">
            <fieldset disabled={!isEditable}>
              <DesignPanel form={form} onPatchSettings={patchSettings} />
            </fieldset>
          </TabsContent>

          <TabsContent value="settings" className="mt-4">
            <fieldset disabled={!isEditable}>
              <SettingsPanel
                form={form}
                origin={origin}
                onPatchTop={patch}
                onPatchSettings={patchSettings}
                spamProtection={
                  <SpamProtectionCard
                    className="space-y-4 md:col-span-2 border-t pt-6"
                    form={formQuery.data ?? form}
                    identity={identity}
                    blockedReason={
                      dirty ? "Save or discard your other edits first." : null
                    }
                    onSaved={(saved) => {
                      queryClient.setQueryData<Form>(formDetailKey, saved);
                      setForm(saved);
                    }}
                  />
                }
              />
            </fieldset>
          </TabsContent>

          <TabsContent value="analytics" className="mt-4">
            {activeTab === "analytics" ? (
              <AnalyticsPanel formId={form.id} />
            ) : null}
          </TabsContent>

          <TabsContent value="variants" className="mt-4">
            {activeTab === "variants" ? (
              <VariantsPanel formId={form.id} />
            ) : null}
          </TabsContent>

          <TabsContent value="activity" className="mt-4">
            {activeTab === "activity" ? (
              <ActivityPanel formId={form.id} />
            ) : null}
          </TabsContent>
        </Tabs>
      </div>

      {/* In-app preview — works for drafts (no public 404). FORM-044 */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent
          className="max-w-3xl"
          onCloseAutoFocus={(event) => {
            const target = previewTriggerRef.current;
            if (!target?.isConnected || target.disabled) return;
            event.preventDefault();
            target.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Preview — {form.name}</DialogTitle>
          </DialogHeader>
          <FormPreview form={form} height={560} />
          {form.status === "published" ? (
            <a
              href={publicUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              Open the live page
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : (
            <p className="text-xs text-muted-foreground">
              This is a sandboxed preview. Publish the form to share its public
              URL.
            </p>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title="Archive form?"
        description={`"${form.name}" will be archived and become read-only. To revive it later, duplicate it from the forms list.`}
        confirmLabel="Archive"
        confirmVariant="default"
        returnFocusRef={archiveTriggerRef}
        fallbackFocusRef={previewTriggerRef}
        onConfirm={async () => {
          await archiveForm();
          setArchiveOpen(false);
        }}
      />
    </div>
  );
}
