/**
 * IntegrationsCatalogRows — the filter chips and the entry rows for the
 * catalog browser.
 *
 * Split out of IntegrationsCatalogPanel so the container stays about state
 * (search / filters / paging / query states) and this file stays about
 * rendering one entry honestly.
 *
 * THE ROW'S CONTRACT. Every row shows BOTH of the server's axes — the tier
 * (`badge`) and the runtime status — because either alone misleads. "Native"
 * with no status reads as connectable; "Planned" with no tier hides that the
 * entry is native work rather than a bridge. The status pill is the one that
 * carries tone, and only `available` is green.
 *
 * NativeWind v4 gotcha: static Pressable style objects only — a function-style
 * `style={({pressed}) => ...}` silently drops layout on this stack.
 */
import { Pressable, ScrollView, Text, View } from "react-native";

import { Chip } from "@/components/Chip";
import { Pill } from "@/components/Pill";
import {
  catalogEntryConnectable,
  catalogStatusLabel,
  catalogStatusTone,
  catalogTierLabel,
  type CatalogEntry,
  type CatalogFilterOption,
} from "@/lib/integrationsCatalog";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface CatalogFilterChipsProps {
  label: string;
  allLabel: string;
  options: readonly CatalogFilterOption[];
  active: string;
  onChange: (next: string) => void;
}

export function CatalogFilterChips({
  label,
  allLabel,
  options,
  active,
  onChange,
}: CatalogFilterChipsProps) {
  if (options.length === 0) return null;
  return (
    <View accessibilityRole="tablist" accessibilityLabel={label}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          flexDirection: "row",
          gap: 6,
          paddingVertical: 6,
          alignItems: "center",
        }}
      >
        <Chip
          label={allLabel}
          active={active === ""}
          onPress={() => onChange("")}
          accessibilityLabel={`${label}: ${allLabel}`}
        />
        {options.map((option) => (
          <Chip
            key={option.value}
            label={`${option.label} ${option.count}`}
            active={active === option.value}
            onPress={() => onChange(active === option.value ? "" : option.value)}
            accessibilityLabel={`${label}: ${option.label}, ${option.count} entries`}
          />
        ))}
      </ScrollView>
    </View>
  );
}

export interface CatalogEntryRowProps {
  entry: CatalogEntry;
  categoryLabel: string;
  expanded: boolean;
  onToggle: (slug: string) => void;
}

export function CatalogEntryRow({
  entry,
  categoryLabel,
  expanded,
  onToggle,
}: CatalogEntryRowProps) {
  const { t } = useTheme();
  const connectable = catalogEntryConnectable(entry);
  const statusLabel = catalogStatusLabel(entry.runtimeStatus);
  const tierLabel = catalogTierLabel(entry.badge);
  return (
    <Pressable
      onPress={() => onToggle(entry.slug)}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={`${entry.name}. ${categoryLabel}. Tier ${tierLabel}, status ${statusLabel}.`}
      accessibilityHint={
        expanded ? "Hide the details" : "Show what this entry covers"
      }
      style={{
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        paddingVertical: 10,
        gap: 6,
        minHeight: 44,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.semibold,
            flexShrink: 1,
          }}
          numberOfLines={1}
        >
          {entry.name}
        </Text>
        <Pill label={tierLabel} tone="neutral" />
        <Pill
          label={statusLabel}
          tone={catalogStatusTone(entry.runtimeStatus)}
          accessibilityLabel={
            connectable
              ? `Runtime status available: this entry can be connected`
              : `Runtime status ${statusLabel}: this entry is listed for coverage, not connectable today`
          }
        />
      </View>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {categoryLabel}
      </Text>
      {expanded ? <CatalogEntryDetail entry={entry} /> : null}
    </Pressable>
  );
}

function CatalogEntryDetail({ entry }: { entry: CatalogEntry }) {
  const { t } = useTheme();
  const connectable = catalogEntryConnectable(entry);
  return (
    <View style={{ gap: 6, marginTop: 2 }}>
      {entry.summary ? (
        // The server writes this sentence — including the release-hold
        // sentences decorateCatalogItem substitutes for held families. Render
        // it verbatim; paraphrasing a hold into "coming soon" is exactly the
        // claim the hold exists to prevent.
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {entry.summary}
        </Text>
      ) : null}
      {entry.capabilities.length > 0 ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {`Covers: ${entry.capabilities.join(", ")}`}
        </Text>
      ) : null}
      <Text
        {...typeCap("caption")}
        style={{
          color: connectable ? t.success : t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {connectable
          ? "Connect it from the web admin — connecting an integration needs the provider's console and stays there."
          : "Not connectable today. It is in the catalog so coverage can be counted honestly, not because it is ready."}
      </Text>
    </View>
  );
}
