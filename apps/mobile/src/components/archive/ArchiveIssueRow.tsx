/**
 * ArchiveIssueRow — one published issue in the index.
 *
 * Extracted from app/(tabs)/archive.tsx when that screen took on preview and
 * unpublish, both of which belong to the ROW rather than the list. The screen
 * keeps paging, search and provenance; the row keeps its own affordances.
 *
 * The interaction model changed with the extraction and the change is the
 * point:
 *
 *  - TAPPING THE CARD OPENS THE IN-APP PREVIEW, not Safari. It cannot 404 and
 *    it cannot lose your place in a 260-issue index.
 *  - "Open ↗" still goes to the real published page, but through the in-app
 *    browser, so returning is a dismiss rather than an app switch.
 *  - UNPUBLISH is a swipe action, which `SwipeableRow` also publishes to the
 *    VoiceOver rotor. It is admin-gated to mirror the server
 *    (`RequireScope(ScopeAdmin)`, archive.go:649) so nobody is offered a
 *    control that can only ever 403.
 *  - PIN / UNPIN sit beside it, and only ONE of the pair is ever offered —
 *    whichever the row's current `pinned` state makes meaningful. Offering
 *    both would put a no-op next to a real action; the server treats pinning
 *    an already-pinned issue as an idempotent success (views.go:317), so the
 *    no-op would even LOOK like it worked.
 *
 * PIN IS ORDERED BEFORE UNPUBLISH because the swipe tray puts the first entry
 * closest to the thumb, and unpublish is the destructive one. A reversible
 * ordering change should not be the easier mis-tap than a 404 for every
 * subscriber holding the link.
 */
import { memo, useCallback } from "react";
import { Pressable, Text, View } from "react-native";

import { SwipeableRow, type SwipeAction } from "@/components/SwipeableRow";
import type { ArchiveIssue } from "@/hooks/useArchiveOps";
import { FONT } from "@/lib/fonts";
import { date, num, plural } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function archiveRowMeta(row: ArchiveIssue): string {
  const parts = [date(row.publishedAt)];
  // ABSENCE IS NOT ZERO — an issue with no recorded views says nothing about
  // views, so it says nothing at all rather than claiming "0 views".
  if (row.viewCount > 0) parts.push(plural(row.viewCount, "view"));
  if (row.uniqueVisitors > 0) parts.push(`${num(row.uniqueVisitors)} unique`);
  return parts.join(" · ");
}

export interface ArchiveIssueRowProps {
  row: ArchiveIssue;
  onPreview: (row: ArchiveIssue) => void;
  onOpenPublic: (row: ArchiveIssue) => void;
  onShare: (row: ArchiveIssue) => void;
  /** Null when the signed-in role cannot unpublish — the action is then absent. */
  onUnpublish: ((row: ArchiveIssue) => void) | null;
  /**
   * Null below admin, exactly like `onUnpublish`. Both archive writes sit
   * behind the same `RequireScope(ScopeAdmin)` mount, so a role that cannot
   * retract cannot feature either.
   */
  onTogglePin: ((row: ArchiveIssue) => void) | null;
}

function ArchiveIssueRowImpl({
  row,
  onPreview,
  onOpenPublic,
  onShare,
  onUnpublish,
  onTogglePin,
}: ArchiveIssueRowProps) {
  const { t } = useTheme();
  const title = row.subject || row.slug;
  const meta = archiveRowMeta(row);

  const handlePreview = useCallback(() => onPreview(row), [onPreview, row]);
  const handleOpen = useCallback(() => onOpenPublic(row), [onOpenPublic, row]);
  const handleShare = useCallback(() => onShare(row), [onShare, row]);
  const handleUnpublish = useCallback(
    () => onUnpublish?.(row),
    [onUnpublish, row],
  );
  const handleTogglePin = useCallback(
    () => onTogglePin?.(row),
    [onTogglePin, row],
  );

  const actions: SwipeAction[] = [];
  if (onTogglePin) {
    actions.push({
      label: row.pinned ? "Unpin" : "Pin",
      kind: "primary",
      onPress: handleTogglePin,
    });
  }
  if (onUnpublish) {
    actions.push({ label: "Unpublish", kind: "danger", onPress: handleUnpublish });
  }

  return (
    <SwipeableRow
      right={actions}
      enabled={actions.length > 0}
      accessibilityLabel={`${title}. ${meta}`}
    >
      <View
        style={{
          backgroundColor: t.surface,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderRadius: 14,
          flexDirection: "row",
          alignItems: "flex-start",
        }}
      >
        <Pressable
          onPress={handlePreview}
          accessibilityRole="button"
          accessibilityLabel={`Preview ${title}. ${meta}`}
          accessibilityHint="Opens the issue inside the app"
          style={{ flex: 1, padding: 14 }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {row.pinned ? (
              <View
                style={{
                  backgroundColor: t.surfaceElevated,
                  borderColor: t.border,
                  borderWidth: 1,
                  borderRadius: 6,
                  paddingHorizontal: 6,
                  paddingVertical: 1,
                }}
              >
                <Text
                  {...typeCap("badgeSmall")}
                  style={{
                    color: t.accent,
                    fontFamily: FONT.bold,
                    ...typeStyle("badgeSmall"),
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                  }}
                >
                  Pinned
                </Text>
              </View>
            ) : null}
            <Text
              {...typeCap("body")}
              style={{
                color: t.fg,
                fontFamily: FONT.semibold,
                ...typeStyle("body"),
                flexShrink: 1,
              }}
              numberOfLines={2}
            >
              {title}
            </Text>
          </View>
          {row.excerpt ? (
            <Text
              {...typeCap("label")}
              style={{
                color: t.fgMuted,
                ...typeStyle("label"),
                marginTop: 6,
                fontFamily: FONT.regular,
              }}
              numberOfLines={2}
            >
              {row.excerpt}
            </Text>
          ) : null}
          <Text
            {...typeCap("numeric")}
            style={{
              color: t.fgSubtle,
              fontFamily: FONT.regular,
              ...typeStyle("numeric"),
              fontVariant: ["tabular-nums"],
              marginTop: 8,
            }}
            numberOfLines={1}
          >
            {meta}
          </Text>
        </Pressable>
        {/* Laid out in the flex row rather than absolutely positioned with
            `right: 8`, which does not mirror under RTL — the buttons used to
            land on top of the title in Arabic and Hebrew. */}
        <View style={{ paddingTop: 6, paddingEnd: 2 }}>
          <RowIconButton
            glyph={"\u2197\uFE0E"}
            label={`Open ${title} on the web`}
            onPress={handleOpen}
          />
          <RowIconButton
            glyph={"\u2934\uFE0E"}
            label={`Share ${title}`}
            onPress={handleShare}
          />
        </View>
      </View>
    </SwipeableRow>
  );
}

function RowIconButton({
  glyph,
  label,
  onPress,
}: {
  glyph: string;
  label: string;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        width: 44,
        height: 44,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* Decorative glyph inside a fixed 44pt target — its meaning is carried
          by the button's a11y label, and it must not scale the target. */}
      <Text
        allowFontScaling={false}
        style={{ color: t.accent, fontSize: 16, fontFamily: FONT.regular }}
      >
        {glyph}
      </Text>
    </Pressable>
  );
}

export const ArchiveIssueRow = memo(ArchiveIssueRowImpl);
