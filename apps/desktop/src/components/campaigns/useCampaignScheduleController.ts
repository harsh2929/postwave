import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { usePersistentLifecycleOperation } from "../../hooks/usePersistentLifecycleOperation";
import {
  lifecycleOperationError,
  useDiscardOnlyDraftLifecycle,
} from "../../hooks/useSettingsDraftLifecycle";
import { type Campaign, type CampaignDetail, api } from "../../lib/api-client";
import {
  CAMPAIGN_SCHEDULING_AVAILABLE,
  CAMPAIGN_SCHEDULING_UNAVAILABLE_REASON,
} from "../../lib/campaign-operational-availability";
import { track as trackTelemetry } from "../../lib/telemetry";
import { toast } from "../Toast";

interface CampaignScheduleControllerInput {
  id: Campaign["id"];
  detail: CampaignDetail;
  setDetail: Dispatch<SetStateAction<CampaignDetail>>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  onChange?: (updated: CampaignDetail | null) => void;
  /** Fail-closed preparation that must finish before any schedule is committed. */
  beforeSchedule?: (() => Promise<void>) | undefined;
}

export interface CampaignScheduleController {
  scheduleOpen: boolean;
  setScheduleOpen: Dispatch<SetStateAction<boolean>>;
  scheduleAt: string;
  setScheduleAt: Dispatch<SetStateAction<string>>;
  pstoOn: boolean;
  setPstoOn: Dispatch<SetStateAction<boolean>>;
  pstoWindowStart: string;
  setPstoWindowStart: Dispatch<SetStateAction<string>>;
  pstoWindowEnd: string;
  setPstoWindowEnd: Dispatch<SetStateAction<string>>;
  pstoSaving: boolean;
  scheduleDiscardConfirmOpen: boolean;
  keepScheduleDraft: () => void;
  discardScheduleDraft: () => void;
  schedule: () => Promise<void>;
}

