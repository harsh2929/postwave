/**
 * Registry rollup for tenant-customer APNs, FCM, and Web push identities.
 * This is not the operator mobile app's Expo-device table, and it is not a
 * delivery-health claim: customer runtime/materialization/providers remain
 * release-held and automatic provider feedback is not yet available.
 */
import { Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { num, plural } from "@/lib/format";
import { pushSummary } from "@/lib/deliverabilityControls";
import type { PushSuppressionRow } from "@/lib/pushSuppressions";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useTheme } from "@/lib/theme";

export interface PushSuppressionCardProps {
  rows: readonly PushSuppressionRow[] | undefined;
  total: number | null;
  loading: boolean;
  hasMore: boolean;
  /** Non-null when the read failed or could not run. */
  unavailableReason: string | null;
  restrictedReason: string | null;
}

export function PushSuppressionCard({
  rows,
  total,
  loading,
  hasMore,
  unavailableReason,
  restrictedReason,
}: PushSuppressionCardProps) {
  const { t } = useTheme();
  const summary = pushSummary(rows ?? []);

  const body = restrictedReason
    ? restrictedReason
    : unavailableReason
      ? unavailableReason
      : loading
        ? "Loading the customer push registry…"
        : rows === undefined || total === null
          ? "The customer push registry total is unknown."
          : total === 0
            ? "The verified registry snapshot contains no active authority rows."
            : `${plural(total, "active registry authority")} recorded. Customer push delivery remains release-held.`;

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 10,
        gap: 10,
      }}
    >
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.bold,
          letterSpacing: 0.6,
          textTransform: "uppercase",
        }}
      >
        Customer push registry
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {body}
      </Text>

      {restrictedReason ||
      unavailableReason ||
      loading ||
      total === null ||
      summary.total === 0 ? null : (
        <View style={{ gap: 8 }}>
          <TallyRow title="By platform" items={summary.platforms} />
          <TallyRow title="By reason" items={summary.reasons} />
          {hasMore || summary.total < total ? (
            <Text
              {...typeCap("label")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
              }}
            >
              Breakdown covers {num(summary.total)} loaded rows; the verified
              registry total is {num(total)}.
            </Text>
          ) : null}
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
            }}
          >
            Automatic APNs/FCM/Web provider feedback is unavailable.
          </Text>
        </View>
      )}
    </View>
  );
}

function TallyRow({
  title,
  items,
}: {
  title: string;
  items: readonly { key: string; label: string; count: number }[];
}) {
  const { t } = useTheme();
  if (items.length === 0) return null;
  return (
    <View
      accessible
      accessibilityLabel={`${title}: ${items
        .map((item) => `${item.label} ${num(item.count)}`)
        .join(", ")}`}
      style={{ gap: 4 }}
    >
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          fontFamily: FONT.medium,
        }}
      >
        {title}
      </Text>
      {items.map((item) => (
        <View
          key={item.key}
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
          }}
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
              flexShrink: 1,
            }}
            numberOfLines={1}
          >
            {item.label}
          </Text>
          <Text
            {...typeCap("numeric")}
            style={{
              color: t.fgMuted,
              ...typeStyle("numeric"),
              fontFamily: FONT.semibold,
              fontVariant: ["tabular-nums"],
            }}
          >
            {num(item.count)}
          </Text>
        </View>
      ))}
    </View>
  );
}
