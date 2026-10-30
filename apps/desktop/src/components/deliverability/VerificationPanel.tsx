import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { verificationApi } from "../../lib/api-client";
import {
  formatBalance,
  measuredSavingsRatio,
  type VerificationMode,
  type VerificationPolicy,
  type VerificationProvider,
  type VerificationStatus,
} from "../../lib/api/verification";
import { useCanAdmin, useRoleStatus } from "../../lib/store";
import { Notice, type NoticeTone } from "../Notice";
import {
  parseVerificationCredits,
  parseVerificationPolicy,
  parseVerificationProviders,
  type VerificationCreditsView,
  type VerificationProvidersView,
} from "./verification-response-contract";

import "../../styles-deliverability-controls.css";

const NUM = new Intl.NumberFormat();
const PCT = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
});

const MODES: readonly VerificationMode[] = ["off", "local", "full"];

const MODE_COPY: Record<VerificationMode, { label: string; help: string }> = {
  off: {
    label: "Off",
    help: "No verification runs at this checkpoint.",
  },
  local: {
    label: "Local · free",
    help: "Rejects syntax, DNS, tenant-blocked disposable domains, and abuse mailboxes. Built-in disposable and functional-role signals remain advisory.",
  },
  full: {
    label: "Full · uses credits",
    help: "Escalates unresolved addresses to the connected vendor. This can spend one credit per address.",
  },
};

const REJECT_STATUS_OPTIONS: readonly {
  status: Exclude<VerificationStatus, "valid">;
  label: string;
  help: string;
  caution?: boolean;
}[] = [
  {
    status: "invalid",
    label: "Invalid",
    help: "The mailbox cannot receive mail.",
  },
  {
    status: "spamtrap",
    label: "Spam trap",
    help: "Mailing it can damage sender reputation.",
  },
  {
    status: "abuse",
    label: "Abuse risk",
    help: "The address is associated with complaint activity.",
  },
  {
    status: "do_not_mail",
    label: "Do not mail",
    help: "The verifier advises against contact.",
  },
  {
    status: "catch_all",
    label: "Catch-all",
    help: "The domain accepts mail, but the exact mailbox is uncertain.",
    caution: true,
  },
  {
    status: "unknown",
    label: "Unknown",
    help: "No decisive verdict was available; this can include vendor outages.",
    caution: true,
  },
];

type LoadState = "loading" | "ready" | "error";
type ProviderDrafts = Partial<Record<VerificationProvider, string>>;

interface Feedback {
  tone: NoticeTone;
  title: string;
  body: string;
}

/**
 * Mirrors the server's tenant-local credential-id contract and catches common
 * live-secret shapes before a billable credential can enter an API payload.
 */
export function credentialRefError(raw: string): string | null {
  if (hasUnsafeCredentialCharacter(raw)) {
    return "Credential ID contains an invisible or control character.";
  }
  const value = raw.trim();
  if (!value) return "A credential ID is required.";
  if (value.length > 128) {
    return "Credential ID is too long (maximum 128 characters).";
  }

  const lowered = value.toLowerCase();
  const looksLikeKnownSecret =
    /^(?:sk[-_]|rk[-_]|sg\.|xox[a-z-]*|gh[pousr]_|github_pat_|akia|asia|aiza|whsec_|bearer\s|basic\s|eyj)/iu.test(
      lowered,
    ) ||
    value.startsWith("{") ||
    value.startsWith("[") ||
    /(?:api[_-]?key|password|access[_-]?token)\s*[:=]/iu.test(value);
  if (looksLikeKnownSecret) {
    return "That looks like a live secret. Choose the credential's tenant-local ID; the key itself must never be sent here.";
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value)) {
    return "Use a tenant-local ID containing only letters, numbers, dots, dashes, or underscores.";
  }
  return null;
}

function hasUnsafeCredentialCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      code <= 31 ||
      (code >= 127 && code <= 159) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x206f) ||
      code === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

