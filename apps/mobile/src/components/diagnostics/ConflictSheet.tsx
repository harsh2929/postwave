/**
 * ConflictSheet — resolve a queued write the server refused (P2.56).
 *
 * Desktop's ConflictModal shows "your version" beside the fetched server
 * copy and lets the person keep theirs (re-issued with `If-Match: *`), keep
 * the server's, or mix per field. Mobile's queued writes carry no
 * precondition and this server refuses the wildcard (lib/offlineConflict
 * header), so "keep mine" here is the same unconditional write sent again —
 * last writer wins, exactly as the original would have — and the sheet's
 * real job is the VERDICT: a plain 409/412 compares fields; a name/slug
 * collision routes to the editor because a verbatim retry fails the same
 * way; a campaign that started sending is locked on every device; a
 * sequence save and a 428 send the person to the record's own screen.
 *
 * The server copy is read through api/queuedWriteConflict only for the
 * routes the manifest mounts (serverCopyPath). Without one — no read route,
 * offline, a failed read — the sheet still renders with your version so a
 * winner can be chosen, which is desktop's behaviour too.
 *
 * NativeWind v4 gotcha: STATIC Pressable styles only.
 */
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { fetchServerCopy } from "@/api/queuedWriteConflict";
import type { AIApiResult } from "@/api/request";
import { useConfirm } from "@/components/ConfirmSheet";
import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import {
  SheetButton,
  SheetGroup,
  SheetHeader,
  SheetNote,
} from "@/components/settings/platform-config/PlatformConfigPrimitives";
import { useToast } from "@/components/Toast";
import { useIsOnline } from "@/hooks/useIsOnline";
import type { QueuedWriteReissue } from "@/hooks/useQueuedWriteDetails";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  conflictFieldRows,
  conflictVerdict,
  mergeConflictFields,
  recordHrefForQueuedPath,
  serverCopyPath,
  unwrapServerCopy,
  type ConflictVerdict,
} from "@/lib/offlineConflict";
import type { QueuedWriteDetail } from "@/lib/queuedWriteDetail";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

type CopyState =
  | { kind: "loading" }
  | { kind: "loaded"; server: unknown }
  | { kind: "error"; message: string }
  | { kind: "unreadable" };

export const NO_READ_ROUTE_NOTE =
  "This record can't be read back on the phone, so only your version is shown. You can still keep it or take the server's.";
export const OFFLINE_COPY_NOTE =
  "You're offline, so the server's current copy can't be loaded. Keeping yours queues it for when you're back online.";
export const KEEP_SERVER_TOAST = "Discarded your version. Server copy retained.";

export function keepMineConsequence(kept: number): string {
  return `This replaces the server's copy of ${kept} field${kept === 1 ? "" : "s"}.`;
}

