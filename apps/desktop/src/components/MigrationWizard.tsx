/**
 * MigrationWizard — the 5-step Modal-based flow for importing subscribers
 * from a third-party ESP into Moosewave.
 *
 * Steps:
 *   1. Pick source     — 8 cards (6 brands + CSV + Other)
 *   2. Connect         — credentials per source (or CSV file picker)
 *   3. Preview         — dry-run report before commit
 *   4. Run             — live progress polling
 *   5. Verify          — final report + rollback CTA
 *
 * State machine:
 *   - `step` advances forward via Next.
 *   - `step` rewinds via Back EXCEPT once the user has hit Run; from
 *     step 4 onwards the migration is in flight server-side and the
 *     only sensible exit is "Close".
 *   - The job id is fetched lazily — created on the transition
 *     `connect → preview` because that's when the server is told the
 *     credentials. Step 1 doesn't need a job.
 *
 * Honest server-support check: sources marked `serverSupport: false`
 * (currently Other) bail out at the Connect step with copy explaining the
 * adapter is shipping. We never POST to a route we know will fail.
 */

import {
  type Dispatch,
  type ReactElement,
  type RefObject,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";

import { useSingleFlightOperation } from "../hooks/useSettingsDraftLifecycle";
import { ConfirmModal } from "./ConfirmModal";
import { Modal, ModalFooter } from "./Modal";
import { toast } from "./Toast";
import { DryRunPreview } from "./migration/DryRunPreview";
import { MigrationDestructiveDialog } from "./migration/MigrationDestructiveDialog";
import { MigrationSourceSessionRecovery } from "./migration/MigrationSourceSessionRecovery";
import { ProgressView } from "./migration/ProgressView";
import {
  ConnectStep,
  MigrationCapabilityNotice,
  PreviewStep,
  SourcePickStep,
} from "./migration/MigrationWizardSteps";
import { MigrationWizardVerifyStep } from "./migration/MigrationWizardVerifyStep";
import {
  normalizeMigrationRollbackCandidate,
  safeMigrationOperationText,
} from "./migration/migrations-surface-helpers";
import { useMigrationWizardRuntime } from "./migration/useMigrationWizardRuntime";
import { useMigrationOAuthHandoff } from "./migration/useMigrationOAuthHandoff";
import { preflightMigrationCommit } from "./migration/migration-source-session";
import { useMigrationClock } from "./migration/useMigrationClock";
export {
  migrationWizardAutomationSummary,
  migrationWizardResourceStatusLabel,
} from "./migration/migration-wizard-summary";
import {
  type MigrationDoneEvent,
  type MigrationDiscoveryReport,
  type MigrationJob,
  type MigrationPreview,
  type MigrationSource,
  type MigrationSourceCapability,
  api,
} from "../lib/api-client";
import { beginUploadTransfer } from "../lib/file-transfer";
import { registerLifecycleGuard } from "../lib/lifecycle-coordinator";
import {
  buildMigrationCredentialInput,
  applyRuntimeMigrationCapability,
  findSource,
  type ConnectionValues as ConnValues,
  type MigrationSourceDef,
  type MigrationSourceId,
  MIGRATION_SOURCES,
  validateConnection,
} from "../lib/migration-sources";

const STEP_NAMES = [
  "Pick source",
  "Connect",
  "Preview",
  "Run",
  "Verify",
] as const;
type StepIdx = 0 | 1 | 2 | 3 | 4;

interface Props {
  onClose: (didCreate: boolean) => void;
  initialSourceId?: MigrationSourceId;
  initialAuthState?: string;
  initialCapabilities?: MigrationSourceCapability[];
}

interface MigrationConnectionBindings {
  capabilities: MigrationSourceCapability[] | null;
  capabilitiesStale: boolean;
  connection: ConnValues;
  initialState: string;
  jobId: string | null;
  oauthHandoffGenerationRef: RefObject<number>;
  oauthPollRef: RefObject<number | null>;
  pollAliveRef: RefObject<boolean>;
  runPreview: (
    source: MigrationSource,
    id: string,
    audienceIds?: string[],
  ) => Promise<void>;
  selectedAudienceIds: string[];
  source: MigrationSourceDef | null;
  stopOAuthHandoff: (updateState?: boolean) => void;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setConnection: Dispatch<SetStateAction<ConnValues>>;
  setDidCreate: Dispatch<SetStateAction<boolean>>;
  setDiscovery: Dispatch<SetStateAction<MigrationDiscoveryReport | null>>;
  setJobId: Dispatch<SetStateAction<string | null>>;
  setOAuthWaiting: Dispatch<SetStateAction<boolean>>;
  setSelectedAudienceIds: Dispatch<SetStateAction<string[]>>;
  setShowSecrets: Dispatch<SetStateAction<Record<string, boolean>>>;
  setSource: Dispatch<SetStateAction<MigrationSourceDef | null>>;
  setStep: Dispatch<SetStateAction<StepIdx>>;
  setStepError: Dispatch<SetStateAction<string | null>>;
  setUploadProgress: Dispatch<SetStateAction<number | null>>;
}

function useMigrationConnection({
  capabilities,
  capabilitiesStale,
  connection,
  initialState,
  jobId,
  oauthHandoffGenerationRef,
  oauthPollRef,
  pollAliveRef,
  runPreview,
  selectedAudienceIds,
  setBusy,
  setConnection,
  setDidCreate,
  setDiscovery,
  setJobId,
  setOAuthWaiting,
  setSelectedAudienceIds,
  setShowSecrets,
  setSource,
  setStep,
  setStepError,
  setUploadProgress,
  source,
  stopOAuthHandoff,
}: MigrationConnectionBindings) {
  const connectionOperation = useSingleFlightOperation({
    ownerId: "migration-wizard-connect",
    label: source
      ? `${source.name} migration connection`
      : "Migration connection",
    detail:
      "Wait for the migration connection or audience discovery request before leaving Moosewave.",
  });
  const runConnectionOperation = async (
    action: string,
    operation: () => Promise<void>,
  ): Promise<void> => {
    const flight = connectionOperation.run(operation);
    if (!flight) return;
    try {
      await flight;
    } catch (caught) {
      if (!pollAliveRef.current) return;
      setBusy(false);
      setUploadProgress(null);
      setStepError(safeMigrationOperationText(caught, action));
    }
  };

  const pickSource = (nextSource: MigrationSourceDef): void => {
    stopOAuthHandoff();
    const capability = capabilities?.find(
      (item) => item.source === nextSource.id,
    );
    setSource(applyRuntimeMigrationCapability(nextSource, capability));
    setConnection({});
    setShowSecrets({});
    setUploadProgress(null);
    setDiscovery(null);
    setSelectedAudienceIds([]);
    setOAuthWaiting(false);
    setStepError(null);
    setStep(1);
  };

  const acceptConnectedJob = async (
    apiSource: MigrationSource,
    id: string,
  ): Promise<void> => {
    setJobId(id);
    setDidCreate(true);
    // The server has accepted and encrypted this setup material. Do not keep
    // an API key or File object in renderer state throughout preview/import,
    // and do not let the lifecycle guard mislabel an accepted draft as local.
    setConnection({});
    setShowSecrets({});
    setUploadProgress(null);
    if (
      apiSource === "mailchimp" ||
      apiSource === "customerio" ||
      apiSource === "hubspot"
    ) {
      setBusy(true);
      setStepError(null);
      const discovered = await Promise.resolve().then(() =>
        api.discoverMigration(apiSource, id),
      );
      if (!pollAliveRef.current) return;
      setBusy(false);
      if (discovered.error) {
        setStepError(
          safeMigrationOperationText(
            discovered.error,
            apiSource === "mailchimp"
              ? "Audience discovery"
              : `${apiSource === "hubspot" ? "HubSpot" : "Customer.io"} source discovery`,
          ),
        );
        return;
      }
      setDiscovery(discovered.data);
      if (apiSource === "customerio" || apiSource === "hubspot") {
        setStep(2);
        void runPreview(apiSource, id);
        return;
      }
      setSelectedAudienceIds([]);
      if ((discovered.data.audiences?.length ?? 0) === 0) {
        setStepError(
          "Mailchimp returned no audiences. Confirm that the authorizing user can read the intended audience, then reconnect.",
        );
      }
      return;
    }
    setStep(2);
    void runPreview(apiSource, id);
  };

  const startOAuthHandoff = useMigrationOAuthHandoff({
    oauthHandoffGenerationRef,
    oauthPollRef,
    stopOAuthHandoff,
    setBusy,
    setOAuthWaiting,
    setStepError,
  });
  const submitConnectOnce = async (): Promise<void> => {
    if (!source) return;
    if (capabilities == null) {
      setStepError(
        "Migration capabilities are still loading. Try again shortly.",
      );
      return;
    }
    if (capabilitiesStale) {
      setStepError(
        "Migration capabilities are not freshly verified. Go back, retry the capability check, and wait for a verified catalog before connecting.",
      );
      return;
    }
    const canonicalSource = findSource(source.id);
    const capability = capabilities.find((item) => item.source === source.id);
    const reviewedSource = canonicalSource
      ? applyRuntimeMigrationCapability(canonicalSource, capability)
      : null;
    if (
      !reviewedSource?.serverSupport ||
      reviewedSource.intakeAvailable === false
    ) {
      setStepError(
        reviewedSource?.runtimeCompatibilityError ??
          reviewedSource?.intakeUnavailableReason ??
          "This source setup contract is not available on the current deployment.",
      );
      return;
    }
    const validationError = validateConnection(reviewedSource, connection);
    if (validationError) {
      setStepError(validationError);
      return;
    }
    setBusy(true);
    setStepError(null);
    const apiSource = reviewedSource.id as MigrationSource;
    if (reviewedSource.authFlow === "oauth") {
      await startOAuthHandoff(apiSource);
      return;
    }
    if (reviewedSource.authFlow === "csv_upload") {
      const file = connection["file"];
      if (!(file instanceof File)) {
        setBusy(false);
        setStepError("Choose a CSV file before continuing.");
        return;
      }
      setUploadProgress(0);
      const transfer = beginUploadTransfer(file, {
        label: `${source.name} migration upload`,
        privacy: "confidential",
        retry: () => submitConnect(),
      });
      let result: Awaited<ReturnType<typeof api.uploadMigrationFile>>;
      try {
        result = await Promise.resolve().then(() =>
          api.uploadMigrationFile(apiSource, file, (progress) => {
            transfer.progress(progress.uploadedBytes, progress.totalBytes);
            if (pollAliveRef.current) {
              setUploadProgress(
                Math.round(
                  (progress.uploadedBytes / Math.max(1, progress.totalBytes)) *
                    100,
                ),
              );
            }
          }),
        );
      } catch (caught) {
        transfer.fail("migration_upload_failed");
        throw caught;
      }
      if (!pollAliveRef.current) return;
      setBusy(false);
      setUploadProgress(null);
      if (result.error) {
        transfer.fail("migration_upload_failed");
        setStepError(
          safeMigrationOperationText(result.error, "Migration file upload"),
        );
        return;
      }
      if (!result.data.job_id.trim()) {
        transfer.fail("migration_upload_invalid_ack");
        setStepError(
          safeMigrationOperationText(
            { kind: "parse", code: "migration_upload_invalid_ack" },
            "Migration file upload",
          ),
        );
        return;
      }
      transfer.complete();
      await acceptConnectedJob(apiSource, result.data.job_id);
      return;
    }
    const credentials = buildMigrationCredentialInput(
      reviewedSource,
      connection,
      initialState,
    );
    const result = await Promise.resolve().then(() =>
      api.createMigration(apiSource, credentials),
    );
    if (!pollAliveRef.current) return;
    setBusy(false);
    if (result.error) {
      setStepError(
        safeMigrationOperationText(result.error, "Migration connection"),
      );
      return;
    }
    if (!result.data.job_id.trim()) {
      setStepError(
        safeMigrationOperationText(
          { kind: "parse", code: "migration_create_invalid_ack" },
          "Migration connection",
        ),
      );
      return;
    }
    await acceptConnectedJob(apiSource, result.data.job_id);
  };

  const submitConnect = async (): Promise<void> =>
    runConnectionOperation("Migration connection", submitConnectOnce);

  const startSelectedAudiencePreviewOnce = async (): Promise<void> => {
    if (!source || !jobId || source.id !== "mailchimp") return;
    if (selectedAudienceIds.length === 0) {
      setStepError(
        "Select at least one Mailchimp audience before the dry-run.",
      );
      return;
    }
    setBusy(true);
    setStepError(null);
    const scoped = await Promise.resolve().then(() =>
      api.discoverMigration(
        source.id as MigrationSource,
        jobId,
        selectedAudienceIds,
      ),
    );
    if (!pollAliveRef.current) return;
    setBusy(false);
    if (scoped.error) {
      setStepError(
        safeMigrationOperationText(scoped.error, "Audience scope discovery"),
      );
      return;
    }
    setDiscovery(scoped.data);
    setStep(2);
    void runPreview(source.id as MigrationSource, jobId, selectedAudienceIds);
  };

  const startSelectedAudiencePreview = async (): Promise<void> =>
    runConnectionOperation(
      "Audience scope discovery",
      startSelectedAudiencePreviewOnce,
    );

  return { pickSource, startSelectedAudiencePreview, submitConnect };
}

function useMigrationWizardController({
  onClose,
  initialSourceId,
  initialAuthState,
  initialCapabilities,
}: Props) {
  const canonicalInitialSource =
    initialSourceId != null
      ? (MIGRATION_SOURCES.find((s) => s.id === initialSourceId) ?? null)
      : null;
  const initialSource =
    canonicalInitialSource && initialCapabilities !== undefined
      ? applyRuntimeMigrationCapability(
          canonicalInitialSource,
          initialCapabilities.find(
            (capability) => capability.source === canonicalInitialSource.id,
          ),
        )
      : canonicalInitialSource;
  const initialState = initialAuthState?.trim() ?? "";
  const [step, setStep] = useState<StepIdx>(initialSource ? 1 : 0);
  const [source, setSource] = useState<MigrationSourceDef | null>(
    initialSource,
  );
  const [conn, setConn] = useState<ConnValues>({});
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});

  /* Job lifecycle ----------------------------------------------------- */
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<MigrationJob | null>(null);
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [discovery, setDiscovery] = useState<MigrationDiscoveryReport | null>(
    null,
  );
  const [selectedAudienceIds, setSelectedAudienceIds] = useState<string[]>([]);
  const [oauthWaiting, setOAuthWaiting] = useState(false);

  /* Step-specific status ---------------------------------------------- */
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [stepErr, setStepErr] = useState<string | null>(null);
  const [didCreate, setDidCreate] = useState(false); // Tells parent to refresh.

  const runtime = useMigrationWizardRuntime({
    initialCapabilities,
    setBusy,
    setJob,
    setOAuthWaiting,
    setPreview,
    setSource,
    setStepError: setStepErr,
  });
  const {
    capabilities,
    capabilitiesError: capabilitiesErr,
    capabilitiesRefreshing,
    capabilitiesStale,
    refreshCapabilities,
    stopOAuthHandoff,
    stopPreview,
  } = runtime;
  const { pickSource, startSelectedAudiencePreview, submitConnect } =
    useMigrationConnection({
      capabilities,
      capabilitiesStale,
      connection: conn,
      initialState,
      jobId,
      oauthHandoffGenerationRef: runtime.oauthHandoffGenerationRef,
      oauthPollRef: runtime.oauthPollRef,
      pollAliveRef: runtime.pollAliveRef,
      runPreview: runtime.runPreview,
      selectedAudienceIds,
      setBusy,
      setConnection: setConn,
      setDidCreate,
      setDiscovery,
      setJobId,
      setOAuthWaiting,
      setSelectedAudienceIds,
      setShowSecrets,
      setSource,
      setStep,
      setStepError: setStepErr,
      setUploadProgress,
      source,
      stopOAuthHandoff,
    });

  /* ------------------------------------------------------------------ */
  /* Step 4: run                                                          */
  /* ------------------------------------------------------------------ */

  const runOperation = useSingleFlightOperation({
    ownerId: "migration-wizard-run",
    label: "Start migration import",
    detail:
      "Wait for the migration start acknowledgement before leaving Moosewave.",
  });

  const startRun = async (): Promise<void> => {
    if (!source || !jobId) return;
    const flight = runOperation.run(async () => {
      setBusy(true);
      setStepErr(null);
      const apiSource = source.id as MigrationSource;
      const snapshot = await Promise.resolve().then(() =>
        api.getMigration(jobId),
      );
      if (snapshot.error) throw snapshot.error;
      const preflight = preflightMigrationCommit(
        snapshot.data,
        { id: jobId, source: apiSource },
        selectedAudienceIds,
      );
      if (!preflight.ok) {
        if (preflight.job) setJob(preflight.job);
        throw {
          kind: "parse",
          code: preflight.code,
        };
      }
      setJob(preflight.job);
      const res = await Promise.resolve().then(() =>
        api.runMigration(
          apiSource,
          jobId,
          apiSource === "mailchimp" ? selectedAudienceIds : undefined,
        ),
      );
      if (!runtime.pollAliveRef.current) return;
      if (res.error) {
        const message = safeMigrationOperationText(
          res.error,
          "Migration start",
        );
        setBusy(false);
        setStepErr(message);
        toast.error({
          message: "Migration start could not be confirmed.",
          detail: message,
        });
        return;
      }
      if (res.data.job_id !== jobId) {
        const message = safeMigrationOperationText(
          { kind: "parse", code: "migration_run_invalid_ack" },
          "Migration start",
        );
        setBusy(false);
        setStepErr(message);
        toast.error({
          message: "Migration start could not be confirmed.",
          detail: message,
        });
        return;
      }
      setBusy(false);
      setStep(3);
    });
    if (!flight) return;
    try {
      await flight;
    } catch (caught) {
      if (!runtime.pollAliveRef.current) return;
      const message = safeMigrationOperationText(caught, "Migration start");
      setBusy(false);
      setStepErr(message);
      toast.error({
        message: "Migration start could not be confirmed.",
        detail: message,
      });
    }
  };

  /* ------------------------------------------------------------------ */
  /* Step 5: verify-step actions                                         */
  /* ------------------------------------------------------------------ */

  const [confirmRollbackOpen, setConfirmRollbackOpen] = useState(false);
  const rollbackOperation = useSingleFlightOperation({
    ownerId: "migration-wizard-rollback",
    label: "Roll back migration records",
    detail:
      "Wait for the migration rollback acknowledgement before leaving Moosewave.",
  });
  const rollbackBusy = rollbackOperation.active;

  /** Roll back the (partially) imported job. Confirmed via ConfirmModal. */
  const doRollback = async (): Promise<void> => {
    if (!jobId || rollbackBusy) return;
    const flight = rollbackOperation.run(async () => {
      const snapshot = await Promise.resolve().then(() =>
        api.getMigration(jobId),
      );
      if (snapshot.error) throw snapshot.error;
      if (
        !source ||
        !normalizeMigrationRollbackCandidate(snapshot.data, {
          id: jobId,
          source: source.id,
        })
      ) {
        throw {
          kind: "parse",
          code: "migration_rollback_preflight_unavailable",
        };
      }
      const res = await Promise.resolve().then(() =>
        api.rollbackMigration(jobId),
      );
      if (res.error) throw res.error;
      const ack = res.data as unknown;
      if (
        !ack ||
        typeof ack !== "object" ||
        (ack as { job_id?: unknown }).job_id !== jobId ||
        (ack as { state?: unknown }).state !== "running"
      ) {
        throw {
          kind: "parse",
          code: "migration_rollback_invalid_ack",
        };
      }
    });
    if (!flight) return;
    try {
      await flight;
      if (!runtime.pollAliveRef.current) return;
      setConfirmRollbackOpen(false);
      toast.success({
        message: "Rollback request acknowledged.",
        detail:
          "Migration history will show durable rollback state; the acknowledgement is not final deletion proof.",
      });
      onClose(true);
    } catch (caught) {
      if (!runtime.pollAliveRef.current) return;
      const safe = safeMigrationOperationText(caught, "Rollback");
      toast.error({
        message: "Rollback could not be confirmed.",
        detail: safe,
      });
    }
  };

  useMigrationWizardLifecycle({
    busy,
    oauthWaiting,
    rollbackBusy,
    connection: conn,
    source,
    step,
    setConnection: setConn,
    setSelectedAudienceIds,
    setShowSecrets,
    stopOAuthHandoff,
  });

  /**
   * Auth failure on the verify step → jump straight back to the
   * Connect step (the wizard keeps `source` + entered values) so the
   * operator can fix the key without restarting the whole flow. The
   * old job is abandoned server-side; submitConnect creates a new one.
   */
  const reenterCredentials = (): void => {
    setJobId(null);
    setJob(null);
    setPreview(null);
    setStepErr(null);
    setBusy(false);
    setStep(1);
  };

  /* ------------------------------------------------------------------ */
  /* Render                                                              */
  /* ------------------------------------------------------------------ */

  const headerTitle = `Migration · Step ${step + 1} of ${STEP_NAMES.length}: ${STEP_NAMES[step]}`;
  const headerDesc =
    step === 0
      ? "Pick the platform you're moving from. We'll handle the rest."
      : source
        ? `Source: ${source.name}`
        : undefined;

  /** Close intent — confirms only when the migration is in-flight.
   *  Uses ConfirmModal: window.confirm silently no-ops in the Tauri
   *  webview, which made the wizard impossible to close mid-run. */
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const handleClose = (): void => {
    if (busy || rollbackBusy) {
      setStepErr(
        "Wait for the current server acknowledgement to settle before closing this migration window.",
      );
      return;
    }
    // [D14-settings-misc#14] Step 3 is the live Run step: ProgressView owns
    // its own progress state and startRun already cleared `busy`, so gate
    // the confirm on the step (job in flight), not on `busy` — otherwise an
    // Esc/backdrop close silently dismisses a running import. Step 2 is only
    // the dry-run poll, so it needs no "still running" confirmation.
    if (step === 3) {
      setConfirmCloseOpen(true);
      return;
    }
    onClose(didCreate);
  };

  return {
    actions: {
      doRollback,
      handleClose,
      pickSource,
      reenterCredentials,
      startRun,
      startSelectedAudiencePreview,
      stopOAuthHandoff,
      submitConnect,
    },
    connection: {
      capabilities,
      capabilitiesErr,
      capabilitiesStale,
      conn,
      discovery,
      oauthWaiting,
      selectedAudienceIds,
      setConn,
      setSelectedAudienceIds,
      setShowSecrets,
      showSecrets,
      source,
      uploadProgress,
    },
    jobState: { job, jobId, preview, setJob, setPreview },
    operations: { busy, rollbackBusy, setBusy, stepErr, setStepErr },
    overlays: {
      confirmCloseOpen,
      confirmRollbackOpen,
      setConfirmCloseOpen,
      setConfirmRollbackOpen,
    },
    polling: { stopPreview },
    shell: { didCreate, headerDesc, headerTitle, onClose, setStep, step },
    sourceCatalog: {
      capabilitiesRefreshing,
      refreshCapabilities,
    },
  };
}

