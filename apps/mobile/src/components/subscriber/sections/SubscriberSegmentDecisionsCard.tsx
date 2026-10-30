/**
 * SubscriberSegmentDecisionsCard — "why is this person (not) in that
 * segment", answered from the phone (SUB-070, EU AI Act Art. 86).
 *
 * Desktop's SegmentDecisionsPanel on the disclosure idiom: live membership
 * per tenant segment with the server-authored summary sentence, expandable
 * per-condition reasons, then any stored decision snapshots. Every sentence
 * is rendered VERBATIM from the server — this card never re-derives a
 * decision it is supposed to be explaining.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { SkeletonList } from "@/components/Skeleton";
import {
  DisclosureEmptyLine,
  SubscriberDisclosureCard,
} from "@/components/subscriber/sections/SubscriberDisclosureCard";
import { useSubscriberSegmentDecisions } from "@/hooks/useSubscriberProfileData";
import { FONT } from "@/lib/fonts";
import { date } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import type { SegmentMembershipRow } from "@/lib/subscriberSegmentDecisions";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

function MembershipRow({ row }: { row: SegmentMembershipRow }) {
  const { t } = useTheme();
  const [expanded, setExpanded] = useState(false);
  return (
    <View
      style={{
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        paddingVertical: 8,
        gap: 4,
      }}
    >
      <Pressable
        onPress={() => {
          haptics.tap();
          setExpanded((v) => !v);
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${row.segmentName}: ${row.isMember ? "member" : "not a member"}`}
        accessibilityHint="Shows each condition's reason"
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.medium,
          }}
        >
          {row.isMember ? "In" : "Not in"} {row.segmentName}
        </Text>
        {row.summary ? (
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgMuted,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
            }}
          >
            {row.summary}
          </Text>
        ) : null}
      </Pressable>
      {expanded
        ? row.conditions.map((condition, i) => (
            <Text
              key={i}
              {...typeCap("label")}
              style={{
                color: condition.matched ? t.fgMuted : t.fgSubtle,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
              }}
            >
              {condition.matched ? "✓" : "✗"} {condition.description}
            </Text>
          ))
        : null}
    </View>
  );
}

export function SubscriberSegmentDecisionsCard({
  subscriberId,
}: {
  subscriberId: string;
}) {
  const { t } = useTheme();
  const [open, setOpen] = useState(false);
  const decisions = useSubscriberSegmentDecisions(subscriberId, open);
  const view = decisions.data;
  const empty =
    view && view.memberships.length === 0 && view.stored.length === 0;

  return (
    <SubscriberDisclosureCard
      title="Segment decisions"
      hint="Why automated segmentation includes or excludes this person"
      open={open}
      count={view ? view.memberships.length : null}
      onToggle={() => setOpen((v) => !v)}
    >
      {decisions.isLoading ? (
        <SkeletonList rows={3} />
      ) : decisions.isError ? (
        <ErrorState
          error={decisions.error}
          onRetry={() => void decisions.refetch()}
        />
      ) : !view || empty ? (
        <DisclosureEmptyLine text="No segments are defined, and no decisions have been recorded for this contact." />
      ) : (
        <>
          {view.memberships.map((row) => (
            <MembershipRow key={row.segmentId} row={row} />
          ))}
          {view.stored.map((row) => (
            <View
              key={row.id}
              accessible
              accessibilityLabel={`${row.typeLabel} decision snapshot`}
              style={{
                borderTopColor: t.borderSubtle,
                borderTopWidth: 1,
                paddingVertical: 8,
                gap: 2,
              }}
            >
              <Text
                {...typeCap("label")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("label"),
                  fontFamily: FONT.medium,
                }}
              >
                {row.typeLabel} decision
                {row.createdAt ? ` · ${date(row.createdAt)}` : ""}
              </Text>
              {row.snapshot.slice(0, 6).map(([key, value]) => (
                <Text
                  key={key}
                  {...typeCap("label")}
                  style={{
                    color: t.fgSubtle,
                    ...typeStyle("label"),
                    fontFamily: FONT.regular,
                  }}
                  numberOfLines={2}
                >
                  {key}: {value}
                </Text>
              ))}
            </View>
          ))}
        </>
      )}
    </SubscriberDisclosureCard>
  );
}
