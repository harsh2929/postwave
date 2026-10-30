/** One privacy-minimized Gift archive record and its route-backed detail. */
import { memo } from "react";
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { EMDASH, date, plural, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import {
  giftStatusLabel,
  giftStatusTone,
  recordHasDataIssue,
  statusDrift,
} from "@/lib/giftInsights";
import type { GiftHistoryRecord } from "@/lib/giftSubscriptions";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface GiftFreshRead {
  isFetching: boolean;
  isError: boolean;
  data: GiftHistoryRecord | null | undefined;
}

export const IDLE_FRESH_READ: GiftFreshRead = Object.freeze({
  isFetching: false,
  isError: false,
  data: undefined,
});

export interface GiftRowProps {
  gift: GiftHistoryRecord;
  expanded: boolean;
  onToggle: (id: string) => void;
  fresh: GiftFreshRead;
  now: number;
}

function GiftRowImpl({ gift, expanded, onToggle, fresh, now }: GiftRowProps) {
  const { t } = useTheme();
  const currentGift = expanded && fresh.data ? fresh.data : gift;
  const status = recordHasDataIssue(currentGift)
    ? "unclassified"
    : currentGift.status;
  const label = giftStatusLabel(status);
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        marginBottom: 8,
        overflow: "hidden",
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${currentGift.label}. ${currentGift.planLabel}. ${label}.`}
        accessibilityHint={
          expanded
            ? "Collapses this record"
            : "Expands this record and refreshes its lifecycle evidence"
        }
        onPress={() => {
          haptics.tap();
          onToggle(gift.id);
        }}
        style={{
          minHeight: 44,
          paddingHorizontal: 12,
          paddingVertical: 10,
          gap: 6,
        }}
      >
        <View
          style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}
        >
          <Text
            {...typeCap("body")}
            numberOfLines={2}
            style={{
              flex: 1,
              color: t.fg,
              ...typeStyle("body"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            {currentGift.label}
          </Text>
          <Pill label={label} tone={giftStatusTone(status)} />
        </View>
        <Text
          {...typeCap("label")}
          numberOfLines={1}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {currentGift.planLabel} ·{" "}
          {currentGift.durationMonths
            ? plural(currentGift.durationMonths, "month")
            : "duration unavailable"}
        </Text>
        <Text
          {...typeCap("caption")}
          numberOfLines={1}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          Recorded{" "}
          {currentGift.createdAt
            ? relativeTime(currentGift.createdAt, { now })
            : "at an unavailable time"}
        </Text>
      </Pressable>
      {expanded ? (
        <GiftRowDetail
          baseline={gift}
          gift={currentGift}
          fresh={fresh}
          now={now}
        />
      ) : null}
    </View>
  );
}

function GiftRowDetail({
  baseline,
  gift,
  fresh,
  now,
}: {
  baseline: GiftHistoryRecord;
  gift: GiftHistoryRecord;
  fresh: GiftFreshRead;
  now: number;
}) {
  const { t } = useTheme();
  const drift = statusDrift(baseline, fresh.data ?? null);
  return (
    <View
      style={{
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 7,
        backgroundColor: t.bgSubtle,
      }}
    >
      <Field label="Lifecycle" value={giftStatusLabel(gift.status)} />
      <Field
        label="Recorded"
        value={gift.createdAt ? date(gift.createdAt) : EMDASH}
      />
      <Field
        label="Redeemed"
        value={
          gift.redeemedAt ? relativeTime(gift.redeemedAt, { now }) : EMDASH
        }
      />
      <Field
        label="Expires"
        value={gift.expiresAt ? date(gift.expiresAt) : EMDASH}
      />
      <Field
        label="Cancelled"
        value={
          gift.canceledAt ? relativeTime(gift.canceledAt, { now }) : EMDASH
        }
      />
      <Field
        label="Evidence"
        value={[
          evidenceLabel("Message", gift.messageRecorded),
          evidenceLabel("Provider invoice", gift.providerInvoiceLinked),
          evidenceLabel("Gifter membership", gift.gifterMemberLinked),
          evidenceLabel("Recipient membership", gift.recipientMemberLinked),
        ].join(" · ")}
      />
      {gift.issues.length > 0 ? (
        <Field
          label="Integrity review"
          value={`${gift.issues.length} contained issue${gift.issues.length === 1 ? "" : "s"}`}
          hint="Contradictory or malformed evidence is never promoted to a trustworthy fact."
        />
      ) : null}
      <Text
        {...typeCap("caption")}
        style={{
          color: drift ? t.warning : t.fgSubtle,
          ...typeStyle("caption"),
          marginTop: 2,
          fontFamily: drift ? FONT.semibold : FONT.regular,
        }}
      >
        {fresh.isFetching
          ? "Refreshing lifecycle evidence…"
          : fresh.isError
            ? "The refresh failed. These values are from the loaded archive page."
            : fresh.data === null
              ? "This record is no longer available to the current workspace."
              : drift
                ? `Lifecycle changed from ${giftStatusLabel(drift.from)} to ${giftStatusLabel(drift.to)}.`
                : fresh.data === undefined
                  ? "Not refreshed yet — these values are from the loaded archive page."
                  : "Confirmed against the server just now."}
      </Text>
    </View>
  );
}

function evidenceLabel(label: string, value: boolean | null): string {
  return `${label}: ${value === null ? "unknown" : value ? "recorded" : "not recorded"}`;
}

function Field({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${value === EMDASH ? "not recorded" : value}.${hint ? ` ${hint}` : ""}`}
    >
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {value}
      </Text>
      {hint ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export const GiftRow = memo(GiftRowImpl);
