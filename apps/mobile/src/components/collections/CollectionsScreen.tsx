/**
 * CollectionsScreen — "is the lookup table this workspace depends on actually
 * there, the right size, and recently updated?"
 *
 * WHY THIS EXISTS ON A PHONE. Reference collections are operator-maintained
 * lookup tables — coupon lists, content snippets, schedules — kept in
 * `reference_collections` and maintained by an overnight import or by an
 * integration writing through the API (`source_type` is uploaded / api /
 * manual, `types.go:40-44`). Desktop has 967 lines of Collections.tsx for
 * authoring them. The question that travels is much narrower and is the only
 * one this screen answers: the nightly job ran — did the table land, is it the
 * size it should be, and when did it last change.
 *
 * A MONITOR, NOT AN ADMIN CONSOLE. Three of the five mounted routes are
 * deliberately absent. `POST /api/v1/collections` takes an already-parsed rows
 * array, with the CSV/JSON parsing expected to have happened client-side
 * (`handlers.go:104-108`), so authoring on a phone means holding a file the
 * device does not have and validating it against `MaxRows = 50000`,
 * `MaxColumnsPerRow = 100` and a 1 MiB serialized ceiling (`types.go:110-133`).
 * `PATCH` carries the sharpest edge in the package — omitting `data` leaves the
 * rows alone, `[]` clears them, `null` is a 400 (`types.go:86-95`) — a rule to
 * exercise on a keyboard with the desktop's validator in view, never on a
 * train. `DELETE` destroys reference data with no undo path here.
 *
 * AUTHORIZATION IS SPLIT ACROSS THIS ONE SCREEN, which is why the route floor
 * and the panel floor differ. The catalogue is `read:subscribers`
 * (`handlers.go:47`), which is in `readOnlyScopes` (`apikeys/middleware.go:332-337`)
 * so every role including viewer can read it. One collection's ROWS are
 * `write:subscribers` (`handlers.go:48`) — a read gated by a write scope, on
 * purpose, because row bodies "can contain confidential lookup values"
 * (`handlers.go:36-39`) — which routes through `sessionRoleAllowsScopes` and
 * admits owner, admin and editor (`middleware.go:291-318`). So the route is
 * registered at `viewer`: taking the catalogue away from viewers to protect
 * rows they were never going to receive would remove the only part they can
 * legitimately see.
 *
 * NOTHING FROM THIS SCREEN IS WRITTEN TO THE DEVICE. The server sends
 * `Cache-Control: no-store` on every collection response
 * (`handlers.go:393-396`), and `shouldPersistQuery` is false for every query
 * (`lib/queryClient.ts:85-93`), so there is no offline snapshot here and the
 * offline state says so rather than showing yesterday's coupon codes.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { useCallback, useMemo, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/ScreenHeader";
import { SearchField } from "@/components/SearchField";
import { SegmentedControl } from "@/components/SegmentedControl";
import { CollectionCatalogSection } from "@/components/collections/CollectionCatalogSection";
import { useCollectionDetail, useCollectionsList } from "@/hooks/useCollections";
import { useDebounced } from "@/hooks/useDebounced";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useFirstPageRefresh } from "@/hooks/useFirstPageRefresh";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import type { CollectionListPage, CollectionSummary } from "@/lib/collections";
import {
  COLLECTION_TYPE_FILTERS,
  collectionTypeLabel,
  couponReferenceCaveat,
  sanitizeCollectionQuery,
  type CollectionTypeFilter,
} from "@/lib/collectionInventory";
import { num, plural } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

const TYPE_OPTIONS = COLLECTION_TYPE_FILTERS.map((value) => ({
  value,
  label: value === "all" ? "All" : collectionTypeLabel(value),
  accessibilityLabel:
    value === "all"
      ? "All collection types"
      : `${collectionTypeLabel(value)} collections only`,
}));

export function CollectionsScreen() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  // Off the store, not the gate: the store carries the auth MODE as well as the
  // role, and an api_key session must default-deny the editor-tier detail
  // because mobile never learns a key's scopes (mobileRouteManifest.ts:166-175).
  const role = useAuthStore((s) => s.session?.effectiveRole ?? null);
  const mode = useAuthStore((s) => s.mode);
  useScreenViewed("collections");

  const [type, setType] = useState<CollectionTypeFilter>("all");
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const detailAllowed = canAccessMinimumRole("editor", role, mode);
  // Debounced, because the filters are part of the QUERY KEY: without this,
  // every keystroke starts a new infinite query and a new request, and typing
  // "invoices" costs eight round trips on a cellular connection. The visible
  // input stays `query` so typing never lags; only the fetch waits.
  const debouncedQuery = useDebounced(query, 350);
  const list = useCollectionsList(type, debouncedQuery);
  const detail = useCollectionDetail(expandedId, detailAllowed);

  const items = useMemo<CollectionSummary[]>(() => {
    const pages = (list.data?.pages ?? []) as CollectionListPage[];
    return pages.flatMap((page) => page.items);
  }, [list.data]);

  // The total belongs to the FIRST page: every page re-reports the same
  // filter-wide COUNT (repo.go:113-119), and reading it off the last page would
  // silently change the denominator if rows were inserted mid-paging.
  const total = useMemo<number | null>(() => {
    const pages = (list.data?.pages ?? []) as CollectionListPage[];
    return pages[0]?.total ?? null;
  }, [list.data]);

  // Bounded to one page request (see useFirstPageRefresh); the type and search
  // filters are both in the query key.
  const refreshList = useFirstPageRefresh(
    ["collections", "list", gate.tenantId],
    list.refetch,
  );
  const refresh = useManualRefresh([refreshList, detail.refetch], {
    enabled: gate.enabled,
  });

  const onToggle = useCallback((id: string) => {
    setExpandedId((current) => (current === id ? null : id));
  }, []);

  // Changing a filter invalidates the keyset cursor server-side
  // (cursor.go:69-73). The query KEY carries the filters, so TanStack starts a
  // fresh infinite query rather than replaying a cursor the server would 400 —
  // but the open row must still close: it belongs to the previous result set.
  const onTypeChange = useCallback((next: CollectionTypeFilter) => {
    setType(next);
    setExpandedId(null);
  }, []);
  const onQueryChange = useCallback((next: string) => {
    setQuery(next);
    setExpandedId(null);
  }, []);

  const search = sanitizeCollectionQuery(query);
  const caveat = couponReferenceCaveat(items);
  // "50 collections" in the header, when the workspace has 312, is the same
  // lie the coverage note exists to prevent — and the header is the line a
  // reader glances at and quotes. So the denominator travels with it.
  const subtitle =
    items.length === 0
      ? undefined
      : total !== null && total > items.length
        ? `${num(items.length)} of ${plural(total, "collection")}`
        : plural(items.length, "collection");

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Collections"
        {...(subtitle ? { subtitle } : {})}
        onBack={goBackOrMore}
      />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            enabled={gate.enabled}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
      >
        <Note
          text="Reference collections are operator-maintained lookup tables. They are read by name elsewhere in the product; creating and importing them is a web-admin job."
          tone="muted"
        />

        <View style={{ marginTop: 12 }}>
          <SegmentedControl
            options={TYPE_OPTIONS}
            value={type}
            onChange={onTypeChange}
            accessibilityLabel="Collection type"
            scrollable
          />
        </View>

        <View style={{ marginTop: 12 }}>
          <SearchField
            value={query}
            onChangeText={onQueryChange}
            placeholder="Search by name"
            accessibilityLabel="Search collections by name"
            resultCount={search.submittable ? items.length : undefined}
            resultNoun="collection"
          />
        </View>

        {search.message ? <Note text={search.message} tone="warning" /> : null}
        {caveat ? <Note text={caveat} tone="muted" /> : null}

        <CollectionCatalogSection
          list={list}
          items={items}
          total={total}
          gate={gate}
          type={type}
          // The DEBOUNCED query, because this one decides whether an empty
          // result reads as "your filter matched nothing" or "this workspace
          // has none" — and it must describe the rows on screen, not the
          // keystroke that has not been fetched yet.
          query={debouncedQuery}
          expandedId={expandedId}
          onToggle={onToggle}
          detailAllowed={detailAllowed}
          detail={detail}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

function Note({ text, tone }: { text: string; tone: "muted" | "warning" }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: tone === "warning" ? t.warning : t.fgMuted,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
        marginTop: 10,
      }}
    >
      {text}
    </Text>
  );
}
