/**
 * IntegrationRecipeRows — one recipe row, and the blueprint it expands into.
 *
 * Split from IntegrationRecipesPanel so the container owns search/paging state
 * and this file owns rendering a recipe honestly.
 *
 * TWO THINGS EVERY ROW MUST SAY. The recipe's badge (the same tier vocabulary
 * the catalog uses) and whether the server marked it `available`. A recipe list
 * that showed only names would read as a menu of things you can switch on;
 * roughly half of them are planned wiring that exists so the coverage reports
 * can count it.
 *
 * THE BLUEPRINT is fetched per row (GET /integrations/recipes/{id}) because
 * that read is what resolves the source and target catalog entries. While it
 * is in flight the row shows the summary it already has rather than a spinner
 * that replaces content.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { Pill } from "@/components/Pill";
import {
  blueprintLines,
  recipeApplyNotice,
  type RecipeDetail,
  type RecipeRow,
} from "@/lib/integrationRecipes";
import { transitionLabel } from "@/lib/direction";
import { catalogStatusLabel, catalogTierLabel } from "@/lib/integrationsCatalog";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface RecipeListRowProps {
  row: RecipeRow;
  expanded: boolean;
  onToggle: (id: string) => void;
  /** The detail read for THIS row, when it is the open one. */
  detail: RecipeDetail | null;
  detailLoading: boolean;
  detailError: unknown;
  onRetryDetail: () => void;
}

export function RecipeListRow({
  row,
  expanded,
  onToggle,
  detail,
  detailLoading,
  detailError,
  onRetryDetail,
}: RecipeListRowProps) {
  const { t } = useTheme();
  const tier = catalogTierLabel(row.badge);
  return (
    <Pressable
      onPress={() => onToggle(row.id)}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={`${row.name}. ${tier}. ${row.available ? "Available" : "Planned"}.`}
      accessibilityHint={expanded ? "Hide the blueprint" : "Show the blueprint"}
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
          {row.name}
        </Text>
        <Pill label={tier} tone="neutral" />
        <Pill
          label={row.available ? "Available" : "Planned"}
          tone={row.available ? "success" : "neutral"}
          accessibilityLabel={
            row.available
              ? "Marked available by the server"
              : "Planned wiring, not runnable"
          }
        />
      </View>
      {row.summary ? <Caption>{row.summary}</Caption> : null}
      {expanded ? (
        <RecipeBlueprintBody
          row={row}
          detail={detail}
          loading={detailLoading}
          error={detailError}
          onRetry={onRetryDetail}
        />
      ) : null}
    </Pressable>
  );
}

function Caption({ children }: { children: React.ReactNode }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgMuted,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
      }}
    >
      {children}
    </Text>
  );
}

function RecipeBlueprintBody({
  row,
  detail,
  loading,
  error,
  onRetry,
}: {
  row: RecipeRow;
  detail: RecipeDetail | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const { t } = useTheme();
  if (error) {
    return (
      <View style={{ marginTop: 6 }}>
        <ErrorState error={error} onRetry={onRetry} />
      </View>
    );
  }
  // The list row already carries a blueprint; the detail read only adds the
  // resolved source/target entries. So render from whichever is in hand and
  // never blank the content while the extra read is in flight.
  const recipe = detail ? detail.recipe : row;
  const lines = blueprintLines(recipe);
  return (
    <View style={{ gap: 6, marginTop: 4 }}>
      {detail ? (
        <Caption>
          {detail.targetName
            ? transitionLabel(
                `${detail.sourceName || recipe.sourceSlug} (${catalogStatusLabel(detail.sourceStatus)})`,
                `${detail.targetName} (${catalogStatusLabel(detail.targetStatus)})`,
              )
            : `${detail.sourceName || recipe.sourceSlug} (${catalogStatusLabel(detail.sourceStatus)})`}
        </Caption>
      ) : loading ? (
        <Caption>Resolving the connected integrations…</Caption>
      ) : null}
      {lines.map((line) => (
        <Caption key={line.label}>{`${line.label}: ${line.value}`}</Caption>
      ))}
      {recipe.steps.length > 0 ? (
        <View style={{ gap: 2, marginTop: 2 }}>
          <Caption>Steps</Caption>
          {recipe.steps.map((step, index) => (
            <Caption key={`${step.title}:${index}`}>
              {`${index + 1}. ${step.title}${step.description ? ` — ${step.description}` : ""}`}
            </Caption>
          ))}
        </View>
      ) : null}
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          marginTop: 2,
        }}
      >
        {recipeApplyNotice(recipe)}
      </Text>
    </View>
  );
}
