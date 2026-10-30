import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";

import { useBlockingLifecycleOperation } from "../../hooks/useBlockingLifecycleOperation";
import { writeClipboardText } from "../../lib/clipboard";
import { registerLifecycleGuard } from "../../lib/lifecycle-coordinator";
import { ConfirmModal } from "../ConfirmModal";
import { FormField } from "../FormField";
import { Notice } from "../Notice";
import { toast } from "../Toast";
import {
  type DeliverabilityProviderConfig,
  deliverabilityHubApi,
} from "../../lib/api-client";
import { useCanAdmin, useRoleStatus } from "../../lib/store";
import {
  buildUpsertConfig,
  credentialRefValidationError,
  generateSecureWebhookToken,
  providerSecretState,
  providerSupportsMirror,
  webhookTokenValidationError,
} from "./provider-config-helpers";
import {
  parseMutationOk,
  parseProviderConfigs,
  parseProviderUpsert,
} from "./settings-response-contract";

const PROVIDERS = [
  "postmark",
  "mailgun",
  "ses",
  "sendgrid",
  "resend",
  "sparkpost",
  "mailersend",
  "mailchimp",
];

/** Tiny "Configured ✓ / Not set" pill — never reveals the secret itself. */
function SecretBadge({
  set,
  label,
}: {
  set: boolean;
  label: string;
}): ReactElement {
  return (
    <span
      className={`badge ${set ? "success" : ""}`}
      title={`${label}: ${set ? "configured" : "not set"}`}
    >
      {label}: {set ? "Configured ✓" : "Not set"}
    </span>
  );
}

