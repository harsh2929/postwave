import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { InlineHelp } from "../../components/InlineHelp";
import { ConfirmModal } from "../../components/ConfirmModal";
import { AssetPicker } from "../../components/library/AssetPicker";
import { Modal, ModalFooter } from "../../components/Modal";
import { Notice } from "../../components/Notice";
import { toast } from "../../components/Toast";
import { type ReferralProgram, api } from "../../lib/api-client";
import { usePersistentLifecycleOperation } from "../../hooks/usePersistentLifecycleOperation";
import {
  lifecycleOperationError,
  useDiscardOnlyDraftLifecycle,
  useExistingSettingLifecycle,
} from "../../hooks/useSettingsDraftLifecycle";
import {
  DEFAULT_REFERRAL_DRAFTS,
  type DraftMilestone,
  expiryIso,
  isoDateValue,
  MAX_REFERRAL_COUNT,
  MAX_REFERRAL_MILESTONES,
  MAX_REFERRAL_REWARD_LABEL_CHARS,
  milestoneDraft,
  programReplaceFields,
  type RewardKind,
  validateReferralDrafts,
} from "./referral-program";

interface ProgramEditorProps {
  canMutate: boolean;
  focusRow?: number | null;
  onClose: () => void;
  onSaved: () => void;
  open: boolean;
  program: ReferralProgram | null;
}

function freshDefaults(): DraftMilestone[] {
  return DEFAULT_REFERRAL_DRAFTS.map((draft) => ({ ...draft }));
}

interface ProgramDraftBaseline {
  drafts: DraftMilestone[];
  expiresDate: string;
}

function cloneDrafts(drafts: DraftMilestone[]): DraftMilestone[] {
  return drafts.map((draft) => ({ ...draft }));
}

function sameProgramDraft(
  drafts: DraftMilestone[],
  expiresDate: string,
  baseline: ProgramDraftBaseline,
): boolean {
  return (
    expiresDate === baseline.expiresDate &&
    JSON.stringify(drafts) === JSON.stringify(baseline.drafts)
  );
}

