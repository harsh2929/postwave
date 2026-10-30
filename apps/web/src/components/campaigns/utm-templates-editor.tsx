// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * UTM templates editor (desktop UTMTemplatesView parity).
 *
 * List the workspace default and every campaign override, load one into the
 * form, save the form as the workspace default — or, when mounted for one
 * campaign, as that campaign's override — delete a template, and preview how
 * the server would rewrite a link.
 *
 * Writes are owner/admin only (ScopeAdmin on the server) and re-check the
 * caller's authority immediately before sending; editors can preview; every
 * signed-in role can read the list. A preview always uses the SAVED
 * templates, never the unsaved fields, and says which template it applied.
 */
import { useId, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Trash2 } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import { canWriteCampaigns } from "@/lib/campaign-write-authority";
import { base, STALE } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";
import { roleCanWrite } from "@/lib/use-admin-gate";
import {
  deleteUtmTemplate,
  EMPTY_UTM_PARAMS,
  listUtmTemplateRecords,
  paramsFromTemplate,
  previewUtmTemplate,
  saveCampaignUtmOverride,
  saveDefaultUtmTemplate,
  UTM_PARAM_KEYS,
  UTM_PARAM_PLACEHOLDERS,
  validateUtmParams,
  validateUtmPreviewUrl,
  type UtmParamKey,
  type UtmParams,
  type UtmPreviewResult,
  type UtmTemplateRecord,
} from "@/lib/utm-templates-api";

const DEFAULT_PREVIEW_URL = "https://example.com/launch";

type SaveTarget = "default" | "campaign";

function summary(template: UtmParams): string {
  const parts = UTM_PARAM_KEYS.flatMap((key) =>
    template[key] ? [`${key}=${template[key]}`] : [],
  );
  return parts.length ? parts.join(" · ") : "(no parameters)";
}

function deleteConsequence(
  template: UtmTemplateRecord,
  campaignId: string | undefined,
): string {
  if (template.isDefault) {
    return "Future sends without their own override will stop getting these UTM parameters. Links already sent are not changed.";
  }
  return template.campaignId === campaignId
    ? "This campaign will fall back to the workspace default template, or to untagged links if there is none. Links already sent are not changed."
    : "That campaign will fall back to the workspace default template, or to untagged links if there is none. Links already sent are not changed.";
}

