/**
 * LookalikeModal — SUB-033 lookalike-audience generation.
 *
 * Opens from the Segments page "Create lookalike" action. The operator
 * picks a SEED segment (filtered to segments with >= 50 members so the
 * centroid is stable), a target size (100–10,000, default 1,000) and an
 * optional confidence-threshold floor (0.5–1.0, default 0.8). On submit we
 * POST /api/v1/audiences/lookalike, which ranks non-seed subscribers by
 * first-party similarity to the seed members (email domain, signup source,
 * engagement tier, churn tier ONLY — no third-party data) and materialises
 * the top-N as a read-only audience.
 *
 * After creation the modal switches to a read-only result card showing the
 * realised member count, seed reference, model confidence, and creation
 * date, mirroring the saved-segment UX. Export/activate flows reuse the
 * standard segment surfaces (the audience persists as a materialised list).
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
  type LookalikeModel,
  LOOKALIKE_DEFAULT_SIZE,
  LOOKALIKE_MAX_SIZE,
  LOOKALIKE_MIN_SIZE,
  createLookalikeAudience,
} from "../../lib/api-client";
import { type Segment } from "../segments/segmentsClient";
import { fmtDateTime } from "../../lib/format-date";
import { usePersistentLifecycleOperation } from "../../hooks/usePersistentLifecycleOperation";
import {
  lifecycleOperationError,
  useDiscardOnlyDraftLifecycle,
} from "../../hooks/useSettingsDraftLifecycle";
import { ConfirmModal } from "../ConfirmModal";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";

/** Minimum seed-segment membership before the centroid is stable enough. */
const MIN_SEED_MEMBERS = 50;
const CREATE_DESCRIPTION =
  "Build an audience of subscribers most similar to a seed segment using first-party email, signup, engagement, and churn signals only.";
const RESULT_DESCRIPTION =
  "This materialized audience is ready to target from a campaign or flow like any saved segment.";

interface LookalikeResultProps {
  result: LookalikeModel;
  seedName: string;
  doneButtonRef: RefObject<HTMLButtonElement | null>;
  busy: boolean;
  onClose: () => void;
}

function LookalikeResult({
  result,
  seedName,
  doneButtonRef,
  busy,
  onClose,
}: LookalikeResultProps): ReactElement {
  return (
    <>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 10,
          marginTop: 14,
        }}
      >
        <ResultStat
          label="Members"
          value={result.member_count.toLocaleString()}
        />
        <ResultStat
          label="Requested"
          value={result.size_requested.toLocaleString()}
        />
        <ResultStat
          label="Seed members"
          value={result.seed_count.toLocaleString()}
        />
        <ResultStat
          label="Confidence floor"
          value={
            typeof result.confidence_threshold === "number"
              ? result.confidence_threshold.toFixed(2)
              : "None"
          }
        />
      </div>

      <div
        className="muted"
        style={{
          fontSize: 11,
          marginTop: 12,
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        <span>Seed segment: {seedName}</span>
        <span>Model: {result.model_version}</span>
        <span>Status: {result.status}</span>
        {result.created_at ? (
          <span>Created {fmtDateTime(result.created_at)}</span>
        ) : null}
      </div>

      <ModalFooter>
        <button
          ref={doneButtonRef}
          type="button"
          className="btn btn-primary"
          onClick={onClose}
          disabled={busy}
          aria-busy={busy ? "true" : undefined}
        >
          Done
        </button>
      </ModalFooter>
    </>
  );
}

