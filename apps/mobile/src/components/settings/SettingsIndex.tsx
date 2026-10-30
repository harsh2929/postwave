/**
 * SettingsIndex — search + category jump for the Settings screen.
 *
 * Settings is a linear scroll of 20+ sections; the only way to find "App lock"
 * was to thumb past API connection, Appearance, Push and Privacy. Desktop has
 * had a searchable navigation index the whole time, and its command palette
 * indexes every settings anchor.
 *
 * Behaviour is deliberately restrained:
 *  - resting state is a single search field and four category chips — no
 *    permanent 22-row table of contents above the settings themselves;
 *  - results appear only once the user has typed or picked a category;
 *  - picking a result scrolls; it does not navigate, so the user keeps their
 *    place and can scroll on from where they landed.
 *
 * Every result also carries a "?" — the contextual-help affordance mobile did
 * not have. Desktop puts that copy in an `InlineHelp` tooltip, which a phone
 * cannot render; here it opens SettingsHelpSheet, keyed on the same anchor the
 * jump uses, so finding a setting and understanding what it costs are one
 * gesture apart. Copy lives in src/lib/settingsHelp.ts.
 *
 * Matching lives in src/lib/settingsIA.ts and is unit-tested there.
 */
import { useMemo, useState } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";

import { Chip } from "@/components/Chip";
import { SearchField } from "@/components/SearchField";
import { SettingsHelpSheet } from "@/components/settings/SettingsHelpSheet";
import { Card } from "@/components/settings/SettingsScreenPrimitives";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  SETTINGS_CATEGORIES,
  filterSettingsByCategory,
  searchSettings,
  type SettingsCategory,
} from "@/lib/settingsIA";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

export function SettingsIndex({
  onJump,
}: {
  /** Scrolls to the section with this anchor key. */
  onJump: (key: string) => void;
}) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<SettingsCategory | null>(null);
  const [helping, setHelping] = useState<{ key: string; label: string } | null>(
    null,
  );

  const results = useMemo(
    () => filterSettingsByCategory(searchSettings(query), category),
    [query, category],
  );
  const browsing = query.trim().length > 0 || category !== null;

  return (
    <Card>
      <SearchField
        value={query}
        onChangeText={setQuery}
        placeholder="Search settings"
        accessibilityLabel="Search settings"
        {...(browsing ? { resultCount: results.length } : {})}
        resultNoun="setting"
      />
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 6,
          marginTop: 10,
        }}
      >
        {SETTINGS_CATEGORIES.map((option) => (
          <Chip
            key={option}
            label={option}
            active={category === option}
            accessibilityLabel={`Show ${option} settings`}
            onPress={() => {
              haptics.tap();
              // Tapping the active chip clears it — a filter you cannot turn
              // off is a trap on a screen with no other exit.
              setCategory((current) => (current === option ? null : option));
            }}
          />
        ))}
      </View>

      {browsing ? (
        <View style={{ marginTop: 10, gap: 2 }}>
          {results.length === 0 ? (
            <Text
              {...typeCap("label")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
              }}
            >
              No settings match “{query.trim()}”. Some workspace controls are
              hidden for your role.
            </Text>
          ) : (
            results.map((anchor) => (
              <View
                key={anchor.key}
                style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
              >
                <Pressable
                  onPress={() => {
                    haptics.tap();
                    onJump(anchor.key);
                  }}
                  accessibilityRole="link"
                  accessibilityLabel={`${anchor.label}, in ${anchor.category}`}
                  accessibilityHint="Scrolls to this section."
                  style={{
                    minHeight: 44,
                    justifyContent: "center",
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    flex: 1,
                  }}
                >
                  <Text
                    {...typeCap("callout")}
                    style={{
                      color: t.fg,
                      ...typeStyle("callout"),
                      flex: 1,
                      fontFamily: FONT.regular,
                    }}
                    numberOfLines={maxLinesAtScale(1, fontScale)}
                  >
                    {anchor.label}
                  </Text>
                  <Text
                    // The category tag rides the same row as the result label,
                    // so it is dense: it must not push the label out.
                    {...typeCap("badgeSmall")}
                    style={{
                      color: t.fgSubtle,
                      ...typeStyle("badgeSmall"),
                      fontFamily: FONT.regular,
                    }}
                  >
                    {anchor.category}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    haptics.tap();
                    setHelping({ key: anchor.key, label: anchor.label });
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`What does ${anchor.label} do?`}
                  accessibilityHint="Explains what this section changes and who it affects"
                  hitSlop={6}
                  style={{
                    width: 44,
                    height: 44,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text
                    // Fixed-size glyph inside a fixed 44pt target; its meaning
                    // is on the a11y label, so it must not scale the button.
                    allowFontScaling={false}
                    style={{
                      color: t.accent,
                      fontSize: 16,
                      fontFamily: FONT.semibold,
                    }}
                  >
                    ?
                  </Text>
                </Pressable>
              </View>
            ))
          )}
        </View>
      ) : null}

      <SettingsHelpSheet
        anchorKey={helping?.key ?? null}
        title={helping?.label ?? ""}
        onClose={() => setHelping(null)}
        onJump={(key) => {
          setHelping(null);
          onJump(key);
        }}
      />
    </Card>
  );
}
