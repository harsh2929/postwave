/**
 * TestPayloadsPicker — dropdown of saved test payloads + "Save as
 * new" form. Refined Webhooks final batch.
 *
 * Stateless w.r.t. fetch — reloads from the server on mount + after
 * every CRUD operation so the picker stays current with parallel
 * sessions.
 */

import { type ReactElement, useCallback, useEffect, useState } from "react";

import { type WebhookTestPayload, api } from "../../lib/api-client";
import { ConfirmModal } from "../ConfirmModal";
import { toast } from "../Toast";

interface Props {
  webhookId: string;
  direction: "inbound" | "outbound";
  /** Current body string in the test editor — used as the source
   *  when the user clicks "Save as new". */
  currentBody: string;
  onLoad: (body: unknown) => void;
}

export function TestPayloadsPicker({
  webhookId,
  direction,
  currentBody,
  onLoad,
}: Props): ReactElement {
  const [items, setItems] = useState<WebhookTestPayload[] | null>(null);
  const [savingName, setSavingName] = useState<string>("");
  const [saving, setSaving] = useState(false);
  // Pending delete target. Replaces a native window.confirm() so the
  // destructive prompt matches the rest of the admin surface.
  const [pendingDelete, setPendingDelete] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const refresh = useCallback(() => {
    void (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await (api as any).listWebhookTestPayloads(
        webhookId,
        direction,
      );
      setItems(res?.data?.items ?? []);
    })();
  }, [webhookId, direction]);

  useEffect(refresh, [refresh]);

  const save = async (): Promise<void> => {
    const name = savingName.trim();
    if (!name) {
      toast.error("Give the payload a name first.");
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(currentBody);
    } catch {
      toast.error("Current body isn't valid JSON.");
      return;
    }
    setSaving(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (api as any).createWebhookTestPayload(webhookId, {
      name,
      direction,
      body,
    });
    setSaving(false);
    if (res.error) {
      toast.error(`Save failed: ${res.error.message}`);
      return;
    }
    toast.success(`Saved "${name}"`);
    setSavingName("");
    refresh();
  };

  const remove = (id: string, name: string): void => {
    // Stage for ConfirmModal — confirmRemove() runs the API call.
    setPendingDelete({ id, name });
  };

  const confirmRemove = async (): Promise<void> => {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (api as any).deleteWebhookTestPayload(pendingDelete.id);
    setDeleteBusy(false);
    if (res.error) {
      toast.error(`Delete failed: ${res.error.message}`);
      return;
    }
    setPendingDelete(null);
    refresh();
  };

  const load = (p: WebhookTestPayload): void => {
    onLoad(p.body);
    toast.info(`Loaded "${p.name}"`);
  };

  return (
    <div className="wh-payloads">
      <div className="wh-payloads-list">
        <span className="wh-health-label">Saved payloads</span>
        {!items ? (
          <span className="muted" style={{ fontSize: 11 }}>
            Loading…
          </span>
        ) : items.length === 0 ? (
          <span className="muted" style={{ fontSize: 11 }}>
            None yet. Save the current body below.
          </span>
        ) : (
          items.map((p) => (
            <span key={p.id} className="wh-payload-chip">
              <button
                type="button"
                className="wh-payload-load"
                onClick={() => load(p)}
                aria-label={`Load ${p.name} into the editor`}
              >
                {p.name}
              </button>
              <button
                type="button"
                className="wh-payload-x"
                onClick={() => remove(p.id, p.name)}
                aria-label={`Delete ${p.name}`}
              >
                ✕
              </button>
            </span>
          ))
        )}
      </div>
      <div className="wh-payloads-save">
        <input
          type="text"
          className="input"
          placeholder="Save current body as…"
          value={savingName}
          onChange={(e) => setSavingName(e.target.value)}
          disabled={saving}
          style={{ flex: 1, fontSize: 12 }}
        />
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void save()}
          disabled={saving || savingName.trim() === ""}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {/* Delete-test-payload confirm. Replaces the legacy native confirm()
          so the destructive prompt matches the rest of the admin surface. */}
      <ConfirmModal
        open={pendingDelete !== null}
        title="Delete saved payload?"
        description={
          pendingDelete
            ? `Delete saved payload "${pendingDelete.name}"? It will no longer be selectable from this picker.`
            : ""
        }
        confirmLabel="Delete payload"
        danger
        busy={deleteBusy}
        onConfirm={(): Promise<void> => confirmRemove()}
        onClose={(): void => setPendingDelete(null)}
      />
    </div>
  );
}
