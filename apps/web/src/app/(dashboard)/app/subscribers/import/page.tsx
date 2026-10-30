// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Multi-step CSV import wizard: upload -> map columns -> consent evidence ->
// preflight review (acknowledged) -> commit with polled progress + cancel ->
// result. Wraps the backend subscriber-imports lifecycle (preview / remap /
// PATCH mapping + consent / confirm(dry_run) / confirm / progress). Falls
// through to a clear result screen with next-step CTAs and an errored-row
// export. An import still running from an earlier visit is offered on the
// upload step so it can be watched or cancelled.

import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, FileUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageShell } from "@/components/dashboard/page-shell";
import { useImportProgress } from "@/components/subscribers/useImportProgress";
import { downloadTextFile } from "@/lib/download";
import { apiErrorMessage } from "@/lib/api";
import { whoami } from "@/lib/auth-api";
import {
  getCustomFieldsMode,
  type CustomFieldsValidatorMode,
} from "@/lib/custom-fields-api";
import { qk, STALE } from "@/lib/query-keys";
import {
  cancelImport,
  confirmImport,
  discardImportPreviewQuietly,
  dryRunImport,
  getRemapOptions,
  importAcknowledgementProblem,
  patchImport,
  previewImport,
  undeclaredCustomFieldKeys,
  type DryRunResults,
  type ImportAcknowledgements,
  type ImportColumnMapping,
  type ImportMapping,
  type ImportPreview,
  type ImportState,
  type RemapOptions,
} from "@/lib/subscriber-imports-api";
import type { ConsentMode } from "./import-wizard-steps";
import type { ImportTargetList } from "./import-target-list";
import { refreshAudienceQueries } from "../subscribers-refresh";

/** A step's footprint while its chunk loads: one card-sized block, announced. */
function StepLoading() {
  return (
    <div role="status" aria-live="polite" className="space-y-4">
      <span className="sr-only">Loading…</span>
      <Skeleton className="h-48 w-full rounded-md" />
    </div>
  );
}

// Only the upload step is on screen when the wizard first paints. Everything
// after it (and the consent evidence form) loads in its own chunk when the
// operator reaches it, which keeps the route under the dashboard bundle budget.
const MapStep = dynamic(
  () => import("./import-wizard-steps").then((m) => m.MapStep),
  { loading: () => <StepLoading /> },
);
const ReviewStep = dynamic(
  () => import("./import-wizard-steps").then((m) => m.ReviewStep),
  { loading: () => <StepLoading /> },
);
const RunningStep = dynamic(
  () => import("./import-wizard-steps").then((m) => m.RunningStep),
  { loading: () => <StepLoading /> },
);
const DoneStep = dynamic(
  () => import("./import-wizard-steps").then((m) => m.DoneStep),
  { loading: () => <StepLoading /> },
);
const ImportConsentEvidenceStep = dynamic(
  () =>
    import("@/components/subscribers/CsvImportWizardSteps").then(
      (m) => m.ImportConsentEvidenceStep,
    ),
  { loading: () => <StepLoading /> },
);
// Renders nothing unless an earlier import is still running or an earlier
// upload was never imported, so nothing to hold space for while it loads.
const InFlightImportRecovery = dynamic(() =>
  import("@/components/subscribers/CsvImportWizardSteps").then(
    (m) => m.InFlightImportRecovery,
  ),
);

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const NO_ACKNOWLEDGEMENTS: ImportAcknowledgements = {
  queue: false,
  failures: false,
};

type Step = "upload" | "map" | "consent" | "review" | "running" | "done";

const SAMPLE_CSV =
  "email,name,tags,status\n" +
  "ada@example.com,Ada Lovelace,vip;beta,enabled\n" +
  "grace@example.com,Grace Hopper,beta,enabled\n";

