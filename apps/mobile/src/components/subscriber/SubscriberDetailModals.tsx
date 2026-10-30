/**
 * Subscriber detail action button + the edit-tags sheet.
 *
 * (AddToListModal lives in ./AddToListModal.tsx and is re-exported here so
 * existing call sites keep one import.)
 *
 * The new-tag box is a TYPEAHEAD over the workspace taxonomy, not plain
 * free text. `tags` is a free-text field on a device where typos are
 * routine, and a typo silently forks the taxonomy ("newsletter" vs
 * "newsleter") with no merge UI anywhere on mobile to undo it. The chips
 * under the input come from GET /api/v1/tag-taxonomy/suggest, and a draft
 * that differs from an existing tag only by CASE says so explicitly —
 * that is the fork this exists to prevent.
 */
import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { Pill } from "@/components/Pill";
import { useToast } from "@/components/Toast";
import { trackSubscriberTagged } from "@/lib/audienceTelemetry";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  limitRunes,
  nextTagsAfterAdd,
  nextTagsAfterRemove,
  TAG_NAME_MAX_RUNES,
  validateTagDraft,
} from "@/lib/tagInput";
import {
  filterTagSuggestions,
  taxonomyCaseVariant,
} from "@/lib/tagSuggestions";
import type { ThemeTokens } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";
import { useDebounced } from "@/hooks/useDebounced";
import { useUpdateSubscriberTags } from "@/hooks/useSubscribers";
import { useTagSuggestions } from "@/hooks/useTagSuggestions";

import { Label } from "./SubscriberDetailPrimitives";
import { TagSuggestionRow } from "./TagSuggestionRow";

import { ModalHeader, SubActionButton } from "./SubActionButton";

export { AddToListModal } from "./AddToListModal";
export { ModalHeader, SubActionButton } from "./SubActionButton";