export function ProviderConfigCard(): ReactElement {
  const canMutate = useCanAdmin();
  const roleStatus = useRoleStatus();
  const [rows, setRows] = useState<DeliverabilityProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [provider, setProvider] = useState("sendgrid");
  const [displayName, setDisplayName] = useState("");
  const [active, setActive] = useState(true);
  const [token, setToken] = useState("");
  const [generatedToken, setGeneratedToken] = useState(false);
  const [generatedTokenAcknowledged, setGeneratedTokenAcknowledged] =
    useState(false);
  const [credentialRef, setCredentialRef] = useState("");
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] =
    useState<DeliverabilityProviderConfig | null>(null);
  const [providerSwitchTarget, setProviderSwitchTarget] = useState<
    string | null
  >(null);
  const operationRef = useRef(false);
  const copyInFlightRef = useRef(false);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const instanceId = useId();
  const providerFieldId = `${instanceId}-provider`;
  const labelFieldId = `${instanceId}-label`;
  const tokenFieldId = `${instanceId}-token`;
  const credentialRefFieldId = `${instanceId}-credential-ref`;
  const activeFieldId = `${instanceId}-active`;
  const existing = useMemo(
    () => rows.find((row) => row.provider === provider),
    [rows, provider],
  );
  const existingState = providerSecretState(existing?.config);
  const dirty =
    displayName !== (existing?.display_name ?? "") ||
    active !== (existing?.active ?? true) ||
    token !== "" ||
    credentialRef !== "";
  const formBusy = saving || removingId !== null;
  const zeroizeDraft = useCallback((): void => {
    setDisplayName("");
    setActive(true);
    tokenRef.current = "";
    setToken("");
    setGeneratedToken(false);
    setGeneratedTokenAcknowledged(false);
    setCredentialRef("");
  }, []);
  useBlockingLifecycleOperation(
    `deliverability-provider-${instanceId}`,
    "Deliverability provider operation",
    formBusy,
  );
  useEffect(() => {
    if (!dirty || formBusy) return;
    return registerLifecycleGuard({
      id: `deliverability-provider-credential-draft-${instanceId}`,
      label: "Deliverability provider credentials",
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : {
              level: "blocking",
              detail:
                "Write-only provider credentials are not saved. Return to this card or explicitly discard them.",
              canDiscard: true,
            },
      discard: zeroizeDraft,
    });
  }, [dirty, formBusy, instanceId, zeroizeDraft]);

  const supportsMirror = providerSupportsMirror(provider);
  const tokenError = webhookTokenValidationError(token);
  const credentialRefError = supportsMirror
    ? credentialRefValidationError(credentialRef)
    : null;

  useEffect(() => {
    setDisplayName(existing?.display_name ?? "");
    setActive(existing?.active ?? true);
    tokenRef.current = "";
    setToken("");
    setGeneratedToken(false);
    setGeneratedTokenAcknowledged(false);
    setCredentialRef("");
  }, [
    existing?.active,
    existing?.display_name,
    existing?.id,
    existing?.updated_at,
    provider,
  ]);

  const load = useCallback(async (): Promise<void> => {
    if (!mountedRef.current) return;
    if (!canMutate) {
      setRows([]);
      setLoadError(null);
      setLoading(false);
      return;
    }
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await deliverabilityHubApi.providers();
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      if (res.error) {
        setLoadError("Provider connections could not be verified.");
        toast.error("Provider connections could not be verified.");
      } else {
        const parsed = parseProviderConfigs(res.data);
        if (parsed) {
          setRows(parsed);
        } else {
          setLoadError("The provider service returned malformed data.");
          toast.error("The provider service returned malformed data.");
        }
      }
    } catch {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setLoadError("Check your connection and retry.");
        toast.error(
          "Couldn't load providers. Check your connection and retry.",
        );
      }
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [canMutate]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, [load]);

  const save = async (): Promise<void> => {
    if (!canMutate || operationRef.current) return;
    // A brand-new row needs at least one secret; an edit may legitimately
    // only flip the active flag or relabel, so don't hard-require here when
    // a stored secret already exists.
    const hasStoredSecret =
      existingState.webhookTokenSet ||
      existingState.mirrorCredentialRefSet ||
      existingState.legacyApiKeySet;
    if (!token.trim() && !credentialRef.trim() && !hasStoredSecret) {
      toast.error(
        supportsMirror
          ? "Enter a webhook token or a vault credential reference"
          : "Webhook token is required",
      );
      return;
    }
    const credentialRefError = credentialRefValidationError(credentialRef);
    if (credentialRefError) {
      toast.error(credentialRefError);
      return;
    }
    operationRef.current = true;
    setSaving(true);
    try {
      const config = buildUpsertConfig({
        existing: existing?.config,
        webhookTokenInput: token,
        // A runtime-secret reference only applies to mirror-capable providers.
        credentialRefInput: supportsMirror ? credentialRef : "",
      });
      const res = await deliverabilityHubApi.upsertProvider({
        provider,
        display_name: displayName.trim(),
        active,
        config,
      });
      if (!mountedRef.current) return;
      if (res.error) {
        toast.error("The provider change could not be confirmed.");
        return;
      }
      if (!parseProviderUpsert(res.data)) {
        toast.error("The provider service returned malformed saved data.");
        return;
      }
      zeroizeDraft();
      toast.success("Provider saved");
      await load();
    } catch {
      if (mountedRef.current) {
        toast.error("Couldn't save provider. Check your connection and retry.");
      }
    } finally {
      operationRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };

  const remove = async (row: DeliverabilityProviderConfig): Promise<void> => {
    if (!canMutate || operationRef.current) return;
    operationRef.current = true;
    setRemovingId(row.id);
    try {
      const res = await deliverabilityHubApi.deleteProvider(row.id);
      if (!mountedRef.current) return;
      if (res.error) {
        toast.error("Provider removal could not be confirmed.");
        return;
      }
      if (!parseMutationOk(res.data)) {
        toast.error("The provider service did not confirm removal.");
        return;
      }
      setRemoveTarget(null);
      toast.success("Provider removed");
      await load();
    } catch {
      if (mountedRef.current) {
        toast.error(
          "Couldn't remove provider. Check your connection and retry.",
        );
      }
    } finally {
      operationRef.current = false;
      if (mountedRef.current) setRemovingId(null);
    }
  };

  const copyToken = async (): Promise<void> => {
    if (copyInFlightRef.current) return;
    copyInFlightRef.current = true;
    const copiedToken = tokenRef.current;
    try {
      const result = await writeClipboardText(copiedToken, {
        contentClass: "secret",
        label: "Webhook receiver token",
        clearIfUnchangedAfterMs: 60_000,
      });
      if (!mountedRef.current || tokenRef.current !== copiedToken) return;
      if (result.ok) {
        setGeneratedTokenAcknowledged(true);
        toast.success(
          "Token copied. Store it now; Moosewave cannot reveal it after save.",
        );
      } else {
        toast.error(result.message);
      }
    } catch {
      if (mountedRef.current && tokenRef.current === copiedToken) {
        toast.error("Couldn't copy the provider token.");
      }
    } finally {
      copyInFlightRef.current = false;
    }
  };

  if (roleStatus === "loading") {
    return (
      <div className="card" style={{ padding: 18 }} aria-busy="true">
        <div className="skel" style={{ width: 180, height: 14 }} />
        <span className="visually-hidden" role="status">
          Resolving provider administration access
        </span>
      </div>
    );
  }
  if (!canMutate) {
    return (
      <div className="card" style={{ padding: 18 }}>
        <Notice tone="neutral" announcement="off" title="Admin access required">
          Provider credentials and connection state are protected by the
          server’s admin scope. This workspace does not request them for the
          current role.
        </Notice>
      </div>
    );
  }

  return (
    <ProviderConfigView
      active={active}
      activeFieldId={activeFieldId}
      canMutate={canMutate}
      credentialRef={credentialRef}
      credentialRefError={credentialRefError}
      credentialRefFieldId={credentialRefFieldId}
      dirty={dirty}
      displayName={displayName}
      existingState={existingState}
      formBusy={formBusy}
      generatedToken={generatedToken}
      generatedTokenAcknowledged={generatedTokenAcknowledged}
      labelFieldId={labelFieldId}
      loading={loading}
      loadError={loadError}
      provider={provider}
      providerFieldId={providerFieldId}
      providerSwitchTarget={providerSwitchTarget}
      removeTarget={removeTarget}
      removingId={removingId}
      rows={rows}
      saving={saving}
      supportsMirror={supportsMirror}
      token={token}
      tokenError={tokenError}
      tokenFieldId={tokenFieldId}
      onCredentialRefChange={setCredentialRef}
      onActiveChange={setActive}
      onCopyToken={copyToken}
      onDisplayNameChange={setDisplayName}
      onGeneratedTokenAcknowledgedChange={setGeneratedTokenAcknowledged}
      onGeneratedTokenChange={setGeneratedToken}
      onReload={load}
      onProviderChange={setProvider}
      onProviderSwitchTargetChange={setProviderSwitchTarget}
      onRemove={remove}
      onRemoveTargetChange={setRemoveTarget}
      onSave={save}
      onTokenChange={(value) => {
        tokenRef.current = value;
        setToken(value);
      }}
      zeroizeDraft={zeroizeDraft}
    />
  );
}

