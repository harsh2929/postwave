/**
 * TemplateLibraryHeader — the catalog controls and the discovery shelf
 * (desktop parity: Templates.tsx:696-701 + TemplateDiscoveryHub), translated
 * to the phone: chips and rails that scroll WITH the list, not a hub page.
 *
 * WHAT LIVES HERE AND WHY IT OWNS ITS OWN READS. Stats, recents, saved
 * searches and collections are per-user/viewer-floor discovery state with no
 * bearing on the screen's verbs, so the screen passes only navigation
 * callbacks and this header talks to hooks/useTemplateDiscovery itself —
 * keeping the route component inside its function-span budget.
 *
 * EVERY SECTION EARNS ITS PIXELS BY EXISTING ONLY WHEN IT HAS CONTENT. A
 * workspace that never saved a search or curated a collection sees the shelf
 * rail and nothing else — an empty "Saved searches" label would be furniture.
 *
 * SAVED SEARCHES: APPLY OPENS THE RESULTS FEED, IT DOES NOT POKE LOCAL STATE.
 * The server re-runs the FULL stored definition (axes this phone has no
 * control for included), so copying q/goal into the local filters and
 * silently dropping the rest would misrepresent the search it claims to run.
 * Deleting one is a long-press behind a confirm; saving the CURRENT search is
 * offered only while something is actually narrowed, and its name is derived
 * from what the search is (savedSearchAutoName) because phones type names
 * badly.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import type { ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { ChipRow } from "@/components/ChipRow";
import { useConfirm } from "@/components/ConfirmSheet";
import { SegmentedControl } from "@/components/SegmentedControl";
import { useToast } from "@/components/Toast";
import {
  useCreateTemplateSavedSearch,
  useDeleteTemplateSavedSearch,
  useRecentTemplateViews,
  useTemplateCollections,
  useTemplateSavedSearches,
  useTemplateStats,
} from "@/hooks/useTemplateDiscovery";
import { FONT } from "@/lib/fonts";
import { num } from "@/lib/format";
import type { MobileTemplate } from "@/lib/templateCatalog";
import {
  savedSearchAutoName,
  shelfQuery,
  sortQueryValue,
  TEMPLATE_SHELF_LABELS,
  TEMPLATE_SHELVES,
  TEMPLATE_SORT_LABELS,
  TEMPLATE_SORTS,
  type TemplateCollection,
  type TemplateSavedSearch,
  type TemplateShelf,
  type TemplateSort,
  type TemplateStats,
} from "@/lib/templateDiscovery";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface TemplateLibraryHeaderProps {
  online: boolean;
  shelf: TemplateShelf;
  onShelfChange: (next: TemplateShelf) => void;
  sort: TemplateSort;
  onSortChange: (next: TemplateSort) => void;
  /** The active local search axes — what "save this search" would store. */
  query: string;
  goal: string | null;
  onOpenTemplate: (template: MobileTemplate) => void;
  onOpenSavedSearch: (search: TemplateSavedSearch) => void;
  onOpenCollection: (collection: TemplateCollection) => void;
}

/** One sentence, not four tiles: the same numbers in a phone's vertical budget. */
function statsLine(stats: TemplateStats): string {
  const parts = [
    `${num(stats.total)} designs`,
    `${num(stats.mine)} mine`,
    `${num(stats.favorites)} favourited`,
    `${num(stats.usedLast30d)} used in 30 days`,
  ];
  return parts.join(" · ");
}

function SectionLabel({ children }: { children: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("label")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("label"),
        fontFamily: FONT.semibold,
        paddingHorizontal: 16,
      }}
    >
      {children}
    </Text>
  );
}