function ProgramMilestoneFields({
  drafts,
  expiresDate,
  fieldPrefix,
  locked,
  operationActive,
  permissionReasonId,
  onAddRow,
  onExpiresDateChange,
  onPickImage,
  onRemoveRow,
  onUpdateRow,
}: {
  drafts: DraftMilestone[];
  expiresDate: string;
  fieldPrefix: string;
  locked: boolean;
  operationActive: boolean;
  permissionReasonId: string;
  onAddRow: () => void;
  onExpiresDateChange: (value: string) => void;
  onPickImage: (index: number) => void;
  onRemoveRow: (index: number) => void;
  onUpdateRow: (index: number, patch: Partial<DraftMilestone>) => void;
}): ReactElement {
  return (
    <>
      <div className="field" style={{ marginBottom: 12 }}>
        <label className="field-label" htmlFor={`${fieldPrefix}-expires`}>
          Intended program end (optional)
          <InlineHelp text="Stored as a UTC end-of-day configuration value. Runtime expiry enforcement is review-gated and this editor remains unavailable until every referral consumer shares the same effective-program rule." />
        </label>
        <input
          id={`${fieldPrefix}-expires`}
          type="date"
          className="input"
          value={expiresDate}
          disabled={locked}
          aria-describedby={locked ? permissionReasonId : undefined}
          onChange={(event) => onExpiresDateChange(event.target.value)}
        />
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          Leave blank for an open-ended intent. This date does not currently
          activate or stop public referral behavior.
        </div>
      </div>

      <div className="field">
        <div className="field-label" id={`${fieldPrefix}-milestones-label`}>
          Milestones
          <InlineHelp text="Each row defines a threshold. The reward unlocks when a subscriber's referral count reaches that many people who themselves became subscribers. Thresholds must be unique." />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {drafts.map((draft, index) => (
            <fieldset
              key={index}
              aria-labelledby={`${fieldPrefix}-milestone-${index}`}
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(min(100%, 10rem), 1fr))",
                gap: 8,
                alignItems: "end",
                minWidth: 0,
                padding: 12,
                border: "1px solid var(--pw-border)",
                borderRadius: 8,
              }}
            >
              <legend
                id={`${fieldPrefix}-milestone-${index}`}
                style={{ fontWeight: 600, paddingInline: 4 }}
              >
                Milestone {index + 1}
              </legend>
              <label className="field-label">
                Referrals needed
                <input
                  type="number"
                  aria-label={`Milestone ${index + 1} referral count`}
                  min={1}
                  max={MAX_REFERRAL_COUNT}
                  step={1}
                  className="input tabular"
                  placeholder="0"
                  value={draft.count}
                  disabled={locked}
                  aria-describedby={locked ? permissionReasonId : undefined}
                  onChange={(event) =>
                    onUpdateRow(index, { count: event.target.value })
                  }
                />
              </label>
              <label className="field-label">
                Reward type
                <select
                  className="input"
                  aria-label={`Milestone ${index + 1} reward type`}
                  value={draft.kind}
                  disabled={locked}
                  aria-describedby={locked ? permissionReasonId : undefined}
                  onChange={(event) =>
                    onUpdateRow(index, {
                      kind: event.target.value as RewardKind,
                    })
                  }
                >
                  <option value="swag">Branded swag</option>
                  <option value="free">Free time</option>
                  <option value="annual">Annual / lifetime</option>
                  <option value="custom">Custom</option>
                </select>
              </label>
              <label className="field-label">
                Reward label
                <input
                  id={`${fieldPrefix}-ms-label-${index}`}
                  type="text"
                  aria-label={`Milestone ${index + 1} reward label`}
                  className="input"
                  placeholder="Reward label"
                  maxLength={MAX_REFERRAL_REWARD_LABEL_CHARS}
                  value={draft.label}
                  disabled={locked}
                  aria-describedby={locked ? permissionReasonId : undefined}
                  onChange={(event) =>
                    onUpdateRow(index, { label: event.target.value })
                  }
                />
              </label>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={operationActive}
                  aria-disabled={locked}
                  aria-describedby={locked ? permissionReasonId : undefined}
                  onClick={() => {
                    if (!locked) onPickImage(index);
                  }}
                >
                  {draft.imageAssetId ? "Change image" : "Choose image"}
                </button>
                <span className="muted" style={{ fontSize: 12 }}>
                  {draft.imageAssetId ? "Reward image selected" : "No image"}
                </span>
              </div>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => onRemoveRow(index)}
                aria-label={`Remove milestone ${index + 1}`}
                aria-disabled={locked || drafts.length <= 1}
                aria-describedby={
                  locked
                    ? permissionReasonId
                    : drafts.length <= 1
                      ? `${fieldPrefix}-milestone-minimum`
                      : undefined
                }
                disabled={operationActive}
              >
                Remove milestone
              </button>
            </fieldset>
          ))}
        </div>
        <p
          id={`${fieldPrefix}-milestone-minimum`}
          className="muted"
          style={{ fontSize: 12, margin: "8px 0 0" }}
        >
          {drafts.length} of {MAX_REFERRAL_MILESTONES} milestones. A program
          must keep at least one milestone.
        </p>
        <button
          type="button"
          className="btn btn-sm"
          onClick={onAddRow}
          disabled={operationActive}
          aria-disabled={locked || drafts.length >= MAX_REFERRAL_MILESTONES}
          aria-describedby={
            locked ? permissionReasonId : `${fieldPrefix}-milestone-minimum`
          }
          style={{ marginTop: 8 }}
        >
          + Add milestone
        </button>
      </div>
    </>
  );
}

