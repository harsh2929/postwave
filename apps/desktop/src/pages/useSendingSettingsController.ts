import { useCallback, useEffect, useRef, useState } from "react";

import { toast } from "../components/Toast";
import {
  useExistingSettingLifecycle,
  useSingleFlightOperation,
} from "../hooks/useSettingsDraftLifecycle";
import {
  useRemoteResource,
  type RemoteLoadResult,
  type RemoteResourceController,
} from "../hooks/useRemoteResource";
import { registerLifecycleGuard } from "../lib/lifecycle-coordinator";
import {
  getApiUrl,
  sendingSettingsApi,
  type ApiResult,
  type SendingSettings,
} from "../lib/api-client";
import { canonicalApiBaseUrl, DEMO_DATA_FALLBACK_ENABLED } from "../lib/config";
import { useCanAdmin, useMe, useRoleStatus } from "../lib/store";
import {
  EMPTY_SENDING_FORM,
  clearedSendingInput,
  formFromSendingSettings,
  parseSendingSettings,
  parseSendingStatus,
  sendingCapCoordinationProvesSettings,
  sendingFormIsDirty,
  sendingInputFromForm,
  sendingSettingsIsCanonicalNoRow,
  sendingSettingsRevision,
  sendingSettingsRevisionAdvances,
  validateSendingForm,
  type SendingFormErrors,
  type SendingFormState,
  type VerifiedSendingSettings,
  type VerifiedSendingStatus,
} from "./sending-settings-model";

const STATUS_POLL_MS = 30_000;
export const SENDING_SETTINGS_RECONCILIATION_QUIESCENCE_MS = 35_000;

export type SendingSettingsTab =
  | "overview"
  | "limits"
  | "frequency"
  | "identity";

export interface SendingSettingsController {
  canAdmin: boolean;
  roleStatus: ReturnType<typeof useRoleStatus>;
  accessDenialReason: "credential-identity-unverified" | null;
  readOnlyDemo: boolean;
  baseline: VerifiedSendingSettings | null;
  status: VerifiedSendingStatus | null;
  form: SendingFormState;
  fieldErrors: SendingFormErrors;
  dirty: boolean;
  saving: boolean;
  refreshing: boolean;
  mutationError: string | null;
  mutationUncertain: boolean;
  savedAt: string | null;
  pendingRemote: VerifiedSendingSettings | null;
  clearOpen: boolean;
  settingsResource: RemoteResourceController<VerifiedSendingSettings>;
  statusResource: RemoteResourceController<VerifiedSendingStatus>;
  setForm: (next: SendingFormState) => void;
  save: () => Promise<boolean>;
  discard: () => void;
  refresh: () => Promise<void>;
  openClear: () => void;
  closeClear: () => void;
  confirmClear: () => Promise<void>;
  adoptPendingRemote: () => void;
}

interface UncertainSubmission {
  owner: string;
  tenantID: string;
  kind: "save" | "clear";
  form: SendingFormState;
  baseline: VerifiedSendingSettings;
  dispatchedAtMonotonicMs: number;
}

function hasFreshCanonicalMutationRevision(
  submission: UncertainSubmission,
  remote: VerifiedSendingSettings,
): remote is VerifiedSendingSettings & { updated_at: string } {
  return sendingSettingsRevisionAdvances(
    submission.baseline.updated_at,
    remote.updated_at,
  );
}

function parseFailure(message: string): RemoteLoadResult<never> {
  return { error: { message, kind: "parse", code: "invalid_response" } };
}

async function loadSettings(
  expectedTenantID: string,
): Promise<RemoteLoadResult<VerifiedSendingSettings>> {
  if (!expectedTenantID) {
    return parseFailure(
      "The active workspace tenant is not resolved; no settings request was sent.",
    );
  }
  const result = await sendingSettingsApi.get();
  if (result.error) return { error: result.error };
  const parsed = parseSendingSettings(result.data);
  return parsed && parsed.tenant_id === expectedTenantID
    ? { data: parsed }
    : parseFailure(
        "The sending-settings response was invalid or did not match the active workspace.",
      );
}

