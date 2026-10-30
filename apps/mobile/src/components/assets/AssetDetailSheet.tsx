/**
 * AssetDetailSheet — read the image, copy its address, or remove it.
 *
 * A sheet rather than a route, for the same reason the template library uses
 * one: the rhythm is browse → open → decide → next, and a pushed screen charges
 * a navigation animation in each direction. It also keeps this cluster to ONE
 * route file, so the surface costs one tab-layout registration instead of two.
 *
 * IT RE-READS THE ASSET ON OPEN, AND THAT IS NOT REDUNDANT. The grid row's
 * `referencesCount` is a scalar maintained by a periodic refresher
 * (assets/refresher.go); `GET /assets/{id}` re-runs `RecomputeReferenceCount`
 * and refuses to answer at all if that recompute fails (handlers.go:360). Only
 * the single read can therefore name WHICH campaign, template or form embeds
 * the image — and "which" is the whole question in front of a delete. Until it
 * lands the sheet says it is checking, rather than rendering an unknown as
 * "nothing uses this".
 *
 * IT RENDERS THE TAPPED ROW IMMEDIATELY. `asset` is the grid row and is
 * available at open; `detail.asset` supersedes it a moment later. Waiting would
 * put a spinner between the tap and content the operator has already seen.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useState, type ReactNode } from "react";
import { Image } from "expo-image";
import { Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Pill } from "@/components/Pill";
import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { AssetAltTextSection } from "@/components/assets/AssetAltTextSection";
import { assetFormatLabel } from "@/components/assets/AssetTile";
import { AssetUsageBlock } from "@/components/assets/AssetUsageBlock";
import {
  absoluteAssetUrl,
  assetDimensions,
  assetUsagePhrase,
  type AssetDetail,
  type MobileAsset,
} from "@/lib/assetLibrary";
import { assetSizeLabel } from "@/lib/assetUploadPolicy";
import { assetWriteBlockNote } from "@/lib/assetVersionGate";
import { FONT } from "@/lib/fonts";
import { EMDASH, dateTime } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface AssetDetailSheetProps {
  /** The grid row that was tapped — available before the single read. */
  asset: MobileAsset | null;
  /** The single read: the only source of the referrer LIST. */
  detail: AssetDetail | null;
  detailLoading: boolean;
  detailFailed: boolean;
  baseUrl: string | null;
  canWrite: boolean;
  online: boolean;
  deleting: boolean;
  onClose: () => void;
  onCopyUrl: (url: string) => void;
  /**
   * Delete the image. WITHHELD — passed as undefined — rather than disabled
   * when the write cannot be made honestly, which today means the row carried
   * no optimistic-concurrency `version`: `DELETE /assets/{id}` reads one from
   * the body and 428s without it (handlers.go:554), and a guessed number would
   * either be refused or delete a row someone else had already changed. The
   * note under the buttons says which of the three reasons applies.
   */
  onDelete?: ((asset: MobileAsset) => void) | undefined;
  /**
   * The alt-text save (PATCH /assets/{id}) — resolves true when it landed.
   * Optional so read-only embeddings (and older tests) render unchanged; the
   * edit affordance appears only when this is provided AND the role/online
   * gates pass.
   */
  onSaveAltText?: ((next: string) => Promise<boolean>) | undefined;
  altTextSaving?: boolean | undefined;
  /**
   * Opens the organise sheet (folders + tags). Optional so read-only
   * embeddings (and older tests) render unchanged; the button only appears
   * when this is provided AND the role/online gates pass.
   */
  onOrganize?: (() => void) | undefined;
  /**
   * The organise sheet itself, rendered INSIDE this modal's tree — iOS stacks
   * a modal presented from a modal, but refuses a sibling while this one is
   * front-most.
   */
  organizeSheet?: ReactNode;
}

/**
 * The preview, as its own component KEYED BY ASSET ID.
 *
 * `previewFailed` has to reset when the sheet moves to a different image, and
 * the sheet itself never unmounts — its `Modal` only toggles `visible`. Holding
 * the flag here and giving this element `key={id}` is what makes React discard
 * the failed state with the image it belonged to; a `useState` in the sheet
 * would leave the second image permanently showing the first one's failure.
 */
function AssetPreview({
  uri,
  altText,
  format,
}: {
  uri: string | null;
  altText: string;
  format: string;
}) {
  const { t } = useTheme();
  const [failed, setFailed] = useState(false);
  if (!uri || failed) {
    return (
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
          textAlign: "center",
          paddingHorizontal: 20,
        }}
      >
        The preview couldn&apos;t be loaded here. The file itself is unaffected —
        its address is below.
      </Text>
    );
  }
  return (
    <Image
      source={{ uri }}
      contentFit="contain"
      // Shares the disk cache with the grid behind this sheet, so opening a
      // tile the operator just scrolled past renders from disk instead of
      // re-fetching the same immutable object.
      cachePolicy="memory-disk"
      transition={120}
      onError={() => setFailed(true)}
      accessibilityRole="image"
      accessibilityLabel={altText || `${format} preview`}
      style={{ width: "100%", height: "100%" }}
    />
  );
}

function Row({ label, value }: { label: string; value: string }) {
  const { t } = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: 12, alignItems: "flex-start" }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
          width: 104,
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
          flex: 1,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

