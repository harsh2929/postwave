/**
 * IntegrationRecipesPanel — read the integration recipes and their blueprints.
 *
 * THE GAP. The desktop reads recipes and their blueprint detail
 * (useIntegrationRecipeController.ts:80) and mobile had no client at all, so
 * "how does Shopify actually reach Moosewave, and what scopes does it need"
 * was a desk-only question.
 *
 * READS ONLY. `POST /integrations/recipes/{id}/apply` exists and is admin, and
 * writes nothing — it echoes the recipe's blueprint with a hard-coded
 * `delegated` status (handlers.go:297). A button here would be a button that
 * does nothing, and configuring a recipe is the STARTING half under
 * lib/stoppingHalfPolicy. So the phone renders the blueprint the apply
 * response would have handed back, and says plainly where the wiring is
 * finished. lib/integrationRecipes carries the full reasoning.
 *
 * BOUNDED RENDER, like the catalog above it: search and an availability filter
 * narrow first, then 20 rows at a time.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { ChipRow } from "@/components/ChipRow";
import { QueryStates } from "@/components/QueryStates";
import { SearchField } from "@/components/SearchField";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonList } from "@/components/Skeleton";
import { RecipeListRow } from "@/components/integrations/IntegrationRecipeRows";
import {
  useIntegrationRecipeDetail,
  useIntegrationRecipes,
} from "@/hooks/useIntegrationRecipes";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import {
  RECIPE_PAGE_SIZE,
  filterRecipes,
  recipeAvailabilityLine,
  recipeResultSentence,
  recipeSearchTerm,
  type RecipeList,
} from "@/lib/integrationRecipes";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

type Availability = "" | "available" | "planned";

const AVAILABILITY_OPTIONS = [
  { value: "" as Availability, label: "All" },
  { value: "available" as Availability, label: "Available" },
  { value: "planned" as Availability, label: "Planned" },
];

const EMPTY_LIST: RecipeList = { items: [], summary: {} };

export function IntegrationRecipesPanel() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState("");
  const [availability, setAvailability] = useState<Availability>("");
  const [limit, setLimit] = useState(RECIPE_PAGE_SIZE);
  const [openId, setOpenId] = useState<string | null>(null);

  const mayRead = canAccessMinimumRole("admin", gate.effectiveRole);
  const recipes = useIntegrationRecipes(expanded && mayRead);
  const detail = useIntegrationRecipeDetail(expanded && mayRead ? openId : null);

  const data = recipes.data ?? EMPTY_LIST;
  const matched = useMemo(
    () => filterRecipes(data.items, { search, availability }),
    [data.items, search, availability],
  );
  const shown = useMemo(() => matched.slice(0, limit), [matched, limit]);
  const filtered = recipeSearchTerm(search) !== "" || availability !== "";

  const onSearch = useCallback((next: string) => {
    setSearch(next);
    setLimit(RECIPE_PAGE_SIZE);
  }, []);
  const onAvailability = useCallback((next: Availability) => {
    setAvailability(next);
    setLimit(RECIPE_PAGE_SIZE);
  }, []);
  const toggleRow = useCallback((id: string) => {
    setOpenId((current) => (current === id ? null : id));
  }, []);
  const showMore = useCallback(
    () => setLimit((current) => current + RECIPE_PAGE_SIZE),
    [],
  );
  const retryDetail = useCallback(() => {
    void detail.refetch();
  }, [detail]);

  const linkStyle = {
    color: t.accent,
    ...typeStyle("callout"),
    fontFamily: FONT.semibold,
  } as const;

  const captionStyle = {
    color: t.fgMuted,
    ...typeStyle("caption"),
    fontFamily: FONT.regular,
  } as const;

  if (!mayRead) {
    return (
      <>
        <SectionLabel topMargin={24}>Integration recipes</SectionLabel>
        <Text {...typeCap("caption")} style={captionStyle}>
          Recipes need an owner or admin session.
        </Text>
      </>
    );
  }

  const availabilityLine = recipeAvailabilityLine(data);

  return (
    <>
      <SectionLabel
        topMargin={24}
        subtitle="Named wirings between a provider and a Moosewave surface, with the scopes, events and field mappings each one needs. Read-only: applying one needs the provider's credentials."
        right={
          <Pressable
            onPress={() => setExpanded((current) => !current)}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            accessibilityLabel={
              expanded ? "Hide the integration recipes" : "Open the integration recipes"
            }
            hitSlop={8}
            style={{ minHeight: 44, justifyContent: "center", paddingStart: 12 }}
          >
            <Text {...typeCap("callout")} style={linkStyle}>
              {expanded ? "Hide" : "Open"}
            </Text>
          </Pressable>
        }
      >
        Integration recipes
      </SectionLabel>

      {expanded ? (
        <QueryStates
          query={recipes}
          gate={gate}
          isEmpty={data.items.length === 0}
          offlineMessage="Recipes need a connection. Reconnect and pull to refresh — an unread list is not an empty one."
          skeleton={
            <SkeletonList rows={4} lines={2} label="Loading the integration recipes" />
          }
          empty={{
            title: "No recipes came back",
            description:
              "The server returned no recipes. That is a server-side result, not a statement about this workspace.",
          }}
        >
          {availabilityLine ? (
            <Text {...typeCap("caption")} style={captionStyle}>
              {availabilityLine}
            </Text>
          ) : null}
          <SearchField
            value={search}
            onChangeText={onSearch}
            placeholder="Recipe, provider, event, or scope"
            accessibilityLabel="Search the integration recipes"
            resultCount={matched.length}
            resultNoun="recipe"
          />
          <ChipRow
            options={AVAILABILITY_OPTIONS}
            value={availability}
            onChange={onAvailability}
            accessibilityLabel="Filter recipes by availability"
            paddingHorizontal={0}
          />
          <Text
            {...typeCap("caption")}
            accessibilityLiveRegion="polite"
            style={{ ...captionStyle, marginTop: 4, marginBottom: 4 }}
          >
            {recipeResultSentence(data.items.length, matched.length, filtered)}
          </Text>

          {matched.length === 0 ? (
            <View
              accessible
              accessibilityRole="summary"
              style={{ paddingVertical: 16, alignItems: "center" }}
            >
              <Text
                {...typeCap("body")}
                style={{
                  color: t.fg,
                  ...typeStyle("body"),
                  fontFamily: FONT.semibold,
                }}
              >
                No recipes match these filters
              </Text>
            </View>
          ) : (
            shown.map((row) => (
              <RecipeListRow
                key={row.id}
                row={row}
                expanded={openId === row.id}
                onToggle={toggleRow}
                detail={openId === row.id ? (detail.data ?? null) : null}
                detailLoading={openId === row.id && detail.isLoading}
                detailError={openId === row.id ? detail.error : null}
                onRetryDetail={retryDetail}
              />
            ))
          )}

          {matched.length > limit ? (
            <Pressable
              onPress={showMore}
              accessibilityRole="button"
              accessibilityLabel={`Show more recipes, ${plural(matched.length - limit, "more recipe")} available`}
              style={{
                minHeight: 44,
                alignItems: "center",
                justifyContent: "center",
                marginTop: 4,
              }}
            >
              <Text {...typeCap("callout")} style={linkStyle}>
                {`Show ${Math.min(RECIPE_PAGE_SIZE, matched.length - limit)} more`}
              </Text>
            </Pressable>
          ) : null}
        </QueryStates>
      ) : null}
    </>
  );
}
