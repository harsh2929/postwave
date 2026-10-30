/**
 * DataExportsSection — workspace data exports on a phone.
 *
 * Mobile could fire a privacy/DSAR request and nothing else; the tenant-export
 * subsystem (GET/POST /api/v1/exports, with a signed 24h download URL) had no
 * mobile client at all. That is the wrong way round: a signed URL is MORE
 * useful on a phone than on a desktop, because the OS can hand it straight to
 * Files, Safari or the share sheet.
 *
 * Two things this gets right that the naive version wouldn't:
 *
 *  - A ready row whose signed URL has already lapsed does not render a
 *    download affordance. Tapping it would 403 with no explanation. The
 *    ordering (expired beats ready) lives in src/lib/exportRows.ts and is
 *    tested there.
 *  - A `file://` download URL — what a self-hosted filesystem-storage
 *    deployment writes — is not offered to Linking either.
 *
 * WATCHING A QUEUED EXPORT. The bundle is built by a background worker, so the
 * row a user creates is `queued` for as long as it takes. The section used to
 * fire one refetch immediately after the POST — which by construction still
 * reads `queued` — and then nothing: the row sat there claiming to be building
 * long after it was downloadable, and only a pull-to-refresh or a re-entry
 * corrected it. GET /api/v1/exports/{id} is the point read that exists for
 * exactly this, and it now polls the OLDEST-visible pending row (which covers
 * re-entering the screen while one is still building, not only the one this
 * session queued) and stops the moment it settles.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";

import {
  getTenantExport,
  listTenantExports,
  requestTenantExport,
} from "@/api/exports";
import { Pill } from "@/components/Pill";
import { QueryStates } from "@/components/QueryStates";
import { ExportRetentionCard } from "@/components/settings/ExportRetentionCard";
import { Card } from "@/components/settings/SettingsScreenPrimitives";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { FONT } from "@/lib/fonts";
import { bytes, num, relativeTime } from "@/lib/format";
import {
  exportDownloadState,
  exportStateLabel,
  exportStatusTone,
  isOpenableDownloadUrl,
  summarizeInclude,
  type TenantExportRow,
} from "@/lib/exportRows";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** Rows shown before the list is expanded. The server returns up to 200. */
const VISIBLE_ROWS = 5;

/**
 * How often to re-read a single still-building export. Slow on purpose: a
 * bundle takes as long as it takes, and this is a point read on a settings
 * screen someone may leave open.
 */
const WATCH_POLL_MS = 8_000;

