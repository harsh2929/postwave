/**
 * DiscountEditSections — the two editable halves of the discount sheet.
 *
 * Split into their own module when DiscountEditSheet.tsx crossed its 450-line
 * file ceiling: extracting them as sibling components fixed the FUNCTION
 * budget but left every line in the same file, which only moved the problem.
 *
 * They are two components rather than one generic "field" because the
 * decisions differ in kind: an expiry is a choice between named intents
 * ("keep", "clear", "extend by N days"), while a cap is a number with a
 * destructive "remove the limit" escape hatch that must not be reachable by
 * simply blanking the input.
 */
import type { Dispatch, SetStateAction } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type { DiscountRow } from "@/hooks/useDiscountOps";
import {
  EXPIRY_EXTENSION_DAYS,
  type ExpiryIntent,
} from "@/lib/discountEdit";
import { dateTime, num } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import * as haptics from "@/lib/haptics";
import type { ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { keyboardDismiss } from "@/lib/keyboardChain";



/**
 * The two editable sections, split out of DiscountEditSheet's render so the
 * sheet itself stays under the function-size budget. They are siblings rather
 * than a generic "field" abstraction because the two decisions are genuinely
 * different: an expiry is a choice between named intents, while a cap is a
 * number with a destructive "remove it" escape hatch.
 */
export function ExpirySection({
  t,
  row,
  expiry,
  setExpiry,
  hasExpiry,
  previewISO,
}: {
  t: ThemeTokens;
  row: DiscountRow | null;
  expiry: ExpiryIntent;
  setExpiry: (next: ExpiryIntent) => void;
  hasExpiry: boolean;
  previewISO: string | null;
}) {
  return (
    <>
    {/* ------------------------------------------------------------------ */}
    <Text
      accessibilityRole="header"
      {...typeCap("label")}
      style={{
        color: t.fg,
        ...typeStyle("label"),
        marginTop: 22,
        fontWeight: "700",
        fontFamily: FONT.bold,
      }}
    >
      Expiry
    </Text>
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("caption"),
        marginTop: 4,
        fontFamily: FONT.regular,
        fontVariant: ["tabular-nums"],
      }}
    >
      {hasExpiry && row?.expires_at
        ? `Currently ${dateTime(row.expires_at)}`
        : "This code has no expiry, so there is nothing to extend."}
    </Text>
    {hasExpiry ? (
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          marginTop: 10,
        }}
      >
        {EXPIRY_EXTENSION_DAYS.map((days) => {
          const selected = expiry.kind === "extend" && expiry.days === days;
          return (
            <Pressable
              key={days}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={`Extend the expiry by ${days} days`}
              onPress={() => {
                haptics.tap();
                setExpiry(selected ? { kind: "keep" } : { kind: "extend", days });
              }}
              style={{
                minHeight: 44,
                justifyContent: "center",
                paddingHorizontal: 14,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: selected ? t.accent : t.border,
                backgroundColor: selected ? t.accentSubtle : t.surface,
              }}
            >
              <Text
                {...typeCap("control")}
                style={{
                  color: selected ? t.accent : t.fg,
                  ...typeStyle("control"),
                  fontWeight: "600",
                  fontFamily: FONT.semibold,
                }}
              >
                +{days} days
              </Text>
            </Pressable>
          );
        })}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: expiry.kind === "clear" }}
          accessibilityLabel="Remove the expiry so this code never expires"
          onPress={() => {
            haptics.tap();
            setExpiry(
              expiry.kind === "clear" ? { kind: "keep" } : { kind: "clear" },
            );
          }}
          style={{
            minHeight: 44,
            justifyContent: "center",
            paddingHorizontal: 14,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: expiry.kind === "clear" ? t.accent : t.border,
            backgroundColor:
              expiry.kind === "clear" ? t.accentSubtle : t.surface,
          }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: expiry.kind === "clear" ? t.accent : t.fg,
              ...typeStyle("control"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            Never expires
          </Text>
        </Pressable>
      </View>
    ) : null}
    {previewISO ? (
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          marginTop: 8,
          fontFamily: FONT.regular,
          fontVariant: ["tabular-nums"],
        }}
      >
        New expiry {dateTime(previewISO)}
      </Text>
    ) : null}

    </>
  );
}

export function CapSection({
  t,
  cap,
  used,
  capText,
  setCapText,
  capCleared,
  setCapCleared,
}: {
  t: ThemeTokens;
  cap: number | null;
  used: number;
  capText: string;
  setCapText: (next: string) => void;
  capCleared: boolean;
  setCapCleared: Dispatch<SetStateAction<boolean>>;
}) {
  return (
    <>
    {/* ------------------------------------------------------------------ */}
    <Text
      accessibilityRole="header"
      {...typeCap("label")}
      style={{
        color: t.fg,
        ...typeStyle("label"),
        marginTop: 22,
        fontWeight: "700",
        fontFamily: FONT.bold,
      }}
    >
      Redemption limit
    </Text>
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("caption"),
        marginTop: 4,
        fontFamily: FONT.regular,
        fontVariant: ["tabular-nums"],
      }}
    >
      {cap === null
        ? `No limit. Redeemed ${num(used)} times so far.`
        : `Currently ${num(cap)}, of which ${num(used)} used.`}
    </Text>
    {cap === null ? null : (
      <>
        <TextInput
          // Inputs scale with the OS text size but their height does not — cap it.
          {...typeCap("body")}
          value={capText}
          onChangeText={(next) => {
            setCapText(next.replace(/[^0-9]/g, ""));
            if (next !== "") setCapCleared(false);
          }}
          editable={!capCleared}
          keyboardType="number-pad"
          {...keyboardDismiss()}
          accessibilityLabel="New redemption limit"
          placeholder={`Higher than ${cap}`}
          placeholderTextColor={t.fgSubtle}
          style={{
            marginTop: 10,
            minHeight: 44,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: t.border,
            backgroundColor: capCleared ? t.bgSubtle : t.surface,
            color: capCleared ? t.fgSubtle : t.fg,
            paddingHorizontal: 12,
            fontFamily: FONT.regular,
            ...typeStyle("body"),
          }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: capCleared }}
          accessibilityLabel="Remove the redemption limit so this code can be used any number of times"
          onPress={() => {
            haptics.tap();
            setCapCleared((current) => {
              if (!current) setCapText("");
              return !current;
            });
          }}
          style={{
            marginTop: 10,
            alignSelf: "flex-start",
            minHeight: 44,
            justifyContent: "center",
            paddingHorizontal: 14,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: capCleared ? t.accent : t.border,
            backgroundColor: capCleared ? t.accentSubtle : t.surface,
          }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: capCleared ? t.accent : t.fg,
              ...typeStyle("control"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            No limit
          </Text>
        </Pressable>
      </>
    )}

    </>
  );
}
