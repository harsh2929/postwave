import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  type InboundTrigger,
  deleteInboundTrigger,
  listInboundTriggers,
  updateInboundTrigger,
} from "../../lib/api-client";
import { ConfirmModal } from "../ConfirmModal";
import { toast } from "../Toast";
import { sanitizeInspectableText } from "../webhook-simulator/ResponseInspector";
import { TriggerEditorDialog } from "./TriggerEditorDialog";
import { TriggerFiredBadge } from "./TriggerFiredBadge";
import { triggerActionLabel } from "./trigger-editor-model";

interface Props {
  webhookId: string;
  /** Most recent retained event body used only for the local preview. */
  sampleBody: string;
}

interface TriggerRowsProps {
  items: InboundTrigger[];
  mutatingId: string | null;
  onEdit: (trigger: InboundTrigger) => void;
  onToggle: (trigger: InboundTrigger) => void;
  onDelete: (trigger: InboundTrigger) => void;
}

function TriggerRows({
  items,
  mutatingId,
  onEdit,
  onToggle,
  onDelete,
}: TriggerRowsProps): ReactElement {
  return (
    <div className="wh-trigger-list" role="list">
      {items.map((trigger) => (
        <article key={trigger.id} className="wh-trigger-row" role="listitem">
          <div className="wh-trigger-copy">
            <div className="wh-trigger-titleline">
              <strong>{trigger.name}</strong>
              <span
                className={`badge ${trigger.active ? "success" : "warning"}`}
              >
                {trigger.active ? "Active" : "Paused"}
              </span>
              <TriggerFiredBadge
                firedCount={trigger.fired_count}
                lastFiredAt={trigger.last_fired_at}
              />
            </div>
            <p className="mono small wh-trigger-condition">
              When {trigger.match_jsonpath} {trigger.match_operator}
              {trigger.match_operator !== "exists"
                ? ` ${JSON.stringify(trigger.match_value ?? "")}`
                : ""}
            </p>
            <p className="muted small wh-trigger-route">
              Email from <code>{trigger.email_jsonpath}</code> →{" "}
              {triggerActionLabel(trigger)}
            </p>
          </div>
          <div className="wh-trigger-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={Boolean(mutatingId)}
              onClick={() => onEdit(trigger)}
            >
              Edit
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={Boolean(mutatingId)}
              onClick={() => onToggle(trigger)}
            >
              {mutatingId === trigger.id
                ? "Updating…"
                : trigger.active
                  ? "Pause"
                  : "Resume"}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={Boolean(mutatingId)}
              aria-label={`Delete ${trigger.name}`}
              onClick={() => onDelete(trigger)}
            >
              Delete
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

export function TriggersPanel({ webhookId, sampleBody }: Props): ReactElement {
  const [items, setItems] = useState<InboundTrigger[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editorTarget, setEditorTarget] = useState<
    InboundTrigger | null | "create"
  >(null);
  const [pendingDelete, setPendingDelete] = useState<InboundTrigger | null>(
    null,
  );
  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const activeRef = useRef(true);
  const loadSequenceRef = useRef(0);
  const currentWebhookIdRef = useRef(webhookId);
  currentWebhookIdRef.current = webhookId;

  const refresh = useCallback(async (): Promise<void> => {
    const sequence = ++loadSequenceRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await listInboundTriggers(webhookId);
      if (!activeRef.current || sequence !== loadSequenceRef.current) return;
      if (result.error) {
        setLoadError(sanitizeInspectableText(result.error.message).text);
        return;
      }
      setItems(Array.isArray(result.data.items) ? result.data.items : []);
    } catch (caught) {
      if (activeRef.current && sequence === loadSequenceRef.current) {
        const message =
          caught instanceof Error
            ? caught.message
            : "The trigger request failed.";
        setLoadError(sanitizeInspectableText(message).text);
      }
    } finally {
      if (activeRef.current && sequence === loadSequenceRef.current) {
        setLoading(false);
      }
    }
  }, [webhookId]);

  useEffect(() => {
    activeRef.current = true;
    setItems(null);
    setEditorTarget(null);
    setPendingDelete(null);
    setMutatingId(null);
    void refresh();
    return () => {
      activeRef.current = false;
      loadSequenceRef.current += 1;
    };
  }, [refresh]);

  const ownerIsCurrent = (owner: string): boolean =>
    activeRef.current && currentWebhookIdRef.current === owner;

  const toggleActive = async (trigger: InboundTrigger): Promise<void> => {
    if (mutatingId) return;
    const owner = webhookId;
    setMutatingId(trigger.id);
    try {
      const result = await updateInboundTrigger(owner, trigger.id, {
        active: !trigger.active,
      });
      if (!ownerIsCurrent(owner)) return;
      if (result.error) {
        toast.error(
          `${trigger.active ? "Pause" : "Resume"} failed: ${
            sanitizeInspectableText(result.error.message).text
          }`,
        );
        return;
      }
      setItems(
        (current) =>
          current?.map((item) =>
            item.id === trigger.id ? result.data : item,
          ) ?? null,
      );
      toast.success(trigger.active ? "Trigger paused" : "Trigger resumed");
    } catch (caught) {
      if (ownerIsCurrent(owner)) {
        const message =
          caught instanceof Error ? caught.message : "Trigger update failed.";
        toast.error(sanitizeInspectableText(message).text);
      }
    } finally {
      if (ownerIsCurrent(owner)) setMutatingId(null);
    }
  };

  const confirmRemove = async (): Promise<void> => {
    const target = pendingDelete;
    if (!target || mutatingId) return;
    const owner = webhookId;
    setMutatingId(target.id);
    try {
      const result = await deleteInboundTrigger(owner, target.id);
      if (!ownerIsCurrent(owner)) return;
      if (result.error) {
        toast.error(
          `Delete failed: ${sanitizeInspectableText(result.error.message).text}`,
        );
        return;
      }
      setItems(
        (current) => current?.filter((item) => item.id !== target.id) ?? null,
      );
      setPendingDelete(null);
      toast.success("Trigger deleted");
    } catch (caught) {
      if (ownerIsCurrent(owner)) {
        const message =
          caught instanceof Error ? caught.message : "Trigger delete failed.";
        toast.error(sanitizeInspectableText(message).text);
      }
    } finally {
      if (ownerIsCurrent(owner)) setMutatingId(null);
    }
  };

  const saveToList = (saved: InboundTrigger): void => {
    setItems((current) => {
      if (!current) return [saved];
      const exists = current.some((item) => item.id === saved.id);
      return exists
        ? current.map((item) => (item.id === saved.id ? saved : item))
        : [saved, ...current];
    });
    setEditorTarget(null);
  };

  return (
    <section
      className="wh-triggers-panel"
      aria-label="Inbound routing triggers"
      aria-busy={loading ? "true" : undefined}
    >
      <div className="wh-triggers-head">
        <div>
          <div className="section-title" style={{ marginBottom: 0 }}>
            Triggers
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            Route verified events only when an explicit payload condition
            matches.
          </p>
        </div>
        <div className="wh-trigger-head-actions">
          <button
            type="button"
            className="btn btn-sm"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading && items !== null ? "Refreshing…" : "Refresh"}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={Boolean(mutatingId)}
            onClick={() => setEditorTarget("create")}
          >
            Add trigger
          </button>
        </div>
      </div>
      {loadError ? (
        <div className="notice" role="alert">
          <strong>Couldn&apos;t load triggers.</strong> {loadError}
          {items
            ? " Previously loaded rules remain visible and may be stale."
            : ""}
          <button
            type="button"
            className="btn btn-sm"
            disabled={loading}
            onClick={() => void refresh()}
          >
            Retry
          </button>
        </div>
      ) : null}
      {loading && items === null ? (
        <div className="muted small" role="status">
          Loading routing triggers…
        </div>
      ) : !items || items.length === 0 ? (
        <div className="wh-trigger-empty" role="status">
          <strong>No routing rules yet</strong>
          <span className="muted small">
            Add one after a representative event arrives so the preview can
            verify its JSON paths.
          </span>
        </div>
      ) : (
        <TriggerRows
          items={items}
          mutatingId={mutatingId}
          onEdit={setEditorTarget}
          onToggle={(trigger) => void toggleActive(trigger)}
          onDelete={setPendingDelete}
        />
      )}
      <TriggerEditorDialog
        key={webhookId}
        open={editorTarget !== null}
        trigger={editorTarget === "create" ? null : editorTarget}
        webhookId={webhookId}
        sampleBody={sampleBody}
        onClose={() => setEditorTarget(null)}
        onSaved={saveToList}
      />
      <ConfirmModal
        open={pendingDelete !== null}
        title="Delete this trigger?"
        description={
          pendingDelete
            ? `Future matching events will no longer run “${pendingDelete.name}.” Fired-count history on this rule will also leave this endpoint view. Pause it instead for a reversible stop.`
            : ""
        }
        confirmLabel={mutatingId ? "Deleting…" : "Delete trigger"}
        cancelLabel="Cancel"
        danger
        busy={Boolean(mutatingId)}
        onConfirm={() => void confirmRemove()}
        onClose={() => {
          if (!mutatingId) setPendingDelete(null);
        }}
      />
    </section>
  );
}