/** Action chips (each press DOES something), unlike ChipRow's single-select. */
function ActionChip({
  label,
  onPress,
  onLongPress,
  accessibilityLabel,
  accessibilityHint,
  emphasis,
}: {
  label: string;
  onPress: () => void;
  onLongPress?: (() => void) | undefined;
  accessibilityLabel: string;
  accessibilityHint?: string | undefined;
  emphasis?: boolean | undefined;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      {...(onLongPress ? { onLongPress } : {})}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      {...(accessibilityHint ? { accessibilityHint } : {})}
      style={{
        minHeight: 36,
        borderRadius: 18,
        paddingHorizontal: 14,
        justifyContent: "center",
        borderWidth: 1,
        borderColor: emphasis ? t.accent : t.border,
        backgroundColor: t.surface,
      }}
    >
      <Text
        numberOfLines={1}
        {...typeCap("bodySmall")}
        style={{
          color: emphasis ? t.accent : t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
          maxWidth: 220,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function ChipScroller({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <View style={{ gap: 6 }}>
      <SectionLabel>{label}</SectionLabel>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}
      >
        {children}
      </ScrollView>
    </View>
  );
}

export function TemplateLibraryHeader(props: TemplateLibraryHeaderProps) {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();

  const stats = useTemplateStats();
  const recents = useRecentTemplateViews();
  const saved = useTemplateSavedSearches();
  const collections = useTemplateCollections();
  const createSaved = useCreateTemplateSavedSearch();
  const deleteSaved = useDeleteTemplateSavedSearch();

  const searchActive =
    props.query.trim() !== "" ||
    props.goal !== null ||
    props.shelf !== "all" ||
    props.sort !== "recommended";

  const saveCurrentSearch = () => {
    const axes = shelfQuery(props.shelf);
    const sort = sortQueryValue(props.sort);
    const name = savedSearchAutoName({
      query: props.query,
      goal: props.goal,
      shelf: props.shelf,
      sort: props.sort,
    });
    createSaved.mutate(
      {
        name,
        filters: {
          ...(props.query.trim() ? { q: props.query.trim() } : {}),
          ...(props.goal ? { goal: props.goal } : {}),
          ...(axes.source ? { source: axes.source } : {}),
          ...(axes.favorited ? { favorited: true } : {}),
          archived: axes.archived,
          ...(sort ? { sort } : {}),
        },
      },
      {
        onSuccess: () =>
          toast({ kind: "success", message: `Saved “${name}”.` }),
        onError: () =>
          toast({ kind: "error", message: "Couldn't save this search." }),
      },
    );
  };

  const removeSavedSearch = (search: TemplateSavedSearch) => {
    void (async () => {
      const ok = await confirm({
        title: `Delete “${search.name}”?`,
        message:
          "Removes this saved search from every device you use. The designs it finds are untouched.",
        confirmLabel: "Delete",
        cancelLabel: "Cancel",
      });
      if (!ok) return;
      deleteSaved.mutate(
        { id: search.id, etag: search.etag },
        {
          onError: () =>
            toast({
              kind: "error",
              message: "Couldn't delete that saved search.",
            }),
        },
      );
    })();
  };

  const recentRows = Array.isArray(recents.data) ? recents.data : [];
  const savedRows = Array.isArray(saved.data) ? saved.data : [];
  const collectionRows = Array.isArray(collections.data)
    ? collections.data
    : [];

  return (
    <View style={{ gap: 10, marginBottom: 8, marginHorizontal: -16 }}>
      {stats.data ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            paddingHorizontal: 16,
          }}
        >
          {statsLine(stats.data)}
        </Text>
      ) : null}

      <View style={{ paddingHorizontal: 16 }}>
        <SegmentedControl
          accessibilityLabel="Choose a shelf of the design library"
          scrollable
          options={TEMPLATE_SHELVES.map((shelf) => ({
            value: shelf,
            label: TEMPLATE_SHELF_LABELS[shelf],
          }))}
          value={props.shelf}
          onChange={props.onShelfChange}
        />
      </View>

      <ChipRow
        accessibilityLabel="Sort designs"
        options={TEMPLATE_SORTS.map((sort) => ({
          value: sort,
          label: TEMPLATE_SORT_LABELS[sort],
          accessibilityLabel: `Sort by ${TEMPLATE_SORT_LABELS[sort].toLowerCase()}`,
        }))}
        value={props.sort}
        onChange={props.onSortChange}
      />

      {recentRows.length > 0 ? (
        <ChipScroller label="Recently viewed">
          {recentRows.map((view) => (
            <ActionChip
              key={view.template.id}
              label={view.template.name}
              onPress={() => props.onOpenTemplate(view.template)}
              accessibilityLabel={`Open ${view.template.name}, viewed recently`}
            />
          ))}
        </ChipScroller>
      ) : null}

      {savedRows.length > 0 || (searchActive && props.online) ? (
        <ChipScroller label="Saved searches">
          {searchActive && props.online ? (
            <ActionChip
              label={
                createSaved.isPending ? "Saving…" : "＋ Save this search"
              }
              emphasis
              onPress={() => {
                if (!createSaved.isPending) saveCurrentSearch();
              }}
              accessibilityLabel="Save the current search"
              accessibilityHint="Stores the active query, goal, shelf and sort as a saved search, shared with desktop"
            />
          ) : null}
          {savedRows.map((search) => (
            <ActionChip
              key={search.id}
              label={search.name}
              onPress={() => props.onOpenSavedSearch(search)}
              onLongPress={() => removeSavedSearch(search)}
              accessibilityLabel={`Run the saved search ${search.name}`}
              accessibilityHint="Opens its results. Long-press to delete the saved search."
            />
          ))}
        </ChipScroller>
      ) : null}

      {collectionRows.length > 0 ? (
        <ChipScroller label="Collections">
          {collectionRows.map((collection) => (
            <ActionChip
              key={collection.id}
              label={`${collection.name} (${num(collection.itemCount)})`}
              onPress={() => props.onOpenCollection(collection)}
              accessibilityLabel={`Open the collection ${collection.name}, ${collection.itemCount} designs`}
            />
          ))}
        </ChipScroller>
      ) : null}
    </View>
  );
}