export function LookalikeModal({
  segments,
  canMutate,
  onClose,
  onCreated,
}: {
  segments: Segment[];
  canMutate: boolean;
  onClose: () => void;
  onCreated?: (model: LookalikeModel) => void;
}): ReactElement {
  const activeRef = useRef(true);
  const resultActionRef = useRef<HTMLButtonElement | null>(null);
  // Eligible seeds: segments with a known membership >= the floor. Segments
  // whose count is unknown (never evaluated) are excluded — we can't promise
  // a stable centroid without a count.
  const eligible = useMemo<Segment[]>(
    () =>
      segments.filter(
        (s) =>
          typeof s.lastCount === "number" && s.lastCount >= MIN_SEED_MEMBERS,
      ),
    [segments],
  );

  const [seedId, setSeedId] = useState<string>(eligible[0]?.id ?? "");
  const [name, setName] = useState("");
  const [size, setSize] = useState<number>(LOOKALIKE_DEFAULT_SIZE);
  const [useThreshold, setUseThreshold] = useState(true);
  const [threshold, setThreshold] = useState(0.8);
  const [dataUseAcknowledged, setDataUseAcknowledged] = useState(false);
  const [result, setResult] = useState<LookalikeModel | null>(null);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const operation = usePersistentLifecycleOperation({
    ownerId: "segments-lookalike-create",
    label: "Lookalike audience generation",
  });

  const seedSegment = useMemo(
    () => eligible.find((s) => s.id === seedId) ?? null,
    [eligible, seedId],
  );

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!eligible.some((segment) => segment.id === seedId)) {
      setSeedId(eligible[0]?.id ?? "");
    }
  }, [eligible, seedId]);

  useEffect(() => {
    if (result && !operation.active) resultActionRef.current?.focus();
  }, [operation.active, result]);

  const draftDirty =
    result === null &&
    (seedId !== (eligible[0]?.id ?? "") ||
      name !== "" ||
      size !== LOOKALIKE_DEFAULT_SIZE ||
      !useThreshold ||
      threshold !== 0.8 ||
      dataUseAcknowledged);

  const discardDraft = useCallback((): void => {
    setSeedId(eligible[0]?.id ?? "");
    setName("");
    setSize(LOOKALIKE_DEFAULT_SIZE);
    setUseThreshold(true);
    setThreshold(0.8);
    setDataUseAcknowledged(false);
    setDiscardConfirmOpen(false);
  }, [eligible]);

  useDiscardOnlyDraftLifecycle({
    ownerId: "segments-lookalike-create",
    label: "Lookalike audience draft",
    dirty: draftDirty,
    operationRef: operation.promiseRef,
    discard: discardDraft,
    detail:
      "This lookalike generation draft has not been submitted. Return to it or explicitly discard it.",
  });

  const submit = async (): Promise<void> => {
    if (!canMutate || !seedId || !dataUseAcknowledged) return;
    const pending = operation.run(() =>
      createLookalikeAudience({
        name: name.trim() || undefined,
        seed_segment_id: seedId,
        size,
        confidence_threshold: useThreshold ? threshold : null,
        data_use_acknowledged: true,
      }),
    );
    if (!pending) return;
    try {
      const res = await pending;
      if (!activeRef.current) return;
      if (res.error) {
        toast.error(
          res.error.status === 403 || res.error.code === "forbidden"
            ? "Creating a lookalike needs a write role."
            : `Couldn't create lookalike: ${res.error.message}`,
        );
        return;
      }
      setResult(res.data);
      setDiscardConfirmOpen(false);
      try {
        onCreated?.(res.data);
      } catch (refreshError) {
        toast.error({
          message: "Lookalike created, but the audience list couldn't refresh",
          detail: lifecycleOperationError(
            refreshError,
            "Refresh the audience list to see the generated audience.",
          ),
        });
      }
      toast.success(
        `Lookalike "${res.data.name || "audience"}" created — ${res.data.member_count.toLocaleString()} members`,
      );
    } catch (reason) {
      if (activeRef.current) {
        toast.error(
          `Couldn't create lookalike: ${lifecycleOperationError(
            reason,
            "The generation request failed.",
          )}`,
        );
      }
    }
  };

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

  return (
    <>
      <Modal
        open
        onClose={requestClose}
        title={
          result?.name ||
          (result ? "Lookalike audience created" : "Create lookalike audience")
        }
        description={result ? RESULT_DESCRIPTION : CREATE_DESCRIPTION}
        size="md"
        closeOnBackdrop={!operation.active}
        closeOnEscape={!operation.active}
        closeDisabled={operation.active}
      >
        {result ? (
          <LookalikeResult
            result={result}
            seedName={seedSegment?.name ?? result.seed_segment_id}
            doneButtonRef={resultActionRef}
            busy={operation.active}
            onClose={requestClose}
          />
        ) : (
          <LookalikeCreateForm
            eligible={eligible}
            seedId={seedId}
            setSeedId={setSeedId}
            seedSegment={seedSegment}
            name={name}
            setName={setName}
            size={size}
            setSize={setSize}
            useThreshold={useThreshold}
            setUseThreshold={setUseThreshold}
            threshold={threshold}
            setThreshold={setThreshold}
            dataUseAcknowledged={dataUseAcknowledged}
            setDataUseAcknowledged={setDataUseAcknowledged}
            canMutate={canMutate}
            busy={operation.active}
            onClose={requestClose}
            onSubmit={submit}
          />
        )}
      </Modal>
      <ConfirmModal
        open={discardConfirmOpen}
        title="Discard lookalike draft?"
        description="The seed, target size, name, and confidence settings in this draft will be lost."
        confirmLabel="Discard draft"
        danger
        busy={operation.active}
        onConfirm={discardAndClose}
        onClose={() => setDiscardConfirmOpen(false)}
      />
    </>
  );
}

