/**
 * AssetOrganizePanel — the organise sheet, wired to the organising verbs with
 * the versions each of them is gated on.
 *
 * Split out of app/(tabs)/assets.tsx when that screen's body crossed its
 * function budget. The seam is a real responsibility rather than a slice of
 * lines: the screen owns BROWSING (a grid, its filters, one open row), while
 * everything here is the answer to "which row's optimistic-concurrency number
 * does this verb send" — a question with three different answers:
 *
 *   file this image into a folder → the ASSET's version
 *   add / remove a tag           → the ASSET's version
 *   rename / delete a folder     → the FOLDER's own version
 *
 * The sheet knows nothing about versions; it renders folder ids and tags. So
 * the folder row is resolved back out of the list here, where the verbs live,
 * rather than widening the sheet's props with a concept it does not use.
 *
 * The two reads it needs — the folder list and this asset's own tags — are
 * passed in and fetched here respectively: the folder list is shared with the
 * screen's filter rail, while the tag list belongs to nothing else.
 */
import {
  useAssetOrganizeActions,
  useAssetTagList,
} from "@/hooks/useAssetOrganize";
import { AssetOrganizeSheet } from "@/components/assets/AssetOrganizeSheet";
import type { AssetFolder, MobileAsset } from "@/lib/assetLibrary";
import { assetFolderById } from "@/lib/assetOrganize";

export interface AssetOrganizePanelProps {
  visible: boolean;
  onClose: () => void;
  /** null while no row is open; the sheet stays closed. */
  assetId: string | null;
  /** The row the detail sheet is showing — the source of its version. */
  asset: MobileAsset | null;
  folders: readonly AssetFolder[];
  foldersLoading: boolean;
  foldersFailed: boolean;
}

export function AssetOrganizePanel(props: AssetOrganizePanelProps) {
  const organize = useAssetOrganizeActions();
  // The grid row does not carry tags; this is the sheet's own read.
  //
  // Gated on `visible`, not just on having a row: the panel is mounted by the
  // detail sheet whether or not anyone opened it, so keying only on the asset
  // id spent a round trip on this asset's tags every time a row was TAPPED —
  // for a control nobody had touched, competing with the preview the reader is
  // actually waiting for. `staleTime: 0` means the read still happens the
  // moment the sheet opens, and AssetOrganizeSheet already renders `tagsLoading`
  // for exactly that window.
  const tagList = useAssetTagList(props.visible ? props.assetId : null);
  const assetId = props.assetId;
  const assetVersion = props.asset?.version ?? null;

  return (
    <AssetOrganizeSheet
      visible={props.visible}
      onClose={props.onClose}
      assetId={assetId}
      assetFilename={props.asset?.filename ?? ""}
      currentFolderId={props.asset?.folderId ?? null}
      folders={props.folders}
      foldersLoading={props.foldersLoading}
      foldersFailed={props.foldersFailed}
      tags={Array.isArray(tagList.data) ? tagList.data : null}
      tagsLoading={tagList.isLoading}
      tagsFailed={tagList.isError}
      busy={organize.busy}
      onMove={(folderId, name) => {
        if (assetId) organize.moveToFolder(assetId, assetVersion, folderId, name);
      }}
      onCreateFolder={(name) => {
        if (assetId) organize.createFolderAndMove(assetId, assetVersion, name);
      }}
      // The rename writes the FOLDER row, so the verb takes the folder itself;
      // the sheet only knows the id it rendered from.
      onRenameFolder={(folderId, name) => {
        const folder = assetFolderById(props.folders, folderId);
        if (folder) organize.renameFolder(folder, name);
      }}
      onDeleteFolder={organize.deleteFolder}
      onAddTag={(tag) => {
        if (assetId) organize.addTag(assetId, assetVersion, tag);
      }}
      onRemoveTag={(tag) => {
        if (assetId) organize.removeTag(assetId, assetVersion, tag);
      }}
    />
  );
}