export function TagsModal({
  visible,
  onClose,
  subscriberId,
  email,
  currentTags,
  t,
}: {
  visible: boolean;
  onClose: () => void;
  subscriberId: string;
  email: string;
  currentTags: string[];
  t: ThemeTokens;
}) {
  const updateTags = useUpdateSubscriberTags();
  const { toast } = useToast();
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (visible) setDraft("");
  }, [visible]);

  // One validator for all three reasons an add is refused (blank, too long,
  // already present) so the hint and the button agree.
  const validation = validateTagDraft(draft, currentTags);
  const canAdd = validation.canAdd && !updateTags.isPending;

  // One request per typing pause, not per keystroke. An EMPTY draft is a
  // legitimate query: the server then returns the most-used tags in the
  // workspace, which is exactly the right opening offer.
  const debouncedDraft = useDebounced(draft.trim(), 250);
  const taxonomy = useTagSuggestions(debouncedDraft, { enabled: visible });
  const suggestions = filterTagSuggestions(taxonomy.data, currentTags);
  // "You typed VIP; the workspace already has vip." Only meaningful once
  // the draft itself is otherwise addable.
  const caseVariant =
    validation.code === "ok"
      ? taxonomyCaseVariant(draft, taxonomy.data)
      : null;

  /**
   * Shared by the Add button and by tapping a suggestion chip, so a picked
   * suggestion goes through the SAME validation (rune cap, duplicate) as a
   * typed one rather than trusting the server's list.
   */
  function addTag(value: string, source: "sheet" | "suggestion" = "sheet") {
    if (updateTags.isPending) return;
    const check = validateTagDraft(value, currentTags);
    const next = nextTagsAfterAdd(currentTags, value);
    if (!check.canAdd || next == null) return;
    updateTags.mutate(
      { id: subscriberId, tags: next },
      {
        onSuccess: () => {
          haptics.success();
          // "suggestion" vs "sheet" is the whole measurement the typeahead
          // exists for: is anyone picking an EXISTING tag instead of typing
          // a near-duplicate?
          trackSubscriberTagged("added", source);
          setDraft("");
        },
        onError: (err: unknown) => {
          haptics.error();
          toast({
            kind: "error",
            message: `Couldn't add that tag. ${err instanceof Error ? err.message : ""}`.trim(),
          });
        },
      },
    );
  }

  function handleAdd() {
    addTag(draft);
  }

  /**
   * Remove with an Undo toast rather than a confirm dialog. The detail
   * card used to confirm and this sheet did not — same action, two
   * behaviours. Removing a tag is trivially reversible, so the reversible
   * path is the right one in BOTH places.
   */
  function handleRemove(tag: string) {
    const next = nextTagsAfterRemove(currentTags, tag);
    if (next == null) return;
    updateTags.mutate(
      { id: subscriberId, tags: next },
      {
        onSuccess: () => {
          haptics.warning();
          trackSubscriberTagged("removed", "sheet");
          toast({
            kind: "info",
            message: `Removed "${tag}"`,
            action: {
              label: "Undo",
              onPress: () =>
                updateTags.mutate({
                  id: subscriberId,
                  tags: nextTagsAfterAdd(next, tag) ?? next,
                }),
            },
          });
        },
        onError: (err: unknown) => {
          haptics.error();
          toast({
            kind: "error",
            message: `Couldn't remove that tag. ${err instanceof Error ? err.message : ""}`.trim(),
          });
        },
      },
    );
  }

  return (
    <KeyboardFormSheet visible={visible} onClose={onClose}>
      <ModalHeader title="Edit tags" onClose={onClose} t={t} />

      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          marginBottom: 16,
          fontFamily: FONT.regular,
        }}
      >
        Tags on {email}. Add a new one below, or tap a tag to remove it.
      </Text>

      <View style={{ flexDirection: "row", gap: 8 }}>
        <TextInput
          value={draft}
          // Hard-cap at the server's rune limit so a pasted paragraph is
          // trimmed here instead of round-tripping to a raw 400.
          onChangeText={(next) => setDraft(limitRunes(next))}
          maxLength={TAG_NAME_MAX_RUNES * 2}
          placeholder="New tag"
          placeholderTextColor={t.fgSubtle}
          accessibilityLabel="New tag"
          {...(validation.hint ? { accessibilityHint: validation.hint } : {})}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={handleAdd}
          returnKeyType="done"
          // `fontSizeFor`, not `typeStyle`: an explicit lineHeight on a
          // TextInput mis-centres the caret and clips descenders on Android.
          maxFontSizeMultiplier={typeCap("body").maxFontSizeMultiplier}
          style={{
            flex: 1,
            color: t.fg,
            fontSize: fontSizeFor("body"),
            fontFamily: FONT.regular,
            borderColor: validation.code === "ok" ? t.border : t.borderSubtle,
            borderWidth: 1,
            borderRadius: 10,
            paddingHorizontal: 12,
            paddingVertical: 10,
            minHeight: 44,
            backgroundColor: t.surface,
          }}
        />
        <SubActionButton
          label={updateTags.isPending ? "Adding…" : "Add"}
          onPress={handleAdd}
          disabled={!canAdd}
          busy={updateTags.isPending}
          {...(validation.hint ? { disabledReason: validation.hint } : {})}
          t={t}
        />
      </View>
      {validation.hint || caseVariant ? (
        <Text
          accessibilityLiveRegion="polite"
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 6,
            fontFamily: FONT.regular,
          }}
        >
          {validation.hint ??
            `This workspace already uses "${caseVariant}". Tap it below to avoid a duplicate.`}
        </Text>
      ) : null}

      <TagSuggestionRow
        suggestions={suggestions}
        isLoading={taxonomy.isLoading && Boolean(debouncedDraft)}
        disabled={updateTags.isPending}
        onPick={(tag) => addTag(tag, "suggestion")}
        t={t}
      />

      <View style={{ marginTop: 20 }}>
        <Label>Current tags</Label>
        {currentTags.length > 0 ? (
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 6,
              marginTop: 8,
            }}
          >
            {currentTags.map((tag) => (
              <Pressable
                key={tag}
                onPress={() => handleRemove(tag)}
                accessibilityRole="button"
                accessibilityLabel={`Remove tag ${tag}`}
                disabled={updateTags.isPending}
                hitSlop={10}
              >
                <Pill label={`${tag}  ✕`} tone="neutral" />
              </Pressable>
            ))}
          </View>
        ) : (
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("bodySmall"),
              marginTop: 8,
              fontFamily: FONT.regular,
            }}
          >
            No tags yet.
          </Text>
        )}
      </View>
    </KeyboardFormSheet>
  );
}
