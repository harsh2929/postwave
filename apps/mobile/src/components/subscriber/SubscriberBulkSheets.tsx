/**
 * The two pickers the bulk bar opens: "which tag?" and "which list?".
 *
 * Both are deliberately thin. The decision each one collects is a single
 * value, and the audience it will be applied to was already chosen on the
 * list behind the sheet — so each sheet states the audience size in its own
 * title rather than making the user remember it.
 *
 * The tag sheet offers the workspace's existing tags as tappable rows AND
 * accepts a new one, because bulk-tagging with a typo creates a second
 * near-identical tag across hundreds of rows and there is no bulk rename.
 */
import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";

import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { SearchField } from "@/components/SearchField";
import { SkeletonList } from "@/components/Skeleton";
import { ModalHeader, SubActionButton } from "@/components/subscriber/SubActionButton";
import { useDebounced } from "@/hooks/useDebounced";
import { useListOptions, type ListOption } from "@/hooks/useListOptions";
import { useTagCatalogue } from "@/hooks/useTagCatalogue";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { limitRunes, runeLength, TAG_NAME_MAX_RUNES } from "@/lib/tagInput";
import type { ThemeTokens } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";
import { keyboardDismiss } from "@/lib/keyboardChain";

function PickerRow({
  label,
  sublabel,
  onPress,
  t,
}: {
  label: string;
  sublabel?: string | undefined;
  onPress: () => void;
  t: ThemeTokens;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={sublabel ? `${label}, ${sublabel}` : label}
      // NativeWind v4: static style object only.
      style={{
        minHeight: 48,
        justifyContent: "center",
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: t.borderSubtle,
        backgroundColor: t.surface,
        marginBottom: 8,
      }}
    >
      <Text
        {...typeCap("body")}
        style={{
          color: t.fg,
          ...typeStyle("body"),
          fontFamily: FONT.regular,
        }}
        numberOfLines={1}
      >
        {label}
      </Text>
      {sublabel ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
          numberOfLines={1}
        >
          {sublabel}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function BulkTagSheet({
  visible,
  count,
  onClose,
  onSubmit,
  t,
}: {
  visible: boolean;
  /** Audience size, restated in the title so it is never ambiguous. */
  count: number;
  onClose: () => void;
  onSubmit: (tag: string) => void;
  t: ThemeTokens;
}) {
  const [draft, setDraft] = useState("");
  const debounced = useDebounced(draft, 250);
  const catalogue = useTagCatalogue({ query: debounced });

  useEffect(() => {
    if (visible) setDraft("");
  }, [visible]);

  const trimmed = draft.trim();
  const tooLong = runeLength(trimmed) > TAG_NAME_MAX_RUNES;
  const rows = Array.isArray(catalogue.data?.rows) ? catalogue.data?.rows : [];
  const exactExists = rows.some(
    (row) => row.name.trim().toLowerCase() === trimmed.toLowerCase(),
  );

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel="Choose a tag to apply"
    >
      <ModalHeader
        title={`Tag ${plural(count, "subscriber")}`}
        onClose={onClose}
        t={t}
      />
      <TextInput
        value={draft}
        onChangeText={(next) => setDraft(limitRunes(next))}
        placeholder="Find or create a tag…"
        placeholderTextColor={t.fgSubtle}
        accessibilityLabel="Tag name"
        autoCapitalize="none"
        autoCorrect={false}
        {...keyboardDismiss()}
        {...typeCap("body")}
        style={{
          color: t.fg,
          backgroundColor: t.surface,
          borderColor: t.border,
          borderWidth: 1,
          borderRadius: 12,
          paddingHorizontal: 12,
          paddingVertical: 12,
          minHeight: 44,
          fontFamily: FONT.regular,
          fontSize: fontSizeFor("body"),
        }}
      />
      {tooLong ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.danger,
            ...typeStyle("label"),
            marginTop: 6,
            fontFamily: FONT.regular,
          }}
        >
          {`Tags are at most ${TAG_NAME_MAX_RUNES} characters.`}
        </Text>
      ) : null}

      {trimmed && !tooLong && !exactExists ? (
        <View style={{ marginTop: 12 }}>
          <SubActionButton
            label={`Create and apply “${trimmed}”`}
            onPress={() => onSubmit(trimmed)}
            t={t}
          />
        </View>
      ) : null}

      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          marginTop: 16,
          marginBottom: 8,
          fontFamily: FONT.regular,
        }}
      >
        {catalogue.isLoading ? "Loading tags…" : "Existing tags"}
      </Text>
      {catalogue.isLoading ? (
        <SkeletonList rows={4} />
      ) : rows.length === 0 ? (
        <Text
          {...typeCap("body")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("body"),
            fontFamily: FONT.regular,
          }}
        >
          {trimmed
            ? "No tag matches. Use the button above to create it."
            : "No tags in this workspace yet."}
        </Text>
      ) : (
        rows.slice(0, 40).map((row) => (
          <PickerRow
            key={row.id || row.name}
            label={row.name}
            {...(row.description ? { sublabel: row.description } : {})}
            onPress={() => onSubmit(row.name)}
            t={t}
          />
        ))
      )}
    </KeyboardFormSheet>
  );
}

export function BulkListSheet({
  visible,
  count,
  onClose,
  onSubmit,
  t,
}: {
  visible: boolean;
  count: number;
  onClose: () => void;
  onSubmit: (list: ListOption) => void;
  t: ThemeTokens;
}) {
  const lists = useListOptions();
  const [q, setQ] = useState("");
  const debouncedQ = useDebounced(q, 200);

  useEffect(() => {
    if (visible) setQ("");
  }, [visible]);

  const rows = useMemo(() => {
    const all = Array.isArray(lists.data?.rows) ? lists.data?.rows : [];
    const needle = debouncedQ.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((row) => row.name.toLowerCase().includes(needle));
  }, [lists.data, debouncedQ]);

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel="Choose a list"
      contentContainerStyle={{ paddingBottom: 8 }}
    >
      <ModalHeader
        title={`Add ${plural(count, "subscriber")} to a list`}
        onClose={onClose}
        t={t}
      />
      <SearchField
        value={q}
        onChangeText={setQ}
        placeholder="Search lists…"
        accessibilityLabel="Search lists"
        {...(debouncedQ ? { resultCount: rows.length } : {})}
        resultNoun="matching list"
      />
      <View style={{ height: 12 }} />
      {lists.isLoading ? (
        <SkeletonList rows={5} />
      ) : rows.length === 0 ? (
        <Text
          {...typeCap("body")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("body"),
            fontFamily: FONT.regular,
          }}
        >
          {debouncedQ ? "No list matches that name." : "No lists in this workspace."}
        </Text>
      ) : (
        <FlatList
          {...MOBILE_LIST_PERF_PROPS}
          scrollEnabled={false}
          data={rows}
          keyExtractor={(row) => row.id}
          renderItem={({ item }) => (
            <PickerRow
              label={item.name}
              {...(item.count == null
                ? {}
                : { sublabel: plural(item.count, "subscriber") })}
              onPress={() => onSubmit(item)}
              t={t}
            />
          )}
        />
      )}
    </KeyboardFormSheet>
  );
}