interface ProgramEditorSurfaceProps {
  canMutate: boolean;
  discardConfirmOpen: boolean;
  drafts: DraftMilestone[];
  expiresDate: string;
  fieldPrefix: string;
  locked: boolean;
  operationActive: boolean;
  open: boolean;
  permissionReasonId: string;
  pickingRow: number;
  program: ReferralProgram | null;
  submitError: string | null;
  submitting: boolean;
  onAddRow: () => void;
  onAssetPick: (asset: { id: string }) => void;
  onDiscard: () => void;
  onDiscardConfirmClose: () => void;
  onExpiresDateChange: (value: string) => void;
  onPickImage: (index: number) => void;
  onPickerClose: () => void;
  onRemoveRow: (index: number) => void;
  onRequestClose: () => void;
  onSubmit: () => void;
  onUpdateRow: (index: number, patch: Partial<DraftMilestone>) => void;
}

function ProgramEditorSurface({
  canMutate,
  discardConfirmOpen,
  drafts,
  expiresDate,
  fieldPrefix,
  locked,
  operationActive,
  open,
  permissionReasonId,
  pickingRow,
  program,
  submitError,
  submitting,
  onAddRow,
  onAssetPick,
  onDiscard,
  onDiscardConfirmClose,
  onExpiresDateChange,
  onPickImage,
  onPickerClose,
  onRemoveRow,
  onRequestClose,
  onSubmit,
  onUpdateRow,
}: ProgramEditorSurfaceProps): ReactElement {
  return (
    <Modal
      open={open}
      onClose={onRequestClose}
      title={program ? "Edit referral program" : "Create referral program"}
      description="Each milestone unlocks a reward when a subscriber refers that many people."
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (canMutate && !operationActive) onSubmit();
        }}
        onKeyDownCapture={(event) => {
          if (
            event.key === "Enter" &&
            (event.nativeEvent.isComposing || event.keyCode === 229)
          ) {
            event.preventDefault();
          }
        }}
      >
        <ProgramMilestoneFields
          drafts={drafts}
          expiresDate={expiresDate}
          fieldPrefix={fieldPrefix}
          locked={locked}
          operationActive={operationActive}
          permissionReasonId={permissionReasonId}
          onAddRow={onAddRow}
          onExpiresDateChange={onExpiresDateChange}
          onPickImage={onPickImage}
          onRemoveRow={onRemoveRow}
          onUpdateRow={onUpdateRow}
        />

        {!canMutate ? (
          <div id={permissionReasonId}>
            <Notice tone="neutral" announcement="polite">
              Referral program administration is restricted to workspace admins.
              You can inspect milestones, reward images, and the program end
              date.
            </Notice>
          </div>
        ) : operationActive ? (
          <div id={permissionReasonId} className="muted" role="status">
            Saving the referral program. Editing and closing resume when the
            request finishes.
          </div>
        ) : null}

        {submitError ? (
          <div className="field-error" role="alert">
            {submitError}
          </div>
        ) : null}

        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={onRequestClose}
            disabled={operationActive}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={operationActive}
            aria-disabled={!canMutate || operationActive}
            aria-describedby={!canMutate ? permissionReasonId : undefined}
          >
            {submitting
              ? "Saving…"
              : program
                ? "Save changes"
                : "Create program"}
          </button>
        </ModalFooter>
      </form>

      <AssetPicker
        open={pickingRow >= 0 && !locked}
        onClose={onPickerClose}
        onPick={onAssetPick}
      />
      <ConfirmModal
        open={discardConfirmOpen}
        title="Discard referral program changes?"
        description="The milestone rows, reward images, and program expiry have not been saved."
        confirmLabel="Discard changes"
        danger
        onConfirm={onDiscard}
        onClose={onDiscardConfirmClose}
      />
    </Modal>
  );
}

