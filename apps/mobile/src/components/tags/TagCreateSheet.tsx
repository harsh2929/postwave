/**
 * TagCreateSheet — create a tag AHEAD of use, from the tags screen.
 *
 * Desktop authors tags in TagCreateModal (TagFormModals.tsx): name with
 * taxonomy suggestions as a typo guard, palette colour, group, description.
 * Mobile only ever created one as a side effect of bulk-applying it
 * (SubscriberBulkSheets), which is how a taxonomy grows colourless,
 * descriptionless near-duplicates. This sheet is the first-class verb,
 * translated to the phone: the same fields, the same server vocabulary
 * (lib/tagCreateDraft mirrors the Go normalisers), one screenful.
 *
 * ONLINE-ONLY, stated in place: creation answers 409 on a registered
 * duplicate and the author must be present for that answer — see
 * api/tags.ts. Suggestions ride the same debounced taxonomy typeahead the
 * subscriber tag box uses; an EXACT match becomes the dedup sentence
 * (orphan registration included), near-misses become "Did you mean" chips.
 *
 * The mutation lives HERE, not on the tags screen: the screen renders this
 * sheet only while it is open, so a closed sheet holds no query and the
 * screen's own hook surface stays untouched.
 */
import { useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { Chip } from "@/components/Chip";
import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import {
  ModalHeader,
  SubActionButton,
} from "@/components/subscriber/SubActionButton";
import { useDebounced } from "@/hooks/useDebounced";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useTagCreate } from "@/hooks/useTagCreate";
import { useTagSuggestions } from "@/hooks/useTagSuggestions";
import { tagCreateFailureCopy } from "@/api/tags";
import { FONT } from "@/lib/fonts";
import { keyboardChain } from "@/lib/keyboardChain";
import { resolveTagColor } from "@/lib/tagCatalogue";
import {
  dedupHintCopy,
  EMPTY_TAG_DRAFT,
  TAG_DESCRIPTION_MAX_RUNES,
  TAG_PALETTE,
  tagCreateDedupHint,
  tagCreateNearMisses,
  validateTagDraft,
  type TagDraft,
} from "@/lib/tagCreateDraft";
import type { TagGroup } from "@/lib/tagGroups";
import { limitRunes } from "@/lib/tagInput";
import type { ThemeTokens } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