function useMigrationWizardLifecycle({
  busy,
  oauthWaiting,
  rollbackBusy,
  connection,
  source,
  step,
  setConnection,
  setSelectedAudienceIds,
  setShowSecrets,
  stopOAuthHandoff,
}: {
  busy: boolean;
  oauthWaiting: boolean;
  rollbackBusy: boolean;
  connection: ConnValues;
  source: MigrationSourceDef | null;
  step: StepIdx;
  setConnection: Dispatch<SetStateAction<ConnValues>>;
  setSelectedAudienceIds: Dispatch<SetStateAction<string[]>>;
  setShowSecrets: Dispatch<SetStateAction<Record<string, boolean>>>;
  stopOAuthHandoff: (updateState?: boolean) => void;
}): void {
  const hasLocalDraft = Object.values(connection).some((value) =>
    value instanceof File
      ? true
      : typeof value === "string" && value.trim().length > 0,
  );
  useEffect(() => {
    const operationActive = busy || oauthWaiting || rollbackBusy;
    const migrationRunning = step === 3;
    if (!operationActive && !migrationRunning && !hasLocalDraft) return;
    return registerLifecycleGuard({
      id: "migration-wizard",
      label: source ? `${source.name} migration` : "Migration setup",
      inspect: (intent) => {
        if (intent.disposition === "hide") return null;
        if (operationActive) {
          return {
            level: "blocking",
            detail:
              "A migration request, authorization handoff, or rollback is still in progress.",
            canDiscard: false,
          };
        }
        if (migrationRunning) {
          return {
            level: "warning",
            detail:
              "The server-side migration will continue, but this device will leave its live progress view.",
            canDiscard: false,
          };
        }
        return {
          level: "warning",
          detail:
            "The selected migration file or connection values have not been submitted.",
        };
      },
      discard: () => {
        setConnection({});
        setSelectedAudienceIds([]);
        setShowSecrets({});
        stopOAuthHandoff();
      },
    });
  }, [
    busy,
    hasLocalDraft,
    oauthWaiting,
    rollbackBusy,
    setConnection,
    setSelectedAudienceIds,
    setShowSecrets,
    source,
    step,
    stopOAuthHandoff,
  ]);
}

