/**
 * The profile's action row, plus the one line that explains why the buttons
 * are unavailable when they are.
 *
 * Previously the four actions greyed out with zero explanation whenever the
 * user was offline — and stayed ENABLED for a read-only viewer, who got a
 * destructive confirm dialog followed by a raw 403.
 */
import { Text, View } from "react-native";

import { SubActionButton } from "@/components/subscriber/SubActionButton";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SubscriberActionRow({
  canMutate,
  canAddToList,
  unavailableReason,
  addToListUnavailableReason,
  busy,
  isSettingStatus,
  isSubscribed,
  onEditTags,
  onAddToList,
  onUnsubscribe,
  onResubscribe,
}: {
  canMutate: boolean;
  /**
   * AUDIENCE#33. "Add to list" is the ONE audience write that survives a
   * replay — the handler only ever adds and the route is idempotent by
   * construction — so it is queued offline while every other action here
   * still needs a live connection. Defaults to `canMutate` so a caller that
   * does not know about the queue keeps the old behaviour.
   */
  canAddToList?: boolean | undefined;
  unavailableReason?: string | undefined;
  addToListUnavailableReason?: string | undefined;
  busy: boolean;
  isSettingStatus: boolean;
  isSubscribed: boolean;
  onEditTags: () => void;
  onAddToList: () => void;
  onUnsubscribe: () => void;
  onResubscribe: () => void;
}) {
  const { t } = useTheme();
  const reason = unavailableReason ? { disabledReason: unavailableReason } : {};
  const addAllowed = canAddToList ?? canMutate;
  const addReason = addToListUnavailableReason
    ? { disabledReason: addToListUnavailableReason }
    : reason;
  return (
    <>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          marginTop: 12,
        }}
      >
        <SubActionButton
          label="Edit tags"
          onPress={onEditTags}
          disabled={!canMutate || busy}
          {...reason}
          t={t}
        />
        <SubActionButton
          label="Add to list"
          onPress={onAddToList}
          disabled={!addAllowed || busy}
          {...addReason}
          t={t}
        />
        {isSubscribed ? (
          <SubActionButton
            label={isSettingStatus ? "Unsubscribing…" : "Unsubscribe"}
            danger
            onPress={onUnsubscribe}
            disabled={!canMutate || busy}
            busy={isSettingStatus}
            {...reason}
            t={t}
          />
        ) : (
          <SubActionButton
            label={isSettingStatus ? "Resubscribing…" : "Resubscribe"}
            onPress={onResubscribe}
            disabled={!canMutate || busy}
            busy={isSettingStatus}
            {...reason}
            t={t}
          />
        )}
      </View>
      {!canMutate && unavailableReason ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            marginTop: 8,
            fontFamily: FONT.regular,
          }}
        >
          {unavailableReason}
        </Text>
      ) : null}
    </>
  );
}