export function ConflictSheet({
  visible,
  detail,
  onClose,
  onKeepMine,
  onKeepServer,
  onEdit,
  fetchCopy = fetchServerCopy,
}: {
  visible: boolean;
  detail: QueuedWriteDetail | null;
  onClose: () => void;
  /** Re-issue the write carrying `body` (all mine, or a per-field mix). */
  onKeepMine: (detail: QueuedWriteDetail, body: unknown) => QueuedWriteReissue;
  /** Drop the queued write; the caller offers the undo. */
  onKeepServer: (detail: QueuedWriteDetail) => void;
  onEdit: (detail: QueuedWriteDetail) => void;
  fetchCopy?: (path: string) => Promise<AIApiResult<unknown>>;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const online = useIsOnline();
  const [copy, setCopy] = useState<CopyState>({ kind: "unreadable" });
  const [keepMine, setKeepMine] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const verdict: ConflictVerdict | null = useMemo(() => {
    if (!detail) return null;
    return conflictVerdict({
      status: detail.failure?.status ?? 0,
      code: detail.failure?.code ?? null,
      kind: detail.kind,
      ...(detail.failure?.message ? { serverMessage: detail.failure.message } : {}),
    });
  }, [detail]);

  useEffect(() => {
    if (!visible || !detail) return;
    setError(null);
    const mine = conflictFieldRows(detail.body, null).map((row) => row.key);
    setKeepMine(new Set(mine));
    const path = serverCopyPath(detail);
    if (!path || !verdict?.canKeepMine) {
      setCopy({ kind: "unreadable" });
      return;
    }
    if (!online) {
      setCopy({ kind: "error", message: OFFLINE_COPY_NOTE });
      return;
    }
    let live = true;
    setCopy({ kind: "loading" });
    void fetchCopy(path)
      .then((result) => {
        if (!live) return;
        if (result.error) {
          setCopy({ kind: "error", message: result.error.message });
          return;
        }
        setCopy({ kind: "loaded", server: unwrapServerCopy(result.data) });
      })
      .catch(() => {
        if (live) {
          setCopy({
            kind: "error",
            message: "The current server version could not be loaded.",
          });
        }
      });
    return () => {
      live = false;
    };
  }, [visible, detail, verdict?.canKeepMine, online, fetchCopy]);

  const server = copy.kind === "loaded" ? copy.server : null;
  const rows = useMemo(
    () => (detail ? conflictFieldRows(detail.body, server) : []),
    [detail, server],
  );
  const loaded = copy.kind === "loaded";
  const keptCount = rows.filter((row) => keepMine.has(row.key)).length;
  const allMine = keptCount === rows.length;

  const toggle = useCallback((key: string) => {
    setKeepMine((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const keepMineNow = useCallback(async () => {
    if (!detail) return;
    const body = loaded
      ? mergeConflictFields(detail.body, server, keepMine)
      : detail.body;
    const ok = await confirm({
      title: allMine ? "Keep your version?" : "Send the mixed fields?",
      message: allMine
        ? "Your queued values replace the server's for every field below."
        : "Fields you kept use your values; the rest take the server's current values.",
      consequence: keepMineConsequence(loaded ? keptCount : rows.length),
      // Never the same label as the sheet button that opened this confirm.
      confirmLabel: allMine ? "Replace server fields" : "Send these fields",
      destructive: true,
    });
    if (!ok) return;
    const result = onKeepMine(detail, body);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    haptics.success();
    toast({
      kind: "success",
      message: online
        ? "Your version is being sent now."
        : "Your version is queued for when you're back online.",
    });
    onClose();
  }, [allMine, confirm, detail, keepMine, keptCount, loaded, onClose, onKeepMine, online, rows.length, server, toast]);

  const keepServer = useCallback(() => {
    if (!detail) return;
    onKeepServer(detail);
    onClose();
  }, [detail, onClose, onKeepServer]);

  if (!detail || !verdict) return null;
  const href = recordHrefForQueuedPath(detail.path);
  const openLabel =
    verdict.kind === "reload-required" ? "Open the sequence" : "Open the record";

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel={`Resolve conflict: ${detail.label}`}
    >
      <SheetHeader
        title={verdict.headline}
        subtitle={`${detail.label} · ${detail.method} ${detail.path}`}
        onClose={onClose}
        closeLabel="Close conflict"
      />
      <SheetNote>{verdict.detail}</SheetNote>
      {copy.kind === "loading" ? <SheetNote>Loading the server&apos;s current copy…</SheetNote> : null}
      {copy.kind === "error" ? <SheetNote tone="warning">{copy.message}</SheetNote> : null}
      {copy.kind === "unreadable" && verdict.canKeepMine ? (
        <SheetNote tone="warning">{NO_READ_ROUTE_NOTE}</SheetNote>
      ) : null}

      {verdict.canKeepMine && rows.length > 0 ? (
        <SheetGroup title="Your version vs the server's">
          {rows.map((row) => {
            const mine = keepMine.has(row.key);
            const canToggle = loaded && row.serverHas;
            return (
              <View key={row.key} style={{ paddingVertical: 6, gap: 4 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text
                    {...typeCap("label")}
                    style={{ color: t.fg, ...typeStyle("label"), flex: 1, fontFamily: FONT.semibold }}
                  >
                    {row.key}
                    {row.differs ? "" : " · same"}
                  </Text>
                  {canToggle ? (
                    <Pressable
                      onPress={() => toggle(row.key)}
                      accessibilityRole="switch"
                      accessibilityLabel={`Keep my ${row.key}`}
                      accessibilityState={{ checked: mine }}
                      hitSlop={8}
                      style={{
                        minHeight: 44,
                        justifyContent: "center",
                        paddingHorizontal: 10,
                        borderRadius: 10,
                        borderWidth: 1,
                        borderColor: mine ? t.accent : t.border,
                      }}
                    >
                      <Text
                        {...typeCap("control")}
                        style={{
                          color: mine ? t.accent : t.fgMuted,
                          ...typeStyle("control"),
                          fontFamily: FONT.semibold,
                        }}
                      >
                        {mine ? "Keeping mine" : "Using server's"}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
                <Text
                  selectable
                  {...typeCap("mono")}
                  style={{ color: t.fg, ...typeStyle("mono"), fontFamily: FONT.regular }}
                >
                  Mine: {row.mine}
                </Text>
                <Text
                  selectable
                  {...typeCap("mono")}
                  style={{ color: t.fgMuted, ...typeStyle("mono"), fontFamily: FONT.regular }}
                >
                  Server: {loaded ? row.server : "(unavailable)"}
                </Text>
              </View>
            );
          })}
        </SheetGroup>
      ) : null}

      {error ? <SheetNote tone="danger">{error}</SheetNote> : null}

      <View style={{ flexDirection: "row", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
        {verdict.canKeepMine ? (
          <SheetButton
            label={allMine || !loaded ? "Keep mine" : "Send selection"}
            tone="primary"
            disabled={copy.kind === "loading" || (loaded && keptCount === 0)}
            accessibilityHint="Sends your values again; the server applies the newest write"
            onPress={() => void keepMineNow()}
          />
        ) : null}
        {verdict.canEdit && detail.editable ? (
          <SheetButton
            label="Edit instead"
            tone="neutral"
            onPress={() => {
              onEdit(detail);
            }}
          />
        ) : null}
        {!verdict.canKeepMine && href ? (
          <SheetButton
            label={openLabel}
            tone="neutral"
            onPress={() => {
              onClose();
              router.push(href as never);
            }}
          />
        ) : null}
        <SheetButton label="Keep server" tone="danger" onPress={keepServer} />
      </View>
    </KeyboardFormSheet>
  );
}