type MigrationWizardController = ReturnType<
  typeof useMigrationWizardController
>;

export function MigrationWizard(props: Props): ReactElement {
  const controller = useMigrationWizardController(props);
  return <MigrationWizardView controller={controller} />;
}

function MigrationWizardView({
  controller,
}: {
  controller: MigrationWizardController;
}): ReactElement {
  const now = useMigrationClock();
  const stepFocusRef = useRef<HTMLHeadingElement | null>(null);
  const {
    actions,
    connection,
    jobState,
    operations,
    overlays,
    polling,
    shell,
    sourceCatalog,
  } = controller;
  const {
    doRollback,
    handleClose,
    pickSource,
    reenterCredentials,
    startRun,
    startSelectedAudiencePreview,
    stopOAuthHandoff,
    submitConnect,
  } = actions;
  const {
    capabilities,
    capabilitiesErr,
    capabilitiesStale,
    conn,
    discovery,
    oauthWaiting,
    selectedAudienceIds,
    setConn,
    setSelectedAudienceIds,
    setShowSecrets,
    showSecrets,
    source,
    uploadProgress,
  } = connection;
  const { job, jobId, preview, setJob, setPreview } = jobState;
  const { busy, rollbackBusy, setBusy, stepErr, setStepErr } = operations;
  const {
    confirmCloseOpen,
    confirmRollbackOpen,
    setConfirmCloseOpen,
    setConfirmRollbackOpen,
  } = overlays;
  const { stopPreview } = polling;
  const { didCreate, headerDesc, headerTitle, onClose, setStep, step } = shell;
  const { capabilitiesRefreshing, refreshCapabilities } = sourceCatalog;
  const connectUnavailableReason =
    step === 1 && source
      ? migrationConnectUnavailableReason({
          busy,
          capabilitiesPending: capabilities === null,
          capabilitiesStale,
          oauthWaiting,
          source,
          values: conn,
          hasDiscovery: Boolean(discovery),
          selectedAudienceCount: selectedAudienceIds.length,
        })
      : null;
  const commitPreflight =
    step === 2 && preview && jobId && source
      ? preflightMigrationCommit(
          job,
          { id: jobId, source: source.id as MigrationSource },
          selectedAudienceIds,
          now,
        )
      : null;
  const stepAnnouncement = `Step ${step + 1} of ${STEP_NAMES.length}: ${STEP_NAMES[step]}${
    stepErr
      ? `. ${stepErr}`
      : capabilitiesErr
        ? ". Migration capabilities could not be confirmed."
        : ""
  }`;

  return (
    <Modal
      open={true}
      onClose={handleClose}
      title={headerTitle}
      initialFocusRef={stepFocusRef}
      focusKey={step}
      {...(headerDesc ? { description: headerDesc } : {})}
    >
      <h3
        ref={stepFocusRef}
        className="sr-only"
        tabIndex={-1}
        data-migration-step-heading
      >
        {`Step ${step + 1} of ${STEP_NAMES.length}: ${STEP_NAMES[step]}`}
      </h3>
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-migration-step-announcement
      >
        {stepAnnouncement}
      </div>
      <StepIndicator step={step} />

      {step === 0 ? (
        <SourcePickStep
          capabilities={capabilities}
          capabilitiesErr={capabilitiesErr}
          stale={capabilitiesStale}
          refreshing={capabilitiesRefreshing}
          onRetry={() => void refreshCapabilities()}
          onPick={pickSource}
        />
      ) : null}

      {step === 1 && source ? (
        <>
          <MigrationCapabilityNotice
            error={capabilitiesErr}
            stale={capabilitiesStale}
            refreshing={capabilitiesRefreshing}
            onRetry={() => void refreshCapabilities()}
          />
          <ConnectStep
            source={source}
            values={conn}
            setValues={setConn}
            showSecrets={showSecrets}
            setShowSecrets={setShowSecrets}
            err={stepErr}
            discovery={discovery}
            selectedAudienceIds={selectedAudienceIds}
            setSelectedAudienceIds={setSelectedAudienceIds}
            oauthWaiting={oauthWaiting}
            onCancelOAuth={() => {
              stopOAuthHandoff();
              setStepErr(null);
            }}
          />
        </>
      ) : null}

      {step === 2 && source ? (
        <>
          {source.id === "customerio" && discovery ? (
            <div className="notice" role="status" style={{ marginBottom: 16 }}>
              {customerIODiscoveryEvidenceText(discovery)}
            </div>
          ) : null}
          {source.id === "hubspot" && discovery ? (
            <div className="notice" role="status" style={{ marginBottom: 16 }}>
              {hubSpotDiscoveryEvidenceText(discovery)}
            </div>
          ) : null}
          {preview && jobId ? (
            <>
              <DryRunPreview
                jobId={jobId}
                source={source.id as MigrationSource}
                sourceLabel={source.name}
                preview={preview}
                commitUnavailableReason={
                  source.commitUnavailableReason ??
                  (commitPreflight && !commitPreflight.ok
                    ? commitPreflight.reason
                    : undefined)
                }
                onConfirm={() => void startRun()}
                onCancel={() => {
                  stopPreview();
                  setStep(1);
                }}
                busy={busy}
                operationError={stepErr}
              />
              {commitPreflight &&
              !commitPreflight.ok &&
              commitPreflight.job &&
              commitPreflight.health?.blocksAction ? (
                <MigrationSourceSessionRecovery
                  job={commitPreflight.job}
                  health={commitPreflight.health}
                  onVerifiedJob={setJob}
                />
              ) : null}
            </>
          ) : (
            <PreviewStep
              source={source}
              preview={preview}
              busy={busy}
              err={stepErr}
            />
          )}
        </>
      ) : null}

      {step === 3 && source && jobId ? (
        <ProgressView
          jobId={jobId}
          source={source.id}
          sourceLabel={source.name}
          onComplete={(done: MigrationDoneEvent) => {
            setJob(done.job);
            if (done.job.verification_report) {
              setPreview(done.job.verification_report);
            }
            if (done.status === "failed" && done.error) {
              setStepErr(done.error);
            }
            setBusy(false);
            setStep(4);
          }}
          onCancel={() => {
            setStepErr(null);
          }}
        />
      ) : null}

      {step === 4 && source ? (
        <MigrationWizardVerifyStep
          job={job}
          preview={preview}
          err={stepErr}
          onClose={() => onClose(true)}
          onRollback={() => setConfirmRollbackOpen(true)}
          onReenterKey={reenterCredentials}
        />
      ) : null}

      <MigrationWizardFooter
        step={step}
        source={source}
        busy={busy}
        uploadProgress={uploadProgress}
        oauthWaiting={oauthWaiting}
        discovery={discovery}
        selectedAudienceIds={selectedAudienceIds}
        connectUnavailableReason={connectUnavailableReason}
        preview={preview}
        onClose={handleClose}
        onConnect={() => void submitConnect()}
        onPreviewAudiences={() => void startSelectedAudiencePreview()}
        onBack={() => {
          stopOAuthHandoff();
          setStep((current) => Math.max(0, current - 1) as StepIdx);
        }}
        onDone={() => onClose(true)}
      />

      <ConfirmModal
        open={confirmCloseOpen}
        title="Close the migration window?"
        description="The migration is still running on the server. You can reopen it from the Migrations table."
        confirmLabel="Close window"
        cancelLabel="Keep watching"
        onConfirm={() => {
          setConfirmCloseOpen(false);
          onClose(didCreate);
        }}
        onClose={() => setConfirmCloseOpen(false)}
      />

      {jobId && source ? (
        <MigrationDestructiveDialog
          open={confirmRollbackOpen}
          kind="rollback"
          jobId={jobId}
          sourceLabel={source.name}
          busy={rollbackBusy}
          importedSubscribers={
            job?.verification_report?.subscribers_imported ??
            job?.progress?.subscribers_done
          }
          rollbackDeadline={job?.rollback_until}
          onConfirm={() => void doRollback()}
          onClose={() => setConfirmRollbackOpen(false)}
        />
      ) : null}
    </Modal>
  );
}

