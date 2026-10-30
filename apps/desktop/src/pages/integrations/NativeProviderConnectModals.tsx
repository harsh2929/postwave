import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactElement,
  type ReactNode,
  type SetStateAction,
} from "react";

import { ConfirmModal } from "../../components/ConfirmModal";
import { FormField } from "../../components/FormField";
import { Modal, ModalFooter } from "../../components/Modal";
import { toast } from "../../components/Toast";
import {
  useCredentialDraftLifecycle,
  type CredentialDraftLifecycle,
} from "../../hooks/useCredentialDraftLifecycle";
import {
  analyticsIntegrationsApi,
  crmIntegrationsApi,
  leadIntegrationsApi,
  loyaltyIntegrationsApi,
  reviewIntegrationsApi,
  subscriptionIntegrationsApi,
  supportIntegrationsApi,
  warehouseApi,
  type ApiResult,
  type AnalyticsProviderSpec,
  type CRMProviderSpec,
  type IntegrationCatalogItem,
  type LeadProviderSpec,
  type LoyaltyProviderSpec,
  type ReviewProviderSpec,
  type SubscriptionProviderSpec,
  type WarehouseConnectionInput,
  type WarehouseProviderSpec,
} from "../../lib/api-client";
import {
  decodeSupportProviderCatalog,
  type SupportProviderSpec,
} from "../../lib/api/support-integrations";
import { tauriApi } from "../../lib/tauri";
import { integrationApiErrorDetail } from "../integrations-helpers";
import {
  CREDENTIAL_REFERENCE_HELP,
  parseNativeProviderRegistry,
  validateNativeProviderDraft,
  type NativeProviderFieldDefinition,
} from "./native-provider-form";

interface NativeProviderField extends NativeProviderFieldDefinition {
  secret?: boolean;
  help?: string;
}

function collectNativeProviderFields<T extends NativeProviderField>(spec?: {
  required_settings: T[];
  optional_settings?: T[];
}): T[] {
  const seen = new Set<string>();
  const ordered: T[] = [];
  for (const field of [
    ...(spec?.required_settings ?? []),
    ...(spec?.optional_settings ?? []),
  ]) {
    if (seen.has(field.key)) continue;
    seen.add(field.key);
    ordered.push(field);
  }
  return ordered;
}

function providerSettings(
  cleaned: Readonly<Record<string, string>>,
): Record<string, string> {
  const settings = { ...cleaned };
  delete settings.credentials_ref;
  return settings;
}

function notifyProviderConfigurationSaved(providerName: string): void {
  toast.info({
    message: `${providerName} configuration saved`,
    detail:
      "Moosewave has refreshed the inventory. Confirm account identity, scopes, and provider health before relying on the connection.",
  });
}

function CredentialProtectedModal({
  lifecycle,
  title,
  description,
  children,
}: {
  lifecycle: CredentialDraftLifecycle;
  title: string;
  description: string;
  children: ReactNode;
}): ReactElement {
  return (
    <>
      <Modal
        open
        onClose={lifecycle.requestClose}
        closeOnBackdrop={!lifecycle.operationActive}
        closeOnEscape={!lifecycle.operationActive}
        closeDisabled={lifecycle.operationActive}
        title={title}
        description={description}
      >
        {children}
      </Modal>
      <ConfirmModal
        open={lifecycle.discardConfirmOpen}
        title="Discard provider credentials?"
        description="Every unsaved credential and reference in this dialog will be cleared from memory."
        confirmLabel="Discard credentials"
        cancelLabel="Keep editing"
        danger
        busy={lifecycle.operationActive}
        onConfirm={lifecycle.discardAndClose}
        onClose={lifecycle.keepEditing}
      />
    </>
  );
}

async function runCredentialConnection({
  lifecycle,
  setBusy,
  setErr,
  request,
  onConnected,
  onSuccess,
  fallbackError,
}: {
  lifecycle: CredentialDraftLifecycle;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setErr: Dispatch<SetStateAction<string | null>>;
  request: () => Promise<string | null>;
  onConnected: () => Promise<void>;
  onSuccess: () => void;
  fallbackError: string;
}): Promise<void> {
  if (!lifecycle.beginOperation()) return;
  setBusy(true);
  setErr(null);
  let succeeded = false;
  let refreshFailed = false;
  try {
    const error = await request();
    if (error) {
      setErr(error);
      return;
    }
    succeeded = true;
    try {
      await onConnected();
    } catch {
      refreshFailed = true;
    }
  } catch {
    setErr(fallbackError);
  } finally {
    lifecycle.finishOperation();
    setBusy(false);
  }
  if (!succeeded) return;
  try {
    onSuccess();
    if (refreshFailed) {
      toast.info(
        "The configuration was saved, but this list couldn't refresh. Reopen the page and verify account identity, scopes, and health.",
      );
    }
  } finally {
    lifecycle.closeAfterSuccess();
  }
}

async function loadProviderRegistry<T>({
  request,
  setProviders,
  setLoading,
  setErr,
  isActive,
  fallbackError,
  signal,
  parseResponse,
  invalidMetadataMessage,
}: {
  request: (signal: AbortSignal) => Promise<ApiResult<{ items: T[] }>>;
  setProviders: Dispatch<SetStateAction<T[]>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setErr: Dispatch<SetStateAction<string | null>>;
  isActive: () => boolean;
  fallbackError: string;
  signal: AbortSignal;
  parseResponse: (value: unknown) => T[] | null;
  invalidMetadataMessage: string;
}): Promise<void> {
  setLoading(true);
  try {
    const res = await request(signal);
    if (!isActive()) return;
    if (res.error) {
      setErr(integrationApiErrorDetail(res.error));
      setProviders([]);
      return;
    }
    const parsed = parseResponse(res.data);
    if (!parsed) {
      setErr(invalidMetadataMessage);
      setProviders([]);
      return;
    }
    setProviders(parsed);
    setErr(null);
  } catch {
    if (!isActive()) return;
    setProviders([]);
    setErr(fallbackError);
  } finally {
    if (isActive()) setLoading(false);
  }
}

interface ProviderRegistryState<T> {
  providers: T[];
  loading: boolean;
  error: string | null;
  retry: () => void;
}

