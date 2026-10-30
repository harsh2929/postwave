/**
 * IntegrationsCatalogPanel — browse the integrations CATALOG from the phone.
 *
 * THE GAP. The integrations tab answered "are my integrations OK?" and nothing
 * else: it lists what IS connected. "What COULD I connect?" — the desktop's
 * catalog surface (apps/desktop/src/pages/integrations/
 * useIntegrationsCatalogController.ts:150) — had no mobile answer at all, so
 * the only way to check whether Moosewave speaks to a tool was to open a laptop.
 *
 * COLLAPSED BY DEFAULT, and the request is not issued until it is opened
 * (hooks/useIntegrationsCatalog). The payload is ~614 rows; the screen above
 * does not need it, and the screen's pull-to-refresh must not drag it down.
 *
 * WHY IT IS READ-ONLY. The screen's own header records the rule — "Writes stay
 * on the web admin" — and connecting an integration genuinely is desk work: it
 * needs an OAuth round trip or a credential pasted from the provider's console.
 * The catalog is reference material, and the honest action is the hand-off.
 *
 * BOUNDED RENDER. 614 rows inside the screen's FlatList header would mount 614
 * cells at once (a nested vertical VirtualizedList is not an option here), so
 * search and two filters narrow first and "Show more" pages the rest 25 at a
 * time.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { QueryStates } from "@/components/QueryStates";
import { SearchField } from "@/components/SearchField";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonList } from "@/components/Skeleton";
import {
  CatalogEntryRow,
  CatalogFilterChips,
} from "@/components/integrations/IntegrationsCatalogRows";
import { useIntegrationsCatalog } from "@/hooks/useIntegrationsCatalog";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import {
  CATALOG_PAGE_SIZE,
  catalogAvailabilityLine,
  catalogCategoryOptions,
  catalogResultSentence,
  catalogSearchTerm,
  catalogTierOptions,
  filterCatalogEntries,
  type IntegrationsCatalog,
} from "@/lib/integrationsCatalog";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const EMPTY_CATALOG: IntegrationsCatalog = {
  entries: [],
  categories: [],
  badges: [],
  counts: {},
};

export function IntegrationsCatalogPanel() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [tier, setTier] = useState("");
  const [limit, setLimit] = useState(CATALOG_PAGE_SIZE);
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const catalog = useIntegrationsCatalog(expanded);

  // GET /api/v1/integrations/catalog is admin in the manifest. Say so rather
  // than opening a browser that can only ever render a 403.
  const mayRead = canAccessMinimumRole("admin", gate.effectiveRole);

  const data = catalog.data ?? EMPTY_CATALOG;
  const entries = data.entries;
  const categories = useMemo(() => catalogCategoryOptions(data), [data]);
  const tiers = useMemo(() => catalogTierOptions(data), [data]);
  const matched = useMemo(
    () => filterCatalogEntries(entries, { search, category, tier }),
    [entries, search, category, tier],
  );
  const shown = useMemo(() => matched.slice(0, limit), [matched, limit]);
  const categoryLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of data.categories) map.set(entry.key, entry.label);
    return map;
  }, [data.categories]);

  const filtered = catalogSearchTerm(search) !== "" || category !== "" || tier !== "";
  const availability = catalogAvailabilityLine(data);

  const onSearch = useCallback((next: string) => {
    setSearch(next);
    setLimit(CATALOG_PAGE_SIZE);
  }, []);
  const onCategory = useCallback((next: string) => {
    setCategory(next);
    setLimit(CATALOG_PAGE_SIZE);
  }, []);
  const onTier = useCallback((next: string) => {
    setTier(next);
    setLimit(CATALOG_PAGE_SIZE);
  }, []);
  const clearFilters = useCallback(() => {
    setSearch("");
    setCategory("");
    setTier("");
    setLimit(CATALOG_PAGE_SIZE);
  }, []);
  const toggleRow = useCallback((slug: string) => {
    setOpenSlug((current) => (current === slug ? null : slug));
  }, []);
  const showMore = useCallback(
    () => setLimit((current) => current + CATALOG_PAGE_SIZE),
    [],
  );

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
        <SectionLabel topMargin={24}>Integration catalog</SectionLabel>
        <Text {...typeCap("caption")} style={captionStyle}>
          Browsing the catalog needs an owner or admin session. Your session can
          still see the connections above.
        </Text>
      </>
    );
  }

  return (
    <>
      <SectionLabel
        topMargin={24}
        subtitle="What Moosewave can speak to, with each entry's real tier and status. Presence here is not a promise that an entry can be connected."
        right={
          <Pressable
            onPress={() => setExpanded((open) => !open)}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            accessibilityLabel={
              expanded ? "Hide the integration catalog" : "Browse the integration catalog"
            }
            hitSlop={8}
            style={{ minHeight: 44, justifyContent: "center", paddingStart: 12 }}
          >
            <Text {...typeCap("callout")} style={linkStyle}>
              {expanded ? "Hide" : "Browse"}
            </Text>
          </Pressable>
        }
      >
        Integration catalog
      </SectionLabel>

      {expanded ? (
        <QueryStates
          query={catalog}
          gate={gate}
          isEmpty={entries.length === 0}
          offlineMessage="The catalog needs a connection. Reconnect and pull to refresh — this is not the same as there being nothing to connect."
          skeleton={
            <SkeletonList rows={4} lines={2} label="Loading the integration catalog" />
          }
          empty={{
            title: "The catalog came back empty",
            description:
              "The server returned no entries. That is a server-side result, not a statement about this workspace.",
          }}
        >
          <MobileScopeNotice
            title="Read-only on mobile"
            body="Connecting an integration needs an OAuth round trip or a credential from the provider's console, so it stays on the web admin. This browser answers what exists and at what tier."
          />
          {availability ? (
            <Text
              {...typeCap("caption")}
              style={{ ...captionStyle, marginTop: 8 }}
            >
              {availability}
            </Text>
          ) : null}
          <SearchField
            value={search}
            onChangeText={onSearch}
            placeholder="Name, category, tier, or capability"
            accessibilityLabel="Search the integration catalog"
            resultCount={matched.length}
            resultNoun="entry"
            resultNounPlural="entries"
          />
          <CatalogFilterChips
            label="Filter by category"
            allLabel="All categories"
            options={categories}
            active={category}
            onChange={onCategory}
          />
          <CatalogFilterChips
            label="Filter by tier"
            allLabel="All tiers"
            options={tiers}
            active={tier}
            onChange={onTier}
          />
          <Text
            {...typeCap("caption")}
            accessibilityLiveRegion="polite"
            style={{ ...captionStyle, marginBottom: 4 }}
          >
            {catalogResultSentence(entries.length, matched.length, filtered)}
          </Text>

          {matched.length === 0 ? (
            <View
              accessible
              accessibilityRole="summary"
              style={{ paddingVertical: 16, alignItems: "center", gap: 6 }}
            >
              <Text
                {...typeCap("body")}
                style={{
                  color: t.fg,
                  ...typeStyle("body"),
                  fontFamily: FONT.semibold,
                }}
              >
                No catalog entries match these filters
              </Text>
              <Pressable
                onPress={clearFilters}
                accessibilityRole="button"
                accessibilityLabel="Clear catalog filters"
                style={{
                  minHeight: 44,
                  justifyContent: "center",
                  paddingHorizontal: 12,
                }}
              >
                <Text {...typeCap("callout")} style={linkStyle}>
                  Clear filters
                </Text>
              </Pressable>
            </View>
          ) : (
            shown.map((entry) => (
              <CatalogEntryRow
                key={entry.slug}
                entry={entry}
                categoryLabel={categoryLabels.get(entry.category) ?? entry.category}
                expanded={openSlug === entry.slug}
                onToggle={toggleRow}
              />
            ))
          )}

          {matched.length > limit ? (
            <Pressable
              onPress={showMore}
              accessibilityRole="button"
              accessibilityLabel={`Show more catalog entries, ${plural(matched.length - limit, "more entry", "more entries")} available`}
              style={{
                minHeight: 44,
                alignItems: "center",
                justifyContent: "center",
                marginTop: 4,
              }}
            >
              <Text {...typeCap("callout")} style={linkStyle}>
                {`Show ${Math.min(CATALOG_PAGE_SIZE, matched.length - limit)} more`}
              </Text>
            </Pressable>
          ) : null}
        </QueryStates>
      ) : null}
    </>
  );
}
