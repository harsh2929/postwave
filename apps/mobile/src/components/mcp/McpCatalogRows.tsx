/**
 * McpCatalogRows — the category chips and the grouped tool rows of the
 * catalogue browser. Pure presentation; the section owns every state.
 *
 * COPY IS THE ONLY ACTION. A row offers "Copy" for its exact identifier —
 * the one thing a phone can usefully do with a tool name is carry it into a
 * chat or a config on another machine. The desktop's own caveat is kept:
 * copying "conveys no authorization or safety metadata". Nothing here
 * invokes a tool.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, ScrollView, Text, View } from "react-native";

import { useToast } from "@/components/Toast";
import { copyToClipboard } from "@/lib/clipboard";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import type { McpCatalogCategory, McpCatalogEntry } from "@/lib/mcpCatalog";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function McpCatalogCategoryChips({
  categories,
  active,
  onChange,
}: {
  categories: readonly McpCatalogCategory[];
  active: string;
  onChange: (category: string) => void;
}) {
  const { t } = useTheme();
  const chip = (
    value: string,
    label: string,
    accessibilityLabel: string,
  ) => {
    const selected = active === value;
    return (
      <Pressable
        key={value || "__all"}
        onPress={() => onChange(value)}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={accessibilityLabel}
        style={{
          minHeight: 36,
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderRadius: 18,
          borderWidth: 1,
          borderColor: selected ? t.accent : t.borderSubtle,
          backgroundColor: selected ? t.accentSubtle : t.surface,
          justifyContent: "center",
        }}
      >
        <Text
          {...typeCap("caption")}
          style={{
            color: selected ? t.accent : t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: selected ? FONT.semibold : FONT.medium,
          }}
        >
          {label}
        </Text>
      </Pressable>
    );
  };
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingVertical: 8 }}
      accessibilityLabel="Filter tools by category"
    >
      {chip("", "All", "All categories")}
      {categories.map((entry) =>
        chip(
          entry.category,
          `${entry.category} · ${entry.count}`,
          `${entry.category}, ${plural(entry.count, "tool")}`,
        ),
      )}
    </ScrollView>
  );
}

export function McpCatalogGroups({
  grouped,
}: {
  grouped: ReadonlyArray<readonly [string, readonly McpCatalogEntry[]]>;
}) {
  const { t } = useTheme();
  return (
    <View style={{ gap: 4 }}>
      {grouped.map(([category, tools]) => (
        <View key={category}>
          <Text
            {...typeCap("caption")}
            accessibilityRole="header"
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.semibold,
              letterSpacing: 0.6,
              textTransform: "uppercase",
              marginTop: 10,
              marginBottom: 4,
            }}
          >
            {category}
          </Text>
          {tools.map((tool) => (
            <McpCatalogRow key={tool.name} tool={tool} />
          ))}
        </View>
      ))}
    </View>
  );
}

function McpCatalogRow({ tool }: { tool: McpCatalogEntry }) {
  const { t } = useTheme();
  const { toast } = useToast();
  const copy = () => {
    haptics.tap();
    void copyToClipboard(tool.name).then((ok) => {
      if (ok) {
        haptics.success();
        toast({ kind: "success", message: "Tool identifier copied" });
      } else {
        haptics.error();
        toast({
          kind: "error",
          message: "The tool identifier could not be copied.",
        });
      }
    });
  };
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
        marginBottom: 6,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
      }}
    >
      <View
        accessible
        accessibilityLabel={`${tool.name}. ${tool.description}`}
        style={{ flex: 1 }}
      >
        <Text
          {...typeCap("bodySmall")}
          selectable
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.medium,
          }}
        >
          {tool.name}
        </Text>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            marginTop: 2,
          }}
        >
          {tool.description}
        </Text>
      </View>
      <Pressable
        onPress={copy}
        accessibilityRole="button"
        accessibilityLabel={`Copy tool identifier ${tool.name}`}
        accessibilityHint="Copies the exact identifier only; it conveys no authorization or safety metadata"
        hitSlop={8}
        style={{
          minHeight: 44,
          minWidth: 44,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: 8,
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: t.accent,
            ...typeStyle("callout"),
            fontFamily: FONT.semibold,
          }}
        >
          Copy
        </Text>
      </Pressable>
    </View>
  );
}
