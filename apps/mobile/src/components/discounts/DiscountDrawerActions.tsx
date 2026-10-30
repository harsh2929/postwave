/**
 * DiscountDrawerActions — the things you can do about one code.
 *
 * WHY THEY LIVE IN THE DRAWER AND NOT ON THE COLLAPSED ROW. A list of two
 * hundred codes with three buttons on every row is six hundred targets for a
 * screen whose job is to be scanned. Each of these acts on a code the operator
 * has already singled out by opening it, and two of them are only meaningful
 * next to what the drawer says:
 *
 *   - "Load more" answers the footnote directly above it. `useDiscountRedemptions`
 *     GROWS its `limit` rather than paging by offset, so this re-asks for a
 *     bigger window (see the hook's own note) — the rows already on screen stay
 *     put and nothing can be duplicated or skipped by a redemption landing
 *     mid-read.
 *   - "Export" is the escape hatch from that same footnote: the drawer is a
 *     window onto a set that can be four hundred rows long, and
 *     GET /api/v1/discounts/{code}/redemptions.csv is the whole set.
 *   - "Extend" is the additive-only edit (PATCH /api/v1/discounts/{code}).
 *   - "Delete code" is the kill switch (DELETE /api/v1/discounts/{code}) — the
 *     only verb here that STOPS something, and the reason this row is worth
 *     reaching for on a phone at all. "This code is on Reddit" is not a
 *     desk-hours problem, and Extend cannot answer it: the server's edit is
 *     additive-only by rule, so the cap cannot come down and the expiry cannot
 *     move earlier.
 *
 * ALL THREE MUTATIONS are omitted entirely — not disabled — when they cannot
 * work, because a disabled button on a phone is a promise you cannot keep.
 * They can be unreachable for two different reasons: the session's role cannot
 * use them, OR the route is not mounted in this build at all. See
 * lib/discountMutationBoundary, whose guard test parses the Go mount list so
 * these arrive null the moment a route goes away.
 *
 * DELETE IS LAST AND IT IS THE ONLY DANGER-TONED CONTROL, deliberately. It sits
 * after the two additive verbs so the destructive one is never where a thumb
 * lands by default, and the colour is reinforcement rather than the signal —
 * the label says "Delete", and the confirm sheet behind it asks for the code to
 * be typed (see discountDeleteCopy).
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { discountDeleteActionLabel } from "@/components/discounts/discountDeleteCopy";
import { FONT } from "@/lib/fonts";
import { num } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface DiscountDrawerActionsProps {
  code: string;
  /** Lifetime redemptions from the row itself, not from the loaded rows. */
  used: number;
  /** Rows currently in the drawer. */
  shown: number;
  /** True when the server is known to hold rows this drawer has not asked for. */
  canLoadMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  exporting: boolean;
  /** Null when the whole-set CSV route is not reachable from this build. */
  onExport: ((code: string, total: number) => void) | null;
  /** Null when the session's role cannot PATCH a discount, or PATCH is unmounted. */
  onEdit: ((code: string) => void) | null;
  /**
   * Null when the session's role cannot DELETE a discount, or the kill switch
   * is unreachable in this build.
   */
  onDelete: ((code: string, used: number) => void) | null;
  /** A delete is in flight; the control stays mounted and says so. */
  deleting: boolean;
}

export function DiscountDrawerActions({
  code,
  used,
  shown,
  canLoadMore,
  loadingMore,
  onLoadMore,
  exporting,
  onExport,
  onEdit,
  onDelete,
  deleting,
}: DiscountDrawerActionsProps) {
  const remaining = Math.max(0, used - shown);
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        gap: 8,
        marginTop: 12,
      }}
    >
      {canLoadMore ? (
        <DrawerButton
          label={loadingMore ? "Loading…" : "Load more"}
          // The exact remainder, spoken. "Load more" alone does not say
          // whether the next tap ends the list or is the first of forty.
          accessibilityLabel={
            loadingMore
              ? "Loading more redemptions"
              : `Load more redemptions. ${num(remaining)} not shown.`
          }
          busy={loadingMore}
          onPress={onLoadMore}
        />
      ) : null}
      {used > 0 && onExport ? (
        <DrawerButton
          label={exporting ? "Preparing…" : "Export CSV"}
          accessibilityLabel={
            exporting
              ? "Preparing the redemption export"
              : `Export every redemption of ${code} as a spreadsheet`
          }
          busy={exporting}
          onPress={() => onExport(code, used)}
        />
      ) : null}
      {onEdit ? (
        <DrawerButton
          label="Extend"
          accessibilityLabel={`Extend the expiry or raise the redemption limit for ${code}`}
          tone="primary"
          busy={false}
          onPress={() => onEdit(code)}
        />
      ) : null}
      {onDelete ? (
        <DrawerButton
          label={deleting ? "Deleting…" : "Delete code"}
          accessibilityLabel={
            deleting
              ? `Deleting ${code}`
              : discountDeleteActionLabel(code)
          }
          tone="danger"
          busy={deleting}
          onPress={() => onDelete(code, used)}
        />
      ) : null}
    </View>
  );
}

function DrawerButton({
  label,
  accessibilityLabel,
  busy,
  onPress,
  tone = "neutral",
}: {
  label: string;
  accessibilityLabel: string;
  busy: boolean;
  onPress: () => void;
  tone?: "neutral" | "primary" | "danger";
}) {
  const { t } = useTheme();
  // Colour is never the only carrier: each tone's label already states the
  // verb, so a monochrome or colour-blind reader loses nothing here.
  const border =
    tone === "primary" ? t.accent : tone === "danger" ? t.danger : t.border;
  // No danger FILL: the palette has no danger-subtle token, and the app's own
  // destructive treatment (ConfirmSheet's confirm button) is a danger border
  // and danger ink on the ordinary surface. Inventing a tinted background here
  // would make this the loudest control in the app.
  const fill = tone === "primary" ? t.accentSubtle : t.surface;
  const ink =
    tone === "primary" ? t.accent : tone === "danger" ? t.danger : t.fg;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: busy, busy }}
      disabled={busy}
      onPress={onPress}
      style={{
        minHeight: 44,
        justifyContent: "center",
        paddingHorizontal: 14,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: border,
        backgroundColor: fill,
        opacity: busy ? 0.6 : 1,
      }}
    >
      <Text
        {...typeCap("control")}
        numberOfLines={1}
        style={{
          color: ink,
          ...typeStyle("control"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
