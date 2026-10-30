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
import {
  FlatList,
  RefreshControl,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SearchField } from "@/components/SearchField";
import { SkeletonList } from "@/components/Skeleton";
import { HeaderAction } from "@/components/deliverability/HeaderAction";
import { AssetDetailSheet } from "@/components/assets/AssetDetailSheet";
import { AssetOrganizePanel } from "@/components/assets/AssetOrganizePanel";
import {
  AssetFilterRails,
  assetFilterHint,
} from "@/components/assets/AssetFilterRails";
import { AssetUploadSheet } from "@/components/assets/AssetUploadSheet";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { goBackOrMore } from "@/lib/nav";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAssetsScreen } from "@/hooks/useAssetsScreen";

export { AppErrorBoundary as ErrorBoundary };

/**
 * One cell of the two-column grid. Module-scoped and memoised so a re-render
 * of the screen that changed nothing about a tile does not repaint it.
 */

export default function Assets() {
  const {
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
  } = useAssetsScreen();

  /* ---------------- render ---------------- */

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Images"
        {...(counts
          ? { subtitle: `${plural(counts.all, "image")} in this workspace` }
          : {})}
        onBack={goBackOrMore}
        right={
          canWrite && writeReachable ? (
            <HeaderAction
              label="+"
              accessibilityLabel="Add an image to the library"
              onPress={() => {
                haptics.tap();
                setUploadOpen(true);
              }}
            />
          ) : null
        }
      />

      <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 }}>
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder="Search by file name…"
          accessibilityLabel="Search images by file name"
          resultCount={library.data ? rows.length : undefined}
          resultNoun="image"
        />
      </View>

      <AssetFilterRails
        filter={filter}
        onFilterChange={setFilter}
        counts={counts}
        folders={Array.isArray(folders.data) ? folders.data : []}
        folderId={folderId}
        onFolderChange={setFolderId}
        tags={Array.isArray(tags.data) ? tags.data : []}
        tag={tag}
        onTagChange={setTag}
        sort={sort}
        onSortChange={setSort}
      />

      <Text
        accessibilityLiveRegion="polite"
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          paddingHorizontal: 16,
          paddingTop: 8,
        }}
      >
        {assetFilterHint(filter)}
      </Text>

      <FlatList
        // Drag-to-dismiss: this screen has a search field, so the keyboard covers
        // roughly half the viewport and nothing else here closes it.
        keyboardDismissMode="on-drag"
        data={library.data === undefined ? [] : rows}
        keyExtractor={(row) => row.id}
        numColumns={2}
        columnWrapperStyle={{ gap: 12 }}
        contentContainerStyle={{
          padding: 16,
          paddingTop: 10,
          paddingBottom: 32,
          gap: 12,
          flexGrow: 1,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
        {...MOBILE_LIST_PERF_PROPS}
        onEndReachedThreshold={0.6}
        onEndReached={loadMore}
        ListHeaderComponent={
          canWrite ? null : (
            <MobileScopeNotice
              title="Read-only for your role"
              body="Browsing the library and copying an image address are open to everyone here. Uploading and deleting need an editor role."
            />
          )
        }
        ListEmptyComponent={
          <QueryStates
            query={library}
            gate={gate}
            isEmpty={rows.length === 0}
            skeleton={<SkeletonList rows={4} />}
            offlineMessage="You're offline, so the image library can't be loaded. It'll load when you reconnect."
            empty={{
              title: narrowed ? "Nothing matches" : "No images yet",
              description: narrowed
                ? "Search covers every file name in the library, not just this page — try different words, or clear the filters."
                : "Images used in campaigns, templates and forms live here. Add one from this phone with the + button.",
              ...(canWrite && writeReachable && !narrowed
                ? {
                    cta: {
                      label: "Add an image",
                      onPress: () => setUploadOpen(true),
                    },
                  }
                : {}),
            }}
          >
            {null}
          </QueryStates>
        }
        renderItem={renderTile}
      />

      <AssetDetailSheet
        asset={openAsset}
        detail={detail.data ?? null}
        detailLoading={detail.isLoading}
        detailFailed={detail.isError}
        baseUrl={gate.baseUrl}
        canWrite={canWrite}
        online={writeReachable}
        deleting={actions.deleting}
        onClose={() => {
          setOrganizeOpen(false);
          setOpenId(null);
        }}
        onCopyUrl={actions.copyUrl}
        // Withheld — not disabled — while the row carries no version: the
        // DELETE reads one from its body and 428s without it, and a guess
        // could remove a row a teammate had already changed.
        onDelete={canVersionedWrite ? actions.removeAsset : undefined}
        // Same rule for the description (useAssetAltTextSave).
        onSaveAltText={altText.save}
        altTextSaving={altText.saving}
        onOrganize={canVersionedWrite ? () => setOrganizeOpen(true) : undefined}
        // Which row's version each organising verb sends is not uniform, so
        // that wiring lives with the verbs (AssetOrganizePanel) rather than in
        // this screen's body.
        organizeSheet={
          <AssetOrganizePanel
            visible={organizeOpen}
            onClose={() => setOrganizeOpen(false)}
            assetId={openId}
            asset={shownAsset}
            folders={folderRows}
            foldersLoading={folders.isLoading}
            foldersFailed={folders.isError}
          />
        }
      />

      <AssetUploadSheet
        visible={uploadOpen}
        busy={actions.uploading}
        onClose={() => setUploadOpen(false)}
        onPickLibrary={actions.pickFromLibrary}
        onPickCamera={actions.pickFromCamera}
      />
    </SafeAreaView>
  );
}