export function ProgramEditor({
  canMutate,
  focusRow,
  onClose,
  onSaved,
  open,
  program,
}: ProgramEditorProps): ReactElement {
  const [drafts, setDrafts] = useState<DraftMilestone[]>(freshDefaults);
  const [expiresDate, setExpiresDate] = useState("");
  const [pickingRow, setPickingRow] = useState(-1);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [baseline, setBaseline] = useState<ProgramDraftBaseline>(() => ({
    drafts: freshDefaults(),
    expiresDate: "",
  }));
  const activeRef = useRef(true);
  const sessionRef = useRef(0);
  const fieldPrefix = useId();
  const permissionReasonId = `${fieldPrefix}-permission-reason`;
  const operation = usePersistentLifecycleOperation({
    ownerId: `referral-program-${program?.id ?? "new"}`,
    label: "Referral program request",
    detail:
      "Wait for the referral program request to finish before leaving Moosewave.",
  });
  const formDirty = open && !sameProgramDraft(drafts, expiresDate, baseline);
  const pickerActive = open && pickingRow >= 0;
  const dirty = formDirty || pickerActive;

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  useEffect(() => {
    sessionRef.current += 1;
    setSubmitting(false);
    setSubmitError(null);
    setDiscardConfirmOpen(false);
    setPickingRow(-1);
    if (!open) return;
    const nextExpiresDate = isoDateValue(program?.expiresAt);
    const nextDrafts = program?.milestones.length
      ? [...program.milestones]
          .sort((left, right) => left.count - right.count)
          .map(milestoneDraft)
      : freshDefaults();
    setExpiresDate(nextExpiresDate);
    setDrafts(nextDrafts);
    setBaseline({
      drafts: cloneDrafts(nextDrafts),
      expiresDate: nextExpiresDate,
    });
  }, [open, program]);

  useEffect(() => {
    if (!open || focusRow == null) return;
    const timer = window.setTimeout(() => {
      const input = document.getElementById(
        `${fieldPrefix}-ms-label-${focusRow}`,
      );
      if (input instanceof HTMLInputElement) {
        input.scrollIntoView({ block: "center" });
        input.focus();
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fieldPrefix, focusRow, open]);

  useEffect(() => {
    if (canMutate) return;
    if (!operation.promiseRef.current) setSubmitting(false);
    setPickingRow(-1);
  }, [canMutate, operation.promiseRef]);

  const locked = operation.active || !canMutate;
  const discardAndClose = useCallback((): void => {
    setDrafts(cloneDrafts(baseline.drafts));
    setExpiresDate(baseline.expiresDate);
    setPickingRow(-1);
    setSubmitError(null);
    setDiscardConfirmOpen(false);
    onClose();
  }, [baseline, onClose]);
  const requestClose = useCallback((): void => {
    if (operation.promiseRef.current) return;
    if (dirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    onClose();
  }, [dirty, onClose, operation.promiseRef]);
  useDiscardOnlyDraftLifecycle({
    ownerId: "referral-program-create",
    label: "Referral program create draft",
    dirty,
    operationRef: operation.promiseRef,
    discard: discardAndClose,
    detail:
      "These referral milestones, rewards, image choices, or expiry have not been created. Return to the editor or explicitly discard them.",
    operationDetail:
      "Wait for the referral program request to finish before leaving Moosewave.",
    enabled: open && program === null,
  });
  useDiscardOnlyDraftLifecycle({
    ownerId: `referral-reward-picker-${program?.id ?? "new"}`,
    label: "Referral reward image selection",
    dirty: pickerActive,
    operationRef: operation.promiseRef,
    discard: () => setPickingRow(-1),
    detail:
      "A referral milestone is waiting for a reward-image selection. Return to the picker or explicitly abandon that selection.",
    operationDetail:
      "Wait for the referral program request to finish before leaving Moosewave.",
    enabled: open && program !== null,
  });

  const updateRow = (index: number, patch: Partial<DraftMilestone>): void => {
    if (locked) return;
    setSubmitError(null);
    setDrafts((rows) =>
      rows.map((row, rowIndex) =>
        rowIndex === index ? { ...row, ...patch } : row,
      ),
    );
  };

  const addRow = (): void => {
    if (locked || drafts.length >= MAX_REFERRAL_MILESTONES) return;
    setSubmitError(null);
    setDrafts((rows) => [...rows, { count: "", kind: "custom", label: "" }]);
  };

  const removeRow = (index: number): void => {
    if (locked || drafts.length <= 1) return;
    setSubmitError(null);
    setDrafts((rows) => rows.filter((_, rowIndex) => rowIndex !== index));
  };

  const submit = async (): Promise<boolean> => {
    if (!open) return false;
    if (operation.promiseRef.current) {
      return (await operation.promiseRef.current) === true;
    }
    if (!canMutate) {
      toast.error("Only workspace admins can save referral programs");
      return false;
    }
    const validation = validateReferralDrafts(drafts);
    if (!validation.ok) {
      setSubmitError(validation.error);
      return false;
    }
    const expiresAt = expiryIso(expiresDate);
    if (expiresAt === undefined) {
      setSubmitError("Program end date is invalid.");
      return false;
    }

    const requestedDrafts = cloneDrafts(drafts);
    const requestedExpiry = expiresDate;
    const requestedSession = sessionRef.current;
    setSubmitting(true);
    setSubmitError(null);
    const request = operation.run(async (): Promise<boolean> => {
      try {
        const result = await api.setReferralProgram({
          milestones: validation.milestones,
          expires_at: expiresAt,
          ...(program
            ? { expected_program_id: program.id }
            : { expect_no_active_program: true }),
          ...programReplaceFields(program),
        });
        if (!activeRef.current || requestedSession !== sessionRef.current) {
          return false;
        }
        if (result.error) {
          setSubmitError(result.error.message);
          return false;
        }
        setBaseline({
          drafts: requestedDrafts,
          expiresDate: requestedExpiry,
        });
        setPickingRow(-1);
        toast.success(program ? "Program updated" : "Program created");
        try {
          onSaved();
        } catch {
          try {
            onClose();
          } catch {
            // The server has already acknowledged the save. A consumer
            // callback failure must not turn that success into a false
            // request error or invite a duplicate retry.
          }
        }
        return true;
      } catch (error) {
        if (activeRef.current && requestedSession === sessionRef.current) {
          setSubmitError(
            lifecycleOperationError(
              error,
              "The referral program request did not complete.",
            ),
          );
        }
        return false;
      } finally {
        if (activeRef.current && requestedSession === sessionRef.current) {
          setSubmitting(false);
        }
      }
    });
    return request ? await request : false;
  };

  useExistingSettingLifecycle({
    ownerId: `referral-program-${program?.id ?? "unknown"}`,
    label: "Referral program settings",
    dirty: formDirty,
    operationRef: operation.promiseRef,
    save: submit,
    discard: discardAndClose,
    detail:
      "These referral milestone, reward, image, or expiry changes have not been saved.",
    operationDetail:
      "Wait for the referral program request to finish before leaving Moosewave.",
    enabled: open && program !== null,
  });

  return (
    <ProgramEditorSurface
      canMutate={canMutate}
      discardConfirmOpen={discardConfirmOpen}
      drafts={drafts}
      expiresDate={expiresDate}
      fieldPrefix={fieldPrefix}
      locked={locked}
      operationActive={operation.active}
      open={open}
      permissionReasonId={permissionReasonId}
      pickingRow={pickingRow}
      program={program}
      submitError={submitError}
      submitting={submitting}
      onAddRow={addRow}
      onAssetPick={(asset) => {
        if (!locked && pickingRow >= 0) {
          updateRow(pickingRow, { imageAssetId: asset.id });
        }
        setPickingRow(-1);
      }}
      onDiscard={discardAndClose}
      onDiscardConfirmClose={() => setDiscardConfirmOpen(false)}
      onExpiresDateChange={(value) => {
        setSubmitError(null);
        setExpiresDate(value);
      }}
      onPickImage={setPickingRow}
      onPickerClose={() => setPickingRow(-1)}
      onRemoveRow={removeRow}
      onRequestClose={requestClose}
      onSubmit={() => void submit()}
      onUpdateRow={updateRow}
    />
  );
}