interface LookalikeCreateFormProps {
  eligible: Segment[];
  seedId: string;
  setSeedId: (id: string) => void;
  seedSegment: Segment | null;
  name: string;
  setName: (name: string) => void;
  size: number;
  setSize: (size: number) => void;
  useThreshold: boolean;
  setUseThreshold: (enabled: boolean) => void;
  threshold: number;
  setThreshold: (threshold: number) => void;
  dataUseAcknowledged: boolean;
  setDataUseAcknowledged: (acknowledged: boolean) => void;
  canMutate: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: () => Promise<void>;
}

function LookalikeCreateForm({
  eligible,
  seedId,
  setSeedId,
  seedSegment,
  name,
  setName,
  size,
  setSize,
  useThreshold,
  setUseThreshold,
  threshold,
  setThreshold,
  dataUseAcknowledged,
  setDataUseAcknowledged,
  canMutate,
  busy,
  onClose,
  onSubmit,
}: LookalikeCreateFormProps): ReactElement {
  const createGuidanceId = useId();
  const createUnavailable =
    !canMutate || !seedId || eligible.length === 0 || !dataUseAcknowledged;
  const createGuidance = !canMutate
    ? "Viewer access can configure this draft but cannot create an audience. An editor-scoped session is required."
    : eligible.length === 0
      ? `Evaluate a segment with at least ${MIN_SEED_MEMBERS} members before creating a lookalike.`
      : !seedId
        ? "Choose an eligible seed segment before creating the lookalike."
        : !dataUseAcknowledged
          ? "Review and acknowledge the first-party data-use notice before creating the lookalike."
          : "Creates a materialized audience by ranking subscribers against the selected seed.";
  return (
    <>
      {eligible.length === 0 ? (
        <div className="notice" style={{ fontSize: 12, marginTop: 12 }}>
          No eligible seed segments. A seed needs at least {MIN_SEED_MEMBERS}
          members with a known count. Evaluate a segment (recompute) first, then
          try again.
        </div>
      ) : (
        <LookalikeControls
          eligible={eligible}
          seedId={seedId}
          setSeedId={setSeedId}
          seedSegment={seedSegment}
          name={name}
          setName={setName}
          size={size}
          setSize={setSize}
          useThreshold={useThreshold}
          setUseThreshold={setUseThreshold}
          threshold={threshold}
          setThreshold={setThreshold}
          dataUseAcknowledged={dataUseAcknowledged}
          setDataUseAcknowledged={setDataUseAcknowledged}
          busy={busy}
        />
      )}
      <p
        id={createGuidanceId}
        className="muted"
        role="status"
        style={{ fontSize: 11, margin: "12px 0 0" }}
      >
        {createGuidance}
      </p>
      <ModalFooter>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onClose}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            if (!createUnavailable) void onSubmit();
          }}
          disabled={busy}
          aria-disabled={createUnavailable || undefined}
          aria-describedby={createGuidanceId}
          aria-busy={busy ? "true" : undefined}
        >
          {busy ? "Generating…" : "Create lookalike"}
        </button>
      </ModalFooter>
    </>
  );
}

type LookalikeControlsProps = Omit<
  LookalikeCreateFormProps,
  "canMutate" | "onClose" | "onSubmit"
>;

