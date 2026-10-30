/**
 * DataExportsSection — Settings "Data" area wiring #34
 * (POST/GET /api/v1/exports, GET /api/v1/exports/{id}).
 *
 * Pairs with the existing ExportRetentionSection in Settings.tsx
 * (the already-wired retention-policy GET/PATCH controls) — this
 * section covers creating bundles and tracking/downloading them.
 *
 * Lifecycle is queued → running → ready | failed (server worker);
 * download_url is a signed 24h URL only present once ready. We never
 * fake progress — status comes from a manual/refreshed GET.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  lifecycleOperationError,
  useDiscardOnlyDraftLifecycle,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import { type TenantExportRow, exportsApi } from "../../lib/api-client";
import { useCanAdmin } from "../../lib/store";
import { ConfirmModal } from "../ConfirmModal";
import { toast } from "../Toast";
import { SettingsSectionHeader } from "./SettingsNav";
import {
  EXPORT_INCLUDE_OPTIONS,
  exportStatusTone,
  fmtExportBytes,
  isDownloadExpired,
  isDownloadReady,
  summarizeInclude,
} from "./exports-helpers";

const DEFAULT_EXPORT_INCLUDE_KEYS = EXPORT_INCLUDE_OPTIONS.map(
  (option) => option.key,
);

export function DataExportsSection(): ReactElement | null {
  const canAdmin = useCanAdmin();
  const [rows, setRows] = useState<TenantExportRow[] | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState<boolean>(false);
  const [exportingAll, setExportingAll] = useState<boolean>(false);
  const [showCreate, setShowCreate] = useState<boolean>(false);
  const [include, setInclude] = useState<Set<string>>(
    () => new Set(DEFAULT_EXPORT_INCLUDE_KEYS),
  );
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const activeRef = useRef(true);
  const operation = useSingleFlightOperation({
    ownerId: "data-export",
    label: "Data export request",
  });

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      const res = await exportsApi.list();
      if (!activeRef.current) return;
      if (res.error) {
        setErr(res.error.message);
        setRows(null);
      } else {
        setRows(res.data?.exports ?? []);
      }
    } catch (loadError) {
      if (activeRef.current) {
        setErr(
          lifecycleOperationError(loadError, "Exports couldn't be loaded."),
        );
        setRows(null);
      }
    } finally {
      if (activeRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    activeRef.current = true;
    if (canAdmin) void load();
    return () => {
      activeRef.current = false;
    };
  }, [canAdmin, load]);

  const draftDirty =
    showCreate &&
    (include.size !== DEFAULT_EXPORT_INCLUDE_KEYS.length ||
      DEFAULT_EXPORT_INCLUDE_KEYS.some((key) => !include.has(key)));
  const discardCreateDraft = useCallback((): void => {
    setInclude(new Set(DEFAULT_EXPORT_INCLUDE_KEYS));
    setShowCreate(false);
    setDiscardConfirmOpen(false);
  }, []);
  const requestCreateClose = useCallback((): void => {
    if (operation.promiseRef.current) return;
    if (draftDirty) setDiscardConfirmOpen(true);
    else discardCreateDraft();
  }, [discardCreateDraft, draftDirty, operation.promiseRef]);

  useDiscardOnlyDraftLifecycle({
    ownerId: "data-export-create",
    label: "Data export selection",
    dirty: draftDirty,
    operationRef: operation.promiseRef,
    discard: discardCreateDraft,
    detail:
      "This export selection is local. Return to it or explicitly discard it; Moosewave will never queue an export during lifecycle Save.",
    operationDetail:
      "Wait for the export request to be accepted before leaving Moosewave.",
  });

  // Admin-only (the routes are admin-scoped server-side too).
  if (!canAdmin) return null;

  const toggleInclude = (key: string): void => {
    setInclude((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const onCreate = async (): Promise<void> => {
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    if (include.size === 0) {
      toast.error("Pick at least one resource to export.");
      return;
    }
    setCreating(true);
    const request = operation.run(async (): Promise<void> => {
      try {
        const res = await exportsApi.create([...include]);
        if (!activeRef.current) return;
        if (res.error) {
          toast.error({
            message: "Couldn't queue export",
            detail: res.error.message,
          });
          return;
        }
        toast.success({
          message: "Export queued",
          detail: `Bundle ${res.data?.id ?? ""} is building — refresh to track status.`,
        });
        discardCreateDraft();
        await load();
      } catch (createError) {
        if (activeRef.current) {
          toast.error({
            message: "Couldn't queue export",
            detail: lifecycleOperationError(
              createError,
              "The export request failed before it was accepted.",
            ),
          });
        }
      } finally {
        if (activeRef.current) setCreating(false);
      }
    });
    if (request) await request;
  };

  /**
   * "Export everything" — the zero-lock-in one-click path. Sending an
   * empty include array tells the server to bundle EVERY supported
   * resource (subscribers, campaigns, automations, audit_log, lists,
   * tags, events, templates, segments, forms, suppressions, consent), so
   * the operator walks away with their whole account. Additive to the
   * per-resource picker below — it doesn't replace it.
   */
  const onExportEverything = async (): Promise<void> => {
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    setExportingAll(true);
    const request = operation.run(async (): Promise<void> => {
      try {
        const res = await exportsApi.create([]);
        if (!activeRef.current) return;
        if (res.error) {
          toast.error({
            message: "Couldn't queue full export",
            detail: res.error.message,
          });
          return;
        }
        toast.success({
          message: "Full account export queued",
          detail: `Bundle ${res.data?.id ?? ""} is building every supported resource — refresh to track status.`,
        });
        await load();
      } catch (createError) {
        if (activeRef.current) {
          toast.error({
            message: "Couldn't queue full export",
            detail: lifecycleOperationError(
              createError,
              "The full-export request failed before it was accepted.",
            ),
          });
        }
      } finally {
        if (activeRef.current) setExportingAll(false);
      }
    });
    if (request) await request;
  };

  return (
    <div className="settings-section">
      <SettingsSectionHeader
        title="Data exports"
        description="Build a ZIP bundle of workspace data (JSONL per resource). Each newly completed export receives the availability deadline configured by the export-retention policy above."
        meta={
          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void load()}
              disabled={loading}
            >
              Refresh
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                if (showCreate) requestCreateClose();
                else setShowCreate(true);
              }}
              disabled={operation.active}
            >
              {showCreate ? "Cancel" : "+ New export"}
            </button>
          </div>
        }
      />
      <div className="settings-section-body">
        <ExportEverythingCard
          busy={operation.active}
          queueing={exportingAll}
          onQueue={onExportEverything}
        />

        {showCreate ? (
          <div className="card" style={{ padding: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              Include in the bundle
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 6,
              }}
            >
              {EXPORT_INCLUDE_OPTIONS.map((o) => (
                <label
                  key={o.key}
                  className="radio-row"
                  style={{ gap: 8, fontSize: 13 }}
                >
                  <input
                    type="checkbox"
                    checked={include.has(o.key)}
                    onChange={() => toggleInclude(o.key)}
                    disabled={operation.active}
                  />
                  <span>
                    {o.label}
                    <span className="muted" style={{ fontSize: 11 }}>
                      {" "}
                      — {o.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => void onCreate()}
                disabled={operation.active || include.size === 0}
              >
                {creating ? "Queueing…" : "Queue export"}
              </button>
            </div>
          </div>
        ) : null}

        {err ? (
          <div className="notice">
            <span>Couldn&apos;t load exports: {err}</span>
            <span className="spacer" />
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void load()}
              disabled={loading}
            >
              Retry
            </button>
          </div>
        ) : loading ? (
          <>
            <div className="skel-row" />
            <div className="skel-row" />
          </>
        ) : (rows ?? []).length === 0 ? (
          <div className="muted" style={{ fontSize: 12 }}>
            No exports yet. Queue one to get a downloadable ZIP of your
            workspace data.
          </div>
        ) : (
          <div>
            {(rows ?? []).map((r) => (
              <ExportRow key={r.id} row={r} />
            ))}
          </div>
        )}
      </div>
      <ConfirmModal
        open={discardConfirmOpen}
        title="Discard export selection?"
        description="Your resource selection has not been queued. Discarding resets the picker to all resources."
        confirmLabel="Discard selection"
        danger
        busy={operation.active}
        onConfirm={discardCreateDraft}
        onClose={() => {
          if (!operation.active) setDiscardConfirmOpen(false);
        }}
      />
    </div>
  );
}

