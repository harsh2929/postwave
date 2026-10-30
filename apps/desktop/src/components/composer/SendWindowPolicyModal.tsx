/**
 * SendWindowPolicyModal — coverage item #2's "Configure" affordance.
 *
 * Small policy editor over GET/PUT/DELETE /send-window. The policy is
 * tenant-wide (one row per tenant): a local-time window
 * (HH:MM..HH:MM), an IANA timezone, a weekday bitmap (Go time.Weekday
 * numbering — see send-checklist-helpers), and an enforcement tier
 * (warn / block / off).
 *
 * PUT and DELETE are admin-scoped (send_window.go mounts them behind
 * ScopeAdmin); the parent passes `canMutate` (write role) and the
 * modal additionally reads `useCanAdmin()` itself — the prop chain to
 * here runs through SendChecklist, and the admin dimension is global
 * store state, not per-campaign. Editors therefore see the form
 * read-only with persistent role guidance instead of a Save that always
 * fails with a 403.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { sendWindowApi } from "../../lib/api-client";
import { useCanAdmin } from "../../lib/store";
import { ConfirmModal } from "../ConfirmModal";
import { Modal, ModalFooter } from "../Modal";
import { Notice } from "../Notice";
import { Skeleton } from "../Skeleton";
import { toast } from "../Toast";
import {
  DEFAULT_WEEKDAY_BITMAP,
  WEEKDAY_LABELS,
  bitmapHasDay,
  toggleWeekday,
  validateSendWindowForm,
} from "../send-checklist-helpers";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Fired after a successful save or delete so the checklist row
   *  re-runs its verdict. */
  onChanged: () => void;
  canMutate: boolean;
}

interface SendWindowDraft {
  startLocal: string;
  endLocal: string;
  timezone: string;
  bitmap: number;
  enforcement: string;
}

function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  } catch {
    return "UTC";
  }
}

function defaultSendWindowDraft(): SendWindowDraft {
  return {
    startLocal: "09:00",
    endLocal: "17:00",
    timezone: localTimezone(),
    bitmap: DEFAULT_WEEKDAY_BITMAP,
    enforcement: "warn",
  };
}

const ENFORCEMENTS = [
  {
    id: "warn",
    label: "Warn",
    hint: "Sends outside the window warn but proceed",
  },
  {
    id: "block",
    label: "Block",
    hint: "Sends outside the window are rejected",
  },
  { id: "off", label: "Off", hint: "Policy stored but not enforced" },
] as const;