async function loadStatus(
  expectedTenantID: string,
): Promise<RemoteLoadResult<VerifiedSendingStatus>> {
  if (!expectedTenantID) {
    return parseFailure(
      "The active workspace tenant is not resolved; no status request was sent.",
    );
  }
  const result = await sendingSettingsApi.status();
  if (result.error) return { error: result.error };
  const parsed = parseSendingStatus(result.data);
  return parsed && parsed.tenant_id === expectedTenantID
    ? { data: parsed }
    : parseFailure(
        "The sending-status response was invalid or did not match the active workspace.",
      );
}

function mutationFailure(
  error: Extract<ApiResult<unknown>, { error: unknown }>["error"],
): string {
  if (error.code === "sending_cap_change_in_progress") {
    return "Another sending-cap change is already in progress. No settings were written; wait a moment, then retry.";
  }
  if (error.code === "deliverability_throttle_active") {
    return "Deliverability protection currently owns the hourly cap. No settings were written; clear the repair override in Deliverability Hub before changing the cap.";
  }
  if (error.status === 409 || error.status === 412) {
    return "A newer settings version exists. Review the server changes before saving again.";
  }
  if (error.status === 401 || error.status === 403) {
    return "Your current session is not authorized to change sending settings.";
  }
  if (error.code === "offline") {
    return "You are offline. Nothing was sent, and your draft is still here.";
  }
  if (error.code === "identity_transition") {
    return "The workspace identity changed before anything was sent. Your draft is still here.";
  }
  if (error.kind === "network" || error.kind === "timeout") {
    return "The save could not be verified. Check the connection, then refresh before retrying.";
  }
  if ((error.status ?? 0) >= 500) {
    return "The service could not save these settings. Your draft is still here.";
  }
  return "The server rejected these settings. Review the fields and try again.";
}

function mutationOutcomeCanBeAmbiguous(
  error: Extract<ApiResult<unknown>, { error: unknown }>["error"],
  sendingCapOutcome?: string,
): boolean {
  if (error.code === "offline" || error.code === "identity_transition") {
    return false;
  }
  if ((error.status ?? 0) >= 400 && sendingCapOutcome === "not-committed") {
    return false;
  }
  // The route contract makes exact HTTP >=400 not-committed the sole
  // post-dispatch proof that a retry is safe. Any other returned failure,
  // including a proxy-generated 3xx/4xx, must retain a reconciliation hold.
  return true;
}

function clearedForm(current: VerifiedSendingSettings): SendingFormState {
  return {
    rateLimit: "",
    quietEnabled: false,
    start: "",
    end: "",
    timezone: "",
    perRecipient: current.quiet_hours_per_recipient,
  };
}

function firstInvalidField(errors: SendingFormErrors): string | null {
  if (errors.rateLimit) return "sending-hourly-cap";
  if (errors.start) return "sending-quiet-start";
  if (errors.end) return "sending-quiet-end";
  if (errors.timezone) return "sending-quiet-timezone";
  return null;
}

function focusField(id: string | null): void {
  if (!id || typeof document === "undefined") return;
  window.setTimeout(() => document.getElementById(id)?.focus(), 0);
}

