/**
 * Production lookalike workflow for the Subscribers surface.
 *
 * Generation is server-authoritative: the selected seed must have at least 50
 * live members and the operator must explicitly acknowledge the first-party
 * data-use notice. Status reads are aggregate-only by default; this component
 * never requests ranked subscriber identities.
 */

import {
  type ReactElement,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type AudienceDestination,
  audienceDestinationsApi,
} from "../../lib/api-client";
import {
  type SubscriberLookalikeAudience,
  lookalikeApi,
} from "../../lib/api/subscriber-lookalike";
import { usePersistentLifecycleOperation } from "../../hooks/usePersistentLifecycleOperation";
import {
  lifecycleOperationError,
  useDiscardOnlyDraftLifecycle,
} from "../../hooks/useSettingsDraftLifecycle";
import { type Segment, segmentsClient } from "../segments/segmentsClient";
import { ConfirmModal } from "../ConfirmModal";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";

interface Props {
  open: boolean;
  onClose: () => void;
  canMutate: boolean;
  selectedCount?: number;
}

type GenerationPhase =
  | "idle"
  | "submitting"
  | "polling"
  | "ready"
  | "failed"
  | "cancelled";

interface DraftBaseline {
  seedId: string;
  name: string;
  size: number;
  useThreshold: boolean;
  threshold: number;
  acknowledged: boolean;
}

const MIN_SIZE = 100;
const MAX_SIZE = 10_000;
const DEFAULT_SIZE = 1_000;
const MIN_SEED_MEMBERS = 50;
const DEFAULT_THRESHOLD = 0.8;
const MIN_THRESHOLD = 0.5;

const FEATURE_LABELS: Record<string, string> = {
  email_domain: "Email domain",
  signup_source: "Signup source",
  engagement: "Engagement score",
  retention: "Retention / churn score",
};

function defaultName(selectedCount: number): string {
  return selectedCount > 0
    ? `Lookalike of ${selectedCount.toLocaleString()} selected`
    : "Lookalike audience";
}

function initialBaseline(selectedCount: number): DraftBaseline {
  return {
    seedId: "",
    name: defaultName(selectedCount),
    size: DEFAULT_SIZE,
    useThreshold: true,
    threshold: DEFAULT_THRESHOLD,
    acknowledged: false,
  };
}

