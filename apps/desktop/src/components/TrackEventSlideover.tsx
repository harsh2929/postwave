/** Read-only product-event evidence and automation handoff. */

import { type ReactElement, useEffect, useId, useRef, useState } from "react";

import { useSingleFlightOperation } from "../hooks/useSettingsDraftLifecycle";
import {
  api,
  type ProductEvent,
  type SequenceCanvasStep,
} from "../lib/api-client";
import { setSection } from "../lib/store";
import {
  boundedJsonPreview,
  isUncertainMutationFailure,
  safeAbsoluteTime,
  safeTrackFailure,
} from "./track/track-maturity";
import { SlideoverShell } from "./SlideoverShell";
import { toast } from "./Toast";

interface Props {
  event: ProductEvent;
  onClose: () => void;
  canCreateSequence: boolean;
}

interface SequenceDraftOutcome {
  tone: "success" | "error";
  message: string;
  retryBlocked?: boolean;
}

const AUTOMATION_EVENT_NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

function EventTimestamp({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}): ReactElement {
  if (!value) {
    return (
      <div>
        <dt>{label}</dt>
        <dd className="muted">Not recorded</dd>
      </div>
    );
  }
  const valid = Number.isFinite(new Date(value).getTime());
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {valid ? (
          <time dateTime={value} className="track-event-timestamp">
            <span>{safeAbsoluteTime(value)}</span>
            <span className="mono muted">{value}</span>
          </time>
        ) : (
          <span className="muted">Invalid timestamp</span>
        )}
      </dd>
    </div>
  );
}

function validResourceId(value: unknown): string | null {
  if (
    (typeof value === "string" &&
      value.trim() === value &&
      value.length > 0 &&
      value.length <= 512) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  ) {
    return String(value);
  }
  return null;
}