function useSendWindowPolicyController({
  open,
  onClose,
  onChanged,
  canMutate,
}: Props) {
  // PUT/DELETE /send-window are ScopeAdmin server-side — write role
  // alone isn't enough. Both dimensions gate every mutating control.
  const canAdmin = useCanAdmin();
  const canEdit = canMutate && canAdmin;
  const gateTitle = !canMutate
    ? "Viewer role can't change the send window"
    : "Changing the send window needs an admin role";

  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [hasPolicy, setHasPolicy] = useState(false);

  const [startLocal, setStartLocal] = useState("09:00");
  const [endLocal, setEndLocal] = useState("17:00");
  const [timezone, setTimezone] = useState("");
  const [bitmap, setBitmap] = useState(DEFAULT_WEEKDAY_BITMAP);
  const [enforcement, setEnforcement] = useState<string>("warn");

  const [formErr, setFormErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [removing, setRemoving] = useState(false);
  const activeRef = useRef(true);
  const openRef = useRef(open);
  const sessionRef = useRef(0);
  const loadSequenceRef = useRef(0);
  const loadFlightRef = useRef<Promise<void> | null>(null);
  const mutationFlightRef = useRef<Promise<void> | null>(null);
  const baselineRef = useRef<SendWindowDraft>(defaultSendWindowDraft());
  const permissionReasonId = useId();
  const weekdayLabelId = useId();
  const enforcementHelpId = useId();
  const policyStatusId = useId();
  openRef.current = open;

  const currentDraft = {
    startLocal,
    endLocal,
    timezone,
    bitmap,
    enforcement,
  };
  const dirty =
    !loading &&
    !loadErr &&
    JSON.stringify(currentDraft) !== JSON.stringify(baselineRef.current);
  const saveAvailable = canEdit && (!hasPolicy || dirty);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      sessionRef.current += 1;
      loadSequenceRef.current += 1;
      loadFlightRef.current = null;
      mutationFlightRef.current = null;
    };
  }, []);

  const load = useCallback((): Promise<void> => {
    if (loadFlightRef.current) return loadFlightRef.current;
    const requestId = ++loadSequenceRef.current;
    const requestSession = sessionRef.current;
    setLoading(true);
    setLoadErr(null);
    const request = (async (): Promise<void> => {
      await Promise.resolve();
      try {
        const res = await sendWindowApi.get();
        if (
          !activeRef.current ||
          !openRef.current ||
          requestId !== loadSequenceRef.current ||
          requestSession !== sessionRef.current
        ) {
          return;
        }
        if (res.error) {
          setLoadErr(res.error.message);
          return;
        }
        const policy = res.data.policy;
        setHasPolicy(policy != null);
        const next = policy
          ? {
              startLocal: policy.start_local.slice(0, 5),
              endLocal: policy.end_local.slice(0, 5),
              timezone: policy.timezone,
              bitmap: policy.weekday_bitmap,
              enforcement: policy.enforcement,
            }
          : defaultSendWindowDraft();
        setStartLocal(next.startLocal);
        setEndLocal(next.endLocal);
        setTimezone(next.timezone);
        setBitmap(next.bitmap);
        setEnforcement(next.enforcement);
        baselineRef.current = next;
      } catch (error) {
        if (
          activeRef.current &&
          openRef.current &&
          requestId === loadSequenceRef.current &&
          requestSession === sessionRef.current
        ) {
          setLoadErr(
            error instanceof Error && error.message
              ? error.message
              : "The send-window policy request failed.",
          );
        }
      } finally {
        if (
          activeRef.current &&
          requestId === loadSequenceRef.current &&
          requestSession === sessionRef.current
        ) {
          setLoading(false);
        }
        if (requestId === loadSequenceRef.current) {
          loadFlightRef.current = null;
        }
      }
    })();
    loadFlightRef.current = request;
    return request;
  }, []);

  useEffect(() => {
    sessionRef.current += 1;
    loadSequenceRef.current += 1;
    loadFlightRef.current = null;
    setConfirmDiscard(false);
    setConfirmRemove(false);
    setFormErr(null);
    if (!open) return;
    void load();
  }, [load, open]);

  const requestClose = (): void => {
    if (mutationFlightRef.current) return;
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };

  const finishMutation = (): void => {
    try {
      onChanged();
    } catch {
      // The server result is authoritative; consumer callback failures must
      // not relabel a completed mutation as a failed network request.
    }
    try {
      onClose();
    } catch {
      // The parent may already have unmounted or replaced this surface.
    }
  };

  const save = async (): Promise<void> => {
    if (mutationFlightRef.current) return mutationFlightRef.current;
    if (!canEdit) {
      setFormErr(gateTitle);
      return;
    }
    const err = validateSendWindowForm({ startLocal, endLocal, bitmap });
    if (err) {
      setFormErr(err);
      return;
    }
    const requestSession = sessionRef.current;
    const requestDraft = {
      ...currentDraft,
      timezone: timezone.trim() || "UTC",
    };
    setSaving(true);
    setFormErr(null);
    const request = (async (): Promise<void> => {
      await Promise.resolve();
      try {
        const res = await sendWindowApi.upsert({
          start_local: requestDraft.startLocal,
          end_local: requestDraft.endLocal,
          timezone: requestDraft.timezone,
          weekday_bitmap: requestDraft.bitmap,
          enforcement: requestDraft.enforcement,
        });
        if (
          !activeRef.current ||
          !openRef.current ||
          requestSession !== sessionRef.current
        ) {
          return;
        }
        if (res.error) {
          setFormErr(res.error.message);
          return;
        }
        baselineRef.current = requestDraft;
        toast.success("Send-window policy saved");
        finishMutation();
      } catch (error) {
        if (activeRef.current && requestSession === sessionRef.current) {
          setFormErr(
            error instanceof Error && error.message
              ? error.message
              : "The send-window policy could not be saved.",
          );
        }
      } finally {
        if (activeRef.current && requestSession === sessionRef.current) {
          setSaving(false);
        }
        mutationFlightRef.current = null;
      }
    })();
    mutationFlightRef.current = request;
    return request;
  };

  const remove = async (): Promise<void> => {
    if (mutationFlightRef.current) return mutationFlightRef.current;
    if (!canEdit) {
      setConfirmRemove(false);
      setFormErr(gateTitle);
      return;
    }
    const requestSession = sessionRef.current;
    setRemoving(true);
    const request = (async (): Promise<void> => {
      await Promise.resolve();
      try {
        const res = await sendWindowApi.remove();
        if (
          !activeRef.current ||
          !openRef.current ||
          requestSession !== sessionRef.current
        ) {
          return;
        }
        if (res.error) {
          setConfirmRemove(false);
          setFormErr(`Couldn't remove policy: ${res.error.message}`);
          return;
        }
        baselineRef.current = currentDraft;
        toast.success("Send-window policy removed");
        finishMutation();
      } catch (error) {
        if (activeRef.current && requestSession === sessionRef.current) {
          setConfirmRemove(false);
          setFormErr(
            error instanceof Error && error.message
              ? `Couldn't remove policy: ${error.message}`
              : "The send-window policy could not be removed.",
          );
        }
      } finally {
        if (activeRef.current && requestSession === sessionRef.current) {
          setRemoving(false);
        }
        mutationFlightRef.current = null;
      }
    })();
    mutationFlightRef.current = request;
    return request;
  };

  return {
    bitmap,
    canEdit,
    confirmDiscard,
    confirmRemove,
    dirty,
    enforcement,
    enforcementHelpId,
    endLocal,
    formErr,
    gateTitle,
    hasPolicy,
    load,
    loadErr,
    loading,
    mutationFlightRef,
    onClose,
    open,
    permissionReasonId,
    policyStatusId,
    remove,
    removing,
    requestClose,
    save,
    saveAvailable,
    saving,
    setBitmap,
    setConfirmDiscard,
    setConfirmRemove,
    setEndLocal,
    setEnforcement,
    setFormErr,
    setStartLocal,
    setTimezone,
    startLocal,
    timezone,
    weekdayLabelId,
  };
}