function bandCount(
  audience: SubscriberLookalikeAudience,
  key: "high" | "medium" | "low",
): number {
  const bands = audience.payload.bands;
  if (!bands || typeof bands !== "object" || Array.isArray(bands)) return 0;
  const value = (bands as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function aggregateCount(
  audience: SubscriberLookalikeAudience,
  key: "candidate_count" | "scored",
): number | null {
  const value = audience.payload[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function featureLabels(audience: SubscriberLookalikeAudience): string[] {
  const dimensions = audience.payload.feature_dims;
  if (!Array.isArray(dimensions)) return [];
  return dimensions
    .filter((item): item is string => typeof item === "string")
    .map((item) => FEATURE_LABELS[item])
    .filter((item): item is string => Boolean(item));
}

function phaseForAudience(
  audience: SubscriberLookalikeAudience,
): GenerationPhase {
  if (audience.status === "ready") return "ready";
  if (audience.status === "failed") return "failed";
  return "cancelled";
}

function destinationLabel(destination: AudienceDestination): string {
  const provider = destination.provider.replaceAll("_", " ");
  const external = destination.external_audience_id?.trim();
  return `${provider}${external ? ` · ${external}` : ""} · ${destination.status}`;
}

export function LookalikeGeneratorModal({
  open,
  onClose,
  canMutate,
  selectedCount = 0,
}: Props): ReactElement | null {
  const mountedRef = useRef(true);
  const loadSequenceRef = useRef(0);
  const generationSequenceRef = useRef(0);
  const pollControllerRef = useRef<AbortController | null>(null);
  const outcomeRef = useRef<HTMLDivElement | null>(null);
  const baselineRef = useRef<DraftBaseline>(initialBaseline(selectedCount));
  const draftDirtyRef = useRef(false);

  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [segLoading, setSegLoading] = useState(false);
  const [segErr, setSegErr] = useState<string | null>(null);
  const [recent, setRecent] = useState<SubscriberLookalikeAudience[]>([]);
  const [recentErr, setRecentErr] = useState<string | null>(null);
  const [destinations, setDestinations] = useState<AudienceDestination[]>([]);
  const [destinationsErr, setDestinationsErr] = useState<string | null>(null);

  const [seedId, setSeedId] = useState("");
  const [name, setName] = useState(defaultName(selectedCount));
  const [size, setSize] = useState(DEFAULT_SIZE);
  const [useThreshold, setUseThreshold] = useState(true);
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [acknowledged, setAcknowledged] = useState(false);

  const [phase, setPhase] = useState<GenerationPhase>("idle");
  const [result, setResult] = useState<SubscriberLookalikeAudience | null>(
    null,
  );
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [destId, setDestId] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const operation = usePersistentLifecycleOperation({
    ownerId: "subscriber-lookalike",
    label: "Subscriber lookalike operation",
    detail:
      "A lookalike request is still settling. Stop status polling first or wait for the server response.",
  });

  const eligibleSegments = useMemo(
    () =>
      (segments ?? []).filter(
        (segment) =>
          typeof segment.lastCount === "number" &&
          Number.isSafeInteger(segment.lastCount) &&
          segment.lastCount >= MIN_SEED_MEMBERS,
      ),
    [segments],
  );
  const excludedSegmentCount =
    (segments?.length ?? 0) - eligibleSegments.length;

  const draftDirty = result
    ? destId !== ""
    : seedId !== baselineRef.current.seedId ||
      name !== baselineRef.current.name ||
      size !== baselineRef.current.size ||
      useThreshold !== baselineRef.current.useThreshold ||
      threshold !== baselineRef.current.threshold ||
      acknowledged !== baselineRef.current.acknowledged;
  draftDirtyRef.current = draftDirty;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadSequenceRef.current += 1;
      generationSequenceRef.current += 1;
      pollControllerRef.current?.abort();
    };
  }, []);

  const loadModalData = useCallback(
    async (requestId: number): Promise<void> => {
      const [segmentResponse, recentResponse, destinationResponse] =
        await Promise.all([
          segmentsClient.list(),
          lookalikeApi.list(),
          audienceDestinationsApi.list(),
        ]);
      if (!mountedRef.current || requestId !== loadSequenceRef.current) return;

      if (segmentResponse.error) {
        setSegments(null);
        setSegErr(segmentResponse.error.message);
      } else {
        const items = segmentResponse.data ?? [];
        const eligible = items.filter(
          (segment) =>
            typeof segment.lastCount === "number" &&
            Number.isSafeInteger(segment.lastCount) &&
            segment.lastCount >= MIN_SEED_MEMBERS,
        );
        const initialSeedId = eligible[0]?.id ?? "";
        setSegments(items);
        setSeedId(initialSeedId);
        baselineRef.current = { ...baselineRef.current, seedId: initialSeedId };
      }

      if (recentResponse.error) {
        setRecent([]);
        setRecentErr(recentResponse.error.message);
      } else {
        setRecent(recentResponse.data.items.slice(0, 5));
      }

      if (destinationResponse.error) {
        setDestinations([]);
        setDestinationsErr(destinationResponse.error.message);
      } else {
        setDestinations(
          destinationResponse.data.items.filter(
            (destination) => destination.status !== "disconnected",
          ),
        );
      }
    },
    [],
  );

  useEffect(() => {
    if (!open || draftDirtyRef.current) return;
    const requestId = ++loadSequenceRef.current;
    const baseline = initialBaseline(selectedCount);
    baselineRef.current = baseline;
    setSeedId("");
    setName(baseline.name);
    setSize(baseline.size);
    setUseThreshold(baseline.useThreshold);
    setThreshold(baseline.threshold);
    setAcknowledged(false);
    setResult(null);
    setPhase("idle");
    setGenerationError(null);
    setDestId("");
    setExportError(null);
    setDeleteConfirmOpen(false);
    setDiscardConfirmOpen(false);
    setSegLoading(true);
    setSegErr(null);
    setRecentErr(null);
    setDestinationsErr(null);
    void loadModalData(requestId)
      .catch((error: unknown) => {
        if (!mountedRef.current || requestId !== loadSequenceRef.current)
          return;
        setSegErr(
          lifecycleOperationError(error, "Couldn't load lookalike data."),
        );
      })
      .finally(() => {
        if (mountedRef.current && requestId === loadSequenceRef.current) {
          setSegLoading(false);
        }
      });
    return () => {
      if (loadSequenceRef.current === requestId) loadSequenceRef.current += 1;
    };
  }, [loadModalData, open, selectedCount]);

  useEffect(() => {
    if (!operation.active && phase !== "idle") outcomeRef.current?.focus();
  }, [operation.active, phase]);

  const discardDraft = useCallback((): void => {
    if (result) {
      setDestId("");
    } else {
      const baseline = baselineRef.current;
      setSeedId(baseline.seedId);
      setName(baseline.name);
      setSize(baseline.size);
      setUseThreshold(baseline.useThreshold);
      setThreshold(baseline.threshold);
      setAcknowledged(baseline.acknowledged);
    }
    setDiscardConfirmOpen(false);
  }, [result]);

  useDiscardOnlyDraftLifecycle({
    ownerId: result
      ? `subscriber-lookalike-destination-${result.id}`
      : "subscriber-lookalike-generate",
    label: result
      ? "Lookalike destination draft"
      : "Subscriber lookalike generation draft",
    dirty: draftDirty,
    operationRef: operation.promiseRef,
    discard: discardDraft,
    detail: result
      ? "A destination association has been selected but not recorded."
      : "This lookalike generation draft has not been submitted.",
  });

  const commitAudience = useCallback(
    (audience: SubscriberLookalikeAudience): void => {
      setResult(audience);
      setRecent((items) =>
        [audience, ...items.filter((item) => item.id !== audience.id)].slice(
          0,
          5,
        ),
      );
      if (audience.status === "ready") {
        setPhase("ready");
        setGenerationError(null);
        toast.success(
          audience.member_count === 0
            ? "Generation finished with no candidates above the selected confidence floor."
            : `Generated ${audience.member_count.toLocaleString()} modeled subscriber${audience.member_count === 1 ? "" : "s"}.`,
        );
      } else if (audience.status === "failed") {
        setPhase("failed");
        setGenerationError(
          audience.error ||
            "The server could not finish this model. Review the seed and try a new generation.",
        );
      }
    },
    [],
  );

  const runStatusWait = useCallback(
    async (
      audience: SubscriberLookalikeAudience,
      requestId: number,
    ): Promise<void> => {
      const controller = new AbortController();
      pollControllerRef.current = controller;
      setPhase("polling");
      const waited = await lookalikeApi.waitForTerminal(audience.id, {
        signal: controller.signal,
      });
      if (!mountedRef.current || requestId !== generationSequenceRef.current)
        return;
      pollControllerRef.current = null;
      if (waited.error) {
        if (waited.error.code === "aborted") {
          setPhase("cancelled");
          setGenerationError(
            "Stopped checking status. This did not cancel the server-side job; use “Check status” before creating another audience.",
          );
        } else {
          setPhase("failed");
          setGenerationError(waited.error.message);
        }
        return;
      }
      commitAudience(waited.data);
    },
    [commitAudience],
  );

  const generate = async (): Promise<void> => {
    if (!canMutate || !seedId || !acknowledged) return;
    const requestId = ++generationSequenceRef.current;
    setPhase("submitting");
    setGenerationError(null);
    const pending = operation.run(async () => {
      const created = await lookalikeApi.create({
        name: name.trim() || "Lookalike audience",
        seed_segment_id: seedId,
        size,
        confidence_threshold: useThreshold ? threshold : null,
        data_use_acknowledged: true,
      });
      if (
        created.error ||
        !mountedRef.current ||
        requestId !== generationSequenceRef.current
      ) {
        return created;
      }
      setResult(created.data);
      setRecent((items) =>
        [
          created.data,
          ...items.filter((item) => item.id !== created.data.id),
        ].slice(0, 5),
      );
      if (
        created.data.status === "pending" ||
        created.data.status === "running"
      ) {
        await runStatusWait(created.data, requestId);
      }
      return created;
    });
    if (!pending) return;
    try {
      const response = await pending;
      if (!mountedRef.current || requestId !== generationSequenceRef.current)
        return;
      if (response.error) {
        setPhase("failed");
        setGenerationError(
          response.error.status === 403 || response.error.code === "forbidden"
            ? "Creating a lookalike needs an editor-scoped session."
            : response.error.message,
        );
        return;
      }
      if (
        response.data.status === "ready" ||
        response.data.status === "failed"
      ) {
        commitAudience(response.data);
      }
    } catch (error) {
      if (mountedRef.current && requestId === generationSequenceRef.current) {
        setPhase("failed");
        setGenerationError(
          lifecycleOperationError(error, "The generation request failed."),
        );
      }
    }
  };

  const resumeStatus = async (): Promise<void> => {
    if (!result || (result.status !== "pending" && result.status !== "running"))
      return;
    const requestId = ++generationSequenceRef.current;
    setGenerationError(null);
    const pending = operation.run(async () => {
      await runStatusWait(result, requestId);
    });
    if (!pending) return;
    try {
      await pending;
    } catch (error) {
      if (mountedRef.current && requestId === generationSequenceRef.current) {
        setPhase("failed");
        setGenerationError(
          lifecycleOperationError(error, "The status request failed."),
        );
      }
    }
  };

  const stopWaiting = (): void => {
    pollControllerRef.current?.abort();
  };

  const openRecent = (audience: SubscriberLookalikeAudience): void => {
    if (operation.active) return;
    setResult(audience);
    setPhase(phaseForAudience(audience));
    setGenerationError(
      audience.status === "failed"
        ? audience.error || "Generation failed."
        : null,
    );
    setDestId("");
    setExportError(null);
  };

  const startAnother = (): void => {
    if (operation.active) return;
    setResult(null);
    setPhase("idle");
    setGenerationError(null);
    setDestId("");
    setAcknowledged(false);
  };

  const recordDestination = async (): Promise<void> => {
    if (!canMutate || !result || !destId) return;
    setExporting(true);
    setExportError(null);
    const pending = operation.run(() => lookalikeApi.export(result.id, destId));
    if (!pending) {
      setExporting(false);
      return;
    }
    try {
      const response = await pending;
      if (!mountedRef.current) return;
      if (response.error) {
        setExportError(response.error.message);
        return;
      }
      setResult(response.data);
      setRecent((items) =>
        items.map((item) =>
          item.id === response.data.id ? response.data : item,
        ),
      );
      setDestId("");
      toast.success(
        "Destination recorded. Provider delivery has not started; run and monitor it from Audience Syncs.",
      );
    } catch (error) {
      if (mountedRef.current) {
        setExportError(
          lifecycleOperationError(error, "The destination request failed."),
        );
      }
    } finally {
      if (mountedRef.current) setExporting(false);
    }
  };

  const deleteAudience = async (): Promise<void> => {
    if (!canMutate || !result) return;
    const id = result.id;
    setDeleting(true);
    const pending = operation.run(() => lookalikeApi.remove(id));
    if (!pending) {
      setDeleting(false);
      return;
    }
    try {
      const response = await pending;
      if (!mountedRef.current) return;
      if (response.error) {
        setDeleteConfirmOpen(false);
        setGenerationError(response.error.message);
        toast.error(`Couldn't delete lookalike: ${response.error.message}`);
        return;
      }
      setRecent((items) => items.filter((item) => item.id !== id));
      setDeleteConfirmOpen(false);
      setResult(null);
      setPhase("idle");
      setGenerationError(null);
      setAcknowledged(false);
      toast.success("Lookalike audience deleted.");
    } catch (error) {
      if (mountedRef.current) {
        setDeleteConfirmOpen(false);
        setGenerationError(
          lifecycleOperationError(error, "The delete request failed."),
        );
      }
    } finally {
      if (mountedRef.current) setDeleting(false);
    }
  };

  if (!open) return null;

  const requestClose = (): void => {
    if (operation.promiseRef.current) return;
    if (draftDirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    onClose();
  };

  const discardAndClose = (): void => {
    if (operation.promiseRef.current) return;
    discardDraft();
    onClose();
  };

  const segReady = eligibleSegments.length > 0;
  const nameValid = name.trim().length > 0 && name.trim().length <= 120;
  const sizeValid =
    Number.isSafeInteger(size) && size >= MIN_SIZE && size <= MAX_SIZE;
  const thresholdValid =
    !useThreshold ||
    (Number.isFinite(threshold) &&
      threshold >= MIN_THRESHOLD &&
      threshold <= 1);
  const generationUnavailable =
    !canMutate ||
    !segReady ||
    !seedId ||
    !nameValid ||
    !sizeValid ||
    !thresholdValid ||
    !acknowledged;

  return (
    <>
      <Modal
        open
        onClose={requestClose}
        closeOnBackdrop={!operation.active}
        closeOnEscape={!operation.active}
        closeDisabled={operation.active}
        title={
          result
            ? result.name || "Lookalike audience"
            : "Generate lookalike audience"
        }
        description={
          result
            ? "Inspect aggregate model evidence, recover status checks, or manage this materialized audience."
            : "Build a first-party modeled audience from one evaluated seed segment."
        }
        size="lg"
      >
        <div aria-busy={operation.active ? "true" : undefined}>
          {result ? (
            <LookalikeOutcome
              outcomeRef={outcomeRef}
              result={result}
              phase={phase}
              generationError={generationError}
              canMutate={canMutate}
              operationActive={operation.active}
              destinations={destinations}
              destinationsErr={destinationsErr}
              destId={destId}
              setDestId={setDestId}
              exporting={exporting}
              exportError={exportError}
              onRecordDestination={recordDestination}
              onResume={resumeStatus}
              onStop={stopWaiting}
              onStartAnother={startAnother}
              onDelete={() => setDeleteConfirmOpen(true)}
              onClose={requestClose}
            />
          ) : (
            <LookalikeForm
              selectedCount={selectedCount}
              segments={eligibleSegments}
              excludedSegmentCount={excludedSegmentCount}
              segLoading={segLoading}
              segErr={segErr}
              seedId={seedId}
              setSeedId={setSeedId}
              name={name}
              setName={setName}
              size={size}
              setSize={setSize}
              useThreshold={useThreshold}
              setUseThreshold={setUseThreshold}
              threshold={threshold}
              setThreshold={setThreshold}
              acknowledged={acknowledged}
              setAcknowledged={setAcknowledged}
              recent={recent}
              recentErr={recentErr}
              generationError={generationError}
              phase={phase}
              canMutate={canMutate}
              operationActive={operation.active}
              generationUnavailable={generationUnavailable}
              onGenerate={generate}
              onOpenRecent={openRecent}
              onClose={requestClose}
            />
          )}
        </div>
      </Modal>
      <ConfirmModal
        open={discardConfirmOpen}
        title={
          result ? "Discard destination draft?" : "Discard lookalike draft?"
        }
        description={
          result
            ? "The selected destination has not been recorded and will be cleared."
            : "The seed, name, size, confidence, and acknowledgement in this draft will be lost."
        }
        confirmLabel="Discard draft"
        danger
        busy={operation.active}
        onConfirm={discardAndClose}
        onClose={() => setDiscardConfirmOpen(false)}
      />
      <ConfirmModal
        open={deleteConfirmOpen}
        title="Delete modeled audience?"
        description="This permanently removes the lookalike header and its materialized ranked members from this workspace. It does not delete subscribers or remove data already sent to a provider."
        confirmLabel="Delete audience"
        danger
        busy={deleting || operation.active}
        onConfirm={deleteAudience}
        onClose={() => setDeleteConfirmOpen(false)}
      />
    </>
  );
}

interface LookalikeFormProps {
  selectedCount: number;
  segments: Segment[];
  excludedSegmentCount: number;
  segLoading: boolean;
  segErr: string | null;
  seedId: string;
  setSeedId: (value: string) => void;
  name: string;
  setName: (value: string) => void;
  size: number;
  setSize: (value: number) => void;
  useThreshold: boolean;
  setUseThreshold: (value: boolean) => void;
  threshold: number;
  setThreshold: (value: number) => void;
  acknowledged: boolean;
  setAcknowledged: (value: boolean) => void;
  recent: SubscriberLookalikeAudience[];
  recentErr: string | null;
  generationError: string | null;
  phase: GenerationPhase;
  canMutate: boolean;
  operationActive: boolean;
  generationUnavailable: boolean;
  onGenerate: () => Promise<void>;
  onOpenRecent: (audience: SubscriberLookalikeAudience) => void;
  onClose: () => void;
}

function LookalikeForm(props: LookalikeFormProps): ReactElement {
  const guidanceId = useId();
  const sizeHelpId = useId();
  const thresholdHelpId = useId();
  const nameError =
    props.name.trim().length === 0
      ? "Enter an audience name."
      : props.name.trim().length > 120
        ? "Keep the name to 120 characters or fewer."
        : null;
  const guidance = !props.canMutate
    ? "Viewer access can inspect and configure this draft. An editor-scoped session is required to generate it."
    : props.segments.length === 0
      ? `Evaluate a saved segment with at least ${MIN_SEED_MEMBERS} live members.`
      : !props.acknowledged
        ? "Review and acknowledge the data-use notice before generation."
        : "Ready to create a materialized modeled audience.";
  return (
    <>
      <div className="lookalike-form-grid">
        <section className="lookalike-config" aria-label="Model configuration">
          {props.selectedCount > 0 ? (
            <div className="lookalike-selection-note" role="note">
              <strong>
                {props.selectedCount.toLocaleString()} selected rows are not the
                seed.
              </strong>{" "}
              Generation uses the saved segment chosen below. Save and evaluate
              a segment first if these exact rows should define the cohort.
            </div>
          ) : null}

          <div className="field">
            <label className="field-label" htmlFor="lookalike-seed">
              Seed segment
            </label>
            {props.segLoading ? (
              <div className="lookalike-skeleton" role="status">
                Loading evaluated segments…
              </div>
            ) : props.segErr ? (
              <div className="notice" role="alert">
                Couldn&apos;t load segments: {props.segErr}
              </div>
            ) : props.segments.length === 0 ? (
              <div className="notice" role="status">
                No eligible seed segments. The server requires at least{" "}
                {MIN_SEED_MEMBERS} live members; evaluate or recompute a saved
                segment first.
              </div>
            ) : (
              <select
                id="lookalike-seed"
                className="input"
                value={props.seedId}
                onChange={(event) => props.setSeedId(event.target.value)}
                disabled={props.operationActive}
              >
                {props.segments.map((segment) => (
                  <option key={segment.id} value={segment.id}>
                    {segment.name} ({segment.lastCount?.toLocaleString()}{" "}
                    members)
                  </option>
                ))}
              </select>
            )}
            <div className="field-help">
              {props.excludedSegmentCount > 0
                ? `${props.excludedSegmentCount} unevaluated or undersized segment${props.excludedSegmentCount === 1 ? " is" : "s are"} hidden.`
                : "Eligibility is rechecked against live membership by the server."}
            </div>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="lookalike-name">
              Audience name
            </label>
            <input
              id="lookalike-name"
              type="text"
              className="input"
              value={props.name}
              maxLength={140}
              onChange={(event) => props.setName(event.target.value)}
              aria-invalid={nameError ? "true" : undefined}
              disabled={props.operationActive}
              autoComplete="off"
            />
            <div
              className={nameError ? "field-error" : "field-help"}
              role={nameError ? "alert" : undefined}
            >
              {nameError ?? `${props.name.trim().length}/120 characters`}
            </div>
          </div>

          <div className="lookalike-number-grid">
            <div className="field">
              <label className="field-label" htmlFor="lookalike-size-number">
                Target size
              </label>
              <input
                id="lookalike-size-number"
                type="number"
                className="input tabular"
                min={MIN_SIZE}
                max={MAX_SIZE}
                step={100}
                value={props.size}
                onChange={(event) => props.setSize(Number(event.target.value))}
                aria-describedby={sizeHelpId}
                disabled={props.operationActive}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="lookalike-size">
                Size slider
              </label>
              <input
                id="lookalike-size"
                type="range"
                min={MIN_SIZE}
                max={MAX_SIZE}
                step={100}
                value={Math.min(
                  MAX_SIZE,
                  Math.max(MIN_SIZE, props.size || MIN_SIZE),
                )}
                onChange={(event) => props.setSize(Number(event.target.value))}
                aria-describedby={sizeHelpId}
                disabled={props.operationActive}
              />
            </div>
          </div>
          <div id={sizeHelpId} className="field-help">
            {MIN_SIZE.toLocaleString()}–{MAX_SIZE.toLocaleString()}. The result
            may be smaller when too few candidates meet the confidence floor.
          </div>

          <div className="lookalike-threshold-row">
            <label
              className="lookalike-switch"
              htmlFor="lookalike-use-threshold"
              aria-label="Apply confidence floor"
            >
              <input
                id="lookalike-use-threshold"
                type="checkbox"
                checked={props.useThreshold}
                onChange={(event) =>
                  props.setUseThreshold(event.target.checked)
                }
                disabled={props.operationActive}
              />
              <span>
                <strong>Apply confidence floor</strong>
                <small>Prefer precision over filling the requested size.</small>
              </span>
            </label>
            {props.useThreshold ? (
              <input
                type="number"
                className="input lookalike-threshold-number tabular"
                min={MIN_THRESHOLD}
                max={1}
                step={0.05}
                value={props.threshold}
                onChange={(event) =>
                  props.setThreshold(Number(event.target.value))
                }
                aria-label="Confidence floor"
                aria-describedby={thresholdHelpId}
                disabled={props.operationActive}
              />
            ) : null}
          </div>
          {props.useThreshold ? (
            <input
              type="range"
              min={MIN_THRESHOLD}
              max={1}
              step={0.05}
              value={Math.min(
                1,
                Math.max(MIN_THRESHOLD, props.threshold || MIN_THRESHOLD),
              )}
              onChange={(event) =>
                props.setThreshold(Number(event.target.value))
              }
              aria-label="Confidence floor slider"
              aria-describedby={thresholdHelpId}
              disabled={props.operationActive}
            />
          ) : null}
          <div id={thresholdHelpId} className="field-help">
            {props.useThreshold
              ? "0.50–1.00. Higher values usually produce a smaller, more similar audience."
              : `No floor: rank up to ${props.size.toLocaleString()} candidates by similarity.`}
          </div>
        </section>

        <aside
          className="lookalike-disclosure"
          aria-labelledby="lookalike-data-use-title"
        >
          <div className="lookalike-disclosure-kicker">First-party model</div>
          <h3 id="lookalike-data-use-title">Know what the model uses</h3>
          <p>
            Moosewave derives similarity from email domain, signup source,
            engagement score, and retention/churn score. It does not use message
            content, third-party broker data, or cross-site browsing activity.
          </p>
          <ul>
            <li>The full email address is not a similarity feature.</li>
            <li>
              Ranked subscriber identifiers and emails are materialized inside
              this workspace so the audience can be activated.
            </li>
            <li>
              Assigning a destination does not itself start provider delivery.
            </li>
          </ul>
          <label className="lookalike-acknowledgement">
            <input
              type="checkbox"
              checked={props.acknowledged}
              onChange={(event) => props.setAcknowledged(event.target.checked)}
              disabled={props.operationActive}
            />
            <span>
              I understand this data use and confirm I am authorized to model
              this first-party subscriber audience.
            </span>
          </label>
        </aside>
      </div>

      {props.generationError ? (
        <div className="lookalike-error" role="alert">
          <strong>Generation did not complete in this view.</strong>
          <span>{props.generationError}</span>
          {props.phase === "failed" ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void props.onGenerate()}
              disabled={props.operationActive || props.generationUnavailable}
            >
              Retry generation
            </button>
          ) : null}
        </div>
      ) : null}

      <RecentLookalikes
        items={props.recent}
        error={props.recentErr}
        onOpen={props.onOpenRecent}
      />

      <p id={guidanceId} className="muted" role="status" aria-live="polite">
        {guidance}
      </p>
      <ModalFooter>
        <button
          type="button"
          className="btn"
          onClick={props.onClose}
          disabled={props.operationActive}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={props.operationActive}
          aria-disabled={props.generationUnavailable || undefined}
          aria-describedby={guidanceId}
          aria-busy={props.operationActive ? "true" : undefined}
          onClick={() => {
            if (!props.generationUnavailable) void props.onGenerate();
          }}
        >
          {props.phase === "submitting" ? "Submitting…" : "Generate audience"}
        </button>
      </ModalFooter>
    </>
  );
}

