import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  blocklistAutoSuppressApi,
  type BlocklistAutoSuppressState,
} from "../../lib/api-client";
import { useCanAdmin } from "../../lib/store";
import { ConfirmModal } from "../ConfirmModal";
import { Icon } from "../Icon";
import { toast } from "../Toast";
import { formatWhen } from "./remediation-helpers";
import { parseAutoSuppressState } from "./settings-response-contract";

interface SettingReceipt {
  enabled: boolean;
  at: string;
}

export function BlocklistAutoSuppressCard(): ReactElement {
  const canAdmin = useCanAdmin();
  const toggleId = useId();
  const toggleDescriptionId = useId();
  const [state, setState] = useState<BlocklistAutoSuppressState | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingValue, setPendingValue] = useState<boolean | null>(null);
  const [receipt, setReceipt] = useState<SettingReceipt | null>(null);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const saveInFlightRef = useRef(false);
  const toggleRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!mountedRef.current) return;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setFailed(false);
    try {
      const result = await blocklistAutoSuppressApi.get();
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      const parsed = result.error ? null : parseAutoSuppressState(result.data);
      if (parsed) setState(parsed);
      else setFailed(true);
    } catch {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setFailed(true);
      }
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, [load]);

  const save = async (): Promise<void> => {
    if (
      !canAdmin ||
      pendingValue === null ||
      !state ||
      loading ||
      saveInFlightRef.current
    ) {
      return;
    }
    const nextValue = pendingValue;
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      const result = await blocklistAutoSuppressApi.set(nextValue);
      if (!mountedRef.current) return;
      const stored = result.error ? null : parseAutoSuppressState(result.data);
      if (!stored || stored.auto_suppress !== nextValue) {
        toast.error("The auto-containment change was not confirmed.");
        return;
      }
      setState(stored);
      setReceipt({ enabled: stored.auto_suppress, at: stored.observed_at });
      setPendingValue(null);
      toast.success(
        stored.auto_suppress
          ? "Blocklist auto-containment enabled"
          : "Blocklist auto-containment disabled",
      );
    } catch {
      if (mountedRef.current) {
        toast.error("The auto-containment change could not be confirmed.");
      }
    } finally {
      saveInFlightRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };

  const enabled = state?.auto_suppress === true;
  const changingToEnabled = pendingValue === true;

  return (
    <section
      className="card dhw-auto-containment"
      aria-labelledby="dhw-auto-containment-title"
    >
      <header>
        <span>
          <Icon name="shield-check" size={17} />
        </span>
        <div>
          <small>Workspace policy</small>
          <h3 id="dhw-auto-containment-title">Blocklist auto-containment</h3>
        </div>
        {state ? (
          <span className="dhw-auto-containment-state" data-enabled={enabled}>
            {enabled ? "Configured on" : "Configured off"}
          </span>
        ) : null}
      </header>

      <p className="dhw-auto-containment-summary">
        The workspace worker checks once per minute for newly qualifying domains
        or dedicated IPs. Active decisions are enforced by the send loop; this
        setting records desired policy, not worker-health proof.
      </p>

      {failed ? (
        <div className="dhw-auto-containment-error" role="alert">
          <Icon name="alert-triangle" size={16} />
          <span>
            The stored policy and current impact could not be verified.
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void load()}
            disabled={loading}
          >
            Retry
          </button>
        </div>
      ) : null}

      {loading && !state ? (
        <div className="dhw-auto-containment-skeleton" aria-busy="true">
          <div className="skel" />
          <div className="skel" />
          <span className="visually-hidden" role="status">
            Loading blocklist auto-containment policy
          </span>
        </div>
      ) : state ? (
        <>
          <dl>
            <div data-tone={state.eligible_now > 0 ? "warning" : "neutral"}>
              <dt>Qualifying, not yet contained</dt>
              <dd>{state.eligible_now.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Active blocklist suppressions</dt>
              <dd>{state.active_suppressions.toLocaleString()}</dd>
            </div>
          </dl>

          <div className="dhw-auto-containment-toggle">
            <input
              id={toggleId}
              ref={toggleRef}
              type="checkbox"
              checked={enabled}
              disabled={!canAdmin || loading || saving}
              aria-describedby={toggleDescriptionId}
              onChange={(event) => setPendingValue(event.target.checked)}
            />
            <span>
              <label htmlFor={toggleId}>
                Automatically contain new qualifying hits
              </label>
              <small id={toggleDescriptionId}>
                {enabled
                  ? "New qualifying subjects are picked up by the next worker sweep."
                  : "No new subject is automatically suppressed by this policy."}
              </small>
            </span>
          </div>

          <p className="dhw-auto-containment-observed">
            Evidence observed {formatWhen(state.observed_at)}. Turning this off
            never clears existing suppressions.
          </p>
        </>
      ) : null}

      {receipt ? (
        <div className="dhw-auto-containment-receipt" role="status">
          Policy {receipt.enabled ? "enabled" : "disabled"}{" "}
          {formatWhen(receipt.at)}. The server confirmed the stored workspace
          setting.
        </div>
      ) : null}

      {!canAdmin ? (
        <p className="dhw-auto-containment-permission">
          Admin access is required to change this workspace policy.
        </p>
      ) : null}

      <ConfirmModal
        open={pendingValue !== null}
        title={
          changingToEnabled
            ? "Enable automatic blocklist containment?"
            : "Disable automatic blocklist containment?"
        }
        description={
          changingToEnabled
            ? "The next worker sweep can create sending-pool suppressions for every currently qualifying subject."
            : "New qualifying blocklist evidence will no longer create automatic suppressions. Existing suppressions remain active."
        }
        confirmLabel={
          changingToEnabled ? "Enable containment" : "Disable containment"
        }
        typeToConfirm={
          changingToEnabled
            ? "ENABLE AUTOMATIC CONTAINMENT"
            : "DISABLE AUTOMATIC CONTAINMENT"
        }
        danger={!changingToEnabled}
        busy={saving}
        returnFocusRef={toggleRef}
        onClose={() => setPendingValue(null)}
        onConfirm={save}
      >
        <div className="dhw-repair-confirmation">
          <strong>Current server-derived impact</strong>
          <ul>
            <li>
              {state?.eligible_now.toLocaleString() ?? "Unknown"} qualifying
              subject{state?.eligible_now === 1 ? "" : "s"} are not currently
              contained.
            </li>
            <li>
              {state?.active_suppressions.toLocaleString() ?? "Unknown"} active
              suppression{state?.active_suppressions === 1 ? "" : "s"} remain in
              force whether this policy is on or off.
            </li>
            <li>
              Observation evidence can change before the next one-minute sweep;
              no send or inbox outcome is guaranteed here.
            </li>
          </ul>
        </div>
      </ConfirmModal>
    </section>
  );
}
