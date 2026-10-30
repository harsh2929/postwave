/**
 * QueuedWriteTools — the per-row verbs and the two sheets the offline queue
 * gained (parity register: P2.56 conflict resolution + the shell-crosscutting
 * "offline outbox depth" row). Kept beside OfflineQueueSection rather than in
 * it so that file stays under its source budget; the section calls
 * `useQueuedWriteTools`, drops `actionsFor(operationId)` into each row and
 * renders `sheets` once.
 *
 * Verbs, mirroring desktop's QueueTray rows:
 *   Details  — every write the cache still holds (verb, path, body, failure).
 *   Edit     — an editable write that is not on the wire.
 *   Resolve  — a failed write whose error is a conflict (409/412/428, or the
 *              sequence reload code).
 *
 * The undo on a discard is `restore`: the write goes back exactly as it was.
 *
 * NativeWind v4 gotcha: STATIC Pressable styles only.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

import { ConflictSheet, KEEP_SERVER_TOAST } from "@/components/diagnostics/ConflictSheet";
import { QueuedWriteSheet } from "@/components/diagnostics/QueuedWriteSheet";
import { useToast } from "@/components/Toast";
import { useQueuedWriteDetails } from "@/hooks/useQueuedWriteDetails";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { isConflictFailure } from "@/lib/offlineConflict";
import type { QueuedWriteDetail } from "@/lib/queuedWriteDetail";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

type OpenSheet =
  | { kind: "detail"; detail: QueuedWriteDetail; editing: boolean }
  | { kind: "conflict"; detail: QueuedWriteDetail };

export interface QueuedWriteTools {
  detailFor: (operationId: string) => QueuedWriteDetail | null;
  actionsFor: (operationId: string) => ReactNode;
  sheets: ReactNode;
  /** Discard with an Undo toast; false when the write is on the wire. */
  discardWithUndo: (detail: QueuedWriteDetail, message?: string) => boolean;
}

export const DISCARDED_TOAST = "Change discarded.";

export function useQueuedWriteTools(
  refresh: () => void | Promise<void>,
  resolveOperationId: string | null,
): QueuedWriteTools {
  const { toast } = useToast();
  const tools = useQueuedWriteDetails();
  const [open, setOpen] = useState<OpenSheet | null>(null);
  const autoOpened = useRef<string | null>(null);

  // Arriving from the banner with `?resolve=<operationId>`: open the resolver
  // for that write once it is in the list, once.
  useEffect(() => {
    if (!resolveOperationId || autoOpened.current === resolveOperationId) return;
    const detail = tools.detailFor(resolveOperationId);
    if (!detail) return;
    autoOpened.current = resolveOperationId;
    setOpen(
      detail.failure && isConflictFailure(detail.failure)
        ? { kind: "conflict", detail }
        : { kind: "detail", detail, editing: false },
    );
  }, [resolveOperationId, tools]);

  const close = useCallback(() => setOpen(null), []);

  const discardWithUndo = useCallback(
    (detail: QueuedWriteDetail, message = DISCARDED_TOAST) => {
      const removed = tools.discard(detail);
      if (!removed) {
        toast({ kind: "error", message: "That change is being sent right now." });
        return false;
      }
      haptics.success();
      toast({
        kind: "success",
        message,
        action: {
          label: "Undo",
          onPress: () => {
            tools.restore(detail);
            toast({ kind: "info", message: "Change restored to the queue." });
            void refresh();
          },
        },
      });
      void refresh();
      return true;
    },
    [refresh, toast, tools],
  );

  const actionsFor = useCallback(
    (operationId: string): ReactNode => {
      const detail = tools.detailFor(operationId);
      if (!detail) return null;
      const conflict = Boolean(detail.failure && isConflictFailure(detail.failure));
      return (
        <QueuedWriteActions
          label={detail.label}
          showEdit={detail.editable && detail.status !== "syncing"}
          showResolve={conflict}
          onDetails={() => setOpen({ kind: "detail", detail, editing: false })}
          onEdit={() => setOpen({ kind: "detail", detail, editing: true })}
          onResolve={() => setOpen({ kind: "conflict", detail })}
        />
      );
    },
    [tools],
  );

  const sheets = useMemo(
    () => (
      <>
        <QueuedWriteSheet
          visible={open?.kind === "detail"}
          detail={open?.kind === "detail" ? open.detail : null}
          startEditing={open?.kind === "detail" ? open.editing : false}
          onClose={close}
          onReissue={(detail, body) => {
            const result = tools.reissue(detail, body);
            if (result.ok) void refresh();
            return result;
          }}
          onRetry={(detail) => {
            const result = tools.retry(detail);
            if (result.ok) void refresh();
            return result;
          }}
          onDiscard={(detail) => {
            discardWithUndo(detail);
          }}
        />
        <ConflictSheet
          visible={open?.kind === "conflict"}
          detail={open?.kind === "conflict" ? open.detail : null}
          onClose={close}
          onKeepMine={(detail, body) => {
            const result = tools.reissue(detail, body);
            if (result.ok) void refresh();
            return result;
          }}
          onKeepServer={(detail) => {
            discardWithUndo(detail, KEEP_SERVER_TOAST);
          }}
          onEdit={(detail) => setOpen({ kind: "detail", detail, editing: true })}
        />
      </>
    ),
    [close, discardWithUndo, open, refresh, tools],
  );

  return useMemo(
    () => ({ detailFor: tools.detailFor, actionsFor, sheets, discardWithUndo }),
    [tools.detailFor, actionsFor, sheets, discardWithUndo],
  );
}

function QueuedWriteActions({
  label,
  showEdit,
  showResolve,
  onDetails,
  onEdit,
  onResolve,
}: {
  label: string;
  showEdit: boolean;
  showResolve: boolean;
  onDetails: () => void;
  onEdit: () => void;
  onResolve: () => void;
}) {
  return (
    <View style={{ flexDirection: "row", gap: 16, flexWrap: "wrap" }}>
      {showResolve ? (
        <ActionLink label="Resolve" spoken={`Resolve conflict for ${label}`} onPress={onResolve} accent />
      ) : null}
      {showEdit ? (
        <ActionLink label="Edit" spoken={`Edit ${label}`} onPress={onEdit} />
      ) : null}
      <ActionLink label="Details" spoken={`Details of ${label}`} onPress={onDetails} />
    </View>
  );
}

function ActionLink({
  label,
  spoken,
  onPress,
  accent = false,
}: {
  label: string;
  spoken: string;
  onPress: () => void;
  accent?: boolean;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={spoken}
      hitSlop={8}
      style={{ minHeight: 44, justifyContent: "center" }}
    >
      <Text
        {...typeCap("control")}
        style={{
          color: accent ? t.accent : t.fg,
          ...typeStyle("control"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
