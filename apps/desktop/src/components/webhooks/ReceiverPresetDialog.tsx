/**
 * ReceiverPresetDialog — opens when a user clicks a receiver card in
 * the onboarding gallery. Pre-fills name + URL hint + sensible
 * default events, then creates an outbound webhook subscription on
 * confirm. Refined Webhooks final batch.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  lifecycleOperationError,
  useDiscardOnlyDraftLifecycle,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import {
  OUTBOUND_WEBHOOK_EVENTS,
  OUTBOUND_WEBHOOK_SIGNING_ALGORITHMS,
  createOutboundWebhook,
  type OutboundWebhookCreateResponse,
  type OutboundWebhookSigningAlgorithm,
} from "../../lib/api-client";
import { newUUIDv7 } from "../../lib/http-fetch";
import { ConfirmModal } from "../ConfirmModal";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";
import { sanitizeInspectableText } from "../webhook-simulator/ResponseInspector";
import {
  buildReceiverAuthConfig,
  createReceiverAuthDraft,
  ReceiverAuthFields,
  receiverAuthDraftIsDirty,
  type ReceiverAuthDraft,
  validateReceiverAuthDraft,
} from "./ReceiverAuthFields";
import {
  DeliveryPolicyFields,
  deliveryPolicyTransform,
  emptyDeliveryPolicyDraft,
  type DeliveryPolicyDraft,
  validateDeliveryPolicyDraft,
} from "./DeliveryPolicyFields";
import { type ReceiverPreset, RECEIVER_PRESETS } from "./receiver-presets";

// Re-export so existing importers (OutboundWebhooks.tsx) keep working;
// the data itself lives in the pure sibling module receiver-presets.ts
// (testable under the node-env vitest setup).
export { RECEIVER_PRESETS };
export type { ReceiverPreset };

interface Props {
  open: boolean;
  preset: ReceiverPreset | null;
  onClose: () => void;
  /**
   * Fired on a successful create. Receives the full server response —
   * crucially including the plaintext `secret`, which is returned exactly
   * once and must be surfaced to the operator in a shown-once view by
   * the parent. Earlier versions of this dialog dropped the secret on
   * the floor.
   */
  onCreated: (created: OutboundWebhookCreateResponse) => void;
}

/** Exact catalog accepted by outbound_webhooks.AllowedEvents. */
export const ALL_EVENTS: string[] = [...OUTBOUND_WEBHOOK_EVENTS];

/**
 * Drop unknown preset topics instead of sending a request the server must
 * reject. Preset data itself uses the canonical producer-backed catalog; this
 * boundary deliberately does not introduce aliases for retired event names.
 */
export function canonicalPresetEvents(events: ReadonlyArray<string>): string[] {
  const allowed = new Set<string>(OUTBOUND_WEBHOOK_EVENTS);
  return [...new Set(events.filter((event) => allowed.has(event)))];
}

