/**
 * BYOKKeysPanel — manage the tenant's bring-your-own KMS keys.
 *
 * Operations exposed:
 *   • List all keys (active + inactive + deleted-but-recent)
 *   • Register a new key (provider + key_ref + description)
 *   • Activate a key (atomic rotation — flips active → inactive, new → active)
 *   • Health-check a key (round-trip a probe DEK through the provider)
 *   • Delete an inactive key (soft-delete)
 *
 * The BYOK API has been fully implemented on the backend for a while
 * but has had ZERO frontend until now. Without this UI, tenants evaluating
 * regulated workloads couldn't see whether their active key was healthy,
 * which is one of the technical posture checks the compliance page shows.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { useBlockingLifecycleOperation } from "../../hooks/useBlockingLifecycleOperation";
import { ConfirmModal } from "../ConfirmModal";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";
import { api, type ByokKey } from "../../lib/api-client";
import { registerLifecycleGuard } from "../../lib/lifecycle-coordinator";

interface Props {
  /** Cached keys from the page parent so the panel renders instantly. */
  keys: ByokKey[];
  /** Notify parent when something mutates so it can refetch. */
  onReload: () => void;
  /** Admin only — disable mutators when false. */
  canMutate: boolean;
}

/** Tolerant field readers — backend serialises with Go's default PascalCase. */
const r = {
  id: (k: ByokKey): string => String(k.id ?? k.ID ?? ""),
  provider: (k: ByokKey): string => String(k.provider ?? k.Provider ?? ""),
  keyRef: (k: ByokKey): string => String(k.key_ref ?? k.KeyRef ?? ""),
  status: (k: ByokKey): string =>
    String(k.status ?? k.Status ?? "").toLowerCase(),
  description: (k: ByokKey): string =>
    String(k.description ?? k.Description ?? ""),
  createdAt: (k: ByokKey): string | undefined =>
    (k.created_at ?? k.CreatedAt) as string | undefined,
  activatedAt: (k: ByokKey): string | undefined =>
    (k.activated_at ?? k.ActivatedAt) as string | undefined,
  lastHealthAt: (k: ByokKey): string | undefined =>
    (k.last_health_check_at ?? k.LastHealthCheckAt) as string | undefined,
  lastHealthOK: (k: ByokKey): boolean | null | undefined =>
    (k.last_health_check_ok ?? k.LastHealthCheckOK) as
      | boolean
      | null
      | undefined,
  lastHealthErr: (k: ByokKey): string | undefined =>
    (k.last_health_check_err ?? k.LastHealthCheckErr) as string | undefined,
};

function statusColor(s: string): string {
  if (s === "active") return "var(--pw-accent)";
  if (s === "inactive") return "var(--pw-fg-muted)";
  if (s === "deleted") return "var(--pw-fg-subtle)";
  return "var(--pw-warning)";
}

