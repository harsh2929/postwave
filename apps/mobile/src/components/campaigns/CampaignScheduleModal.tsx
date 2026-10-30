/**
 * CampaignScheduleModal — pick when a campaign goes out.
 *
 * Fixed here:
 *  - The confirmation line is now ZONE-QUALIFIED. It used to be a bare
 *    `toLocaleString()` sitting directly under a recommendation formatted as
 *    "9:00 AM UTC" — two clocks side by side, only one of them labelled.
 *  - The past-time guard is re-evaluated on a ticking clock AND re-checked
 *    against a fresh `Date.now()` inside the save handler, so a sheet left
 *    open across the picked minute can no longer schedule into the past.
 *  - Outcomes are toasts, not modal alerts, and failures render through
 *    campaignErrorMessage rather than echoing the HTTP layer. That matters
 *    especially here: the gateway owns dispatch state and answers a
 *    client-set `scheduled_at` with 422 `campaign_dispatch_state_owned` while
 *    durable delivery is being verified — which now reads as an explanation
 *    instead of a raw error string.
 *  - A campaign configured on desktop for per-recipient send-time
 *    optimization warns before a single fixed time overwrites it.
 *  - PER-RECIPIENT SCHEDULING. The sheet used to offer exactly one decision:
 *    a single fixed UTC-ish moment for the entire audience. Desktop has always
 *    also offered "schedule by best time", which lands every recipient at the
 *    hour THEY open, with a dry-run distribution first. That is now a toggle
 *    here, and in that mode the date wheel changes meaning from "when everyone
 *    receives this" to "when the window starts" — which the sheet says out
 *    loud rather than leaving the operator to infer.
 *  - SEND-WINDOW VERDICT under the picker (desktop parity: SendChecklist's
 *    send-window row). POST /send-window/check for the picked minute, once
 *    the wheel rests; the line reads desktop's sentence with the server's
 *    reason verbatim, and says "checking…" / offline / failed in between.
 *    Advisory only — it never disables Save; the schedule handler evaluates
 *    the same policy itself, and its refusal sentence is what the toast shows.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { EVENTS } from "@postwave/telemetry";

import { getClient } from "@/api/sdkClient";
import {
  KeyboardFormSheet,
  type ReturnFocusRef,
} from "@/components/KeyboardFormSheet";
import { SendTimeOptBanner } from "@/components/SendTimeOptBanner";
import { SendWindowVerdictLine } from "@/components/SendWindowVerdictLine";
import { useToast } from "@/components/Toast";
import { BestTimeScheduleCard } from "@/components/campaigns/BestTimeScheduleCard";
import {
  ActionButton,
  DateTimeWheel,
  ModalHeader,
} from "@/components/campaigns/CampaignDetailControls";
import {
  useBestTimeSchedulePreview,
  useCommitBestTimeSchedule,
} from "@/hooks/useCampaignBestTime";
import { codeFromError, messageFromError } from "@/api/request";
import { sendWindowRefusalMessage } from "@/lib/sendWindowScheduleLine";
import type { CampaignDetail } from "@/hooks/useCampaigns";
import {
  bestTimeCommitMessage,
  DEFAULT_BEST_TIME_WINDOW,
} from "@/lib/bestTimeSchedule";
import { campaignErrorMessage } from "@/lib/campaignErrors";
import {
  isScheduleInPast,
  personalizedSendWarning,
  resolvedTimeZone,
  scheduleConfirmLine,
} from "@/lib/campaignSchedule";
import { FONT } from "@/lib/fonts";
import { typeCap } from "@/lib/typeScale";
import { haptics } from "@/lib/haptics";
import { track } from "@/lib/telemetry";
import { useTheme } from "@/lib/theme";

/** How often the past-time guard re-reads the wall clock while open. */
const CLOCK_TICK_MS = 30_000;