function RecentLookalikes({
  items,
  error,
  onOpen,
}: {
  items: SubscriberLookalikeAudience[];
  error: string | null;
  onOpen: (audience: SubscriberLookalikeAudience) => void;
}): ReactElement | null {
  if (error) {
    return (
      <p className="field-help" role="status">
        Recent audiences couldn&apos;t be loaded: {error}
      </p>
    );
  }
  if (items.length === 0) return null;
  return (
    <section
      className="lookalike-recent"
      aria-labelledby="lookalike-recent-title"
    >
      <h3 id="lookalike-recent-title">Recent modeled audiences</h3>
      <div className="lookalike-recent-list">
        {items.map((audience) => (
          <button
            key={audience.id}
            type="button"
            className="lookalike-recent-item"
            onClick={() => onOpen(audience)}
          >
            <span>
              <strong>{audience.name || "Lookalike audience"}</strong>
              <small>
                {audience.member_count.toLocaleString()} members ·{" "}
                {audience.seed_count.toLocaleString()} seed
              </small>
            </span>
            <span
              className={`badge ${audience.status === "ready" ? "success" : audience.status === "failed" ? "danger" : "accent"}`}
            >
              {audience.status}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

interface OutcomeProps {
  outcomeRef: RefObject<HTMLDivElement | null>;
  result: SubscriberLookalikeAudience;
  phase: GenerationPhase;
  generationError: string | null;
  canMutate: boolean;
  operationActive: boolean;
  destinations: AudienceDestination[];
  destinationsErr: string | null;
  destId: string;
  setDestId: (value: string) => void;
  exporting: boolean;
  exportError: string | null;
  onRecordDestination: () => Promise<void>;
  onResume: () => Promise<void>;
  onStop: () => void;
  onStartAnother: () => void;
  onDelete: () => void;
  onClose: () => void;
}

function LookalikeOutcome(props: OutcomeProps): ReactElement {
  const pending =
    props.result.status === "pending" || props.result.status === "running";
  const ready = props.result.status === "ready";
  const failed = props.result.status === "failed";
  const candidates = aggregateCount(props.result, "candidate_count");
  const scored = aggregateCount(props.result, "scored");
  const features = featureLabels(props.result);
  return (
    <>
      <div
        ref={props.outcomeRef}
        className="lookalike-outcome"
        tabIndex={-1}
        role={failed ? "alert" : "status"}
        aria-live="polite"
      >
        <div className="lookalike-outcome-heading">
          <div>
            <div className="lookalike-disclosure-kicker">Model status</div>
            <h3>
              {ready
                ? "Audience materialized"
                : failed
                  ? "Generation failed"
                  : "Generation in progress"}
            </h3>
          </div>
          <span
            className={`badge ${ready ? "success" : failed ? "danger" : "accent"}`}
          >
            {props.phase === "cancelled"
              ? "status check stopped"
              : props.result.status}
          </span>
        </div>

        {pending ? (
          <div className="lookalike-job-state">
            <div className="lookalike-pulse" aria-hidden="true" />
            <div>
              <strong>
                {props.phase === "polling"
                  ? "Checking server status…"
                  : "The server may still be processing this audience."}
              </strong>
              <p>
                {props.generationError ??
                  "You can stop checking without cancelling the server-side job, then resume from this saved audience."}
              </p>
            </div>
          </div>
        ) : failed ? (
          <div className="lookalike-error">
            <strong>No audience is ready to activate.</strong>
            <span>
              {props.generationError ||
                props.result.error ||
                "The model failed without a public error detail."}
            </span>
          </div>
        ) : props.result.member_count === 0 ? (
          <div className="notice" role="status">
            No candidates met the current confidence floor. No destination
            handoff is available. Lower the floor or choose a broader eligible
            seed and generate a new audience.
          </div>
        ) : (
          <div className="lookalike-stat-grid">
            <OutcomeStat
              label="Modeled members"
              value={props.result.member_count}
            />
            <OutcomeStat label="Seed members" value={props.result.seed_count} />
            <OutcomeStat label="Candidate pool" value={candidates} />
            <OutcomeStat label="Passed floor" value={scored} />
          </div>
        )}
      </div>

      {ready ? (
        <>
          <section
            className="lookalike-evidence"
            aria-labelledby="lookalike-evidence-title"
          >
            <div className="lookalike-section-heading">
              <div>
                <h3 id="lookalike-evidence-title">Aggregate model evidence</h3>
                <p>
                  No subscriber identities or raw feature snapshots are loaded
                  in this view.
                </p>
              </div>
              <span className="badge">{props.result.model_version}</span>
            </div>
            <div className="lookalike-band-grid">
              {(
                [
                  ["high", "High", "≥ 0.80"],
                  ["medium", "Medium", "0.50–0.79"],
                  ["low", "Low", "< 0.50"],
                ] as const
              ).map(([key, label, range]) => {
                const count = bandCount(props.result, key);
                const percentage =
                  props.result.member_count > 0
                    ? Math.round((count / props.result.member_count) * 100)
                    : 0;
                return (
                  <div key={key} className="lookalike-band">
                    <span>
                      <strong>{label}</strong>
                      <small>{range}</small>
                    </span>
                    <strong className="tabular">
                      {count.toLocaleString()}
                    </strong>
                    <div className="lookalike-band-track" aria-hidden="true">
                      <span
                        style={{ width: `${Math.min(100, percentage)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            {features.length > 0 ? (
              <div className="lookalike-signals">
                <span>Signals used</span>
                {features.map((feature) => (
                  <span key={feature} className="badge">
                    {feature}
                  </span>
                ))}
              </div>
            ) : null}
          </section>

          {props.result.member_count > 0 ? (
            <section
              className="lookalike-destination"
              aria-labelledby="lookalike-destination-title"
            >
              <div className="lookalike-section-heading">
                <div>
                  <h3 id="lookalike-destination-title">Destination handoff</h3>
                  <p>
                    Record a configured destination association. This does not
                    start or prove provider delivery.
                  </p>
                </div>
              </div>
              {props.result.exported_destination_id ? (
                <div className="lookalike-handoff-status" role="status">
                  <strong>Destination recorded</strong>
                  <span>
                    Run and monitor the separate delivery from Audience Syncs.
                    This screen does not claim that subscriber data was
                    delivered.
                  </span>
                </div>
              ) : props.destinationsErr ? (
                <div className="notice" role="alert">
                  Couldn&apos;t load destinations: {props.destinationsErr}
                </div>
              ) : props.destinations.length === 0 ? (
                <div className="notice" role="status">
                  No configured audience destinations are available. Create one
                  in Audience Syncs before recording a handoff.
                </div>
              ) : (
                <div className="lookalike-destination-controls">
                  <label
                    className="field-label"
                    htmlFor="lookalike-destination"
                  >
                    Configured destination
                  </label>
                  <select
                    id="lookalike-destination"
                    className="input"
                    value={props.destId}
                    onChange={(event) => props.setDestId(event.target.value)}
                    disabled={props.operationActive}
                  >
                    <option value="">Choose a destination…</option>
                    {props.destinations.map((destination) => (
                      <option key={destination.id} value={destination.id}>
                        {destinationLabel(destination)}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void props.onRecordDestination()}
                    disabled={
                      props.operationActive ||
                      props.exporting ||
                      !props.destId ||
                      !props.canMutate
                    }
                  >
                    {props.exporting ? "Recording…" : "Record destination"}
                  </button>
                </div>
              )}
              {props.exportError ? (
                <div className="field-error" role="alert">
                  {props.exportError}
                </div>
              ) : null}
              {!props.canMutate ? (
                <div className="field-help">
                  Viewer access can inspect this handoff, but an editor-scoped
                  session is required to change it.
                </div>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}

      <ModalFooter>
        {pending && props.phase === "polling" ? (
          <button type="button" className="btn" onClick={props.onStop}>
            Stop checking
          </button>
        ) : pending ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void props.onResume()}
            disabled={props.operationActive}
          >
            Check status
          </button>
        ) : null}
        {failed || (ready && props.result.member_count === 0) ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={props.onStartAnother}
            disabled={props.operationActive}
          >
            Start another model
          </button>
        ) : null}
        {(ready || failed) && props.canMutate ? (
          <button
            type="button"
            className="btn btn-danger"
            onClick={props.onDelete}
            disabled={props.operationActive}
          >
            Delete audience
          </button>
        ) : null}
        <button
          type="button"
          className="btn"
          onClick={props.onClose}
          disabled={props.operationActive}
        >
          Done
        </button>
      </ModalFooter>
    </>
  );
}

function OutcomeStat({
  label,
  value,
}: {
  label: string;
  value: number | null;
}): ReactElement {
  return (
    <div className="lookalike-stat">
      <span>{label}</span>
      <strong className="tabular">
        {value == null ? "Not reported" : value.toLocaleString()}
      </strong>
    </div>
  );
}