function ReceiverEventSelection({
  selected,
  onToggle,
}: {
  selected: ReadonlySet<string>;
  onToggle: (event: string) => void;
}): ReactElement {
  return (
    <div className="field">
      <div className="field-label">Subscribe to these events</div>
      <div className="wh-events-grid">
        {ALL_EVENTS.map((event) => (
          <label key={event} className="wh-events-row">
            <input
              type="checkbox"
              checked={selected.has(event)}
              onChange={() => onToggle(event)}
            />
            <span className="mono" style={{ fontSize: 12 }}>
              {event}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

function signingAlgorithmLabel(
  algorithm: OutboundWebhookSigningAlgorithm,
): string {
  switch (algorithm) {
    case "hmac_sha256":
      return "HMAC-SHA256 (shared secret)";
    case "ecdsa_p256":
      return "ECDSA P-256 (public key verification)";
    case "ed25519":
      return "Ed25519 (public key verification)";
  }
}

function ReceiverSigningAlgorithmField({
  value,
  onChange,
}: {
  value: OutboundWebhookSigningAlgorithm;
  onChange: (value: OutboundWebhookSigningAlgorithm) => void;
}): ReactElement {
  return (
    <div className="field">
      <label className="field-label" htmlFor="wh-preset-algorithm">
        Signing algorithm
      </label>
      <select
        id="wh-preset-algorithm"
        className="select"
        value={value}
        onChange={(event) =>
          onChange(event.target.value as OutboundWebhookSigningAlgorithm)
        }
      >
        {OUTBOUND_WEBHOOK_SIGNING_ALGORITHMS.map((algorithm) => (
          <option key={algorithm} value={algorithm}>
            {signingAlgorithmLabel(algorithm)}
          </option>
        ))}
      </select>
      <p className="field-help">
        The algorithm cannot be changed after creation. Asymmetric receivers
        receive only the public verification key; the private signing key stays
        encrypted inside Moosewave. HMAC secrets are shown once.
      </p>
    </div>
  );
}

export function ReceiverPresetDialog({
  open,
  preset,
  onClose,
  onCreated,
}: Props): ReactElement {
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState(preset?.description ?? "");
  const [algorithm, setAlgorithm] =
    useState<OutboundWebhookSigningAlgorithm>("hmac_sha256");
  const [events, setEvents] = useState<Set<string>>(
    new Set(canonicalPresetEvents(preset?.defaultEvents ?? [])),
  );
  const [authDraft, setAuthDraft] = useState<ReceiverAuthDraft>(() =>
    createReceiverAuthDraft("none"),
  );
  const [authError, setAuthError] = useState<string | null>(null);
  const [policy, setPolicy] = useState<DeliveryPolicyDraft>(
    emptyDeliveryPolicyDraft,
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const createIdentityRef = useRef<{
    fingerprint: string;
    key: string;
  } | null>(null);
  const lifecycleId = useId();
  const operation = useSingleFlightOperation({
    ownerId: "receiver-preset-create",
    label: "Webhook receiver connection",
    detail: "Wait for the webhook receiver request to finish before leaving.",
  });
  const defaultEvents = useMemo(
    () => new Set(canonicalPresetEvents(preset?.defaultEvents ?? [])),
    [preset],
  );
  const defaultDescription = preset?.description ?? "";
  const draftDirty =
    open &&
    (url.trim() !== "" ||
      description.trim() !== defaultDescription.trim() ||
      algorithm !== "hmac_sha256" ||
      receiverAuthDraftIsDirty(authDraft) ||
      Boolean(policy.filterExpression.trim()) ||
      policy.projections.length > 0 ||
      [...events].sort().join("\u001f") !==
        [...defaultEvents].sort().join("\u001f"));
  const discardDraft = useCallback((): void => {
    setUrl("");
    setDescription(defaultDescription);
    setAlgorithm("hmac_sha256");
    setEvents(new Set(defaultEvents));
    setAuthDraft(createReceiverAuthDraft("none"));
    setPolicy(emptyDeliveryPolicyDraft());
    setAuthError(null);
    setSubmitError(null);
    setConfirmClose(false);
    createIdentityRef.current = null;
    onClose();
  }, [defaultDescription, defaultEvents, onClose]);
  useDiscardOnlyDraftLifecycle({
    ownerId: "receiver-preset-create",
    label: "Webhook receiver draft",
    dirty: draftDirty,
    operationRef: operation.promiseRef,
    discard: discardDraft,
    detail:
      "This receiver URL, event selection, or credential change has not been submitted.",
  });

  // Reset the draft whenever the dialog opens for a (different)
  // preset. This replaces the old render-time `setEvents` reset, which
  // (a) fired on every render where the set was empty — so the last
  // checkbox could never be unchecked — and (b) leaked selections
  // across presets. Deliberately-empty selections are now a valid
  // intermediate state; emptiness is validated on submit instead.
  useEffect(() => {
    if (open && preset) {
      setUrl("");
      setDescription(preset.description);
      setAlgorithm("hmac_sha256");
      setAuthDraft(createReceiverAuthDraft("none"));
      setPolicy(emptyDeliveryPolicyDraft());
      setAuthError(null);
      setSubmitError(null);
      createIdentityRef.current = null;
      setEvents(new Set(canonicalPresetEvents(preset.defaultEvents)));
    }
    // Key on the preset's name (its identity) — the gallery passes a
    // fresh object reference per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preset?.name]);

  const submit = async (): Promise<void> => {
    if (!preset) return;
    if (!url.trim()) {
      setSubmitError("Enter the HTTPS URL that will receive deliveries.");
      return;
    }
    if (events.size === 0) {
      setSubmitError("Select at least one event to subscribe to.");
      return;
    }
    const receiverAuthError = validateReceiverAuthDraft(authDraft);
    if (receiverAuthError) {
      setAuthError(receiverAuthError);
      return;
    }
    const policyError = validateDeliveryPolicyDraft(policy);
    if (policyError) {
      setSubmitError(`Delivery policy: ${policyError}`);
      return;
    }
    const authConfig = buildReceiverAuthConfig(authDraft);
    const transformTemplate = deliveryPolicyTransform(policy);
    const input = {
      url: url.trim(),
      description: description.trim() || preset.description,
      events: [...events],
      algorithm,
      ...(authConfig ? { auth_config: authConfig } : {}),
      ...(policy.filterExpression.trim()
        ? { filter_expression: policy.filterExpression.trim() }
        : {}),
      ...(transformTemplate ? { transform_template: transformTemplate } : {}),
    };
    const fingerprint = JSON.stringify(input);
    if (createIdentityRef.current?.fingerprint !== fingerprint) {
      createIdentityRef.current = { fingerprint, key: newUUIDv7() };
    }
    const idempotencyKey = createIdentityRef.current.key;
    setAuthError(null);
    setSubmitError(null);
    const request = operation.run(async () => {
      const res = await createOutboundWebhook(input, { idempotencyKey });
      if (!res.error && res.data) {
        createIdentityRef.current = null;
        setUrl("");
        setDescription(preset.description);
        setAlgorithm("hmac_sha256");
        setEvents(new Set());
        setAuthDraft(createReceiverAuthDraft("none"));
        setPolicy(emptyDeliveryPolicyDraft());
        setAuthError(null);
        // Parent activation happens synchronously inside onCreated, before
        // this retained request owner releases in its finally path.
        onCreated(res.data);
      }
      return res;
    });
    if (!request) return;
    setSubmitting(true);
    let res: Awaited<ReturnType<typeof createOutboundWebhook>>;
    try {
      res = await request;
    } catch (error) {
      const message = sanitizeInspectableText(
        lifecycleOperationError(error, "The webhook request failed."),
      ).text;
      setSubmitError(message);
      toast.error(`Create failed: ${message}`);
      return;
    } finally {
      setSubmitting(false);
    }
    if (res.error || !res.data) {
      const message = sanitizeInspectableText(
        res.error?.message ?? "The server returned no data.",
      ).text;
      setSubmitError(message);
      toast.error(`Create failed: ${message}`);
      return;
    }
    // The strict API decoder already proved that the algorithm-appropriate
    // one-time HMAC secret or asymmetric public verification key is present.
  };

  const toggleEvent = (ev: string): void => {
    setEvents((prev) => {
      const next = new Set(prev);
      if (next.has(ev)) next.delete(ev);
      else next.add(ev);
      return next;
    });
  };

  const guardedClose = (): void => {
    if (submitting || operation.active) {
      toast.info({
        id: `receiver-preset-busy-${lifecycleId}`,
        message: "Webhook connection still running",
        detail: "Wait for it to finish before closing this dialog.",
      });
      return;
    }
    if (draftDirty) {
      setConfirmClose(true);
      return;
    }
    discardDraft();
  };

  return (
    <>
      <Modal
        open={open && preset !== null}
        onClose={guardedClose}
        closeOnBackdrop={!submitting && !operation.active}
        closeOnEscape={!submitting && !operation.active}
        title={preset ? `Connect to ${preset.name}` : "Connect"}
        description={preset?.helpText ?? ""}
      >
        <div className="field">
          <label className="field-label" htmlFor="wh-preset-url">
            Receiver URL
          </label>
          <input
            id="wh-preset-url"
            type="url"
            className="input mono"
            placeholder={preset?.urlPlaceholder ?? "https://…"}
            value={url}
            aria-invalid={submitError && !url.trim() ? "true" : undefined}
            aria-describedby={submitError ? "wh-preset-error" : undefined}
            onChange={(e) => {
              setUrl(e.target.value);
              setSubmitError(null);
            }}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="wh-preset-description">
            Description
          </label>
          <input
            id="wh-preset-description"
            className="input"
            value={description}
            maxLength={200}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        <ReceiverSigningAlgorithmField
          value={algorithm}
          onChange={setAlgorithm}
        />
        <ReceiverAuthFields
          draft={authDraft}
          error={authError}
          onChange={(next) => {
            setAuthDraft(next);
            setAuthError(null);
            setSubmitError(null);
          }}
        />
        <ReceiverEventSelection
          selected={events}
          onToggle={(event) => {
            toggleEvent(event);
            setSubmitError(null);
          }}
        />
        <DeliveryPolicyFields
          value={policy}
          disabled={submitting || operation.active}
          onChange={(next) => {
            setPolicy(next);
            setSubmitError(null);
          }}
        />
        {submitError ? (
          <p id="wh-preset-error" className="field-error" role="alert">
            {submitError}
          </p>
        ) : null}
        <ModalFooter>
          <button type="button" className="btn" onClick={guardedClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={
              submitting || operation.active || !url.trim() || events.size === 0
            }
            onClick={() => void submit()}
          >
            {submitting ? "Creating…" : "Connect"}
          </button>
        </ModalFooter>
      </Modal>
      <ConfirmModal
        open={confirmClose}
        title="Discard webhook receiver draft?"
        description="The unsaved receiver URL, event selection, delivery policy, and any write-only receiver credentials will be cleared. No destination has been created yet."
        confirmLabel="Discard draft"
        cancelLabel="Keep editing"
        danger
        onConfirm={discardDraft}
        onClose={() => setConfirmClose(false)}
      />
    </>
  );
}

// RECEIVER_PRESETS lives in ./receiver-presets.ts (re-exported above).
