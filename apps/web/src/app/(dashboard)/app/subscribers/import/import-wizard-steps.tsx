// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// The import wizard's later steps: map columns -> preflight review -> running
// -> result. page.tsx loads this module with next/dynamic once a preview
// exists, so the upload step paints without the review table, the progress
// bar, or the errored-row CSV tooling in its initial JavaScript.

import Link from "next/link";
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Download,
  RotateCcw,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Progress } from "@/components/ui/progress";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ImportPreflightAcknowledgements } from "@/components/subscribers/CsvImportWizardSteps";
import {
  ImportTargetListStep,
  type ImportTargetList,
} from "./import-target-list";
import { useDirectoryIdentity } from "@/components/subscribers/directory-context";
import { downloadTextFile } from "@/lib/download";
import { toCsv } from "@/lib/analytics-format";
import { pluralizeCount } from "@/lib/pluralize";
import { base } from "@/lib/query-keys";
import type { CustomFieldsValidatorMode } from "@/lib/custom-fields-api";
import { describeSubscriberRowError } from "@/lib/subscriber-row-errors";
import {
  customFieldKeyOf,
  customFieldMappingProblem,
  importAcknowledgementProblem,
  importRowErrorsCsvUrl,
  isValidCustomFieldKey,
  listImportRowErrors,
  suggestCustomFieldKey,
  undeclaredCustomFieldKeys,
  type DryRunResults,
  type ImportAcknowledgements,
  type ImportColumnMapping,
  type ImportConsentDraft,
  type ImportFieldKind,
  type ImportPreview,
  type ImportState,
  type RemapOptions,
} from "@/lib/subscriber-imports-api";

const RESULT_PAGE = 50;
/** How many recorded row failures the result screen lists before the CSV. */
const ROW_ERROR_PREVIEW = 20;

const CUSTOM_FIELD_TYPE_LABELS: Record<string, string> = {
  string: "Text",
  number: "Number",
  boolean: "Yes / no",
  date: "Date",
  enum: "Choice",
  array: "List",
  object: "Group",
  email: "Email",
  url: "Web address",
  phone: "Phone",
  region: "Region",
};

function listOfKeys(keys: readonly string[]): string {
  return keys.join(", ");
}

export type ConsentMode = ImportConsentDraft["mode"];

/* --------------------------------- Map ------------------------------------ */
const FALLBACK_KINDS: { kind: ImportFieldKind; label: string }[] = [
  { kind: "email", label: "Email (required)" },
  { kind: "name", label: "Full name" },
  { kind: "first_name", label: "First name" },
  { kind: "last_name", label: "Last name" },
  { kind: "tags", label: "Tags" },
  { kind: "custom", label: "Custom field" },
  { kind: "ignore", label: "Skip this column" },
];

