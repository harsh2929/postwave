/**
 * IntegrationCard — one connection in the health roll-up.
 *
 * Three things the previous version got wrong, all fixed here:
 *
 *  1. A HEALTHY ROW WAS A LITERAL NO-OP. `disabled={!hasError}` with an
 *     undefined accessibilityRole meant tapping a working integration did
 *     nothing at all, which teaches the user the list is not interactive. Every
 *     row is now expandable and every row has something to show when open.
 *  2. PROVIDER ERRORS WERE UNREADABLE. The error text was capped at three
 *     lines with no way to see the rest, and provider errors routinely put the
 *     actionable part at the END. Expanding the row lifts the cap.
 *  3. THE HUMAN-READABLE MESSAGE WAS THROWN AWAY. The server sends
 *     `health_message` alongside the raw `last_error`; the hook used to drop
 *     it. It now leads, with the raw error underneath.
 *
 * NativeWind v4 gotcha: static style objects only — never
 * `style={({ pressed }) => …}`, which silently drops layout.
 */
import { Pressable, Text, View } from "react-native";

import { Card } from "@/components/Card";
import { IntegrationHealthPanel } from "@/components/integrations/IntegrationHealthPanel";
import { Pill, type PillTone } from "@/components/Pill";
import { useIntegrationHealth } from "@/hooks/useIntegrations";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { FONT } from "@/lib/fonts";
import { dateTime, relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import type { Integration } from "@/lib/integrationRows";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

function statusTone(status: Integration["status"]): PillTone {
  if (status === "healthy") return "success";
  if (status === "degraded") return "warning";
  return "danger";
}

function deliveryLabel(value: string | undefined): string {
  if (!value) return "No deliveries yet";
  const rel = relativeTime(value, { fallback: "" });
  return rel ? `Last delivery ${rel}` : "No deliveries yet";
}

/** Absolute timestamp for assistive tech — relative time is for the eye. */
function deliverySpoken(value: string | undefined): string {
  if (!value) return "No deliveries yet";
  const abs = dateTime(value, "");
  return abs ? `Last delivery ${abs}` : "No deliveries yet";
}

export interface IntegrationCardProps {
  row: Integration;
  expanded: boolean;
  /**
   * Called with THIS row's id rather than as a bare thunk. A thunk forces the
   * list to build one closure per row on every render, which is precisely
   * what stops the screen from hoisting a stable `renderItem`.
   */
  onToggle: (id: string) => void;
  onShareError: (row: Integration) => void;
  /** Absolute, same-origin manage URL, or null when there is nowhere to go. */
  manageHref: string | null;
  onOpenManage: (href: string) => void;
}

export function IntegrationCard({
  row,
  expanded,
  onToggle,
  onShareError,
  manageHref,
  onOpenManage,
}: IntegrationCardProps) {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const error = (row.last_error ?? "").trim();
  const hasError = error.length > 0;
  // Fetched only while THIS card is open. Twelve connections would otherwise
  // mean twelve tenant-scoped health queries for detail nobody asked to see.
  const health = useIntegrationHealth(row.slug, expanded);

  return (
    <View style={{ marginBottom: 8 }}>
      <Card style={{ padding: 0, overflow: "hidden" }}>
        <Pressable
          onPress={() => {
            haptics.tap();
            onToggle(row.id);
          }}
          onLongPress={hasError ? () => onShareError(row) : undefined}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={`${row.name} integration, ${row.status}. ${deliverySpoken(
            row.last_delivery_at,
          )}.${hasError ? " Has an error." : ""} ${
            expanded
              ? "Collapse"
              : "Expand for health checks, recent sync attempts and the retry policy"
          }.`}
          style={{ padding: 16, minHeight: 44 }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <Text
              {...typeCap("heading")}
              style={{
                color: t.fg,
                ...typeStyle("heading"),
                fontWeight: "600",
                fontFamily: FONT.semibold,
                flex: 1,
              }}
              numberOfLines={1}
            >
              {row.name}
            </Text>
            <Pill label={row.status} tone={statusTone(row.status)} />
          </View>

          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
              marginTop: 6,
            }}
          >
            {deliveryLabel(row.last_delivery_at)}
          </Text>

          {row.health_message ? (
            <Text
              {...typeCap("label")}
              style={{
                color: row.status === "healthy" ? t.fgMuted : t.warning,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
                marginTop: 8,
              }}
              numberOfLines={expanded ? undefined : 2}
            >
              {row.health_message}
            </Text>
          ) : null}

          {hasError ? (
            <Text
              {...typeCap("label")}
              style={{
                color: t.danger,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
                marginTop: 8,
              }}
              numberOfLines={expanded ? undefined : 3}
            >
              {error}
            </Text>
          ) : null}

          <Text
            {...typeCap("callout")}
            style={{
              color: t.accent,
              ...typeStyle("callout"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
              marginTop: 8,
            }}
          >
            {expanded ? "Show less" : hasError ? "Show full error" : "Details"}
          </Text>
        </Pressable>

        {expanded ? (
          <View
            style={{
              borderTopColor: t.borderSubtle,
              borderTopWidth: 1,
              paddingHorizontal: 16,
              paddingVertical: 12,
              gap: 10,
            }}
          >
            {row.category ? (
              <Text
                {...typeCap("label")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("label"),
                  fontFamily: FONT.regular,
                }}
              >
                Category: {row.category}
              </Text>
            ) : null}

            <IntegrationHealthPanel
              name={row.name}
              health={health.data}
              loading={health.isLoading && gate.enabled}
              failed={health.isError}
              online={gate.enabled}
            />
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              {hasError ? (
                <RowAction
                  label="Share error"
                  onPress={() => onShareError(row)}
                  a11y={`Share the ${row.name} error`}
                />
              ) : null}
              {manageHref ? (
                <RowAction
                  label="Open in web admin"
                  onPress={() => onOpenManage(manageHref)}
                  a11y={`Manage ${row.name} in the web admin. Opens outside the app.`}
                />
              ) : null}
            </View>
          </View>
        ) : null}
      </Card>
    </View>
  );
}

function RowAction({
  label,
  onPress,
  a11y,
}: {
  label: string;
  onPress: () => void;
  a11y: string;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      style={{
        minHeight: 44,
        justifyContent: "center",
        paddingHorizontal: 14,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: t.border,
        backgroundColor: t.bgSubtle,
      }}
    >
      <Text
        {...typeCap("control")}
        style={{
          color: t.accent,
          ...typeStyle("control"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