interface ProviderConfigViewProps {
  active: boolean;
  activeFieldId: string;
  canMutate: boolean;
  credentialRef: string;
  credentialRefError: string | null;
  credentialRefFieldId: string;
  dirty: boolean;
  displayName: string;
  existingState: ReturnType<typeof providerSecretState>;
  formBusy: boolean;
  generatedToken: boolean;
  generatedTokenAcknowledged: boolean;
  labelFieldId: string;
  loading: boolean;
  loadError: string | null;
  provider: string;
  providerFieldId: string;
  providerSwitchTarget: string | null;
  removeTarget: DeliverabilityProviderConfig | null;
  removingId: string | null;
  rows: DeliverabilityProviderConfig[];
  saving: boolean;
  supportsMirror: boolean;
  token: string;
  tokenError: string | null;
  tokenFieldId: string;
  onCredentialRefChange: (value: string) => void;
  onActiveChange: (value: boolean) => void;
  onCopyToken: () => Promise<void>;
  onDisplayNameChange: (value: string) => void;
  onGeneratedTokenAcknowledgedChange: (value: boolean) => void;
  onGeneratedTokenChange: (value: boolean) => void;
  onReload: () => Promise<void>;
  onProviderChange: (value: string) => void;
  onProviderSwitchTargetChange: (value: string | null) => void;
  onRemove: (row: DeliverabilityProviderConfig) => Promise<void>;
  onRemoveTargetChange: (row: DeliverabilityProviderConfig | null) => void;
  onSave: () => Promise<void>;
  onTokenChange: (value: string) => void;
  zeroizeDraft: () => void;
}