export function UtmTemplatesEditor({
  identity,
  campaignId,
}: {
  /** The page's own whoami snapshot; writes re-check it before sending. */
  identity: MeResponse | null;
  /** When set, the editor can save and preview this campaign's override. */
  campaignId?: string;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const role = identity ? effectiveAuthRole(identity) : null;
  const viewerMode = identity?.viewer_mode === true;
  const canAdmin = Boolean(identity) && !viewerMode && roleCanWrite(role);
  const canPreview = canWriteCampaigns(identity);
  const adminReason = viewerMode
    ? "This session is in viewer mode, so UTM templates are read-only."
    : "Saving or deleting UTM templates needs an owner or admin role.";

  const listKey = useMemo(
    () => base("utm-templates", identity?.tenant_id ?? "pending", role),
    [identity?.tenant_id, role],
  );
  const templates = useQuery({
    queryKey: listKey,
    queryFn: ({ signal }) => listUtmTemplateRecords(signal),
    staleTime: STALE.reference,
    enabled: identity !== null,
  });

  const [form, setForm] = useState<UtmParams>({ ...EMPTY_UTM_PARAMS });
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UtmTemplateRecord | null>(
    null,
  );
  const [previewUrl, setPreviewUrl] = useState(DEFAULT_PREVIEW_URL);
  const [preview, setPreview] = useState<UtmPreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async ({
      target,
      params,
    }: {
      target: SaveTarget;
      params: UtmParams;
    }) => {
      if (!identity) throw new Error("Workspace access is still loading.");
      await verifyFreshAdminAuthority(identity);
      return target === "campaign" && campaignId
        ? saveCampaignUtmOverride(campaignId, params)
        : saveDefaultUtmTemplate(params);
    },
    onSuccess: (receipt, { target, params }) => {
      setFormError(null);
      // Describe what was sent (trimmed), not the raw keystrokes.
      setSaved(
        target === "campaign"
          ? `Saved as this campaign's override: ${summary(params)}.`
          : `Saved as the workspace default: ${summary(params)}.`,
      );
      // A saved template changes what the next preview resolves to.
      setPreview(null);
      queryClient.setQueryData<UtmTemplateRecord[]>(listKey, (current = []) => {
        const previous = current.find((row) => row.id === receipt.id);
        const savedRow: UtmTemplateRecord = {
          ...EMPTY_UTM_PARAMS,
          ...params,
          id: receipt.id,
          campaignId: target === "campaign" ? (campaignId ?? "") : "",
          isDefault: target === "default",
          enabled: previous?.enabled ?? true,
          updatedAt: "",
        };
        return [...current.filter((row) => row.id !== receipt.id), savedRow];
      });
      void queryClient.invalidateQueries({ queryKey: listKey });
    },
    onError: (error) => {
      setSaved(null);
      setFormError(
        apiErrorMessage(error, "The UTM template could not be saved."),
      );
    },
  });

  const runPreview = useMutation({
    mutationFn: (url: string) => previewUtmTemplate({ url, campaignId }),
    onSuccess: (result) => {
      setPreviewError(null);
      setPreview(result);
    },
    onError: (error) => {
      setPreview(null);
      setPreviewError(
        apiErrorMessage(error, "The preview could not be generated."),
      );
    },
  });

  async function confirmDelete(): Promise<void> {
    const target = deleteTarget;
    if (!target || !identity) return;
    try {
      await verifyFreshAdminAuthority(identity);
      await deleteUtmTemplate(target.id);
    } catch (error) {
      // ConfirmDialog renders this sentence inside the still-open dialog.
      throw new Error(
        apiErrorMessage(error, "The UTM template could not be deleted."),
      );
    }
    setSaved(
      target.isDefault
        ? "Deleted the workspace default template."
        : "Deleted the campaign override.",
    );
    setPreview(null);
    void queryClient.invalidateQueries({ queryKey: listKey });
  }

  function edit(key: UtmParamKey, value: string) {
    setSaved(null);
    setFormError(null);
    setForm((current) => ({ ...current, [key]: value }));
  }

  function submit(target: SaveTarget) {
    if (!canAdmin || save.isPending) return;
    const validation = validateUtmParams(form);
    if (!validation.ok) {
      setSaved(null);
      setFormError(validation.error);
      return;
    }
    save.mutate({
      target,
      params: { ...EMPTY_UTM_PARAMS, ...validation.input },
    });
  }

  function submitPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canPreview || runPreview.isPending) return;
    const checked = validateUtmPreviewUrl(previewUrl);
    if (!checked.ok) {
      setPreview(null);
      setPreviewError(checked.error);
      return;
    }
    runPreview.mutate(checked.url);
  }

  const rows = Array.isArray(templates.data) ? templates.data : [];
  const ownOverride = campaignId
    ? rows.find((row) => row.campaignId === campaignId)
    : undefined;

  return (
    <div className="space-y-6" data-testid="utm-templates-editor">
      <Alert>
        <AlertDescription>
          These templates are saved configuration for preview. Template delivery
          is not connected in this build. To tag links in a send, set the UTM
          values and enable Google Analytics tags in the campaign editor’s
          Tracking section.
        </AlertDescription>
      </Alert>
      <section aria-labelledby={`${id}-list`} className="space-y-3">
        <h3 id={`${id}-list`} className="text-sm font-semibold">
          Saved templates
        </h3>
        {campaignId ? (
          <p className="text-sm text-muted-foreground">
            {ownOverride
              ? "This campaign has a saved override for template previews."
              : "No override configuration is saved for this campaign."}
          </p>
        ) : null}
        {templates.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading UTM templates…
          </p>
        ) : templates.isError ? (
          <div
            role="alert"
            className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 sm:flex-row sm:items-start"
          >
            <p className="min-w-0 flex-1 text-sm">
              UTM templates could not be loaded. This is not a confirmed empty
              configuration.{" "}
              {apiErrorMessage(templates.error, "The request failed.")}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={templates.isFetching}
              onClick={() => void templates.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            No UTM templates are saved. Links are sent without UTM parameters
            unless a campaign sets its own tracking values.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border" aria-label="UTM templates">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {row.isDefault
                      ? "Workspace default"
                      : row.campaignId === campaignId
                        ? "This campaign's override"
                        : "Campaign override"}
                    {!row.enabled ? (
                      <Badge variant="outline">Disabled</Badge>
                    ) : null}
                  </p>
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                    {summary(row)}
                  </p>
                  {!row.isDefault && row.campaignId !== campaignId ? (
                    <Link
                      className="mt-1 inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
                      href={asRoute(
                        `/app/campaigns/${encodeURIComponent(row.campaignId)}/utm`,
                      )}
                    >
                      <Link2 className="size-3" aria-hidden />
                      Open that campaign&apos;s UTM settings
                    </Link>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setSaved(null);
                      setFormError(null);
                      setForm(paramsFromTemplate(row));
                    }}
                  >
                    Load into form
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!canAdmin}
                    title={canAdmin ? undefined : adminReason}
                    aria-label={`Delete ${row.isDefault ? "the workspace default" : "this campaign override"} (${summary(row)})`}
                    onClick={() => canAdmin && setDeleteTarget(row)}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby={`${id}-form`} className="space-y-3">
        <h3 id={`${id}-form`} className="text-sm font-semibold">
          Template parameters
        </h3>
        <p className="text-xs text-muted-foreground">
          The preview appends missing parameters to absolute web links; a value
          already on a link is never overwritten. Tokens:{" "}
          <code>{"{{campaign_name}}"}</code>, <code>{"{{campaign_slug}}"}</code>
          , <code>{"{{date}}"}</code>.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {UTM_PARAM_KEYS.map((key) => (
            <div key={key} className="grid gap-1.5">
              <Label htmlFor={`${id}-${key}`}>{key}</Label>
              <Input
                id={`${id}-${key}`}
                value={form[key]}
                placeholder={UTM_PARAM_PLACEHOLDERS[key] || undefined}
                autoComplete="off"
                spellCheck={false}
                maxLength={256}
                disabled={!canAdmin || save.isPending}
                onChange={(event) => edit(key, event.target.value)}
              />
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            loading={save.isPending && save.variables?.target === "default"}
            disabled={!canAdmin || save.isPending}
            aria-describedby={`${id}-save-hint`}
            onClick={() => submit("default")}
          >
            Save as workspace default
          </Button>
          {campaignId ? (
            <Button
              type="button"
              variant="secondary"
              loading={save.isPending && save.variables?.target === "campaign"}
              disabled={!canAdmin || save.isPending}
              aria-describedby={`${id}-save-hint`}
              onClick={() => submit("campaign")}
            >
              Save as this campaign&apos;s override
            </Button>
          ) : null}
          <span
            id={`${id}-save-hint`}
            className="text-xs text-muted-foreground"
          >
            {canAdmin
              ? "Saving replaces the existing template for that target."
              : adminReason}
          </span>
        </div>
        <div aria-live="polite">
          {formError ? (
            <Alert variant="destructive">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : saved ? (
            <p role="status" className="text-sm text-success">
              {saved}
            </p>
          ) : null}
        </div>
      </section>

      <section aria-labelledby={`${id}-preview`} className="space-y-3">
        <h3 id={`${id}-preview`} className="text-sm font-semibold">
          Preview a link
        </h3>
        <form
          noValidate
          className="flex flex-wrap items-end gap-2"
          onSubmit={submitPreview}
        >
          <div className="grid min-w-0 flex-1 gap-1.5">
            <Label htmlFor={`${id}-preview-url`}>Link to preview</Label>
            <Input
              id={`${id}-preview-url`}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={previewUrl}
              disabled={!canPreview}
              onChange={(event) => {
                setPreview(null);
                setPreviewError(null);
                setPreviewUrl(event.target.value);
              }}
            />
          </div>
          <Button
            type="submit"
            variant="outline"
            loading={runPreview.isPending}
            disabled={!canPreview}
          >
            Preview
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          {canPreview
            ? `Uses the saved ${campaignId ? "override or default" : "default"} template — not unsaved fields above.`
            : "Previewing needs an owner, admin, or editor role outside viewer mode."}
        </p>
        <div aria-live="polite">
          {previewError ? (
            <Alert variant="destructive">
              <AlertDescription>{previewError}</AlertDescription>
            </Alert>
          ) : preview ? (
            <div
              className="space-y-1 rounded-lg border p-3 text-sm"
              data-testid="utm-preview-result"
            >
              <p className="font-medium">
                {preview.appliedFrom === "campaign"
                  ? "Applied this campaign's override"
                  : preview.appliedFrom === "default"
                    ? "Applied the workspace default"
                    : "No template applies — the link is sent unchanged"}
              </p>
              <p className="break-all font-mono text-xs">{preview.rewritten}</p>
              {preview.template && preview.rewritten === preview.original ? (
                <p className="text-xs text-muted-foreground">
                  The link already carried every parameter this template sets,
                  so nothing was appended.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={
          deleteTarget?.isDefault
            ? "Delete the workspace default UTM template?"
            : "Delete this campaign's UTM override?"
        }
        description={
          deleteTarget ? deleteConsequence(deleteTarget, campaignId) : ""
        }
        confirmLabel="Delete template"
        onConfirm={confirmDelete}
      />
    </div>
  );
}