export default function ImportWizardPage() {
  const [step, setStep] = useState<Step>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [remap, setRemap] = useState<RemapOptions | null>(null);
  const [columns, setColumns] = useState<ImportColumnMapping[]>([]);
  const [onExisting, setOnExisting] = useState<"skip" | "update" | "error">(
    "skip",
  );
  const [revision, setRevision] = useState(0);
  // The workspace's custom-field mode decides what the import may do with a
  // mapped field it hasn't defined; "Create new custom fields" starts on in
  // auto mode, as the server's own default for the upload does.
  const [customFieldsMode, setCustomFieldsMode] =
    useState<CustomFieldsValidatorMode | null>(null);
  const [autoCreate, setAutoCreate] = useState(false);
  const [consentMode, setConsentMode] = useState<ConsentMode>("none");
  // The list imported contacts join, chosen on the Map step and saved with the
  // mapping. Null is "no list", which is what an import has always done.
  const [targetList, setTargetList] = useState<ImportTargetList | null>(null);
  const [dryRun, setDryRun] = useState<DryRunResults | null>(null);
  const [acks, setAcks] = useState<ImportAcknowledgements>(NO_ACKNOWLEDGEMENTS);
  const [finalState, setFinalState] = useState<ImportState | null>(null);
  // An import started on an earlier visit that the operator re-attached to.
  const [resumedImportId, setResumedImportId] = useState<string | null>(null);

  const importId = preview?.id ?? resumedImportId;
  const cancelledRef = useRef(false);
  const queryClient = useQueryClient();
  // The same identity read every dashboard page shares; the tenant scopes the
  // caches this wizard refreshes.
  const me = useQuery({ queryKey: qk.authMe(), queryFn: whoami, staleTime: STALE.authMe });
  const tenantId = me.data?.tenant_id ?? "anon";

  // The upload that is still only a preview, if any. It can't be resumed from
  // another visit, so leaving the wizard discards it instead of holding the
  // file on the server for the 24-hour abandoned-preview window.
  const draftIdRef = useRef<string | null>(null);
  useEffect(() => {
    draftIdRef.current =
      preview && (step === "map" || step === "consent" || step === "review")
        ? preview.id
        : null;
  }, [preview, step]);
  useEffect(
    () => () => {
      if (draftIdRef.current) void discardImportPreviewQuietly(draftIdRef.current);
    },
    [],
  );

  const reset = () => {
    setStep("upload");
    setFile(null);
    setError(null);
    setPreview(null);
    setRemap(null);
    setColumns([]);
    setOnExisting("skip");
    setRevision(0);
    setCustomFieldsMode(null);
    setAutoCreate(false);
    setConsentMode("none");
    setTargetList(null);
    setDryRun(null);
    setAcks(NO_ACKNOWLEDGEMENTS);
    setFinalState(null);
    setResumedImportId(null);
    cancelledRef.current = false;
  };

  // Abandon the current upload: the server drops the file and review data.
  // keepFile leaves the chosen file selected so Preview can re-upload it.
  const discardPreview = async ({ keepFile }: { keepFile: boolean }) => {
    const id = preview?.id;
    const chosen = file;
    reset();
    if (keepFile) setFile(chosen);
    if (id) await discardImportPreviewQuietly(id);
    void queryClient.invalidateQueries({
      queryKey: ["subscriber-imports", tenantId],
    });
  };

  // The strict-mode notice sends the operator to Settings › Custom fields in
  // a new tab. Re-read the declared fields (and the mode) when they come back,
  // or when they ask, so a field defined meanwhile stops showing as new.
  const [recheckingFields, setRecheckingFields] = useState(false);
  const recheckRef = useRef(false);
  const recheckDeclaredFields = useCallback(async () => {
    if (recheckRef.current) return;
    recheckRef.current = true;
    setRecheckingFields(true);
    try {
      const [options, modeRead] = await Promise.all([
        getRemapOptions(),
        getCustomFieldsMode().catch(() => null),
      ]);
      setRemap(options);
      // A changed mode changes what the step can offer; an unchanged one keeps
      // the operator's own "create new custom fields" choice.
      const mode = modeRead?.custom_fields_mode ?? null;
      if (mode && mode !== customFieldsMode) {
        setCustomFieldsMode(mode);
        setAutoCreate(mode === "auto");
      }
    } catch {
      // Keep what the step already shows; the preflight re-checks every row.
    } finally {
      recheckRef.current = false;
      setRecheckingFields(false);
    }
  }, [customFieldsMode]);
  useEffect(() => {
    if (step !== "map") return;
    const onFocus = () => void recheckDeclaredFields();
    const onVisible = () => {
      if (document.visibilityState === "visible") onFocus();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [step, recheckDeclaredFields]);

  const resumeImport = (id: string) => {
    setError(null);
    setPreview(null);
    setDryRun(null);
    setFinalState(null);
    setResumedImportId(id);
    setBusy(true);
    setStep("running");
  };

  /* -------- Step 1: upload + preview -------- */
  const startPreview = async () => {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setError("This CSV is larger than the 50 MB import limit.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const [p, options, modeRead] = await Promise.all([
        previewImport(file),
        getRemapOptions(),
        // The mode only shapes what the Map step explains; if it can't be read
        // the upload keeps its server-side default and nothing is promised.
        getCustomFieldsMode().catch(() => null),
      ]);
      const mode = modeRead?.custom_fields_mode ?? null;
      setPreview(p);
      setRemap(options);
      setColumns(p.mapping.columns);
      setOnExisting((p.on_existing as typeof onExisting) || "skip");
      setRevision(p.configuration_revision);
      setCustomFieldsMode(mode);
      setAutoCreate(mode === "auto");
      setStep("map");
    } catch (e) {
      setError(apiErrorMessage(e, "Could not read the CSV."));
    } finally {
      setBusy(false);
    }
  };

  /* -------- Step 2: persist mapping, then record consent evidence -------- */
  const continueToConsent = async () => {
    if (!importId) return;
    setBusy(true);
    setError(null);
    try {
      const mapping: ImportMapping = {
        ...(preview!.mapping as ImportMapping),
        columns,
      };
      const patched = await patchImport(importId, {
        configuration_revision: revision,
        mapping,
        on_existing: onExisting,
        // "" clears it, so going back and choosing "No list" is saved too.
        target_list_id: targetList?.id ?? "",
        // Only an auto-mode workspace can create fields through an import;
        // when the mode couldn't be read the upload keeps its own default.
        ...(customFieldsMode
          ? { auto_create_properties: customFieldsMode === "auto" && autoCreate }
          : {}),
      });
      setRevision(patched.configuration_revision);
      setStep("consent");
    } catch (e) {
      setError(apiErrorMessage(e, "Could not save the column mapping."));
    } finally {
      setBusy(false);
    }
  };

  /* -------- Step 3: the consent choice is saved; run the preflight -------- */
  // The preflight runs only after the consent contract is persisted, so it
  // judges the contract the operator actually chose.
  const runPreflight = async () => {
    if (!importId) return;
    setBusy(true);
    setError(null);
    try {
      const dry = await dryRunImport(importId);
      setDryRun(dry.dry_run_results);
      setAcks(NO_ACKNOWLEDGEMENTS);
      setStep("review");
    } catch (e) {
      setError(apiErrorMessage(e, "Could not validate the import."));
    } finally {
      setBusy(false);
    }
  };

  /* -------- Step 4: commit + poll progress -------- */
  const commit = async () => {
    if (!importId || !dryRun || importAcknowledgementProblem(dryRun, acks))
      return;
    setBusy(true);
    setError(null);
    cancelledRef.current = false;
    // From the click on, the upload is no longer a draft to throw away:
    // leaving while Confirm is in flight must not discard it. It becomes one
    // again only if Confirm fails.
    draftIdRef.current = null;
    try {
      await confirmImport(importId);
      setStep("running");
    } catch (e) {
      draftIdRef.current = importId;
      setError(apiErrorMessage(e, "Could not start the import."));
      setBusy(false);
    }
  };

  // Follow the import to its terminal status while on the running step: over
  // GET /api/v1/subscriber-imports/{id}/progress (server-sent events) when the
  // browser can open one, otherwise by polling the import read every 1.5 s.
  const progress = useImportProgress(importId, step === "running");
  useEffect(() => {
    if (progress.state) setFinalState(progress.state);
    if (progress.done) {
      setStep("done");
      setBusy(false);
      // The audience changed: the directory, its counts and growth trend,
      // the dashboard and the onboarding checklist all read it.
      refreshAudienceQueries(queryClient, tenantId);
    }
  }, [progress.state, progress.done, queryClient, tenantId]);

  const cancel = async () => {
    if (!importId) return;
    cancelledRef.current = true;
    try {
      await cancelImport(importId);
      toast.message("Cancelling import…");
    } catch (e) {
      toast.error(apiErrorMessage(e, "Could not cancel."));
    }
  };

  return (
    <PageShell className="max-w-4xl">
      <header>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Import subscribers
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload a CSV, map its columns, preview the outcome, then commit — with
          live progress you can cancel.
        </p>
      </header>

      <Stepper step={step} />

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis"
        >
          {error}
        </div>
      ) : null}

      {step === "upload" ? (
        <>
          <InFlightImportRecovery onResume={resumeImport} />
          <UploadStep
            file={file}
            busy={busy}
            onFile={(f) => {
              setFile(f);
              setError(null);
            }}
            onNext={startPreview}
          />
        </>
      ) : null}

      {step === "map" && preview ? (
        <MapStep
          preview={preview}
          remap={remap}
          columns={columns}
          onColumns={setColumns}
          onExisting={onExisting}
          onOnExisting={setOnExisting}
          customFieldsMode={customFieldsMode}
          autoCreate={autoCreate}
          onAutoCreate={setAutoCreate}
          onRecheckFields={() => void recheckDeclaredFields()}
          recheckingFields={recheckingFields}
          targetList={targetList}
          onTargetList={setTargetList}
          busy={busy}
          onBack={() => void discardPreview({ keepFile: true })}
          onNext={continueToConsent}
        />
      ) : null}

      {step === "consent" && importId ? (
        <ImportConsentEvidenceStep
          importId={importId}
          revision={revision}
          busy={busy}
          onBack={() => setStep("map")}
          onSaved={({ revision: nextRevision, mode }) => {
            setRevision(nextRevision);
            setConsentMode(mode);
            void runPreflight();
          }}
        />
      ) : null}

      {step === "review" && dryRun ? (
        <ReviewStep
          dryRun={dryRun}
          busy={busy}
          consentMode={consentMode}
          acknowledgements={acks}
          onAcknowledgements={setAcks}
          onBack={() => setStep("consent")}
          onCommit={commit}
          onDiscard={() => discardPreview({ keepFile: false })}
          fieldsToCreate={
            customFieldsMode === "auto" && autoCreate
              ? undeclaredCustomFieldKeys(columns, remap?.custom_fields ?? [])
              : []
          }
        />
      ) : null}

      {step === "running" ? (
        <RunningStep state={finalState} onCancel={cancel} />
      ) : null}

      {step === "done" ? (
        <DoneStep
          state={finalState}
          dryRun={dryRun}
          consentMode={resumedImportId ? null : consentMode}
          targetListName={resumedImportId ? null : (targetList?.name ?? null)}
          onReset={reset}
        />
      ) : null}
    </PageShell>
  );
}

