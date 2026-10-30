/**
 * AssetOrganizeSheet — file one image into a folder, mint/rename/delete
 * folders, and edit the image's tags. Opened from the detail sheet's
 * "Organise" button; rendered INSIDE the detail sheet's modal tree so iOS
 * stacks the two sheets instead of refusing to present a sibling.
 *
 * WHY THIS EXISTS ON A PHONE AT ALL: uploading is the one verb this device is
 * best at, and until now everything a phone uploaded landed uncategorised and
 * untagged, waiting for a laptop to clean up after it. Filing and labelling
 * are one-thumb verbs; only alt-text authoring stays a keyboard job.
 *
 * FOLDER SEMANTICS ARE THE SERVER'S: exactly one folder per asset (picking
 * replaces), "Uncategorised" is folder_id NULL, a duplicate folder name is a
 * 409 (stated before the tap via `assetFolderNameTaken`), and deleting a
 * folder leaves its images in place — which is why its confirm (in
 * useAssetOrganize) is a plain one, not the typed-phrase gate.
 *
 * Editor-floor + online-only, enforced one level up: the Organise button only
 * renders for `canWrite && online` AND only when the asset row carries the
 * optimistic-concurrency version that filing and tagging are both gated on —
 * every write here answers 428 `expected_version_required` without one, so a
 * sheet opened for a version-less row could offer nothing that worked.
 *
 * The Manage strip (rename / delete a folder) lives in AssetManageFolder: those
 * two verbs are gated on the FOLDER's own version rather than the asset's, and
 * that difference is worth a file boundary.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import {
  ActionButton,
  ModalHeader,
} from "@/components/campaigns/CampaignDetailControls";
import { AssetManageFolder } from "@/components/assets/AssetManageFolder";
import { AssetTagSection } from "@/components/assets/AssetTagSection";
import type { AssetFolder } from "@/lib/assetLibrary";
import {
  assetFolderNameTaken,
  normalizeAssetFolderName,
} from "@/lib/assetOrganize";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import { keyboardChain } from "@/lib/keyboardChain";
import { useTheme, type ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface AssetOrganizeSheetProps {
  visible: boolean;
  onClose: () => void;
  assetId: string | null;
  assetFilename: string;
  /** null = Uncategorised. */
  currentFolderId: string | null;
  folders: readonly AssetFolder[];
  foldersLoading: boolean;
  foldersFailed: boolean;
  tags: readonly string[] | null;
  tagsLoading: boolean;
  tagsFailed: boolean;
  busy: boolean;
  onMove: (folderId: string | null, folderName: string | null) => void;
  onCreateFolder: (name: string) => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onDeleteFolder: (folder: AssetFolder) => void;
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
}

function FolderRow({
  label,
  hint,
  current,
  disabled,
  onPress,
  t,
}: {
  label: string;
  hint: string | null;
  current: boolean;
  disabled: boolean;
  onPress: () => void;
  t: ThemeTokens;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={current ? `${label}, current folder` : label}
      accessibilityState={{ disabled, selected: current }}
      style={{
        minHeight: 44,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: current ? t.accent : t.borderSubtle,
        backgroundColor: t.surface,
        marginBottom: 8,
        opacity: disabled && !current ? 0.5 : 1,
      }}
    >
      <View style={{ flex: 1 }}>
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
      </View>
      {current ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.accent,
            ...typeStyle("label"),
            fontFamily: FONT.semibold,
          }}
        >
          ✓
        </Text>
      ) : null}
    </Pressable>
  );
}

