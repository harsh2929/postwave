/**
 * MoreSection / MoreRowItem — the sectioned destination list.
 *
 * Split out of more.tsx for the source budget. Row geometry uses `minHeight`
 * rather than a fixed vertical padding so rows grow instead of clipping at
 * accessibility text sizes, and a row's badge is folded into the spoken label
 * (a bare coloured pill is invisible to VoiceOver).
 */
import { router } from "expo-router";
import { Pressable, Text, View } from "react-native";

import { EmptyState } from "@/components/EmptyState";
import { NewFeatureBadge } from "@/components/settings/NewFeatureBadge";
import { TabBarIcon, type IconName } from "@/components/TabBarIcon";
import { iconTile, sectionLabel } from "@/components/more/moreStyles";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { moreFilterHeading } from "@/lib/moreFilter";
import { newFeatureLabel } from "@/lib/newFeatures";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** "New: API usage & cost dashboard", or a bare "New" if the label is gone. */
function newFeatureSpokenSuffix(featureKey: string): string {
  const label = newFeatureLabel(featureKey);
  return label ? `New: ${label}` : "New";
}

export type MoreRow = {
  key: string;
  icon: IconName;
  label: string;
  hint?: string;
  to?: string;
  onPress?: () => void;
  destructive?: boolean;
  /** Trailing count, e.g. unread notifications. May be capped ("99+"). */
  badge?: string;
  /**
   * What the badge SAYS out loud. The visible pill is capped for layout, so
   * without this VoiceOver reads "99 plus unread" and the exact number — the
   * only reason to look at a count — is unavailable to a screen-reader user.
   */
  badgeSpoken?: string;
  /**
   * Feature key from `lib/newFeatures` when this destination is inside its
   * 30-day discovery window. Carries the KEY rather than a boolean so the pill
   * and the spoken label both name the feature the badge is about, and so the
   * what's-new card and this row can never disagree about what is new.
   */
  newFeatureKey?: string;
  /** Rendered as a pin glyph, and folded into the spoken label. */
  favorite?: boolean;
  /**
   * Pin/unpin. Exposed BOTH as a long press and as a VoiceOver rotor action —
   * a long press is invisible to a screen reader, so a gesture-only pin would
   * be a feature that exists for sighted users only.
   */
  onToggleFavorite?: (() => void) | undefined;
};

export function MoreSection({
  title,
  rows,
  t,
  onVisit,
}: {
  title: string;
  rows: MoreRow[];
  t: ReturnType<typeof useTheme>["t"];
  /** Called with the row key before navigating — feeds the Recent list. */
  onVisit?: ((key: string) => void) | undefined;
}) {
  if (rows.length === 0) return null;
  return (
    <View style={{ marginBottom: 24 }}>
      <Text
        accessibilityRole="header"
        // Uppercase group heading: prose, sits on its own row, so it earns the
        // loosest ceiling in the scale rather than clipping at 1.4x.
        {...typeCap("caption")}
        style={[
          sectionLabel(t),
          typeStyle("caption"),
          { marginStart: 16, marginBottom: 8 },
        ]}
      >
        {title}
      </Text>
      <View
        style={{
          backgroundColor: t.surface,
          marginHorizontal: 12,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: t.borderSubtle,
          overflow: "hidden",
        }}
      >
        {rows.map((r, i) => (
          <MoreRowItem
            key={r.key}
            row={r}
            isLast={i === rows.length - 1}
            t={t}
            onVisit={onVisit}
          />
        ))}
      </View>
    </View>
  );
}

/**
 * The filtered view of the whole menu — one ranked list instead of six
 * sections.
 *
 * `MoreSection` renders NULL when it has no rows, which is right while
 * browsing (an empty "Enterprise" section should not occupy a heading) and
 * exactly wrong here: a query that matches nothing would leave the screen
 * blank under a search box, which reads as a broken filter rather than an
 * answer. Zero matches is a real, statable result.
 */
export function FilteredDestinations({
  rows,
  query,
  t,
  onVisit,
}: {
  rows: MoreRow[];
  query: string;
  t: ReturnType<typeof useTheme>["t"];
  onVisit?: ((key: string) => void) | undefined;
}) {
  if (rows.length === 0) {
    return (
      <View style={{ marginHorizontal: 12, marginTop: 8 }}>
        <EmptyState
          title="No matching destination"
          description={`Nothing in this workspace's menu matches “${query}”. Screens you cannot access for your role are not listed.`}
        />
      </View>
    );
  }
  return (
    <MoreSection
      title={moreFilterHeading(rows.length)}
      rows={rows}
      t={t}
      onVisit={onVisit}
    />
  );
}

