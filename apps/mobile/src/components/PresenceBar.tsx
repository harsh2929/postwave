/**
 * PresenceBar — the mobile end of the presence signal.
 *
 * The server has broadcast `presence.update` since the desktop avatar stack
 * landed, and this app has been INCREMENTING that counter — from the
 * connection lib/eventCacheSync opens at launch — while rendering none of it.
 * Desktop shows it (components/PresenceIndicator.tsx), web shows it
 * (lib/realtime/use-presence.ts); the phone was the one client that only
 * published.
 *
 * Design rules, all of which the two reference clients also follow:
 *  - RENDERS NOTHING WHEN ALONE. Presence is advisory. A permanent "0 others"
 *    badge is noise on every screen it sits on, so `presenceSummary` returns
 *    null and this returns null with it.
 *  - THE BUBBLES ARE NEVER THE ONLY SIGNAL. Initials in coloured circles are
 *    unreadable to a screen reader and ambiguous in greyscale, so the whole
 *    row is one accessibility node carrying the spoken sentence, and the count
 *    is also printed as a word.
 *  - IT IS NOT A LOCK. Copy says who is here, never "wait" or "locked": the
 *    server tracks connections for information, and nothing on either side
 *    prevents a concurrent edit.
 *
 * WHERE IT IS MOUNTED, AND WHY ONLY THERE. One call site:
 * `app/(tabs)/dashboard.tsx`, in the "right now" band immediately above the
 * reporting controls that carry the freshness receipt. The reasoning:
 *
 *  - The signal is WORKSPACE-scoped, so it belongs on the one screen whose
 *    subject is the workspace, not on chrome every screen draws. Putting it in
 *    ScreenHeader would repeat the same sentence on ~70 tabs.
 *  - It sits beside the Live/updated-at receipt because they answer the same
 *    question from two sides: the receipt says the data is current, presence
 *    says you are not the only person looking at it.
 *  - It does not sit above ActiveSendStrip / ResumeCard. Those two are the
 *    screen's urgent self-gating strips; an advisory row must not outrank a
 *    send in flight.
 *  - It cannot churn with the poll. The store commits only when the viewer
 *    list actually CHANGES (presenceStore.applyWorkspacePresence compares
 *    first), and it is fed by connect/disconnect frames, not by the 30s
 *    dashboard poll — so it does not reflow the screen under a reader.
 *  - `style` carries the spacing so the alone case reflows nothing at all.
 *
 * The `entityRef` path below is deliberately NOT mounted anywhere yet — see
 * hooks/usePresence.ts for the cost argument.
 */
import { Text, View, type StyleProp, type ViewStyle } from "react-native";

import { useEntityPresence, useWorkspacePresence } from "@/hooks/usePresence";
import { FONT } from "@/lib/fonts";
import { presenceInitials, presenceSummary } from "@/lib/presence";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface PresenceBarProps {
  /**
   * Scope. Omit for workspace-wide presence, which is free (it reads the
   * connection that is already open). Pass a ref from
   * `presenceEntityRefFor("campaign", id)` to show who is on THIS record —
   * that opens a second, entity-scoped subscription for as long as this is
   * mounted, so use it on detail screens only.
   */
  entityRef?: string | null;
  /**
   * Spacing from the call site. It has to live on the root rather than in a
   * wrapper View: this component renders NULL when the user is alone, which is
   * the common case, and a wrapper carrying the margin would leave a permanent
   * empty gap on a screen showing no presence at all.
   */
  style?: StyleProp<ViewStyle>;
}

export function PresenceBar({ entityRef, style }: PresenceBarProps) {
  const { t } = useTheme();
  const workspace = useWorkspacePresence();
  const record = useEntityPresence(entityRef ?? null);
  const snapshot = entityRef ? record : workspace;
  const summary = presenceSummary(snapshot, entityRef ? "record" : "workspace");

  if (!summary) return null;

  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={summary.accessibilityLabel}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          maxWidth: "100%",
        },
        style,
      ]}
    >
      <View
        importantForAccessibility="no-hide-descendants"
        style={{ flexDirection: "row", alignItems: "center" }}
      >
        {snapshot.viewers.map((viewer, index) => (
          <View
            key={`${viewer.id ?? "anon"}-${index}`}
            style={{
              width: 22,
              height: 22,
              borderRadius: 11,
              alignItems: "center",
              justifyContent: "center",
              borderWidth: 1,
              borderColor: t.borderSubtle,
              backgroundColor: t.surface,
              // Overlap into a stack, like desktop's.
              marginStart: index === 0 ? 0 : -6,
            }}
          >
            <Text
              {...typeCap("badgeSmall")}
              numberOfLines={1}
              style={{
                color: t.fgMuted,
                ...typeStyle("badgeSmall"),
                fontFamily: FONT.semibold,
              }}
            >
              {presenceInitials(viewer.label)}
            </Text>
          </View>
        ))}
      </View>
      <Text
        importantForAccessibility="no-hide-descendants"
        {...typeCap("badgeSmall")}
        numberOfLines={1}
        style={{
          flexShrink: 1,
          color: t.fgSubtle,
          ...typeStyle("badgeSmall"),
          fontFamily: FONT.regular,
        }}
      >
        {summary.label}
      </Text>
    </View>
  );
}
