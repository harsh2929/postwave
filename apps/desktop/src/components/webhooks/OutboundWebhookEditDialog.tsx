/**
 * OutboundWebhookEditDialog — edit an existing outbound webhook's URL and
 * event filter after creation (KLV-06 / DEV-08 lifecycle gap: creation +
 * test + retry were wired, but post-create editing of url/events was not).
 *
 * Backed by the canonical PATCH /api/v1/outbound-webhooks/{id} contract used
 * by the Simulator. Unlike the create dialog there is no signing material to
 * surface — it remains unchanged by URL, description, and event edits.
 *
 * Honesty: a webhook may carry event topics outside the canonical
 * ALL_EVENTS catalog (e.g. list-scoped list.subscriber.*). Those are shown
 * as checkboxes too and preserved — editing the filter never silently
 * drops a topic the operator can't see.
 */

import { type ReactElement, useEffect, useId, useRef, useState } from "react";

import { useBlockingLifecycleOperation } from "../../hooks/useBlockingLifecycleOperation";
import {
  type OutboundWebhook,
  type OutboundWebhookUpdateInput,
  updateOutboundWebhook,
} from "../../lib/api-client";
import { registerLifecycleGuard } from "../../lib/lifecycle-coordinator";
import { ConfirmModal } from "../ConfirmModal";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";
import { sanitizeInspectableText } from "../webhook-simulator/ResponseInspector";
import { ALL_EVENTS } from "./ReceiverPresetDialog";
import {
  buildReceiverAuthConfig,
  createReceiverAuthDraft,
  ReceiverAuthFields,
  type ReceiverAuthDraft,
  validateReceiverAuthDraft,
} from "./ReceiverAuthFields";
import {
  DeliveryPolicyFields,
  deliveryPolicyDraftFromWebhook,
  deliveryPolicyEquals,
  deliveryPolicyTransform,
  type DeliveryPolicyDraft,
  validateDeliveryPolicyDraft,
} from "./DeliveryPolicyFields";

interface Props {
  /** null = closed. */
  webhook: OutboundWebhook | null;
  onClose: () => void;
  onSaved: () => void;
}

