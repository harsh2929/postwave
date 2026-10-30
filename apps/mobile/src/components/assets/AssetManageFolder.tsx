/**
 * AssetManageFolder — the strip that appears under a folder row in the organise
 * sheet's Manage mode: rename it, or delete it.
 *
 * Split out of AssetOrganizeSheet when that file crossed its source budget, and
 * the seam is a real one: everything left in the sheet writes the ASSET row
 * (filing it into a bucket, adding a tag), while both verbs here write the
 * FOLDER row and are gated on the FOLDER's own version. Mixing the two gates in
 * one component is precisely how a rename ends up sending an image's version.
 *
 * THE GATE. `UpdateFolder` (folders.go:448) and `DeleteFolder`
 * (readExpectedVersionBody, folders.go:486) both answer 428
 * `expected_version_required` without a positive `expected_version`, and 412
 * `stale_version` when it no longer matches. A folder row that reached this app
 * without a version therefore has no honest rename or delete: the controls are
 * WITHHELD and the reason is stated where they would have been, rather than
 * offered and refused, or fired with a guessed number that could overwrite a
 * colleague's rename.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useState } from "react";
import { Text, TextInput, View } from "react-native";

import { ActionButton } from "@/components/campaigns/CampaignDetailControls";
import type { AssetFolder } from "@/lib/assetLibrary";
import { normalizeAssetFolderName } from "@/lib/assetOrganize";
import {
  ASSET_FOLDER_VERSION_MISSING,
  isAssetRowVersion,
} from "@/lib/assetVersionGate";
import { FONT } from "@/lib/fonts";
import { keyboardChain } from "@/lib/keyboardChain";
import type { ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function AssetManageFolder({
  folder,
  busy,
  onRenameFolder,
  onDeleteFolder,
  t,
}: {
  folder: AssetFolder;
  busy: boolean;
  onRenameFolder: (folderId: string, name: string) => void;
  onDeleteFolder: (folder: AssetFolder) => void;
  t: ThemeTokens;
}) {
  const [name, setName] = useState(folder.name);
  const normalized = normalizeAssetFolderName(name);
  if (!isAssetRowVersion(folder.version)) {
    return (
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          marginBottom: 8,
          fontFamily: FONT.regular,
        }}
      >
        {ASSET_FOLDER_VERSION_MISSING}
      </Text>
    );
  }
  // One rename decision, shared by the button and the return key, so the
  // keyboard can never fire a rename the button refuses (an empty name, an
  // unchanged name, or a write already in flight).
  const renameBlocked =
    busy || normalized.length === 0 || normalized === folder.name;
  const rename = () => {
    if (renameBlocked) return;
    onRenameFolder(folder.id, normalized);
  };

  return (
    <View style={{ marginBottom: 8, gap: 8 }}>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <TextInput
          {...typeCap("body")}
          value={name}
          onChangeText={setName}
          accessibilityLabel={`New name for the ${folder.name} folder`}
          autoCapitalize="sentences"
          autoCorrect={false}
          editable={!busy}
          {...keyboardChain({ onSubmit: rename, disabled: renameBlocked })}
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
        <ActionButton label="Rename" onPress={rename} disabled={renameBlocked} />
      </View>
      <ActionButton
        label="Delete folder"
        danger
        onPress={() => onDeleteFolder(folder)}
        disabled={busy}
      />
    </View>
  );
}
