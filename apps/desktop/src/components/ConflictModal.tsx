/**
 * ConflictModal — side-by-side resolver for items the server rejected
 * with HTTP 409/412.
 *
 *   - Keep mine    → reissue with `If-Match: *` (server overwrites).
 *   - Edit & retry → open the QueuedMutationEditor seeded with the
 *                    queued body; on save the edited body is persisted
 *                    to the queued item and then routed through the
 *                    SAME keep-mine path (reissueAsOverwrite reads the
 *                    stored — now edited — body), so the edit replays
 *                    with `If-Match: *` overwrite semantics.
 *   - Keep server  → discard our copy, server version stands.
 *
 * Sits on top of the QueueTray slideover via the existing Modal helper
 * (dialog stack handles Esc nesting). Renders 'Your version' (the body
 * the outbox is holding) next to 'Server version' fetched through the
 * canonical API request layer. If the fetch fails, the modal still
 * renders with just our version so the user can pick a winner.
 */

import { type ReactElement, useEffect, useMemo, useState } from "react";

import { apiRequest } from "../lib/api-client";
import {
  updateOfflineMutation,
  type OfflineMutation,
} from "../lib/offline-store";
import { ConfirmModal } from "./ConfirmModal";
import { Modal, ModalFooter } from "./Modal";
import { QueuedMutationEditor } from "./QueuedMutationEditor";

interface ConflictModalProps {
  open: boolean;
  item: OfflineMutation | null;
  onClose: () => void;
  onKeepMine: (id: string) => void;
  onKeepServer: (id: string) => void;
}

