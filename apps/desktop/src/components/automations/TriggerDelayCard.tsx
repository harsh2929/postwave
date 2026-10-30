import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";

import { usePersistentLifecycleOperation } from "../../hooks/usePersistentLifecycleOperation";
import {
  AUTOMATION_SURFACE_BOUNDARIES,
  TRIGGER_DELAY_LEARNING_AVAILABLE,
} from "../../lib/automation-operational-availability";
import {
  type TriggerDelayPreference,
  triggerDelayApi,
} from "../../lib/api-client";
import { registerLifecycleGuard } from "../../lib/lifecycle-coordinator";
import { ConfirmModal } from "../ConfirmModal";
import { FormField } from "../FormField";
import { SectionHeader } from "../SectionHeader";
import { toast } from "../Toast";

import {
  delayLookupErrors,
  fmtConfidence,
  fmtDelay,
  MAX_DELAY_SECONDS,
  MAX_TRIGGER_DELAY_EVENT_NAME_BYTES,
  MAX_TRIGGER_DELAY_REASON_BYTES,
  parseDelaySeconds,
  triggerDelayReasonError,
} from "./trigger-delay-helpers";
import { normalizeTriggerDelayPreference } from "./response-normalizers";
import { fmtRelative } from "./zero-copy-helpers";

interface LookupPair {
  subscriberId: string;
  eventName: string;
  key: string;
}

interface ResolvedPair {
  pair: LookupPair;
  preference: TriggerDelayPreference | null;
}

interface LookupState {
  resolved: ResolvedPair | null;
  loading: boolean;
  error: string | null;
  stale: boolean;
}

function pairFrom(subscriberId: string, eventName: string): LookupPair {
  const subscriber = subscriberId.trim().toLowerCase();
  const event = eventName.trim().toLowerCase();
  return {
    subscriberId: subscriber,
    eventName: event,
    key: `${subscriber}\u0000${event}`,
  };
}

