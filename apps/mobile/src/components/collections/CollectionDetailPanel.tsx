/**
 * CollectionDetailPanel — the rows of ONE reference collection, and the
 * permission split that makes this panel different from the list above it.
 *
 * THE SPLIT, READ FROM THE HANDLER. `GET /api/v1/collections` is mounted behind
 * `RequireScope(ScopeReadSubscribers)` and `GET /api/v1/collections/{id}` behind
 * `RequireScope(ScopeWriteSubscribers)` (`collections/handlers.go:47-48`) — a
 * READ that requires a WRITE scope, deliberately, because "a full detail
 * response can contain confidential lookup values" (`handlers.go:36-39`).
 * `read:subscribers` is in `readOnlyScopes` so the list clears every role;
 * `write:subscribers` is not, so the detail runs `sessionRoleAllowsScopes`
 * (`apikeys/middleware.go:300-318`) and admits owner, admin and — via
 * `editorWriteScopes` — editor. A viewer gets 403 `insufficient_role`.
 *
 * SO THE PANEL PRE-EMPTS, AND STILL HANDLES THE LIVE REFUSAL. `allowed` keeps a
 * viewer from firing a request that can only 403; the 403 branch stays because
 * `storedGrantsCoverScopes` (`middleware.go:216`) can additively grant the scope
 * to a custom role, and because a role can change mid-session. Both say the
 * same sentence (`COLLECTION_DETAIL_GATE`) so the rule reads as one rule.
 *
 * A 404 IS NOT A REFUSAL AND NOT AN EMPTY COLLECTION. `Get` returns 404
 * `not_found` for a valid id with no row for this tenant (`handlers.go:93-96`),
 * which on this screen means the collection was deleted between the list read
 * and the tap. That gets its own sentence rather than falling through to "no
 * rows", which would report a deletion as an empty table.
 *
 * NativeWind v4: static style objects only.
 */
import { Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { RoleGateNotice } from "@/components/RoleGateNotice";
import { SkeletonList } from "@/components/Skeleton";
import { CollectionRowsTable } from "@/components/collections/CollectionRowsTable";
import type { CollectionDetail } from "@/lib/collections";
import {
  COLLECTION_DETAIL_GATE,
  collectionSourceSentence,
  isCollectionRoleDenied,
} from "@/lib/collectionInventory";
import {
  COLLECTION_ROW_PREVIEW_LIMIT,
  collectionColumnNote,
  collectionColumns,
  collectionRowPreviewNote,
  previewWasSanitized,
} from "@/lib/collectionRows";
import { dateTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface CollectionDetailPanelProps {
  /** True when the session's role clears the detail route's editor floor. */
  allowed: boolean;
  /** Whether the online gate lets any request run at all. */
  online: boolean;
  detail: CollectionDetail | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
}

export function CollectionDetailPanel({
  allowed,
  online,
  detail,
  isLoading,
  isError,
  error,
}: CollectionDetailPanelProps) {
  const { t } = useTheme();

  // Logical sides, not physical: Android declares supportsRtl, so the rule
  // that ties this panel to the row above it must mirror with the layout
  // rather than staying pinned to the left of a right-aligned column.
  const frame = {
    marginTop: 10,
    marginBottom: 4,
    paddingStart: 12,
    borderStartWidth: 2,
    borderStartColor: t.borderSubtle,
    gap: 8,
  } as const;

  if (!allowed) {
    return (
      <View style={frame}>
        <RoleGateNotice
          title={COLLECTION_DETAIL_GATE.title}
          body={COLLECTION_DETAIL_GATE.body}
        />
      </View>
    );
  }

  if (isError) {
    if (isCollectionRoleDenied(error)) {
      return (
        <View style={frame}>
          <RoleGateNotice
            title={COLLECTION_DETAIL_GATE.title}
            body={COLLECTION_DETAIL_GATE.body}
            live
          />
        </View>
      );
    }
    if (isNotFound(error)) {
      return (
        <View style={frame}>
          <ErrorState message="This collection is no longer in this workspace — it was removed after the list was loaded. Pull to refresh." />
        </View>
      );
    }
    return (
      <View style={frame}>
        <ErrorState error={error} />
      </View>
    );
  }

  if (!online && !detail) {
    return (
      <View style={frame}>
        <ErrorState message="Rows are read live and are never stored on this device. Reconnect to open this collection." />
      </View>
    );
  }

  if (isLoading || !detail) {
    return (
      <View style={frame}>
        <SkeletonList rows={3} lines={3} label="Loading collection rows" />
      </View>
    );
  }

  const preview = detail.rows.slice(0, COLLECTION_ROW_PREVIEW_LIMIT);
  const columns = collectionColumns(preview);
  const previewNote = collectionRowPreviewNote(preview.length, detail.rowCount);
  const columnNote = collectionColumnNote(columns);
  const sanitized = previewWasSanitized(preview, columns.names);
  const created = dateTime(detail.createdAt, "");

  return (
    <View style={frame}>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {collectionSourceSentence(detail.sourceType)}
        {created ? ` · created ${created}` : ""}
      </Text>

      {detail.rows.length === 0 ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          This collection exists but holds no rows. That is a real state, not a
          failed read — anything referencing it will find nothing.
        </Text>
      ) : (
        <CollectionRowsTable rows={preview} columns={columns} />
      )}

      {previewNote ? <PanelNote text={previewNote} /> : null}
      {columnNote ? <PanelNote text={columnNote} /> : null}
      {sanitized ? (
        <PanelNote text="Some values contained text-direction characters, which were removed so they could not reorder what you are reading." />
      ) : null}
    </View>
  );
}

function PanelNote({ text }: { text: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
      }}
    >
      {text}
    </Text>
  );
}

/** 404 from the detail route: the collection is gone for this tenant. */
function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { status?: unknown }).status === 404;
}