function ProviderConfigView({
  active,
  activeFieldId,
  canMutate,
  credentialRef,
  credentialRefError,
  credentialRefFieldId,
  dirty,
  displayName,
  existingState,
  formBusy,
  generatedToken,
  generatedTokenAcknowledged,
  labelFieldId,
  loading,
  loadError,
  onCredentialRefChange,
  onActiveChange,
  onCopyToken,
  onDisplayNameChange,
  onGeneratedTokenAcknowledgedChange,
  onGeneratedTokenChange,
  onReload,
  onProviderChange,
  onProviderSwitchTargetChange,
  onRemove,
  onRemoveTargetChange,
  onSave,
  onTokenChange,
  provider,
  providerFieldId,
  providerSwitchTarget,
  removeTarget,
  removingId,
  rows,
  saving,
  supportsMirror,
  token,
  tokenError,
  tokenFieldId,
  zeroizeDraft,
}: ProviderConfigViewProps): ReactElement {
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontWeight: 600 }}>Provider config</div>
        <div className="muted" style={{ fontSize: 12 }}>
          Webhook tokens for bounce / complaint / unsubscribe / open / click
          receivers — plus a tenant-bound runtime-secret reference used to
          mirror suppressions from Mailchimp and SendGrid without storing raw
          sending credentials in provider configuration.
        </div>
      </div>

      {loadError ? (
        <Notice
          tone="danger"
          announcement="assertive"
          style={{ marginBottom: 10 }}
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void onReload()}
              disabled={loading}
            >
              Retry
            </button>
          }
        >
          Couldn&apos;t refresh providers: {loadError}
          {rows.length > 0 ? " Showing the last verified list." : ""}
        </Notice>
      ) : null}

      <div style={{ display: "grid", gap: 8 }}>
        <div className="row" style={{ gap: 8 }}>
          <div style={{ flex: 1 }}>
            <FormField label="Provider" htmlFor={providerFieldId}>
              <select
                id={providerFieldId}
                className="input"
                value={provider}
                disabled={!canMutate || formBusy}
                onChange={(e) => {
                  const nextProvider = e.target.value;
                  if (dirty) {
                    onProviderSwitchTargetChange(nextProvider);
                    return;
                  }
                  onProviderChange(nextProvider);
                }}
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
          <div style={{ flex: 1 }}>
            <FormField label="Label" htmlFor={labelFieldId}>
              <input
                id={labelFieldId}
                className="input"
                value={displayName}
                disabled={!canMutate || formBusy}
                placeholder="Production"
                onChange={(e) => onDisplayNameChange(e.target.value)}
              />
            </FormField>
          </div>
        </div>

        <FormField
          label="Webhook receiver token"
          htmlFor={tokenFieldId}
          error={tokenError}
          help={
            existingState.webhookTokenSet
              ? "A one-way token digest is stored — leave blank to keep it. The plaintext is never readable after save."
              : "High-entropy token the Moosewave edge receiver verifies on inbound callbacks. Configure the same value at the edge/provider boundary."
          }
        >
          <input
            id={tokenFieldId}
            className="input"
            type="password"
            autoComplete="new-password"
            value={token}
            disabled={!canMutate || formBusy}
            placeholder={
              existingState.webhookTokenSet
                ? "Leave blank to keep current token"
                : "Generate or enter at least 32 characters"
            }
            onChange={(e) => {
              onTokenChange(e.target.value);
              onGeneratedTokenChange(false);
              onGeneratedTokenAcknowledgedChange(false);
            }}
          />
        </FormField>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn ghost"
            disabled={!canMutate || formBusy}
            onClick={() => {
              try {
                onTokenChange(generateSecureWebhookToken());
                onGeneratedTokenChange(true);
                onGeneratedTokenAcknowledgedChange(false);
              } catch {
                toast.error(
                  "Secure random generation isn't available on this device.",
                );
              }
            }}
          >
            Generate 256-bit token
          </button>
          {token ? (
            <button
              type="button"
              className="btn ghost"
              disabled={formBusy}
              onClick={() => void onCopyToken()}
            >
              Copy token
            </button>
          ) : null}
        </div>
        {generatedToken && !generatedTokenAcknowledged ? (
          <div className="banner warning" role="status">
            This generated token is shown only until save. Copy it into your
            secure setup record or confirm that you stored it before saving.
            <div style={{ marginTop: 8 }}>
              <button
                type="button"
                className="btn ghost"
                disabled={formBusy}
                onClick={() => onGeneratedTokenAcknowledgedChange(true)}
              >
                I stored it securely
              </button>
            </div>
          </div>
        ) : null}

        {supportsMirror ? (
          <FormField
            label="Runtime-secret reference"
            htmlFor={credentialRefFieldId}
            error={credentialRefError}
            help={
              existingState.mirrorCredentialRefSet
                ? "A tenant-bound runtime-secret reference is configured — leave blank to keep it. The referenced secret may be a raw key or JSON containing api_key or token."
                : "Tenant-relative name of a runtime secret containing this ESP's suppression-read API key (for example deliverability/mailchimp). The server binds it to the active workspace."
            }
          >
            <input
              id={credentialRefFieldId}
              className="input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={credentialRef}
              disabled={!canMutate || formBusy}
              placeholder={
                existingState.mirrorCredentialRefSet
                  ? "Leave blank to keep current reference"
                  : `deliverability/${provider}`
              }
              onChange={(e) => onCredentialRefChange(e.target.value)}
            />
          </FormField>
        ) : null}

        {supportsMirror &&
        (existingState.webhookTokenSet ||
          existingState.mirrorCredentialRefSet ||
          existingState.legacyApiKeySet) ? (
          <div className="muted" style={{ fontSize: 11 }}>
            Leave an existing value blank to keep it. Moosewave never reads a
            referenced secret into this form.
          </div>
        ) : null}

        <div className="row" style={{ gap: 9, alignItems: "flex-start" }}>
          <input
            id={activeFieldId}
            type="checkbox"
            checked={active}
            disabled={!canMutate || formBusy}
            aria-describedby={`${activeFieldId}-description`}
            onChange={(event) => onActiveChange(event.target.checked)}
          />
          <span>
            <label
              htmlFor={activeFieldId}
              style={{ display: "block", fontSize: 12, fontWeight: 600 }}
            >
              Active provider connection
            </label>
            <small id={`${activeFieldId}-description`} className="muted">
              Inactive rows retain their redacted configuration but are not
              treated as an enabled provider connection.
            </small>
          </span>
        </div>

        {supportsMirror &&
        existingState.legacyApiKeySet &&
        !existingState.mirrorCredentialRefSet ? (
          <div className="banner warning" role="status">
            This row still uses a legacy raw mirror key. Supply a vault
            reference and save to migrate it; the server removes the legacy
            value after the reference is accepted.
          </div>
        ) : null}

        <div>
          <button
            type="button"
            className="btn primary"
            disabled={
              !canMutate ||
              formBusy ||
              tokenError !== null ||
              (generatedToken && !generatedTokenAcknowledged) ||
              credentialRefError !== null
            }
            onClick={() => void onSave()}
          >
            {saving ? "Saving..." : "Save provider"}
          </button>
        </div>
      </div>

      {loadError && rows.length === 0 ? null : (
        <ProviderRows
          canMutate={canMutate}
          formBusy={formBusy}
          loading={loading}
          removingId={removingId}
          rows={rows}
          onRemoveTargetChange={onRemoveTargetChange}
        />
      )}
      <ConfirmModal
        open={providerSwitchTarget !== null}
        title="Discard credentials and switch provider?"
        description="The label and write-only credentials currently typed in this card have not been saved."
        confirmLabel="Discard and switch"
        danger
        onClose={() => onProviderSwitchTargetChange(null)}
        onConfirm={() => {
          if (!providerSwitchTarget) return;
          const nextProvider = providerSwitchTarget;
          zeroizeDraft();
          onProviderChange(nextProvider);
          onProviderSwitchTargetChange(null);
        }}
      />
      <ConfirmModal
        open={removeTarget !== null}
        title="Remove this provider?"
        description="Moosewave will stop accepting this provider configuration. Provider-side webhooks, credentials, domains, and other resources are not removed automatically."
        confirmLabel="Remove provider"
        danger
        busy={removingId !== null}
        onClose={() => onRemoveTargetChange(null)}
        onConfirm={async () => {
          if (removeTarget) await onRemove(removeTarget);
        }}
      >
        {removeTarget ? (
          <p style={{ margin: 0 }}>
            <strong>
              {removeTarget.display_name || removeTarget.provider}
            </strong>
            {removeTarget.display_name ? ` · ${removeTarget.provider}` : ""}
          </p>
        ) : null}
      </ConfirmModal>
    </div>
  );
}