function MoreRowItem({
  row,
  isLast,
  t,
  onVisit,
}: {
  row: MoreRow;
  isLast: boolean;
  t: ReturnType<typeof useTheme>["t"];
  onVisit?: ((key: string) => void) | undefined;
}) {
  const labelColor = row.destructive ? t.danger : t.fg;
  const iconColor = row.destructive ? t.danger : t.fgMuted;
  const pinAction = row.onToggleFavorite;
  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        onVisit?.(row.key);
        if (row.onPress) row.onPress();
        else if (row.to) router.push(row.to as never);
      }}
      {...(pinAction
        ? {
            onLongPress: () => {
              haptics.impact();
              pinAction();
            },
            accessibilityActions: [
              {
                name: "pin",
                label: row.favorite ? "Unpin from Favourites" : "Pin to Favourites",
              },
            ],
            onAccessibilityAction: (event: {
              nativeEvent: { actionName: string };
            }) => {
              if (event.nativeEvent.actionName === "pin") pinAction();
            },
          }
        : {})}
      accessibilityRole="button"
      accessibilityLabel={[
        row.label,
        row.favorite ? "Pinned" : null,
        // The pill is drawn INSIDE this Pressable, which groups its children
        // for VoiceOver — so the badge's own label is never spoken and the
        // word has to be folded in here, exactly like the unread count.
        row.newFeatureKey ? newFeatureSpokenSuffix(row.newFeatureKey) : null,
        row.badge ? `${row.badgeSpoken ?? row.badge} unread` : null,
        row.hint,
      ]
        .filter(Boolean)
        .join(". ")}
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 16,
        // minHeight rather than a fixed vertical padding so the row grows
        // instead of clipping at accessibility text sizes.
        minHeight: 56,
        paddingVertical: 12,
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: t.borderSubtle,
      }}
    >
      <View style={iconTile(t)}>
        <TabBarIcon name={row.icon} color={iconColor} size={20} />
      </View>
      <View style={{ flex: 1, paddingEnd: 8 }}>
        <Text
          // Destination title = `body`, the app's reading size. The row has no
          // fixed height (minHeight 56 + padding), so it grows with the text.
          {...typeCap("body")}
          style={{
            color: labelColor,
            ...typeStyle("body"),
            fontWeight: "500",
            fontFamily: FONT.medium,
          }}
        >
          {row.label}
        </Text>
        {row.hint ? (
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("label"),
              marginTop: 2,
              fontFamily: FONT.regular,
            }}
          >
            {row.hint}
          </Text>
        ) : null}
      </View>
      {/* Discovery badge. Hidden from the accessibility tree because the row's
          own label already says it (see accessibilityLabel above); a second
          node would make VoiceOver read "New" twice on the same row. */}
      {row.newFeatureKey ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={{ marginEnd: 8 }}
        >
          <NewFeatureBadge featureKey={row.newFeatureKey} />
        </View>
      ) : null}
      {row.badge ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={{
            minWidth: 22,
            paddingHorizontal: 6,
            paddingVertical: 2,
            borderRadius: 999,
            backgroundColor: t.danger,
            alignItems: "center",
            justifyContent: "center",
            marginEnd: 8,
          }}
        >
          <Text
            // Count bubble: pinned geometry (minWidth 22, radius 999) sharing
            // the row with the chevron, so it takes the tight dense ceiling.
            {...typeCap("badgeSmall")}
            style={{
              color: t.accentFg,
              ...typeStyle("badgeSmall"),
              fontFamily: FONT.semibold,
            }}
          >
            {row.badge}
          </Text>
        </View>
      ) : null}
      {/* Pinned state is a glyph AND a word in the spoken label — never a
          colour on its own. The Favourites section above carries the same
          meaning by position. */}
      {row.favorite ? (
        <View style={{ marginEnd: 6 }}>
          <TabBarIcon name="check" color={t.accent} size={14} />
        </View>
      ) : null}
      {!row.destructive ? (
        <TabBarIcon name="chevron" color={t.fgSubtle} size={16} />
      ) : null}
    </Pressable>
  );
}

