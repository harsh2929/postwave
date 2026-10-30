// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * SunsetPoliciesCard — sunset policy management on /list-hygiene (parity row
 * audience-43; desktop reference components/subscribers/SunsetPoliciesCard).
 *
 * Web counted the policies and could do nothing with them. This card adds what
 * desktop has: create / edit / delete a policy, per-policy execution history,
 * and the re-engagement template preview.
 *
 * RUN NOW IS WITHHELD, ON PURPOSE AND ON BOTH CLIENTS. `POST …/{id}/run` is a
 * synchronous sweep with no reviewed impact plan, progress, cancellation,
 * targeted retry or receipt. Desktop renders "Run unavailable" and saves every
 * definition paused; so does this card. Nothing here calls `/run`.
 *
 * Policy CRUD is ScopeAdmin server-side — the LIST included — so a non-admin
 * gets the reason and zero protected requests, never a 403.
 */

import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History, Loader2, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
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
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import {
  createSunsetPolicy,
  deleteSunsetPolicy,
  describeSunsetCriteria,
  listSunsetExecutions,
  listSunsetPolicies,
  parseExcludedTags,
  previewSunsetReengagement,
  SUNSET_ACTION_LABELS,
  SUNSET_ACTIONS,
  SUNSET_INACTIVE_DAYS_MAX,
  SUNSET_INACTIVE_DAYS_MIN,
  SUNSET_TEMPLATE_VARIANTS,
  SUNSET_TONES,
  updateSunsetPolicy,
  validateSunsetBrand,
  validateSunsetPolicyInput,
  type SunsetAction,
  type SunsetBrandSnapshot,
  type SunsetPolicy,
  type SunsetPolicyInput,
  type SunsetReengagementTemplate,
  type SunsetTemplateVariant,
  type SunsetTone,
} from "@/lib/list-hygiene-api";
import { STALE } from "@/lib/query-keys";
import { roleCanWrite } from "@/lib/use-admin-gate";

/** Owner or admin outside viewer mode — the server's ScopeAdmin gate. */
export function canManageSunsetPolicies(
  identity: MeResponse | null | undefined,
): boolean {
  return Boolean(
    identity &&
    identity.viewer_mode !== true &&
    roleCanWrite(effectiveAuthRole(identity)),
  );
}

function manageGateReason(identity: MeResponse | null): string {
  if (!identity) return "Workspace identity is still resolving.";
  if (identity.viewer_mode === true) {
    return "View as viewer is on, so sunset policies are not requested or changed.";
  }
  return "Sunset policies need owner or admin access.";
}

interface PolicyDraft {
  name: string;
  inactiveDays: string;
  action: SunsetAction;
  excludedTags: string;
}

const EMPTY_DRAFT: PolicyDraft = {
  name: "",
  inactiveDays: "180",
  action: "suppress",
  excludedTags: "",
};

function draftFromPolicy(policy: SunsetPolicy): PolicyDraft {
  return {
    name: policy.name,
    inactiveDays: String(policy.inactiveDays),
    action: (SUNSET_ACTIONS as readonly string[]).includes(policy.action)
      ? (policy.action as SunsetAction)
      : "suppress",
    excludedTags: policy.excludedTags.join(", "),
  };
}

function draftToInput(draft: PolicyDraft): SunsetPolicyInput {
  return {
    name: draft.name.trim(),
    // Number("") is 0 and Number("12.5") is not whole; both fail validation
    // rather than being coerced into something the operator did not type.
    inactiveDays: draft.inactiveDays.trim() === "" ? NaN : Number(draft.inactiveDays),
    action: draft.action,
    enabled: false,
    excludedTags: parseExcludedTags(draft.excludedTags),
  };
}

type EditorState = { mode: "create" } | { mode: "edit"; policy: SunsetPolicy };