export function VerificationPanel(): ReactElement {
  const canAdmin = useCanAdmin();
  const roleStatus = useRoleStatus();
  const authorized = roleStatus === "resolved" && canAdmin;

  const [providerData, setProviderData] =
    useState<VerificationProvidersView | null>(null);
  const [providerDrafts, setProviderDrafts] = useState<ProviderDrafts>({});
  const [selectedProvider, setSelectedProvider] =
    useState<VerificationProvider>("zerobounce");
  const [policy, setPolicy] = useState<VerificationPolicy | null>(null);
  const [policyDraft, setPolicyDraft] = useState<VerificationPolicy | null>(
    null,
  );
  const [credits, setCredits] = useState<VerificationCreditsView | null>(null);
  const [providerState, setProviderState] = useState<LoadState>("loading");
  const [policyState, setPolicyState] = useState<LoadState>("loading");
  const [creditsState, setCreditsState] = useState<LoadState>("loading");

  const [refError, setRefError] = useState<string | null>(null);
  const [providerBusy, setProviderBusy] = useState(false);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [providerFeedback, setProviderFeedback] = useState<Feedback | null>(
    null,
  );
  const [policyFeedback, setPolicyFeedback] = useState<Feedback | null>(null);
  const [fullModeAcknowledged, setFullModeAcknowledged] = useState(false);
  const [providerActivationAcknowledged, setProviderActivationAcknowledged] =
    useState(false);

  const mountedRef = useRef(false);
  const authorityEpochRef = useRef(0);
  const providerRequestRef = useRef(0);
  const policyRequestRef = useRef(0);
  const creditsRequestRef = useRef(0);
  const providerMutationRef = useRef(0);
  const policyMutationRef = useRef(0);
  const providerFlightRef = useRef(false);
  const policyFlightRef = useRef(false);
  const credentialInputRef = useRef<HTMLInputElement | null>(null);

  const loadProviders =
    useCallback(async (): Promise<VerificationProvidersView | null> => {
      if (!authorized || !mountedRef.current) return null;
      const requestId = ++providerRequestRef.current;
      setProviderState("loading");
      try {
        const result = await verificationApi.listProviders();
        if (!mountedRef.current || requestId !== providerRequestRef.current)
          return null;
        const parsed = result.error
          ? null
          : parseVerificationProviders(result.data);
        if (!parsed) {
          setProviderState("error");
          return null;
        }
        const drafts: ProviderDrafts = {};
        for (const provider of parsed.available) {
          drafts[provider] =
            parsed.providers.find((entry) => entry.provider === provider)
              ?.credential_ref ?? "";
        }
        const active = parsed.providers.find((entry) => entry.enabled);
        setProviderData(parsed);
        setProviderDrafts(drafts);
        setSelectedProvider(active?.provider ?? parsed.available[0]);
        setRefError(null);
        setProviderActivationAcknowledged(false);
        setProviderState("ready");
        return parsed;
      } catch {
        if (mountedRef.current && requestId === providerRequestRef.current) {
          setProviderState("error");
        }
        return null;
      }
    }, [authorized]);

  const loadPolicy =
    useCallback(async (): Promise<VerificationPolicy | null> => {
      if (!authorized || !mountedRef.current) return null;
      const requestId = ++policyRequestRef.current;
      setPolicyState("loading");
      try {
        const result = await verificationApi.getPolicy();
        if (!mountedRef.current || requestId !== policyRequestRef.current)
          return null;
        const parsed = result.error
          ? null
          : parseVerificationPolicy(result.data);
        if (!parsed) {
          setPolicyState("error");
          return null;
        }
        setPolicy(clonePolicy(parsed));
        setPolicyDraft(clonePolicy(parsed));
        setFullModeAcknowledged(false);
        setPolicyState("ready");
        return parsed;
      } catch {
        if (mountedRef.current && requestId === policyRequestRef.current) {
          setPolicyState("error");
        }
        return null;
      }
    }, [authorized]);

  const loadCredits =
    useCallback(async (): Promise<VerificationCreditsView | null> => {
      if (!authorized || !mountedRef.current) return null;
      const requestId = ++creditsRequestRef.current;
      setCreditsState("loading");
      try {
        const result = await verificationApi.credits(30);
        if (!mountedRef.current || requestId !== creditsRequestRef.current)
          return null;
        const parsed = result.error
          ? null
          : parseVerificationCredits(result.data);
        if (!parsed) {
          setCreditsState("error");
          return null;
        }
        setCredits(parsed);
        setCreditsState("ready");
        return parsed;
      } catch {
        if (mountedRef.current && requestId === creditsRequestRef.current) {
          setCreditsState("error");
        }
        return null;
      }
    }, [authorized]);

  useEffect(() => {
    mountedRef.current = true;
    authorityEpochRef.current += 1;
    if (authorized) {
      void Promise.all([loadProviders(), loadPolicy(), loadCredits()]);
    } else {
      setProviderData(null);
      setProviderDrafts({});
      setPolicy(null);
      setPolicyDraft(null);
      setCredits(null);
      setProviderFeedback(null);
      setPolicyFeedback(null);
      setRefError(null);
      setProviderBusy(false);
      setPolicyBusy(false);
      setProviderState("loading");
      setPolicyState("loading");
      setCreditsState("loading");
      providerFlightRef.current = false;
      policyFlightRef.current = false;
    }
    return () => {
      mountedRef.current = false;
      authorityEpochRef.current += 1;
      providerRequestRef.current += 1;
      policyRequestRef.current += 1;
      creditsRequestRef.current += 1;
      providerMutationRef.current += 1;
      policyMutationRef.current += 1;
      providerFlightRef.current = false;
      policyFlightRef.current = false;
    };
  }, [authorized, loadCredits, loadPolicy, loadProviders]);

  const activeProvider =
    providerData?.providers.find((entry) => entry.enabled) ?? null;
  const selectedConfig =
    providerData?.providers.find(
      (entry) => entry.provider === selectedProvider,
    ) ?? null;
  const credentialRef = providerDrafts[selectedProvider] ?? "";
  const switchingProvider = Boolean(
    activeProvider && activeProvider.provider !== selectedProvider,
  );
  const providerDirty = Boolean(
    providerData &&
    (!selectedConfig?.enabled ||
      credentialRef.trim() !== (selectedConfig?.credential_ref ?? "")),
  );
  const providerActionable =
    providerDirty || Boolean(selectedConfig?.has_error);

  const policyDirty = useMemo(
    () => Boolean(policy && policyDraft && !policiesEqual(policy, policyDraft)),
    [policy, policyDraft],
  );
  const fullModeSelected =
    policyDraft?.forms_mode === "full" || policyDraft?.import_mode === "full";
  const fullFormsSelected = policyDraft?.forms_mode === "full";
  const configuredFullMode =
    policy?.forms_mode === "full" || policy?.import_mode === "full";
  const connectingIntoFullMode = Boolean(
    providerState === "ready" &&
    !activeProvider &&
    configuredFullMode &&
    providerActionable,
  );
  const policyValidationError =
    policyDraft?.forms_reject_statuses.length === 0
      ? "Choose at least one refused verdict. An empty list is not saved because the server substitutes defaults."
      : null;

  const saveProvider = useCallback(async (): Promise<void> => {
    const validation = credentialRefError(credentialRef);
    setRefError(validation);
    if (validation) {
      credentialInputRef.current?.focus();
      return;
    }
    if (
      providerState !== "ready" ||
      !providerActionable ||
      providerFlightRef.current ||
      (connectingIntoFullMode && !providerActivationAcknowledged)
    ) {
      return;
    }

    const submittedProvider = selectedProvider;
    const submittedRef = credentialRef.trim();
    const submittedSettings = selectedConfig?.settings;
    const wasSwitch = switchingProvider;
    const mutationId = ++providerMutationRef.current;
    const authorityEpoch = authorityEpochRef.current;
    providerFlightRef.current = true;
    setProviderBusy(true);
    setProviderFeedback(null);
    try {
      const result = await verificationApi.saveProvider(submittedProvider, {
        credential_ref: submittedRef,
        enabled: true,
        ...(submittedSettings ? { settings: submittedSettings } : {}),
      });
      if (
        !mountedRef.current ||
        authorityEpoch !== authorityEpochRef.current ||
        mutationId !== providerMutationRef.current
      ) {
        return;
      }
      if (result.error) {
        const refreshed = await loadProviders();
        if (
          !mountedRef.current ||
          authorityEpoch !== authorityEpochRef.current ||
          mutationId !== providerMutationRef.current
        ) {
          return;
        }
        setProviderFeedback({
          tone: refreshed ? "warning" : "danger",
          title: refreshed
            ? "Provider change was not confirmed"
            : "Provider state is uncertain",
          body: refreshed
            ? "The authoritative provider state was re-read. Review it before submitting another change."
            : "The request did not produce a trustworthy receipt and the current provider state could not be verified. Editing is paused until a refresh succeeds.",
        });
        return;
      }

      const refreshed = await loadProviders();
      if (
        !mountedRef.current ||
        authorityEpoch !== authorityEpochRef.current ||
        mutationId !== providerMutationRef.current
      ) {
        return;
      }
      const confirmed = refreshed?.providers.find(
        (entry) => entry.provider === submittedProvider && entry.enabled,
      );
      if (!confirmed) {
        setProviderFeedback({
          tone: refreshed ? "danger" : "warning",
          title: refreshed
            ? "Provider activation was not confirmed"
            : "Change accepted; current state is unverified",
          body: refreshed
            ? "The authoritative settings do not confirm the requested active provider. Review them before another change."
            : "The change was accepted, but its refreshed state could not be read. Editing is paused until a refresh succeeds.",
        });
      } else if (confirmed.has_error) {
        setProviderFeedback({
          tone: "danger",
          title: "Provider health needs attention",
          body: "The saved provider reports a health failure. Full public-form verification remains fail-open; verify the workspace credential ID and provider account before relying on paid checks.",
        });
      } else {
        setProviderFeedback({
          tone: "success",
          title: wasSwitch ? "Active provider switched" : "Provider connected",
          body: "The active configuration and latest connection status were re-read from the server.",
        });
      }
      void loadCredits();
    } catch {
      if (
        mountedRef.current &&
        authorityEpoch === authorityEpochRef.current &&
        mutationId === providerMutationRef.current
      ) {
        const refreshed = await loadProviders();
        if (
          !mountedRef.current ||
          authorityEpoch !== authorityEpochRef.current ||
          mutationId !== providerMutationRef.current
        ) {
          return;
        }
        setProviderFeedback({
          tone: refreshed ? "warning" : "danger",
          title: refreshed
            ? "Provider change was not confirmed"
            : "Provider state is uncertain",
          body: refreshed
            ? "The authoritative provider state was re-read. Review it before submitting another change."
            : "The request ended without a trustworthy receipt and the current provider state could not be verified. Editing is paused until a refresh succeeds.",
        });
      }
    } finally {
      if (mutationId === providerMutationRef.current) {
        providerFlightRef.current = false;
        if (mountedRef.current) setProviderBusy(false);
      }
    }
  }, [
    connectingIntoFullMode,
    credentialRef,
    loadCredits,
    loadProviders,
    providerActionable,
    providerActivationAcknowledged,
    providerState,
    selectedConfig?.settings,
    selectedProvider,
    switchingProvider,
  ]);

  const savePolicy = useCallback(async (): Promise<void> => {
    if (
      !policyDraft ||
      !policyDirty ||
      policyValidationError ||
      policyState !== "ready" ||
      policyFlightRef.current ||
      (fullModeSelected && !fullModeAcknowledged)
    ) {
      return;
    }

    const submittedPolicy: VerificationPolicy = {
      forms_mode: policyDraft.forms_mode,
      forms_reject_statuses: orderedRejectStatuses(
        policyDraft.forms_reject_statuses,
      ),
      forms_suggest_typos: policyDraft.forms_suggest_typos ?? true,
      import_mode: policyDraft.import_mode,
    };
    const mutationId = ++policyMutationRef.current;
    const authorityEpoch = authorityEpochRef.current;
    policyFlightRef.current = true;
    setPolicyBusy(true);
    setPolicyFeedback(null);
    try {
      const result = await verificationApi.savePolicy(submittedPolicy);
      if (
        !mountedRef.current ||
        authorityEpoch !== authorityEpochRef.current ||
        mutationId !== policyMutationRef.current
      ) {
        return;
      }
      const parsed = result.error ? null : parseVerificationPolicy(result.data);
      if (!parsed) {
        const refreshed = await loadPolicy();
        if (
          !mountedRef.current ||
          authorityEpoch !== authorityEpochRef.current ||
          mutationId !== policyMutationRef.current
        ) {
          return;
        }
        setPolicyFeedback({
          tone: refreshed ? "warning" : "danger",
          title: refreshed
            ? "Save receipt was not verified"
            : "Policy state is uncertain",
          body: refreshed
            ? "The authoritative policy was re-read. Review it before submitting another change."
            : "Neither the save receipt nor the current policy could be verified. Editing is paused until a refresh succeeds.",
        });
        return;
      }
      setPolicy(clonePolicy(parsed));
      setPolicyDraft(clonePolicy(parsed));
      setFullModeAcknowledged(false);
      setPolicyFeedback({
        tone: "success",
        title: "Enforcement policy saved",
        body: "The controls now show the policy returned by the server.",
      });
    } catch {
      if (
        mountedRef.current &&
        authorityEpoch === authorityEpochRef.current &&
        mutationId === policyMutationRef.current
      ) {
        const refreshed = await loadPolicy();
        if (
          !mountedRef.current ||
          authorityEpoch !== authorityEpochRef.current ||
          mutationId !== policyMutationRef.current
        ) {
          return;
        }
        setPolicyFeedback({
          tone: refreshed ? "warning" : "danger",
          title: "Policy save was not confirmed",
          body: refreshed
            ? "The authoritative policy was re-read. Review it before retrying."
            : "The current policy could not be verified. Editing is paused until a refresh succeeds.",
        });
      }
    } finally {
      if (mutationId === policyMutationRef.current) {
        policyFlightRef.current = false;
        if (mountedRef.current) setPolicyBusy(false);
      }
    }
  }, [
    fullModeAcknowledged,
    fullModeSelected,
    loadPolicy,
    policyDirty,
    policyDraft,
    policyState,
    policyValidationError,
  ]);

  if (roleStatus === "loading") {
    return <VerificationLoading label="Loading verification permissions" />;
  }
  if (roleStatus !== "resolved") {
    return (
      <section className="verification-card">
        <Notice
          tone="warning"
          announcement="off"
          title="Verification permissions are unavailable"
        >
          Provider references, policy, and usage remain hidden until workspace
          authority can be verified.
        </Notice>
      </section>
    );
  }
  if (!canAdmin) {
    return (
      <section className="verification-card">
        <Notice tone="neutral" announcement="off" title="Admin access required">
          Provider references and enforcement policy can affect vendor billing
          and who is allowed to subscribe. They are available only to workspace
          admins.
        </Notice>
      </section>
    );
  }

  const providerControlsDisabled = providerBusy || providerState !== "ready";
  const policyControlsDisabled = policyBusy || policyState !== "ready";

  return (
    <div className="verification-stack">
      <section
        className="verification-card verification-card--connection"
        aria-labelledby="verification-provider-title"
      >
        <header className="verification-card-head">
          <div>
            <span className="verification-kicker">01 · Connection</span>
            <h3 id="verification-provider-title">Verification provider</h3>
          </div>
          <span
            className="verification-state-pill"
            data-state={
              providerState === "error"
                ? "attention"
                : providerDirty
                  ? "attention"
                  : activeProvider
                    ? "active"
                    : "idle"
            }
          >
            {providerState === "loading" && !providerData
              ? "Loading"
              : providerState === "error" && providerData
                ? "Last verified state"
                : providerDirty
                  ? "Unsaved draft"
                  : activeProvider
                    ? "Connected"
                    : "Local checks only"}
          </span>
        </header>
        <p className="verification-lede">
          Moosewave keeps mailbox probes away from your sending infrastructure.
          Connect a verifier with the opaque ID of a credential in this
          workspace; the server derives its vault path and the live key never
          belongs in this form or renderer state.
        </p>

        {providerState === "loading" && !providerData ? (
          <VerificationSectionLoading label="Loading provider settings" />
        ) : providerState === "error" && !providerData ? (
          <Notice
            tone="danger"
            title="Provider settings could not be verified"
            action={
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void loadProviders()}
              >
                Retry
              </button>
            }
          >
            Editing is paused so an unknown configuration cannot be overwritten.
          </Notice>
        ) : providerData ? (
          <>
            {providerState === "loading" ? (
              <Notice
                tone="info"
                announcement="polite"
                title="Refreshing authoritative connection state"
              >
                The last verified settings remain visible and read-only.
              </Notice>
            ) : providerState === "error" ? (
              <Notice
                tone="warning"
                title="Latest connection refresh failed"
                action={
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => {
                      setProviderFeedback(null);
                      void loadProviders();
                    }}
                  >
                    Refresh state
                  </button>
                }
              >
                The last verified settings remain visible. Editing is paused
                until the current server state is known.
              </Notice>
            ) : null}

            <fieldset
              className="verification-provider-picker"
              disabled={providerControlsDisabled}
            >
              <legend>Choose provider</legend>
              <div className="verification-provider-options">
                {providerData.available.map((provider) => {
                  const config = providerData.providers.find(
                    (entry) => entry.provider === provider,
                  );
                  return (
                    <label
                      key={provider}
                      className="verification-provider-option"
                      data-selected={selectedProvider === provider}
                    >
                      <span className="sr-only">
                        Verification provider option
                      </span>
                      <input
                        id={`verification-provider-${provider}`}
                        type="radio"
                        name="verification-provider"
                        value={provider}
                        checked={selectedProvider === provider}
                        onChange={() => {
                          setSelectedProvider(provider);
                          setRefError(null);
                          setProviderFeedback(null);
                          setProviderActivationAcknowledged(false);
                        }}
                      />
                      <span>
                        <strong>{providerName(provider)}</strong>
                        <small>
                          {config?.enabled
                            ? "Active provider"
                            : config
                              ? "Saved · inactive"
                              : "Not configured"}
                        </small>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div className="verification-field verification-field--credential">
              <label htmlFor="verification-credential-ref">
                Workspace credential ID for {providerName(selectedProvider)}
              </label>
              <input
                ref={credentialInputRef}
                id="verification-credential-ref"
                type="text"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={128}
                value={credentialRef}
                disabled={providerControlsDisabled}
                placeholder="verification-production"
                aria-invalid={refError ? "true" : undefined}
                aria-describedby={
                  refError
                    ? "verification-credential-help verification-credential-error"
                    : "verification-credential-help"
                }
                onBlur={() => setRefError(credentialRefError(credentialRef))}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setProviderDrafts((current) => ({
                    ...current,
                    [selectedProvider]: next,
                  }));
                  setRefError(null);
                  setProviderFeedback(null);
                  setProviderActivationAcknowledged(false);
                }}
              />
              <p
                id="verification-credential-help"
                className="verification-help"
              >
                An opaque ID from this workspace's credential vault. Maximum 128
                characters; never paste an API key or global vault path.
              </p>
              {refError ? (
                <p
                  id="verification-credential-error"
                  className="verification-field-error"
                  role="alert"
                >
                  {refError}
                </p>
              ) : null}
            </div>

            {switchingProvider ? (
              <Notice
                tone="warning"
                announcement="off"
                title="Health check before atomic activation"
              >
                Saving asks the server to activate{" "}
                {providerName(selectedProvider)}
                {" and deactivate "}
                {providerName(activeProvider?.provider ?? selectedProvider)}
                {
                  " only after the new tenant credential resolves and its provider balance check succeeds. A failed check leaves the former configuration untouched."
                }
              </Notice>
            ) : null}

            {connectingIntoFullMode ? (
              <Notice
                tone="warning"
                announcement="off"
                title="This connection activates an existing full-mode policy"
              >
                <label className="verification-acknowledgement">
                  <input
                    type="checkbox"
                    checked={providerActivationAcknowledged}
                    disabled={providerControlsDisabled}
                    onChange={(event) =>
                      setProviderActivationAcknowledged(
                        event.currentTarget.checked,
                      )
                    }
                  />
                  <span>
                    I understand unresolved addresses can begin consuming vendor
                    credits immediately, and public-form checks fail open during
                    a provider outage.
                  </span>
                </label>
              </Notice>
            ) : null}

            <dl className="verification-provider-status">
              <div>
                <dt>Active provider</dt>
                <dd>
                  {activeProvider
                    ? providerName(activeProvider.provider)
                    : "None · local tier"}
                </dd>
              </div>
              <div>
                <dt>Reported balance</dt>
                <dd>
                  {activeProvider
                    ? formatBalance(activeProvider.last_balance)
                    : "Not connected"}
                </dd>
              </div>
              <div>
                <dt>Last health check</dt>
                <dd>
                  {activeProvider?.last_balance_at
                    ? formatTimestamp(activeProvider.last_balance_at)
                    : "No verified check"}
                </dd>
              </div>
            </dl>

            {activeProvider?.has_error ? (
              <Notice tone="danger" title="Provider connection needs attention">
                The latest provider check failed. The raw vendor response is
                intentionally hidden; verify the credential ID and provider
                account before relying on paid checks.
              </Notice>
            ) : null}

            <div className="verification-actions verification-actions--split">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={providerControlsDisabled || !providerDirty}
                onClick={() => {
                  const drafts: ProviderDrafts = {};
                  for (const provider of providerData.available) {
                    drafts[provider] =
                      providerData.providers.find(
                        (entry) => entry.provider === provider,
                      )?.credential_ref ?? "";
                  }
                  setProviderDrafts(drafts);
                  setSelectedProvider(
                    activeProvider?.provider ?? providerData.available[0],
                  );
                  setRefError(null);
                  setProviderFeedback(null);
                  setProviderActivationAcknowledged(false);
                }}
              >
                Discard connection draft
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  providerControlsDisabled ||
                  !providerActionable ||
                  (connectingIntoFullMode && !providerActivationAcknowledged)
                }
                onClick={() => void saveProvider()}
              >
                {providerBusy
                  ? "Saving and checking…"
                  : switchingProvider
                    ? "Switch provider"
                    : selectedConfig?.has_error && !providerDirty
                      ? "Recheck provider"
                      : "Save provider"}
              </button>
            </div>
            {providerFeedback ? (
              <Notice
                tone={providerFeedback.tone}
                title={providerFeedback.title}
              >
                {providerFeedback.body}
              </Notice>
            ) : null}
          </>
        ) : null}
      </section>

      <section
        className="verification-card verification-card--policy"
        aria-labelledby="verification-policy-title"
      >
        <header className="verification-card-head">
          <div>
            <span className="verification-kicker">02 · Guardrails</span>
            <h3 id="verification-policy-title">
              Where verification is enforced
            </h3>
          </div>
          <span
            className="verification-state-pill"
            data-state={
              policyState === "error" || policyDirty ? "attention" : "active"
            }
          >
            {policyState === "loading" && !policyDraft
              ? "Loading"
              : policyState === "error" && policyDraft
                ? "Last verified state"
                : policyDirty
                  ? "Unsaved changes"
                  : "Authoritative policy"}
          </span>
        </header>
        <p className="verification-lede">
          Changes stay in a local draft until you save them. Full mode can spend
          credits; public-form verification deliberately fails open so a
          third-party outage cannot take signup offline.
        </p>

        {policyState === "loading" && !policyDraft ? (
          <VerificationSectionLoading label="Loading enforcement policy" />
        ) : policyState === "error" && !policyDraft ? (
          <Notice
            tone="danger"
            title="Enforcement policy could not be verified"
            action={
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void loadPolicy()}
              >
                Retry
              </button>
            }
          >
            Policy editing is paused until the current server state is known.
          </Notice>
        ) : policyDraft ? (
          <>
            {policyState === "loading" ? (
              <Notice
                tone="info"
                announcement="polite"
                title="Refreshing authoritative policy"
              >
                The last verified policy remains visible and read-only.
              </Notice>
            ) : policyState === "error" ? (
              <Notice
                tone="warning"
                title="Latest policy refresh failed"
                action={
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => {
                      setPolicyFeedback(null);
                      void loadPolicy();
                    }}
                  >
                    Refresh policy
                  </button>
                }
              >
                The last verified policy remains visible. Editing is paused
                until the current server state is known.
              </Notice>
            ) : null}

            <div className="verification-policy-grid">
              <div className="verification-field">
                <label htmlFor="verification-forms-mode">
                  Public signup forms
                </label>
                <select
                  id="verification-forms-mode"
                  value={policyDraft.forms_mode}
                  disabled={policyControlsDisabled}
                  onChange={(event) => {
                    const mode = event.currentTarget.value as VerificationMode;
                    setPolicyDraft((current) =>
                      current ? { ...current, forms_mode: mode } : current,
                    );
                    setFullModeAcknowledged(false);
                    setPolicyFeedback(null);
                  }}
                >
                  {policyOptions()}
                </select>
                <p className="verification-help">
                  {MODE_COPY[policyDraft.forms_mode].help}
                </p>
              </div>
              <div className="verification-field">
                <label htmlFor="verification-import-mode">Import commit</label>
                <select
                  id="verification-import-mode"
                  value={policyDraft.import_mode}
                  disabled={policyControlsDisabled}
                  onChange={(event) => {
                    const mode = event.currentTarget.value as VerificationMode;
                    setPolicyDraft((current) =>
                      current ? { ...current, import_mode: mode } : current,
                    );
                    setFullModeAcknowledged(false);
                    setPolicyFeedback(null);
                  }}
                >
                  {policyOptions()}
                </select>
                <p className="verification-help">
                  Import preview remains free. This mode applies only when an
                  operator commits the import.
                </p>
              </div>
            </div>

            <fieldset
              className="verification-rejection-fieldset"
              disabled={policyControlsDisabled}
              aria-describedby="verification-rejection-help"
            >
              <legend>Signup verdicts to refuse</legend>
              <p id="verification-rejection-help" className="verification-help">
                These verdicts apply to public forms when verification is on.
                Catch-all and unknown can include legitimate B2B addresses.
              </p>
              <div className="verification-status-options">
                {REJECT_STATUS_OPTIONS.map((option) => {
                  const checked = policyDraft.forms_reject_statuses.includes(
                    option.status,
                  );
                  return (
                    <label
                      key={option.status}
                      className="verification-status-option"
                      data-caution={option.caution || undefined}
                    >
                      <span className="sr-only">Signup refusal verdict</span>
                      <input
                        id={`verification-reject-${option.status}`}
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => {
                          const statuses = event.currentTarget.checked
                            ? [
                                ...policyDraft.forms_reject_statuses,
                                option.status,
                              ]
                            : policyDraft.forms_reject_statuses.filter(
                                (status) => status !== option.status,
                              );
                          setPolicyDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  forms_reject_statuses:
                                    orderedRejectStatuses(statuses),
                                }
                              : current,
                          );
                          setPolicyFeedback(null);
                        }}
                      />
                      <span>
                        <strong>{option.label}</strong>
                        <small>{option.help}</small>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <label className="verification-toggle-row">
              <span className="sr-only">Typo suggestion setting</span>
              <input
                id="verification-suggest-typos"
                type="checkbox"
                checked={policyDraft.forms_suggest_typos ?? true}
                disabled={policyControlsDisabled}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setPolicyDraft((current) =>
                    current
                      ? {
                          ...current,
                          forms_suggest_typos: checked,
                        }
                      : current,
                  );
                  setPolicyFeedback(null);
                }}
              />
              <span>
                <strong>Offer safe typo correction</strong>
                <small>
                  Suggest a corrected domain without silently changing the
                  visitor's address.
                </small>
              </span>
            </label>

            {policyValidationError ? (
              <Notice tone="danger" title="Policy draft needs attention">
                {policyValidationError}
              </Notice>
            ) : null}

            {fullModeSelected && policyDirty ? (
              <Notice
                tone="warning"
                announcement="off"
                title="Full mode changes cost and continuity behavior"
              >
                <ul className="verification-risk-list">
                  <li>
                    Unresolved addresses can consume one vendor credit each.
                  </li>
                  <li>
                    {fullFormsSelected
                      ? "Public forms accept the signup when the vendor is unavailable, then preserve the degraded verdict for operators."
                      : "Public-form fail-open behavior is unchanged unless its mode is also set to full."}
                  </li>
                </ul>
                <label className="verification-acknowledgement">
                  <input
                    type="checkbox"
                    checked={fullModeAcknowledged}
                    disabled={policyControlsDisabled}
                    onChange={(event) =>
                      setFullModeAcknowledged(event.currentTarget.checked)
                    }
                  />
                  <span>
                    I understand the credit cost and public-form fail-open
                    behavior described above.
                  </span>
                </label>
              </Notice>
            ) : null}
            {fullModeSelected &&
            providerState === "ready" &&
            !activeProvider ? (
              <Notice
                tone="info"
                announcement="off"
                title="No paid provider is connected"
              >
                Full mode currently performs only free local checks. Connecting
                a provider later activates the acknowledged credit-bearing step.
              </Notice>
            ) : null}

            <div className="verification-policy-receipt" aria-live="polite">
              <span>
                {policyDirty
                  ? "Draft differs from the server policy"
                  : "No unsaved policy changes"}
              </span>
              <small>
                {policy?.updated_at
                  ? `Server update ${formatTimestamp(policy.updated_at)}`
                  : "Default policy · no stored update timestamp"}
              </small>
            </div>

            <div className="verification-actions verification-actions--split">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={policyControlsDisabled || !policyDirty}
                onClick={() => {
                  setPolicyDraft(policy ? clonePolicy(policy) : null);
                  setFullModeAcknowledged(false);
                  setPolicyFeedback(null);
                }}
              >
                Discard policy changes
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  policyControlsDisabled ||
                  !policyDirty ||
                  Boolean(policyValidationError) ||
                  (fullModeSelected && !fullModeAcknowledged)
                }
                onClick={() => void savePolicy()}
              >
                {policyBusy ? "Saving policy…" : "Save enforcement policy"}
              </button>
            </div>
            {policyFeedback ? (
              <Notice tone={policyFeedback.tone} title={policyFeedback.title}>
                {policyFeedback.body}
              </Notice>
            ) : null}
          </>
        ) : null}
      </section>

      <section
        className="verification-card verification-card--credits"
        aria-labelledby="verification-credits-title"
      >
        <header className="verification-card-head">
          <div>
            <span className="verification-kicker">03 · Measured usage</span>
            <h3 id="verification-credits-title">Credits and savings</h3>
          </div>
          <span
            className="verification-state-pill"
            data-state={creditsState === "error" ? "attention" : "idle"}
          >
            {creditsState === "error" && credits
              ? "Last verified totals"
              : "Last 30 days"}
          </span>
        </header>
        <p className="verification-lede">
          These figures are observed accounting, not a forecast. Local checks
          and cached verdicts settle addresses before a vendor credit is used.
        </p>

        {creditsState === "loading" && !credits ? (
          <VerificationSectionLoading label="Loading measured credit usage" />
        ) : creditsState === "error" && !credits ? (
          <Notice
            tone="warning"
            title="Credit accounting is temporarily unavailable"
            action={
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void loadCredits()}
              >
                Retry
              </button>
            }
          >
            Provider and policy settings remain available; no usage value is
            inferred.
          </Notice>
        ) : credits ? (
          <>
            {creditsState === "loading" ? (
              <Notice
                tone="info"
                announcement="polite"
                title="Refreshing measured usage"
              >
                The last verified accounting remains visible.
              </Notice>
            ) : creditsState === "error" ? (
              <Notice
                tone="warning"
                title="Latest credit refresh failed"
                action={
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void loadCredits()}
                  >
                    Refresh usage
                  </button>
                }
              >
                The last verified totals remain visible; no missing period is
                inferred as zero.
              </Notice>
            ) : null}
            {credits.has_error ? (
              <Notice
                tone="warning"
                title="Latest provider balance check failed"
              >
                Historical measured usage remains visible. The raw provider
                error is intentionally not displayed.
              </Notice>
            ) : null}

            <dl className="verification-balance-strip">
              <div>
                <dt>Accounting provider</dt>
                <dd>
                  {credits.provider
                    ? providerName(credits.provider)
                    : "Local tier only"}
                </dd>
              </div>
              <div>
                <dt>Current reported balance</dt>
                <dd>{formatBalance(credits.balance)}</dd>
              </div>
              <div>
                <dt>Balance observed</dt>
                <dd>
                  {credits.balance_checked_at
                    ? formatTimestamp(credits.balance_checked_at)
                    : "Not available"}
                </dd>
              </div>
            </dl>

            <dl className="verification-stat-grid">
              <div>
                <dt>Addresses checked</dt>
                <dd>{NUM.format(credits.totals.verified)}</dd>
              </div>
              <div>
                <dt>Credits spent</dt>
                <dd>{NUM.format(credits.totals.credits_spent)}</dd>
              </div>
              <div>
                <dt>Settled by local checks</dt>
                <dd>{NUM.format(credits.totals.local_filtered)}</dd>
              </div>
              <div>
                <dt>Served from cache</dt>
                <dd>{NUM.format(credits.totals.cache_hits)}</dd>
              </div>
              <div className="verification-stat-highlight">
                <dt>Measured credits saved</dt>
                <dd>
                  {NUM.format(credits.totals.credits_saved)}
                  <small>
                    {PCT.format(measuredSavingsRatio(credits.totals))} of checks
                  </small>
                </dd>
              </div>
            </dl>
          </>
        ) : null}
      </section>
    </div>
  );
}

