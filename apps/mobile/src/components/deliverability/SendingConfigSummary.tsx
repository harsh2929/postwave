/**
 * SendingConfigSummary — what is SAVED, as distinct from what is happening
 * right now (that is SendingStatusCard). Kept because the two answer different
 * questions: "what did we configure" vs "what is the worker doing".
 *
 * Lifted out of app/(tabs)/sending-settings.tsx unchanged. It is the same
 * responsibility as IpPoolCard beside it — a read-only reading of the loaded
 * settings row, with the same rule that an unloaded row asserts NOTHING — and
 * the screen it came from is 270 lines over its source budget, so the pair
 * belongs together here rather than at the bottom of an edit screen.
 */
import { Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { num } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SendingConfigSummary({
  row,
  configured,
}: {
  row:
    | {
        max_sends_per_hour?: number | null;
        quiet_hours_start?: string;
        quiet_hours_end?: string;
        quiet_hours_tz?: string;
      }
    | undefined;
  configured: boolean;
}) {
  const { t } = useTheme();
  const cap = row?.max_sends_per_hour ?? null;
  const hasCap = cap != null && cap > 0;
  const hasQuiet = Boolean(
    row?.quiet_hours_start && row?.quiet_hours_end && row?.quiet_hours_tz,
  );

  if (!row) {
    // No row loaded — say nothing. The old screen asserted "Sending is
    // uncapped" here, which is a claim about a compliance control it had
    // never read.
    return null;
  }

  if (!configured) {
    return (
      <View
        style={{
          backgroundColor: t.surface,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderStyle: "dashed",
          borderRadius: 14,
          padding: 14,
          marginBottom: 16,
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: t.fg,
            ...typeStyle("callout"),
            fontFamily: FONT.semibold,
          }}
        >
          No workspace ceiling
        </Text>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            marginTop: 4,
            fontFamily: FONT.regular,
          }}
        >
          No workspace-specific hourly ceiling or quiet hours are configured.
          Provider, quota, and safety controls still apply.
        </Text>
      </View>
    );
  }

  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        gap: 8,
        marginBottom: 16,
      }}
    >
      {hasCap ? (
        <Badge tone="success" label={`Cap ${num(cap)}/hr`} />
      ) : (
        <Badge tone="muted" label="No workspace cap" />
      )}
      {hasQuiet ? (
        <Badge
          tone="warning"
          label={`Quiet ${row?.quiet_hours_start}–${row?.quiet_hours_end}`}
        />
      ) : (
        <Badge tone="muted" label="No quiet hours" />
      )}
    </View>
  );
}

function Badge({
  label,
  tone,
}: {
  label: string;
  tone: "success" | "warning" | "muted";
}) {
  const { t } = useTheme();
  const color =
    tone === "success" ? t.success : tone === "warning" ? t.warning : t.fgMuted;
  return (
    <View
      style={{
        borderColor: color,
        borderWidth: 1,
        borderRadius: 999,
        paddingHorizontal: 10,
        paddingVertical: 4,
        backgroundColor: t.surface,
      }}
    >
      <Text
        {...typeCap("badge")}
        style={{ color, ...typeStyle("badge"), fontFamily: FONT.semibold }}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );
}
