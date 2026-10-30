/**
 * SubscriberSelectionBar — the bar that appears when the subscribers list is
 * in selection mode.
 *
 * Modelled on iOS Mail/Photos: long-press a row to enter selection, tap rows
 * to add/remove, act from a bar pinned above the tab bar, Done to leave.
 *
 * Two things it does that a naive port would not:
 *
 *  - IT EXPLAINS ITS OWN UNAVAILABILITY. A viewer or an offline operator gets
 *    the reason as visible text AND as the buttons' accessibilityHint, rather
 *    than three greyed-out controls. Desktop solved this with
 *    `bulkAvailabilityCopy`; this is the phone's version of the same contract.
 *  - IT SAYS WHAT "ALL" MEANS. "Select all" over an infinite list selects the
 *    rows that are LOADED, never the workspace, and the button says "loaded"
 *    so it cannot be read as the latter.
 */
import { Text, View } from "react-native";

import { SubActionButton } from "@/components/subscriber/SubActionButton";
import { FONT } from "@/lib/fonts";
import type { ThemeTokens } from "@/lib/theme";
import {
  BULK_VERB_SPECS,
  selectionTitle,
  type BulkAvailability,
  type BulkVerb,
} from "@/lib/subscriberSelection";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SubscriberSelectionBar({
  count,
  loadedCount,
  allLoadedSelected,
  availability,
  pending,
  onVerb,
  onSelectAll,
  onClear,
  onDone,
  t,
}: {
  count: number;
  /** Rows materialised in the list right now — the ceiling "all" means. */
  loadedCount: number;
  allLoadedSelected: boolean;
  availability: BulkAvailability;
  pending: boolean;
  onVerb: (verb: BulkVerb) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onDone: () => void;
  t: ThemeTokens;
}) {
  const enabled = availability.enabled && !pending;
  const reason = availability.reason;

  return (
    <View
      // The bar is a distinct region so VoiceOver users can jump to it
      // instead of swiping back through every selected row.
      accessibilityRole="toolbar"
      accessibilityLabel={`${selectionTitle(count)}. Bulk actions.`}
      style={{
        borderTopColor: t.border,
        borderTopWidth: 1,
        backgroundColor: t.surface,
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 12,
        gap: 10,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
            flexShrink: 1,
          }}
          // Announced on every change so a screen-reader user hears the
          // count move as they tap rows.
          accessibilityLiveRegion="polite"
          numberOfLines={2}
        >
          {selectionTitle(count)}
        </Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <SubActionButton
            label={allLoadedSelected ? "Clear" : "Select loaded"}
            onPress={allLoadedSelected ? onClear : onSelectAll}
            disabled={loadedCount === 0}
            {...(loadedCount === 0
              ? { disabledReason: "No subscribers are loaded yet." }
              : {})}
            t={t}
          />
          <SubActionButton label="Done" onPress={onDone} t={t} />
        </View>
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {(Object.keys(BULK_VERB_SPECS) as BulkVerb[]).map((verb) => {
          const spec = BULK_VERB_SPECS[verb];
          return (
            <SubActionButton
              key={verb}
              label={spec.label}
              onPress={() => onVerb(verb)}
              disabled={!enabled}
              busy={pending}
              {...(spec.destructive ? { danger: true } : {})}
              {...(reason ? { disabledReason: reason } : {})}
              t={t}
            />
          );
        })}
      </View>

      {reason && !availability.enabled ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {reason}
        </Text>
      ) : null}
    </View>
  );
}