function ProviderRows({
  canMutate,
  formBusy,
  loading,
  onRemoveTargetChange,
  removingId,
  rows,
}: {
  canMutate: boolean;
  formBusy: boolean;
  loading: boolean;
  onRemoveTargetChange: (row: DeliverabilityProviderConfig) => void;
  removingId: string | null;
  rows: DeliverabilityProviderConfig[];
}): ReactElement {
  if (loading) {
    return (
      <div style={{ marginTop: 14, fontSize: 13 }} className="muted">
        Loading...
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div style={{ marginTop: 14, fontSize: 13 }} className="muted">
        No provider tokens saved.
      </div>
    );
  }
  return (
    <div style={{ marginTop: 14, display: "grid", gap: 8 }}>
      {rows.map((row) => {
        const state = providerSecretState(row.config);
        const rowSupportsMirror = providerSupportsMirror(row.provider);
        return (
          <div
            key={row.id}
            style={{
              border: "1px solid var(--pw-border)",
              borderRadius: 8,
              padding: "8px 10px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 10,
            }}
          >
            <div style={{ display: "grid", gap: 4 }}>
              <div style={{ fontWeight: 500 }}>{row.provider}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                {row.display_name || "Default"} ·{" "}
                {row.active ? "active" : "inactive"}
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <SecretBadge
                  set={state.webhookTokenSet}
                  label="Webhook token"
                />
                {rowSupportsMirror ? (
                  <SecretBadge
                    set={state.mirrorCredentialRefSet}
                    label="Mirror secret reference"
                  />
                ) : null}
                {rowSupportsMirror && state.legacyApiKeySet ? (
                  <span className="badge warning">Legacy key · migrate</span>
                ) : null}
              </div>
            </div>
            <button
              type="button"
              className="btn ghost"
              disabled={!canMutate || formBusy}
              onClick={() => onRemoveTargetChange(row)}
            >
              {removingId === row.id ? "Removing…" : "Remove"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