/* --------------------------------- Stepper -------------------------------- */
function Stepper({ step }: { step: Step }) {
  const steps: { id: Step; label: string }[] = [
    { id: "upload", label: "Upload" },
    { id: "map", label: "Map columns" },
    { id: "consent", label: "Consent" },
    { id: "review", label: "Review" },
    { id: "done", label: "Import" },
  ];
  const order: Step[] = [
    "upload",
    "map",
    "consent",
    "review",
    "running",
    "done",
  ];
  const currentIdx = order.indexOf(step);
  return (
    <ol className="flex flex-wrap items-center gap-2 text-sm">
      {steps.map((s, i) => {
        const idx = order.indexOf(s.id);
        const active = step === s.id || (s.id === "done" && step === "running");
        const done =
          currentIdx > idx && !(s.id === "done" && step === "running");
        return (
          <li key={s.id} className="flex items-center gap-2">
            <span
              className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                active
                  ? "bg-primary text-primary-foreground"
                  : done
                    ? "bg-success-subtle text-success-emphasis"
                    : "bg-muted text-muted-foreground"
              }`}
            >
              {i + 1}
            </span>
            <span className={active ? "font-medium" : "text-muted-foreground"}>
              {s.label}
            </span>
            {i < steps.length - 1 ? (
              <span className="text-muted-foreground">→</span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/* --------------------------------- Upload --------------------------------- */
function UploadStep({
  file,
  busy,
  onFile,
  onNext,
}: {
  file: File | null;
  busy: boolean;
  onFile: (f: File | null) => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-md border bg-card p-4 text-sm">
        <p className="text-muted-foreground">
          Required column: <code>email</code>. Optional: <code>name</code>,{" "}
          <code>tags</code> (comma- or semicolon-separated), plus any custom
          field you&apos;ve defined under{" "}
          <Link
            className="inline-flex items-center rounded-sm font-medium text-primary underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11"
            href="/app/settings/custom-fields"
          >
            Custom fields
          </Link>
          . You&apos;ll map columns on the next step.
        </p>
        <button
          type="button"
          className="mt-3 inline-flex min-h-11 items-center gap-1.5 text-sm text-primary hover:underline"
          onClick={() =>
            downloadTextFile("subscribers-sample.csv", SAMPLE_CSV, "text/csv")
          }
        >
          <Download className="h-4 w-4" />
          Download sample CSV
        </button>
      </div>

      <div>
        <label htmlFor="import-file" className="mb-2 block text-sm font-medium">
          CSV file
        </label>
        <input
          id="import-file"
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
          className="block w-full max-w-full text-sm file:mr-3 file:min-h-11 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-2.5 file:text-sm file:font-medium hover:file:bg-muted"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          {/* The picker starts empty when this step is shown again after Back,
              so name the file Preview will upload. */}
          {file ? (
            <>
              Selected: <span className="font-medium text-foreground">{file.name}</span> · up to 50 MB.
            </>
          ) : (
            "Up to 50 MB."
          )}
        </p>
      </div>

      <Button type="button" onClick={onNext} disabled={!file || busy}>
        <FileUp className="h-4 w-4" />
        {busy ? "Reading…" : "Preview"}
      </Button>
    </div>
  );
}
