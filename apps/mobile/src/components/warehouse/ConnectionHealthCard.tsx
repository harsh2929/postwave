/**
 * ConnectionHealthCard — the selected run's CONNECTION, and the one write this
 * screen offers.
 *
 * WHY A SECOND READ AT ALL. A run is history; the connection is the thing that
 * will (or will not) run again tonight. `healthForConnection` (warehouse.go:
 * 872-928) folds the connection's own status, its missing required settings,
 * its validator warnings and its newest run into one verdict — which is
 * exactly the "will this keep failing" question a run row cannot answer.
 *
 * THE PAUSE, AND WHY IT IS NOT ROLE-GATED SEPARATELY. `POST
 * /connections/{id}/pause` is `apikeys.RequireScope(ScopeAdmin)`
 * (warehouse.go:192) — but so is every READ on this screen once
 * `routeauth.Middleware` has evaluated the manifest, which marks the whole
 * `/api/v1/warehouse/*` family `session_minimum_role: admin`. Anyone who can
 * SEE this card can already pause. Drawing a disabled button and a "you need
 * admin" explanation would be inventing a permission tier the server does not
 * have. What IS gated is connectivity: the button disappears offline rather
 * than queueing, because a pause replayed on reconnect fires into a world that
 * has moved on, and the entire value of pausing is that it happens while the
 * operator is watching the failure.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { Pill, type PillTone } from "@/components/Pill";
import { QueryStates } from "@/components/QueryStates";
import type { QueryLike } from "@/components/QueryStates";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import type { OnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { usePauseWarehouseConnection } from "@/hooks/useWarehouseRuns";
import { pauseErrorMessage } from "@/api/warehouseRuns";
import { EMDASH, dateTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import type { WarehouseConnectionHealth } from "@/lib/warehouseRuns";

const HEALTH_TONE: Readonly<Record<string, PillTone>> = {
  healthy: "success",
  paused: "neutral",
  error: "danger",
  needs_attention: "warning",
  disconnected: "danger",
};

export interface ConnectionHealthCardProps {
  query: QueryLike & { data?: WarehouseConnectionHealth | undefined };
  gate: Pick<OnlineQueryGate, "enabled">;
  connectionName: string;
}

export function ConnectionHealthCard({
  query,
  gate,
  connectionName,
}: ConnectionHealthCardProps) {
  const { t } = useTheme();
  const confirm = useConfirm();
  const { toast } = useToast();
  const pause = usePauseWarehouseConnection();
  const [pausing, setPausing] = useState(false);
  const health = query.data;

  const onPause = useCallback(async () => {
    if (!health?.connectionId) return;
    const ok = await confirm({
      title: `Pause ${connectionName}?`,
      message:
        "The scheduler stops picking this connection up. Runs already in flight are not cancelled.",
      confirmLabel: "Pause",
      destructive: true,
      consequence:
        "Nothing will export or import from this connection until somebody re-activates it on the web admin — the app cannot un-pause it.",
    });
    if (!ok) return;
    setPausing(true);
    try {
      await pause.mutateAsync(health.connectionId);
      haptics.success();
      toast({ kind: "success", message: `${connectionName} is paused.` });
    } catch (error) {
      haptics.error();
      toast({ kind: "error", message: pauseErrorMessage(error) });
    } finally {
      setPausing(false);
    }
  }, [confirm, connectionName, health?.connectionId, pause, toast]);

  const alreadyPaused = (health?.status ?? "").toLowerCase() === "paused";

  return (
    <View style={{ marginTop: 8 }}>
      <SectionLabel>Connection health</SectionLabel>
      <QueryStates
        query={query}
        gate={gate}
        isEmpty={!health}
        offlineMessage="Reconnect to read this connection's health."
        skeleton={
          <SkeletonList rows={1} lines={3} label="Loading connection health" />
        }
        empty={{
          title: "No health for this connection",
          description:
            "The run's connection was deleted, or the server has nothing recorded for it.",
        }}
      >
        {health ? (
          <View
            style={{
              backgroundColor: t.surface,
              borderColor: t.borderSubtle,
              borderWidth: 1,
              borderRadius: 14,
              padding: 14,
              gap: 10,
            }}
          >
            <View
              accessible
              accessibilityLabel={`${connectionName}: ${health.health || "unknown health"}, connection status ${health.status || "unknown"}.${
                health.lastRunStatus
                  ? ` Newest run ${health.lastRunStatus}${
                      health.lastRunAt
                        ? ` at ${dateTime(health.lastRunAt, EMDASH)}`
                        : ""
                    }.`
                  : " No run recorded."
              }${health.error ? ` ${health.error}` : ""}`}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <Pill
                  label={health.health || "unknown"}
                  tone={HEALTH_TONE[health.health] ?? "warning"}
                />
                <Pill label={health.status || "unknown"} tone="neutral" />
                {health.provider ? (
                  <Pill label={health.provider} tone="neutral" />
                ) : null}
              </View>
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("bodySmall"),
                  marginTop: 8,
                  fontFamily: FONT.regular,
                }}
              >
                {health.lastRunStatus
                  ? `Newest run: ${health.lastRunStatus} · ${dateTime(health.lastRunAt, EMDASH)}`
                  : "No run recorded for this connection."}
              </Text>
              {health.error ? (
                <Text
                  selectable
                  {...typeCap("bodySmall")}
                  style={{
                    color: t.danger,
                    ...typeStyle("bodySmall"),
                    marginTop: 8,
                    fontFamily: FONT.regular,
                  }}
                >
                  {health.error}
                </Text>
              ) : null}
              {health.missingRequiredSettings.length > 0 ? (
                <Text
                  {...typeCap("label")}
                  style={{
                    color: t.warning,
                    ...typeStyle("label"),
                    marginTop: 8,
                    fontFamily: FONT.regular,
                  }}
                >
                  {`Missing settings: ${health.missingRequiredSettings.join(", ")} — fix these on the web admin.`}
                </Text>
              ) : null}
              {health.warnings.map((warning) => (
                <Text
                  key={warning}
                  {...typeCap("label")}
                  style={{
                    color: t.fgSubtle,
                    ...typeStyle("label"),
                    marginTop: 6,
                    fontFamily: FONT.regular,
                  }}
                >
                  {warning}
                </Text>
              ))}
            </View>

            {gate.enabled && !alreadyPaused ? (
              <Pressable
                onPress={onPause}
                disabled={pausing}
                accessibilityRole="button"
                accessibilityLabel={`Pause ${connectionName}`}
                accessibilityHint="Stops the scheduler from starting new runs for this connection"
                accessibilityState={{ disabled: pausing, busy: pausing }}
                style={{
                  minHeight: 44,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: t.border,
                  opacity: pausing ? 0.45 : 1,
                }}
              >
                <Text
                  {...typeCap("callout")}
                  style={{
                    color: t.danger,
                    ...typeStyle("callout"),
                    fontWeight: "600",
                    fontFamily: FONT.semibold,
                  }}
                >
                  {pausing ? "Pausing…" : "Pause this connection"}
                </Text>
              </Pressable>
            ) : null}
            {alreadyPaused ? (
              <Text
                {...typeCap("label")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("label"),
                  fontFamily: FONT.regular,
                }}
              >
                Already paused. Re-activating a connection is a web-admin
                action — this app deliberately does not offer it.
              </Text>
            ) : null}
          </View>
        ) : null}
      </QueryStates>
    </View>
  );
}