export function ConflictModal({
  open,
  item,
  onClose,
  onKeepMine,
  onKeepServer,
}: ConflictModalProps): ReactElement | null {
  const [serverVersion, setServerVersion] = useState<unknown>(null);
  const [serverVersionTag, setServerVersionTag] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [selectedMineFields, setSelectedMineFields] = useState<Set<string>>(
    new Set(),
  );
  const [confirmOverwrite, setConfirmOverwrite] = useState<
    "mine" | "merge" | null
  >(null);

  useEffect(() => {
    if (!open || !item) return;
    setEditing(false);
    setConfirmOverwrite(null);
    setServerVersion(null);
    setServerVersionTag(null);
    setLoadedAt(null);
    setLoadError(null);
    setLoading(true);
    void apiRequest<unknown>(item.path, { method: "GET", cache: "no-store" })
      .then((result) => {
        if (result.error) {
          setLoadError(result.error.message);
          return;
        }
        setServerVersion(result.data);
        setServerVersionTag(result.serverVersion ?? null);
        setLoadedAt(new Date().toISOString());
        setSelectedMineFields(
          new Set(
            conflictFieldRows(item.body, result.data).map((row) => row.key),
          ),
        );
      })
      .catch(() =>
        setLoadError("The current server version could not be loaded."),
      )
      .finally(() => setLoading(false));
  }, [open, item, reloadToken]);

  const mineText = useMemo(() => safeJson(item?.body), [item?.body]);
  const serverText = useMemo(
    () => (loading ? "Loading…" : safeJson(serverVersion)),
    [loading, serverVersion],
  );
  const fieldRows = useMemo(
    () => conflictFieldRows(item?.body, serverVersion),
    [item?.body, serverVersion],
  );

  if (!open || !item) return null;
  return (
    <>
      {/* The resolver hides (rather than stacks) while the editor is
       * open — two simultaneous Modals would fight over the focus
       * trap. Cancelling the editor brings the resolver back. */}
      {!editing && !confirmOverwrite ? (
        <Modal
          open={open}
          onClose={onClose}
          title="Resolve conflict"
          description={`${item.actionLabel ?? "Queued change"} · ${item.recordLabel ?? "record"}`}
        >
          <p className="muted">
            The server changed after this local edit was saved. Review the
            freshest server copy before choosing which fields to overwrite.
          </p>
          {loadError ? (
            <div className="notice notice-danger" role="alert">
              <strong>Server copy unavailable</strong>
              <div>{loadError}</div>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setReloadToken((value) => value + 1)}
              >
                Retry loading server copy
              </button>
            </div>
          ) : null}
          {loadedAt ? (
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              Server copy checked {new Date(loadedAt).toLocaleTimeString()}
              {serverVersionTag ? ` · version ${serverVersionTag}` : ""}
            </div>
          ) : null}
          {fieldRows.length > 0 && !loading && !loadError ? (
            <div className="conflict-field-table-wrap">
              <table className="conflict-field-table">
                <caption>
                  Fields that differ between this device and the server
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Use mine</th>
                    <th scope="col">Field</th>
                    <th scope="col">Your value</th>
                    <th scope="col">Server value</th>
                  </tr>
                </thead>
                <tbody>
                  {fieldRows.map((row) => (
                    <tr key={row.key}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedMineFields.has(row.key)}
                          aria-label={`Keep your value for ${row.key}`}
                          onChange={(event) => {
                            setSelectedMineFields((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(row.key);
                              else next.delete(row.key);
                              return next;
                            });
                          }}
                        />
                      </td>
                      <th scope="row">
                        <code>{row.key}</code>
                      </th>
                      <td>
                        <code>{row.mine}</code>
                      </td>
                      <td>
                        <code>{row.server}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="conflict-cols">
              <div className="conflict-col">
                <div className="conflict-col-head">Your version</div>
                <pre className="conflict-col-body">{mineText}</pre>
              </div>
              <div className="conflict-col">
                <div className="conflict-col-head">Server version</div>
                <pre className="conflict-col-body">{serverText}</pre>
              </div>
            </div>
          )}
          <ModalFooter>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setEditing(true)}
            >
              Edit &amp; retry
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => onKeepServer(item.id)}
            >
              Discard mine · keep server
            </button>
            {fieldRows.length > 0 ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={loading || !!loadError}
                onClick={() => setConfirmOverwrite("merge")}
              >
                Retry selected merge
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary"
              disabled={loading || !!loadError}
              onClick={() => setConfirmOverwrite("mine")}
            >
              Overwrite with mine
            </button>
          </ModalFooter>
        </Modal>
      ) : null}
      <QueuedMutationEditor
        open={editing}
        item={item}
        onClose={() => setEditing(false)}
        onSaved={(id) => {
          setEditing(false);
          // The editor has already persisted the edited body to the
          // queued item. Route through the existing keep-mine path:
          // reissueAsOverwrite reads the stored (edited) body and
          // re-queues it with `If-Match: *`, so the edit is what
          // replays.
          onKeepMine(id);
        }}
      />
      <ConfirmModal
        open={confirmOverwrite !== null}
        title={
          confirmOverwrite === "merge"
            ? "Overwrite server with selected merge?"
            : "Overwrite server with your local version?"
        }
        description="This bypasses the stale version check and writes a new server version. Other users may have changed the same fields."
        confirmLabel="Overwrite and retry"
        danger
        onClose={() => setConfirmOverwrite(null)}
        onConfirm={() => {
          if (confirmOverwrite === "merge") {
            updateOfflineMutation(item.id, {
              body: mergeConflictFields(
                item.body,
                serverVersion,
                selectedMineFields,
              ),
            });
          }
          setConfirmOverwrite(null);
          onKeepMine(item.id);
        }}
      >
        Review the selected fields and server freshness above before continuing.
        The retry remains in the sync journal until the server confirms it.
      </ConfirmModal>
    </>
  );
}

function safeJson(value: unknown): string {
  if (value === undefined || value === null) return "(no body)";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

interface ConflictFieldRow {
  key: string;
  mine: string;
  server: string;
}

export function conflictFieldRows(
  mine: unknown,
  server: unknown,
): ConflictFieldRow[] {
  if (!isRecord(mine) || !isRecord(server)) return [];
  const keys = new Set([...Object.keys(mine), ...Object.keys(server)]);
  return [...keys]
    .sort((a, b) => a.localeCompare(b))
    .filter((key) => safeJson(mine[key]) !== safeJson(server[key]))
    .map((key) => ({
      key,
      mine: safeJson(mine[key]),
      server: safeJson(server[key]),
    }));
}

export function mergeConflictFields(
  mine: unknown,
  server: unknown,
  selectedMineFields: ReadonlySet<string>,
): unknown {
  if (!isRecord(mine) || !isRecord(server)) return mine;
  const merged: Record<string, unknown> = { ...server };
  for (const key of selectedMineFields) {
    if (Object.prototype.hasOwnProperty.call(mine, key))
      merged[key] = mine[key];
    else delete merged[key];
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