function ExportEverythingCard({
  busy,
  queueing,
  onQueue,
}: {
  busy: boolean;
  queueing: boolean;
  onQueue: () => Promise<void>;
}): ReactElement {
  return (
    <div
      className="card"
      style={{
        padding: 12,
        marginBottom: 12,
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div style={{ flex: 1, minWidth: 220 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
          Export everything — no lock-in
        </div>
        <div
          id="workspace-export-description"
          className="muted"
          style={{ fontSize: 12 }}
        >
          One click bundles your entire account: subscribers, campaigns,
          automations, audit log, lists, tags, events, templates, segments,
          forms, suppressions, and consent records. You get a portable ZIP of
          JSONL files (one per resource). Its availability deadline is assigned
          from the tenant export-retention policy when the bundle completes.
        </div>
      </div>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => void onQueue()}
        disabled={busy}
        aria-describedby="workspace-export-description"
      >
        {queueing ? "Queueing…" : "Export everything"}
      </button>
    </div>
  );
}

function ExportRow({ row }: { row: TenantExportRow }): ReactElement {
  const ready = isDownloadReady(row);
  const expired = isDownloadExpired(row);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 0",
        borderBottom: "1px solid var(--pw-border-soft)",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13 }}>
          {summarizeInclude(row.include ?? [])}
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          {(() => {
            const d = new Date(row.created_at ?? "");
            return Number.isFinite(d.getTime())
              ? d.toLocaleString()
              : (row.created_at ?? "—");
          })()}
          {row.rows_total > 0 ? ` · ${row.rows_total} rows` : ""}
          {row.bytes_total > 0 ? ` · ${fmtExportBytes(row.bytes_total)}` : ""}
          {row.requested_by_email ? ` · by ${row.requested_by_email}` : ""}
        </div>
        {row.status === "failed" && row.error ? (
          <div
            className="muted"
            style={{ fontSize: 11, color: "var(--pw-danger)" }}
          >
            {row.error}
          </div>
        ) : null}
      </div>
      <span className={`badge ${exportStatusTone(row.status)}`}>
        {row.status}
      </span>
      {ready ? (
        expired ? (
          <span className="muted" style={{ fontSize: 11 }}>
            link expired
          </span>
        ) : (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              if (!row.download_url) return;
              void import("../../lib/file-transfer").then(
                ({ downloadUrlToFile }) =>
                  downloadUrlToFile({
                    url: row.download_url!,
                    suggestedName: `workspace-export-${row.id}.zip`,
                    label: "Workspace data export",
                    privacy: "confidential",
                    mimeType: "application/zip",
                  }).then((saved) => {
                    if (!saved.ok) toast.error(saved.message);
                  }),
              );
            }}
            aria-label={
              row.expires_at
                ? `Download export bundle. Signed link valid until ${new Date(row.expires_at).toLocaleString()}`
                : "Download export bundle"
            }
          >
            Download
          </button>
        )
      ) : null}
    </div>
  );
}