export function TrackEventSlideover({
  event,
  onClose,
  canCreateSequence,
}: Props): ReactElement {
  const mountedRef = useRef(true);
  const statusId = useId();
  const [outcome, setOutcome] = useState<SequenceDraftOutcome | null>(null);
  const operation = useSingleFlightOperation({
    ownerId: `track-event-sequence-${String(event.id)}`,
    label: "Product-event sequence draft creation",
    detail:
      "Wait for the sequence draft request to finish before leaving Moosewave.",
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const rawEventName = event.eventName || event.event_name || "";
  const eventName = rawEventName.trim() || "Unnamed event";
  const subscriber =
    event.subscriber_email ||
    event.subscriberId ||
    event.subscriber_id ||
    "Not recorded";
  const occurred = event.occurredAt ?? event.occurred_at;
  const received = event.receivedAt ?? event.received_at;
  const properties = event.properties ?? null;
  const canAutomate =
    eventName.length <= 128 && AUTOMATION_EVENT_NAME_RE.test(eventName);

  const createSequenceDraft = (): Promise<void> => {
    if (
      !canCreateSequence ||
      !canAutomate ||
      outcome?.tone === "success" ||
      outcome?.retryBlocked
    ) {
      return Promise.resolve();
    }
    setOutcome(null);
    const request = operation.run(async (): Promise<void> => {
      const triggerStep: SequenceCanvasStep = {
        type: "condition",
        position: 1,
        condition: {
          predicate: "product_event",
          value: eventName,
          yes_branch: [],
          no_branch: [],
        },
      };
      const sequenceName = `Follow up: ${eventName}`;
      try {
        const sequenceResponse = await api.createSequence({
          name: sequenceName,
          status: "draft",
          steps: [triggerStep],
        });
        if (!mountedRef.current) return;
        if (sequenceResponse.error) {
          const uncertain = isUncertainMutationFailure(sequenceResponse.error);
          const failure = safeTrackFailure(
            sequenceResponse.error,
            uncertain
              ? "The sequence request couldn't be confirmed."
              : "The sequence draft couldn't be created.",
          );
          const message = uncertain
            ? `${failure} Open Sequences to verify the result before retrying.`
            : failure;
          setOutcome({
            tone: "error",
            message,
            retryBlocked: uncertain,
          });
          toast.error(message);
          return;
        }
        const sequenceId = validResourceId(sequenceResponse.data?.id);
        if (!sequenceId) {
          const message =
            "The service accepted the sequence request but returned no valid sequence ID. Open Sequences to verify the result before retrying.";
          setOutcome({ tone: "error", message, retryBlocked: true });
          toast.error(message);
          return;
        }
        const message = `Sequence draft ${sequenceId} created with a ${eventName} product-event condition.`;
        setOutcome({ tone: "success", message });
        toast.success(message);
        setSection("sequences");
        onClose();
      } catch {
        if (!mountedRef.current) return;
        const message =
          "The sequence request couldn't be confirmed. Open Sequences to verify the result before retrying.";
        setOutcome({ tone: "error", message, retryBlocked: true });
        toast.error(message);
      }
    });
    return request ?? Promise.resolve();
  };

  const subtitle = occurred
    ? `Occurred ${safeAbsoluteTime(occurred)}`
    : "Occurrence time not recorded";
  const createUnavailable =
    operation.active ||
    !canCreateSequence ||
    !canAutomate ||
    outcome?.tone === "success" ||
    Boolean(outcome?.retryBlocked);
  const createReason = operation.active
    ? "Creating the inactive sequence draft. Repeated activation reuses this operation."
    : !canCreateSequence
      ? "Campaign-write access is required to create a sequence draft."
      : !canAutomate
        ? "This event has no valid event name, so an automation trigger cannot be created."
        : outcome?.tone === "success"
          ? outcome.message
          : outcome?.retryBlocked
            ? "The creation result is uncertain. Open Sequences to verify it before retrying to prevent a duplicate."
            : "Creates one inactive server-side sequence draft with this product-event condition. Nothing is activated or sent.";

  const requestClose = (): void => {
    if (!operation.active) onClose();
  };

  return (
    <SlideoverShell
      open
      onClose={requestClose}
      size="md"
      eyebrow="Product event evidence"
      title={eventName}
      subtitle={subtitle}
      busy={operation.active}
      footer={
        <>
          <button
            type="button"
            className="btn"
            aria-disabled={operation.active || undefined}
            aria-describedby={operation.active ? statusId : undefined}
            onClick={requestClose}
          >
            Close
          </button>
          <button
            type="button"
            className="btn btn-primary"
            aria-disabled={createUnavailable || undefined}
            aria-describedby={statusId}
            onClick={() => {
              if (!createUnavailable) void createSequenceDraft();
            }}
          >
            {operation.active ? "Creating draft…" : "Create sequence draft"}
          </button>
        </>
      }
    >
      <dl className="track-event-evidence">
        <div>
          <dt>Event ID</dt>
          <dd className="mono">{String(event.id)}</dd>
        </div>
        <div>
          <dt>Subscriber</dt>
          <dd className="mono">{String(subscriber)}</dd>
        </div>
        <EventTimestamp label="Occurred" value={occurred} />
        <EventTimestamp label="Received" value={received} />
        <div>
          <dt>Evidence source</dt>
          <dd>Workspace product-event feed or authenticated live stream</dd>
        </div>
      </dl>

      <section aria-labelledby={`${statusId}-properties`}>
        <h3 id={`${statusId}-properties`} className="label">
          Properties
        </h3>
        <p className="muted small">
          Raw workspace evidence may contain personal data. Share and retain it
          according to your organization&apos;s data policy.
        </p>
        {properties && Object.keys(properties).length > 0 ? (
          <pre className="muted mono pw-pre track-event-properties">
            {boundedJsonPreview(properties, 12_000)}
          </pre>
        ) : (
          <div className="muted">
            No properties were recorded on this event.
          </div>
        )}
      </section>

      <div
        id={statusId}
        className={outcome?.tone === "error" ? "field-error" : "muted"}
        role={outcome?.tone === "error" ? "alert" : "status"}
        aria-live="polite"
      >
        {outcome?.message ?? createReason}
      </div>
    </SlideoverShell>
  );
}
