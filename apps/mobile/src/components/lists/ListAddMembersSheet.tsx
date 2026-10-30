/**
 * ListAddMembersSheet — find people and put them on THIS list.
 *
 * Desktop's AddSubscribersModal (components/lists/tabs/MembersTab.tsx:425)
 * translated to a phone: search, tap to select, one batched
 * POST /api/v1/lists/{id}/subscribers, and the server's `{added, skipped}`
 * reported verbatim.
 *
 * Two things it does that the desktop picker does not:
 *
 *  - IT KNOWS WHO IS ALREADY ON THE LIST. The candidate search runs the same
 *    query against the list's own membership, and matches render as a disabled
 *    "On list" row sorted to the bottom (the person-side picker's idiom) rather
 *    than as a tappable row whose add would silently do nothing. Where that
 *    check cannot be made — either read failing — the whole search fails into
 *    its error state instead of showing half an answer.
 *  - IT REQUIRES A QUERY. The tenant's subscriber table is PII; a sheet that
 *    opens must not page through people nobody asked for, which is the same
 *    rule the members section itself follows.
 *
 * Rows the server sent without a uuid id are shown but not selectable: the
 * POST 400s the WHOLE batch on an id that is neither a uuid nor an integer, so
 * a row that cannot be added must not look addable.
 */
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ErrorState } from "@/components/ErrorState";
import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { SearchField } from "@/components/SearchField";
import { SkeletonList } from "@/components/Skeleton";
import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { ModalHeader } from "@/components/subscriber/SubActionButton";
import { useDebounced } from "@/hooks/useDebounced";
import { useAddListMembers, useListCandidates } from "@/hooks/useListMembership";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import {
  addMembersConfirmCopy,
  addableSelection,
  buildCandidateRows,
  candidateTrailingLabel,
  LIST_MEMBER_ADD_MAX,
  type AddMembersResult,
  type CandidateRow,
} from "@/lib/listMembershipRows";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { useTheme, type ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

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

export function ListAddMembersSheet({
  visible,
  listId,
  listName,
  onClose,
  onAdded,
}: {
  visible: boolean;
  listId: string;
  listName: string;
  onClose: () => void;
  /** Fired with the server's counts (null when it sent none). */
  onAdded: (result: AddMembersResult | null) => void;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const debouncedQ = useDebounced(q, 250);
  const search = useListCandidates(listId, debouncedQ, visible);
  const add = useAddListMembers(listId);

  useEffect(() => {
    if (visible) {
      setQ("");
      setSelected(new Set());
    }
  }, [visible]);

  const rows = useMemo(
    () =>
      buildCandidateRows(
        Array.isArray(search.data?.items) ? search.data.items : [],
        // Never a bare `??`: an absent membership check must degrade to "we
        // know of no members", not to whatever the cache happened to hold.
        search.data?.memberIds instanceof Set
          ? search.data.memberIds
          : new Set<string>(),
      ),
    [search.data],
  );
  const { ids, emails, capped } = useMemo(
    () => addableSelection(rows, selected),
    [rows, selected],
  );

  function toggle(row: CandidateRow) {
    if (row.state !== "addable" || row.id === null) return;
    const id = row.id;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function submit() {
    if (ids.length === 0 || add.isPending) return;
    // Adding people to a list changes who receives mail, so the last step
    // before the write names the list and — while it fits on a phone — the
    // people. Same discipline as the row's remove confirm.
    void (async () => {
      const copy = addMembersConfirmCopy(listName, emails);
      const ok = await confirm({
        title: copy.title,
        message: copy.message,
        confirmLabel: copy.confirmLabel,
        consequence: copy.consequence,
      });
      if (ok) send();
    })();
  }

  function send() {
    add.mutate(ids, {
      onSuccess: (result) => {
        setSelected(new Set());
        onAdded(result);
        onClose();
      },
      // Keep the sheet — and the selection — open so the operator can retry
      // without re-picking, exactly like the desktop modal.
      onError: (error) => {
        toast({
          kind: "error",
          message:
            errorPresentation(error).message ||
            "Couldn't add those subscribers.",
        });
      },
    });
  }

  const renderRow = ({ item }: { item: CandidateRow }) => {
    const picked = item.id !== null && selected.has(item.id);
    const actionable = item.state === "addable";
    const label = candidateTrailingLabel(item, picked);
    return (
      <Pressable
        onPress={() => toggle(item)}
        disabled={!actionable || add.isPending}
        accessibilityRole="button"
        accessibilityLabel={
          actionable
            ? `${picked ? "Deselect" : "Select"} ${item.email}`
            : item.state === "member"
              ? `${item.email} — already on this list`
              : `${item.email} — can't be added`
        }
        accessibilityState={{ disabled: !actionable, selected: picked }}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          backgroundColor: t.surface,
          borderColor: picked ? t.accent : t.borderSubtle,
          borderWidth: picked ? 2 : 1,
          borderRadius: 12,
          paddingHorizontal: 14,
          paddingVertical: 12,
          minHeight: 48,
          opacity: actionable ? 1 : 0.55,
        }}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontFamily: FONT.medium,
            }}
            numberOfLines={1}
          >
            {item.name || item.email}
          </Text>
          {item.name ? (
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
              numberOfLines={1}
            >
              {item.email}
            </Text>
          ) : null}
        </View>
        <Text
          {...typeCap("control")}
          style={{
            color: picked ? t.accent : t.fgMuted,
            ...typeStyle("control"),
            fontFamily: FONT.semibold,
          }}
        >
          {label}
        </Text>
      </Pressable>
    );
  };

  const renderEmpty = () => {
    if (!debouncedQ.trim()) {
      return (
        <Hint t={t}>
          Search by email or name to find people to add to “{listName}”.
        </Hint>
      );
    }
    if (search.isLoading) return <SkeletonList rows={5} />;
    if (search.isError) {
      return (
        <ErrorState
          error={search.error}
          onRetry={() => void search.refetch()}
        />
      );
    }
    return <Hint t={t}>No subscribers match “{debouncedQ.trim()}”.</Hint>;
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
        accessibilityLabel="Add members to this list"
      >
        <FlatList
          {...MOBILE_LIST_PERF_PROPS}
          data={rows}
          keyExtractor={(row, index) => row.id ?? `${row.email}-${index}`}
          renderItem={renderRow}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={{ padding: 20, paddingBottom: 24 }}
          ItemSeparatorComponent={RowSeparator}
          ListHeaderComponent={
            <View style={{ gap: 12, marginBottom: 12 }}>
              <ModalHeader title="Add members" onClose={onClose} t={t} />
              <SearchField
                value={q}
                onChangeText={setQ}
                placeholder="Search subscribers…"
                accessibilityLabel="Search subscribers to add"
                {...(debouncedQ.trim() && typeof search.data?.total === "number"
                  ? { resultCount: search.data.total }
                  : {})}
                resultNoun="matching subscriber"
              />
            </View>
          }
          ListEmptyComponent={renderEmpty}
        />
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: t.border,
            paddingHorizontal: 20,
            paddingVertical: 12,
            gap: 8,
          }}
        >
          {capped ? (
            <Hint t={t}>
              Only the first {LIST_MEMBER_ADD_MAX} selected will be sent — the
              server takes no more per request.
            </Hint>
          ) : null}
          <Pressable
            onPress={submit}
            disabled={ids.length === 0 || add.isPending}
            accessibilityRole="button"
            accessibilityLabel={
              ids.length === 0
                ? "Select subscribers to add"
                : `Add ${plural(ids.length, "subscriber")} to ${listName}`
            }
            accessibilityState={{ disabled: ids.length === 0 || add.isPending }}
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              minHeight: 48,
              borderRadius: 12,
              backgroundColor:
                ids.length === 0 || add.isPending ? t.surface : t.accent,
              borderColor: t.border,
              borderWidth: ids.length === 0 || add.isPending ? 1 : 0,
            }}
          >
            {add.isPending ? <ActivityIndicator color={t.fgMuted} /> : null}
            <Text
              {...typeCap("control")}
              style={{
                color:
                  ids.length === 0 || add.isPending ? t.fgMuted : t.accentFg,
                ...typeStyle("control"),
                fontFamily: FONT.semibold,
              }}
            >
              {add.isPending
                ? "Adding…"
                : ids.length === 0
                  ? "Select someone to add"
                  : `Add ${plural(ids.length, "subscriber")}`}
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </ReducedMotionModal>
  );
}

function Hint({ children, t }: { children: React.ReactNode; t: ThemeTokens }) {
  return (
    <Text
      {...typeCap("bodySmall")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("bodySmall"),
        fontFamily: FONT.regular,
      }}
    >
      {children}
    </Text>
  );
}