function SheetButton({
  label,
  onPress,
  tone,
  disabled,
  hint,
}: {
  label: string;
  onPress: () => void;
  tone: "accent" | "danger";
  disabled: boolean;
  hint?: string | undefined;
}) {
  const { t } = useTheme();
  const colour = tone === "danger" ? t.danger : t.accent;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      {...(hint ? { accessibilityHint: hint } : {})}
      style={{
        minHeight: 48,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 12,
        borderWidth: 1,
        borderColor: colour,
        paddingHorizontal: 16,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <Text
        {...typeCap("callout")}
        style={{
          color: colour,
          ...typeStyle("callout"),
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function AssetDetailSheet(props: AssetDetailSheetProps) {
  const { t } = useTheme();
  const shown = props.detail?.asset ?? props.asset;
  const uri = shown ? absoluteAssetUrl(shown.url, props.baseUrl) : null;
  // The detail read's recomputed count supersedes the row's refreshed scalar.
  const liveCount = props.detail?.asset?.referencesCount ?? null;
  /**
   * ONE note under the buttons, never a stack of them, and it is driven by the
   * SAME condition the buttons are: the third reason ("no version") is read
   * off the absence of the callback, because the decision to withhold belongs
   * to the screen, where it is unit-testable, rather than to this render.
   */
  const writeBlock = assetWriteBlockNote(
    props.canWrite,
    props.online,
    Boolean(props.onDelete),
  );

  return (
    <ReducedMotionModal
      visible={props.asset !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 16,
            paddingVertical: 10,
            gap: 12,
          }}
        >
          <Text
            numberOfLines={2}
            {...typeCap("title")}
            style={{
              color: t.fg,
              ...typeStyle("title"),
              fontFamily: FONT.semibold,
              flex: 1,
            }}
          >
            {shown?.filename || "Image"}
          </Text>
          <Pressable
            onPress={props.onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={{
              minWidth: 44,
              minHeight: 44,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: t.accent,
                ...typeStyle("control"),
                fontFamily: FONT.semibold,
              }}
            >
              Done
            </Text>
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingBottom: 28,
            gap: 14,
          }}
          keyboardShouldPersistTaps="handled"
        >
          {shown ? (
            <>
              <View
                style={{
                  aspectRatio: 16 / 10,
                  borderRadius: 14,
                  overflow: "hidden",
                  backgroundColor: t.bgSubtle,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <AssetPreview
                  key={shown.id}
                  uri={uri}
                  altText={shown.altText}
                  format={assetFormatLabel(shown.mime)}
                />
              </View>

              <View
                style={{
                  flexDirection: "row",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <Pill label={assetFormatLabel(shown.mime)} tone="neutral" />
                {liveCount !== null && liveCount > 0 ? (
                  <Pill
                    label="In use"
                    tone="info"
                    accessibilityLabel={assetUsagePhrase(liveCount)}
                  />
                ) : null}
              </View>

              <View style={{ gap: 8 }}>
                <Row
                  label="Dimensions"
                  value={
                    assetDimensions(shown)
                      ? `${assetDimensions(shown)} px`
                      : EMDASH
                  }
                />
                <Row
                  label="Size"
                  value={
                    shown.bytes === null ? EMDASH : assetSizeLabel(shown.bytes)
                  }
                />
                <Row label="Added" value={dateTime(shown.createdAt)} />
                <AssetAltTextSection
                  // Keyed so a sheet moved to a different image discards the
                  // previous image's edit state, exactly like the preview.
                  key={shown.id}
                  altText={shown.altText}
                  canEdit={Boolean(
                    props.canWrite && props.online && props.onSaveAltText,
                  )}
                  saving={props.altTextSaving ?? false}
                  onSave={props.onSaveAltText ?? (() => Promise.resolve(false))}
                />
                <Row label="Address" value={uri ?? EMDASH} />
              </View>

              <AssetUsageBlock
                usage={props.detail?.usage ?? []}
                loading={props.detailLoading}
                failed={props.detailFailed}
                loaded={props.detail !== null}
              />

              <View style={{ gap: 10 }}>
                <SheetButton
                  label="Copy image address"
                  tone="accent"
                  disabled={uri === null}
                  onPress={() => {
                    if (uri) props.onCopyUrl(uri);
                  }}
                  hint={
                    uri === null
                      ? "Unavailable until this workspace reports a full address for the file"
                      : "Copies the full address so you can paste it into a campaign on another device"
                  }
                />
                {props.canWrite && props.online && props.onOrganize ? (
                  <SheetButton
                    label="Organise — folder and tags"
                    tone="accent"
                    disabled={false}
                    onPress={props.onOrganize}
                    hint="File this image into a folder or edit its tags"
                  />
                ) : null}
                {props.canWrite && props.online && props.onDelete ? (
                  <SheetButton
                    label={props.deleting ? "Deleting…" : "Delete image"}
                    tone="danger"
                    disabled={props.deleting}
                    onPress={() => props.onDelete?.(shown)}
                    hint="Asks you to confirm first"
                  />
                ) : null}
              </View>

              {writeBlock === null ? null : (
                <Text
                  {...typeCap("caption")}
                  style={{
                    color: t.fgSubtle,
                    ...typeStyle("caption"),
                    fontFamily: FONT.regular,
                  }}
                >
                  {writeBlock}
                </Text>
              )}
            </>
          ) : null}
        </ScrollView>
        {props.organizeSheet}
      </SafeAreaView>
    </ReducedMotionModal>
  );
}