export function CampaignScheduleModal({
  visible,
  onClose,
  campaign,
  returnFocusRef,
}: {
  visible: boolean;
  onClose: () => void;
  campaign: CampaignDetail;
  returnFocusRef?: ReturnFocusRef | undefined;
}) {
  const { t } = useTheme();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const zone = useMemo(() => resolvedTimeZone(), []);

  const initial = useMemo<Date>(() => {
    if (campaign.scheduled_at) {
      const d = new Date(campaign.scheduled_at);
      if (!Number.isNaN(d.getTime())) return d;
    }
    const d = new Date();
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    return d;
  }, [campaign.scheduled_at]);

  const [picked, setPicked] = useState<Date>(initial);
  const [now, setNow] = useState<number>(() => Date.now());
  // Best-time mode defaults ON for a campaign desktop already configured for
  // per-recipient optimisation: opening this sheet must not quietly stage the
  // very overwrite the warning below exists to prevent.
  const [bestTime, setBestTime] = useState<boolean>(
    () => campaign.per_recipient_optimize === true,
  );
  const [withinDays, setWithinDays] = useState<number>(
    DEFAULT_BEST_TIME_WINDOW,
  );

  useEffect(() => {
    if (visible) setPicked(initial);
  }, [visible, initial]);

  useEffect(() => {
    if (visible) setBestTime(campaign.per_recipient_optimize === true);
  }, [visible, campaign.per_recipient_optimize]);

  // The guard has to keep up with wall-clock time. The interval only runs
  // while the sheet is open, so a backgrounded app isn't paying for it.
  useEffect(() => {
    if (!visible) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [visible]);

  const updateMutation = useMutation({
    mutationFn: async (scheduledAt: string) => {
      const { client } = getClient();
      // The lifecycle route, not PATCH. `campaigns.update` refuses both
      // `scheduled_at` and `status` with 422 `campaign_dispatch_state_owned`,
      // so this mutation could never have succeeded; the server derives
      // draft -> scheduled itself.
      return client.campaigns.schedule(campaign.id, scheduledAt);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaign"] });
      void queryClient.invalidateQueries({ queryKey: ["campaign-report"] });
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      void queryClient.invalidateQueries({ queryKey: ["campaign-counts"] });
      track(EVENTS.CAMPAIGN_SCHEDULED, { source: "mobile_detail" });
      onClose();
      toast({
        kind: "success",
        message: scheduleConfirmLine(picked, zone).replace(
          "Will send:",
          "Scheduled for",
        ),
      });
    },
    onError: (err: unknown) => {
      haptics.error();
      // The schedule handler evaluates the send window itself and refuses a
      // blocked instant with 422 `outside_send_window` carrying its own
      // sentence and the reason; campaignErrorMessage's generic 422 arm would
      // blame the campaign's state instead, so the server's sentence wins.
      toast({
        kind: "error",
        message:
          sendWindowRefusalMessage(codeFromError(err), messageFromError(err)) ??
          campaignErrorMessage(err, "Couldn't schedule the campaign."),
      });
    },
  });

  const bestTimePreview = useBestTimeSchedulePreview(campaign.id, {
    withinDays,
    referenceAt: picked,
    enabled: visible && bestTime,
  });
  const commitBestTime = useCommitBestTimeSchedule(campaign.id);

  const isPast = isScheduleInPast(picked, now);
  // In best-time mode the picked moment is the WINDOW ANCHOR, not the send
  // instant, so the fixed-time warning no longer describes what will happen.
  const pstoWarning = bestTime ? null : personalizedSendWarning(campaign);
  const pending = updateMutation.isPending || commitBestTime.isPending;

  const handleSave = useCallback(() => {
    // Re-validate against a FRESH clock: the rendered guard may be up to
    // CLOCK_TICK_MS stale, and the sheet may have sat backgrounded for hours.
    if (isScheduleInPast(picked, Date.now())) {
      setNow(Date.now());
      haptics.warning();
      toast({
        kind: "warning",
        message: "That time has passed. Pick a time in the future.",
      });
      return;
    }
    if (bestTime) {
      commitBestTime.mutate(
        { withinDays, referenceAt: picked },
        {
          onSuccess: (result) => {
            track(EVENTS.CAMPAIGN_SCHEDULED, {
              source: "mobile_detail_best_time",
            });
            onClose();
            toast({ kind: "success", message: bestTimeCommitMessage(result) });
          },
          onError: (err: unknown) => {
            haptics.error();
            toast({
              kind: "error",
              message: campaignErrorMessage(
                err,
                "Couldn't schedule by best time.",
              ),
            });
          },
        },
      );
      return;
    }
    updateMutation.mutate(picked.toISOString());
  }, [
    bestTime,
    commitBestTime,
    onClose,
    picked,
    toast,
    updateMutation,
    withinDays,
  ]);

  const handleApplySuggested = useCallback((iso: string) => {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) setPicked(d);
  }, []);

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
    >
      <ModalHeader title="Schedule send" onClose={onClose} />

      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          fontSize: 13,
          marginBottom: 12,
          fontFamily: FONT.regular,
        }}
      >
        Choose when this campaign should send. Times you pick are in your
        device&apos;s zone{zone ? ` (${zone})` : ""}; the AI recommendation
        below is labelled with its own zone.
      </Text>

      {pstoWarning ? (
        <View
          accessible
          accessibilityLabel={pstoWarning}
          style={{
            backgroundColor: t.bgSubtle,
            borderColor: t.warning,
            borderWidth: 1,
            borderRadius: 10,
            paddingHorizontal: 12,
            paddingVertical: 10,
            marginBottom: 12,
          }}
        >
          <Text
            {...typeCap("label")}
            style={{
              color: t.warning,
              fontSize: 12,
              lineHeight: 17,
              fontFamily: FONT.medium,
            }}
          >
            {pstoWarning}
          </Text>
        </View>
      ) : null}

      {bestTime ? null : (
        <SendTimeOptBanner
          segmentId={campaign.segment_id ?? null}
          campaignId={campaign.id}
          onApply={handleApplySuggested}
        />
      )}

      <BestTimeScheduleCard
        enabled={bestTime}
        onToggle={setBestTime}
        withinDays={withinDays}
        onWithinDaysChange={setWithinDays}
        preview={bestTimePreview.data?.preview ?? null}
        loading={bestTimePreview.isLoading}
        problem={bestTimePreview.data?.problem ?? null}
        retryable={bestTimePreview.data?.retryable ?? false}
        onRetry={() => void bestTimePreview.refetch()}
        disabled={pending}
      />

      <View style={{ marginTop: 16 }}>
        {/* focusKey re-centres each column on its selection every time the
            sheet re-opens — the sheet stays mounted behind the Modal, so
            without it the columns keep whatever scroll they last had. */}
        <DateTimeWheel
          value={picked}
          onChange={setPicked}
          t={t}
          focusKey={visible ? "open" : "closed"}
        />
      </View>

      <Text
        {...typeCap("numeric")}
        accessibilityLiveRegion="polite"
        style={{
          color: isPast ? t.danger : t.fgMuted,
          fontSize: 12,
          marginTop: 12,
          fontFamily: FONT.regular,
          fontVariant: ["tabular-nums"],
        }}
      >
        {isPast
          ? "That time has passed — pick a time in the future."
          : bestTime
            ? `${scheduleConfirmLine(picked, zone).replace("Will send:", "Window starts:")} · then each recipient at their own hour`
            : scheduleConfirmLine(picked, zone)}
      </Text>

      {/* "Is THIS time inside the send window?" — advisory only; the sheet
          never sees the verdict, so nothing here can gate Save on it. In
          best-time mode the picked moment is only the window anchor, so the
          line stands down rather than describe the wrong instant. */}
      <SendWindowVerdictLine picked={picked} applicable={visible && !bestTime} />


      <View
        style={{
          flexDirection: "row",
          justifyContent: "flex-end",
          gap: 8,
          marginTop: 20,
        }}
      >
        <ActionButton label="Cancel" onPress={onClose} disabled={pending} />
        <ActionButton
          label={
            pending
              ? "Scheduling…"
              : bestTime
                ? "Schedule by best time"
                : "Save"
          }
          primary
          onPress={handleSave}
          disabled={pending || isPast}
        />
      </View>
    </KeyboardFormSheet>
  );
}