export function MapStep({
  preview,
  remap,
  columns,
  onColumns,
  onExisting,
  onOnExisting,
  customFieldsMode: mode,
  autoCreate,
  onAutoCreate,
  onRecheckFields,
  recheckingFields = false,
  targetList,
  onTargetList,
  busy,
  onBack,
  onNext,
}: {
  preview: ImportPreview;
  remap: RemapOptions | null;
  columns: ImportColumnMapping[];
  onColumns: (cols: ImportColumnMapping[]) => void;
  onExisting: "skip" | "update" | "error";
  onOnExisting: (v: "skip" | "update" | "error") => void;
  /** The workspace's Settings › Custom fields mode; null when it couldn't be read. */
  customFieldsMode: CustomFieldsValidatorMode | null;
  /** "Create new custom fields" — only offered when the workspace mode is auto. */
  autoCreate: boolean;
  onAutoCreate: (next: boolean) => void;
  /** Re-read the workspace's declared custom fields, e.g. after defining one in Settings. */
  onRecheckFields?: () => void;
  recheckingFields?: boolean;
  /** The list imported contacts will join, or null for none. */
  targetList: ImportTargetList | null;
  onTargetList: (next: ImportTargetList | null) => void;
  busy: boolean;
  onBack: () => void;
  onNext: () => void;
}) {
  const kinds = remap?.merge_fields?.length
    ? (remap.merge_fields as { kind: ImportFieldKind; label: string }[])
    : FALLBACK_KINDS;
  const hasEmail = columns.some((c) => c.kind === "email");
  const declared = Array.isArray(remap?.custom_fields) ? remap.custom_fields : [];
  const declaredByKey = new Map(declared.map((field) => [field.key, field]));
  const newKeys = undeclaredCustomFieldKeys(columns, declared);
  const mappingProblem = customFieldMappingProblem(columns);
  const fieldListId = useId();

  const setKind = (index: number, kind: ImportFieldKind) =>
    onColumns(
      columns.map((c) => {
        if (c.index !== index) return c;
        // A column switched to custom starts with a valid key from its header.
        if (kind === "custom" && !isValidCustomFieldKey(customFieldKeyOf(c))) {
          return { ...c, kind, custom_key: suggestCustomFieldKey(c.name, c.index) };
        }
        return { ...c, kind };
      }),
    );
  const setCustomKey = (index: number, custom_key: string) =>
    onColumns(
      columns.map((c) => (c.index === index ? { ...c, custom_key } : c)),
    );

  return (
    <div className="space-y-4">
      <div className="rounded-md border bg-card">
        <div className="border-b p-3 text-sm font-medium">
          Map {pluralizeCount(columns.length, "column")} ·{" "}
          {pluralizeCount(preview.rows_total, "row")} (
          {preview.rows_new.toLocaleString()} new,{" "}
          {preview.rows_existing.toLocaleString()} existing)
        </div>
        <div className="divide-y">
          {columns.map((col) => {
            const key = customFieldKeyOf(col);
            const keyValid = isValidCustomFieldKey(key);
            const existing = keyValid ? declaredByKey.get(key) : undefined;
            const hintId = `${fieldListId}-hint-${col.index}`;
            return (
              <div
                key={col.index}
                className="flex flex-wrap items-center gap-3 p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium">
                    {col.name || `Column ${col.index + 1}`}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    e.g. {String(preview.sample_rows[0]?.[col.name] ?? "—")}
                  </div>
                </div>
                <Select
                  aria-label={`Map column ${col.name}`}
                  className="w-full sm:w-48"
                  value={col.kind}
                  onChange={(e) =>
                    setKind(col.index, e.target.value as ImportFieldKind)
                  }
                >
                  {kinds.map((k) => (
                    <option key={k.kind} value={k.kind}>
                      {k.label}
                    </option>
                  ))}
                </Select>
                {col.kind === "custom" ? (
                  <div className="grid w-full gap-1 sm:w-44">
                    <input
                      aria-label={`Custom field key for ${col.name}`}
                      aria-describedby={hintId}
                      aria-invalid={!keyValid || undefined}
                      list={declared.length > 0 ? fieldListId : undefined}
                      value={col.custom_key ?? ""}
                      onChange={(e) => setCustomKey(col.index, e.target.value)}
                      placeholder="custom_key"
                      autoCapitalize="off"
                      spellCheck={false}
                      className="h-11 w-full rounded-md border border-input bg-transparent px-3 text-base aria-[invalid=true]:border-destructive sm:h-9 sm:text-sm"
                    />
                    <p
                      id={hintId}
                      className={`text-xs ${keyValid ? "text-muted-foreground" : "text-destructive"}`}
                    >
                      {!keyValid
                        ? "Use a–z, 0–9 and _, starting with a letter."
                        : existing
                          ? `Existing field · ${CUSTOM_FIELD_TYPE_LABELS[existing.type] ?? existing.type}`
                          : "New field"}
                    </p>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        {declared.length > 0 ? (
          <datalist id={fieldListId}>
            {declared.map((field) => (
              <option key={field.key} value={field.key}>
                {field.label}
              </option>
            ))}
          </datalist>
        ) : null}
      </div>

      {newKeys.length > 0 ? (
        <NewCustomFieldsNotice
          mode={mode}
          keys={newKeys}
          autoCreate={autoCreate}
          onAutoCreate={onAutoCreate}
          onRecheck={onRecheckFields}
          rechecking={recheckingFields}
          disabled={busy}
        />
      ) : null}

      {!hasEmail ? (
        <p className="flex items-center gap-1.5 text-sm text-warning-emphasis">
          <AlertTriangle className="h-4 w-4" />
          Map one column to Email to continue.
        </p>
      ) : null}
      {mappingProblem ? (
        <p role="alert" className="flex items-start gap-1.5 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {mappingProblem}
        </p>
      ) : null}

      <ImportTargetListStep
        value={targetList}
        onChange={onTargetList}
        disabled={busy}
      />

      <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
        <label
          htmlFor="existing-contact-policy"
          className="text-sm text-muted-foreground"
        >
          When a contact already exists
        </label>
        <Select
          id="existing-contact-policy"
          aria-label="When a contact already exists"
          className="w-full sm:w-40"
          value={onExisting}
          onChange={(e) =>
            onOnExisting(e.target.value as "skip" | "update" | "error")
          }
        >
          <option value="skip">Skip</option>
          <option value="update">Update</option>
          <option value="error">Error</option>
        </Select>
      </div>

      <div className="flex flex-wrap justify-between gap-2">
        <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button
          type="button"
          onClick={onNext}
          disabled={busy || !hasEmail || Boolean(mappingProblem)}
        >
          {busy ? "Saving…" : "Continue to consent"}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

/**
 * What happens to mapped custom fields the workspace hasn't defined, per its
 * Settings › Custom fields mode — decided before the preflight, not
 * discovered as a wall of failed rows at Review.
 */
function NewCustomFieldsNotice({
  mode,
  keys,
  autoCreate,
  onAutoCreate,
  onRecheck,
  rechecking = false,
  disabled,
}: {
  mode: CustomFieldsValidatorMode | null;
  keys: string[];
  autoCreate: boolean;
  onAutoCreate: (next: boolean) => void;
  onRecheck?: () => void;
  rechecking?: boolean;
  disabled: boolean;
}) {
  const hintId = useId();
  const count = keys.length;
  const noun = count === 1 ? "custom field" : "custom fields";
  const settingsLink = (
    <Link
      href="/app/settings/custom-fields"
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-primary underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      Settings › Custom fields
      <span className="sr-only"> (opens in a new tab)</span>
    </Link>
  );
  if (mode === "strict") {
    return (
      <div role="note" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
        <label className="flex items-start gap-2 text-muted-foreground">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-primary"
            checked={false}
            disabled
            aria-describedby={hintId}
          />
          <span>
            Create {count} new {noun}: <span className="font-mono">{listOfKeys(keys)}</span>
          </span>
        </label>
        <p id={hintId} className="mt-2">
          This workspace only accepts custom fields defined in {settingsLink}, so
          rows with a value for {count === 1 ? "this field" : "these fields"} won&apos;t
          be imported. Define {count === 1 ? "it" : "them"} there first, or set the
          column to “Skip this column”.
        </p>
        {onRecheck ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={onRecheck}
            disabled={rechecking}
            aria-describedby={hintId}
          >
            {rechecking ? "Checking…" : "Check again"}
          </Button>
        ) : null}
      </div>
    );
  }
  if (mode === "off") {
    return (
      <p role="note" className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
        Custom field checks are turned off for this workspace, so{" "}
        <span className="font-mono">{listOfKeys(keys)}</span> will be stored as text
        exactly as {count === 1 ? "it appears" : "they appear"} in the file, without
        creating {count === 1 ? "a custom field" : "custom fields"}.
      </p>
    );
  }
  if (mode !== "auto") return null;
  return (
    <div className="rounded-md border bg-card p-3 text-sm">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-primary"
          checked={autoCreate}
          disabled={disabled}
          onChange={(event) => onAutoCreate(event.target.checked)}
          aria-describedby={hintId}
        />
        <span>
          <span className="font-medium">
            Create {count} new {noun}
          </span>{" "}
          as text: <span className="font-mono">{listOfKeys(keys)}</span>
        </span>
      </label>
      <p id={hintId} className="mt-1 pl-6 text-muted-foreground">
        {autoCreate
          ? `${count === 1 ? "It's" : "They're"} added to Settings › Custom fields when the import runs.`
          : `Rows with a value for ${count === 1 ? "this column" : "these columns"} won't be imported unless the ${count === 1 ? "field exists" : "fields exist"}.`}
      </p>
    </div>
  );
}

/* -------------------------------- Review ---------------------------------- */
export function ReviewStep({
  dryRun,
  busy,
  consentMode,
  acknowledgements,
  onAcknowledgements,
  onBack,
  onCommit,
  onDiscard,
  fieldsToCreate,
}: {
  dryRun: DryRunResults;
  busy: boolean;
  consentMode: ConsentMode;
  acknowledgements: ImportAcknowledgements;
  onAcknowledgements: (next: ImportAcknowledgements) => void;
  onBack: () => void;
  onCommit: () => void;
  /** Abandon this upload: the file and its review data are removed. */
  onDiscard: () => void | Promise<void>;
  /** Mapped custom fields this import creates when it runs. */
  fieldsToCreate: readonly string[];
}) {
  const toCreate = fieldsToCreate;
  const withheld = importAcknowledgementProblem(dryRun, acknowledgements);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [page, setPage] = useState(0);

  const rows = errorsOnly
    ? dryRun.rows.filter((r) => r.outcome === "fail")
    : dryRun.rows;
  const pageRows = rows.slice(
    page * RESULT_PAGE,
    page * RESULT_PAGE + RESULT_PAGE,
  );
  const pages = Math.max(1, Math.ceil(rows.length / RESULT_PAGE));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Tile label="Total" value={dryRun.rows_total} />
        <Tile label="Create" value={dryRun.would_create} tone="success" />
        <Tile label="Update" value={dryRun.would_update} />
        <Tile label="Skip" value={dryRun.would_skip} tone="warning" />
        <Tile label="Fail" value={dryRun.would_fail} tone="destructive" />
      </div>

      <div className="rounded-md border bg-card">
        <div className="flex flex-col items-start justify-between gap-2 border-b p-3 text-sm sm:flex-row sm:items-center">
          <span className="font-medium">
            Row preview
            {dryRun.detail_capped ? " (first 500)" : ""}
          </span>
          <label className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={errorsOnly}
              onChange={(e) => {
                setErrorsOnly(e.target.checked);
                setPage(0);
              }}
              className="h-4 w-4 rounded border-input accent-primary"
            />
            Errors only
          </label>
        </div>
        <div
          role="region"
          aria-label="Import row outcomes"
          tabIndex={0}
          className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 text-left">
                  Row
                </th>
                <th scope="col" className="px-3 py-2 text-left">
                  Outcome
                </th>
                <th scope="col" className="px-3 py-2 text-left">
                  Detail
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {pageRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={3}
                    className="px-3 py-6 text-center text-muted-foreground"
                  >
                    {errorsOnly ? "No errored rows." : "No rows."}
                  </td>
                </tr>
              ) : (
                pageRows.map((r) => (
                  <tr key={r.row_number}>
                    <td className="px-3 py-2 text-muted-foreground">
                      {r.row_number}
                    </td>
                    <td className="px-3 py-2">
                      <OutcomePill outcome={r.outcome} />
                    </td>
                    <td className="px-3 py-2 text-xs text-destructive">
                      {r.error ?? ""}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {pages > 1 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t p-2 text-xs text-muted-foreground">
            <span>
              Page {page + 1} of {pages}
            </span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page >= pages - 1}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {toCreate.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          Custom fields: this import creates {toCreate.length} new text{" "}
          {toCreate.length === 1 ? "field" : "fields"} when it runs —{" "}
          <span className="font-mono text-foreground">{listOfKeys(toCreate)}</span>.
        </p>
      ) : null}

      <p className="text-sm text-muted-foreground">
        {consentMode === "verified"
          ? "Consent: the first-party email-marketing proof you recorded is attached to this import."
          : "Consent: no proof recorded — new contacts are imported as unconfirmed and are not sendable until each one confirms."}
      </p>

      <ImportPreflightAcknowledgements
        dryRun={dryRun}
        value={acknowledgements}
        onChange={onAcknowledgements}
        disabled={busy}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
            Back
          </Button>
          <ConfirmDialog
            title="Discard this upload?"
            description="The file and your column and consent choices are removed. Nothing has been imported."
            confirmLabel="Discard upload"
            confirmVariant="destructive"
            onConfirm={onDiscard}
            trigger={
              <Button type="button" variant="ghost" disabled={busy}>
                Discard upload…
              </Button>
            }
          />
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {withheld ? (
            <span className="text-xs text-muted-foreground">{withheld}</span>
          ) : null}
          <Button
            type="button"
            onClick={onCommit}
            disabled={busy || Boolean(withheld)}
          >
            {busy
              ? "Starting…"
              : `Import ${pluralizeCount(dryRun.would_create + dryRun.would_update, "contact")}`}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- Running --------------------------------- */
export function RunningStep({
  state,
  onCancel,
}: {
  state: ImportState | null;
  onCancel: () => void;
}) {
  const total = state?.rows_total ?? 0;
  const processed = state?.processed_rows ?? 0;
  const pct =
    total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const cancelling = state?.cancel_requested;
  return (
    <div className="space-y-4">
      <div
        role="status"
        aria-live="polite"
        className="rounded-md border bg-card p-4"
      >
        <div className="mb-2 flex flex-wrap items-center justify-between gap-1 text-sm">
          <span className="font-medium">
            {cancelling ? "Cancelling…" : "Importing…"}
          </span>
          <span className="tabular-nums text-muted-foreground">
            {processed.toLocaleString()} / {total.toLocaleString()} ({pct}%)
          </span>
        </div>
        {total > 0 ? (
          <Progress
            value={pct}
            aria-label="Subscriber import progress"
            aria-valuetext={`${processed.toLocaleString()} of ${pluralizeCount(total, "row")} processed`}
          />
        ) : (
          <Skeleton className="h-2 w-full" />
        )}
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="text-success">
            Imported {(state?.rows_imported ?? 0).toLocaleString()}
          </span>
          <span>Skipped {(state?.rows_skipped ?? 0).toLocaleString()}</span>
          <span className="text-destructive">
            Failed {(state?.rows_failed ?? 0).toLocaleString()}
          </span>
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        onClick={onCancel}
        disabled={cancelling}
      >
        {cancelling ? "Cancelling…" : "Cancel import"}
      </Button>
    </div>
  );
}

/* --------------------------------- Done ----------------------------------- */
export function DoneStep({
  state,
  dryRun,
  consentMode,
  targetListName = null,
  onReset,
}: {
  state: ImportState | null;
  dryRun: DryRunResults | null;
  /** The consent choice made in this wizard; null for a resumed import. */
  consentMode: ConsentMode | null;
  /** The list this import added contacts to; null when it named none. */
  targetListName?: string | null;
  onReset: () => void;
}) {
  const status = state?.status ?? "ready";
  // The guard belongs on `rows`: `.filter` on a truthy non-array throws
  // before `?? []` can supply a default.
  const failed = Array.isArray(dryRun?.rows)
    ? dryRun.rows.filter((r) => r.outcome === "fail")
    : [];
  const cancelled = status === "cancelled" || status === "canceled";

  const downloadErrors = () => {
    // JSON.stringify escapes an embedded quote as \" but RFC-4180 requires ""
    // doubling, so a quote in the error text produced a malformed row; and
    // error_code was emitted unquoted. toCsv handles both, plus the
    // spreadsheet formula guard on server-supplied error text.
    downloadTextFile(
      "import-errors.csv",
      `${toCsv([
        ["row_number", "error_code", "error"],
        ...failed.map((r) => [r.row_number, r.error_code ?? "", r.error ?? ""]),
      ])}\r\n`,
      "text/csv",
    );
  };

  return (
    <div className="space-y-4">
      {/* Announce completion to screen readers (SUB-048). */}
      <div
        role="status"
        aria-live="polite"
        className="rounded-md border bg-card p-6 text-center"
      >
        {cancelled ? (
          <>
            <RotateCcw className="mx-auto h-10 w-10 text-muted-foreground" />
            <h2 className="mt-3 font-display text-lg font-semibold">
              Import cancelled
            </h2>
          </>
        ) : status === "failed" ? (
          <>
            <AlertTriangle className="mx-auto h-10 w-10 text-destructive" />
            <h2 className="mt-3 font-display text-lg font-semibold">
              Import failed
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {state?.error ?? "The import did not complete."}
            </p>
          </>
        ) : (
          <>
            <CheckCircle2 className="mx-auto h-10 w-10 text-success" />
            <h2 className="mt-3 font-display text-lg font-semibold">
              Import complete
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Imported {(state?.rows_imported ?? 0).toLocaleString()}, skipped{" "}
              {(state?.rows_skipped ?? 0).toLocaleString()}, failed{" "}
              {(state?.rows_failed ?? 0).toLocaleString()}.
            </p>
            {targetListName ? (
              // Not "every contact in this file": a row that failed validation
              // was never written, so it never joined the list either.
              <p className="mt-1 text-sm text-muted-foreground">
                The contacts this import wrote are now on{" "}
                <span className="font-medium text-foreground">
                  {targetListName}
                </span>
                .
              </p>
            ) : null}
            {/*
              An import with no consent contract lands its rows as
              `unconfirmed` (subscriber_import/options.go
              subscriberStatusAndConsent), and every audience query filters
              `status = 'enabled'` — so those contacts cannot receive a
              campaign. That is the reviewed, fail-closed behaviour, not a bug:
              a CSV proves a list, not a grant.

              The consent step records the grant (patchImportConsent sends the
              full contract on the PATCH); only an import that carries it lands
              rows as `enabled`. So the warning shows whenever this wizard
              saved "no consent proof", rather than let the operator discover
              it at send time. An import resumed from an earlier visit has a
              contract this page never saw, so it makes no claim either way.
            */}
            {consentMode === "none" && (state?.rows_imported ?? 0) > 0 ? (
              <p className="mt-2 text-sm text-warning">
                These contacts are imported as <strong>unconfirmed</strong> and
                are not yet sendable: a CSV records a list, not permission to
                email it. Campaigns only reach confirmed contacts. Record
                consent evidence for them before you send.
              </p>
            ) : null}
            {/*
              "42 failed" without "which 42" is an unanswerable message: the
              rows are in the database until the 30-day prune, and until now
              nothing read them. The CSV is the shape the fix happens in —
              someone opens their spreadsheet, finds those row numbers, and
              corrects them.
            */}
            {(state?.rows_failed ?? 0) > 0 && state?.id ? (
              <>
                <ImportRowErrorList
                  importId={state.id}
                  failedCount={state.rows_failed}
                />
                <p className="mt-2 text-sm">
                  <a
                    className="font-medium underline underline-offset-4"
                    href={importRowErrorsCsvUrl(state.id)}
                    download
                  >
                    Download the{" "}
                    {pluralizeCount(state?.rows_failed ?? 0, "failed row")} (CSV)
                  </a>
                </p>
              </>
            ) : null}
          </>
        )}
      </div>

      <div className="flex flex-wrap justify-center gap-2">
        <Button asChild>
          <Link href="/app/subscribers">View subscribers</Link>
        </Button>
        <Button type="button" variant="outline" onClick={onReset}>
          Import another
        </Button>
        {failed.length > 0 ? (
          <Button type="button" variant="outline" onClick={downloadErrors}>
            <Download className="h-4 w-4" />
            Download {pluralizeCount(failed.length, "errored row")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The first failures the worker recorded, with the reason for each — "42
 * failed" alone is unanswerable, and the reason (an erased address, an
 * undefined custom field) is often something the operator fixes outside the
 * file.
 */
function ImportRowErrorList({
  importId,
  failedCount,
}: {
  importId: string;
  failedCount: number;
}) {
  const identity = useDirectoryIdentity();
  const errors = useQuery({
    queryKey: [
      ...base("subscriber-import-errors", identity.tenantId, identity.role),
      importId,
    ],
    queryFn: () => listImportRowErrors(importId, { limit: ROW_ERROR_PREVIEW }),
    enabled: identity.ready,
    // A finished import's failures never change.
    staleTime: Infinity,
  });
  if (errors.isPending) {
    return (
      <div role="status" aria-live="polite" className="mx-auto mt-3 max-w-md space-y-2">
        <span className="sr-only">Loading the failed rows…</span>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
      </div>
    );
  }
  if (errors.isError) {
    return (
      <p role="alert" className="mt-3 text-sm text-destructive">
        Couldn&apos;t load the failed rows. The CSV below lists every one.
      </p>
    );
  }
  const items = Array.isArray(errors.data?.items) ? errors.data.items : [];
  if (items.length === 0) return null;
  const total = Math.max(errors.data?.total ?? 0, failedCount);
  return (
    <div className="mx-auto mt-3 max-w-xl text-left">
      <h3 className="text-sm font-medium">Rows that weren&apos;t imported</h3>
      <div
        role="region"
        aria-label="Rows that weren't imported"
        tabIndex={0}
        className="mt-1 max-h-60 overflow-y-auto rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ul className="space-y-1 text-sm">
          {items.map((item) => (
            <li key={`${item.row_number}-${item.error_code}`}>
              <span className="font-medium tabular-nums">Row {item.row_number.toLocaleString()}</span>
              <span className="text-muted-foreground"> — {describeSubscriberRowError(item)}</span>
            </li>
          ))}
        </ul>
      </div>
      {total > items.length ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Showing the first {items.length.toLocaleString()} of {total.toLocaleString()}.
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------- bits ------------------------------------ */
function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "success" | "warning" | "destructive";
}) {
  const color =
    tone === "success"
      ? "text-success"
      : tone === "warning"
        ? "text-warning-emphasis"
        : tone === "destructive"
          ? "text-destructive"
          : "text-foreground";
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${color}`}>
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function OutcomePill({
  outcome,
}: {
  outcome: "create" | "update" | "skip" | "fail";
}) {
  const cls =
    outcome === "create"
      ? "bg-success-subtle text-success-emphasis"
      : outcome === "update"
        ? "bg-foreground/10 text-foreground"
        : outcome === "fail"
          ? "bg-destructive/15 text-destructive-emphasis"
          : "bg-warning/15 text-warning-emphasis";
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${cls}`}>
      {outcome.toUpperCase()}
    </span>
  );
}