export function AssetOrganizeSheet(props: AssetOrganizeSheetProps) {
  const { t } = useTheme();
  const [managing, setManaging] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  useEffect(() => {
    if (props.visible) {
      setManaging(null);
      setNewName("");
    }
  }, [props.visible]);

  const createName = normalizeAssetFolderName(newName);
  const taken = assetFolderNameTaken(props.folders, createName);

  return (
    <KeyboardFormSheet
      visible={props.visible && props.assetId !== null}
      onClose={props.onClose}
      accessibilityLabel="Organise this image"
    >
      <ModalHeader title="Organise" onClose={props.onClose} />
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          marginBottom: 16,
          fontFamily: FONT.regular,
        }}
      >
        {props.assetFilename || "This image"} lives in one folder at a time;
        tags can stack.
      </Text>

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          Folder
        </Text>
        {props.folders.length > 0 ? (
          <Pressable
            onPress={() => setManaging((prev) => (prev === null ? "" : null))}
            accessibilityRole="button"
            accessibilityLabel={
              managing === null
                ? "Manage folders — rename or delete"
                : "Stop managing folders"
            }
            hitSlop={8}
            style={{ minHeight: 32, justifyContent: "center" }}
          >
            <Text
              {...typeCap("label")}
              style={{
                color: t.accent,
                ...typeStyle("label"),
                fontFamily: FONT.semibold,
              }}
            >
              {managing === null ? "Manage" : "Done managing"}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {props.foldersLoading ? (
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
      ) : props.foldersFailed ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.danger,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          The folder list couldn&apos;t be loaded. Close this and pull to
          refresh.
        </Text>
      ) : (
        <>
          {props.folders.map((folder) => (
            <View key={folder.id}>
              <FolderRow
                label={folder.name}
                hint={
                  folder.assetCount > 0
                    ? `${plural(folder.assetCount, "image")} in it`
                    : null
                }
                current={props.currentFolderId === folder.id}
                disabled={
                  props.busy ||
                  (managing === null && props.currentFolderId === folder.id)
                }
                onPress={() =>
                  managing !== null
                    ? setManaging((prev) =>
                        prev === folder.id ? "" : folder.id,
                      )
                    : props.onMove(folder.id, folder.name)
                }
                t={t}
              />
              {managing === folder.id ? (
                // Keyed by the CURRENT name so a landed rename remounts the
                // field with the server's answer instead of the stale draft.
                <AssetManageFolder
                  key={folder.name}
                  folder={folder}
                  busy={props.busy}
                  onRenameFolder={props.onRenameFolder}
                  onDeleteFolder={props.onDeleteFolder}
                  t={t}
                />
              ) : null}
            </View>
          ))}
          {managing !== null ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                marginBottom: 8,
                fontFamily: FONT.regular,
              }}
            >
              Tap a folder to rename or delete it. Deleting a folder never
              deletes the images inside — they go back to Uncategorised.
            </Text>
          ) : props.currentFolderId !== null ? (
            <FolderRow
              label="Remove from folder"
              hint="Back to Uncategorised."
              current={false}
              disabled={props.busy}
              onPress={() => props.onMove(null, null)}
              t={t}
            />
          ) : null}
        </>
      )}

      <View
        style={{
          flexDirection: "row",
          gap: 8,
          alignItems: "center",
          marginTop: 4,
        }}
      >
        <TextInput
          {...typeCap("body")}
          value={newName}
          onChangeText={setNewName}
          placeholder="New folder"
          placeholderTextColor={t.fgSubtle}
          accessibilityLabel="Name for a new folder"
          accessibilityHint="Creates the folder and files this image into it."
          autoCapitalize="sentences"
          autoCorrect={false}
          editable={!props.busy}
          // The return key is exactly as capable as the Create button beside
          // it — same guard, same action — so the two cannot drift.
          {...keyboardChain({
            onSubmit: () => props.onCreateFolder(createName),
            disabled: props.busy || createName.length === 0 || taken,
          })}
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
          label="Create"
          primary
          onPress={() => props.onCreateFolder(createName)}
          disabled={props.busy || createName.length === 0 || taken}
        />
      </View>
      {taken ? (
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
          “{createName}” already exists — tap it in the list above to file this
          image there.
        </Text>
      ) : null}

      <AssetTagSection
        visible={props.visible}
        tags={props.tags}
        tagsLoading={props.tagsLoading}
        tagsFailed={props.tagsFailed}
        busy={props.busy}
        onAddTag={props.onAddTag}
        onRemoveTag={props.onRemoveTag}
      />
    </KeyboardFormSheet>
  );
}