function fmtRel(iso: string | undefined): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h ago`;
  return `${Math.round(diff / 86400_000)}d ago`;
}

export function BYOKKeysPanel({
  keys,
  onReload,
  canMutate,
}: Props): ReactElement {
  const [providers, setProviders] = useState<string[] | null>(null);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState({
    provider: "",
    key_ref: "",
    description: "",
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [addErr, setAddErr] = useState<string | null>(null);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  // Pending activate/delete confirmation. In-app ConfirmModal replaces
  // window.confirm, which silently no-ops in the Tauri webview — keys
  // could never be activated or deleted from the desktop app.
  const [confirm, setConfirm] = useState<{
    action: "activate" | "delete";
    id: string;
  } | null>(null);
  const instanceId = useId();
  const operationRef = useRef(false);
  const operationActive = busy !== null;
  const providerFieldId = `${instanceId}-provider`;
  const keyRefFieldId = `${instanceId}-key-ref`;
  const descriptionFieldId = `${instanceId}-description`;
  const draftDirty =
    addOpen && (draft.key_ref !== "" || draft.description !== "");
  const clearSensitiveDraft = useCallback((): void => {
    setDraft((current) => ({
      provider: current.provider,
      key_ref: "",
      description: "",
    }));
    setAddErr(null);
  }, []);
  const discardAndClose = useCallback((): void => {
    clearSensitiveDraft();
    setDiscardConfirmOpen(false);
    setAddOpen(false);
  }, [clearSensitiveDraft]);

  useBlockingLifecycleOperation(
    `byok-key-${instanceId}`,
    "Encryption key operation",
    operationActive,
  );
  useEffect(() => {
    if (!draftDirty || operationActive) return;
    return registerLifecycleGuard({
      id: `byok-key-draft-${instanceId}`,
      label: "Encryption key registration",
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : {
              level: "blocking",
              detail:
                "This key reference has not been registered. Return to the form or explicitly discard and zeroize it.",
              canDiscard: true,
            },
      discard: discardAndClose,
    });
  }, [discardAndClose, draftDirty, instanceId, operationActive]);

  useEffect(() => {
    let cancelled = false;
    const loadProviders = async (): Promise<void> => {
      try {
        const res = await api.byokListProviders();
        if (cancelled) return;
        if (res.error) {
          setProviders([]);
          setProvidersError(res.error.message);
          return;
        }
        const wired = res.data?.providers ?? [];
        setProviders(wired);
        setProvidersError(null);
        setDraft((current) => ({
          ...current,
          provider: wired.includes(current.provider)
            ? current.provider
            : (wired[0] ?? ""),
        }));
      } catch {
        if (!cancelled) {
          setProviders([]);
          setProvidersError(
            "Available key providers couldn't be loaded. Check your connection and retry.",
          );
        }
      }
    };
    void loadProviders();
    return () => {
      cancelled = true;
    };
  }, []);

  const requestAddClose = (): void => {
    if (operationActive) return;
    if (draftDirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    clearSensitiveDraft();
    setAddOpen(false);
  };

  async function create(): Promise<void> {
    if (operationRef.current) return;
    if (!draft.provider || !providers?.includes(draft.provider)) {
      setAddErr("No BYOK provider is available in this deployment.");
      return;
    }
    if (!draft.key_ref.trim()) {
      setAddErr("Key reference is required (ARN, resource ID, Vault path).");
      return;
    }
    operationRef.current = true;
    setBusy("create");
    setAddErr(null);
    try {
      const res = await api.byokCreateKey({
        provider: draft.provider,
        key_ref: draft.key_ref.trim(),
        description: draft.description.trim(),
      });
      if (res.error) {
        setAddErr(res.error.message);
        return;
      }
      toast.success("Key registered (inactive). Activate when ready.");
      clearSensitiveDraft();
      setAddOpen(false);
      onReload();
    } catch {
      setAddErr(
        "The key couldn't be registered. Check your connection and retry.",
      );
    } finally {
      operationRef.current = false;
      setBusy(null);
    }
  }

  async function activate(id: string): Promise<void> {
    if (operationRef.current) return;
    operationRef.current = true;
    setBusy(`act-${id}`);
    try {
      const res = await api.byokActivateKey(id);
      if (res.error) {
        toast.error(`Activate failed: ${res.error.message}`);
        return;
      }
      setConfirm(null);
      toast.success("Key activated. Subsequent envelope encryption uses it.");
      onReload();
    } catch {
      toast.error("Activate failed. Check your connection and retry.");
    } finally {
      operationRef.current = false;
      setBusy(null);
    }
  }

  async function health(id: string): Promise<void> {
    if (operationRef.current) return;
    operationRef.current = true;
    setBusy(`hc-${id}`);
    try {
      const res = await api.byokHealthCheck(id);
      if (res.error) {
        toast.error(`Health check failed: ${res.error.message}`);
        return;
      }
      if (res.data?.ok) {
        toast.success("Health check OK — key round-tripped a probe.");
      } else {
        toast.error(`Health check failed: ${res.data?.error ?? "unknown"}`);
      }
      onReload();
    } catch {
      toast.error("Health check failed. Check your connection and retry.");
    } finally {
      operationRef.current = false;
      setBusy(null);
    }
  }

  async function remove(id: string): Promise<void> {
    if (operationRef.current) return;
    operationRef.current = true;
    setBusy(`del-${id}`);
    try {
      const res = await api.byokDeleteKey(id);
      if (res.error) {
        toast.error(`Delete failed: ${res.error.message}`);
        return;
      }
      setConfirm(null);
      toast.success("Key removed.");
      onReload();
    } catch {
      toast.error("Delete failed. Check your connection and retry.");
    } finally {
      operationRef.current = false;
      setBusy(null);
    }
  }

  return (
    <BYOKKeysView
      addError={addErr}
      addOpen={addOpen}
      busy={busy}
      canMutate={canMutate}
      confirm={confirm}
      descriptionFieldId={descriptionFieldId}
      discardConfirmOpen={discardConfirmOpen}
      draft={draft}
      keyRefFieldId={keyRefFieldId}
      keys={keys}
      operationActive={operationActive}
      providerFieldId={providerFieldId}
      providers={providers}
      providersError={providersError}
      onActivate={activate}
      onAddOpenChange={setAddOpen}
      onConfirmChange={setConfirm}
      onCreate={create}
      onDiscardAndClose={discardAndClose}
      onDiscardConfirmOpenChange={setDiscardConfirmOpen}
      onDraftChange={setDraft}
      onHealth={health}
      onRemove={remove}
      onRequestAddClose={requestAddClose}
    />
  );
}

interface BYOKKeysViewProps {
  addError: string | null;
  addOpen: boolean;
  busy: string | null;
  canMutate: boolean;
  confirm: { action: "activate" | "delete"; id: string } | null;
  descriptionFieldId: string;
  discardConfirmOpen: boolean;
  draft: { provider: string; key_ref: string; description: string };
  keyRefFieldId: string;
  keys: ByokKey[];
  operationActive: boolean;
  providerFieldId: string;
  providers: string[] | null;
  providersError: string | null;
  onActivate: (id: string) => Promise<void>;
  onAddOpenChange: (open: boolean) => void;
  onConfirmChange: (
    confirm: { action: "activate" | "delete"; id: string } | null,
  ) => void;
  onCreate: () => Promise<void>;
  onDiscardAndClose: () => void;
  onDiscardConfirmOpenChange: (open: boolean) => void;
  onDraftChange: (draft: BYOKKeysViewProps["draft"]) => void;
  onHealth: (id: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onRequestAddClose: () => void;
}

function BYOKKeysView({
  addError,
  addOpen,
  busy,
  canMutate,
  confirm,
  descriptionFieldId,
  discardConfirmOpen,
  draft,
  keyRefFieldId,
  keys,
  onActivate,
  onAddOpenChange,
  onConfirmChange,
  onCreate,
  onDiscardAndClose,
  onDiscardConfirmOpenChange,
  onDraftChange,
  onHealth,
  onRemove,
  onRequestAddClose,
  operationActive,
  providerFieldId,
  providers,
  providersError,
}: BYOKKeysViewProps): ReactElement {
  const registerDescriptionId = useId();
  const registerUnavailableReason = !canMutate
    ? "Admin role required."
    : operationActive
      ? "Another encryption-key operation is already in progress."
      : null;
  return (
    <div
      className="card"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div className="section-title" style={{ marginBottom: 4 }}>
            Encryption keys (BYOK)
          </div>
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
            Tenant-owned KMS keys for envelope encryption of PHI-sensitive
            payloads. HIPAA mode requires at least one active key.
          </div>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => {
            if (!registerUnavailableReason) onAddOpenChange(true);
          }}
          aria-disabled={registerUnavailableReason !== null || undefined}
          aria-describedby={registerDescriptionId}
        >
          + Register key
        </button>
        <span id={registerDescriptionId} className="visually-hidden">
          {registerUnavailableReason ??
            "Register a tenant-owned KMS key in an inactive state."}
        </span>
      </div>

      <BYOKKeyRows
        busy={busy}
        canMutate={canMutate}
        keys={keys}
        operationActive={operationActive}
        onConfirmChange={onConfirmChange}
        onHealth={onHealth}
      />

      <Modal
        open={addOpen}
        onClose={onRequestAddClose}
        title="Register a new key"
        description="The key is registered in an inactive state. Activation performs a live encrypt/decrypt health check before flipping it atomically."
        closeOnBackdrop={!operationActive}
        closeOnEscape={!operationActive}
      >
        <div className="field">
          <label className="field-label" htmlFor={providerFieldId}>
            Provider
          </label>
          <select
            id={providerFieldId}
            className="input"
            value={draft.provider}
            disabled={operationActive}
            onChange={(e) =>
              onDraftChange({ ...draft, provider: e.target.value })
            }
          >
            {(providers ?? []).map((p) => (
              <option key={p} value={p}>
                {p.toUpperCase()}
              </option>
            ))}
          </select>
          {providers === null ? (
            <div className="field-help">Loading available providers…</div>
          ) : providers.length === 0 ? (
            <div className="field-error">
              {providersError ??
                "No BYOK provider is configured for this deployment."}
            </div>
          ) : null}
        </div>
        <div className="field">
          <label className="field-label" htmlFor={keyRefFieldId}>
            Key reference
          </label>
          <input
            id={keyRefFieldId}
            type="text"
            className="input"
            value={draft.key_ref}
            disabled={operationActive}
            onChange={(e) =>
              onDraftChange({ ...draft, key_ref: e.target.value })
            }
            placeholder={
              draft.provider === "aws"
                ? "arn:aws:kms:us-east-1:123:key/abc-123"
                : draft.provider === "gcp"
                  ? "projects/p/locations/l/keyRings/r/cryptoKeys/k"
                  : draft.provider === "vault"
                    ? "transit/keys/postwave-tenant"
                    : "tink keyset id"
            }
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={descriptionFieldId}>
            Description (optional)
          </label>
          <input
            id={descriptionFieldId}
            type="text"
            className="input"
            value={draft.description}
            disabled={operationActive}
            onChange={(e) =>
              onDraftChange({ ...draft, description: e.target.value })
            }
            placeholder="e.g. Production · us-east-1 · rotated 2026-Q1"
          />
        </div>
        {addError ? <div className="field-error">{addError}</div> : null}
        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={onRequestAddClose}
            disabled={operationActive}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void onCreate()}
            disabled={
              operationActive ||
              !draft.provider ||
              !providers?.includes(draft.provider)
            }
          >
            {busy === "create" ? "Registering…" : "Register"}
          </button>
        </ModalFooter>
      </Modal>

      <ConfirmModal
        open={confirm !== null}
        title={
          confirm?.action === "activate"
            ? "Activate this key?"
            : "Delete this key?"
        }
        description={
          confirm?.action === "activate"
            ? "Moosewave will first live-test this key. Only a successful encrypt/decrypt round trip can flip the currently-active key to inactive."
            : "Soft-delete this inactive key? It stays visible in the list for a while but can no longer be activated."
        }
        confirmLabel={confirm?.action === "activate" ? "Activate" : "Delete"}
        danger={confirm?.action === "delete"}
        busy={operationActive}
        onConfirm={() => {
          if (!confirm) return;
          if (confirm.action === "activate") void onActivate(confirm.id);
          else void onRemove(confirm.id);
        }}
        onClose={() => {
          if (!operationActive) onConfirmChange(null);
        }}
      />

      <ConfirmModal
        open={discardConfirmOpen}
        title="Discard key registration?"
        description="The key reference and description have not been registered. Discarding clears them from this device's memory."
        confirmLabel="Discard draft"
        danger
        onConfirm={onDiscardAndClose}
        onClose={() => onDiscardConfirmOpenChange(false)}
      />
    </div>
  );
}

function BYOKKeyRows({
  busy,
  canMutate,
  keys,
  onConfirmChange,
  onHealth,
  operationActive,
}: {
  busy: string | null;
  canMutate: boolean;
  keys: ByokKey[];
  onConfirmChange: BYOKKeysViewProps["onConfirmChange"];
  onHealth: (id: string) => Promise<void>;
  operationActive: boolean;
}): ReactElement {
  const actionDescriptionBaseId = useId();
  if (keys.length === 0) {
    return (
      <div
        className="muted"
        style={{
          fontSize: 12,
          padding: "16px 0",
          textAlign: "center",
          lineHeight: 1.5,
        }}
      >
        No tenant-managed keys yet. Register one (AWS KMS, GCP KMS, Vault
        Transit, or Tink keyset) to satisfy the BYOK readiness gate.
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {keys.map((key, index) => {
        const id = r.id(key);
        const status = r.status(key);
        const color = statusColor(status);
        const ok = r.lastHealthOK(key);
        const healthAt = r.lastHealthAt(key);
        const healthDescriptionId = `${actionDescriptionBaseId}-${index}-health`;
        const activateDescriptionId = `${actionDescriptionBaseId}-${index}-activate`;
        const deleteDescriptionId = `${actionDescriptionBaseId}-${index}-delete`;
        const actionUnavailableReason = !canMutate
          ? "Admin role required."
          : operationActive
            ? "Another encryption-key operation is already in progress."
            : null;
        return (
          <div
            key={id}
            style={{
              display: "grid",
              gridTemplateColumns: "8px 1.4fr 90px 1fr 240px",
              alignItems: "center",
              gap: 10,
              padding: "8px 12px",
              background: "var(--pw-bg-elev-2)",
              borderRadius: 4,
              fontSize: 12,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: color,
              }}
            />
            <div>
              <div
                style={{
                  color: "var(--pw-fg)",
                  fontFamily:
                    "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                  fontSize: 11,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                title={r.keyRef(key)}
              >
                {r.keyRef(key) || "(no key_ref)"}
              </div>
              <div className="muted" style={{ fontSize: 10 }}>
                {r.provider(key).toUpperCase()}
                {r.description(key) ? ` · ${r.description(key)}` : ""}
              </div>
            </div>
            <span
              style={{
                color,
                fontWeight: 600,
                textTransform: "uppercase",
                fontSize: 10,
                letterSpacing: 0.4,
              }}
            >
              {status || "—"}
            </span>
            <div
              className="muted"
              style={{ fontSize: 11, display: "flex", flexDirection: "column" }}
              title={
                healthAt
                  ? `Last checked ${new Date(healthAt).toLocaleString()}`
                  : ""
              }
            >
              <span>
                Health:{" "}
                <span
                  style={{
                    color:
                      ok === true
                        ? "var(--pw-accent)"
                        : ok === false
                          ? "var(--pw-danger)"
                          : "var(--pw-fg-muted)",
                    fontWeight: 600,
                  }}
                >
                  {ok === true ? "OK" : ok === false ? "Fail" : "Unchecked"}
                </span>
              </span>
              <span style={{ fontSize: 10 }}>{fmtRel(healthAt)}</span>
            </div>
            <div
              style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}
            >
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  if (!actionUnavailableReason) void onHealth(id);
                }}
                aria-disabled={actionUnavailableReason !== null || undefined}
                aria-describedby={healthDescriptionId}
                aria-busy={busy === `hc-${id}` || undefined}
              >
                {busy === `hc-${id}` ? "Checking…" : "Health"}
              </button>
              <span id={healthDescriptionId} className="visually-hidden">
                {actionUnavailableReason ??
                  "Run an encrypt and decrypt probe against this key provider."}
              </span>
              {status === "inactive" ? (
                <>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      if (!actionUnavailableReason) {
                        onConfirmChange({ action: "activate", id });
                      }
                    }}
                    aria-disabled={
                      actionUnavailableReason !== null || undefined
                    }
                    aria-describedby={activateDescriptionId}
                    aria-busy={busy === `act-${id}` || undefined}
                  >
                    {busy === `act-${id}` ? "Activating…" : "Activate"}
                  </button>
                  <span id={activateDescriptionId} className="visually-hidden">
                    {actionUnavailableReason ??
                      "Activate this key using a live health check and atomic rotation."}
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      if (!actionUnavailableReason) {
                        onConfirmChange({ action: "delete", id });
                      }
                    }}
                    aria-disabled={
                      actionUnavailableReason !== null || undefined
                    }
                    aria-describedby={deleteDescriptionId}
                    style={{ color: "var(--pw-danger)" }}
                  >
                    Delete
                  </button>
                  <span id={deleteDescriptionId} className="visually-hidden">
                    {actionUnavailableReason ??
                      "Soft-delete this inactive key after confirmation."}
                  </span>
                </>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