export function TagCreateSheet({
  visible,
  groups,
  onClose,
  onCreated,
  t,
}: {
  visible: boolean;
  /** The workspace's tag groups, already loaded by the tags screen. */
  groups: TagGroup[];
  onClose: () => void;
  /** Fired after the server confirms; the screen owns the receipt toast. */
  onCreated: (name: string) => void;
  t: ThemeTokens;
}) {
  const gate = useOnlineQueryGate();
  const [draft, setDraft] = useState<TagDraft>(EMPTY_TAG_DRAFT);
  const create = useTagCreate();
  // Name is not the last field, so its return key advances rather than
  // submitting; the colour and group choices in between are chips, not fields.
  const descriptionRef = useRef<TextInput>(null);

  const debouncedName = useDebounced(draft.name, 250);
  const suggestions = useTagSuggestions(debouncedName, { enabled: visible });
  const rows = Array.isArray(suggestions.data) ? suggestions.data : [];
  const dedup = tagCreateDedupHint(rows, draft.name);
  const nearMisses = dedup ? [] : tagCreateNearMisses(rows, draft.name);

  const validation = validateTagDraft(draft);
  const offline = !gate.enabled;

  const submit = () => {
    create.mutate(draft, {
      onSuccess: (created) => onCreated(created.name),
    });
  };

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel="Create a tag"
    >
      <ModalHeader title="New tag" onClose={onClose} t={t} />
      <View style={{ gap: 16 }}>
        <View style={{ gap: 6 }}>
          <FieldLabel t={t}>Name</FieldLabel>
          <TextInput
            value={draft.name}
            onChangeText={(name) =>
              setDraft((d) => ({ ...d, name: limitRunes(name) }))
            }
            placeholder="vip"
            placeholderTextColor={t.fgSubtle}
            accessibilityLabel="Tag name"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            {...typeCap("body")}
            {...keyboardChain({ next: descriptionRef })}
            style={{
              color: t.fg,
              backgroundColor: t.surface,
              borderColor: validation.nameHint ? t.danger : t.border,
              borderWidth: 1,
              borderRadius: 12,
              paddingHorizontal: 12,
              paddingVertical: 12,
              minHeight: 44,
              fontFamily: FONT.regular,
              fontSize: fontSizeFor("body"),
            }}
          />
          {validation.nameHint ? (
            <Hint tone="danger" t={t}>
              {validation.nameHint}
            </Hint>
          ) : dedup ? (
            <Hint tone="warning" t={t}>
              {dedupHintCopy(dedup)}
            </Hint>
          ) : nearMisses.length > 0 ? (
            <View style={{ gap: 6 }}>
              <Hint t={t}>Did you mean one of these existing tags?</Hint>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                {nearMisses.map((s) => (
                  <Chip
                    key={s.tag}
                    label={s.tag}
                    active={false}
                    onPress={() => setDraft((d) => ({ ...d, name: s.tag }))}
                    accessibilityLabel={`Use existing tag name ${s.tag}`}
                  />
                ))}
              </View>
            </View>
          ) : null}
        </View>

        <View style={{ gap: 6 }}>
          <FieldLabel t={t}>Colour</FieldLabel>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Chip
              label="None"
              active={draft.color === ""}
              onPress={() => setDraft((d) => ({ ...d, color: "" }))}
              accessibilityLabel="No colour"
            />
            {TAG_PALETTE.map((colour) => (
              <Swatch
                key={colour.id}
                id={colour.id}
                label={colour.label}
                selected={draft.color === colour.id}
                onPress={() => setDraft((d) => ({ ...d, color: colour.id }))}
                t={t}
              />
            ))}
          </View>
        </View>

        {groups.length > 0 ? (
          <View style={{ gap: 6 }}>
            <FieldLabel t={t}>Group</FieldLabel>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              <Chip
                label="No group"
                active={draft.groupId === ""}
                onPress={() => setDraft((d) => ({ ...d, groupId: "" }))}
                accessibilityLabel="No group"
              />
              {groups.map((group) => (
                <Chip
                  key={group.id}
                  label={group.name}
                  active={draft.groupId === group.id}
                  onPress={() => setDraft((d) => ({ ...d, groupId: group.id }))}
                  accessibilityLabel={`Group ${group.name}`}
                />
              ))}
            </View>
          </View>
        ) : null}

        <View style={{ gap: 6 }}>
          <FieldLabel t={t}>Description</FieldLabel>
          <TextInput
            ref={descriptionRef}
            value={draft.description}
            onChangeText={(description) =>
              setDraft((d) => ({
                ...d,
                description: limitRunes(description, TAG_DESCRIPTION_MAX_RUNES),
              }))
            }
            placeholder="What does this tag mean? Who should get it?"
            placeholderTextColor={t.fgSubtle}
            accessibilityLabel="Tag description"
            multiline
            {...typeCap("body")}
            style={{
              color: t.fg,
              backgroundColor: t.surface,
              borderColor: t.border,
              borderWidth: 1,
              borderRadius: 12,
              paddingHorizontal: 12,
              paddingVertical: 12,
              minHeight: 88,
              textAlignVertical: "top",
              fontFamily: FONT.regular,
              fontSize: fontSizeFor("body"),
            }}
          />
        </View>

        {create.isError ? (
          <Hint tone="danger" t={t}>
            {tagCreateFailureCopy(create.error)}
          </Hint>
        ) : null}

        <SubActionButton
          label="Create tag"
          onPress={submit}
          disabled={!validation.canSubmit || offline}
          busy={create.isPending}
          {...(offline
            ? {
                disabledReason:
                  "You're offline. Creating a tag needs a connection so a duplicate name can be refused while you're still here to rename it.",
              }
            : validation.canSubmit
              ? {}
              : { disabledReason: "Enter a tag name first." })}
          t={t}
        />
      </View>
    </KeyboardFormSheet>
  );
}

function FieldLabel({ children, t }: { children: string; t: ThemeTokens }) {
  return (
    <Text
      {...typeCap("label")}
      style={{
        color: t.fgMuted,
        ...typeStyle("label"),
        fontFamily: FONT.regular,
      }}
    >
      {children}
    </Text>
  );
}

function Hint({
  children,
  tone = "muted",
  t,
}: {
  children: string;
  tone?: "muted" | "warning" | "danger";
  t: ThemeTokens;
}) {
  const color =
    tone === "danger" ? t.danger : tone === "warning" ? t.warning : t.fgSubtle;
  return (
    <Text
      {...typeCap("label")}
      accessibilityRole="text"
      style={{ color, ...typeStyle("label"), fontFamily: FONT.regular }}
    >
      {children}
    </Text>
  );
}

/** One palette swatch: the colour dot plus its name, selectable. */
function Swatch({
  id,
  label,
  selected,
  onPress,
  t,
}: {
  id: string;
  label: string;
  selected: boolean;
  onPress: () => void;
  t: ThemeTokens;
}) {
  const dot = resolveTagColor(id) ?? t.fgSubtle;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Colour ${label}`}
      accessibilityState={{ selected }}
      // NativeWind v4: static style object only.
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        minHeight: 44,
        paddingHorizontal: 12,
        borderRadius: 999,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? t.accent : t.borderSubtle,
        backgroundColor: t.surface,
      }}
    >
      <View
        style={{
          width: 12,
          height: 12,
          borderRadius: 6,
          backgroundColor: dot,
        }}
      />
      <Text
        {...typeCap("callout")}
        style={{
          color: t.fg,
          ...typeStyle("callout"),
          fontFamily: selected ? FONT.semibold : FONT.regular,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