function LookalikeControls({
  eligible,
  seedId,
  setSeedId,
  seedSegment,
  name,
  setName,
  size,
  setSize,
  useThreshold,
  setUseThreshold,
  threshold,
  setThreshold,
  dataUseAcknowledged,
  setDataUseAcknowledged,
  busy,
}: LookalikeControlsProps): ReactElement {
  return (
    <>
      <label
        htmlFor="lookalike-seed"
        style={{
          display: "block",
          fontSize: 13,
          fontWeight: 600,
          marginTop: 12,
        }}
      >
        Seed segment
      </label>
      <select
        id="lookalike-seed"
        className="input"
        style={{ width: "100%", marginTop: 4 }}
        value={seedId}
        onChange={(event) => setSeedId(event.target.value)}
        disabled={busy}
        aria-label="Seed segment"
      >
        {eligible.map((segment) => (
          <option key={segment.id} value={segment.id}>
            {segment.name} ({(segment.lastCount ?? 0).toLocaleString()} members)
          </option>
        ))}
      </select>
      <label
        htmlFor="lookalike-name"
        style={{
          display: "block",
          fontSize: 13,
          fontWeight: 600,
          marginTop: 14,
        }}
      >
        Audience name (optional)
      </label>
      <input
        id="lookalike-name"
        className="input"
        style={{ width: "100%", marginTop: 4 }}
        value={name}
        onChange={(event) => setName(event.target.value)}
        disabled={busy}
        placeholder={
          seedSegment ? `Lookalike of ${seedSegment.name}` : "Lookalike"
        }
        aria-label="Audience name"
      />
      <label
        style={{
          display: "block",
          fontSize: 13,
          fontWeight: 600,
          marginTop: 14,
        }}
      >
        Target size: {size.toLocaleString()}
      </label>
      <input
        type="range"
        min={LOOKALIKE_MIN_SIZE}
        max={LOOKALIKE_MAX_SIZE}
        step={100}
        value={size}
        onChange={(event) => setSize(Number(event.target.value))}
        disabled={busy}
        style={{ width: "100%" }}
        aria-label="Target size"
      />
      <div className="muted" style={{ fontSize: 11 }}>
        {LOOKALIKE_MIN_SIZE.toLocaleString()}–
        {LOOKALIKE_MAX_SIZE.toLocaleString()}. The ranker returns up to this
        many members, fewer if the confidence floor drops candidates.
      </div>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 13,
          fontWeight: 600,
          marginTop: 14,
        }}
      >
        <input
          type="checkbox"
          checked={useThreshold}
          onChange={(event) => setUseThreshold(event.target.checked)}
          disabled={busy}
          aria-label="Apply confidence threshold"
        />
        Confidence threshold{useThreshold ? `: ${threshold.toFixed(2)}` : ""}
      </label>
      {useThreshold ? (
        <>
          <input
            type="range"
            min={0.5}
            max={1}
            step={0.05}
            value={threshold}
            onChange={(event) => setThreshold(Number(event.target.value))}
            disabled={busy}
            style={{ width: "100%" }}
            aria-label="Confidence threshold"
          />
          <div className="muted" style={{ fontSize: 11 }}>
            0.50–1.00. Candidates below this similarity floor are dropped —
            higher means a smaller, more precise audience.
          </div>
        </>
      ) : (
        <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
          No floor — take the top {size.toLocaleString()} by similarity.
        </div>
      )}
      <div
        className="lookalike-disclosure"
        style={{ position: "static", marginTop: 14 }}
      >
        <div className="lookalike-disclosure-kicker">First-party model</div>
        <h3>Data-use acknowledgement</h3>
        <p>
          Similarity uses email domain, signup source, engagement score, and
          retention/churn score. Ranked subscriber identifiers and emails are
          materialized in this workspace; message content, third-party broker
          data, and cross-site browsing activity are not model inputs.
        </p>
        <label className="lookalike-acknowledgement">
          <input
            type="checkbox"
            checked={dataUseAcknowledged}
            onChange={(event) => setDataUseAcknowledged(event.target.checked)}
            disabled={busy}
          />
          <span>
            I understand this data use and confirm I am authorized to model this
            first-party subscriber audience.
          </span>
        </label>
      </div>
    </>
  );
}

function ResultStat({
  label,
  value,
}: {
  label: string;
  value: string;
}): ReactElement {
  return (
    <div
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 8,
        padding: "8px 10px",
      }}
    >
      <div className="muted" style={{ fontSize: 11 }}>
        {label}
      </div>
      <div className="tabular" style={{ fontSize: 16, fontWeight: 600 }}>
        {value}
      </div>
    </div>
  );
}