function MigrationWizardFooter({
  step,
  source,
  busy,
  uploadProgress,
  oauthWaiting,
  discovery,
  selectedAudienceIds,
  connectUnavailableReason,
  preview,
  onClose,
  onConnect,
  onPreviewAudiences,
  onBack,
  onDone,
}: {
  step: StepIdx;
  source: MigrationSourceDef | null;
  busy: boolean;
  uploadProgress: number | null;
  oauthWaiting: boolean;
  discovery: MigrationDiscoveryReport | null;
  selectedAudienceIds: string[];
  connectUnavailableReason: string | null;
  preview: MigrationPreview | null;
  onClose: () => void;
  onConnect: () => void;
  onPreviewAudiences: () => void;
  onBack: () => void;
  onDone: () => void;
}): ReactElement {
  return (
    <ModalFooter>
      {step > 0 && step < 3 && !busy ? (
        <button type="button" className="btn" onClick={onBack}>
          Back
        </button>
      ) : null}
      {step === 0 ? (
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
      ) : null}
      {step === 1 && source ? (
        source.serverSupport ? (
          <button
            type="button"
            className="btn btn-primary"
            aria-disabled={Boolean(connectUnavailableReason) || undefined}
            aria-busy={busy || undefined}
            aria-describedby={
              connectUnavailableReason
                ? "migration-connect-unavailable-reason"
                : undefined
            }
            onClick={() => {
              if (connectUnavailableReason) return;
              if (discovery && source.id === "mailchimp") {
                onPreviewAudiences();
              } else {
                onConnect();
              }
            }}
          >
            {busy && uploadProgress === 0
              ? "Preparing secure upload…"
              : busy && uploadProgress != null
                ? `Uploading ${uploadProgress}%…`
                : busy
                  ? "Connecting…"
                  : oauthWaiting
                    ? "Hosted migration workspace open"
                    : discovery && source.id === "mailchimp"
                      ? `Preview ${selectedAudienceIds.length} audience${selectedAudienceIds.length === 1 ? "" : "s"}`
                      : source.authFlow === "oauth"
                        ? `Connect ${source.name} in browser`
                        : "Connect & preview"}
          </button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        )
      ) : null}
      {step === 1 && connectUnavailableReason ? (
        <span
          id="migration-connect-unavailable-reason"
          className="migration-action-reason"
          role={busy || oauthWaiting ? "status" : undefined}
        >
          {connectUnavailableReason}
        </span>
      ) : null}
      {step === 2 && !preview ? (
        <>
          <button
            type="button"
            className="btn btn-primary"
            aria-disabled="true"
            aria-busy="true"
            aria-describedby="migration-dry-run-pending-reason"
          >
            Preparing dry-run…
          </button>
          <span
            id="migration-dry-run-pending-reason"
            className="migration-action-reason"
            role="status"
          >
            The dry-run report has not been verified yet. No real import can
            start from this state.
          </span>
        </>
      ) : null}
      {step === 3 ? (
        <button type="button" className="btn" onClick={onClose}>
          Run in background
        </button>
      ) : null}
      {step === 4 ? (
        <button type="button" className="btn btn-primary" onClick={onDone}>
          Done
        </button>
      ) : null}
    </ModalFooter>
  );
}

