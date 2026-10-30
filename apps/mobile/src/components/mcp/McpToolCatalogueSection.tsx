/**
 * McpToolCatalogueSection — browse the server-bundled MCP tool catalogue.
 *
 * COLLAPSED BY DEFAULT. The monitor above answers "what did agents just do";
 * this section answers "what MAY they call" — a 289-row document the desktop
 * keeps on its own tab. On a phone it lives under the log, folded, and the
 * request is not issued until the operator opens it (hooks/useMcpCatalog).
 *
 * WHAT THE LIST IS. `GetCatalog` (apps/api/internal/apikeycalls/handlers.go:
 * 37-44, 206-225) serves a JSON file embedded at build time and labels it a
 * CANDIDATE snapshot: "no equality is guaranteed with an installed
 * @postwave/mcp-server registry artifact, a running proxy, or the
 * independent native Go registry". The section says so in the desktop's
 * words, once, above the search field, and never presents a row as
 * "available".
 *
 * Search and category filter are the desktop's rules (lib/mcpCatalog):
 * case-insensitive substring over name, description and category, bounded
 * at 256 characters, intersected with one category. "Show more" pages the
 * matches 40 at a time so the ScrollView above never swallows 289 rows at
 * once.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import {
  McpCatalogCategoryChips,
  McpCatalogGroups,
} from "@/components/mcp/McpCatalogRows";
import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { QueryStates } from "@/components/QueryStates";
import { SearchField } from "@/components/SearchField";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonList } from "@/components/Skeleton";
import { useMcpCatalog } from "@/hooks/useMcpCatalog";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import {
  filterMcpCatalog,
  groupMcpCatalog,
  MCP_CATALOG_PAGE_SIZE,
  mcpCatalogCategories,
  mcpCatalogResultSentence,
  mcpCatalogSearchTerm,
} from "@/lib/mcpCatalog";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface McpToolCatalogueSectionProps {
  allowed: boolean;
  gate: { enabled: boolean };
}

export function McpToolCatalogueSection({
  allowed,
  gate,
}: McpToolCatalogueSectionProps) {
  const { t } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [limit, setLimit] = useState(MCP_CATALOG_PAGE_SIZE);
  const catalog = useMcpCatalog(allowed, expanded);

  const entries = useMemo(
    () => (Array.isArray(catalog.data) ? catalog.data : []),
    [catalog.data],
  );
  const categories = useMemo(() => mcpCatalogCategories(entries), [entries]);
  const matched = useMemo(
    () => filterMcpCatalog(entries, search, category),
    [entries, search, category],
  );
  const grouped = useMemo(() => groupMcpCatalog(matched, limit), [matched, limit]);
  const filtered = mcpCatalogSearchTerm(search) !== "" || category !== "";

  const onSearch = useCallback((next: string) => {
    setSearch(next);
    setLimit(MCP_CATALOG_PAGE_SIZE);
  }, []);
  const onCategory = useCallback((next: string) => {
    setCategory(next);
    setLimit(MCP_CATALOG_PAGE_SIZE);
  }, []);
  const clearFilters = useCallback(() => {
    setSearch("");
    setCategory("");
    setLimit(MCP_CATALOG_PAGE_SIZE);
  }, []);
  const toggle = useCallback(() => setExpanded((open) => !open), []);
  const showMore = useCallback(
    () => setLimit((current) => current + MCP_CATALOG_PAGE_SIZE),
    [],
  );

  const linkStyle = {
    color: t.accent,
    ...typeStyle("callout"),
    fontFamily: FONT.semibold,
  } as const;

  return (
    <>
      <SectionLabel
        subtitle="Server-bundled candidate list. Presence here is build evidence, not proof that an installed client can discover or execute a tool."
        right={
          <Pressable
            onPress={toggle}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            accessibilityLabel={
              expanded ? "Hide the tool catalogue" : "Browse the tool catalogue"
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
        Tool catalogue
      </SectionLabel>

      {expanded ? (
        <QueryStates
          query={catalog}
          gate={gate}
          isEmpty={entries.length === 0}
          offlineMessage="The tool catalogue needs a connection. Reconnect and pull to refresh."
          skeleton={
            <SkeletonList rows={3} lines={2} label="Loading the tool catalogue" />
          }
          empty={{
            title: "Validated candidate catalogue is empty",
            description:
              "The server returned no candidate identifiers. Artifact parity and transport governance still require independent qualification.",
          }}
        >
          <MobileScopeNotice
            title="Installed-client parity is not qualified"
            body="The public npm artifact and this server-bundled candidate response can differ. Treat these rows as build evidence, not as a promise that an installed client can discover or execute each identifier."
          />
          <SearchField
            value={search}
            onChangeText={onSearch}
            placeholder="Name, category, or description"
            accessibilityLabel="Search the tool catalogue"
            resultCount={matched.length}
            resultNoun="tool"
          />
          <McpCatalogCategoryChips
            categories={categories}
            active={category}
            onChange={onCategory}
          />
          <Text
            {...typeCap("caption")}
            accessibilityLiveRegion="polite"
            style={{
              color: t.fgMuted,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              marginBottom: 4,
            }}
          >
            {mcpCatalogResultSentence(
              entries.length,
              matched.length,
              categories.length,
              filtered,
            )}
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
                No tools match these filters
              </Text>
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.regular,
                  textAlign: "center",
                }}
              >
                Try a shorter identifier or remove the selected category.
              </Text>
              <Pressable
                onPress={clearFilters}
                accessibilityRole="button"
                accessibilityLabel="Clear catalogue filters"
                style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 12 }}
              >
                <Text {...typeCap("callout")} style={linkStyle}>
                  Clear filters
                </Text>
              </Pressable>
            </View>
          ) : (
            <McpCatalogGroups grouped={grouped} />
          )}

          {matched.length > limit ? (
            <Pressable
              onPress={showMore}
              accessibilityRole="button"
              accessibilityLabel={`Show more tools, ${plural(matched.length - limit, "more tool")} available`}
              style={{
                minHeight: 44,
                alignItems: "center",
                justifyContent: "center",
                marginTop: 4,
              }}
            >
              <Text {...typeCap("callout")} style={linkStyle}>
                {`Show more (${matched.length - limit} more)`}
              </Text>
            </Pressable>
          ) : null}
        </QueryStates>
      ) : null}
    </>
  );
}
