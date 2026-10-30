/**
 * StoreCardActions — the verbs beneath one store card.
 *
 * THE ACTION ROW. Resume, Pause and More sit in one row beneath the body, each
 * its own sibling Pressable. Pause and More are only RENDERED when the screen
 * passes their handlers — an admin who is online — so a viewer sees the same
 * card minus the verbs, never a verb that 403s. A paused store keeps its
 * Pause button visible but disabled with the reason spoken, because there is
 * no un-pause route (lib/commerceConnection.ts) and a button that vanished
 * would leave the state unexplained.
 *
 * It renders nothing at all when the screen passes no handlers, which is why
 * the row lives here rather than inside StoreCard's own Pressable: the card
 * body and these buttons must stay SIBLINGS (see StoreCard).
 *
 * NativeWind v4: static style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { pauseVerb } from "@/lib/commerceConnection";
import type { CommerceStore } from "@/lib/commerceRollup";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface StoreCardActionsProps {
  store: CommerceStore;
  /** The card's own heading, so a spoken label names the same thing. */
  title: string;
  disconnected: boolean;
  paused: boolean;
  /** Undefined hides the action entirely (no admin scope / offline). */
  onResume?: ((store: CommerceStore) => void) | undefined;
  resuming: boolean;
  /** Undefined hides the action entirely (not owner/admin, or offline). */
  onPause?: ((store: CommerceStore) => void) | undefined;
  pausing: boolean;
  /** Undefined hides the overflow entirely (not owner/admin, or offline). */
  onMore?: ((store: CommerceStore) => void) | undefined;
}

export function StoreCardActions({
  store,
  title,
  disconnected,
  paused,
  onResume,
  resuming,
  onPause,
  pausing,
  onMore,
}: StoreCardActionsProps) {
  const { t } = useTheme();
  const pause = pauseVerb(store);
  const pauseDisabled = pausing || !pause.enabled;

  if (!onResume && !onPause && !onMore) return null;

  return (
    <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
      {onResume ? (
        <Pressable
          onPress={() => onResume(store)}
          disabled={resuming || disconnected}
          accessibilityRole="button"
          accessibilityLabel={
            disconnected
              ? `${title} is disconnected — reconnect it on the web admin before syncing`
              : `Resume the ${title} sync`
          }
          accessibilityHint="Asks the server to continue the backfill from where it stopped"
          accessibilityState={{
            disabled: resuming || disconnected,
            busy: resuming,
          }}
          style={{
            flex: 1,
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 10,
            borderWidth: 1,
            borderColor: t.border,
            opacity: resuming || disconnected ? 0.45 : 1,
          }}
        >
          <Text
            {...typeCap("callout")}
            style={{
              color: t.accent,
              ...typeStyle("callout"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            {resuming ? "Starting…" : "Resume sync"}
          </Text>
        </Pressable>
      ) : null}

      {onPause ? (
        <Pressable
          onPress={() => onPause(store)}
          disabled={pauseDisabled}
          accessibilityRole="button"
          accessibilityLabel={
            pause.enabled ? `Pause the ${title} integration` : pause.reason
          }
          accessibilityHint="Marks the store paused; everything already imported is kept"
          accessibilityState={{ disabled: pauseDisabled, busy: pausing }}
          style={{
            flex: 1,
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 10,
            borderWidth: 1,
            borderColor: t.border,
            opacity: pauseDisabled ? 0.45 : 1,
          }}
        >
          <Text
            {...typeCap("callout")}
            style={{
              color: t.accent,
              ...typeStyle("callout"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            {pausing ? "Pausing…" : paused ? "Paused" : "Pause"}
          </Text>
        </Pressable>
      ) : null}

      {onMore ? (
        <Pressable
          onPress={() => onMore(store)}
          accessibilityRole="button"
          accessibilityLabel={`More actions for ${title}`}
          accessibilityHint="Opens the disconnect option"
          style={{
            minWidth: 44,
            minHeight: 44,
            paddingHorizontal: 12,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 10,
            borderWidth: 1,
            borderColor: t.border,
          }}
        >
          <Text
            {...typeCap("callout")}
            style={{
              color: t.fgMuted,
              ...typeStyle("callout"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            More
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