export function useCampaignScheduleController({
  id,
  detail,
  setDetail,
  setBusy,
  onChange,
  beforeSchedule,
}: CampaignScheduleControllerInput): CampaignScheduleController {
  const [scheduleOpen, setScheduleOpenState] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  const [pstoOn, setPstoOn] = useState(false);
  const [pstoWindowStart, setPstoWindowStart] = useState("");
  const [pstoWindowEnd, setPstoWindowEnd] = useState("");
  const [pstoSaving, setPstoSaving] = useState(false);
  const [scheduleDiscardConfirmOpen, setScheduleDiscardConfirmOpen] =
    useState(false);
  const mountedRef = useRef(true);
  const scheduleOpenRef = useRef(scheduleOpen);
  const operation = usePersistentLifecycleOperation({
    ownerId: `campaign-schedule-${String(id ?? "new")}`,
    label: "Campaign scheduling request",
    detail:
      "Wait for the campaign scheduling request to finish before leaving Moosewave.",
  });
  scheduleOpenRef.current = scheduleOpen;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const draftDirty =
    scheduleOpen &&
    Boolean(scheduleAt || pstoOn || pstoWindowStart || pstoWindowEnd);
  const discardScheduleDraft = useCallback((): void => {
    setScheduleAt("");
    setPstoOn(false);
    setPstoWindowStart("");
    setPstoWindowEnd("");
    setScheduleDiscardConfirmOpen(false);
    setScheduleOpenState(false);
  }, []);
  const keepScheduleDraft = useCallback((): void => {
    if (!operation.promiseRef.current) setScheduleDiscardConfirmOpen(false);
  }, [operation.promiseRef]);
  const requestScheduleClose = useCallback((): void => {
    if (operation.promiseRef.current) return;
    if (draftDirty) {
      setScheduleDiscardConfirmOpen(true);
      return;
    }
    discardScheduleDraft();
  }, [discardScheduleDraft, draftDirty, operation.promiseRef]);
  const setScheduleOpen: Dispatch<SetStateAction<boolean>> = useCallback(
    (next): void => {
      const open =
        typeof next === "function" ? next(scheduleOpenRef.current) : next;
      if (open) {
        if (!CAMPAIGN_SCHEDULING_AVAILABLE) return;
        setScheduleDiscardConfirmOpen(false);
        setScheduleOpenState(true);
      } else {
        requestScheduleClose();
      }
    },
    [requestScheduleClose],
  );

  useDiscardOnlyDraftLifecycle({
    ownerId: `campaign-schedule-${String(id ?? "new")}`,
    label: "Campaign schedule draft",
    dirty: draftDirty,
    operationRef: operation.promiseRef,
    discard: discardScheduleDraft,
    detail:
      "This campaign schedule has not been submitted. Return to it or explicitly discard it.",
    operationDetail:
      "Wait for the campaign scheduling request to finish before leaving Moosewave.",
  });

  const validatePersonalizedWindow = (): {
    windowStart: Date;
    windowEnd: Date;
  } | null => {
    if (!pstoWindowStart || !pstoWindowEnd) {
      toast.error("Pick a window start and end");
      return null;
    }
    const windowStart = new Date(pstoWindowStart);
    const windowEnd = new Date(pstoWindowEnd);
    if (
      Number.isNaN(windowStart.getTime()) ||
      Number.isNaN(windowEnd.getTime())
    ) {
      toast.error("Invalid window");
      return null;
    }
    if (windowEnd.getTime() <= windowStart.getTime()) {
      toast.error("Window end must be after start");
      return null;
    }
    if (
      windowEnd.getTime() - windowStart.getTime() >
      30 * 24 * 60 * 60 * 1000
    ) {
      toast.error("Window must be 30 days or shorter");
      return null;
    }
    return { windowStart, windowEnd };
  };

  const schedule = async (): Promise<void> => {
    if (!CAMPAIGN_SCHEDULING_AVAILABLE) {
      toast.error(CAMPAIGN_SCHEDULING_UNAVAILABLE_REASON);
      return;
    }
    if (id == null) return;
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }

    const personalized = pstoOn ? validatePersonalizedWindow() : null;
    if (pstoOn && !personalized) return;
    let scheduledAt: string | null = null;
    if (!pstoOn) {
      if (!scheduleAt) {
        toast.error("Pick a send time first");
        return;
      }
      const scheduled = new Date(scheduleAt);
      if (Number.isNaN(scheduled.getTime())) {
        toast.error("Invalid send time");
        return;
      }
      if (scheduled.getTime() < Date.now() - 60_000) {
        toast.error("Send time must be in the future");
        return;
      }
      scheduledAt = scheduled.toISOString();
    }

    if (pstoOn) setPstoSaving(true);
    else setBusy(true);
    const request = operation.run(async (): Promise<void> => {
      try {
        if (beforeSchedule) await beforeSchedule();
        if (personalized) {
          const result = await api.patchCampaignPSTO(id, {
            per_recipient_optimize: true,
            send_window_start: personalized.windowStart.toISOString(),
            send_window_end: personalized.windowEnd.toISOString(),
          });
          if (!mountedRef.current) return;
          if (result.error) {
            toast.error(`Couldn't set PSTO: ${result.error.message}`);
            return;
          }
          try {
            if (result.data) setDetail(result.data);
            onChange?.(result.data ?? detail);
          } catch {
            // The server commit is authoritative. A parent refresh callback
            // cannot turn it back into a retryable scheduling request.
          }
          discardScheduleDraft();
          toast.success("Per-recipient send scheduled");
          return;
        }

        // POST /schedule owns this field. The previous PATCH carried both
        // `status` and `scheduled_at`, either of which the authoring endpoint
        // refuses outright — so committing a schedule from this modal failed
        // every time. The server derives draft → scheduled itself.
        const result = await api.scheduleCampaign(id, scheduledAt!);
        if (!mountedRef.current) return;
        if (result.error) {
          toast.error(`Couldn't schedule: ${result.error.message}`);
          return;
        }
        if (result.queued) {
          discardScheduleDraft();
          toast.info({
            message: "Schedule change is pending server confirmation",
            detail:
              "The campaign remains unscheduled in Moosewave until the server accepts the requested time.",
          });
          return;
        }
        try {
          if (result.data) setDetail(result.data);
          onChange?.(
            result.data ?? {
              ...detail,
              status: "scheduled",
              scheduled_at: scheduledAt!,
            },
          );
        } catch {
          // The schedule is committed even if a parent refresh callback fails.
        }
        discardScheduleDraft();
        toast.success("Campaign scheduled");
        trackTelemetry("campaign_scheduled", { source: "slideover" });
      } catch (scheduleError) {
        if (mountedRef.current) {
          toast.error(
            `Couldn't schedule: ${lifecycleOperationError(
              scheduleError,
              "The scheduling request did not complete.",
            )}`,
          );
        }
      } finally {
        if (mountedRef.current) {
          setPstoSaving(false);
          setBusy(false);
        }
      }
    });
    if (request) await request;
  };

  return {
    scheduleOpen,
    setScheduleOpen,
    scheduleAt,
    setScheduleAt,
    pstoOn,
    setPstoOn,
    pstoWindowStart,
    setPstoWindowStart,
    pstoWindowEnd,
    setPstoWindowEnd,
    pstoSaving,
    scheduleDiscardConfirmOpen,
    keepScheduleDraft,
    discardScheduleDraft,
    schedule,
  };
}