export function customerIODiscoveryEvidenceText(
  discovery: MigrationDiscoveryReport,
): string {
  const channelCount = discovery.subscription_channels_count;
  const channelEvidence =
    typeof channelCount === "number" && Number.isInteger(channelCount)
      ? `${channelCount} subscription-channel definition${channelCount === 1 ? "" : "s"}`
      : "an unavailable subscription-channel definition count";
  const objectCount = discovery.custom_objects_count;
  const objectEvidence =
    typeof objectCount === "number" && Number.isInteger(objectCount)
      ? `${objectCount} custom-object type${objectCount === 1 ? "" : "s"}`
      : "an unavailable custom-object type count";
  const nonEmailCount = discovery.profiles_without_email_count;
  const nonEmailEvidence =
    typeof nonEmailCount === "number" && Number.isInteger(nonEmailCount)
      ? `${nonEmailCount} profile${nonEmailCount === 1 ? "" : "s"} without a usable email`
      : "an unavailable non-email profile count";
  return `Customer.io preflight found ${channelEvidence}, ${objectEvidence}, and ${nonEmailEvidence}. These are exact source-inventory evidence; channel definitions are not consent, object types are not object-profile parity, and non-email identities are not fabricated into email subscribers.`;
}

export function hubSpotDiscoveryEvidenceText(
  discovery: MigrationDiscoveryReport,
): string {
  const nonEmailCount = discovery.profiles_without_email_count;
  const nonEmailEvidence =
    typeof nonEmailCount === "number" && Number.isInteger(nonEmailCount)
      ? `${nonEmailCount} contact${nonEmailCount === 1 ? "" : "s"} without a valid current primary email`
      : "an unavailable no-primary-email contact count";
  const additionalEmailCount = discovery.additional_email_identities_count;
  const additionalEmailEvidence =
    typeof additionalEmailCount === "number" &&
    Number.isInteger(additionalEmailCount)
      ? `${additionalEmailCount} additional email identit${additionalEmailCount === 1 ? "y" : "ies"}`
      : "an unavailable additional-email identity count";
  return `HubSpot preflight found ${nonEmailEvidence} and ${additionalEmailEvidence}. Neither category is fabricated into an independent sendable subscriber; additional addresses remain exact reconciliation evidence tied to the current primary-email boundary.`;
}