export function OutboundWebhookEditDialog({
  webhook,
  onClose,
  onSaved,
}: Props): ReactElement | null {
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<Set<string>>(new Set());
  const [authDraft, setAuthDraft] = useState<ReceiverAuthDraft>(() =>
    createReceiverAuthDraft("preserve"),
  );
  const [authError, setAuthError] = useState<string | null>(null);
  const [policy, setPolicy] = useState<DeliveryPolicyDraft>(() =>
    deliveryPolicyDraftFromWebhook(null),
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const saveFlightRef = useRef<Promise<unknown> | null>(null);
  const lifecycleId = useId();

  // Re-hydrate whenever the target webhook changes (operator may edit a
  // different row without closing first).
  useEffect(() => {
    if (!webhook) return;
    // Read APIs expose only a safe display projection. Starting blank prevents
    // the editor from accidentally submitting that redacted value as a new
    // destination.
    setUrl("");
    setDescription(webhook.description ?? "");
    setEvents(new Set(Array.isArray(webhook.events) ? webhook.events : []));
    setAuthDraft(createReceiverAuthDraft("preserve"));
    setPolicy(deliveryPolicyDraftFromWebhook(webhook));
    setAuthError(null);
    setSaving(false);
    setSaveError(null);
    saveFlightRef.current = null;
    setConfirmClose(false);
  }, [webhook]);

  const baselineEvents = Array.isArray(webhook?.events) ? webhook.events : [];
  const baselinePolicy = deliveryPolicyDraftFromWebhook(webhook);
  const dirty = Boolean(
    webhook &&
    (url.trim() !== "" ||
      description.trim() !== (webhook.description ?? "").trim() ||
      authDraft.mode !== "preserve" ||
      !deliveryPolicyEquals(policy, baselinePolicy) ||
      [...events].sort().join("\u001f") !==
        [...baselineEvents].sort().join("\u001f")),
  );
  useBlockingLifecycleOperation(
    `outbound-webhook-edit-${lifecycleId}`,
    "Outbound webhook save",
    saving,
  );
  useEffect(() => {
    if (!webhook || !dirty || saving) return;
    return registerLifecycleGuard({
      id: `outbound-webhook-edit-draft-${lifecycleId}`,
      label: "Outbound webhook edit",
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : {
              level: "warning",
              detail:
                "Webhook URL, event, or receiver-auth changes have not been saved.",
              canDiscard: true,
            },
      discard: () => {
        setUrl("");
        setDescription(webhook.description ?? "");
        setEvents(new Set(baselineEvents));
        setAuthDraft(createReceiverAuthDraft("preserve"));
        setPolicy(deliveryPolicyDraftFromWebhook(webhook));
        setAuthError(null);
        setSaveError(null);
        setConfirmClose(false);
        onClose();
      },
    });
  }, [baselineEvents, dirty, lifecycleId, onClose, saving, webhook]);

  if (!webhook) return null;

  // Union of the canonical catalog + any topics this webhook already has
  // (so out-of-catalog topics stay visible + toggleable, never dropped).
  const current = Array.isArray(webhook.events) ? webhook.events : [];
  const topics = [...new Set([...ALL_EVENTS, ...current])];

  const toggle = (ev: string): void => {
    setEvents((prev) => {
      const next = new Set(prev);
      if (next.has(ev)) next.delete(ev);
      else next.add(ev);
      return next;
    });
  };

  const save = async (): Promise<void> => {
    const trimmed = url.trim();
    if (events.size === 0 || saveFlightRef.current) return;
    const receiverAuthError = validateReceiverAuthDraft(authDraft);
    if (receiverAuthError) {
      setAuthError(receiverAuthError);
      return;
    }
    const policyError = validateDeliveryPolicyDraft(policy);
    if (policyError) {
      setSaveError(`Delivery policy: ${policyError}`);
      return;
    }
    const authConfig = buildReceiverAuthConfig(authDraft);
    const patch: OutboundWebhookUpdateInput = {
      description: description.trim(),
      events: [...events],
    };
    if (trimmed) patch.url = trimmed;
    if (authConfig !== undefined) patch.auth_config = authConfig;
    if (!deliveryPolicyEquals(policy, baselinePolicy)) {
      patch.filter_expression = policy.filterExpression.trim() || null;
      patch.transform_template = deliveryPolicyTransform(policy);
    }
    setAuthError(null);
    setSaveError(null);
    setSaving(true);
    const pending = updateOutboundWebhook(webhook.id, patch);
    saveFlightRef.current = pending;
    let res: Awaited<ReturnType<typeof updateOutboundWebhook>>;
    try {
      res = await pending;
    } catch (error) {
      const message = sanitizeInspectableText(
        error instanceof Error && error.message
          ? error.message
          : "The webhook update request failed.",
      ).text;
      setSaveError(message);
      toast.error(`Couldn't save webhook: ${message}`);
      return;
    } finally {
      if (saveFlightRef.current === pending) saveFlightRef.current = null;
      setSaving(false);
    }
    if (res.error) {
      const message = sanitizeInspectableText(res.error.message).text;
      setSaveError(message);
      toast.error(`Couldn't save webhook: ${message}`);
      return;
    }
    toast.success("Webhook updated");
    onSaved();
  };

  const guardedClose = (): void => {
    if (saving) {
      toast.info({
        id: `outbound-webhook-save-${lifecycleId}`,
        message: "Webhook save still running",
        detail: "Wait for it to finish before closing this dialog.",
      });
      return;
    }
    if (dirty) {
      setConfirmClose(true);
      return;
    }
    onClose();
  };

  return (
    <>
      <Modal
        open={webhook !== null}
        onClose={guardedClose}
        closeOnBackdrop={!saving}
        closeOnEscape={!saving}
        title="Edit outbound webhook"
        description="Change the receiver URL, events, or write-only receiver authentication. Moosewave signing material is unchanged."
      >
        <div className="field">
          <label className="field-label" htmlFor="wh-edit-url">
            Replace endpoint URL <span className="muted">(optional)</span>
          </label>
          <p className="field-help">
            Current destination: <span className="mono">{webhook.url}</span>.
            Moosewave hides its path and query on reads. Leave this blank to
            preserve it, or enter the complete new URL.
          </p>
          <input
            id="wh-edit-url"
            type="url"
            className="input mono"
            placeholder="https://hooks.example.com/complete-path"
            value={url}
            aria-invalid={saveError && !url.trim() ? "true" : undefined}
            aria-describedby={saveError ? "wh-edit-error" : undefined}
            onChange={(e) => {
              setUrl(e.target.value);
              setSaveError(null);
            }}
          />
        </div>
        <ReceiverAuthFields
          draft={authDraft}
          current={webhook.auth_config}
          status={webhook.auth_config_status}
          error={authError}
          allowPreserve
          onChange={(next) => {
            setAuthDraft(next);
            setAuthError(null);
            setSaveError(null);
          }}
        />
        <div className="field">
          <label className="field-label" htmlFor="wh-edit-description">
            Description
          </label>
          <input
            id="wh-edit-description"
            className="input"
            value={description}
            maxLength={512}
            onChange={(event) => {
              setDescription(event.target.value);
              setSaveError(null);
            }}
          />
        </div>
        <div className="field">
          <div className="field-label">Subscribe to these events</div>
          <div className="wh-events-grid">
            {topics.map((ev) => (
              <label key={ev} className="wh-events-row">
                <input
                  type="checkbox"
                  checked={events.has(ev)}
                  onChange={() => {
                    toggle(ev);
                    setSaveError(null);
                  }}
                />
                <span className="mono" style={{ fontSize: 12 }}>
                  {ev}
                </span>
              </label>
            ))}
          </div>
          {events.size === 0 ? (
            <div className="field-error" role="alert">
              Select at least one event.
            </div>
          ) : null}
        </div>
        <DeliveryPolicyFields
          value={policy}
          invalid={webhook.delivery_policy_status === "invalid"}
          disabled={saving}
          onChange={(next) => {
            setPolicy(next);
            setSaveError(null);
          }}
        />
        {saveError ? (
          <p id="wh-edit-error" className="field-error" role="alert">
            {saveError}
          </p>
        ) : null}
        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={guardedClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving || !dirty || events.size === 0}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </ModalFooter>
      </Modal>
      <ConfirmModal
        open={confirmClose}
        title="Discard webhook changes?"
        description="The URL, event, delivery-policy, or write-only receiver-auth changes in this dialog have not been saved."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        danger
        onConfirm={() => {
          setConfirmClose(false);
          setUrl("");
          setDescription(webhook.description ?? "");
          setEvents(new Set(baselineEvents));
          setAuthDraft(createReceiverAuthDraft("preserve"));
          setPolicy(deliveryPolicyDraftFromWebhook(webhook));
          setAuthError(null);
          setSaveError(null);
          onClose();
        }}
        onClose={() => setConfirmClose(false)}
      />
    </>
  );
}