export function useSendingSettingsController(): SendingSettingsController {
  const roleCanAdmin = useCanAdmin();
  const roleStatus = useRoleStatus();
  const me = useMe();
  // A key projection without its exact non-secret credential fingerprint
  // cannot own a draft or reconciliation receipt. Two rotated keys may share
  // the same actor label, tenant, role, and origin, so fail closed instead of
  // collapsing them into an "unverified-key" identity.
  const credentialIdentityVerified =
    me?.credentialSource !== "api-key" ||
    Boolean(me.credentialFingerprint?.trim());
  const canAdmin = roleCanAdmin && credentialIdentityVerified;
  const accessDenialReason =
    roleCanAdmin && !credentialIdentityVerified
      ? "credential-identity-unverified"
      : null;
  const accessResolved = roleStatus === "resolved";
  const tenantID = me?.tenant.trim() ?? "";
  const apiOrigin = canonicalApiBaseUrl(getApiUrl()) ?? "invalid-api-origin";
  // Drafts, reconciliation receipts, and in-flight mutation ownership belong
  // to the exact authenticated principal, not merely the tenant and a boolean
  // admin gate. Two admins in one workspace (or two API keys with the same
  // actor label) must never inherit or accept one another's local control-plane
  // intent during an identity transition.
  const identity = JSON.stringify([
    apiOrigin,
    tenantID || "no-tenant",
    me?.user.trim() || "no-user",
    me?.credentialSource ?? "unknown-auth",
    me?.credentialSource === "api-key"
      ? (me.credentialFingerprint ?? "unverified-key")
      : "session",
    me?.effectiveRole ?? "unresolved-role",
    canAdmin ? "admin" : "blocked",
  ]);
  const readOnlyDemo = DEMO_DATA_FALLBACK_ENABLED;
  const loadCurrentSettings = useCallback(
    () => loadSettings(tenantID),
    [tenantID],
  );
  const loadCurrentStatus = useCallback(() => loadStatus(tenantID), [tenantID]);

  const settingsResource = useRemoteResource(loadCurrentSettings, {
    identity,
    auto: accessResolved && canAdmin && tenantID.length > 0,
  });
  const statusResource = useRemoteResource(loadCurrentStatus, {
    identity,
    auto: accessResolved && canAdmin && tenantID.length > 0,
  });

  const previousIdentityRef = useRef(identity);
  const [baselineRecord, setBaselineRecord] =
    useState<VerifiedSendingSettings | null>(null);
  const [baselineOwner, setBaselineOwner] = useState("");
  const baseline =
    previousIdentityRef.current === identity && baselineOwner === identity
      ? baselineRecord
      : null;
  const [form, setFormState] = useState<SendingFormState>({
    ...EMPTY_SENDING_FORM,
  });
  const [fieldErrors, setFieldErrors] = useState<SendingFormErrors>({});
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [uncertainSubmission, setUncertainSubmission] =
    useState<UncertainSubmission | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [pendingRemote, setPendingRemote] =
    useState<VerifiedSendingSettings | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const formRef = useRef(form);
  const baselineRef = useRef(baseline);
  const identityRef = useRef(identity);
  const uncertainSubmissionRef = useRef(uncertainSubmission);
  formRef.current = form;
  baselineRef.current = baseline;
  identityRef.current = identity;
  uncertainSubmissionRef.current = uncertainSubmission;

  const operation = useSingleFlightOperation({
    ownerId: `sending-settings:${identity}`,
    label: "Sending settings update",
    detail:
      "Wait for the sending-settings request to finish before leaving Moosewave.",
  });

  useEffect(() => {
    if (previousIdentityRef.current === identity) return;
    previousIdentityRef.current = identity;
    setBaselineRecord(null);
    setBaselineOwner("");
    setFormState({ ...EMPTY_SENDING_FORM });
    setFieldErrors({});
    setPendingRemote(null);
    setClearOpen(false);
    setMutationError(null);
    setSavedAt(null);
    uncertainSubmissionRef.current = null;
    setUncertainSubmission(null);
  }, [identity]);

  const adopt = useCallback(
    (next: VerifiedSendingSettings): void => {
      setBaselineRecord(next);
      setBaselineOwner(identity);
      setFormState(formFromSendingSettings(next));
      setFieldErrors({});
      setMutationError(null);
      setPendingRemote(null);
      uncertainSubmissionRef.current = null;
      setUncertainSubmission(null);
    },
    [identity],
  );

  useEffect(() => {
    if (!accessResolved || !canAdmin) {
      setBaselineRecord(null);
      setBaselineOwner("");
      setPendingRemote(null);
      setClearOpen(false);
      setMutationError(null);
      setSavedAt(null);
      uncertainSubmissionRef.current = null;
      setUncertainSubmission(null);
      return;
    }
    const remote = settingsResource.data;
    if (!remote) return;
    // Verification reads are reconciled below. The generic adoption effect
    // must not clear an outcome receipt while shared cap convergence remains
    // unproven.
    if (uncertainSubmissionRef.current) return;
    const current = baselineRef.current;
    if (!current) {
      adopt(remote);
      return;
    }
    if (sendingSettingsRevision(current) === sendingSettingsRevision(remote)) {
      return;
    }
    if (sendingFormIsDirty(formRef.current, current)) {
      setPendingRemote((previous) =>
        previous &&
        sendingSettingsRevision(previous) === sendingSettingsRevision(remote)
          ? previous
          : remote,
      );
      return;
    }
    adopt(remote);
  }, [accessResolved, adopt, canAdmin, settingsResource.data]);

  useEffect(() => {
    if (!accessResolved || !canAdmin) return undefined;
    const poll = (): void => {
      if (
        document.visibilityState === "visible" &&
        statusResource.transport !== "loading"
      ) {
        void statusResource.reload();
      }
    };
    const timer = window.setInterval(poll, STATUS_POLL_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [
    accessResolved,
    canAdmin,
    statusResource.reload,
    statusResource.transport,
  ]);

  const dirty = sendingFormIsDirty(form, baseline);

  const setForm = useCallback((next: SendingFormState): void => {
    if (uncertainSubmissionRef.current) return;
    setFormState(next);
    setMutationError(null);
    setFieldErrors({});
  }, []);

  const discard = useCallback((): void => {
    if (uncertainSubmissionRef.current) return;
    const current = baselineRef.current;
    if (!current) return;
    setFormState(formFromSendingSettings(current));
    setFieldErrors({});
    if (!uncertainSubmissionRef.current) setMutationError(null);
  }, []);

  const acceptVerifiedSubmission = useCallback(
    (
      submission: UncertainSubmission,
      remote: VerifiedSendingSettings,
      successMessage: string,
    ): boolean => {
      if (
        identityRef.current !== submission.owner ||
        remote.tenant_id !== submission.tenantID ||
        !hasFreshCanonicalMutationRevision(submission, remote)
      ) {
        return false;
      }
      // A missing IP projection means this response could not verify the
      // current assignment. Never carry an older pool forward as if it were
      // part of this receipt; the follow-up GET may restore fresh evidence.
      const saved = remote;
      setBaselineRecord(saved);
      setBaselineOwner(submission.owner);
      if (
        submission.kind === "clear" ||
        JSON.stringify(formRef.current) === JSON.stringify(submission.form)
      ) {
        setFormState(formFromSendingSettings(saved));
      }
      setFieldErrors({});
      setMutationError(null);
      setPendingRemote(null);
      uncertainSubmissionRef.current = null;
      setUncertainSubmission(null);
      setSavedAt(saved.updated_at);
      if (submission.kind === "clear") setClearOpen(false);
      toast.success(successMessage);
      return true;
    },
    [],
  );

  const resolveSubmission = useCallback(
    (
      submission: UncertainSubmission,
      remote: VerifiedSendingSettings,
      remoteStatus: VerifiedSendingStatus | null,
      successMessage: string,
      absenceProofEligible: boolean,
    ):
      | "applied"
      | "not-applied"
      | "conflict"
      | "coordination-pending"
      | "revision-pending"
      | "superseded" => {
      if (identityRef.current !== submission.owner) return "superseded";
      const desiredMatches = !sendingFormIsDirty(submission.form, remote);
      const revisionAdvanced = hasFreshCanonicalMutationRevision(
        submission,
        remote,
      );
      const statusProvesRemote = Boolean(
        remoteStatus &&
        sendingCapCoordinationProvesSettings(remoteStatus, remote),
      );
      const exactCanonicalNoRow =
        sendingSettingsIsCanonicalNoRow(submission.baseline) &&
        sendingSettingsIsCanonicalNoRow(remote);
      // updated_at plus every policy field stored in the CAS row must still
      // match. The IP pool is an independently resolved, read-only projection
      // and may legitimately change while this CAS revision remains unchanged,
      // so it cannot prevent a post-quiescence proof of non-application.
      const exactPriorRevision =
        submission.baseline.updated_at !== null &&
        remote.updated_at === submission.baseline.updated_at &&
        remote.tenant_id === submission.baseline.tenant_id &&
        remote.max_sends_per_hour === submission.baseline.max_sends_per_hour &&
        remote.quiet_hours_start === submission.baseline.quiet_hours_start &&
        remote.quiet_hours_end === submission.baseline.quiet_hours_end &&
        remote.quiet_hours_tz === submission.baseline.quiet_hours_tz &&
        remote.quiet_hours_per_recipient ===
          submission.baseline.quiet_hours_per_recipient &&
        remote.fallback_hour_utc === submission.baseline.fallback_hour_utc;

      if (desiredMatches && revisionAdvanced) {
        if (statusProvesRemote) {
          return acceptVerifiedSubmission(submission, remote, successMessage)
            ? "applied"
            : "superseded";
        }
        uncertainSubmissionRef.current = submission;
        setUncertainSubmission(submission);
        setPendingRemote(null);
        setMutationError(
          "The settings are persisted, but shared sending-cap convergence is not yet verified. Sending admission remains conservatively protected. Refresh to verify before editing or leaving this workspace.",
        );
        return "coordination-pending";
      }

      if (revisionAdvanced) {
        uncertainSubmissionRef.current = null;
        setUncertainSubmission(null);
        setPendingRemote(remote);
        setMutationError(
          "The server has a different revision. Your draft is intact; review the newer version before saving again.",
        );
        return "conflict";
      }

      if (exactCanonicalNoRow || exactPriorRevision) {
        if (!absenceProofEligible) {
          uncertainSubmissionRef.current = submission;
          setUncertainSubmission(submission);
          setPendingRemote(null);
          setMutationError(
            "The prior state is visible, but the server mutation window has not quiesced. Wait at least 35 seconds from submission, then refresh before retrying.",
          );
          return "revision-pending";
        }
        if (!statusProvesRemote) {
          uncertainSubmissionRef.current = submission;
          setUncertainSubmission(submission);
          setPendingRemote(null);
          setMutationError(
            "The prior settings are visible after the mutation window, but shared sending-cap authority is not ready and matching. Refresh again before retrying.",
          );
          return "coordination-pending";
        }
        uncertainSubmissionRef.current = null;
        setUncertainSubmission(null);
        setPendingRemote(null);
        setMutationError(
          exactCanonicalNoRow
            ? "The canonical no-row state is verified after the mutation window and shared cap authority is ready. You can retry the change safely."
            : "The prior server revision is verified after the mutation window and shared cap authority is ready. You can retry the change safely.",
        );
        return "not-applied";
      }

      uncertainSubmissionRef.current = submission;
      setUncertainSubmission(submission);
      setPendingRemote(null);
      setMutationError(
        "The canonical revision does not prove either a later committed write or the exact prior state. Refresh to reconcile before editing or retrying.",
      );
      return "revision-pending";
    },
    [acceptVerifiedSubmission],
  );

  const reconcileAmbiguousMutation = useCallback(
    async (
      submission: UncertainSubmission,
      successMessage: string,
    ): Promise<boolean> => {
      // Eligibility is captured before either read is dispatched. A settings
      // snapshot started just before the deadline cannot become an absence
      // proof merely because the parallel status request completes after it.
      const absenceProofEligible =
        performance.now() - submission.dispatchedAtMonotonicMs >=
        SENDING_SETTINGS_RECONCILIATION_QUIESCENCE_MS;
      const [verified, verifiedStatus] = await Promise.all([
        settingsResource.reloadResult(),
        statusResource.reloadResult(),
      ]);
      if (identityRef.current !== submission.owner) return false;
      if (verified?.data) {
        const outcome = resolveSubmission(
          submission,
          verified.data,
          verifiedStatus?.data ?? null,
          successMessage,
          absenceProofEligible,
        );
        return outcome === "applied";
      }
      uncertainSubmissionRef.current = submission;
      setUncertainSubmission(submission);
      setMutationError(
        "The request outcome is unknown because the verification read also failed. Refresh to reconcile before editing or retrying.",
      );
      return false;
    },
    [resolveSubmission, settingsResource, statusResource],
  );

  const saveImpl = useCallback(async (): Promise<boolean> => {
    const current = baselineRef.current;
    if (!current || !canAdmin || readOnlyDemo) return false;
    if (uncertainSubmissionRef.current) {
      setMutationError(
        "Refresh to reconcile the previous request before saving again.",
      );
      return false;
    }
    const submitted = { ...formRef.current };
    const errors = validateSendingForm(submitted);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setMutationError("Fix the highlighted fields before saving.");
      focusField(firstInvalidField(errors));
      return false;
    }

    const submission: UncertainSubmission = {
      owner: identity,
      tenantID,
      kind: "save",
      form: submitted,
      baseline: current,
      dispatchedAtMonotonicMs: performance.now(),
    };

    setMutationError(null);
    let result: ApiResult<SendingSettings>;
    try {
      result = await sendingSettingsApi.put(
        sendingInputFromForm(submitted, current.updated_at),
      );
    } catch {
      return reconcileAmbiguousMutation(submission, "Sending settings saved");
    }
    if (identityRef.current !== submission.owner) return false;
    if (result.error) {
      const { error } = result;
      if (
        mutationOutcomeCanBeAmbiguous(
          error,
          result.responseMetadata?.sendingCapOutcome,
        )
      ) {
        return reconcileAmbiguousMutation(
          submission,
          "Sending settings saved and verified",
        );
      }
      const message = mutationFailure(error);
      setMutationError(message);
      if (
        (error.status === 409 || error.status === 412) &&
        error.code !== "sending_cap_change_in_progress" &&
        error.code !== "deliverability_throttle_active"
      ) {
        void settingsResource.reload();
      }
      toast.error({
        message: "Sending settings were not saved",
        detail: message,
      });
      return false;
    }
    const parsed = parseSendingSettings(result.data);
    if (
      !parsed ||
      !hasFreshCanonicalMutationRevision(submission, parsed) ||
      parsed.tenant_id !== submission.tenantID ||
      sendingFormIsDirty(submission.form, parsed)
    ) {
      return reconcileAmbiguousMutation(
        submission,
        "Sending settings saved and verified",
      );
    }
    if (
      !acceptVerifiedSubmission(submission, parsed, "Sending settings saved")
    ) {
      return false;
    }
    await Promise.all([settingsResource.reload(), statusResource.reload()]);
    return true;
  }, [
    acceptVerifiedSubmission,
    canAdmin,
    identity,
    readOnlyDemo,
    reconcileAmbiguousMutation,
    settingsResource,
    statusResource,
    tenantID,
  ]);

  const save = useCallback(async (): Promise<boolean> => {
    const request = operation.run(saveImpl);
    return request ? request : false;
  }, [operation, saveImpl]);

  useExistingSettingLifecycle({
    ownerId: `sending-settings:${identity}`,
    label: "Sending settings",
    dirty,
    operationRef: operation.promiseRef,
    save,
    discard,
    enabled:
      canAdmin &&
      !readOnlyDemo &&
      baseline !== null &&
      uncertainSubmission === null,
  });

  useEffect(() => {
    if (!uncertainSubmission) return undefined;
    return registerLifecycleGuard({
      id: `sending-settings-reconciliation:${identity}`,
      label: "Sending settings reconciliation",
      inspect: () => ({
        level: "blocking",
        detail:
          "Refresh and verify the sending-settings outcome against the shared cap authority before leaving this workspace.",
        canSave: false,
        canDiscard: false,
        canRecover: false,
      }),
    });
  }, [identity, uncertainSubmission]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!canAdmin) return;
    const submission = uncertainSubmissionRef.current;
    const absenceProofEligible = Boolean(
      submission &&
      performance.now() - submission.dispatchedAtMonotonicMs >=
        SENDING_SETTINGS_RECONCILIATION_QUIESCENCE_MS,
    );
    const [verified, verifiedStatus] = await Promise.all([
      settingsResource.reloadResult(),
      statusResource.reloadResult(),
    ]);
    if (!submission || identityRef.current !== submission.owner) return;
    if (verified?.data) {
      resolveSubmission(
        submission,
        verified.data,
        verifiedStatus?.data ?? null,
        submission.kind === "clear"
          ? "Hourly cap and quiet hours cleared and verified"
          : "Sending settings saved and verified",
        absenceProofEligible,
      );
      return;
    }
    setMutationError(
      "The request outcome is still unknown. Restore connectivity and refresh again before editing or retrying.",
    );
  }, [canAdmin, resolveSubmission, settingsResource, statusResource]);

  const confirmClear = useCallback(async (): Promise<void> => {
    const current = baselineRef.current;
    if (!current || !canAdmin || readOnlyDemo) return;
    if (uncertainSubmissionRef.current) {
      setMutationError(
        "Refresh to reconcile the previous request before clearing settings.",
      );
      return;
    }
    const submission: UncertainSubmission = {
      owner: identity,
      tenantID,
      kind: "clear",
      form: clearedForm(current),
      baseline: current,
      dispatchedAtMonotonicMs: performance.now(),
    };
    const request = operation.run(async (): Promise<boolean> => {
      setMutationError(null);
      let result: ApiResult<SendingSettings>;
      try {
        result = await sendingSettingsApi.put(clearedSendingInput(current));
      } catch {
        return reconcileAmbiguousMutation(
          submission,
          "Hourly cap and quiet hours cleared and verified",
        );
      }
      if (identityRef.current !== submission.owner) return false;
      if (result.error) {
        const { error } = result;
        if (
          mutationOutcomeCanBeAmbiguous(
            error,
            result.responseMetadata?.sendingCapOutcome,
          )
        ) {
          return reconcileAmbiguousMutation(
            submission,
            "Hourly cap and quiet hours cleared and verified",
          );
        }
        const message = mutationFailure(error);
        setMutationError(message);
        if (
          (error.status === 409 || error.status === 412) &&
          error.code !== "sending_cap_change_in_progress" &&
          error.code !== "deliverability_throttle_active"
        ) {
          void settingsResource.reload();
        }
        return false;
      }
      const parsed = parseSendingSettings(result.data);
      if (
        !parsed ||
        !hasFreshCanonicalMutationRevision(submission, parsed) ||
        parsed.tenant_id !== submission.tenantID ||
        sendingFormIsDirty(submission.form, parsed)
      ) {
        return reconcileAmbiguousMutation(
          submission,
          "Hourly cap and quiet hours cleared and verified",
        );
      }
      if (
        !acceptVerifiedSubmission(
          submission,
          parsed,
          "Hourly cap and quiet hours cleared",
        )
      ) {
        return false;
      }
      await Promise.all([settingsResource.reload(), statusResource.reload()]);
      return true;
    });
    if (request) await request;
  }, [
    acceptVerifiedSubmission,
    canAdmin,
    identity,
    operation,
    readOnlyDemo,
    reconcileAmbiguousMutation,
    settingsResource,
    statusResource,
    tenantID,
  ]);

  const adoptPendingRemote = useCallback((): void => {
    if (pendingRemote) adopt(pendingRemote);
  }, [adopt, pendingRemote]);

  return {
    canAdmin,
    roleStatus,
    accessDenialReason,
    readOnlyDemo,
    baseline,
    status: statusResource.data,
    form,
    fieldErrors,
    dirty,
    saving: operation.active,
    refreshing:
      settingsResource.transport === "loading" ||
      statusResource.transport === "loading",
    mutationError,
    mutationUncertain: uncertainSubmission !== null,
    savedAt,
    pendingRemote,
    clearOpen,
    settingsResource,
    statusResource,
    setForm,
    save,
    discard,
    refresh,
    openClear: () => {
      if (uncertainSubmissionRef.current) return;
      setMutationError(null);
      setClearOpen(true);
    },
    closeClear: () => {
      if (!operation.active) setClearOpen(false);
    },
    confirmClear,
    adoptPendingRemote,
  };
}