function VerificationLoading({ label }: { label: string }): ReactElement {
  return (
    <section className="verification-card" aria-busy="true">
      <VerificationSectionLoading label={label} />
    </section>
  );
}

function VerificationSectionLoading({
  label,
}: {
  label: string;
}): ReactElement {
  return (
    <div className="verification-loading" aria-busy="true">
      <span className="visually-hidden" role="status">
        {label}
      </span>
      <span aria-hidden="true" />
      <span aria-hidden="true" />
      <span aria-hidden="true" />
    </div>
  );
}

function providerName(provider: VerificationProvider): string {
  return provider === "zerobounce" ? "ZeroBounce" : "Kickbox";
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString()
    : "Unavailable";
}

function policyOptions(): ReactElement[] {
  return MODES.map((mode) => (
    <option key={mode} value={mode}>
      {MODE_COPY[mode].label}
    </option>
  ));
}

function clonePolicy(policy: VerificationPolicy): VerificationPolicy {
  return {
    ...policy,
    forms_reject_statuses: [...policy.forms_reject_statuses],
  };
}

function orderedRejectStatuses(
  statuses: readonly VerificationStatus[],
): VerificationStatus[] {
  const selected = new Set(statuses);
  return REJECT_STATUS_OPTIONS.map((option) => option.status).filter((status) =>
    selected.has(status),
  );
}

function policiesEqual(
  left: VerificationPolicy,
  right: VerificationPolicy,
): boolean {
  return (
    left.forms_mode === right.forms_mode &&
    left.import_mode === right.import_mode &&
    (left.forms_suggest_typos ?? true) ===
      (right.forms_suggest_typos ?? true) &&
    orderedRejectStatuses(left.forms_reject_statuses).join("|") ===
      orderedRejectStatuses(right.forms_reject_statuses).join("|")
  );
}
