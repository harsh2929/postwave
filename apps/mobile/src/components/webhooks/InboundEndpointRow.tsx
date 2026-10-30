/**
 * InboundEndpointRow — one receive endpoint, and everything you can do to it
 * from a phone.
 *
 * It used to be read-only: a name, two pills, and a Share button. The state it
 * displayed (`enabled`) was the one thing an operator most often needs to
 * change in a hurry — a partner flooding the slug, a leaked secret — and the
 * row offered no way to change it.
 *
 * THE URL. `truncateMiddle` rather than a trailing clamp, because the slug at
 * the END is the only part that distinguishes one endpoint from another and a
 * tail-truncated URL hides exactly that. Tapping COPIES (expo-clipboard) —
 * copying is what the row is for, and the share sheet was three taps to reach
 * the same result. Share stays as a second control for handing it to another
 * app. There is deliberately no "open in browser" and no QR: the ingest route
 * is POST-only (`MountPublicRoutes` registers only `Post`), so a browser — or
 * a phone camera following a QR — gets a 405 and reads the endpoint as
 * broken. Copy and Share are the two transfers that actually end with this
 * URL pasted into an upstream system's settings.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { type InboundWebhookRow } from "@/hooks/useInboundWebhookOps";
import { date, plural, relativeTime, truncateMiddle } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/**
 * Freshness beats a calendar date on an operator screen: "Added 4d ago"
 * answers "is this endpoint new?" without arithmetic. The absolute date stays
 * in the accessibilityLabel. Null for a missing/unparseable timestamp, so the
 * row omits the line rather than rendering "Invalid Date".
 */
export function addedLine(
  value: string | undefined,
): { text: string; spoken: string } | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return { text: `Added ${relativeTime(d)}`, spoken: `Added ${date(d)}` };
}

export interface InboundEndpointRowProps {
  row: InboundWebhookRow;
  /** A write against THIS row is in flight. */
  pending: boolean;
  /** Any write on the screen is in flight — keeps two from racing. */
  busy: boolean;
  onCopyUrl: (row: InboundWebhookRow) => void;
  onShareUrl: (row: InboundWebhookRow) => void;
  onToggleEnabled: (row: InboundWebhookRow) => void;
  onOpenEvents: (row: InboundWebhookRow) => void;
  onRotate: (row: InboundWebhookRow) => void;
}

export function InboundEndpointRow({
  row,
  pending,
  busy,
  onCopyUrl,
  onShareUrl,
  onToggleEnabled,
  onOpenEvents,
  onRotate,
}: InboundEndpointRowProps) {
  const { t } = useTheme();
  const label = row.name || row.slug;
  const added = addedLine(row.createdAt);

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 8,
      }}
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
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.semibold,
            flex: 1,
          }}
          numberOfLines={1}
        >
          {label}
        </Text>
        <Pill
          label={row.enabled ? "enabled" : "disabled"}
          tone={row.enabled ? "success" : "neutral"}
          accessibilityLabel={
            row.enabled
              ? "Enabled: this endpoint is accepting events."
              : "Disabled: this endpoint answers upstream senders with 410 Gone."
          }
        />
      </View>

      {row.publicUrl ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            marginTop: 10,
          }}
        >
          <Pressable
            onPress={() => onCopyUrl(row)}
            accessibilityRole="button"
            accessibilityLabel={`Copy the inbound URL for ${label}`}
            style={{
              flex: 1,
              backgroundColor: t.bgSubtle,
              borderRadius: 10,
              paddingHorizontal: 10,
              paddingVertical: 8,
              minHeight: 44,
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Text
              selectable
              // The full URL is what a screen reader should get; the visible
              // run is a middle-truncation for the eye only.
              accessibilityLabel={row.publicUrl}
              {...typeCap("mono")}
              style={{
                color: t.fg,
                ...typeStyle("mono"),
                fontFamily: "Menlo",
                flex: 1,
              }}
              numberOfLines={2}
            >
              {truncateMiddle(row.publicUrl, 64)}
            </Text>
            <Text
              {...typeCap("control")}
              style={{
                color: t.accent,
                ...typeStyle("control"),
                fontFamily: FONT.semibold,
              }}
            >
              Copy
            </Text>
          </Pressable>
          <Pressable
            onPress={() => onShareUrl(row)}
            accessibilityRole="button"
            accessibilityLabel={`Share the inbound URL for ${label} to another app`}
            style={{
              minHeight: 44,
              minWidth: 44,
              paddingHorizontal: 10,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: t.border,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: t.fg,
                ...typeStyle("control"),
                fontFamily: FONT.semibold,
              }}
            >
              Share
            </Text>
          </Pressable>
        </View>
      ) : null}

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          marginTop: 8,
          flexWrap: "wrap",
        }}
      >
        {/* The list endpoint returns no event counts, so this line only ever
            appears when a gateway supplies one. A missing count is silence,
            never "0 events". */}
        {row.eventCount !== undefined ? (
          <Text
            {...typeCap("caption")}
            style={{
              color: row.eventCount === 0 ? t.fgSubtle : t.fgMuted,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              fontVariant: ["tabular-nums"],
            }}
          >
            {row.eventCount === 0
              ? "No events yet"
              : plural(row.eventCount, "event")}
          </Text>
        ) : null}
        {added ? (
          <Text
            accessibilityLabel={added.spoken}
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              fontVariant: ["tabular-nums"],
            }}
          >
            {added.text}
          </Text>
        ) : null}
      </View>

      <View
        style={{ flexDirection: "row", gap: 8, marginTop: 10, flexWrap: "wrap" }}
      >
        <RowButton
          label="Events"
          a11y={`Show the events that reached ${label}`}
          onPress={() => onOpenEvents(row)}
          disabled={false}
          tone="neutral"
        />
        <RowButton
          label={
            pending ? "Saving…" : row.enabled ? "Disable" : "Enable"
          }
          a11y={
            row.enabled
              ? `Disable ${label}. Upstream senders will be refused until it is enabled again.`
              : `Enable ${label} so it starts accepting events again.`
          }
          onPress={() => onToggleEnabled(row)}
          disabled={busy}
          tone={row.enabled ? "warning" : "accent"}
        />
        <RowButton
          label="Rotate secret"
          a11y={`Rotate the signing secret for ${label}`}
          onPress={() => onRotate(row)}
          disabled={busy}
          tone="neutral"
        />
      </View>
    </View>
  );
}

function RowButton({
  label,
  a11y,
  onPress,
  disabled,
  tone,
}: {
  label: string;
  a11y: string;
  onPress: () => void;
  disabled: boolean;
  tone: "neutral" | "accent" | "warning";
}) {
  const { t } = useTheme();
  const color =
    tone === "warning" ? t.warning : tone === "accent" ? t.accent : t.fg;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ disabled }}
      style={{
        paddingHorizontal: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: tone === "neutral" ? t.border : color,
        backgroundColor: tone === "neutral" ? t.bgSubtle : "transparent",
        opacity: disabled ? 0.5 : 1,
        minHeight: 44,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        {...typeCap("control")}
        style={{
          color,
          ...typeStyle("control"),
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
