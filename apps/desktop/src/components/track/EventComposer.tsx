/**
 * EventComposer — guarded in-app form to ingest a live product event.
 *
 * This is deliberately named and presented as a live write: the endpoint
 * persists the event and may trigger automations, flows, and revenue
 * attribution. A review acknowledgement prevents it being mistaken for a
 * harmless preview.
 *
 * v2 (audit pass):
 *   - Properties textarea validates JSON on EVERY change (not just
 *     blur) so the operator sees errors as they type instead of after
 *     they click away.
 *   - Event name validated to the snake_case_dot.namespace pattern
 *     the server enforces, inline before send instead of on round-trip.
 *   - Form resets on successful send (event name + props text only;
 *     identity is preserved so successive test events for the same
 *     subscriber don't require retyping).
 *   - Send-failure toast carries the error code for support triage.
 */

import {
  type ReactElement,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { api } from "../../lib/api-client";
import { newUUIDv7 } from "../../lib/http-fetch";
import {
  useDiscardOnlyDraftLifecycle,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import { toast } from "../Toast";
import { isUncertainMutationFailure, safeTrackFailure } from "./track-maturity";

interface Props {
  /** Optional pre-fill when the operator opened the composer from a
   *  catalog row (e.g. "fire another checkout_completed"). */
  initialEventName?: string;
  onSent?: () => void;
  canSend?: boolean;
}

const EVENT_NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

function useComposerValidation(): {
  clearIdentityError: () => void;
  clearValidation: () => void;
  identityError: string | null;
  nameError: string | null;
  propertiesError: string | null;
  validateIdentity: (raw: string) => boolean;
  validateName: (raw: string) => boolean;
  validateProperties: (raw: string) => Record<string, unknown> | null;
} {
  const [propertiesError, setPropertiesError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const clearIdentityError = useCallback(() => setIdentityError(null), []);
  const clearValidation = useCallback(() => {
    setIdentityError(null);
    setNameError(null);
    setPropertiesError(null);
  }, []);
  const validateName = useCallback((raw: string): boolean => {
    const trimmed = raw.trim();
    const message = !trimmed
      ? "Enter an event name."
      : trimmed.length > 128
        ? "Keep the name under 128 characters."
        : !EVENT_NAME_RE.test(trimmed)
          ? "Use snake_case, optionally dot-namespaced (e.g. signup.email_confirmed)."
          : null;
    setNameError(message);
    return message === null;
  }, []);
  const validateProperties = useCallback(
    (raw: string): Record<string, unknown> | null => {
      const trimmed = raw.trim();
      if (!trimmed) {
        setPropertiesError(null);
        return {};
      }
      if (trimmed.length > 65_536) {
        setPropertiesError(
          "Keep the properties JSON at or below 65,536 characters.",
        );
        return null;
      }
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          setPropertiesError(null);
          return parsed as Record<string, unknown>;
        }
        setPropertiesError("Properties must be a JSON object.");
      } catch {
        setPropertiesError(
          "Enter a valid JSON object. Check commas, quotes, and braces.",
        );
      }
      return null;
    },
    [],
  );
  const validateIdentity = useCallback((raw: string): boolean => {
    const trimmed = raw.trim();
    const message = !trimmed
      ? "Enter a subscriber ID or email address."
      : trimmed.length > 512 || /[\u0000-\u001f\u007f]/.test(trimmed)
        ? "Use an ID or email without control characters (512 characters maximum)."
        : trimmed.includes("@") && trimmed.length > 320
          ? "Email addresses must be 320 characters or fewer."
          : null;
    setIdentityError(message);
    return message === null;
  }, []);
  return {
    clearIdentityError,
    clearValidation,
    identityError,
    nameError,
    propertiesError,
    validateIdentity,
    validateName,
    validateProperties,
  };
}

interface EventComposerPanelProps {
  active: boolean;
  acknowledged: boolean;
  uncertain: boolean;
  eventName: string;
  identity: string;
  identityError: string | null;
  identityErrorId: string;
  nameError: string | null;
  nameErrorId: string;
  onEventNameBlur: (value: string) => void;
  onEventNameChange: (value: string) => void;
  onAcknowledgedChange: (value: boolean) => void;
  onIdentityBlur: (value: string) => void;
  onIdentityChange: (value: string) => void;
  onPropertiesChange: (value: string) => void;
  onSubmit: () => void;
  panelId: string;
  panelRef: RefObject<HTMLDivElement | null>;
  firstFieldRef: RefObject<HTMLInputElement | null>;
  propertiesError: string | null;
  propertiesErrorId: string;
  propertiesText: string;
  sendFailed: boolean;
  sendStatus: string | null;
  sendStatusId: string;
  triggerId: string;
}

interface EventComposerDisclosureProps {
  active: boolean;
  canSend: boolean;
  draftTouched: boolean;
  open: boolean;
  panelId: string;
  panelProps: EventComposerPanelProps;
  permissionStatusId: string;
  sendStatusId: string;
  setOpen: (open: boolean) => void;
  triggerId: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
}

function EventComposerPanel({
  active,
  acknowledged,
  uncertain,
  eventName,
  identity,
  identityError,
  identityErrorId,
  nameError,
  nameErrorId,
  onEventNameBlur,
  onEventNameChange,
  onAcknowledgedChange,
  onIdentityBlur,
  onIdentityChange,
  onPropertiesChange,
  onSubmit,
  panelId,
  panelRef,
  firstFieldRef,
  propertiesError,
  propertiesErrorId,
  propertiesText,
  sendFailed,
  sendStatus,
  sendStatusId,
  triggerId,
}: EventComposerPanelProps): ReactElement {
  return (
    <div
      ref={panelRef}
      id={panelId}
      className="track-composer-body"
      role="region"
      aria-labelledby={triggerId}
      aria-busy={active || undefined}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="track-composer-grid">
          <label className="muted small">
            Subscriber (id or email)
            <input
              ref={firstFieldRef}
              className="input"
              style={{ fontSize: 12, width: "100%" }}
              placeholder="alice@example.com"
              value={identity}
              maxLength={512}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={identityError ? "true" : undefined}
              aria-describedby={identityError ? identityErrorId : undefined}
              disabled={uncertain}
              onChange={(event) => onIdentityChange(event.target.value)}
              onBlur={(event) => onIdentityBlur(event.target.value)}
            />
          </label>
          <label className="muted small">
            Event name
            <input
              className="input mono"
              style={{ fontSize: 12, width: "100%" }}
              placeholder="checkout_completed"
              value={eventName}
              onChange={(event) => onEventNameChange(event.target.value)}
              onBlur={(event) => onEventNameBlur(event.target.value)}
              maxLength={128}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={nameError ? "true" : undefined}
              aria-describedby={nameError ? nameErrorId : undefined}
              disabled={uncertain}
            />
          </label>
        </div>
        {identityError ? (
          <div id={identityErrorId} className="field-error" role="alert">
            {identityError}
          </div>
        ) : null}
        {nameError ? (
          <div id={nameErrorId} className="field-error" role="alert">
            {nameError}
          </div>
        ) : null}
        <label className="muted small" style={{ display: "block" }}>
          Properties (JSON object)
          <textarea
            className="input mono"
            style={{ fontSize: 12, width: "100%" }}
            rows={4}
            maxLength={65_536}
            value={propertiesText}
            onChange={(event) => onPropertiesChange(event.target.value)}
            placeholder='{"plan": "pro", "amount": 49}'
            aria-invalid={propertiesError ? "true" : undefined}
            aria-describedby={propertiesError ? propertiesErrorId : undefined}
            disabled={uncertain}
          />
        </label>
        {propertiesError ? (
          <div id={propertiesErrorId} className="field-error" role="alert">
            {propertiesError}
          </div>
        ) : null}
        <div className="track-live-write-warning" role="note">
          <strong>This is a live workspace write.</strong>
          <span>
            It persists the event and may trigger automations, sequences, and
            revenue attribution. It is not a dry run. A successful response
            confirms the event record, not completion of downstream work; verify
            resulting runs in their owning workspace.
          </span>
          <label className="track-live-write-confirm">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={uncertain}
              onChange={(event) =>
                onAcknowledgedChange(event.currentTarget.checked)
              }
            />
            I reviewed the subscriber, event name, and production impact.
          </label>
        </div>
        {sendStatus ? (
          <div
            id={sendStatusId}
            className={sendFailed ? "field-error" : "muted"}
            role={sendFailed ? "alert" : "status"}
            aria-live="polite"
          >
            {sendStatus}
          </div>
        ) : (
          <span id={sendStatusId} className="visually-hidden">
            {active
              ? "The live event send is in progress."
              : uncertain
                ? "The previous result is uncertain. Retry sends the exact same event with the same idempotency key."
                : !identity.trim() || !eventName.trim()
                  ? "Enter a subscriber and event name before sending."
                  : propertiesError || nameError || identityError
                    ? "Correct the form errors before sending."
                    : !acknowledged
                      ? "Acknowledge the live-workspace impact before sending."
                      : "Live event composer is ready."}
          </span>
        )}
        <div className="track-composer-actions">
          <span className="muted small">
            Writes through <span className="mono">POST /api/v1/track</span> with
            a retry-safe idempotency key.
          </span>
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={active || !acknowledged}
            aria-describedby={sendStatusId}
          >
            {active
              ? "Sending…"
              : uncertain
                ? "Retry same live event"
                : "Send live event"}
          </button>
        </div>
      </form>
    </div>
  );
}

function EventComposerDisclosure({
  active,
  canSend,
  draftTouched,
  open,
  panelId,
  panelProps,
  permissionStatusId,
  sendStatusId,
  setOpen,
  triggerId,
  triggerRef,
}: EventComposerDisclosureProps): ReactElement {
  const triggerLabel = open
    ? "Close composer"
    : !canSend
      ? "Live event unavailable"
      : draftTouched
        ? "Resume live event"
        : "Send live event";
  return (
    <div className="track-composer">
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className="btn btn-sm"
        aria-disabled={active || !canSend || undefined}
        aria-describedby={
          !canSend ? permissionStatusId : active ? sendStatusId : undefined
        }
        onClick={() => {
          if (!active && canSend) setOpen(!open);
        }}
        aria-expanded={open}
        aria-controls={panelId}
      >
        {triggerLabel}
      </button>
      {!canSend ? (
        <span
          id={permissionStatusId}
          className="track-permission-note"
          role="status"
        >
          Admin only
        </span>
      ) : null}
      {open ? <EventComposerPanel {...panelProps} /> : null}
    </div>
  );
}

export function EventComposer({
  initialEventName = "",
  onSent,
  canSend = false,
}: Props): ReactElement {
  const [open, setOpen] = useState(false);
  const [identity, setIdentity] = useState("");
  const [eventName, setEventName] = useState(initialEventName);
  const previousInitialNameRef = useRef(initialEventName);

  const [propsText, setPropsText] = useState("{}");
  const {
    clearIdentityError,
    clearValidation,
    identityError,
    nameError,
    propertiesError,
    validateIdentity,
    validateName,
    validateProperties,
  } = useComposerValidation();
  const [sendStatus, setSendStatus] = useState<string | null>(null);
  const [sendFailed, setSendFailed] = useState(false);
  const [sendUncertain, setSendUncertain] = useState(false);
  const [draftTouched, setDraftTouched] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef(true);
  const triggerId = useId();
  const panelId = useId();
  const identityErrorId = useId();
  const nameErrorId = useId();
  const propsErrorId = useId();
  const sendStatusId = useId();
  const permissionStatusId = useId();
  const idempotencyKeyRef = useRef(newUUIDv7());
  const operation = useSingleFlightOperation({
    ownerId: "product-event-composer",
    label: "Live product-event send",
    detail:
      "Wait for the product-event send to finish before leaving Moosewave.",
  });

  // Parent catalog selection may prefill a pristine draft, but it must never
  // mutate an in-flight or ambiguous write. An uncertain retry is only safe
  // when both its idempotency key and exact request body stay unchanged.
  useEffect(() => {
    if (!draftTouched && !sendUncertain && !operation.active) {
      setEventName((current) =>
        current === previousInitialNameRef.current ? initialEventName : current,
      );
    }
    previousInitialNameRef.current = initialEventName;
  }, [draftTouched, initialEventName, operation.active, sendUncertain]);

  // Authorization can change while this inline surface is open. Close it
  // immediately and restore focus so a stale privileged control is never left
  // actionable or visually implied to remain available.
  useEffect(() => {
    if (canSend || !open) return;
    setOpen(false);
    queueMicrotask(() => triggerRef.current?.focus());
  }, [canSend, open]);

  const discardDraft = useCallback((): void => {
    setIdentity("");
    setEventName(initialEventName);
    setPropsText("{}");
    clearValidation();
    setSendStatus(null);
    setSendFailed(false);
    setSendUncertain(false);
    setAcknowledged(false);
    idempotencyKeyRef.current = newUUIDv7();
    setDraftTouched(false);
    setOpen(false);
  }, [clearValidation, initialEventName]);
  useDiscardOnlyDraftLifecycle({
    ownerId: "product-event-composer-draft",
    label: "Live product-event draft",
    dirty: draftTouched,
    operationRef: operation.promiseRef,
    discard: discardDraft,
    detail: "The live event inputs have not been sent.",
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => firstFieldRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.isComposing ||
        event.keyCode === 229 ||
        event.key !== "Escape" ||
        operation.active
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      queueMicrotask(() => triggerRef.current?.focus());
    };
    window.addEventListener("keydown", onKeyDown);
    const onPointerDown = (event: MouseEvent): void => {
      if (
        operation.active ||
        !(event.target instanceof Node) ||
        panelRef.current?.contains(event.target) ||
        triggerRef.current?.contains(event.target)
      ) {
        return;
      }
      setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onPointerDown);
    };
  }, [open, operation.active]);

  const onSend = (): Promise<void> => {
    if (!canSend || !acknowledged) return Promise.resolve();
    const props = validateProperties(propsText);
    if (props === null) return Promise.resolve();
    const trimmedIdentity = identity.trim();
    const trimmedName = eventName.trim();
    const identityValid = validateIdentity(trimmedIdentity);
    const nameValid = validateName(trimmedName);
    if (!identityValid || !nameValid) return Promise.resolve();
    const body: Parameters<typeof api.sendProductEvent>[0] = {
      event_name: trimmedName,
      properties: props,
    };
    // Heuristic: "@" means email, otherwise treat as subscriber id.
    if (trimmedIdentity.includes("@")) body.email = trimmedIdentity;
    else body.subscriber_id = trimmedIdentity;
    setSendStatus(null);
    setSendFailed(false);
    const request = operation.run(async (): Promise<void> => {
      try {
        const res = await api.sendProductEvent(body, {
          idempotencyKey: idempotencyKeyRef.current,
        });
        if (!mountedRef.current) return;
        if (res.error) {
          const uncertain = isUncertainMutationFailure(res.error);
          const message = uncertain
            ? safeTrackFailure(
                res.error,
                "Moosewave couldn't confirm whether the live event was accepted. Refresh the feed or retry this exact event safely.",
              )
            : safeTrackFailure(res.error, "The live event couldn't be sent.");
          setSendFailed(true);
          setSendUncertain(uncertain);
          if (!uncertain) idempotencyKeyRef.current = newUUIDv7();
          setSendStatus(message);
          toast.error(message);
          return;
        }
        const eventId: unknown = res.data?.id;
        if (
          !(
            (typeof eventId === "number" && Number.isSafeInteger(eventId)) ||
            (typeof eventId === "string" &&
              eventId.trim() === eventId &&
              eventId.length > 0 &&
              eventId.length <= 512)
          )
        ) {
          const message =
            "The service accepted the send but did not return a valid event ID. Refresh the feed before retrying to avoid a duplicate.";
          setSendFailed(true);
          setSendUncertain(true);
          setSendStatus(message);
          toast.error(message);
          return;
        }
        const message = `Live event recorded. Event ID: ${String(eventId)}. Downstream processing continues independently.`;
        setSendStatus(message);
        toast.success(message);
        // Reset event name + props but keep `identity` populated — the
        // operator's most common next action is sending another event for
        // the same subscriber.
        setEventName("");
        setPropsText("{}");
        clearValidation();
        setDraftTouched(false);
        setAcknowledged(false);
        setSendUncertain(false);
        idempotencyKeyRef.current = newUUIDv7();
        onSent?.();
      } catch {
        if (!mountedRef.current) return;
        const message =
          "Moosewave couldn't confirm whether the live event was accepted. Refresh the feed before retrying; this draft keeps the same idempotency key.";
        setSendFailed(true);
        setSendUncertain(true);
        setSendStatus(message);
        toast.error(message);
      }
    });
    return request ?? Promise.resolve();
  };

  return (
    <EventComposerDisclosure
      active={operation.active}
      canSend={canSend}
      draftTouched={draftTouched}
      open={open}
      panelId={panelId}
      permissionStatusId={permissionStatusId}
      sendStatusId={sendStatusId}
      setOpen={setOpen}
      triggerId={triggerId}
      triggerRef={triggerRef}
      panelProps={{
        active: operation.active,
        acknowledged,
        uncertain: sendUncertain,
        eventName,
        firstFieldRef,
        identity,
        identityError,
        identityErrorId,
        nameError,
        nameErrorId,
        onEventNameBlur: validateName,
        onEventNameChange: (value) => {
          setEventName(value);
          setDraftTouched(true);
          if (nameError) validateName(value);
        },
        onAcknowledgedChange: (value) => {
          setAcknowledged(value);
          setDraftTouched(true);
          setSendStatus(null);
        },
        onIdentityBlur: validateIdentity,
        onIdentityChange: (value) => {
          setIdentity(value);
          clearIdentityError();
          setSendStatus(null);
          setDraftTouched(true);
        },
        onPropertiesChange: (value) => {
          setPropsText(value);
          validateProperties(value);
          setDraftTouched(true);
        },
        onSubmit: () => void onSend(),
        panelId,
        panelRef,
        propertiesError,
        propertiesErrorId: propsErrorId,
        propertiesText: propsText,
        sendFailed,
        sendStatus,
        sendStatusId,
        triggerId,
      }}
    />
  );
}
