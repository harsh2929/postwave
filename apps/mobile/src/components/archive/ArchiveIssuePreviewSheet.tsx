/**
 * ArchiveIssuePreviewSheet — read a published issue WITHOUT leaving the app.
 *
 * The archive row's only affordance used to be `Linking.openURL`, which hands
 * the user to Safari: returning is an app switch, the app cold-starts back at
 * the top of the index, and the scroll position and the search they typed are
 * both gone. Worse, that URL is built from the tenant's PUBLIC archive routing,
 * so on a workspace that has never configured an archive slug or vanity domain
 * the button reliably opened a 404 in an external browser.
 *
 * This sheet reads GET /api/v1/admin/archive/issues/{slug}/preview
 * (archive.go:702 AdminPreview → Repo.GetIssue) — the workspace's own copy,
 * which needs no public routing at all. It renders the issue as TEXT and says
 * so: `react-native-webview` is not a dependency, so there is no honest way to
 * claim pixel fidelity here. The full-fidelity path is one tap away when a
 * public URL exists, and it opens in the IN-APP browser so the back-stack
 * survives.
 */
import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { SkeletonList } from "@/components/Skeleton";
import { useArchiveIssuePreview } from "@/hooks/useArchiveOps";
import {
  htmlToParagraphs,
  previewWasTruncated,
  readingMinutes,
} from "@/lib/archivePreviewText";
import { FONT } from "@/lib/fonts";
import { date } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const MAX_PARAGRAPHS = 60;

export function ArchiveIssuePreviewSheet({
  slug,
  fallbackTitle,
  onClose,
  onOpenPublic,
  openPublicBlockedReason,
}: {
  /** Null closes the sheet; a slug opens it and drives the fetch. */
  slug: string | null;
  /** The list row's subject — shown while the detail read is still in flight. */
  fallbackTitle: string;
  onClose: () => void;
  onOpenPublic: (() => void) | null;
  openPublicBlockedReason: string | null;
}) {
  const { t } = useTheme();
  const preview = useArchiveIssuePreview(slug);

  const paragraphs = useMemo(
    () => htmlToParagraphs(preview.data?.htmlBody ?? "", MAX_PARAGRAPHS),
    [preview.data?.htmlBody],
  );
  const truncated = useMemo(
    () => previewWasTruncated(preview.data?.htmlBody ?? "", MAX_PARAGRAPHS),
    [preview.data?.htmlBody],
  );
  const minutes = readingMinutes(paragraphs);

  const title = preview.data?.subject || fallbackTitle || slug || "Issue";
  const meta = preview.data
    ? [
        date(preview.data.publishedAt),
        preview.data.authorName || null,
        // ABSENCE IS NOT ZERO — an unreadable body has no reading time.
        minutes === null ? null : `≈${minutes} min read`,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" · ")
    : null;

  return (
    <KeyboardFormSheet
      visible={slug !== null}
      onClose={onClose}
      accessibilityLabel={`Preview of ${title}`}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text
            accessibilityRole="header"
            {...typeCap("title")}
            style={{
              color: t.fg,
              fontFamily: FONT.bold,
              ...typeStyle("title"),
            }}
          >
            {title}
          </Text>
          {meta ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                fontFamily: FONT.regular,
                ...typeStyle("caption"),
                marginTop: 4,
              }}
            >
              {meta}
            </Text>
          ) : null}
        </View>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close preview"
          hitSlop={8}
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
              fontFamily: FONT.semibold,
              ...typeStyle("control"),
            }}
          >
            Done
          </Text>
        </Pressable>
      </View>

      <PreviewBody
        isLoading={preview.isLoading}
        isError={preview.isError}
        error={preview.error}
        onRetry={() => void preview.refetch()}
        paragraphs={paragraphs}
        hasData={Boolean(preview.data)}
        truncated={truncated}
      />

      <View style={{ marginTop: 20, gap: 8 }}>
        <Pressable
          onPress={() => onOpenPublic?.()}
          disabled={!onOpenPublic}
          accessibilityRole="link"
          accessibilityLabel="Open the published page in the in-app browser"
          {...(openPublicBlockedReason
            ? { accessibilityHint: openPublicBlockedReason }
            : {})}
          accessibilityState={{ disabled: !onOpenPublic }}
          style={{
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 10,
            borderWidth: 1,
            borderColor: t.border,
            backgroundColor: t.surface,
            opacity: onOpenPublic ? 1 : 0.5,
          }}
        >
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              fontFamily: FONT.semibold,
              ...typeStyle("body"),
            }}
          >
            Open published page
          </Text>
        </Pressable>
        {openPublicBlockedReason ? (
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              fontFamily: FONT.regular,
              ...typeStyle("caption"),
            }}
          >
            {openPublicBlockedReason}
          </Text>
        ) : null}
      </View>
    </KeyboardFormSheet>
  );
}

function PreviewBody({
  isLoading,
  isError,
  error,
  onRetry,
  paragraphs,
  hasData,
  truncated,
}: {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  paragraphs: readonly string[];
  hasData: boolean;
  truncated: boolean;
}) {
  const { t } = useTheme();
  // ERROR WINS OVER EMPTY: a failed read must never render as "this issue has
  // no text", which on an archive screen reads as "we published a blank page".
  if (isError) {
    return (
      <View style={{ marginTop: 16 }}>
        <ErrorState compact error={error} onRetry={onRetry} />
      </View>
    );
  }
  if (isLoading && !hasData) {
    return (
      <View style={{ marginTop: 16 }}>
        <SkeletonList rows={6} lines={3} label="Loading the issue" />
      </View>
    );
  }
  return (
    <View style={{ marginTop: 16 }}>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          fontFamily: FONT.semibold,
          ...typeStyle("caption"),
          textTransform: "uppercase",
          letterSpacing: 0.6,
          marginBottom: 10,
        }}
      >
        Text preview · images and layout not shown
      </Text>
      {paragraphs.length === 0 ? (
        <Text
          {...typeCap("body")}
          style={{
            color: t.fgMuted,
            fontFamily: FONT.regular,
            ...typeStyle("body"),
          }}
        >
          This issue has no readable text — its body is images or markup only.
          Open the published page to see it as subscribers do.
        </Text>
      ) : (
        <ScrollView
          nestedScrollEnabled
          style={{ maxHeight: 420 }}
          contentContainerStyle={{ gap: 12, paddingBottom: 4 }}
        >
          {paragraphs.map((paragraph, index) => (
            <Text
              key={`p-${index}`}
              {...typeCap("body")}
              selectable
              style={{
                color: t.fg,
                fontFamily: FONT.regular,
                ...typeStyle("body"),
              }}
            >
              {paragraph}
            </Text>
          ))}
          {truncated ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                fontFamily: FONT.regular,
                ...typeStyle("caption"),
              }}
            >
              Preview stops after {MAX_PARAGRAPHS} blocks — this issue is
              longer. Open the published page for the rest.
            </Text>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}
