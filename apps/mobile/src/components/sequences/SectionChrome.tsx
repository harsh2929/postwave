/**
 * sequences/SectionChrome — the small shared parts of the participants and
 * stuck-report sections.
 *
 * Split out when SequenceParticipants.tsx crossed its source budget. The seam
 * is a real one: everything here is presentation with no knowledge of either
 * endpoint, and `SectionNotice` is the single place that decides how an
 * honest empty/off/error state looks in this cluster.
 */
import { Pressable, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import type { SectionState } from "@/lib/sequenceParticipants";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SectionHeading({
  title,
  detail,
}: {
  title: string;
  detail?: string | undefined;
}) {
  const { t } = useTheme();
  return (
    <View>
      <Text
        {...typeCap("heading")}
        style={{
          color: t.fg,
          ...typeStyle("heading"),
          fontWeight: "500",
          fontFamily: FONT.medium,
        }}
      >
        {title}
      </Text>
      {detail ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
            marginTop: 2,
          }}
        >
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

export function SectionNotice({
  state,
  onRetry,
}: {
  state: SectionState;
  onRetry: () => void;
}) {
  const { t } = useTheme();
  const isError = state.kind === "error";
  return (
    <View
      accessible
      {...(isError ? { accessibilityRole: "alert" as const } : {})}
      accessibilityLabel={`${state.title ?? ""}. ${state.message ?? ""}`}
      style={{
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderStyle: "dashed",
        borderRadius: 12,
        padding: 16,
        gap: 6,
      }}
    >
      <Text
        {...typeCap("callout")}
        style={{
          color: t.fg,
          ...typeStyle("callout"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {state.title}
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        {state.message}
      </Text>
      {state.retryable ? (
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel="Try loading again"
          hitSlop={8}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.accent,
              ...typeStyle("bodySmall"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            Try again
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Pager({
  page,
  pageCount,
  onChange,
}: {
  page: number;
  pageCount: number;
  onChange: (next: number) => void;
}) {
  const { t } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <PagerButton
        label="Previous"
        disabled={page <= 1}
        onPress={() => onChange(page - 1)}
      />
      <Text
        accessibilityLabel={`Page ${page} of ${pageCount}`}
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        {page} / {pageCount}
      </Text>
      <PagerButton
        label="Next"
        disabled={page >= pageCount}
        onPress={() => onChange(page + 1)}
      />
    </View>
  );
}

function PagerButton({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`${label} page of participants`}
      accessibilityState={{ disabled }}
      hitSlop={6}
      style={{
        minHeight: 44,
        paddingHorizontal: 14,
        justifyContent: "center",
        borderRadius: 10,
        borderWidth: 1,
        borderColor: t.border,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function rowStyle(borderColor: string) {
  return {
    borderColor,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    minHeight: 56,
    justifyContent: "center" as const,
  };
}