type SendWindowPolicyController = ReturnType<
  typeof useSendWindowPolicyController
>;

function SendWindowPolicyConfirmations({
  controller,
}: {
  controller: SendWindowPolicyController;
}): ReactElement {
  const {
    confirmDiscard,
    confirmRemove,
    onClose,
    remove,
    removing,
    setConfirmDiscard,
    setConfirmRemove,
  } = controller;
  return (
    <>
      <ConfirmModal
        open={confirmRemove}
        title="Remove send-window policy?"
        description="Campaigns will be sendable at any time of day, any day of the week."
        confirmLabel={removing ? "Removing…" : "Remove policy"}
        danger
        busy={removing}
        onConfirm={remove}
        onClose={() => {
          if (!removing) setConfirmRemove(false);
        }}
      />
      <ConfirmModal
        open={confirmDiscard}
        title="Discard send-window changes?"
        description="The local time window, timezone, weekdays, or enforcement changes have not been saved."
        confirmLabel="Discard changes"
        danger
        onConfirm={() => {
          setConfirmDiscard(false);
          onClose();
        }}
        onClose={() => setConfirmDiscard(false)}
      />
    </>
  );
}

function SendWindowPolicySurface({
  controller,
}: {
  controller: SendWindowPolicyController;
}): ReactElement {
  const {
    bitmap,
    canEdit,
    dirty,
    enforcement,
    enforcementHelpId,
    endLocal,
    formErr,
    gateTitle,
    hasPolicy,
    load,
    loadErr,
    loading,
    mutationFlightRef,
    open,
    permissionReasonId,
    policyStatusId,
    removing,
    requestClose,
    save,
    saveAvailable,
    saving,
    setBitmap,
    setConfirmRemove,
    setEndLocal,
    setEnforcement,
    setFormErr,
    setStartLocal,
    setTimezone,
    startLocal,
    timezone,
    weekdayLabelId,
  } = controller;
  return (
    <>
      <Modal
        open={open}
        onClose={requestClose}
        title="Send window"
        description="Restrict when campaigns may go out. The window applies tenant-wide, in the policy's timezone."
      >
        {loading ? (
          <Skeleton lines={4} aria-label="Loading send-window policy" />
        ) : loadErr ? (
          <Notice
            tone="danger"
            title="Couldn't load the current policy"
            action={
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void load()}
              >
                Retry
              </button>
            }
          >
            {loadErr}
          </Notice>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (saveAvailable && !mutationFlightRef.current) {
                void save();
              } else if (!canEdit) {
                setFormErr(gateTitle);
              }
            }}
            onKeyDownCapture={(event) => {
              if (
                event.key === "Enter" &&
                (event.nativeEvent.isComposing || event.keyCode === 229)
              ) {
                event.preventDefault();
              }
            }}
          >
            {!canEdit ? (
              <Notice tone="warning" title="Read-only send window">
                <span id={permissionReasonId}>{gateTitle}.</span> You can review
                the active policy, including its timezone and enforcement.
              </Notice>
            ) : null}
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(min(100%, 12rem), 1fr))",
                gap: 8,
              }}
            >
              <div className="field">
                <label className="field-label" htmlFor="sw-start">
                  Start (local)
                </label>
                <input
                  id="sw-start"
                  type="time"
                  className="input"
                  value={startLocal}
                  onChange={(e) => {
                    setFormErr(null);
                    setStartLocal(e.target.value);
                  }}
                  disabled={!canEdit}
                  aria-describedby={!canEdit ? permissionReasonId : undefined}
                />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="sw-end">
                  End (local)
                </label>
                <input
                  id="sw-end"
                  type="time"
                  className="input"
                  value={endLocal}
                  onChange={(e) => {
                    setFormErr(null);
                    setEndLocal(e.target.value);
                  }}
                  disabled={!canEdit}
                  aria-describedby={!canEdit ? permissionReasonId : undefined}
                />
              </div>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="sw-tz">
                Timezone (IANA)
              </label>
              <input
                id="sw-tz"
                type="text"
                className="input mono"
                value={timezone}
                onChange={(e) => {
                  setFormErr(null);
                  setTimezone(e.target.value);
                }}
                placeholder="Europe/Stockholm"
                disabled={!canEdit}
                aria-describedby={!canEdit ? permissionReasonId : undefined}
              />
            </div>
            <div className="field">
              <span id={weekdayLabelId} className="field-label">
                Allowed weekdays
              </span>
              <div
                role="group"
                aria-labelledby={weekdayLabelId}
                style={{ display: "flex", gap: 4, flexWrap: "wrap" }}
              >
                {WEEKDAY_LABELS.map((label, day) => {
                  const on = bitmapHasDay(bitmap, day);
                  return (
                    <button
                      key={label}
                      type="button"
                      className="btn btn-sm"
                      aria-pressed={on}
                      onClick={() => {
                        if (canEdit && !mutationFlightRef.current) {
                          setFormErr(null);
                          setBitmap(toggleWeekday(bitmap, day));
                        }
                      }}
                      disabled={saving || removing}
                      aria-disabled={!canEdit || saving || removing}
                      aria-describedby={
                        !canEdit ? permissionReasonId : undefined
                      }
                      style={{
                        background: on ? "var(--pw-fg)" : "transparent",
                        color: on ? "var(--pw-bg)" : "var(--pw-fg-muted)",
                        fontWeight: on ? 600 : 400,
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="sw-enforcement">
                Enforcement
              </label>
              <select
                id="sw-enforcement"
                className="input"
                value={enforcement}
                onChange={(e) => {
                  setFormErr(null);
                  setEnforcement(e.target.value);
                }}
                disabled={!canEdit}
                aria-describedby={[
                  enforcementHelpId,
                  !canEdit ? permissionReasonId : null,
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {ENFORCEMENTS.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.label} — {e.hint}
                  </option>
                ))}
              </select>
              <div id={enforcementHelpId} className="field-help">
                {ENFORCEMENTS.find((e) => e.id === enforcement)?.hint}
              </div>
            </div>
            <div
              id={policyStatusId}
              className="muted"
              role="status"
              style={{ fontSize: 12 }}
            >
              {dirty
                ? "Unsaved send-window changes. Save the policy or cancel and explicitly discard them."
                : hasPolicy
                  ? "Showing the saved tenant-wide send-window policy."
                  : "No policy is saved yet; campaigns can currently send at any time."}
              {hasPolicy
                ? " Removing it makes campaigns sendable at any time of day, on any weekday."
                : ""}
            </div>
            {formErr ? (
              <div className="field-error" role="alert">
                {formErr}
              </div>
            ) : null}
            <ModalFooter>
              {hasPolicy ? (
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => {
                    if (canEdit && !mutationFlightRef.current) {
                      setConfirmRemove(true);
                    } else if (!canEdit) {
                      setFormErr(gateTitle);
                    }
                  }}
                  disabled={saving || removing}
                  aria-disabled={!canEdit || saving || removing}
                  aria-describedby={
                    !canEdit ? permissionReasonId : policyStatusId
                  }
                >
                  Remove policy
                </button>
              ) : null}
              <span className="spacer" style={{ flex: 1 }} />
              <button
                type="button"
                className="btn"
                onClick={requestClose}
                disabled={saving || removing}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={saving || removing}
                aria-disabled={!saveAvailable || saving || removing}
                aria-describedby={
                  !canEdit ? permissionReasonId : policyStatusId
                }
              >
                {saving
                  ? "Saving…"
                  : hasPolicy
                    ? "Save policy"
                    : "Create policy"}
              </button>
            </ModalFooter>
          </form>
        )}
      </Modal>

      <SendWindowPolicyConfirmations controller={controller} />
    </>
  );
}

export function SendWindowPolicyModal(props: Props): ReactElement {
  const controller = useSendWindowPolicyController(props);
  return <SendWindowPolicySurface controller={controller} />;
}
