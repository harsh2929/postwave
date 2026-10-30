// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// The three pieces the web CSV import wizard lacked relative to desktop's
// ImportSubscribersWizard: a dedicated consent-evidence step, the preflight
// acknowledgements that gate the commit, and recovery of an import that is
// still running (e.g. after the tab was closed mid-import).

import { useId, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api";
import { base } from "@/lib/query-keys";
import { absoluteTime, timeAgo } from "@/lib/relative-time";
import { pluralizeCount } from "@/lib/pluralize";
import {
  buildImportConsentPatch,
  cancelImport,
  discardImportPreview,
  emptyImportConsentDraft,
  IMPORT_CONSENT_CONFIRMATION,
  IMPORT_CONSENT_SOURCES,
  isDraftImport,
  isInFlightImport,
  isNotAPreviewError,
  listSubscriberImports,
  patchImportConsent,
  validateImportConsentDraft,
  type DryRunResults,
  type ImportAcknowledgements,
  type ImportConsentDraft,
  type ImportConsentField,
  type ImportSummary,
} from "@/lib/subscriber-imports-api";

import { useDirectoryIdentity } from "./directory-context";

/* --------------------------- Consent evidence ----------------------------- */

/**
 * Step between Map and Review. "No proof" keeps every imported row
 * unconfirmed; "verified" records the first-party proof on the import (PATCH,
 * under the configuration revision) so its rows may land sendable. Either
 * choice is persisted before the preflight runs, so the preflight judges the
 * contract the operator actually chose.
 */
export function ImportConsentEvidenceStep({
  importId,
  revision,
  busy,
  onSaved,
  onBack,
}: {
  importId: string;
  revision: number;
  busy?: boolean;
  onSaved: (next: { revision: number; mode: ImportConsentDraft["mode"] }) => void;
  onBack?: () => void;
}) {
  const prefix = useId();
  const id = (name: string) => `${prefix}-${name}`;
  const [draft, setDraft] = useState<ImportConsentDraft>(emptyImportConsentDraft);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errors = validateImportConsentDraft(draft);
  const set = <K extends keyof ImportConsentDraft>(key: K, value: ImportConsentDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const fieldError = (field: ImportConsentField) =>
    touched && errors[field] ? (
      <p id={id(`${field}-error`)} className="text-xs text-destructive">
        {errors[field]}
      </p>
    ) : null;
  const described = (field: ImportConsentField) =>
    touched && errors[field] ? id(`${field}-error`) : undefined;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    const patch = buildImportConsentPatch(draft);
    if (!patch || saving || busy) return;
    setSaving(true);
    setError(null);
    try {
      const result = await patchImportConsent(importId, revision, patch);
      onSaved({ revision: result.configuration_revision, mode: draft.mode });
    } catch (err) {
      setError(apiErrorMessage(err, "Could not save the consent evidence."));
    } finally {
      setSaving(false);
    }
  };

  const disabled = saving || busy;
  const verified = draft.mode === "verified";

  return (
    <form className="grid gap-4 rounded-md border p-4" onSubmit={submit} noValidate>
      <fieldset className="grid gap-2" disabled={disabled}>
        <legend className="text-sm font-medium">Consent evidence for these contacts</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name={id("mode")}
            className="mt-0.5 h-4 w-4 accent-primary"
            checked={!verified}
            onChange={() => setDraft({ ...emptyImportConsentDraft(), mode: "none" })}
          />
          <span>
            <strong>No consent proof.</strong> New contacts are imported as
            unconfirmed and are not sendable until each one confirms.
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name={id("mode")}
            className="mt-0.5 h-4 w-4 accent-primary"
            checked={verified}
            onChange={() => set("mode", "verified")}
          />
          <span>
            <strong>I hold first-party email-marketing consent</strong> for
            every address in this file and can cite the record.
          </span>
        </label>
      </fieldset>

      {verified ? (
        <fieldset className="grid gap-3" disabled={disabled}>
          <legend className="sr-only">Consent proof</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor={id("source")}>Proof type</Label>
              <Select
                id={id("source")}
                value={draft.source}
                aria-invalid={Boolean(touched && errors.source)}
                aria-describedby={described("source")}
                onChange={(event) =>
                  set("source", event.target.value as ImportConsentDraft["source"])
                }
              >
                <option value="">Choose the record…</option>
                {IMPORT_CONSENT_SOURCES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
              {fieldError("source")}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={id("captured")}>Captured at</Label>
              <Input
                id={id("captured")}
                type="datetime-local"
                value={draft.capturedAt}
                aria-invalid={Boolean(touched && errors.capturedAt)}
                aria-describedby={described("capturedAt")}
                onChange={(event) => set("capturedAt", event.target.value)}
              />
              {fieldError("capturedAt")}
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor={id("url")}>Evidence URL (HTTPS)</Label>
              <Input
                id={id("url")}
                type="url"
                value={draft.sourceUrl}
                placeholder="https://forms.example.com/consent/export-2026-09"
                aria-invalid={Boolean(touched && errors.sourceUrl)}
                aria-describedby={described("sourceUrl")}
                onChange={(event) => set("sourceUrl", event.target.value)}
              />
              {fieldError("sourceUrl")}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={id("jurisdiction")}>Jurisdiction</Label>
              <Input
                id={id("jurisdiction")}
                value={draft.jurisdiction}
                maxLength={32}
                placeholder="GB, EU, US-CA"
                aria-invalid={Boolean(touched && errors.jurisdiction)}
                aria-describedby={described("jurisdiction")}
                onChange={(event) => set("jurisdiction", event.target.value.toUpperCase())}
              />
              {fieldError("jurisdiction")}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={id("policy")}>Policy version</Label>
              <Input
                id={id("policy")}
                value={draft.policyVersion}
                maxLength={100}
                aria-invalid={Boolean(touched && errors.policyVersion)}
                aria-describedby={described("policyVersion")}
                onChange={(event) => set("policyVersion", event.target.value)}
              />
              {fieldError("policyVersion")}
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor={id("reference")}>Evidence reference</Label>
              <Input
                id={id("reference")}
                value={draft.evidenceReference}
                maxLength={288}
                placeholder="receipt:CONSENT-123"
                aria-invalid={Boolean(touched && errors.evidenceReference)}
                aria-describedby={described("evidenceReference")}
                onChange={(event) => set("evidenceReference", event.target.value)}
              />
              {fieldError("evidenceReference")}
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor={id("reason")}>Audit reason</Label>
              <Textarea
                id={id("reason")}
                value={draft.reason}
                maxLength={500}
                rows={2}
                aria-invalid={Boolean(touched && errors.reason)}
                aria-describedby={described("reason")}
                onChange={(event) => set("reason", event.target.value)}
              />
              {fieldError("reason")}
            </div>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-primary"
              checked={draft.scopeAcknowledged}
              aria-describedby={described("scopeAcknowledged")}
              onChange={(event) => set("scopeAcknowledged", event.target.checked)}
            />
            <span>This proof covers email marketing only — not SMS, push or profiling.</span>
          </label>
          {fieldError("scopeAcknowledged")}
          <div className="grid gap-1.5">
            <Label htmlFor={id("typed")}>
              Type <span className="font-mono">{IMPORT_CONSENT_CONFIRMATION}</span> to confirm the scope
            </Label>
            <Input
              id={id("typed")}
              value={draft.typedConfirmation}
              autoComplete="off"
              aria-invalid={Boolean(touched && errors.typedConfirmation)}
              aria-describedby={described("typedConfirmation")}
              onChange={(event) => set("typedConfirmation", event.target.value)}
            />
            {fieldError("typedConfirmation")}
          </div>
        </fieldset>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-between gap-2">
        {onBack ? (
          <Button type="button" variant="ghost" disabled={disabled} onClick={onBack}>
            Back
          </Button>
        ) : (
          <span />
        )}
        <Button type="submit" disabled={disabled}>
          {saving ? "Saving…" : verified ? "Save proof & run preflight" : "Continue without proof"}
        </Button>
      </div>
    </form>
  );
}

/* ------------------------- Preflight acknowledgements --------------------- */

/**
 * The two checkboxes that stand between the authoritative preflight and the
 * commit: the operator reviewed the outcome, and (when rows will fail) accepts
 * that those rows will not be imported. Client-side only — `/confirm` takes no
 * acknowledgement fields.
 */
export function ImportPreflightAcknowledgements({
  dryRun,
  value,
  onChange,
  disabled,
}: {
  dryRun: Pick<DryRunResults, "would_create" | "would_update" | "would_skip" | "would_fail">;
  value: ImportAcknowledgements;
  onChange: (next: ImportAcknowledgements) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="grid gap-2 rounded-md border p-3 text-sm" disabled={disabled}>
      <legend className="px-1 text-sm font-medium">Before you queue this import</legend>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-primary"
          checked={value.queue}
          onChange={(event) => onChange({ ...value, queue: event.target.checked })}
        />
        <span>
          I reviewed the preflight: {dryRun.would_create.toLocaleString()} to create,{" "}
          {dryRun.would_update.toLocaleString()} to update,{" "}
          {dryRun.would_skip.toLocaleString()} to skip. Queue it.
        </span>
      </label>
      {dryRun.would_fail > 0 ? (
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-primary"
            checked={value.failures}
            onChange={(event) => onChange({ ...value, failures: event.target.checked })}
          />
          <span>
            {dryRun.would_fail.toLocaleString()} row{dryRun.would_fail === 1 ? "" : "s"} will
            fail and will not be imported. I will fix them from the error report.
          </span>
        </label>
      ) : null}
    </fieldset>
  );
}

/* --------------------------- In-flight recovery --------------------------- */

/** How an import is named to a person: its file, never its id. */
function importFileLabel(item: Pick<ImportSummary, "filename">): string {
  return item.filename.trim() || "an untitled file";
}

/**
 * Imports still queued or running, with their progress and a cancel, and
 * uploads that were previewed but never imported, with a discard. Lets an
 * operator who left the wizard mid-import find it again, and remove an
 * abandoned upload's file now rather than when it expires. Admin only (the
 * list route is `admin`-scoped); renders nothing for other roles.
 */
export function InFlightImportRecovery({
  onResume,
}: {
  /** Re-attach the wizard's progress view to this import. */
  onResume?: (importId: string) => void;
}) {
  const identity = useDirectoryIdentity();
  const queryClient = useQueryClient();
  const key = base("subscriber-imports", identity.tenantId, identity.role);
  const imports = useQuery({
    queryKey: key,
    queryFn: () => listSubscriberImports(20),
    enabled: identity.ready && identity.canAdmin,
    refetchInterval: (query) =>
      (Array.isArray(query.state.data) ? query.state.data : []).some((item) => isInFlightImport(item.status)) ? 3_000 : false,
  });
  if (!identity.canAdmin) return null;
  const all = Array.isArray(imports.data) ? imports.data : [];
  const inFlight = all.filter((item) => isInFlightImport(item.status));
  const drafts = all.filter((item) => isDraftImport(item.status));
  if (imports.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {apiErrorMessage(imports.error, "Could not check for imports in progress.")}
      </p>
    );
  }
  if (inFlight.length === 0 && drafts.length === 0) return null;
  return (
    <>
      {inFlight.length > 0 ? (
        <section
          aria-label="Imports in progress"
          className="grid gap-2 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm"
        >
          <h2 className="font-medium">
            {inFlight.length === 1 ? "An import is still running" : `${inFlight.length} imports are still running`}
          </h2>
          <ul className="grid gap-2">
            {inFlight.map((item) => {
              const pct =
                item.rows_total > 0
                  ? Math.min(100, Math.round((item.processed_rows / item.rows_total) * 100))
                  : 0;
              return (
                <li key={item.id} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">
                    {importFileLabel(item)} · {item.status} ·{" "}
                    {item.processed_rows.toLocaleString()} of{" "}
                    {pluralizeCount(item.rows_total, "row")} ({pct}%)
                    {item.cancel_requested ? " · cancelling" : ""}
                  </span>
                  {onResume ? (
                    <Button type="button" size="sm" variant="outline" onClick={() => onResume(item.id)}>
                      Show progress
                    </Button>
                  ) : null}
                  {!item.cancel_requested ? (
                    <ConfirmDialog
                      title={`Cancel importing ${item.filename.trim() || "this file"}?`}
                      description="Rows already imported stay imported; the remaining rows are not processed. You can re-upload the file later."
                      confirmLabel="Cancel import"
                      confirmVariant="destructive"
                      onConfirm={async () => {
                        try {
                          await cancelImport(item.id);
                          toast.message("Cancelling import…");
                          await queryClient.invalidateQueries({ queryKey: key });
                        } catch (error) {
                          toast.error(apiErrorMessage(error, "Could not cancel the import."));
                          throw error;
                        }
                      }}
                      trigger={
                        <Button type="button" size="sm" variant="ghost">
                          Cancel…
                        </Button>
                      }
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {drafts.length > 0 ? (
        <section
          aria-label="Unfinished uploads"
          className="grid gap-2 rounded-md border bg-muted/30 p-3 text-sm"
        >
          <h2 className="font-medium">
            {drafts.length === 1
              ? "An upload was never imported"
              : `${drafts.length} uploads were never imported`}
          </h2>
          <p className="text-muted-foreground">
            An unfinished upload can&apos;t be picked up again. Discard it to delete
            the file now; otherwise it&apos;s deleted automatically a day after it
            was uploaded.
          </p>
          <ul className="grid gap-2">
            {drafts.map((item) => {
              const uploaded = timeAgo(item.created_at);
              return (
                <li key={item.id} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">
                    {importFileLabel(item)}
                    {uploaded ? (
                      <>
                        {" · uploaded "}
                        <time dateTime={item.created_at} title={absoluteTime(item.created_at)}>
                          {uploaded}
                        </time>
                      </>
                    ) : null}
                  </span>
                  <ConfirmDialog
                    title={`Discard ${item.filename.trim() || "this upload"}?`}
                    description="The uploaded file and its column choices are deleted. Nothing was imported from it."
                    confirmLabel="Discard upload"
                    confirmVariant="destructive"
                    onConfirm={async () => {
                      try {
                        await discardImportPreview(item.id);
                        toast.success("Upload discarded.");
                      } catch (error) {
                        if (!isNotAPreviewError(error)) {
                          toast.error(apiErrorMessage(error, "Could not discard the upload."));
                          throw error;
                        }
                        // Confirmed in another tab, or already discarded: it
                        // is left exactly as it is.
                        toast.message("This upload wasn't discarded", {
                          description: "It has already started importing, or it was discarded somewhere else.",
                        });
                      }
                      await queryClient.invalidateQueries({ queryKey: key });
                    }}
                    trigger={
                      <Button type="button" size="sm" variant="ghost">
                        Discard…
                      </Button>
                    }
                  />
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </>
  );
}
