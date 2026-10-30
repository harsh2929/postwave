/** A private-roster row that keeps manual and source authority distinct. */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { SwipeableRow } from "@/components/SwipeableRow";
import { FONT } from "@/lib/fonts";
import { relativeTime } from "@/lib/format";
import {
  formatE164,
  isReversibleManualSmsSuppression,
  type SmsSuppression,
} from "@/lib/suppressionContracts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

interface Props {
  mutationReady: boolean;
  now: number;
  onRemove: (row: SmsSuppression) => Promise<void>;
  row: SmsSuppression;
  writeBusy: boolean;
}

function reasonTone(reason: string): "danger" | "warning" | "neutral" {
  const value = reason.trim().toLowerCase();
  if (value.includes("stop") || value.includes("opt_out")) return "danger";
  if (value.includes("manual") || value.includes("admin")) return "warning";
  return "neutral";
}

export function SmsSuppressionRow({
  mutationReady,
  now,
  onRemove,
  row,
  writeBusy,
}: Props) {
  const { t } = useTheme();
  const when = row.createdAt ? relativeTime(row.createdAt, { now }) : "—";
  const removable = isReversibleManualSmsSuppression(row);
  const authority = removable
    ? "Manual workspace hold · removable after owner/admin reauthorization"
    : `Locked · ${row.lockedReason ?? "carrier or system authority"}`;
  const card = (
    <View
      accessible
      accessibilityLabel={`${formatE164(row.phone)}, SMS suppression, reason ${row.reason}, source ${row.source}, ${authority}, ${when}`}
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 8,
        gap: 6,
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
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.semibold,
            flexShrink: 1,
          }}
          numberOfLines={1}
        >
          {formatE164(row.phone)}
        </Text>
        <Pill label={row.reason} tone={reasonTone(row.reason)} />
      </View>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
        numberOfLines={1}
      >
        {when} · Source: {row.source || "unknown"}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: removable ? t.warning : t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.medium,
        }}
      >
        {authority}
      </Text>
    </View>
  );

  if (!mutationReady || !removable || writeBusy) return card;
  return (
    <SwipeableRow
      accessibilityLabel={`${formatE164(row.phone)}, manual SMS hold`}
      right={[
        {
          label: "Remove hold",
          kind: "danger",
          onPress: () => onRemove(row),
        },
      ]}
    >
      {card}
    </SwipeableRow>
  );
}
