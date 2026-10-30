/**
 * StoreLifecycleSection — "how much demand is waiting, and has anyone acted
 * on it?"
 *
 * WHY IT SITS UNDER THE RECOVERY QUEUES. The queues above show ROWS — the
 * newest 25 of one kind. This is the store-wide roll-up of the same subsystem:
 * every cart-recovery link, back-in-stock subscription and price-drop watcher
 * grouped by the server's own status, plus what the last 30 days produced.
 * They answer the same question at two zoom levels, so they share a store
 * selection and a pull gesture rather than a second destination.
 *
 * THE ONE WRITE, AND WHY IT IS NEVER AUTOMATIC. `POST .../lifecycle/evaluate`
 * re-checks every back-in-stock and price-drop subscription on the store
 * against imported inventory and price data and marks the qualifying ones
 * eligible. That is a fan-out across a tenant's catalogue with no preflight
 * count, so it is: admin-only, online-only, behind a confirm that states what
 * it examines and what "eligible" does NOT mean, and started by nothing except
 * that confirmed press. It is not run on mount, on focus, on refresh or on a
 * store switch.
 *
 * STATUS VOCABULARY IS THE SERVER'S. `by_status` and the 30-day event
 * histogram are `map[string]int` whose keys are whatever the rows hold. They
 * are printed as they arrive, so a status this build has never seen still
 * shows up with its count instead of being dropped by a client-side enum.
 *
 * NativeWind v4: static style objects only.
 */
