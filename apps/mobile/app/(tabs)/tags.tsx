/**
 * Tags — the label catalogue.
 *
 * Mirrors desktop's /audience/tags. Used as a "what tags exist?" reference
 * when an operator is troubleshooting why a segment isn't matching the rows
 * they expected. One mutation lives here — CREATE (TagCreateSheet), for
 * editor+ roles, so a tag can carry its colour and description from birth
 * instead of being born as a side effect of bulk-applying it. Rename,
 * merge and delete stay desktop-only; tapping a tag drills into the people
 * who carry it.
 *
 * Four behaviours worth calling out:
 *
 *  - Search, group and archived filtering are SERVER-side
 *    (`GET /api/v1/tags?query=&group_id=&include_archived=`). The screen
 *    used to pull the whole taxonomy on every refresh and filter it in a
 *    useMemo. Sort stays client-side because the endpoint does not sort.
 *  - The online gate is handled. With a restored-but-unvalidated session
 *    the query never runs, so isLoading/isError are both false with zero
 *    rows — which the old empty state confidently reported as "No tags yet".
 *  - The scroller sets keyboardShouldPersistTaps, so the first tap after
 *    typing lands on the chip instead of being eaten dismissing the keyboard.
 *  - Pull-to-refresh binds to isRefetching, not isFetching, so the spinner
 *    does not fire on the initial cold load.
 */
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { CachedSessionNoticeContent } from "@/components/CachedSessionNotice";
import { Chip } from "@/components/Chip";
import { SearchField } from "@/components/SearchField";
import { SegmentedControl } from "@/components/SegmentedControl";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useToast } from "@/components/Toast";
import { TagCatalogueStates } from "@/components/tags/TagCatalogueStates";
import { TagChip } from "@/components/tags/TagChip";
import { TagCreateSheet } from "@/components/tags/TagCreateSheet";
import { TagGroupFilter } from "@/components/tags/TagGroupFilter";
import { useTagMaintenance } from "@/components/tags/TagMaintenanceLayer";
import { TAG_CHIP_ACTIONS } from "@/components/tags/tagRowActions";
import { AudienceNav } from "@/components/subscriber/AudienceNav";
import { useDebounced } from "@/hooks/useDebounced";
import { useListPreferences } from "@/hooks/useListPreferences";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { CachedNotice } from "@/components/deliverability/CachedNotice";
import { useTagCatalogue, useTagGroups } from "@/hooks/useTagCatalogue";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { audienceGateNotice } from "@/lib/audienceGateNotice";
import { FONT } from "@/lib/fonts";
import { date as fmtDate, plural, relativeTime } from "@/lib/format";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { goBackOrMore } from "@/lib/nav";
import {
  asTagSortMode,
  sortTags,
  type TagCatalogueRow,
} from "@/lib/tagCatalogue";
import { tagGroupName } from "@/lib/tagGroups";
import { useTheme, type ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

const TAGS_ROUTE = "/(tabs)/tags";

// Cap how many variable-width chips mount at once. The catalogue is a
// flex-wrap chip-cloud (chips size to their text), a layout FlatList's
// fixed-width column virtualization can't represent, so instead of
// converting to FlatList we bound the mounted node count with an
// incremental "show more".
const CHIP_PAGE_SIZE = 60;

/** The header's create affordance — editor-floor callers only render it. */
function NewTagButton({
  onPress,
  t,
}: {
  onPress: () => void;
  t: ThemeTokens;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Create a tag"
      hitSlop={8}
      style={{ minHeight: 44, justifyContent: "center" }}
    >
      <Text
        {...typeCap("callout")}
        style={{
          color: t.accent,
          ...typeStyle("callout"),
          fontFamily: FONT.semibold,
        }}
      >
        + New
      </Text>
    </Pressable>
  );
}

export default function Tags() {
  useScreenViewed("tags");
  const { t } = useTheme();
  const { toast } = useToast();
  const gate = useOnlineQueryGate();

  // A tap on a tag hit in Search arrives with the hit's title as `q`, so the
  // list opens already narrowed to the thing the user picked.
  const params = useLocalSearchParams<{ q?: string }>();
  const [q, setQ] = useState(typeof params.q === "string" ? params.q : "");
  const [showArchived, setShowArchived] = useState(false);
  // "" = every group. Group is the primary navigational axis on a large
  // taxonomy and the filter is applied SERVER-side by useTagCatalogue.
  const [groupId, setGroupId] = useState("");
  const [prefs, setPrefs] = useListPreferences("tags", { sort: "name" });
  const sort = asTagSortMode(prefs.sort);
  const debouncedQ = useDebounced(q, 250);
  const [visibleLimit, setVisibleLimit] = useState(CHIP_PAGE_SIZE);
  // Create-ahead-of-use (desktop's TagCreateModal). POST /api/v1/tags is
  // editor-floor in the routeauth manifest; below that the affordance is
  // OMITTED, not disabled — a viewer cannot use it, and an api_key session
  // counts as viewer here exactly as canAccessMinimumRole treats it.
  const mode = useAuthStore((s) => s.mode);
  const role = useAuthStore((s) => s.session?.effectiveRole ?? null);
  const canCreate = canAccessMinimumRole("editor", role, mode);
  const [createOpen, setCreateOpen] = useState(false);

  const tags = useTagCatalogue({
    query: debouncedQ,
    groupId,
    includeArchived: showArchived,
  });
  const groupsQuery = useTagGroups();
  // Same guard, same reason: `TagGroupFilter` reads `.length` and then maps,
  // and `{}.length` is undefined — so the "no groups, render nothing" early
  // return does not fire and the map below it throws.
  const groupRows = Array.isArray(groupsQuery.data) ? groupsQuery.data : [];
  const gateNotice: CachedSessionNoticeContent | null = audienceGateNotice({
    gateEnabled: gate.enabled,
    hasTenant: Boolean(gate.tenantId),
    noun: "tags",
  });

  // The API filters; only the ordering is ours. `data` carries snapshot
  // provenance alongside the rows (AUDIENCE#66), so the catalogue is readable
  // in airplane mode and says when it was captured.
  // Array.isArray, not `?? []`: a NULLISH guard passes a truthy `{}` or
  // `{items: []}` straight into sortTags, which SPREADS it — the same
  // "Invalid attempt to spread non-iterable instance" api-keys shipped. Two
  // routes lead here: a restored persisted query cache written by an older row
  // shape, and the offline vault, whose `isStored` guard checks only that the
  // record has a `value` key and a numeric `capturedAt`, never that `value` is
  // a list.
  const rows = useMemo(() => {
    const backing = tags.data?.rows;
    return sortTags(Array.isArray(backing) ? backing : [], sort);
  }, [tags.data, sort]);

  // Re-narrowing the catalogue collapses back to the first page so we never
  // carry a stale large slice across filters.
  useEffect(() => {
    setVisibleLimit(CHIP_PAGE_SIZE);
  }, [debouncedQ, sort, showArchived, groupId]);

  const visibleRows = useMemo(
    () => rows.slice(0, visibleLimit),
    [rows, visibleLimit],
  );
  const remaining = rows.length - visibleRows.length;
  const freshness = relativeTime(tags.dataUpdatedAt || undefined, {
    fallback: "",
  });

  // Row menu + maintenance sheets (edit / history / groups): one hook so
  // this function stays inside its budget. Delete has no sheet anywhere —
  // the server holds both delete routes behind an unconditional 409.
  const maintenance = useTagMaintenance({
    canEdit: canCreate,
    groups: groupRows,
    t,
  });
  const runTagAction = maintenance.runTagAction;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Tags"
        onBack={goBackOrMore}
        right={
          canCreate ? (
            <NewTagButton onPress={() => setCreateOpen(true)} t={t} />
          ) : undefined
        }
      />
      <View
        style={{
          paddingHorizontal: 16,
          paddingTop: 8,
          paddingBottom: 8,
          gap: 10,
        }}
      >
        <AudienceNav active={TAGS_ROUTE} />
        <SearchField
          value={q}
          onChangeText={setQ}
          placeholder="Search tags…"
          accessibilityLabel="Search tags"
          {...(debouncedQ ? { resultCount: rows.length } : {})}
          resultNoun="matching tag"
        />
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
              numberOfLines={1}
              accessibilityLabel={
                tags.isLoading ? "Loading tags" : plural(rows.length, "tag")
              }
            >
              {tags.isLoading ? "…" : plural(rows.length, "tag")}
            </Text>
            {freshness ? (
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("caption"),
                  fontFamily: FONT.regular,
                }}
                numberOfLines={1}
                accessibilityLabel={`Last updated ${freshness}`}
              >
                {`Updated ${freshness}`}
              </Text>
            ) : null}
          </View>
          <SegmentedControl
            accessibilityLabel="Sort order"
            options={[
              { value: "name", label: "A–Z" },
              { value: "newest", label: "Newest" },
            ]}
            value={sort}
            onChange={(next) => setPrefs({ sort: next })}
          />
        </View>
        <TagGroupFilter
          groups={groupRows}
          selectedId={groupId}
          onSelect={setGroupId}
        />
        <View style={{ flexDirection: "row", gap: 6 }}>
          <Chip
            label="Archived"
            active={showArchived}
            onPress={() => setShowArchived((on) => !on)}
            accessibilityLabel={
              showArchived ? "Hide archived tags" : "Include archived tags"
            }
          />
          {canCreate ? (
            <Chip
              label="Manage groups"
              active={false}
              onPress={maintenance.openGroups}
              accessibilityLabel="Manage the tag groups"
            />
          ) : null}
        </View>
      </View>
      <ScrollView
        // Drag-to-dismiss: this screen has a search field, so the keyboard covers
        // roughly half the viewport and nothing else here closes it.
        keyboardDismissMode="on-drag"
        // With the search keyboard open, the first tap on a chip must act.
        // Without this the scroller defaults to keyboardShouldPersistTaps
        // "never" and eats it dismissing the keyboard.
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          padding: 16,
          paddingTop: 4,
          paddingBottom: 32,
        }}
        refreshControl={
          <RefreshControl
            // isRefetching, not isFetching: the latter is true on the cold
            // mount too, so the pull spinner fired on first load.
            refreshing={tags.isRefetching && !tags.isLoading}
            onRefresh={() => void tags.refetch()}
            enabled={!gateNotice}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
      >
        {/* A cached catalogue must say so, and how old it is — the same
            component (and the same rule) the deliverability screens use. */}
        <CachedNotice backing={tags.data} />

        <TagCatalogueStates
          isLoading={tags.isLoading}
          isError={tags.isError}
          error={tags.error}
          rowCount={rows.length}
          query={debouncedQ}
          groupName={tagGroupName(groupRows, groupId)}
          showArchived={showArchived}
          gateNotice={gateNotice}
          onRetry={() => void tags.refetch()}
          onClearSearch={() => {
            setQ("");
            setGroupId("");
          }}
          onGoToSubscribers={() => router.push("/(tabs)/subscribers")}
        />

        {/* Wrapped flex so tags read like the chip-cloud they are on web. */}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {visibleRows.map((row, i) => (
            <TagChip
              // id/name come straight from the gateway; fall back to the
              // index so blank-id / duplicate-name rows never produce empty
              // or colliding React keys.
              key={row.id || row.name || `tag-${i}`}
              row={row}
              createdText={fmtDate(row.created_at, "")}
              onLongPress={maintenance.openMenu}
              actions={TAG_CHIP_ACTIONS}
              onAction={runTagAction}
            />
          ))}
        </View>

        {/* Reveal the next page of chips on demand so a large catalogue
            doesn't mount every chip up front. */}
        {remaining > 0 ? (
          <Pressable
            onPress={() => setVisibleLimit((n) => n + CHIP_PAGE_SIZE)}
            accessibilityRole="button"
            accessibilityLabel={`Show ${remaining} more tags`}
            style={{
              marginTop: 16,
              alignSelf: "center",
              backgroundColor: t.surface,
              borderColor: t.borderSubtle,
              borderWidth: 1,
              borderRadius: 999,
              paddingHorizontal: 16,
              paddingVertical: 10,
              minHeight: 44,
              justifyContent: "center",
            }}
          >
            <Text
              {...typeCap("callout")}
              style={{
                color: t.fg,
                ...typeStyle("callout"),
                fontWeight: "600",
                fontFamily: FONT.semibold,
              }}
            >
              {`Show ${remaining} more`}
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
      {/* Mounted only while open, so a closed sheet holds no suggestion
          query and the screen's hook surface stays what the render tests
          mock. The sheet owns the mutation; the screen owns the receipt. */}
      {createOpen ? (
        <TagCreateSheet
          visible
          groups={groupRows}
          onClose={() => setCreateOpen(false)}
          onCreated={(name) => {
            setCreateOpen(false);
            toast({ kind: "success", message: `Created “${name}”` });
          }}
          t={t}
        />
      ) : null}
      {/* The long-press menu + edit / history / group sheets. */}
      {maintenance.layer}
    </SafeAreaView>
  );
}
