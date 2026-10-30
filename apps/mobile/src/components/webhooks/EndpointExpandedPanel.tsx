/**
 * EndpointExpandedPanel — the disclosed half of an outbound endpoint row: the
 * 24h delivery rollup, and the verbs that rollup licenses.
 *
 * Split out of EndpointRow rather than nested inside it. The row carries two
 * separable responsibilities — the collapsed summary (identity, state,
 * freshness, selection checkbox) and the expanded diagnosis (health, and
 * which write it justifies) — and once the per-endpoint deliveries drill-down
 * and multi-select landed on the same component, keeping both in one function
 * put it over this repo's cyclomatic and file-length ceilings
 * (scripts/check-source-budgets.mjs). Splitting by responsibility is the
 * house remedy; raising the budget is not.
 *
 * THE VERB IS CHOSEN BY THE ROLLUP, not by `active`. An endpoint the delivery
 * worker auto-disabled needs Re-enable (the server re-validates destination
 * and receiver auth first); "Resume" merely re-flips `active` and the worker
 * disables it again. `auto_disabled` only arrives with the health rollup, so
 * until it does the row stays neutral rather than guessing.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import type { OutboundHealth, OutboundWebhook } from "@/hooks/useOutboundWebhooks";
import { FONT } from "@/lib/fonts";
import { num, percent } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface EndpointExpandedPanelProps {
  webhook: OutboundWebhook;
  /** The row's own title, so every announcement names what the operator sees. */
  title: string;
  autoDisabled: boolean;
  health: OutboundHealth | undefined;
  healthLoading: boolean;
  busy: boolean;
  onPauseResume: () => void;
  onReEnable: () => void;
  /** Opens this endpoint's own delivery history. Undefined = no control. */
  onShowDeliveries: (() => void) | undefined;
  /** Why the history control is inert (role), rendered beside it. */
  deliveriesBlockedReason: string | null;
}

export function EndpointExpandedPanel({
  webhook,
  title,
  autoDisabled,
  health,
  healthLoading,
  busy,
  onPauseResume,
  onReEnable,
  onShowDeliveries,
  deliveriesBlockedReason,
}: EndpointExpandedPanelProps) {
  const { t } = useTheme();
  return (
    <View
      style={{
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 10,
      }}
    >
      <HealthSummary health={health} loading={healthLoading} />
      {autoDisabled && health?.disabled_reason ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.warning,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {health.disabled_reason}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        {autoDisabled ? (
          <Action
            label="Re-enable"
            onPress={onReEnable}
            disabled={busy}
            a11y={`Re-enable ${title}. The server checks the destination and receiver authentication first.`}
          />
        ) : (
          <Action
            label={webhook.active ? "Pause" : "Resume"}
            onPress={onPauseResume}
            disabled={busy}
            a11y={
              webhook.active
                ? `Pause ${title}. New events stop being enqueued; history and signing configuration are retained.`
                : `Resume ${title}. New events start being enqueued again.`
            }
          />
        )}
        {onShowDeliveries ? (
          <Action
            label="Deliveries"
            onPress={onShowDeliveries}
            disabled={busy || deliveriesBlockedReason !== null}
            a11y={
              deliveriesBlockedReason
                ? `Delivery history is unavailable for ${title}: ${deliveriesBlockedReason}`
                : `Show the recent deliveries to ${title}, newest first, with replay.`
            }
          />
        ) : null}
      </View>
      {onShowDeliveries && deliveriesBlockedReason ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {deliveriesBlockedReason}
        </Text>
      ) : null}
    </View>
  );
}

function HealthSummary({
  health,
  loading,
}: {
  health: OutboundHealth | undefined;
  loading: boolean;
}) {
  const { t } = useTheme();
  if (loading) {
    return (
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        Loading the last 24 hours…
      </Text>
    );
  }
  if (!health) {
    return (
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        Delivery health couldn&apos;t be loaded.
      </Text>
    );
  }
  const total = health.deliveries_total;
  // A success RATE over zero deliveries is not 100% — it is undefined. Say so.
  const rate =
    total > 0 ? percent(health.deliveries_succeeded / total, { digits: 0 }) : "—";
  return (
    <View
      accessible
      accessibilityLabel={`Last 24 hours: ${num(total)} deliveries, ${num(
        health.deliveries_succeeded,
      )} succeeded, ${num(health.deliveries_failed)} failed, success rate ${rate}.`}
    >
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        Last 24h · {num(total)} deliveries · {num(health.deliveries_succeeded)} ok ·{" "}
        {num(health.deliveries_failed)} failed · {rate} success
      </Text>
    </View>
  );
}

function Action({
  label,
  onPress,
  disabled,
  a11y,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  a11y: string;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ disabled }}
      style={{
        minHeight: 44,
        justifyContent: "center",
        paddingHorizontal: 16,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: t.border,
        backgroundColor: t.bgSubtle,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text
        style={{
          color: t.accent,
          ...typeStyle("control"),
          fontFamily: FONT.semibold,
        }}
        {...typeCap("control")}
      >
        {label}
      </Text>
    </Pressable>
  );
}
