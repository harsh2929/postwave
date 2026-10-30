/**
 * SegmentHoldoutConfigModal — configure a holdout (control group) for a
 * segment so the P&L panel can report HOLDOUT-VALIDATED causal lift
 * (feature #4, approved decision D2: the config lives in the P&L panel).
 *
 * POSTs to /api/v1/segments/{id}/holdout. On success the parent refetches
 * its P&L so the lift pillar appears. Honest-UI: the modal explains that
 * a holdout deliberately WITHHOLDS sends from a slice of the segment to
 * measure incremental lift — it never promises a lift number up front.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { ConfirmModal } from "../ConfirmModal";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";
import { usePersistentLifecycleOperation } from "../../hooks/usePersistentLifecycleOperation";
import {
  lifecycleOperationError,
  useDiscardOnlyDraftLifecycle,
} from "../../hooks/useSettingsDraftLifecycle";
import { segmentPnlClient } from "./segmentPnlClient";

const WINDOW_CHOICES = [30, 60, 90, 180] as const;
const HOLDOUT_DESCRIPTION =
  "Withhold a deterministic random slice of this segment to measure incremental messaging lift against the treated group.";

export function SegmentHoldoutConfigModal({
  segmentId,
  onClose,
  onConfigured,
}: {
  segmentId: string;
  onClose: () => void;
  onConfigured: () => void;
}): ReactElement {
  const mountedRef = useRef(true);
  const percentId = useId();
  const windowLabelId = useId();
  const [percent, setPercent] = useState(10);
  const [windowDays, setWindowDays] = useState<number>(90);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const operation = usePersistentLifecycleOperation({
    ownerId: `segment-holdout-${segmentId}`,
    label: "Segment holdout configuration",
  });
  const draftDirty = percent !== 10 || windowDays !== 90;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const discardDraft = useCallback((): void => {
    setPercent(10);
    setWindowDays(90);
    setDiscardConfirmOpen(false);
  }, []);

  useDiscardOnlyDraftLifecycle({
    ownerId: `segment-holdout-${segmentId}`,
    label: "Segment holdout draft",
    dirty: draftDirty,
    operationRef: operation.promiseRef,
    discard: discardDraft,
    detail:
      "This holdout percentage or measurement window has not been submitted. Return to it or explicitly discard it.",
  });

  const save = async (): Promise<void> => {
    const pending = operation.run(() =>
      segmentPnlClient.configureHoldout(segmentId, {
        percent,
        windowDays,
      }),
    );
    if (!pending) return;
    try {
      const res = await pending;
      if (!mountedRef.current) return;
      if (res.error) {
        toast.error(
          res.error.code === "forbidden" || res.error.status === 403
            ? "Configuring a holdout needs an admin role."
            : `Could not configure holdout: ${res.error.message}`,
        );
        return;
      }
      discardDraft();
      toast.success(
        `Holdout set — ${percent}% of this segment will be withheld to measure lift`,
      );
      try {
        onConfigured();
      } catch (refreshError) {
        toast.error({
          message: "Holdout saved, but the report couldn't refresh",
          detail: lifecycleOperationError(
            refreshError,
            "Refresh the segment report to see the saved holdout.",
          ),
        });
      }
      onClose();
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          `Could not configure holdout: ${lifecycleOperationError(
            error,
            "The holdout request failed.",
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
        title="Configure segment holdout"
        description={HOLDOUT_DESCRIPTION}
        size="sm"
        closeOnBackdrop={!operation.active}
        closeOnEscape={!operation.active}
        closeDisabled={operation.active}
      >
        <label
          htmlFor={percentId}
          style={{ display: "block", fontSize: 13, fontWeight: 600 }}
        >
          Holdout percent: {percent}%
        </label>
        <input
          id={percentId}
          type="range"
          min={0}
          max={50}
          step={1}
          value={percent}
          onChange={(event) => setPercent(Number(event.target.value))}
          disabled={operation.active}
          style={{ width: "100%" }}
          aria-describedby={`${percentId}-help`}
        />
        <div
          id={`${percentId}-help`}
          className="muted"
          style={{ fontSize: 11 }}
        >
          0–50%. Larger holdouts measure lift more precisely but withhold more
          revenue from the control group.
        </div>

        <div style={{ marginTop: 14 }}>
          <span id={windowLabelId} style={{ fontSize: 13, fontWeight: 600 }}>
            Measurement window
          </span>
          <div
            role="group"
            aria-labelledby={windowLabelId}
            style={{ display: "flex", gap: 8, marginTop: 6 }}
          >
            {WINDOW_CHOICES.map((days) => (
              <button
                key={days}
                type="button"
                className={`btn btn-sm ${windowDays === days ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setWindowDays(days)}
                disabled={operation.active}
                aria-pressed={windowDays === days}
              >
                {days}d
              </button>
            ))}
          </div>
        </div>

        <ModalFooter>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={requestClose}
            disabled={operation.active}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void save()}
            disabled={operation.active}
            aria-busy={operation.active ? "true" : undefined}
          >
            {operation.active ? "Saving…" : "Save holdout"}
          </button>
        </ModalFooter>
      </Modal>
      <ConfirmModal
        open={discardConfirmOpen}
        title="Discard holdout draft?"
        description="The changed holdout percentage and measurement window will be lost."
        confirmLabel="Discard draft"
        danger
        busy={operation.active}
        onConfirm={discardAndClose}
        onClose={() => setDiscardConfirmOpen(false)}
      />
    </>
  );
}
