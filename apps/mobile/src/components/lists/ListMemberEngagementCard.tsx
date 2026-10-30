/**
 * ListMemberEngagementCard — per-member opens/clicks for the rows the
 * Members section has materialised (desktop AnalyticsTab per-row
 * engagement, translated to the ListMemberHealthCard shape).
 *
 * Same three refusals as the health card, for the same reasons:
 *  - NEVER RUNS ON ITS OWN — the input is whatever pagination has loaded,
 *    so an automatic read would grade a moving target. Press-driven.
 *  - SAYS "LOADED MEMBERS", NEVER "THE LIST".
 *  - SAYS WHEN THE ANSWER IS TRIMMED — the server caps at 500 ids and the
 *    transport reports `capped`; a trimmed check silently presented as
 *    complete is a wrong number.
 *
 * NativeWind v4 house rule: the Pressable style is a STATIC object.
 */
import { Pressable, Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { Card, Label } from "@/components/subscriber/SubscriberDetailPrimitives";
import { usePerRowEngagementCheck } from "@/hooks/useListInsights";
import { FONT } from "@/lib/fonts";
import { relativeTime, plural } from "@/lib/format";
import { engagementCheckIds } from "@/lib/listInsightRows";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function ListMemberEngagementCard({
  listId,
  memberIds,
  blocked,
}: {
  listId: string | undefined;
  /** Ids of the members materialised right now. */
  memberIds: readonly (string | null | undefined)[];
  /** The online gate is closed — the screen already says why. */
  blocked: boolean;
}) {
  const { t } = useTheme();
  const check = usePerRowEngagementCheck(listId);
  const askable = engagementCheckIds(memberIds).ids.length;
  const result = check.data ?? null;

  if (askable === 0 && !result) return null;

  const disabled = blocked || check.isPending || askable === 0 || !listId;
  const onCheck = () => {
    if (disabled) return;
    haptics.tap();
    check.mutate(memberIds);
  };

  return (
    <Card
      accessibilityLabel="Engagement of loaded members"
      style={{ marginBottom: 12 }}
    >
      <Label>Member engagement</Label>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
          marginTop: 6,
        }}
      >
        Opens and clicks (last 90 days) for the members loaded on this screen
        right now — not the whole list.
      </Text>

      <View style={{ marginTop: 10, alignItems: "flex-start" }}>
        <Pressable
          onPress={onCheck}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={
            check.isPending
              ? "Checking engagement"
              : `Check ${plural(askable, "loaded member")}`
          }
          accessibilityState={{ disabled }}
          style={{
            backgroundColor: disabled ? t.bgSubtle : t.surface,
            borderColor: t.border,
            borderWidth: 1,
            borderRadius: 10,
            paddingHorizontal: 14,
            paddingVertical: 9,
          }}
        >
          <Text
            {...typeCap("label")}
            style={{
              color: disabled ? t.fgMuted : t.fg,
              ...typeStyle("label"),
              fontFamily: FONT.medium,
            }}
          >
            {check.isPending
              ? "Checking…"
              : `Check ${plural(askable, "loaded member")}`}
          </Text>
        </Pressable>
      </View>

      {check.isError ? (
        <ErrorState compact error={check.error} onRetry={onCheck} />
      ) : null}

      {result ? (
        <View style={{ marginTop: 12 }}>
          {result.capped ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
                marginBottom: 6,
              }}
            >
              Answer covers the first 500 loaded members — the server&apos;s cap.
            </Text>
          ) : null}
          {result.rows.length === 0 ? (
            <Text
              {...typeCap("label")}
              style={{
                color: t.fgMuted,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
              }}
            >
              No engagement events recorded for these members.
            </Text>
          ) : (
            result.rows.map((row, i) => (
              <View
                key={row.id}
                style={{
                  paddingVertical: 7,
                  borderTopWidth: i === 0 ? 0 : 1,
                  borderTopColor: t.border,
                  flexDirection: "row",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <Text
                  {...typeCap("label")}
                  style={{
                    color: t.fg,
                    ...typeStyle("label"),
                    fontFamily: FONT.regular,
                    flexShrink: 1,
                  }}
                  numberOfLines={1}
                >
                  {row.email}
                </Text>
                <Text
                  {...typeCap("caption")}
                  style={{
                    color: t.fgMuted,
                    ...typeStyle("caption"),
                    fontFamily: FONT.regular,
                    marginStart: 8,
                  }}
                >
                  {`${row.opens} opens · ${row.clicks} clicks${
                    row.lastEngagedAt
                      ? ` · ${relativeTime(row.lastEngagedAt, { fallback: "" })}`
                      : ""
                  }`}
                </Text>
              </View>
            ))
          )}
        </View>
      ) : null}
    </Card>
  );
}
