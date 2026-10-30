/**
 * AddToListModal — put a subscriber on a list.
 *
 * Three defects the audit found, fixed together because they are one
 * interaction:
 *
 *  1. The picker never knew which lists the person was ALREADY on. The
 *     server insert is idempotent (ON CONFLICT DO NOTHING), so tapping a
 *     list they were already on reported success and changed nothing.
 *     `useSubscriberLists` now feeds real membership state, and existing
 *     members render as disabled "On list" rows sorted to the bottom.
 *  2. The "Added ✓" receipt was single-valued (`addedListId`), so adding
 *     to a second list silently un-marked the first. It is a Set now.
 *  3. There was no search. A tenant with 150 lists gave you a 150-row
 *     scroll on a 6-row viewport, on the one screen where you know exactly
 *     which list you want.
 */
import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { SearchField } from "@/components/SearchField";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { useDebounced } from "@/hooks/useDebounced";
import { useListOptions, type ListOption } from "@/hooks/useListOptions";
import { useAddSubscriberToList } from "@/hooks/useSubscribers";
import { useSubscriberLists } from "@/hooks/useSubscriberLists";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { plural } from "@/lib/format";
import type { ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

import { ModalHeader, SubActionButton } from "./SubActionButton";

interface PickerRow extends ListOption {
  /** Already a member before this sheet opened, or added during it. */
  member: boolean;
  /** Added during THIS session — earns the "Added ✓" receipt. */
  justAdded: boolean;
}

/**
 * Filter by name, then sort members to the bottom (they are not actionable)
 * while preserving the catalogue order within each group. Pure so the
 * ordering rule is obvious and cheap to change.
 */
/**
 * A NAMED component, not an inline arrow. An arrow declared in the render body
 * is a NEW component TYPE on every parent render, and React cannot reconcile
 * two different types — so every separator between every visible row was
 * unmounted and rebuilt on each keystroke in the search field above. Measured
 * before the fix: 0 of the rendered separators survived a re-render; after, all
 * of them do. Same defect the sequences list was fixed for.
 */
function RowSeparator() {
  return <View style={{ height: 8 }} />;
}

export function buildPickerRows(
  lists: readonly ListOption[],
  memberIds: ReadonlySet<string>,
  addedIds: ReadonlySet<string>,
  needle: string,
): PickerRow[] {
  const q = needle.trim().toLowerCase();
  const rows = lists
    .filter((l) => !q || l.name.toLowerCase().includes(q))
    .map((l) => ({
      ...l,
      member: memberIds.has(l.id) || addedIds.has(l.id),
      justAdded: addedIds.has(l.id),
    }));
  return [...rows.filter((r) => !r.member), ...rows.filter((r) => r.member)];
}

export function AddToListModal({
  visible,
  onClose,
  subscriberId,
  email,
  t,
}: {
  visible: boolean;
  onClose: () => void;
  subscriberId: string;
  email: string;
  t: ThemeTokens;
}) {
  const lists = useListOptions();
  const memberships = useSubscriberLists(subscriberId);
  const addToList = useAddSubscriberToList();
  const { toast } = useToast();
  const [addedIds, setAddedIds] = useState<ReadonlySet<string>>(new Set());
  const [q, setQ] = useState("");
  const debouncedQ = useDebounced(q, 200);

  useEffect(() => {
    if (visible) {
      setAddedIds(new Set());
      setQ("");
    }
  }, [visible]);

  const memberIds = useMemo(
    () => new Set((Array.isArray(memberships.data) ? memberships.data : []).map((m) => m.id)),
    [memberships.data],
  );

  const rows = useMemo(
    () => buildPickerRows(lists.data?.rows ?? [], memberIds, addedIds, debouncedQ),
    [lists.data, memberIds, addedIds, debouncedQ],
  );

  function handleAdd(list: ListOption) {
    addToList.mutate(
      { id: subscriberId, listId: list.id },
      {
        onSuccess: () => {
          haptics.success();
          setAddedIds((prev) => new Set(prev).add(list.id));
        },
        onError: (err: unknown) => {
          haptics.error();
          toast({
            kind: "error",
            message: `Couldn't add to ${list.name}. ${err instanceof Error ? err.message : ""}`.trim(),
          });
        },
      },
    );
  }

  const renderRow = ({ item }: { item: PickerRow }) => {
    const trailing = item.justAdded
      ? "Added ✓"
      : item.member
        ? "On list"
        : "Add";
    return (
      <Pressable
        onPress={() => handleAdd(item)}
        disabled={addToList.isPending || item.member}
        accessibilityRole="button"
        accessibilityLabel={
          item.member
            ? `${item.name} — already on this list`
            : `Add ${email} to ${item.name}`
        }
        accessibilityState={{ disabled: item.member }}
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          backgroundColor: t.surface,
          borderColor: item.justAdded ? t.success : t.borderSubtle,
          borderWidth: 1,
          borderRadius: 12,
          paddingHorizontal: 14,
          paddingVertical: 12,
          minHeight: 48,
          opacity: item.member && !item.justAdded ? 0.55 : 1,
        }}
      >
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.medium,
            flex: 1,
          }}
          numberOfLines={2}
        >
          {item.name}
        </Text>
        {/* `control`: the trailing verb is pinned to the right of the row and
            must not push the list name out of it. */}
        <Text
          {...typeCap("control")}
          style={{
            color: item.justAdded ? t.success : t.fgMuted,
            ...typeStyle("control"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          {trailing}
        </Text>
      </Pressable>
    );
  };

  const renderEmpty = () => {
    if (lists.isLoading) return <SkeletonList rows={5} />;
    if (lists.isError) {
      return (
        <View>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.danger,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
            }}
          >
            Couldn&apos;t load lists.
          </Text>
          <View style={{ marginTop: 12, flexDirection: "row" }}>
            <SubActionButton
              label={lists.isFetching ? "Retrying…" : "Retry"}
              onPress={() => void lists.refetch()}
              disabled={lists.isFetching}
              busy={lists.isFetching}
              t={t}
            />
          </View>
        </View>
      );
    }
    return (
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {debouncedQ
          ? `No lists match "${debouncedQ}".`
          : "No lists in this workspace yet."}
      </Text>
    );
  };

  return (
    <ReducedMotionModal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
        accessibilityViewIsModal
        accessibilityLabel="Add subscriber to list"
      >
        <FlatList
          {...MOBILE_LIST_PERF_PROPS}
          data={rows}
          keyExtractor={(l) => l.id}
          renderItem={renderRow}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 20, paddingBottom: 32 }}
          ItemSeparatorComponent={RowSeparator}
          ListHeaderComponent={
            <View style={{ gap: 12, marginBottom: 12 }}>
              <ModalHeader title="Add to list" onClose={onClose} t={t} />
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.regular,
                }}
              >
                Pick a list to add {email} to.
                {memberIds.size > 0
                  ? ` Already on ${plural(memberIds.size, "list")}.`
                  : ""}
              </Text>
              <SearchField
                value={q}
                onChangeText={setQ}
                placeholder="Search lists…"
                accessibilityLabel="Search lists"
                {...(debouncedQ ? { resultCount: rows.length } : {})}
                resultNoun="matching list"
              />
            </View>
          }
          ListEmptyComponent={renderEmpty}
        />
      </SafeAreaView>
    </ReducedMotionModal>
  );
}
