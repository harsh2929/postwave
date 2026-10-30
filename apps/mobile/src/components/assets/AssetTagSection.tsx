/**
 * AssetTagSection — the tag half of the organise sheet: the asset's own tags
 * as removable chips, plus a field to add one.
 *
 * The add field previews the server's normalisation (lib/assetOrganize
 * `normalizeAssetTag`, mirroring assets/tags.go:56) the same way the campaign
 * tag sheet does: someone typing "Q3 Launch!" is told it will land as
 * "q3 launch" BEFORE the tap, not surprised by it on the rail afterwards.
 *
 * Loading and failure are stated, never blank: "no tags" is a claim about the
 * asset, and a failed read must not make it.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { ActionButton } from "@/components/campaigns/CampaignDetailControls";
import { normalizeAssetTag } from "@/lib/assetOrganize";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function AssetTagSection({
  visible,
  tags,
  tagsLoading,
  tagsFailed,
  busy,
  onAddTag,
  onRemoveTag,
}: {
  /** The sheet's visibility — resets the add field on each open. */
  visible: boolean;
  /** null while the read has not landed. */
  tags: readonly string[] | null;
  tagsLoading: boolean;
  tagsFailed: boolean;
  busy: boolean;
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
}) {
  const { t } = useTheme();
  const [raw, setRaw] = useState("");
  useEffect(() => {
    if (visible) setRaw("");
  }, [visible]);

  const normalized = normalizeAssetTag(raw);
  const changed = raw.trim().length > 0 && normalized !== raw.trim();

  return (
    <View style={{ marginTop: 20 }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          marginBottom: 6,
          fontFamily: FONT.regular,
        }}
      >
        Tags
      </Text>

      {tagsFailed ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.danger,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          The tags couldn&apos;t be loaded, so what is shown here may be
          incomplete. Close and reopen to retry.
        </Text>
      ) : tagsLoading || tags === null ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          Checking this image&apos;s tags…
        </Text>
      ) : tags.length === 0 ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          No tags yet.
        </Text>
      ) : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {tags.map((tag) => (
            <Pressable
              key={tag}
              onPress={busy ? undefined : () => onRemoveTag(tag)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={`Remove the ${tag} tag`}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                minHeight: 36,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: t.border,
                backgroundColor: t.surface,
                paddingHorizontal: 12,
                opacity: busy ? 0.5 : 1,
              }}
            >
              <Text
                {...typeCap("label")}
                style={{
                  color: t.fg,
                  ...typeStyle("label"),
                  fontFamily: FONT.regular,
                }}
              >
                {tag}
              </Text>
              <Text
                {...typeCap("label")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("label"),
                  fontFamily: FONT.regular,
                }}
              >
                ✕
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      <View
        style={{
          flexDirection: "row",
          gap: 8,
          alignItems: "center",
          marginTop: 10,
        }}
      >
        <TextInput
          {...typeCap("body")}
          value={raw}
          onChangeText={setRaw}
          placeholder="summer-hero"
          placeholderTextColor={t.fgSubtle}
          accessibilityLabel="Tag to add"
          accessibilityHint="Lowercased; punctuation becomes dashes; 64 characters at most."
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={80}
          returnKeyType="done"
          editable={!busy}
          onSubmitEditing={() => {
            if (normalized) onAddTag(normalized);
          }}
          style={{
            flex: 1,
            color: t.fg,
            fontSize: 15,
            fontFamily: FONT.regular,
            borderColor: t.border,
            borderWidth: 1,
            borderRadius: 10,
            paddingHorizontal: 12,
            minHeight: 44,
            backgroundColor: t.surface,
          }}
        />
        <ActionButton
          label="Add tag"
          onPress={() => onAddTag(normalized)}
          disabled={busy || normalized.length === 0}
        />
      </View>
      {changed ? (
        <Text
          {...typeCap("caption")}
          accessibilityLiveRegion="polite"
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 6,
            fontFamily: FONT.regular,
          }}
        >
          Will be saved as “{normalized}” — tags are lowercased and punctuation
          becomes dashes.
        </Text>
      ) : null}
    </View>
  );
}
