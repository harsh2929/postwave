/**
 * IntelligentRetryCard — recent retry-queue state with the two phone-shaped
 * triage verbs: advance one to worker re-evaluation, or drop it.
 *
 * The list and both mutations are exact-admin because rows contain subscriber
 * addresses and live queue state. Below admin, neither cached rows nor controls
 * render and the query hook does not dispatch the private request.
 * Both writes are ONLINE-ONLY: a replayed decision acts on a queue a worker
 * has been draining in the meantime. Dismiss confirms (it drops the send);
 * mark-ready acts immediately, but never promises a retry or delivery: the
 * worker re-evaluates caps and subscriber state first.
 */
import { Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import {
  OpsAction,
  OpsCard,
  OpsCardBody,
  OpsCardTitle,
} from "@/components/deliverability/OpsCard";
import { Pill } from "@/components/Pill";
import { useToast } from "@/components/Toast";
import {
  useRetryEvents,
  useSetRetryEventStatus,
} from "@/hooks/useDeliverabilityRecovery";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isExactTenantAdminRole } from "@/lib/campaignAccess";
import {
  retryEventActionPolicy,
  retryQueueCaption,
} from "@/lib/deliverabilityOpsView";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const SHOWN_ROWS = 5;

export function IntelligentRetryCard() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const confirm = useConfirm();
  const { toast } = useToast();
  const query = useRetryEvents();
  const setStatus = useSetRetryEventStatus();

  const admin = isExactTenantAdminRole(gate.effectiveRole);
  const offline = !gate.enabled;
  // Mask data at render time as well as at the query boundary. This closes the
  // stale-cache window during an admin -> viewer role transition.
  const events = admin && Array.isArray(query.data) ? query.data : [];
  const actionable = events.filter((event) => {
    const policy = retryEventActionPolicy(event);
    return policy.markReady || policy.dismiss;
  });
  const rows = events.slice(0, SHOWN_ROWS);

  const body = !admin
    ? "Workspace owner or admin access is required to read retry-queue evidence. It can include subscriber addresses and exact queue state."
    : offline
      ? "The retry queue can't be read offline."
      : query.isError
        ? "The retry queue couldn't be loaded — queue records may exist without showing here."
        : !query.data
          ? "Loading the retry queue…"
          : retryQueueCaption(events);

  const onAction = async (
    id: string,
    expectedUpdatedAt: string,
    email: string,
    action: "mark-ready" | "dismiss",
  ) => {
    haptics.tap();
    if (action === "dismiss") {
      const ok = await confirm({
        title: "Dismiss this queued send?",
        message: `The queued send to ${email || "this recipient"} will be dropped instead of retried.`,
        confirmLabel: "Dismiss send",
        destructive: true,
      });
      if (!ok) return;
    }
    setStatus.mutate(
      { id, action, expectedUpdatedAt },
      {
        onSuccess: () =>
          toast({
            kind: "success",
            message:
              action === "dismiss"
                ? "Retry queue record dismissed."
                : "Marked ready — a worker will re-evaluate caps and subscriber state; delivery is not forced.",
          }),
        onError: (err) => {
          haptics.error();
          toast({
            kind: "error",
            message:
              errorPresentation(err).message ||
              "Couldn't update the retry queue record.",
          });
        },
      },
    );
  };

  return (
    <OpsCard>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <OpsCardTitle>Retry queue</OpsCardTitle>
        {actionable.length > 0 && !offline ? (
          <Pill label={`${actionable.length} actionable`} tone="warning" />
        ) : null}
      </View>
      <OpsCardBody
        {...(admin && query.isError ? { role: "alert" as const } : {})}
      >
        {body}
      </OpsCardBody>
      {rows.map((event) => {
        const policy = retryEventActionPolicy(event);
        return (
          <View
            key={event.id}
            style={{
              borderTopColor: t.borderSubtle,
              borderTopWidth: 1,
              paddingTop: 8,
              gap: 2,
            }}
          >
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fg,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.medium,
              }}
              numberOfLines={1}
            >
              {event.subscriberEmail || "Unknown recipient"}
            </Text>
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
              numberOfLines={2}
            >
              {`${event.status.replaceAll("_", " ")} · ${event.reason || "reason unavailable"} · retry after ${event.retryAfter ? relativeTime(event.retryAfter) : "—"} · ${event.attempts} attempt${event.attempts === 1 ? "" : "s"}`}
            </Text>
            {admin && !offline && (policy.markReady || policy.dismiss) ? (
              <View style={{ flexDirection: "row", gap: 16 }}>
                {policy.markReady ? (
                  <OpsAction
                    label="Mark ready"
                    onPress={() =>
                      void onAction(
                        event.id,
                        event.updatedAt,
                        event.subscriberEmail,
                        "mark-ready",
                      )
                    }
                    disabled={setStatus.isPending}
                    accessibilityLabel={`Mark the queued send to ${event.subscriberEmail || "this recipient"} ready`}
                  />
                ) : null}
                {policy.dismiss ? (
                  <OpsAction
                    label="Dismiss"
                    onPress={() =>
                      void onAction(
                        event.id,
                        event.updatedAt,
                        event.subscriberEmail,
                        "dismiss",
                      )
                    }
                    disabled={setStatus.isPending}
                    destructive
                    accessibilityLabel={`Dismiss the queued send to ${event.subscriberEmail || "this recipient"}`}
                  />
                ) : null}
              </View>
            ) : null}
          </View>
        );
      })}
      {events.length > SHOWN_ROWS ? (
        <OpsCardBody>
          {`Showing the first ${SHOWN_ROWS} of ${events.length} queue records.`}
        </OpsCardBody>
      ) : null}
    </OpsCard>
  );
}