export function SunsetPoliciesCard({
  identity,
  queryKey,
}: {
  /** The page's resolved identity; null while it is still unknown. */
  identity: MeResponse | null;
  /** The page's own sunset key, so both observers share one fetch. */
  queryKey: readonly unknown[];
}) {
  const queryClient = useQueryClient();
  const gateId = useId();
  const reasonId = useId();
  const canManage = canManageSunsetPolicies(identity);
  const [editor, setEditor] = useState<EditorState | null>(null);

  const policies = useQuery({
    queryKey: [...queryKey],
    queryFn: listSunsetPolicies,
    enabled: canManage,
    staleTime: STALE.list,
  });
  const rows = Array.isArray(policies.data) ? policies.data : [];

  const replaceRows = (next: (current: SunsetPolicy[]) => SunsetPolicy[]) => {
    queryClient.setQueryData<SunsetPolicy[]>([...queryKey], (current) =>
      next(Array.isArray(current) ? current : []),
    );
  };

  async function removePolicy(policy: SunsetPolicy): Promise<void> {
    if (!identity) throw new Error("Workspace identity is not resolved yet.");
    try {
      await verifyFreshAdminAuthority(identity);
      await deleteSunsetPolicy(policy.id);
    } catch (error: unknown) {
      throw new Error(
        apiErrorMessage(error, `"${policy.name}" could not be deleted.`),
      );
    }
    replaceRows((current) => current.filter((row) => row.id !== policy.id));
    toast.success(`Deleted "${policy.name}"`);
  }

  return (
    <section
      aria-labelledby="lh-sunset"
      className="rounded-lg border p-4 sm:p-6"
      data-testid="sunset-policies"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="lh-sunset" className="text-base font-medium">
            Sunset policies
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Policies decide when a subscriber counts as inactive and what
            happens to them.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canManage ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void policies.refetch()}
              disabled={policies.isFetching}
              aria-busy={policies.isFetching}
            >
              <RefreshCw aria-hidden className="h-4 w-4" />
              {policies.isFetching ? "Loading…" : "Refresh policies"}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            disabled={!canManage}
            aria-describedby={canManage ? undefined : reasonId}
            onClick={() => setEditor({ mode: "create" })}
          >
            <Plus aria-hidden className="h-4 w-4" />
            New policy
          </Button>
        </div>
      </div>

      {!canManage ? (
        <p id={reasonId} role="status" className="mt-2 text-sm text-muted-foreground">
          {manageGateReason(identity)} No policy request was made for this
          session.
        </p>
      ) : null}

      <div
        id={gateId}
        role="note"
        aria-label="Sunset execution availability"
        className="mt-3 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm"
      >
        <p className="font-medium">
          Automated and manual sweeps are unavailable in this release
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          You can review policy definitions and historical executions. New and
          edited definitions stay paused until execution has an immutable
          impact preview, durable progress, cancellation, targeted retry, and a
          complete receipt. No subscriber is changed from this page.
        </p>
      </div>

      {canManage ? (
        <div className="mt-4">
          {policies.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading sunset policies…
            </p>
          ) : policies.isError ? (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3"
            >
              <p className="text-sm text-destructive">
                {apiErrorMessage(
                  policies.error,
                  "Sunset policies could not be loaded.",
                )}{" "}
                This is a failed request, not an empty list.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void policies.refetch()}
                disabled={policies.isFetching}
              >
                Retry
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              No sunset policies yet. Create one to define when inactive
              subscribers get suppressed, tagged, or queued for a win-back.
            </p>
          ) : (
            <ul className="grid gap-3" aria-label="Sunset policies">
              {rows.map((policy) => (
                <SunsetPolicyRow
                  key={policy.id}
                  policy={policy}
                  gateId={gateId}
                  queryKey={queryKey}
                  onEdit={() => setEditor({ mode: "edit", policy })}
                  onDelete={() => removePolicy(policy)}
                />
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <ReengagementPreview canManage={canManage} reasonId={reasonId} />

      <SunsetPolicyDialog
        key={editor?.mode === "edit" ? editor.policy.id : (editor?.mode ?? "closed")}
        editor={editor}
        identity={identity}
        onClose={() => setEditor(null)}
        onSaved={(saved, created) => {
          replaceRows((current) =>
            created
              ? [saved, ...current.filter((row) => row.id !== saved.id)]
              : current.map((row) => (row.id === saved.id ? saved : row)),
          );
          setEditor(null);
          toast.success(
            created ? `Created "${saved.name}"` : `Updated "${saved.name}"`,
          );
        }}
      />
    </section>
  );
}

function SunsetPolicyRow({
  policy,
  gateId,
  queryKey,
  onEdit,
  onDelete,
}: {
  policy: SunsetPolicy;
  gateId: string;
  queryKey: readonly unknown[];
  onEdit: () => void;
  onDelete: () => Promise<void>;
}) {
  const historyId = useId();
  const [historyOpen, setHistoryOpen] = useState(false);
  return (
    <li className="rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 break-words text-sm font-medium">
          {policy.name}
        </span>
        <Badge variant="outline">
          {policy.enabled ? "Legacy enabled flag · execution gated" : "Paused"}
        </Badge>
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={historyOpen}
          aria-controls={historyId}
          onClick={() => setHistoryOpen((open) => !open)}
        >
          <History aria-hidden className="h-4 w-4" />
          {historyOpen ? "Hide history" : "History"}
        </Button>
        <Badge variant="secondary" aria-describedby={gateId}>
          Run unavailable
        </Badge>
        <Button type="button" variant="outline" size="sm" onClick={onEdit}>
          Edit
        </Button>
        <ConfirmDialog
          trigger={
            <Button type="button" variant="ghost" size="sm" className="text-destructive">
              Delete
            </Button>
          }
          title="Delete sunset policy?"
          description={`Delete "${policy.name}"? Past executions stay in the history; no subscribers are changed.`}
          confirmLabel="Delete policy"
          cancelLabel="Keep policy"
          onConfirm={onDelete}
        />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {describeSunsetCriteria(policy)}
      </p>
      <section
        id={historyId}
        hidden={!historyOpen}
        aria-label={`${policy.name} execution history`}
        className="mt-2 border-t pt-2"
      >
        {historyOpen ? (
          <SunsetExecutionHistory policyId={policy.id} queryKey={queryKey} />
        ) : null}
      </section>
    </li>
  );
}

function SunsetExecutionHistory({
  policyId,
  queryKey,
}: {
  policyId: string;
  queryKey: readonly unknown[];
}) {
  const executions = useQuery({
    queryKey: [...queryKey, "executions", policyId],
    queryFn: () => listSunsetExecutions(policyId),
    staleTime: STALE.list,
  });
  const rows = Array.isArray(executions.data) ? executions.data : [];

  if (executions.isPending) {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Loading execution history…
      </p>
    );
  }
  if (executions.isError) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-destructive">
          Couldn&apos;t load history:{" "}
          {apiErrorMessage(executions.error, "the request failed.")}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void executions.refetch()}
          disabled={executions.isFetching}
        >
          Retry history
        </Button>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No executions recorded for this policy yet.
      </p>
    );
  }
  return (
    <ul
      tabIndex={0}
      aria-label="Execution history rows"
      className="grid max-h-56 gap-1 overflow-y-auto rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {rows.map((row) => (
        <li
          key={row.id}
          className="grid gap-1 rounded bg-muted/40 px-2 py-1 text-xs sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:gap-3"
        >
          <span className="min-w-0 break-all">
            {row.subscriberId || "Unknown subscriber"}
            {row.reason ? (
              <span className="text-muted-foreground"> — {row.reason}</span>
            ) : null}
          </span>
          <Badge variant="outline">{row.actionTaken || "unknown"}</Badge>
          <span className="tabular-nums text-muted-foreground">
            {formatWireTimestamp(row.executedAt, "Unknown time")}
          </span>
        </li>
      ))}
    </ul>
  );
}