function parseSupportProviderCatalogItems(
  value: unknown,
): SupportProviderSpec[] | null {
  return decodeSupportProviderCatalog(value)?.items ?? null;
}

function useProviderRegistry<T>(
  request: (signal: AbortSignal) => Promise<ApiResult<{ items: T[] }>>,
  fallbackError: string,
  parseResponse: (
    value: unknown,
  ) => T[] | null = parseNativeProviderRegistry<T>,
  invalidMetadataMessage = "The provider registry returned malformed setup metadata. Retry after the service is healthy.",
): ProviderRegistryState<T> {
  const [providers, setProviders] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requestVersion, setRequestVersion] = useState(0);
  const requestRef = useRef(request);

  useEffect(() => {
    requestRef.current = request;
  }, [request]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void loadProviderRegistry({
      request: (signal) => requestRef.current(signal),
      setProviders,
      setLoading,
      setErr: setError,
      isActive: () => active,
      fallbackError,
      signal: controller.signal,
      parseResponse,
      invalidMetadataMessage,
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [fallbackError, invalidMetadataMessage, parseResponse, requestVersion]);

  const retry = useCallback(() => {
    setRequestVersion((current) => current + 1);
  }, []);

  return { providers, loading, error, retry };
}

interface NativeProviderValidationState {
  errors: Record<string, string>;
  updateValue: (key: string, value: string) => void;
  registerInput: (key: string, input: HTMLInputElement | null) => void;
  validate: () => Record<string, string> | null;
}

function useNativeProviderValidation(
  fields: readonly NativeProviderFieldDefinition[],
  values: Readonly<Record<string, string>>,
  setValues: Dispatch<SetStateAction<Record<string, string>>>,
): NativeProviderValidationState {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const inputRefs = useRef(new Map<string, HTMLInputElement>());

  const updateValue = useCallback(
    (key: string, value: string) => {
      setValues((current) => ({ ...current, [key]: value }));
      setErrors((current) => {
        if (!current[key]) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    },
    [setValues],
  );

  const registerInput = useCallback(
    (key: string, input: HTMLInputElement | null) => {
      if (input) inputRefs.current.set(key, input);
      else inputRefs.current.delete(key);
    },
    [],
  );

  const validate = useCallback(() => {
    const result = validateNativeProviderDraft(fields, values);
    setErrors(result.errors);
    if (result.firstInvalidKey) {
      const invalidKey = result.firstInvalidKey;
      queueMicrotask(() => {
        inputRefs.current.get(invalidKey)?.focus({ preventScroll: true });
      });
      return null;
    }
    return result.cleaned;
  }, [fields, values]);

  return { errors, updateValue, registerInput, validate };
}

function ProviderRegistryFooter({
  error,
  loading,
  onRetry,
  onClose,
}: {
  error: string | null;
  loading: boolean;
  onRetry: () => void;
  onClose: () => void;
}): ReactElement {
  return (
    <ModalFooter>
      <button type="button" className="btn" onClick={onClose}>
        Close
      </button>
      {error ? (
        <button
          type="button"
          className="btn btn-primary"
          disabled={loading}
          onClick={onRetry}
        >
          {loading ? "Retrying..." : "Retry setup"}
        </button>
      ) : null}
    </ModalFooter>
  );
}

function ProviderSetupGuidance({
  providerName,
  docsUrl,
}: {
  providerName: string;
  docsUrl?: string;
}): ReactElement {
  const safeDocsUrl = useMemo(() => {
    if (!docsUrl) return null;
    try {
      const parsed = new URL(docsUrl);
      return parsed.protocol === "https:" ? parsed.toString() : null;
    } catch {
      return null;
    }
  }, [docsUrl]);

  return (
    <aside className="int-native-vault-guidance" aria-label="Credential safety">
      <div>
        <strong>Use an existing secure-vault reference</strong>
        <p>
          Moosewave expects a vault identifier, not the underlying password,
          token, API key, or secret document.
        </p>
      </div>
      {safeDocsUrl ? (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            void tauriApi.openUrl(safeDocsUrl).catch(() => {
              toast.info(`${providerName} setup guidance couldn't be opened.`);
            });
          }}
        >
          Open {providerName} setup guide
        </button>
      ) : null}
    </aside>
  );
}

export function CRMConnectModal({
  item,
  onClose,
  onConnected,
}: {
  item: IntegrationCatalogItem;
  onClose: () => void;
  onConnected: () => Promise<void>;
}): ReactElement {
  const {
    providers,
    loading,
    error: registryError,
    retry: retryRegistry,
  } = useProviderRegistry<CRMProviderSpec>(
    () => crmIntegrationsApi.providers(),
    "CRM provider setup couldn't be loaded. Check your connection and retry.",
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const lifecycle = useCredentialDraftLifecycle({
    ownerId: `native-crm-${item.slug}`,
    label: `${item.name} CRM credentials`,
    values,
    setValues,
    busy,
    onClose,
  });

  const spec = useMemo(
    () => providers.find((candidate) => candidate.provider === item.slug),
    [item.slug, providers],
  );

  const fields = useMemo(() => collectNativeProviderFields(spec), [spec]);
  const validation = useNativeProviderValidation(fields, values, setValues);

  const submit = async (): Promise<void> => {
    if (!spec) {
      setErr(`${item.name} is not available in the CRM provider registry.`);
      return;
    }
    const cleaned = validation.validate();
    if (!cleaned) return;
    const credentialsRef = cleaned.credentials_ref ?? "";
    const settings: Record<string, unknown> = providerSettings(cleaned);
    await runCredentialConnection({
      lifecycle,
      setBusy,
      setErr,
      request: async () => {
        const res = await crmIntegrationsApi.create({
          provider: spec.provider,
          name: crmIntegrationName(spec, cleaned),
          credentials_ref: credentialsRef,
          settings,
        });
        return res.error ? integrationApiErrorDetail(res.error) : null;
      },
      onConnected,
      onSuccess: () => notifyProviderConfigurationSaved(spec.name),
      fallbackError: `${spec.name} configuration couldn't be saved. Check your connection and retry.`,
    });
  };

  const title = `Configure ${spec?.name ?? item.name}`;
  const description = spec
    ? `Save a ${spec.name} CRM import configuration with ${spec.auth_mode.replaceAll("_", " ")} credentials and ${spec.sync_model?.replaceAll("_", " ") ?? "canonical import"} semantics. Moosewave will not treat it as verified until refreshed health confirms identity and access.`
    : `Prepare a native managed CRM configuration for ${item.name}.`;

  return (
    <CredentialProtectedModal
      lifecycle={lifecycle}
      title={title}
      description={description}
    >
      {loading ? (
        <div className="notice">Loading CRM provider setup...</div>
      ) : null}
      {!loading && !spec ? (
        <div className="notice notice-error" role="alert">
          {registryError ??
            `${item.name} is not registered as a managed CRM connector yet.`}
        </div>
      ) : null}
      {spec ? (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="notice" style={{ marginBottom: 12 }}>
            Syncs {spec.sync_objects.join(", ")} with scopes{" "}
            {spec.scopes.join(", ")}.
          </div>
          <ProviderSetupGuidance
            providerName={spec.name}
            docsUrl={spec.docs_url}
          />
          {fields.map((field) => (
            <NativeProviderFieldInput
              key={field.key}
              field={field}
              provider={spec.provider}
              value={values[field.key] ?? ""}
              onChange={(value) => {
                validation.updateValue(field.key, value);
                setErr(null);
              }}
              inputRef={(input) => validation.registerInput(field.key, input)}
              error={validation.errors[field.key]}
              disabled={busy}
            />
          ))}
          {err ? (
            <div className="notice notice-error" role="alert">
              {err}
            </div>
          ) : null}
          <ModalFooter>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={lifecycle.requestClose}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Saving..." : "Save configuration"}
            </button>
          </ModalFooter>
        </form>
      ) : (
        <ProviderRegistryFooter
          error={registryError}
          loading={loading}
          onRetry={retryRegistry}
          onClose={lifecycle.requestClose}
        />
      )}
    </CredentialProtectedModal>
  );
}

export function LeadConnectModal({
  item,
  onClose,
  onConnected,
}: {
  item: IntegrationCatalogItem;
  onClose: () => void;
  onConnected: () => Promise<void>;
}): ReactElement {
  const {
    providers,
    loading,
    error: registryError,
    retry: retryRegistry,
  } = useProviderRegistry<LeadProviderSpec>(
    () => leadIntegrationsApi.providers(),
    "Lead provider setup couldn't be loaded. Check your connection and retry.",
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const lifecycle = useCredentialDraftLifecycle({
    ownerId: `native-lead-${item.slug}`,
    label: `${item.name} lead credentials`,
    values,
    setValues,
    busy,
    onClose,
  });

  const spec = useMemo(
    () => providers.find((candidate) => candidate.provider === item.slug),
    [item.slug, providers],
  );

  const fields = useMemo(() => collectNativeProviderFields(spec), [spec]);
  const validation = useNativeProviderValidation(fields, values, setValues);

  const submit = async (): Promise<void> => {
    if (!spec) {
      setErr(`${item.name} is not available in the lead provider registry.`);
      return;
    }
    const cleaned = validation.validate();
    if (!cleaned) return;
    const settings: Record<string, unknown> = providerSettings(cleaned);
    await runCredentialConnection({
      lifecycle,
      setBusy,
      setErr,
      request: async () => {
        const res = await leadIntegrationsApi.create({
          provider: spec.provider,
          name: leadIntegrationName(spec, cleaned),
          credentials_ref: cleaned.credentials_ref ?? "",
          settings,
        });
        return res.error ? integrationApiErrorDetail(res.error) : null;
      },
      onConnected,
      onSuccess: () => notifyProviderConfigurationSaved(spec.name),
      fallbackError: `${spec.name} configuration couldn't be saved. Check your connection and retry.`,
    });
  };

  const title = `Configure ${spec?.name ?? item.name}`;
  const description = spec
    ? `Save a managed ${spec.name} lead-ingest configuration with ${spec.auth_mode.replaceAll("_", " ")} credentials. Refreshed identity, scope, and health evidence is still required.`
    : `Prepare a managed lead-ingest configuration for ${item.name}.`;

  return (
    <CredentialProtectedModal
      lifecycle={lifecycle}
      title={title}
      description={description}
    >
      {loading ? (
        <div className="notice">Loading lead provider setup...</div>
      ) : null}
      {!loading && !spec ? (
        <div className="notice notice-error" role="alert">
          {registryError ??
            `${item.name} is not registered as a managed lead connector yet.`}
        </div>
      ) : null}
      {spec ? (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="notice" style={{ marginBottom: 12 }}>
            Imports {spec.sync_objects.join(", ")} through{" "}
            {spec.sync_model?.replaceAll("_", " ") ?? "managed ingest"}.
          </div>
          <ProviderSetupGuidance
            providerName={spec.name}
            docsUrl={spec.docs_url}
          />
          {fields.map((field) => (
            <NativeProviderFieldInput
              key={field.key}
              field={field}
              provider={spec.provider}
              value={values[field.key] ?? ""}
              onChange={(value) => {
                validation.updateValue(field.key, value);
                setErr(null);
              }}
              inputRef={(input) => validation.registerInput(field.key, input)}
              error={validation.errors[field.key]}
              disabled={busy}
            />
          ))}
          {err ? (
            <div className="notice notice-error" role="alert">
              {err}
            </div>
          ) : null}
          <ModalFooter>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={lifecycle.requestClose}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Saving..." : "Save configuration"}
            </button>
          </ModalFooter>
        </form>
      ) : (
        <ProviderRegistryFooter
          error={registryError}
          loading={loading}
          onRetry={retryRegistry}
          onClose={lifecycle.requestClose}
        />
      )}
    </CredentialProtectedModal>
  );
}

export function ReviewConnectModal({
  item,
  onClose,
  onConnected,
}: {
  item: IntegrationCatalogItem;
  onClose: () => void;
  onConnected: () => Promise<void>;
}): ReactElement {
  const {
    providers,
    loading,
    error: registryError,
    retry: retryRegistry,
  } = useProviderRegistry<ReviewProviderSpec>(
    () => reviewIntegrationsApi.providers(),
    "Review provider setup couldn't be loaded. Check your connection and retry.",
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const lifecycle = useCredentialDraftLifecycle({
    ownerId: `native-review-${item.slug}`,
    label: `${item.name} review credentials`,
    values,
    setValues,
    busy,
    onClose,
  });

  const spec = useMemo(
    () => providers.find((candidate) => candidate.provider === item.slug),
    [item.slug, providers],
  );

  const fields = useMemo(() => collectNativeProviderFields(spec), [spec]);
  const validation = useNativeProviderValidation(fields, values, setValues);

  const submit = async (): Promise<void> => {
    if (!spec) {
      setErr(`${item.name} is not available in the review provider registry.`);
      return;
    }
    const cleaned = validation.validate();
    if (!cleaned) return;
    const settings: Record<string, unknown> = providerSettings(cleaned);
    await runCredentialConnection({
      lifecycle,
      setBusy,
      setErr,
      request: async () => {
        const res = await reviewIntegrationsApi.create({
          provider: spec.provider,
          name: reviewIntegrationName(spec, cleaned),
          credentials_ref: cleaned.credentials_ref ?? "",
          settings,
        });
        return res.error ? integrationApiErrorDetail(res.error) : null;
      },
      onConnected,
      onSuccess: () => notifyProviderConfigurationSaved(spec.name),
      fallbackError: `${spec.name} configuration couldn't be saved. Check your connection and retry.`,
    });
  };

  const title = `Configure ${spec?.name ?? item.name}`;
  const description = spec
    ? `Save a native managed ${spec.name} review-source configuration with ${spec.auth_mode.replaceAll("_", " ")} credentials. Refreshed identity, scope, and health evidence is still required.`
    : `Prepare a native managed review-source configuration for ${item.name}.`;

  return (
    <CredentialProtectedModal
      lifecycle={lifecycle}
      title={title}
      description={description}
    >
      {loading ? (
        <div className="notice">Loading review provider setup...</div>
      ) : null}
      {!loading && !spec ? (
        <div className="notice notice-error" role="alert">
          {registryError ??
            `${item.name} is not registered as a managed review connector yet.`}
        </div>
      ) : null}
      {spec ? (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="notice" style={{ marginBottom: 12 }}>
            Syncs {spec.sync_objects.join(", ")} with scopes{" "}
            {spec.scopes.join(", ")}.
          </div>
          <ProviderSetupGuidance
            providerName={spec.name}
            docsUrl={spec.docs_url}
          />
          {fields.map((field) => (
            <NativeProviderFieldInput
              key={field.key}
              field={field}
              provider={spec.provider}
              value={values[field.key] ?? ""}
              onChange={(value) => {
                validation.updateValue(field.key, value);
                setErr(null);
              }}
              inputRef={(input) => validation.registerInput(field.key, input)}
              error={validation.errors[field.key]}
              disabled={busy}
            />
          ))}
          {err ? (
            <div className="notice notice-error" role="alert">
              {err}
            </div>
          ) : null}
          <ModalFooter>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={lifecycle.requestClose}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Saving..." : "Save configuration"}
            </button>
          </ModalFooter>
        </form>
      ) : (
        <ProviderRegistryFooter
          error={registryError}
          loading={loading}
          onRetry={retryRegistry}
          onClose={lifecycle.requestClose}
        />
      )}
    </CredentialProtectedModal>
  );
}

export function LoyaltyConnectModal({
  item,
  onClose,
  onConnected,
}: {
  item: IntegrationCatalogItem;
  onClose: () => void;
  onConnected: () => Promise<void>;
}): ReactElement {
  const {
    providers,
    loading,
    error: registryError,
    retry: retryRegistry,
  } = useProviderRegistry<LoyaltyProviderSpec>(
    () => loyaltyIntegrationsApi.providers(),
    "Loyalty provider setup couldn't be loaded. Check your connection and retry.",
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const lifecycle = useCredentialDraftLifecycle({
    ownerId: `native-loyalty-${item.slug}`,
    label: `${item.name} loyalty credentials`,
    values,
    setValues,
    busy,
    onClose,
  });

  const spec = useMemo(
    () => providers.find((candidate) => candidate.provider === item.slug),
    [item.slug, providers],
  );

  const fields = useMemo(() => collectNativeProviderFields(spec), [spec]);
  const validation = useNativeProviderValidation(fields, values, setValues);

  const submit = async (): Promise<void> => {
    if (!spec) {
      setErr(`${item.name} is not available in the loyalty provider registry.`);
      return;
    }
    const cleaned = validation.validate();
    if (!cleaned) return;
    const settings: Record<string, unknown> = providerSettings(cleaned);
    await runCredentialConnection({
      lifecycle,
      setBusy,
      setErr,
      request: async () => {
        const res = await loyaltyIntegrationsApi.create({
          provider: spec.provider,
          name: loyaltyIntegrationName(spec, cleaned),
          credentials_ref: cleaned.credentials_ref ?? "",
          settings,
        });
        return res.error ? integrationApiErrorDetail(res.error) : null;
      },
      onConnected,
      onSuccess: () => notifyProviderConfigurationSaved(spec.name),
      fallbackError: `${spec.name} configuration couldn't be saved. Check your connection and retry.`,
    });
  };

  const title = `Configure ${spec?.name ?? item.name}`;
  const description = spec
    ? `Save a native managed ${spec.name} loyalty-source configuration with ${spec.auth_mode.replaceAll("_", " ")} credentials. Refreshed identity, scope, and health evidence is still required.`
    : `Prepare a native managed loyalty-source configuration for ${item.name}.`;

  return (
    <CredentialProtectedModal
      lifecycle={lifecycle}
      title={title}
      description={description}
    >
      {loading ? (
        <div className="notice">Loading loyalty provider setup...</div>
      ) : null}
      {!loading && !spec ? (
        <div className="notice notice-error" role="alert">
          {registryError ??
            `${item.name} is not registered as a managed loyalty connector yet.`}
        </div>
      ) : null}
      {spec ? (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="notice" style={{ marginBottom: 12 }}>
            Syncs {spec.sync_objects.join(", ")} with scopes{" "}
            {spec.scopes.join(", ")}.
          </div>
          <ProviderSetupGuidance
            providerName={spec.name}
            docsUrl={spec.docs_url}
          />
          {fields.map((field) => (
            <NativeProviderFieldInput
              key={field.key}
              field={field}
              provider={spec.provider}
              value={values[field.key] ?? ""}
              onChange={(value) => {
                validation.updateValue(field.key, value);
                setErr(null);
              }}
              inputRef={(input) => validation.registerInput(field.key, input)}
              error={validation.errors[field.key]}
              disabled={busy}
            />
          ))}
          {err ? (
            <div className="notice notice-error" role="alert">
              {err}
            </div>
          ) : null}
          <ModalFooter>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={lifecycle.requestClose}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Saving..." : "Save configuration"}
            </button>
          </ModalFooter>
        </form>
      ) : (
        <ProviderRegistryFooter
          error={registryError}
          loading={loading}
          onRetry={retryRegistry}
          onClose={lifecycle.requestClose}
        />
      )}
    </CredentialProtectedModal>
  );
}

export function SubscriptionConnectModal({
  item,
  onClose,
  onConnected,
}: {
  item: IntegrationCatalogItem;
  onClose: () => void;
  onConnected: () => Promise<void>;
}): ReactElement {
  const {
    providers,
    loading,
    error: registryError,
    retry: retryRegistry,
  } = useProviderRegistry<SubscriptionProviderSpec>(
    () => subscriptionIntegrationsApi.providers(),
    "Subscription provider setup couldn't be loaded. Check your connection and retry.",
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const lifecycle = useCredentialDraftLifecycle({
    ownerId: `native-subscription-${item.slug}`,
    label: `${item.name} subscription credentials`,
    values,
    setValues,
    busy,
    onClose,
  });

  const spec = useMemo(
    () => providers.find((candidate) => candidate.provider === item.slug),
    [item.slug, providers],
  );

  const fields = useMemo(() => collectNativeProviderFields(spec), [spec]);
  const validation = useNativeProviderValidation(fields, values, setValues);

  const submit = async (): Promise<void> => {
    if (!spec) {
      setErr(
        `${item.name} is not available in the subscription provider registry.`,
      );
      return;
    }
    const cleaned = validation.validate();
    if (!cleaned) return;
    const settings: Record<string, unknown> = providerSettings(cleaned);
    await runCredentialConnection({
      lifecycle,
      setBusy,
      setErr,
      request: async () => {
        const res = await subscriptionIntegrationsApi.create({
          provider: spec.provider,
          name: subscriptionIntegrationName(spec, cleaned),
          credentials_ref: cleaned.credentials_ref ?? "",
          settings,
        });
        return res.error ? integrationApiErrorDetail(res.error) : null;
      },
      onConnected,
      onSuccess: () => notifyProviderConfigurationSaved(spec.name),
      fallbackError: `${spec.name} configuration couldn't be saved. Check your connection and retry.`,
    });
  };

  const title = `Configure ${spec?.name ?? item.name}`;
  const description = spec
    ? `Save a managed ${spec.name} ${spec.category} ingest configuration with ${spec.auth_mode.replaceAll("_", " ")} credentials. Refreshed identity, scope, and health evidence is still required.`
    : `Prepare a managed subscription or shipment ingest configuration for ${item.name}.`;

  return (
    <CredentialProtectedModal
      lifecycle={lifecycle}
      title={title}
      description={description}
    >
      {loading ? (
        <div className="notice">Loading subscription provider setup...</div>
      ) : null}
      {!loading && !spec ? (
        <div className="notice notice-error" role="alert">
          {registryError ??
            `${item.name} is not registered as a managed subscription connector yet.`}
        </div>
      ) : null}
      {spec ? (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="notice" style={{ marginBottom: 12 }}>
            Imports {spec.sync_objects.join(", ")} through{" "}
            {spec.sync_model?.replaceAll("_", " ") ?? "managed ingest"}.
          </div>
          <ProviderSetupGuidance
            providerName={spec.name}
            docsUrl={spec.docs_url}
          />
          {fields.map((field) => (
            <NativeProviderFieldInput
              key={field.key}
              field={field}
              provider={spec.provider}
              value={values[field.key] ?? ""}
              onChange={(value) => {
                validation.updateValue(field.key, value);
                setErr(null);
              }}
              inputRef={(input) => validation.registerInput(field.key, input)}
              error={validation.errors[field.key]}
              disabled={busy}
            />
          ))}
          {err ? (
            <div className="notice notice-error" role="alert">
              {err}
            </div>
          ) : null}
          <ModalFooter>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={lifecycle.requestClose}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Saving..." : "Save configuration"}
            </button>
          </ModalFooter>
        </form>
      ) : (
        <ProviderRegistryFooter
          error={registryError}
          loading={loading}
          onRetry={retryRegistry}
          onClose={lifecycle.requestClose}
        />
      )}
    </CredentialProtectedModal>
  );
}

export function SupportConnectModal({
  item,
  onClose,
}: {
  item: IntegrationCatalogItem;
  onClose: () => void;
  onConnected: () => Promise<void>;
}): ReactElement {
  const {
    providers,
    loading,
    error: registryError,
  } = useProviderRegistry<SupportProviderSpec>(
    (signal) => supportIntegrationsApi.providers(signal),
    "Support provider setup couldn't be loaded. Check your connection and retry.",
    parseSupportProviderCatalogItems,
    "The support provider registry returned malformed static catalog metadata. Retry after the service is healthy.",
  );
  const spec = useMemo(
    () => providers.find((candidate) => candidate.key === item.slug),
    [item.slug, providers],
  );

  return (
    <Modal
      open
      onClose={onClose}
      title="Support integration runtime held"
      description={`Catalog entry: ${item.name}. Credentials and provider lifecycle actions are not available in this release.`}
    >
      {loading ? (
        <div className="notice" role="status">
          Loading the static support-provider catalog…
        </div>
      ) : null}
      {!loading && !spec ? (
        <div className="notice notice-error" role="alert">
          {registryError ??
            `${item.name} is not present in the reported support-provider catalog.`}
        </div>
      ) : null}
      {spec ? (
        <div className="notice" role="status">
          Reported provider: <strong>{spec.name}</strong>. This label is static
          catalog metadata, not proof of a connection or enabled runtime.
        </div>
      ) : null}
      <div className="notice notice-warning" role="note">
        No credential field is shown and no create, ingest, sync, backfill,
        pause, disconnect, or run-history request will be sent. Admin/provider
        hold code: <code>support_integration_runtime_held</code>. Public
        callback ingress is separately held with{" "}
        <code>support_provider_ingress_held</code>.
      </div>
      <ModalFooter>
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Close
        </button>
      </ModalFooter>
    </Modal>
  );
}

export function AnalyticsConnectModal({
  item,
  onClose,
  onConnected,
}: {
  item: IntegrationCatalogItem;
  onClose: () => void;
  onConnected: () => Promise<void>;
}): ReactElement {
  const {
    providers,
    loading,
    error: registryError,
    retry: retryRegistry,
  } = useProviderRegistry<AnalyticsProviderSpec>(
    () => analyticsIntegrationsApi.providers(),
    "Analytics provider setup couldn't be loaded. Check your connection and retry.",
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const lifecycle = useCredentialDraftLifecycle({
    ownerId: `native-analytics-${item.slug}`,
    label: `${item.name} analytics credentials`,
    values,
    setValues,
    busy,
    onClose,
  });

  const spec = useMemo(
    () => providers.find((candidate) => candidate.provider === item.slug),
    [item.slug, providers],
  );

  const fields = useMemo(() => collectNativeProviderFields(spec), [spec]);
  const validation = useNativeProviderValidation(fields, values, setValues);

  const submit = async (): Promise<void> => {
    if (!spec) {
      setErr(
        `${item.name} is not available in the analytics provider registry.`,
      );
      return;
    }
    const cleaned = validation.validate();
    if (!cleaned) return;
    const settings: Record<string, unknown> = providerSettings(cleaned);
    await runCredentialConnection({
      lifecycle,
      setBusy,
      setErr,
      request: async () => {
        const res = await analyticsIntegrationsApi.create({
          provider: spec.provider,
          name: analyticsIntegrationName(spec, cleaned),
          credentials_ref: cleaned.credentials_ref ?? "",
          settings,
        });
        return res.error ? integrationApiErrorDetail(res.error) : null;
      },
      onConnected,
      onSuccess: () => notifyProviderConfigurationSaved(spec.name),
      fallbackError: `${spec.name} configuration couldn't be saved. Check your connection and retry.`,
    });
  };

  const title = `Configure ${spec?.name ?? item.name}`;
  const description = spec
    ? `Save a managed ${spec.name} ${spec.category} source configuration with ${spec.auth_mode.replaceAll("_", " ")} credentials and canonical Moosewave profile/event ingest. Refreshed identity, scope, and health evidence is still required.`
    : `Prepare a native managed analytics or CDP configuration for ${item.name}.`;

  return (
    <CredentialProtectedModal
      lifecycle={lifecycle}
      title={title}
      description={description}
    >
      {loading ? (
        <div className="notice">Loading analytics provider setup...</div>
      ) : null}
      {!loading && !spec ? (
        <div className="notice notice-error" role="alert">
          {registryError ??
            `${item.name} is not registered as a managed analytics connector yet.`}
        </div>
      ) : null}
      {spec ? (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="notice" style={{ marginBottom: 12 }}>
            Imports canonical {spec.sync_objects.join(", ")}
            {spec.scopes.length
              ? ` with provider scopes ${spec.scopes.join(", ")}.`
              : "; provider-side API scopes are not claimed until the adapter is verified."}
          </div>
          <ProviderSetupGuidance
            providerName={spec.name}
            docsUrl={spec.docs_url}
          />
          {fields.map((field) => (
            <NativeProviderFieldInput
              key={field.key}
              field={field}
              provider={spec.provider}
              value={values[field.key] ?? ""}
              onChange={(value) => {
                validation.updateValue(field.key, value);
                setErr(null);
              }}
              inputRef={(input) => validation.registerInput(field.key, input)}
              error={validation.errors[field.key]}
              disabled={busy}
            />
          ))}
          {err ? (
            <div className="notice notice-error" role="alert">
              {err}
            </div>
          ) : null}
          <ModalFooter>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={lifecycle.requestClose}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Saving..." : "Save configuration"}
            </button>
          </ModalFooter>
        </form>
      ) : (
        <ProviderRegistryFooter
          error={registryError}
          loading={loading}
          onRetry={retryRegistry}
          onClose={lifecycle.requestClose}
        />
      )}
    </CredentialProtectedModal>
  );
}

export function WarehouseConnectModal({
  item,
  onClose,
  onConnected,
}: {
  item: IntegrationCatalogItem;
  onClose: () => void;
  onConnected: () => Promise<void>;
}): ReactElement {
  const {
    providers,
    loading,
    error: registryError,
    retry: retryRegistry,
  } = useProviderRegistry<WarehouseProviderSpec>(
    () => warehouseApi.providers(),
    "Warehouse provider setup couldn't be loaded. Check your connection and retry.",
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [validationReview, setValidationReview] = useState<{
    input: WarehouseConnectionInput;
    warnings: string[];
  } | null>(null);
  const closeWarehouseModal = useCallback(() => {
    setValidationReview(null);
    onClose();
  }, [onClose]);
  const lifecycle = useCredentialDraftLifecycle({
    ownerId: `native-warehouse-${item.slug}`,
    label: `${item.name} warehouse credentials`,
    values,
    setValues,
    busy,
    onClose: closeWarehouseModal,
  });

  const spec = useMemo(
    () => providers.find((candidate) => candidate.provider === item.slug),
    [item.slug, providers],
  );

  const fields = useMemo(() => collectNativeProviderFields(spec), [spec]);
  const validation = useNativeProviderValidation(fields, values, setValues);

  const validateConnection = async (): Promise<void> => {
    if (!spec) {
      setErr(
        `${item.name} is not available in the warehouse provider registry.`,
      );
      return;
    }
    const cleaned = validation.validate();
    if (!cleaned || !lifecycle.beginOperation()) return;

    const objectSelection = warehouseObjectSelection(spec);
    const input: WarehouseConnectionInput = {
      provider: spec.provider,
      name: warehouseConnectionName(spec, cleaned),
      direction: spec.capabilities.includes("warehouse_import")
        ? "bidirectional"
        : "export",
      status: "active",
      credentials_ref: cleaned.credentials_ref ?? "",
      config: providerSettings(cleaned),
      object_selection: objectSelection,
      cadence: "manual",
      backfill_days: 90,
    };

    setBusy(true);
    setErr(null);
    setValidationReview(null);
    try {
      const result = await warehouseApi.validate(input);
      if (result.error) {
        setErr(result.error.message);
        return;
      }
      if (!result.data.valid) {
        setErr((result.data.errors ?? ["Validation failed."]).join(" "));
        return;
      }
      setValidationReview({
        input,
        warnings: result.data.warnings ?? [],
      });
    } catch {
      setErr(
        `${spec.name} couldn't be validated. Check your connection and retry.`,
      );
    } finally {
      lifecycle.finishOperation();
      setBusy(false);
    }
  };

  const createReviewedConnection = async (): Promise<void> => {
    if (!spec || !validationReview) return;
    await runCredentialConnection({
      lifecycle,
      setBusy,
      setErr,
      request: async () => {
        const res = await warehouseApi.createConnection(validationReview.input);
        return res.error ? integrationApiErrorDetail(res.error) : null;
      },
      onConnected,
      onSuccess: () => notifyProviderConfigurationSaved(spec.name),
      fallbackError: `${spec.name} configuration couldn't be saved. Check your connection and retry.`,
    });
  };

  const title = `Configure ${spec?.name ?? item.name}`;
  const description = spec
    ? `Validate, review, and save a managed ${spec.name} warehouse configuration with ${spec.auth_mode.replaceAll("_", " ")} credentials. Saving still requires a refreshed health check before production use.`
    : `Prepare a managed warehouse configuration for ${item.name}.`;

  return (
    <CredentialProtectedModal
      lifecycle={lifecycle}
      title={title}
      description={description}
    >
      {loading ? (
        <div className="notice">Loading warehouse provider setup...</div>
      ) : null}
      {!loading && !spec ? (
        <div className="notice notice-error" role="alert">
          {registryError ??
            `${item.name} is not registered as a managed warehouse connector yet.`}
        </div>
      ) : null}
      {spec ? (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (validationReview) void createReviewedConnection();
            else void validateConnection();
          }}
        >
          {validationReview ? (
            <WarehouseConnectionReview spec={spec} review={validationReview} />
          ) : (
            <>
              <div className="notice" style={{ marginBottom: 12 }}>
                Syncs {warehouseObjectSelection(spec).join(", ")}. Runtime is{" "}
                {spec.runtime_status}; deeper mappings live in Data Platform.
              </div>
              <ProviderSetupGuidance
                providerName={spec.name}
                docsUrl={spec.docs_url}
              />
              {fields.map((field) => (
                <NativeProviderFieldInput
                  key={field.key}
                  field={field}
                  provider={spec.provider}
                  value={values[field.key] ?? ""}
                  onChange={(value) => {
                    validation.updateValue(field.key, value);
                    setErr(null);
                  }}
                  inputRef={(input) =>
                    validation.registerInput(field.key, input)
                  }
                  error={validation.errors[field.key]}
                  disabled={busy}
                />
              ))}
            </>
          )}
          {err ? (
            <div className="notice notice-error" role="alert">
              {err}
            </div>
          ) : null}
          <ModalFooter>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                if (validationReview) {
                  setValidationReview(null);
                  setErr(null);
                } else {
                  lifecycle.requestClose();
                }
              }}
            >
              {validationReview ? "Back to edit" : "Cancel"}
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy
                ? validationReview
                  ? "Saving..."
                  : "Validating..."
                : validationReview
                  ? "Save reviewed configuration"
                  : "Validate connection"}
            </button>
          </ModalFooter>
        </form>
      ) : (
        <ProviderRegistryFooter
          error={registryError}
          loading={loading}
          onRetry={retryRegistry}
          onClose={lifecycle.requestClose}
        />
      )}
    </CredentialProtectedModal>
  );
}

function WarehouseConnectionReview({
  spec,
  review,
}: {
  spec: WarehouseProviderSpec;
  review: { input: WarehouseConnectionInput; warnings: string[] };
}): ReactElement {
  return (
    <section className="int-native-validation-review" aria-live="polite">
      <div className="int-native-validation-review__heading">
        <span
          className="int-native-validation-review__check"
          aria-hidden="true"
        >
          ✓
        </span>
        <div>
          <strong>Validation passed — review before creating</strong>
          <p>
            No connection has been created. Confirm this validated snapshot,
            including its data scope, before continuing.
          </p>
        </div>
      </div>
      <dl className="int-native-validation-review__facts">
        <div>
          <dt>Provider</dt>
          <dd>{spec.name}</dd>
        </div>
        <div>
          <dt>Direction</dt>
          <dd>{review.input.direction?.replaceAll("_", " ") ?? "export"}</dd>
        </div>
        <div>
          <dt>Objects</dt>
          <dd>{review.input.object_selection?.join(", ") ?? "None"}</dd>
        </div>
        <div>
          <dt>Cadence</dt>
          <dd>{review.input.cadence ?? "manual"}</dd>
        </div>
        <div>
          <dt>Initial backfill</dt>
          <dd>{review.input.backfill_days ?? 0} days</dd>
        </div>
        <div>
          <dt>Credential</dt>
          <dd>Existing vault reference (value hidden)</dd>
        </div>
      </dl>
      <div
        className={`int-native-validation-review__warnings${review.warnings.length ? " is-warning" : ""}`}
        role="status"
      >
        <strong>
          {review.warnings.length
            ? `${review.warnings.length} validation warning${review.warnings.length === 1 ? "" : "s"}`
            : "No validation warnings"}
        </strong>
        {review.warnings.length ? (
          <ul>
            {review.warnings.map((warning, index) => (
              <li key={`${index}-${warning}`}>{warning}</li>
            ))}
          </ul>
        ) : (
          <p>The provider accepted the reviewed connection settings.</p>
        )}
      </div>
    </section>
  );
}

function NativeProviderFieldInput({
  field,
  provider,
  value,
  onChange,
  inputRef,
  error,
  disabled,
}: {
  field: NativeProviderField;
  provider: string;
  value: string;
  onChange: (value: string) => void;
  inputRef: (input: HTMLInputElement | null) => void;
  error?: string;
  disabled: boolean;
}): ReactElement {
  const inputId = useId();
  const isVaultReference =
    field.key === "credentials_ref" || field.key.endsWith("_ref");
  return (
    <FormField
      label={
        field.key === "credentials_ref"
          ? "Credential reference — existing secure vault identifier"
          : field.label
      }
      required={field.required}
      help={isVaultReference ? CREDENTIAL_REFERENCE_HELP : field.help}
      helpTooltip={isVaultReference ? field.help : undefined}
      error={error}
      htmlFor={inputId}
    >
      <input
        ref={inputRef}
        id={inputId}
        type={isVaultReference ? "text" : field.secret ? "password" : "text"}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={nativeProviderFieldPlaceholder(provider, field.key)}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        disabled={disabled}
      />
    </FormField>
  );
}

const PROVIDER_FIELD_PLACEHOLDERS: Readonly<Record<string, string>> = {
  portal_id: "12345678",
  org_id: "00D5f000001abcD",
  company_domain: "acme",
  store_id: "store_123",
  store_domain: "acme.myshopify.com",
  shop_domain: "acme.myshopify.com",
  store_url: "https://store.example.com",
  base_url: "https://store.example.com",
  store_hash: "abc123",
  account_id: "acct_123",
  merchant_id: "merchant_123",
  location_id: "location_123",
  environment: "live",
  webhook_id: "WH-123456789",
  settlement_currency: "USD",
  warehouse_id: "warehouse_123",
  tracking_slug: "order-status",
  api_version: "2021-11",
  subdomain: "acme",
  workspace_id: "workspace_123",
  account_domain: "acme.gorgias.com",
  brand_id: "brand_123",
  inbox_id: "inbox_123",
  measurement_id: "G-XXXXXXXXXX",
  container_id: "GTM-XXXXXXX",
  source_id: "src_123",
  data_plane_url: "https://acme.dataplane.rudderstack.com",
  bucket: "postwave-exports",
  endpoint_url: "https://<account-id>.r2.cloudflarestorage.com",
  prefix: "postwave/exports",
  import_prefix: "warehouse/imports/prod/",
  dataset: "postwave",
  location: "US",
  table_prefix: "postwave",
  account: "xy12345.us-east-1",
  warehouse: "COMPUTE_WH",
  database: "POSTWAVE",
  schema: "PUBLIC",
  role: "POSTWAVE_LOADER",
  stage: "POSTWAVE_STAGE",
  cluster_or_workgroup: "postwave-analytics",
  iam_role_ref: "cred_redshift_iam_role",
  host: "db.example.com",
  port: "5432",
  sslmode: "require",
  project_id: "project_123",
  property_id: "properties/123456789",
  stream_id: "stream_123",
  server_container_url: "https://gtm.example.com",
  workspace_slug: "acme",
  region: "US",
  identity_mode: "distinct_id",
  group_type: "company",
  site_id: "site_123",
  site_url: "https://example.com",
  form_id: "form_123",
  form_name: "Newsletter signup",
  campaign_id: "campaign_123",
  program_id: "optional",
  instance_url: "https://acme.my.salesforce.com",
  list_id: "optional",
  pipeline_id: "optional",
};

function nativeProviderFieldPlaceholder(provider: string, key: string): string {
  if (key === "webhook_signature_ref") {
    return `cred_${provider}_webhook_signature`;
  }
  if (key === "credentials_ref") return `vault://integrations/${provider}`;
  if (key === "webhook_secret_ref") return `cred_${provider}_webhook`;
  return PROVIDER_FIELD_PLACEHOLDERS[key] ?? "optional";
}

function crmIntegrationName(
  spec: CRMProviderSpec,
  settings: Record<string, string>,
): string {
  const identifier =
    settings.portal_id ??
    settings.org_id ??
    settings.company_domain ??
    settings.instance_url ??
    "";
  return identifier ? `${spec.name} ${identifier}` : spec.name;
}

function leadIntegrationName(
  spec: LeadProviderSpec,
  settings: Record<string, string>,
): string {
  const identifier =
    settings.form_id ??
    settings.site_id ??
    settings.site_url ??
    settings.form_name ??
    "";
  return identifier ? `${spec.name} ${identifier}` : spec.name;
}

function reviewIntegrationName(
  spec: ReviewProviderSpec,
  settings: Record<string, string>,
): string {
  const identifier = settings.store_id ?? settings.shop_domain ?? "";
  return identifier ? `${spec.name} ${identifier}` : spec.name;
}

function loyaltyIntegrationName(
  spec: LoyaltyProviderSpec,
  settings: Record<string, string>,
): string {
  const identifier =
    settings.shop_domain ?? settings.site_id ?? settings.campaign_id ?? "";
  return identifier ? `${spec.name} ${identifier}` : spec.name;
}

function subscriptionIntegrationName(
  spec: SubscriptionProviderSpec,
  settings: Record<string, string>,
): string {
  const identifier =
    settings.store_domain ?? settings.account_id ?? settings.warehouse_id ?? "";
  return identifier ? `${spec.name} ${identifier}` : spec.name;
}

function analyticsIntegrationName(
  spec: AnalyticsProviderSpec,
  settings: Record<string, string>,
): string {
  const identifier =
    settings.measurement_id ??
    settings.container_id ??
    settings.source_id ??
    settings.project_id ??
    "";
  return identifier ? `${spec.name} ${identifier}` : spec.name;
}

function warehouseObjectSelection(spec: WarehouseProviderSpec): string[] {
  const supported = new Set([
    "profiles",
    "events",
    "metrics",
    "campaigns",
    "flows",
    "forms",
    "catalog",
    "custom_objects",
    "reviews",
  ]);
  const objects = spec.sync_objects.filter((item) => supported.has(item));
  return objects.length > 0 ? objects.slice(0, 6) : ["profiles", "events"];
}

function warehouseConnectionName(
  spec: WarehouseProviderSpec,
  settings: Record<string, string>,
): string {
  const identifier =
    settings.dataset ??
    settings.database ??
    settings.catalog ??
    settings.bucket ??
    settings.workspace_url ??
    settings.host ??
    settings.account ??
    settings.cluster_or_workgroup ??
    "";
  return identifier ? `${spec.name} ${identifier}` : spec.name;
}
