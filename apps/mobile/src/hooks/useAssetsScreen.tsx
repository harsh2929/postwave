/**
 * hooks/useAssetsScreen.ts — the Images screen's controller.
 *
 * Extracted from `app/(tabs)/assets.tsx`, which the source-budget gate found
 * at 451 lines with a 306-line component function. The split follows the house
 * shape (see useDashboardScreen, useAuditScreen, useSendingSettingsForm): every
 * query, gate, memo and callback lives here, and the screen is render.
 *
 * The comments below are load-bearing and travelled with the code they explain:
 * why a closed session gate counts as offline for a write door, why the memoised
 * grid cell needs stable callback identities, and why the optimistic-concurrency
 * affordances are WITHHELD rather than disabled when a row carries no version.
 */
/**
 * Assets — the workspace image library, and the one place a phone genuinely
 * contributes to it.
 *
 * WHY THIS SURFACE EXISTS AT ALL. A complete asset library shipped server-side
 * (`apps/api/internal/assets` — upload, list with smart filters, folders, tags,
 * per-asset usage, checked delete) and desktop has browsed it for as long as it
 * has existed. Mobile had nothing, which meant the images used in every campaign
 * could only ever come from a laptop — even though the picture is almost always
 * already on the phone, or is about to be taken with it. That is backwards.
 * Uploading is the verb this device is BEST at, and it was the one verb missing.
 *
 * WHAT THIS SCREEN DOES
 *   Browse the library as a grid, narrow it by the server's own smart filters
 *   and by folder / tag, SORT it (the server's five orders — newest, oldest,
 *   largest, name, most-used — as a chip rail, because a big library in
 *   browse-order-only is a scroll punishment), open one image to read its
 *   size, dimensions, what still uses it and its address (copyable, so it can
 *   be pasted into a campaign anywhere), EDIT ITS ALT TEXT (the image most in
 *   need of describing is the one just uploaded from this phone — the person
 *   who took the picture is the one who knows what it shows), UPLOAD from the
 *   photo library or the camera, ORGANISE it (file into a folder — minting,
 *   renaming or deleting folders in place — and add/remove tags, via the
 *   detail sheet's Organise button), and delete behind a confirm that
 *   escalates when live drafts are at stake. Organising from the phone
 *   matters because the phone is where uploads HAPPEN: without it every phone
 *   upload landed uncategorised until a laptop filed it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   No multi-select delete. Arming multi-select destruction on a grid of
 *   thumbnails invites exactly the misclick the typed-phrase confirm exists to
 *   prevent. The omission is argued at its endpoint in api/assets.ts rather
 *   than left as a gap. (Alt-text editing USED to be on this list — "a
 *   keyboard job" — an argument honest about effort and wrong about context;
 *   see AssetAltTextSection.)
 *
 * BOTH VERBS ARE ONLINE-ONLY, AND THE AFFORDANCES ARE HIDDEN OFFLINE.
 * lib/offlineQueueSafety already says so: `/^DELETE /` is in its
 * ONLINE_ONLY_PATTERNS (which win over everything) and `POST /api/v1/assets` is
 * absent from SAFE_MUTATION_PATTERNS. There is a physical reason too — the
 * paused-mutation journal is persisted into the Keychain with a 72 KB ceiling
 * (lib/secureQueryPersister), and a 10 MiB image is ~13.4 MiB of base64, about
 * 190× the entire budget. A queued binary upload is not something this app's
 * queue can hold, so the button is not offered rather than offered and broken.
 *
 * READING IS `viewer`, BOTH VERBS ARE `editor`. These are SCOPE gates
 * (`apikeys.RequireScope`), not role gates: `read:campaigns` is in
 * `readOnlyScopes` so every signed-in role may browse, and `write:campaigns` is
 * in `editorWriteScopes` so upload and delete admit owner, admin and editor but
 * not viewer. A viewer therefore sees the whole library and is told plainly
 * what they cannot do, rather than finding out via a 403.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { AssetGridCell } from "@/components/assets/AssetGridCell";
import { useCallback, useMemo, useState } from "react";
import {
  type ListRenderItem,
} from "react-native";

import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { useDebounced } from "@/hooks/useDebounced";
import { useIsOnline } from "@/hooks/useIsOnline";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useFirstPageRefresh } from "@/hooks/useFirstPageRefresh";
import { assetLibraryQueryRootKey } from "@/lib/detailSeedKeys";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import {
  useAssetDetail,
  useAssetFolders,
  useAssetLibrary,
  useAssetTags,
} from "@/hooks/useAssets";
import { useAssetActions } from "@/hooks/useAssetActions";
import { useAssetAltTextSave } from "@/hooks/useAssetAltTextSave";
import {
  DEFAULT_ASSET_SORT,
  type AssetFilter,
  type AssetSort,
  type MobileAsset,
} from "@/lib/assetLibrary";
import { canOfferAssetWrite } from "@/lib/assetVersionGate";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useTheme } from "@/lib/theme";
import { useAuthStore } from "@/store/auth";

export { AppErrorBoundary as ErrorBoundary };

/**
 * One cell of the two-column grid. Module-scoped and memoised so a re-render
 * of the screen that changed nothing about a tile does not repaint it.
 */