/* ====================================================================
 * StepIndicator
 * ================================================================== */

function StepIndicator({ step }: { step: StepIdx }): ReactElement {
  return (
    <ol
      className="wizard-progress"
      aria-label={`Migration wizard, step ${step + 1} of ${STEP_NAMES.length}`}
    >
      {STEP_NAMES.map((name, i) => {
        const state = i < step ? "done" : i === step ? "active" : "pending";
        return (
          <li
            key={name}
            className={`wizard-step is-${state}`}
            aria-current={i === step ? "step" : undefined}
          >
            <div className="wizard-step-num" aria-hidden="true">
              {i + 1}
            </div>
            <div className="wizard-step-label">{name}</div>
            {i < STEP_NAMES.length - 1 ? (
              <div className="wizard-step-sep" aria-hidden />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function migrationConnectUnavailableReason({
  busy,
  capabilitiesPending,
  capabilitiesStale,
  oauthWaiting,
  source,
  values,
  hasDiscovery,
  selectedAudienceCount,
}: {
  busy: boolean;
  capabilitiesPending: boolean;
  capabilitiesStale: boolean;
  oauthWaiting: boolean;
  source: MigrationSourceDef;
  values: ConnValues;
  hasDiscovery: boolean;
  selectedAudienceCount: number;
}): string | null {
  if (busy) {
    return "A connection, upload, discovery, or preview request is already in progress.";
  }
  if (capabilitiesPending) {
    return "Migration capabilities are still being verified. Wait for the server catalog before connecting.";
  }
  if (capabilitiesStale) {
    return "The migration capability catalog is not freshly verified. Go back and retry verification before connecting.";
  }
  if (source.intakeAvailable === false) {
    return (
      source.intakeUnavailableReason ??
      "This deployment has not attested that source setup is available."
    );
  }
  if (oauthWaiting) {
    return "Finish the hosted migration task or return to source setup before opening another browser workspace.";
  }
  const validation = validateConnection(source, values);
  if (validation) return validation;
  if (
    source.id === "mailchimp" &&
    hasDiscovery &&
    selectedAudienceCount === 0
  ) {
    return "Select at least one Mailchimp audience before preparing the scoped dry-run.";
  }
  return null;
}

/* ====================================================================
 * Step 1: source pick
 * ================================================================== */

/* Small noop to satisfy the unused-id-name rule on MigrationSourceId. */
const _MigrationSourceId: MigrationSourceId | undefined = undefined;
void _MigrationSourceId;