export function TriggerDelayCard({
  canAdmin,
}: {
  canAdmin: boolean;
}): ReactElement {
  const [subscriberId, setSubscriberId] = useState("");
  const [eventName, setEventName] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [state, setState] = useState<LookupState>({
    resolved: null,
    loading: false,
    error: null,
    stale: false,
  });
  const [overrideDelay, setOverrideDelay] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [overrideErr, setOverrideErr] = useState<string | null>(null);
  const [overrideReasonErr, setOverrideReasonErr] = useState<string | null>(
    null,
  );
  const [pendingLookup, setPendingLookup] = useState<LookupPair | null>(null);
  const lookupSequenceRef = useRef(0);
  const lookupInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const boundary = AUTOMATION_SURFACE_BOUNDARIES["timing-overrides"];
  const saveOperation = usePersistentLifecycleOperation({
    ownerId: "automations-trigger-delay-save",
    label: "Saving manual timing override",
    detail: "Wait for the timing override request to finish before exiting.",
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      lookupSequenceRef.current += 1;
      lookupInFlightRef.current = false;
    };
  }, []);

  const hydrateOverride = useCallback(
    (preference: TriggerDelayPreference | null): void => {
      setOverrideDelay(
        preference ? String(preference.optimal_delay_seconds) : "",
      );
      setOverrideReason(preference?.reason ?? "");
      setOverrideErr(null);
      setOverrideReasonErr(null);
    },
    [],
  );

  const currentPair = pairFrom(subscriberId, eventName);
  const pairIsCurrent = state.resolved?.pair.key === currentPair.key;
  const baselineDelay = state.resolved?.preference
    ? String(state.resolved.preference.optimal_delay_seconds)
    : "";
  const baselineReason = state.resolved?.preference?.reason ?? "";
  const overrideDirty =
    state.resolved !== null &&
    (overrideDelay !== baselineDelay || overrideReason !== baselineReason);

  const performLookup = async (pair: LookupPair): Promise<void> => {
    if (lookupInFlightRef.current || saveOperation.promiseRef.current) return;
    lookupInFlightRef.current = true;
    const sequence = ++lookupSequenceRef.current;
    setState((previous) => ({
      ...previous,
      loading: true,
      error: null,
      stale: false,
    }));
    try {
      const response = await triggerDelayApi.getPreference({
        subscriberId: pair.subscriberId,
        eventName: pair.eventName,
      });
      if (!mountedRef.current || sequence !== lookupSequenceRef.current) return;
      if (response.error) {
        if (response.error.status === 404) {
          const resolved = { pair, preference: null };
          setState({ resolved, loading: false, error: null, stale: false });
          hydrateOverride(null);
          return;
        }
        setState((previous) => ({
          ...previous,
          loading: false,
          error: "The timing lookup failed.",
          stale: previous.resolved !== null,
        }));
        return;
      }
      const normalized = normalizeTriggerDelayPreference(response.data, pair);
      if (!normalized.ok) {
        setState((previous) => ({
          ...previous,
          loading: false,
          error: normalized.message,
          stale: previous.resolved !== null,
        }));
        return;
      }
      const preference = normalized.value;
      setState({
        resolved: { pair, preference },
        loading: false,
        error: null,
        stale: false,
      });
      hydrateOverride(preference);
    } catch {
      if (!mountedRef.current || sequence !== lookupSequenceRef.current) return;
      setState((previous) => ({
        ...previous,
        loading: false,
        error: "The timing lookup did not complete.",
        stale: previous.resolved !== null,
      }));
    } finally {
      if (sequence === lookupSequenceRef.current) {
        lookupInFlightRef.current = false;
      }
    }
  };

  const lookup = (): void => {
    const validation = delayLookupErrors({ subscriberId, eventName });
    setErrors(validation);
    if (
      Object.keys(validation).length > 0 ||
      saveOperation.promiseRef.current ||
      lookupInFlightRef.current
    )
      return;
    const pair = pairFrom(subscriberId, eventName);
    if (overrideDirty) {
      setPendingLookup(pair);
      return;
    }
    void performLookup(pair);
  };

  useEffect(() => {
    if (!canAdmin || !overrideDirty || saveOperation.active) return;
    return registerLifecycleGuard({
      id: "automations-trigger-delay-draft",
      label: "Manual timing override",
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : {
              level: "blocking",
              detail: "The manual timing override has unsaved local changes.",
            },
      discard: () => {
        setOverrideDelay(baselineDelay);
        setOverrideReason(baselineReason);
      },
    });
  }, [
    baselineDelay,
    baselineReason,
    canAdmin,
    overrideDirty,
    saveOperation.active,
  ]);

  const saveOverride = async (): Promise<void> => {
    const resolved = state.resolved;
    if (!resolved || !pairIsCurrent) {
      setOverrideErr(
        "Look up the current subscriber and event pair before saving",
      );
      return;
    }
    const parsed = parseDelaySeconds(overrideDelay);
    const reasonError = triggerDelayReasonError(overrideReason);
    setOverrideReasonErr(reasonError);
    if (!parsed.ok) {
      setOverrideErr(parsed.error);
      return;
    }
    if (reasonError) return;
    setOverrideErr(null);
    const pending = saveOperation.run(() =>
      triggerDelayApi.putPreference({
        subscriber_id: resolved.pair.subscriberId,
        event_name: resolved.pair.eventName,
        optimal_delay_seconds: parsed.seconds,
        reason: overrideReason.trim() || undefined,
      }),
    );
    if (!pending) return;
    try {
      const response = await pending;
      if (response.error) {
        toast.error({
          message: "Couldn't save manual timing override",
          detail: "Review secure service logs for the operational error.",
        });
        return;
      }
      const normalized = normalizeTriggerDelayPreference(
        response.data,
        resolved.pair,
      );
      if (!normalized.ok) {
        toast.error({
          message: "Couldn't verify the saved timing override",
          detail: normalized.message,
        });
        return;
      }
      if (mountedRef.current) {
        setState({
          resolved: { pair: resolved.pair, preference: normalized.value },
          loading: false,
          error: null,
          stale: false,
        });
        hydrateOverride(normalized.value);
      }
      toast.success("Manual timing override saved");
    } catch {
      toast.error({
        message: "Couldn't save manual timing override",
        detail: "The save request did not complete.",
      });
    }
  };

  return (
    <>
      <TriggerDelayView
        canAdmin={canAdmin}
        subscriberId={subscriberId}
        eventName={eventName}
        errors={errors}
        state={state}
        pairIsCurrent={pairIsCurrent}
        overrideDelay={overrideDelay}
        overrideReason={overrideReason}
        overrideError={overrideErr}
        overrideReasonError={overrideReasonErr}
        saving={saveOperation.active}
        available={boundary.available}
        unavailable={boundary.unavailable}
        onSubscriberIdChange={(value) => {
          if (!saveOperation.promiseRef.current && !lookupInFlightRef.current)
            setSubscriberId(value);
        }}
        onEventNameChange={(value) => {
          if (!saveOperation.promiseRef.current && !lookupInFlightRef.current)
            setEventName(value);
        }}
        onOverrideDelayChange={(value) => {
          if (
            pairIsCurrent &&
            !saveOperation.promiseRef.current &&
            !lookupInFlightRef.current
          )
            setOverrideDelay(value);
        }}
        onOverrideReasonChange={(value) => {
          if (
            pairIsCurrent &&
            !saveOperation.promiseRef.current &&
            !lookupInFlightRef.current
          ) {
            setOverrideReason(value);
            setOverrideReasonErr(null);
          }
        }}
        onLookup={lookup}
        onSave={() => void saveOverride()}
      />
      <ConfirmModal
        open={pendingLookup !== null}
        danger
        title="Discard the unsaved timing override?"
        description="Looking up another subscriber-event pair will replace the local override values you have not saved."
        confirmLabel="Discard and look up"
        onConfirm={() => {
          const pair = pendingLookup;
          setPendingLookup(null);
          hydrateOverride(state.resolved?.preference ?? null);
          if (pair) void performLookup(pair);
        }}
        onClose={() => setPendingLookup(null)}
      />
    </>
  );
}