export function useAssetsScreen() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const online = useIsOnline();
  useScreenViewed("assets");

  const mode = useAuthStore((s) => s.mode);
  const canWrite = canAccessMinimumRole("editor", gate.effectiveRole, mode);
  /**
   * THE CONNECTION HALF OF EVERY WRITE DOOR ON THIS SCREEN.
   *
   * Two different facts can make a write impossible, and only one of them is
   * the radio. `useIsOnline()` is OS reachability; `gate.enabled` is
   * `canUseOnlineServices()` — false for a cached or blocked session, which
   * cannot call the API at all however good the network is. An upload is a
   * multi-megabyte base64 body that lib/offlineQueueSafety refuses to queue,
   * so with either fact false there is nothing honest to offer.
   *
   * The screen already treats a closed gate as offline everywhere else: the
   * list's own `offlineMessage` below is what QueryStates renders for
   * `!gate.enabled`. Offering "+" in that same frame contradicted the sentence
   * next to it. Same shape as landing-pages.tsx (`… && gate.enabled`) and
   * pii-findings.tsx (`isAdmin && gate.enabled`).
   */
  const writeReachable = online && gate.enabled;

  const [query, setQuery] = useState("");
  // 300ms: `q` reaches the server as a LIKE over filename, not a local filter.
  const debouncedQuery = useDebounced(query, 300);
  const [filter, setFilter] = useState<AssetFilter>("all");
  const [sort, setSort] = useState<AssetSort>(DEFAULT_ASSET_SORT);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [organizeOpen, setOrganizeOpen] = useState(false);

  const library = useAssetLibrary({
    query: debouncedQuery,
    filter,
    folderId,
    tag,
    sort,
  });
  const folders = useAssetFolders();
  const tags = useAssetTags();
  const detail = useAssetDetail(openId);
  // Bounded to one page request (see useFirstPageRefresh). Every filter this
  // screen offers is in the query KEY, so page one is the whole answer.
  const refreshLibrary = useFirstPageRefresh(
    assetLibraryQueryRootKey(gate.tenantId),
    library.refetch,
  );
  const refresh = useManualRefresh([
    refreshLibrary,
    folders.refetch,
    tags.refetch,
  ]);

  const rows = useMemo(
    () => (Array.isArray(library.data?.pages) ? library.data?.pages : []).flatMap((page) => page.items),
    [library.data],
  );
  // `counts` describes the whole tenant set, so the FIRST page's copy is the
  // authoritative one and later pages cannot disagree with it.
  const counts = library.data?.pages?.[0]?.counts ?? null;
  const openAsset = useMemo(
    () => rows.find((row) => row.id === openId) ?? null,
    [rows, openId],
  );
  const narrowed =
    debouncedQuery.trim() !== "" || filter !== "all" || folderId !== null || tag !== null;

  // Stable identities. `AssetTile` is `React.memo`'d, and an arrow rebuilt
  // inside `renderItem` is a changed prop on every cell — so the memo could
  // never hold, and every visible thumbnail re-rendered on each keystroke in
  // the search field and on opening or closing the detail sheet.
  const openTile = useCallback((asset: MobileAsset) => setOpenId(asset.id), []);
  const lastIndex = rows.length - 1;
  const renderTile = useCallback<ListRenderItem<MobileAsset>>(
    ({ item, index }) => (
      <AssetGridCell
        asset={item}
        baseUrl={gate.baseUrl}
        alone={index === lastIndex && index % 2 === 0}
        onPress={openTile}
      />
    ),
    [gate.baseUrl, lastIndex, openTile],
  );

  const loadMore = useCallback(() => {
    if (library.hasNextPage && !library.isFetchingNextPage) {
      void library.fetchNextPage();
    }
  }, [library]);

  // The detail read's copy of the row supersedes the grid's (fresher folderId).
  const shownAsset = detail.data?.asset ?? openAsset;

  // The alt-text save, with its version gate and its two failure sentences, in
  // hooks/useAssetAltTextSave. `save` is undefined when the row carries no
  // optimistic-concurrency version, and the sheet OMITS the affordance rather
  // than offering a button whose PATCH the server would refuse (428).
  const altText = useAssetAltTextSave(openId, shownAsset);

  /**
   * THE ONE GATE EVERY WRITE ON THIS SHEET SHARES.
   *
   * Deleting, filing into a folder and tagging are all optimistic-concurrency
   * writes against the ASSET row: each answers 428 `expected_version_required`
   * without a positive `expected_version` and 412 `stale_version` when the
   * number no longer matches. The only honest source of it is the row on
   * screen, so when the payload carried none the affordances are WITHHELD —
   * passing `undefined` rather than disabling — and the sheet says which of
   * role / connection / version is the reason. (Folder rename and delete are
   * gated separately, on the FOLDER's version, inside AssetManageFolder.)
   */
  const canVersionedWrite = canOfferAssetWrite(
    canWrite,
    writeReachable,
    shownAsset?.version,
  );
  const folderRows = Array.isArray(folders.data) ? folders.data : [];

  const actions = useAssetActions({
    // The single read RECOMPUTES the reference count; the grid row carries a
    // periodically refreshed scalar. Prefer the recomputed one once it lands.
    recomputedCount: detail.data?.asset?.referencesCount ?? null,
    onUploaded: () => setUploadOpen(false),
    onDeleted: () => setOpenId(null),
  });

  return {
    actions,
    altText,
    canVersionedWrite,
    canWrite,
    counts,
    detail,
    filter,
    folderId,
    folderRows,
    folders,
    gate,
    library,
    loadMore,
    narrowed,
    online,
    openAsset,
    openId,
    organizeOpen,
    query,
    refresh,
    renderTile,
    rows,
    setFilter,
    setFolderId,
    setOpenId,
    setOrganizeOpen,
    setQuery,
    setSort,
    setTag,
    setUploadOpen,
    shownAsset,
    sort,
    t,
    tag,
    tags,
    uploadOpen,
    writeReachable,
  };
}

export type AssetsScreenController = ReturnType<typeof useAssetsScreen>;
