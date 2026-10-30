/**
 * CampaignBulkSheets — the two pickers the selection bar opens.
 *
 * TAG. `POST /api/v1/campaigns/org-tags/bulk` normalises the tag server-side
 * (trim → lowercase → 40 chars, campaigns/org_tags.go:32) and rejects an
 * empty one with a 400. The field therefore previews the normalised value
 * rather than letting someone type "Q3 Launch" and be surprised by
 * "q3 launch" appearing on seven campaigns.
 *
 * FOLDER. `PATCH /api/v1/campaigns/{id}/folder` takes an id or "" for
 * uncategorised, so "Remove from folder" is a first-class row and not a
 * blank option. Creating a folder lives HERE too (`POST /campaigns/folders`,
 * editor floor): this sheet shows the whole folder set right above the field,
 * and the server's insert is create-or-reuse (`ON CONFLICT (tenant_id, name)
 * DO UPDATE`), so re-typing an existing name files into it rather than
 * duplicating it. The one quiet split that IS possible — "Newsletters" next
 * to "newsletters", because the conflict is exact-string — is called out
 * under the field before the tap (campaignFolderNameConflict).
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import {
  ActionButton,
  ModalHeader,
} from "@/components/campaigns/CampaignDetailControls";
import {
  campaignFolderNameConflict,
  normalizeCampaignFolderName,
  type CampaignFolder,
} from "@/lib/campaignFolders";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useTheme, type ThemeTokens } from "@/lib/theme";

/** Mirrors `normalizeOrgTag` in apps/api/internal/campaigns/org_tags.go:32. */
export function normalizeOrgTag(raw: string): string {
  return raw.trim().toLowerCase().slice(0, 40);
}

export function CampaignBulkTagSheet({
  visible,
  onClose,
  count,
  onApply,
  pending,
}: {
  visible: boolean;
  onClose: () => void;
  count: number;
  onApply: (tag: string) => void;
  pending: boolean;
}) {
  const { t } = useTheme();
  const [raw, setRaw] = useState("");
  useEffect(() => {
    if (visible) setRaw("");
  }, [visible]);

  const normalized = normalizeOrgTag(raw);
  const changed = normalized !== raw.trim() && raw.trim().length > 0;

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel="Tag selected campaigns"
    >
      <ModalHeader title="Tag campaigns" onClose={onClose} />
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          marginBottom: 16,
          fontFamily: FONT.regular,
        }}
      >
        Adds one organisational label to {plural(count, "campaign")}. Campaigns
        that already carry it are left alone.
      </Text>

      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          marginBottom: 6,
          fontFamily: FONT.regular,
        }}
      >
        Tag
      </Text>
      <TextInput
        // Inputs scale with the OS text size but their height does not — cap it.
        {...typeCap("body")}
        value={raw}
        onChangeText={setRaw}
        placeholder="q3-launch"
        placeholderTextColor={t.fgSubtle}
        accessibilityLabel="Tag to apply"
        accessibilityHint="Lowercased and trimmed to 40 characters by the server."
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={80}
        returnKeyType="done"
        onSubmitEditing={() => {
          if (normalized) onApply(normalized);
        }}
        style={{
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
          Will be saved as “{normalized}” — tags are lowercased.
        </Text>
      ) : null}

      <View
        style={{
          flexDirection: "row",
          justifyContent: "flex-end",
          gap: 8,
          marginTop: 20,
        }}
      >
        <ActionButton label="Cancel" onPress={onClose} disabled={pending} />
        <ActionButton
          label={pending ? "Tagging…" : "Apply tag"}
          primary
          onPress={() => onApply(normalized)}
          disabled={pending || normalized.length === 0}
        />
      </View>
    </KeyboardFormSheet>
  );
}

function FolderRow({
  label,
  hint,
  onPress,
  t,
  disabled,
}: {
  label: string;
  hint?: string | undefined;
  onPress: () => void;
  t: ThemeTokens;
  disabled: boolean;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      {...(hint ? { accessibilityHint: hint } : {})}
      accessibilityState={{ disabled }}
      disabled={disabled}
      style={{
        minHeight: 44,
        justifyContent: "center",
        paddingVertical: 12,
        paddingHorizontal: 14,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: t.borderSubtle,
        backgroundColor: t.surface,
        marginBottom: 8,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text
        {...typeCap("body")}
        style={{ color: t.fg, ...typeStyle("body"), fontFamily: FONT.regular }}
      >
        {label}
      </Text>
      {hint ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 2,
            fontFamily: FONT.regular,
          }}
        >
          {hint}
        </Text>
      ) : null}
    </Pressable>
  );
}