function TriggerDelayView({
  canAdmin,
  subscriberId,
  eventName,
  errors,
  state,
  pairIsCurrent,
  overrideDelay,
  overrideReason,
  overrideError,
  overrideReasonError,
  saving,
  available,
  unavailable,
  onSubscriberIdChange,
  onEventNameChange,
  onOverrideDelayChange,
  onOverrideReasonChange,
  onLookup,
  onSave,
}: {
  canAdmin: boolean;
  subscriberId: string;
  eventName: string;
  errors: Record<string, string>;
  state: LookupState;
  pairIsCurrent: boolean;
  overrideDelay: string;
  overrideReason: string;
  overrideError: string | null;
  overrideReasonError: string | null;
  saving: boolean;
  available: string;
  unavailable: string;
  onSubscriberIdChange: (value: string) => void;
  onEventNameChange: (value: string) => void;
  onOverrideDelayChange: (value: string) => void;
  onOverrideReasonChange: (value: string) => void;
  onLookup: () => void;
  onSave: () => void;
}): ReactElement {
  return (
    <section
      id="manual-timing-overrides"
      className="automations-surface"
      aria-label="Manual timing overrides"
    >
      <SectionHeader
        title="Manual timing overrides"
        description="Inspect or store one explicit delay for a subscriber-event pair. Automatic learning and confidence scoring are not operational in this build."
        helpText="The available API stores a manual override keyed by subscriber ID and event name. Sample count and confidence are stored metadata; this page does not claim they were learned or universally enforced."
      />
      <div className="automations-boundary">
        <div>
          <span className="automations-boundary__label">Available</span>
          <strong>{available}</strong>
        </div>
        <div data-blocked="true">
          <span className="automations-boundary__label">Unavailable</span>
          <strong>{unavailable}</strong>
        </div>
      </div>
      <div className="automations-card">
        <form
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            onLookup();
          }}
        >
          <div className="automations-lookup-grid">
            <FormField
              label="Subscriber ID"
              required
              error={errors.subscriberId}
              help="Use the canonical UUID stored on the subscriber record."
            >
              <input
                type="text"
                value={subscriberId}
                disabled={saving || state.loading}
                onChange={(event) => onSubscriberIdChange(event.target.value)}
                placeholder="00000000-0000-0000-0000-000000000000"
                autoComplete="off"
              />
            </FormField>
            <FormField label="Event name" required error={errors.eventName}>
              <input
                type="text"
                value={eventName}
                disabled={saving || state.loading}
                maxLength={MAX_TRIGGER_DELAY_EVENT_NAME_BYTES}
                onChange={(event) => onEventNameChange(event.target.value)}
                placeholder="cart.abandoned"
                autoComplete="off"
              />
            </FormField>
            <div className="automations-field-action">
              <button
                type="submit"
                className="btn"
                disabled={state.loading || saving}
              >
                {state.loading ? "Looking up…" : "Look up pair"}
              </button>
            </div>
          </div>
        </form>
        {state.loading && !state.resolved ? (
          <p className="muted" role="status">
            Looking up the stored override…
          </p>
        ) : null}
        {state.error && !state.resolved ? (
          <div className="callout error" role="alert">
            {state.error} Retry, then review secure service logs if it persists.
          </div>
        ) : null}
        {state.error && state.stale && state.resolved ? (
          <div className="callout warning" role="status">
            The latest lookup failed: {state.error} The retained result belongs
            to <strong>{state.resolved.pair.eventName}</strong> for the
            previously resolved subscriber. Look up again before saving.
          </div>
        ) : null}
        {state.resolved ? (
          <ResolvedTimingOverride
            canAdmin={canAdmin}
            resolved={state.resolved}
            pairIsCurrent={pairIsCurrent}
            overrideDelay={overrideDelay}
            overrideReason={overrideReason}
            overrideError={overrideError}
            overrideReasonError={overrideReasonError}
            saving={saving}
            interactionLocked={saving || state.loading || !pairIsCurrent}
            onDelayChange={onOverrideDelayChange}
            onReasonChange={onOverrideReasonChange}
            onSave={onSave}
          />
        ) : state.error ? null : (
          <div className="automations-inline-empty">
            <strong>Enter an exact pair to inspect</strong>
            <span>
              No subscriber-wide recommendation is inferred from this tool.
            </span>
          </div>
        )}
        {!TRIGGER_DELAY_LEARNING_AVAILABLE ? (
          <p className="automations-footnote">
            Automatic learning is disabled by the release readiness boundary.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function ResolvedTimingOverride({
  canAdmin,
  resolved,
  pairIsCurrent,
  overrideDelay,
  overrideReason,
  overrideError,
  overrideReasonError,
  saving,
  interactionLocked,
  onDelayChange,
  onReasonChange,
  onSave,
}: {
  canAdmin: boolean;
  resolved: ResolvedPair;
  pairIsCurrent: boolean;
  overrideDelay: string;
  overrideReason: string;
  overrideError: string | null;
  overrideReasonError: string | null;
  saving: boolean;
  interactionLocked: boolean;
  onDelayChange: (value: string) => void;
  onReasonChange: (value: string) => void;
  onSave: () => void;
}): ReactElement {
  return (
    <div className="automations-resolved-panel">
      <div className="automations-resolved-panel__heading">
        <div>
          <span className="label">Resolved pair</span>
          <strong>{resolved.pair.eventName}</strong>
        </div>
        <span className={`badge ${resolved.preference ? "" : "warning"}`}>
          {resolved.preference ? "override stored" : "no override"}
        </span>
      </div>
      {!pairIsCurrent ? (
        <div className="callout warning" role="status">
          The inputs now describe a different pair. The retained result is
          read-only until you look up the current values.
        </div>
      ) : null}
      {resolved.preference ? (
        <PreferenceDetails preference={resolved.preference} />
      ) : (
        <p className="muted">
          No explicit override is stored. Downstream fallback behavior depends
          on consumer configuration and is not verified here.
        </p>
      )}
      {canAdmin ? (
        <div className="automations-override-editor">
          <div>
            <span className="label">
              {resolved.preference ? "Update override" : "Set override"}
            </span>
            <p>This is a manual value. It is not a learned recommendation.</p>
          </div>
          <div className="automations-override-grid">
            <FormField
              label="Delay (seconds)"
              error={overrideError}
              help={`0 to ${MAX_DELAY_SECONDS.toLocaleString()} (30 days).`}
            >
              <input
                type="number"
                min={0}
                max={MAX_DELAY_SECONDS}
                value={overrideDelay}
                disabled={interactionLocked}
                onChange={(event) => onDelayChange(event.target.value)}
              />
            </FormField>
            <FormField
              label="Operator reason (optional)"
              error={overrideReasonError}
              help="500 UTF-8 bytes maximum."
            >
              <input
                type="text"
                value={overrideReason}
                disabled={interactionLocked}
                maxLength={MAX_TRIGGER_DELAY_REASON_BYTES}
                onChange={(event) => onReasonChange(event.target.value)}
                placeholder="Manual override — VIP cadence"
                autoComplete="off"
              />
            </FormField>
            <div className="automations-field-action">
              <button
                type="button"
                className="btn btn-primary"
                disabled={interactionLocked || !pairIsCurrent}
                onClick={onSave}
              >
                {saving ? "Saving…" : "Save manual override"}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <p className="muted">
          Your role can inspect but not change manual overrides.
        </p>
      )}
    </div>
  );
}

function PreferenceDetails({
  preference,
}: {
  preference: TriggerDelayPreference;
}): ReactElement {
  const values = [
    ["Stored delay", fmtDelay(preference.optimal_delay_seconds)],
    ["Stored sample metadata", preference.sample_count.toLocaleString()],
    ["Stored confidence metadata", fmtConfidence(preference.confidence)],
    ["Computed timestamp", fmtRelative(preference.computed_at)],
  ];
  return (
    <div>
      <dl className="automations-definition-grid">
        {values.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {preference.reason ? (
        <p className="automations-footnote">
          Operator reason: {preference.reason}
        </p>
      ) : null}
    </div>
  );
}
