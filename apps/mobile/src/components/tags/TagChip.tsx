/**
 * TagChip — one chip in the tag catalogue.
 *
 * Two things it does that the old inline chip did not:
 *
 *  - it is TAPPABLE. The chip had only `onLongPress` (share), so "who is
 *    tagged VIP?" meant memorising the name, backing out to Subscribers
 *    and typing it in. It now routes to the subscribers list seeded with
 *    the tag name — `GET /api/v1/subscribers?q=` matches against
 *    `unnest(tags)` (apps/api/internal/subscribers/repo_helpers.go
 *    subscriberSearchILIKE), so the destination really is the people who
 *    carry it.
 *  - it renders the colour, description and `pii` flag the API already
 *    returns and mobile was discarding at its type boundary.
 *  - LONG PRESS OPENS A MENU, not a share sheet. The chip spent the phone's
 *    right-click on `Share.share()`, which is the least likely thing anyone
 *    wants from a tag; the screen owns a RowActionSheet now and this component
 *    only reports the gesture (LOVE#32).
 *  - THE MENU IS ALSO A ROTOR ACTION. A long press is invisible to VoiceOver
 *    and cannot be performed with it at all, so a gesture-only menu is the
 *    exact regression `SwipeableRow` refuses to ship ("without it, swipe
 *    actions make the app *less* accessible than it was"). The chip publishes
 *    the same verbs as `accessibilityActions`, mirroring `MoreRows`.
 *
 *    The action NAMES are static and the ROW is a parameter of the callback,
 *    so both props are stable across renders and the `memo` below still holds
 *    for a 60-chip cloud.
 *
 * The colour is a left accent bar, never the sole carrier of meaning, and
 * PII is a text badge rather than a hue.
 */
import { memo } from "react";
import { Link } from "expo-router";
import { Pressable, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import {
  isTagArchived,
  tagSpokenLabel,
  type TagCatalogueRow,
} from "@/lib/tagCatalogue";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** One verb the chip publishes to assistive tech. Names must match the
 *  RowAction keys the screen's menu builds —
 *  `__tests__/row-action-menu.native.test.tsx` pins the two against each
 *  other, since nothing else ties a module constant to per-row closures. */
export interface TagChipAction {
  name: string;
  label: string;
}

function TagChipBody({
  row,
  createdText,
  onLongPress,
  actions,
  onAction,
}: {
  row: TagCatalogueRow;
  /** Pre-formatted created date, or "" when the row carries none. */
  createdText: string;
  /** Long press. The screen decides which verbs the menu offers. */
  onLongPress: (row: TagCatalogueRow) => void;
  /**
   * The menu's verbs, republished in the VoiceOver rotor. Pass a module-level
   * constant — a fresh array per render defeats this component's `memo`.
   */
  actions: readonly TagChipAction[];
  /** Run one published verb against this row. */
  onAction: (row: TagCatalogueRow, name: string) => void;
}) {
  const { t } = useTheme();
  const label = row.name || "(unnamed)";
  const archived = isTagArchived(row);
  const secondary = row.description || createdText;

  return (
    <Link
      href={{ pathname: "/(tabs)/subscribers", params: { q: label } }}
      asChild
    >
      <Pressable
        onLongPress={() => onLongPress(row)}
        accessibilityRole="button"
        accessibilityLabel={tagSpokenLabel(row, createdText)}
        // Same shape as MoreRows: the gesture and the rotor reach the SAME
        // verbs, so a screen-reader user gains the menu rather than being told
        // about a gesture they cannot make.
        accessibilityActions={actions as { name: string; label: string }[]}
        onAccessibilityAction={(event: {
          nativeEvent: { actionName: string };
        }) => {
          onAction(row, event.nativeEvent.actionName);
        }}
        // NativeWind v4: a function-style `style` on Pressable silently
        // drops layout. Static object only.
        style={{
          backgroundColor: t.surface,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderLeftWidth: row.color ? 4 : 1,
          borderLeftColor: row.color ?? t.borderSubtle,
          borderRadius: secondary ? 14 : 999,
          paddingHorizontal: 12,
          paddingVertical: 8,
          minHeight: 44,
          justifyContent: "center",
          // Cap the chip so an unbreakable, very long tag name ellipsises
          // instead of sizing past the screen edge and clipping silently.
          maxWidth: "100%",
          opacity: archived ? 0.6 : 1,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text
            {...typeCap("control")}
            style={{
              color: t.fg,
              ...typeStyle("control"),
              fontWeight: "500",
              fontFamily: FONT.medium,
              flexShrink: 1,
            }}
            numberOfLines={1}
          >
            {label}
          </Text>
          {row.pii ? (
            <Text
              {...typeCap("badgeSmall")}
              style={{
                color: t.warning,
                ...typeStyle("badgeSmall"),
                fontWeight: "700",
                fontFamily: FONT.bold,
                letterSpacing: 0.4,
              }}
            >
              PII
            </Text>
          ) : null}
          {archived ? (
            <Text
              {...typeCap("badgeSmall")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("badgeSmall"),
                fontWeight: "700",
                fontFamily: FONT.bold,
                letterSpacing: 0.4,
              }}
            >
              ARCHIVED
            </Text>
          ) : null}
        </View>
        {secondary ? (
          <Text
            {...typeCap("badgeSmall")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("badgeSmall"),
              marginTop: 2,
              fontFamily: FONT.regular,
            }}
            numberOfLines={1}
          >
            {secondary}
          </Text>
        ) : null}
      </Pressable>
    </Link>
  );
}

export const TagChip = memo(TagChipBody);