import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { QueryStates } from "@/components/QueryStates";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import {
  useCommerceLifecycleReport,
  useEvaluateCommerceLifecycle,
} from "@/hooks/useCommerceLifecycle";
import type { OnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  lifecycleErrorMessage,
  lifecycleEvaluateConfirmCopy,
  lifecycleEvaluationOutcomeCopy,
  lifecycleReportIsEmpty,
  lifecycleReportMatches,
  offersLifecycleEvaluation,
  type CommerceLifecycleReport,
  type LifecycleQueue,
} from "@/lib/commerceLifecycle";
import { dateTime, num } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function StoreLifecycleSection({
  integrationId,
  storeName,
  gate,
  canAdmin,
}: {
  integrationId: string | null;
  storeName: string;
  gate: Pick<OnlineQueryGate, "enabled">;
  canAdmin: boolean;
}) {
  const { t } = useTheme();
  const confirm = useConfirm();
  const { toast } = useToast();
  // The report route is admin for a cookie session, so a viewer's read is not
  // attempted at all: a 403 rendered as "no lifecycle demand" would be the app
  // inventing a fact about the store.
  const report = useCommerceLifecycleReport(integrationId, canAdmin);
  const evaluate = useEvaluateCommerceLifecycle();
  const [running, setRunning] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);

  const data = report.data ?? null;
  const matches = lifecycleReportMatches(data, integrationId);

  const onEvaluate = useCallback(async () => {
    if (!integrationId) return;
    const copy = lifecycleEvaluateConfirmCopy(storeName, matches ? data : null);
    const ok = await confirm({
      title: copy.title,
      message: copy.message,
      consequence: copy.consequence,
      confirmLabel: copy.confirmLabel,
    });
    if (!ok) return;
    setRunning(true);
    haptics.tap();
    try {
      const summary = await evaluate.mutateAsync(integrationId);
      haptics.success();
      const outcome = lifecycleEvaluationOutcomeCopy(summary);
      setReceipt(outcome);
      toast({ kind: "success", message: outcome });
    } catch (err) {
      haptics.error();
      setReceipt(null);
      toast({ kind: "error", message: lifecycleErrorMessage(err, "evaluate") });
    } finally {
      setRunning(false);
    }
  }, [confirm, data, evaluate, integrationId, matches, storeName, toast]);

  if (!canAdmin) return null;

  return (
    <View>
      <SectionLabel topMargin={24}>Lifecycle demand</SectionLabel>
      <QueryStates
        query={report}
        gate={gate}
        isEmpty={data !== null && matches && lifecycleReportIsEmpty(data)}
        offlineMessage="Lifecycle demand needs a connection. Reconnect and pull to refresh."
        skeleton={
          <SkeletonList rows={3} lines={2} label="Loading lifecycle demand" />
        }
        empty={{
          title: "No lifecycle demand yet",
          description:
            "No cart-recovery link, back-in-stock subscription or price-drop watcher exists for this store, so there is nothing to evaluate.",
        }}
      >
        {data === null ? null : !matches ? (
          <Note
            text={`The server returned a lifecycle report for a different store (${data.integrationId ?? "unnamed"}). Pull to refresh rather than reading these numbers against ${storeName}.`}
          />
        ) : (
          <View
            style={{
              backgroundColor: t.surface,
              borderColor: t.borderSubtle,
              borderWidth: 1,
              borderRadius: 14,
              padding: 14,
              gap: 12,
            }}
          >
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              {`Measured by the server at ${dateTime(data.generatedAt)}. Eligible means a shopper qualifies to be told — not that anyone has been told.`}
            </Text>

            {data.queues.map((queue) => (
              <QueueRow key={queue.kind} queue={queue} />
            ))}

            <Figures report={data} />

            {data.eventsLast30Days.length > 0 ? (
              <View style={{ gap: 4 }}>
                <Text
                  {...typeCap("caption")}
                  style={{
                    color: t.fgMuted,
                    ...typeStyle("caption"),
                    fontFamily: FONT.semibold,
                  }}
                >
                  Events in the last 30 days
                </Text>
                <Text
                  {...typeCap("bodySmall")}
                  style={{
                    color: t.fg,
                    ...typeStyle("bodySmall"),
                    fontFamily: FONT.regular,
                  }}
                >
                  {data.eventsLast30Days
                    .map((row) => `${row.key} ${num(row.count)}`)
                    .join(" · ")}
                </Text>
              </View>
            ) : null}

            {receipt ? <Note text={receipt} /> : null}

            {offersLifecycleEvaluation({ canAdmin, online: gate.enabled }) ? (
              <Pressable
                onPress={() => {
                  void onEvaluate();
                }}
                disabled={running || !integrationId}
                accessibilityRole="button"
                accessibilityLabel={`Evaluate lifecycle eligibility for ${storeName}`}
                accessibilityHint="Asks first. Re-checks every back-in-stock and price-drop subscription on this store and marks the qualifying ones eligible; it sends nothing."
                accessibilityState={{
                  disabled: running || !integrationId,
                  busy: running,
                }}
                style={{
                  minHeight: 44,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: t.border,
                  opacity: running || !integrationId ? 0.45 : 1,
                }}
              >
                <Text
                  {...typeCap("callout")}
                  style={{
                    color: t.accent,
                    ...typeStyle("callout"),
                    fontWeight: "600",
                    fontFamily: FONT.semibold,
                  }}
                >
                  {running ? "Evaluating…" : "Evaluate eligibility…"}
                </Text>
              </Pressable>
            ) : null}
          </View>
        )}
      </QueryStates>
    </View>
  );
}

/** One queue: our label, the server's total, the server's status words. */
function QueueRow({ queue }: { queue: LifecycleQueue }) {
  const { t } = useTheme();
  return (
    <View style={{ gap: 2 }}>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {`${queue.label} · ${num(queue.total)}`}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {queue.byStatus.length > 0
          ? queue.byStatus.map((row) => `${row.key} ${num(row.count)}`).join(" · ")
          : "No rows to break down by status."}
      </Text>
    </View>
  );
}

function Figures({ report }: { report: CommerceLifecycleReport }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("bodySmall")}
      style={{
        color: t.fg,
        ...typeStyle("bodySmall"),
        fontFamily: FONT.regular,
      }}
    >
      {`${num(report.eligibleLast30Days)} became eligible in the last 30 days · ${num(report.notifiedPending)} eligible and not yet notified`}
    </Text>
  );
}

function Note({ text: body }: { text: string }) {
  const { t } = useTheme();
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {body}
      </Text>
    </View>
  );
}