/**
 * The create field. What the caption under it says is decided BEFORE the tap:
 * an exact-name match will reuse that folder (server `ON CONFLICT … DO
 * UPDATE`), and a case-only match would mint a near-duplicate — the split the
 * old sheet refused to risk is now named instead of silently performed.
 */
function NewFolderField({
  visible,
  folders,
  pending,
  onCreate,
  t,
}: {
  visible: boolean;
  folders: readonly CampaignFolder[];
  pending: boolean;
  onCreate: (name: string) => void;
  t: ThemeTokens;
}) {
  const [raw, setRaw] = useState("");
  useEffect(() => {
    if (visible) setRaw("");
  }, [visible]);

  const name = normalizeCampaignFolderName(raw);
  const conflict = campaignFolderNameConflict(folders, name);
  const caption =
    conflict === "exact"
      ? `“${name}” already exists — this files the selection into it.`
      : conflict === "case"
        ? "A folder with this name in different casing already exists. Creating this one makes a second, separate folder."
        : null;

  return (
    <View style={{ marginTop: 16 }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          marginBottom: 6,
          fontFamily: FONT.regular,
        }}
      >
        New folder
      </Text>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <TextInput
          {...typeCap("body")}
          value={raw}
          onChangeText={setRaw}
          placeholder="Newsletters"
          placeholderTextColor={t.fgSubtle}
          accessibilityLabel="Name for a new folder"
          accessibilityHint="Creates the folder and files the selected campaigns into it."
          autoCapitalize="sentences"
          autoCorrect={false}
          returnKeyType="done"
          editable={!pending}
          onSubmitEditing={() => {
            if (name) onCreate(name);
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
          label={pending ? "Filing…" : "Create"}
          primary
          onPress={() => onCreate(name)}
          disabled={pending || name.length === 0}
        />
      </View>
      {caption ? (
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
          {caption}
        </Text>
      ) : null}
    </View>
  );
}

export function CampaignFolderPickerSheet({
  visible,
  onClose,
  count,
  folders,
  foldersLoading,
  foldersFailed,
  onPick,
  onCreate,
  pending,
}: {
  visible: boolean;
  onClose: () => void;
  count: number;
  folders: readonly CampaignFolder[];
  foldersLoading: boolean;
  foldersFailed: boolean;
  /** null files the campaigns back under "uncategorised". */
  onPick: (folderId: string | null) => void;
  /** Create a folder with this (already-trimmed) name, then file into it. */
  onCreate: (name: string) => void;
  pending: boolean;
}) {
  const { t } = useTheme();
  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel="Move selected campaigns to a folder"
    >
      <ModalHeader title="Move to folder" onClose={onClose} />
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          marginBottom: 16,
          fontFamily: FONT.regular,
        }}
      >
        Files {plural(count, "campaign")}. A campaign lives in one folder at a
        time, so this replaces whatever folder it is in now.
      </Text>

      {foldersLoading ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          Loading folders…
        </Text>
      ) : foldersFailed ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.danger,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          The folder list couldn&apos;t be loaded, so there is nothing to move
          into. Close this and pull to refresh.
        </Text>
      ) : folders.length === 0 ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            lineHeight: 19,
            fontFamily: FONT.regular,
          }}
        >
          This workspace has no campaign folders yet. Name the first one below
          and the selected campaigns are filed into it in the same step.
        </Text>
      ) : (
        folders.map((folder) => (
          <FolderRow
            key={folder.id}
            label={folder.name}
            {...(folder.campaignCount > 0
              ? { hint: `${plural(folder.campaignCount, "campaign")} already here` }
              : {})}
            onPress={() => onPick(folder.id)}
            t={t}
            disabled={pending}
          />
        ))
      )}

      <View style={{ height: 8 }} />
      <FolderRow
        label="Remove from folder"
        hint="Files them under Uncategorised."
        onPress={() => onPick(null)}
        t={t}
        disabled={pending}
      />

      {/* The create field renders even while the folder list is loading or
          failed: minting a folder needs no knowledge of the others — only the
          duplicate-name caption does, and it simply stays quiet without them. */}
      <NewFolderField
        visible={visible}
        folders={folders}
        pending={pending}
        onCreate={onCreate}
        t={t}
      />
    </KeyboardFormSheet>
  );
}