function SunsetPolicyDialog({
  editor,
  identity,
  onClose,
  onSaved,
}: {
  editor: EditorState | null;
  identity: MeResponse | null;
  onClose: () => void;
  onSaved: (policy: SunsetPolicy, created: boolean) => void;
}) {
  const nameId = useId();
  const daysId = useId();
  const actionId = useId();
  const tagsId = useId();
  const statusId = useId();
  const [draft, setDraft] = useState<PolicyDraft>(() =>
    editor?.mode === "edit" ? draftFromPolicy(editor.policy) : EMPTY_DRAFT,
  );
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<"name" | "inactiveDays" | "action", string>>
  >({});

  const save = useMutation({
    mutationFn: async (input: SunsetPolicyInput) => {
      if (!identity) throw new Error("Workspace identity is not resolved yet.");
      await verifyFreshAdminAuthority(identity);
      return editor?.mode === "edit"
        ? updateSunsetPolicy(editor.policy.id, input)
        : createSunsetPolicy(input);
    },
    onSuccess: (saved) => onSaved(saved, editor?.mode !== "edit"),
  });

  const submit = () => {
    if (save.isPending) return;
    const input = draftToInput(draft);
    const errors = validateSunsetPolicyInput(input);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    save.mutate(input);
  };

  const editing = editor?.mode === "edit";
  return (
    <Dialog
      open={editor !== null}
      onOpenChange={(open) => {
        if (!open && !save.isPending) onClose();
      }}
    >
      <DialogContent
        closeDisabled={save.isPending}
        onEscapeKeyDown={(event) => {
          if (save.isPending) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (save.isPending) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit sunset policy" : "New sunset policy"}
          </DialogTitle>
          <DialogDescription>
            Subscribers inactive past the threshold are swept by the
            policy&apos;s action. Excluded tags are never touched.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          // The field messages below mirror the server's own rules; native
          // constraint bubbles would pre-empt them with browser copy.
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor={nameId}>Name</Label>
            <Input
              id={nameId}
              value={draft.name}
              placeholder="12-month sunset"
              disabled={save.isPending}
              aria-invalid={fieldErrors.name ? true : undefined}
              onChange={(event) =>
                setDraft((d) => ({ ...d, name: event.target.value }))
              }
            />
            {fieldErrors.name ? (
              <p className="text-xs text-destructive">{fieldErrors.name}</p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={daysId}>Inactive days</Label>
            <Input
              id={daysId}
              type="number"
              inputMode="numeric"
              min={SUNSET_INACTIVE_DAYS_MIN}
              max={SUNSET_INACTIVE_DAYS_MAX}
              step={1}
              value={draft.inactiveDays}
              disabled={save.isPending}
              aria-invalid={fieldErrors.inactiveDays ? true : undefined}
              onChange={(event) =>
                setDraft((d) => ({ ...d, inactiveDays: event.target.value }))
              }
            />
            <p className="text-xs text-muted-foreground">
              How long without engagement before a subscriber qualifies (
              {SUNSET_INACTIVE_DAYS_MIN}–{SUNSET_INACTIVE_DAYS_MAX} days).
            </p>
            {fieldErrors.inactiveDays ? (
              <p className="text-xs text-destructive">
                {fieldErrors.inactiveDays}
              </p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={actionId}>Action</Label>
            <Select
              id={actionId}
              value={draft.action}
              disabled={save.isPending}
              onChange={(event) =>
                setDraft((d) => ({
                  ...d,
                  action: event.target.value as SunsetAction,
                }))
              }
            >
              {SUNSET_ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {SUNSET_ACTION_LABELS[action]}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={tagsId}>Excluded tags</Label>
            <Input
              id={tagsId}
              value={draft.excludedTags}
              placeholder="vip, paying-customer"
              disabled={save.isPending}
              onChange={(event) =>
                setDraft((d) => ({ ...d, excludedTags: event.target.value }))
              }
            />
            <p className="text-xs text-muted-foreground">
              Comma-separated. Subscribers carrying any of these tags are
              skipped by the sweep.
            </p>
          </div>
          <p role="note" className="rounded-md border bg-muted/40 p-2 text-xs">
            This definition will be saved as paused. Enabling execution is
            withheld until the reviewed, cancellable job contract is available.
          </p>
          {save.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {apiErrorMessage(save.error, "The policy could not be saved.")}
            </p>
          ) : null}
          <p id={statusId} role="status" className="text-xs text-muted-foreground">
            {save.isPending
              ? "Saving the policy. This dialog stays open until the request settles."
              : "Saving only updates this paused definition; it does not scan or change subscribers."}
          </p>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={save.isPending}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={save.isPending}
              aria-describedby={statusId}
            >
              {save.isPending ? (
                <>
                  <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : editing ? (
                "Save policy"
              ) : (
                "Create policy"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const BRAND_TEXT_FIELDS = [
  { key: "WorkspaceName", label: "Workspace name" },
  { key: "SenderName", label: "Sender name" },
  { key: "ProductName", label: "Product name" },
] as const;

const BRAND_URL_FIELDS = [
  { key: "HomepageURL", label: "Homepage URL" },
  { key: "UnsubscribeURL", label: "Unsubscribe URL" },
] as const;

/**
 * POST /sunset/reengagement/preview. A pure template generator: ONE rendered
 * template back, not a candidate list, and nothing is sent or scheduled. The
 * HTML is shown as source text only — generated markup is never injected.
 */
function ReengagementPreview({
  canManage,
  reasonId,
}: {
  canManage: boolean;
  reasonId: string;
}) {
  const baseId = useId();
  const toneId = useId();
  const variantId = useId();
  const errorId = useId();
  const htmlId = useId();
  const [brand, setBrand] = useState<SunsetBrandSnapshot>({});
  const [tone, setTone] = useState<SunsetTone>("casual");
  const [variant, setVariant] = useState<SunsetTemplateVariant>("soft");
  const [invalid, setInvalid] = useState<{
    field: keyof SunsetBrandSnapshot;
    message: string;
  } | null>(null);
  const [showHtml, setShowHtml] = useState(false);

  const preview = useMutation({
    mutationFn: previewSunsetReengagement,
  });
  const template: SunsetReengagementTemplate | undefined = preview.data;

  // Any edit invalidates a rendered template: it no longer reflects the form.
  const touch = () => {
    setInvalid(null);
    setShowHtml(false);
    preview.reset();
  };

  const generate = () => {
    if (!canManage || preview.isPending) return;
    const snapshot: SunsetBrandSnapshot = { ...brand, Tone: tone };
    const problem = validateSunsetBrand(snapshot);
    setInvalid(problem);
    if (problem) return;
    preview.mutate({ brand: snapshot, variant });
  };

  const describedBy = (field: keyof SunsetBrandSnapshot) =>
    invalid?.field === field ? errorId : !canManage ? reasonId : undefined;

  return (
    <details className="mt-4 rounded-md border p-3">
      <summary className="cursor-pointer text-sm font-medium">
        Re-engagement email preview
        <span className="font-normal text-muted-foreground">
          {" "}
          — template-generated win-back copy from your brand fields
        </span>
      </summary>
      <p className="mt-2 text-xs text-muted-foreground">
        This is a copy-only preview. It does not select recipients, schedule a
        campaign, or send a message. Empty URLs use safe campaign merge tags.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {[...BRAND_TEXT_FIELDS, ...BRAND_URL_FIELDS].map((field) => {
          const url = field.key === "HomepageURL" || field.key === "UnsubscribeURL";
          const inputId = `${baseId}-${field.key}`;
          return (
            <div key={field.key} className="grid gap-1.5">
              <Label htmlFor={inputId}>{field.label}</Label>
              <Input
                id={inputId}
                type={url ? "url" : "text"}
                inputMode={url ? "url" : undefined}
                autoCapitalize={url ? "none" : undefined}
                spellCheck={url ? false : undefined}
                value={brand[field.key] ?? ""}
                disabled={!canManage || preview.isPending}
                aria-invalid={invalid?.field === field.key ? true : undefined}
                aria-describedby={describedBy(field.key)}
                onChange={(event) => {
                  const value = event.target.value;
                  touch();
                  setBrand((current) => ({ ...current, [field.key]: value }));
                }}
              />
            </div>
          );
        })}
        <div className="grid gap-1.5">
          <Label htmlFor={toneId}>Tone</Label>
          <Select
            id={toneId}
            value={tone}
            disabled={!canManage || preview.isPending}
            onChange={(event) => {
              touch();
              setTone(event.target.value as SunsetTone);
            }}
          >
            {SUNSET_TONES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={variantId}>Template variant</Label>
          <Select
            id={variantId}
            value={variant}
            disabled={!canManage || preview.isPending}
            onChange={(event) => {
              touch();
              setVariant(event.target.value as SunsetTemplateVariant);
            }}
          >
            {SUNSET_TEMPLATE_VARIANTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!canManage || preview.isPending}
          aria-describedby={!canManage ? reasonId : undefined}
          onClick={generate}
        >
          {preview.isPending ? "Generating…" : "Generate preview"}
        </Button>
      </div>
      {invalid ? (
        <p id={errorId} role="alert" className="mt-2 text-sm text-destructive">
          {invalid.message}
        </p>
      ) : preview.isError ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {apiErrorMessage(preview.error, "The preview could not be generated.")}
        </p>
      ) : null}
      {template ? (
        <div
          className="mt-3 grid gap-2 rounded-md border p-3 text-sm"
          data-testid="sunset-preview-result"
        >
          <p>
            <span className="text-muted-foreground">Subject:</span>{" "}
            <strong>{template.subject}</strong>
          </p>
          <p>
            <span className="text-muted-foreground">Preheader:</span>{" "}
            {template.preheader}
          </p>
          <pre className="whitespace-pre-wrap rounded bg-muted/40 p-2 font-sans text-sm">
            {template.bodyText}
          </pre>
          <p>
            <span className="text-muted-foreground">Primary CTA:</span>{" "}
            {template.primaryCta}
          </p>
          <p className="text-xs text-muted-foreground">
            Variant: {template.variant}. This preview is not linked to a live
            recipient count or an execution plan.
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="justify-self-start"
            aria-expanded={showHtml}
            aria-controls={htmlId}
            onClick={() => setShowHtml((open) => !open)}
          >
            {showHtml ? "Hide HTML source" : "Show HTML source"}
          </Button>
          <pre
            id={htmlId}
            hidden={!showHtml}
            tabIndex={0}
            aria-label="Generated HTML source"
            className="max-h-56 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {template.bodyHtml}
          </pre>
        </div>
      ) : null}
    </details>
  );
}