export function DataExportsSection() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const { toast } = useToast();
  const [requesting, setRequesting] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const exports = useQuery({
    queryKey: ["tenant-exports", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    queryFn: async (): Promise<TenantExportRow[]> => {
      const res = await listTenantExports();
      if (res.error) {
        throw Object.assign(new Error(res.error.message), res.error);
      }
      return res.data?.exports ?? [];
    },
    // Exports are built by a background worker, so the list goes stale on its
    // own schedule; 30s keeps a "queued → ready" transition visible without
    // polling the endpoint on every re-render.
    staleTime: 30_000,
  });

  const rows = Array.isArray(exports.data) ? exports.data : [];

  // The OLDEST still-building row (the list is newest-first), so the one
  // closest to finishing is the one being watched. "" when nothing is pending,
  // which is what disables the watch entirely.
  const pendingId =
    [...rows]
      .reverse()
      .find((row) => exportDownloadState(row).kind === "pending")?.id ?? "";

  const watched = useQuery({
    queryKey: ["tenant-export", gate.tenantId, pendingId],
    enabled: gate.enabled && Boolean(gate.tenantId) && pendingId !== "",
    // A row that is being watched precisely because it is changing must never
    // be served from cache.
    staleTime: 0,
    queryFn: async (): Promise<TenantExportRow | null> => {
      const res = await getTenantExport(pendingId);
      if (res.error) {
        throw Object.assign(new Error(res.error.message), res.error);
      }
      return res.data ?? null;
    },
    // Re-decided after every response, so the poll stops dead the moment the
    // worker finishes rather than running for as long as the screen is open.
    refetchInterval: (query) => {
      const row = query.state.data as TenantExportRow | null | undefined;
      if (!row) return WATCH_POLL_MS;
      return exportDownloadState(row).kind === "pending" ? WATCH_POLL_MS : false;
    },
    refetchIntervalInBackground: false,
  });

  // The list is what this screen renders, so the list is what has to be
  // refreshed when the watched row settles — the point read only decides WHEN.
  const settledId =
    watched.data && exportDownloadState(watched.data).kind !== "pending"
      ? watched.data.id
      : null;
  useEffect(() => {
    if (!settledId) return;
    void exports.refetch();
    // `exports` is a stable query object from the same client; keying the
    // effect on it as well would re-run this on every list response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledId]);

  async function onRequest() {
    if (requesting) return;
    setRequesting(true);
    try {
      const res = await requestTenantExport();
      if (res.error) {
        toast({
          kind: "error",
          message:
            res.error.status === 403
              ? "Only workspace admins can export workspace data."
              : "Couldn't queue the export. Check your connection.",
        });
        return;
      }
      toast({
        kind: "success",
        message: "Export queued. It appears here when the bundle is ready.",
      });
      void exports.refetch();
    } finally {
      setRequesting(false);
    }
  }

  async function onOpen(row: TenantExportRow, url: string) {
    haptics.tap();
    try {
      const opened = await Linking.canOpenURL(url);
      if (!opened) throw new Error("cannot open");
      await Linking.openURL(url);
    } catch {
      toast({
        kind: "error",
        message: `Couldn't open the download for the export from ${relativeTime(row.created_at)}.`,
      });
    }
  }

  return (
    <Card>
      <Pressable
        onPress={() => void onRequest()}
        disabled={requesting}
        accessibilityRole="button"
        accessibilityLabel="Request a new workspace data export"
        accessibilityHint="Queues a downloadable archive of this workspace's data."
        accessibilityState={{ disabled: requesting, busy: requesting }}
        style={{
          minHeight: 44,
          justifyContent: "center",
          alignItems: "center",
          borderRadius: 10,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: t.surface,
          opacity: requesting ? 0.6 : 1,
        }}
      >
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontWeight: "700",
            fontFamily: FONT.bold,
          }}
        >
          {requesting ? "Queuing…" : "Request workspace export"}
        </Text>
      </Pressable>

      <View style={{ marginTop: 12, gap: 10 }}>
        <QueryStates
          query={exports}
          isEmpty={rows.length === 0}
          gate={gate}
          empty={{
            title: "No exports yet",
            description:
              "Request one above. Bundles stay downloadable for 24 hours.",
          }}
          offlineMessage="Reconnect to load workspace exports."
          skeleton={<SkeletonList rows={2} lines={2} label="Loading exports" />}
        >
          {(expanded ? rows : rows.slice(0, VISIBLE_ROWS)).map((row) => (
            <ExportRow key={row.id} row={row} onOpen={onOpen} />
          ))}
          {rows.length > VISIBLE_ROWS ? (
            // The truncated rows are in the SAME array the visible ones came
            // from — the server sends the whole list (LIMIT 200) in one
            // response. Sending the user to the web admin for rows already in
            // memory was not a limitation, it was a slice.
            <Pressable
              onPress={() => {
                haptics.tap();
                setExpanded((prev) => !prev);
              }}
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              accessibilityLabel={
                expanded
                  ? `Show only the ${num(VISIBLE_ROWS)} most recent exports`
                  : `Show ${num(rows.length - VISIBLE_ROWS)} older exports`
              }
              style={{ minHeight: 44, justifyContent: "center" }}
            >
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.accent,
                  ...typeStyle("caption"),
                  fontFamily: FONT.regular,
                }}
              >
                {expanded
                  ? "Show fewer"
                  : `Show ${num(rows.length - VISIBLE_ROWS)} older`}
              </Text>
            </Pressable>
          ) : null}
        </QueryStates>
      </View>
      {/* The policy behind the list: how long bundles are kept, how many may be active. */}
      <ExportRetentionCard />
    </Card>
  );
}

function ExportRow({
  row,
  onOpen,
}: {
  row: TenantExportRow;
  onOpen: (row: TenantExportRow, url: string) => void | Promise<void>;
}) {
  const { t } = useTheme();
  const state = exportDownloadState(row);
  const openable = state.kind === "ready" && isOpenableDownloadUrl(state.url);
  const detail = openable
    ? exportStateLabel(state)
    : state.kind === "ready"
      ? // Ready, live URL, but not something the OS can open — a self-hosted
        // filesystem deployment writes a file:// path here.
        "Download this one from the web admin"
      : exportStateLabel(state);

  const size = row.bytes_total > 0 ? bytes(row.bytes_total) : null;
  const spoken = [
    `Export from ${relativeTime(row.created_at)}`,
    `status ${row.status}`,
    summarizeInclude(row.include),
    size ? `${size}, ${num(row.rows_total)} rows` : null,
    detail,
  ]
    .filter(Boolean)
    .join(". ");

  const body = (
    <>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            flex: 1,
            fontFamily: FONT.regular,
          }}
          numberOfLines={1}
        >
          {summarizeInclude(row.include)}
        </Text>
        {/* Status is never colour-alone: the pill carries the word too. */}
        <Pill label={row.status} tone={exportStatusTone(row.status)} />
      </View>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
        numberOfLines={1}
      >
        {relativeTime(row.created_at)}
        {size ? ` · ${size}` : ""}
        {row.rows_total > 0 ? ` · ${num(row.rows_total)} rows` : ""}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: state.kind === "failed" ? t.danger : t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
        numberOfLines={2}
      >
        {detail}
      </Text>
    </>
  );

  if (!openable || state.kind !== "ready") {
    return (
      <View accessible accessibilityLabel={spoken} style={{ gap: 2 }}>
        {body}
      </View>
    );
  }
  const url = state.url;
  return (
    <Pressable
      onPress={() => void onOpen(row, url)}
      accessibilityRole="link"
      accessibilityLabel={spoken}
      accessibilityHint="Opens the signed download link."
      style={{ minHeight: 44, justifyContent: "center", gap: 2 }}
    >
      {body}
    </Pressable>
  );
}
