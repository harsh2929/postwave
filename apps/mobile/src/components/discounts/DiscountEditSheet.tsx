/**
 * DiscountEditSheet — extend a promotion from a phone.
 *
 * The Discounts screen was 100% read-only while exactly one discount mutation
 * is mounted: `PATCH /api/v1/discounts/{code}`, whose two edits (bump the
 * redemption cap, push the expiry out) are additive-only by server rule. That
 * is what makes them safe here — there is no destructive branch to fear, so
 * the sheet needs no typed-phrase gate, only a clear statement of what will
 * change.
 *
 * WHY PRESETS FOR THE EXPIRY AND A FIELD FOR THE CAP. "Extend by a week"
 * is how an operator standing at a conference stand thinks about a date, and
 * a date wheel on a page sheet costs four gestures to express it. A cap is
 * the opposite: the number is already decided ("raise it to 500"), and
 * offering +50/+100 presets would make the common case arithmetic.
 *
 * All the rules live in `lib/discountEdit` (import-free, unit-tested). This
 * file is the chrome: it never decides whether an edit is legal, it only
 * shows the reason the pure module gave.
 *
 * NativeWind v4 gotcha: static Pressable style objects only — a function-style
 * `style={({pressed}) => …}` silently drops layout on this stack.
 */
import {
  CapSection,
  ExpirySection,
} from "@/components/discounts/DiscountEditSections";
import { Pressable, Text, View } from "react-native";

import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { useToast } from "@/components/Toast";
import type { DiscountRow } from "@/hooks/useDiscountOps";
import { useDiscountEditDraft } from "@/hooks/useDiscountEditDraft";
import {
  currentCap,
  currentExpiry,
  extendedExpiryISO,
  timesRedeemed,
} from "@/lib/discountEdit";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface DiscountEditSheetProps {
  row: DiscountRow | null;
  onClose: () => void;
  returnFocusRef?: { current: unknown } | undefined;
}

export function DiscountEditSheet({
  row,
  onClose,
  returnFocusRef,
}: DiscountEditSheetProps) {
  const { t } = useTheme();
  const { toast } = useToast();
  // Cheap derivations from the row, kept at the call site because they are
  // read only by the JSX below — the draft hook owns intents, not display.
  const cap = row ? currentCap(row) : null;
  const used = row ? timesRedeemed(row) : 0;
  const hasExpiry = row ? currentExpiry(row) !== null : false;

  const {
    expiry,
    setExpiry,
    capText,
    setCapText,
    capCleared,
    setCapCleared,
    result,
    saving,
    close,
    onSave,
  } = useDiscountEditDraft({ row, onClose, toast });

  const previewISO =
    row && expiry.kind === "extend"
      ? extendedExpiryISO(row, expiry.days, Date.now())
      : null;

  return (
    <KeyboardFormSheet
      visible={row !== null}
      onClose={close}
      accessibilityLabel={row ? `Edit limits for ${row.code}` : "Edit limits"}
      {...(returnFocusRef ? { returnFocusRef } : {})}
    >
      <Text
        accessibilityRole="header"
        {...typeCap("title")}
        style={{
          color: t.fg,
          ...typeStyle("title"),
          fontWeight: "700",
          fontFamily: FONT.bold,
        }}
      >
        Extend {row?.code ?? "code"}
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          marginTop: 6,
          fontFamily: FONT.regular,
        }}
      >
        Only additive changes are available here. Ending a promotion early —
        lowering the limit, pulling the expiry forward — stays on the web admin.
      </Text>

      <ExpirySection
        t={t}
        row={row}
        expiry={expiry}
        setExpiry={setExpiry}
        hasExpiry={hasExpiry}
        previewISO={previewISO}
      />
      <CapSection
        t={t}
        cap={cap}
        used={used}
        capText={capText}
        setCapText={setCapText}
        capCleared={capCleared}
        setCapCleared={setCapCleared}
      />
      {/* ------------------------------------------------------------------ */}
      {result && !result.ok ? (
        <Text
          accessibilityLiveRegion="polite"
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            marginTop: 22,
            fontFamily: FONT.regular,
          }}
        >
          {result.reason}
        </Text>
      ) : null}

      <View style={{ flexDirection: "row", gap: 10, marginTop: 22 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel and close"
          onPress={close}
          style={{
            flex: 1,
            minHeight: 48,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 12,
            borderWidth: 1,
            borderColor: t.border,
            backgroundColor: t.surface,
          }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: t.fg,
              ...typeStyle("control"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            Cancel
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{
            disabled: !result?.ok || saving,
          }}
          accessibilityLabel={
            result?.ok ? result.summary : "Nothing to save yet"
          }
          disabled={!result?.ok || saving}
          onPress={onSave}
          style={{
            flex: 1,
            minHeight: 48,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 12,
            backgroundColor: result?.ok ? t.accent : t.bgSubtle,
            opacity: saving ? 0.6 : 1,
          }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: result?.ok ? t.accentFg : t.fgSubtle,
              ...typeStyle("control"),
              fontWeight: "700",
              fontFamily: FONT.bold,
            }}
          >
            {saving ? "Saving…" : "Save"}
          </Text>
        </Pressable>
      </View>
    </KeyboardFormSheet>
  );
}
