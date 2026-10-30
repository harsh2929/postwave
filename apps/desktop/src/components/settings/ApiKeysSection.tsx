/**
 * ApiKeysSection — workspace API-key management for the Settings page
 * (roadmap item 5: scope editor on key creation).
 *
 * Endpoints (apps/api/main.go:3133-3140, all admin-scope):
 *   GET    /api/v1/api-keys             list (no plaintext)
 *   POST   /api/v1/api-keys             create — scopes set HERE only
 *   POST   /api/v1/api-keys/{id}/rotate revoke + re-mint (same scopes),
 *                                       returns a fresh plaintext once
 *   DELETE /api/v1/api-keys/{id}        revoke
 *
 * Honest constraint surfaced in the UI: there is NO update route, so a
 * key's scopes are fixed at creation — changing access means rotating
 * (same scopes, new secret) or minting a new key and revoking the old.
 *
 * Scope catalog renders all 13 real backend scope ids (7 core + 6
 * audit:*) with short descriptions — see api-key-scopes.ts.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  api,
  type ApiKeyRow,
  type ApiKeysListResponse,
} from "../../lib/api-client";
import {
  clipboardSuccessDetail,
  writeClipboardText,
} from "../../lib/clipboard";
import { useCanAdmin } from "../../lib/store";
import { useShownOnceSecretLifecycle } from "../../hooks/useShownOnceSecretLifecycle";
import {
  lifecycleOperationError,
  useDiscardOnlyDraftLifecycle,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import { ConfirmModal } from "../ConfirmModal";
import { toast } from "../Toast";
import { SettingsSectionHeader } from "./SettingsNav";
import {
  API_KEY_SCOPES,
  API_KEY_SCOPE_GROUPS,
  scopesSummary,
  toggleScope,
  validateKeyDraft,
} from "./api-key-scopes";

function unwrapKeys(payload: ApiKeysListResponse | undefined): ApiKeyRow[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload as ApiKeyRow[];
  return payload.items ?? payload.keys ?? payload.data ?? [];
}

interface ApiKeyListProps {
  keys: ApiKeyRow[];
  loading: boolean;
  error: string | null;
  operationActive: boolean;
  plaintextPending: boolean;
  actionGuidanceId: string;
  onReload: () => void;
  onRotate: (key: ApiKeyRow) => void;
  onRevoke: (key: ApiKeyRow) => void;
}

function ApiKeyList({
  keys,
  loading,
  error,
  operationActive,
  plaintextPending,
  actionGuidanceId,
  onReload,
  onRotate,
  onRevoke,
}: ApiKeyListProps): ReactElement {
  if (error) {
    return (
      <div className="notice">
        <span>Couldn&apos;t load API keys: {error}</span>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={onReload}
          disabled={loading}
        >
          {loading ? "Retrying…" : "Retry"}
        </button>
      </div>
    );
  }
  if (loading) {
    return (
      <div
        className="skel-row"
        role="status"
        aria-label="Loading API keys"
        aria-busy="true"
      />
    );
  }
  if (keys.length === 0) {
    return (
      <div className="muted" style={{ fontSize: 12 }}>
        No API keys yet. Create one to let an integration or agent call the API
        with scoped access.
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {keys.map((key, index) => {
        const revoked = Boolean(key.revokedAt);
        const keyGuidanceId = `${actionGuidanceId}-key-${index}`;
        return (
          <div
            key={key.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
              padding: "8px 10px",
              background: "var(--pw-bg-elev)",
              borderRadius: 4,
              fontSize: 12,
              opacity: revoked ? 0.55 : 1,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ overflowWrap: "anywhere" }}>
                {key.label || "(unlabeled)"}
                {revoked ? (
                  <span className="muted" style={{ fontSize: 10 }}>
                    {" "}
                    · revoked
                  </span>
                ) : null}
              </div>
              <div
                className="muted mono"
                style={{ fontSize: 10, overflowWrap: "anywhere" }}
              >
                {key.prefix}… · {scopesSummary(key.scopes ?? [])}
              </div>
              {!revoked ? (
                <div
                  id={keyGuidanceId}
                  className="muted"
                  style={{ fontSize: 10, marginTop: 2 }}
                >
                  Rotate immediately revokes this secret and creates a
                  replacement with the same scopes. Revoke stops every
                  integration using it and cannot be undone.
                </div>
              ) : null}
            </div>
            <span className="muted tabular" style={{ whiteSpace: "nowrap" }}>
              {key.lastUsedAt
                ? `used ${new Date(key.lastUsedAt).toLocaleDateString()}`
                : "never used"}
            </span>
            {!revoked ? (
              <>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    if (!plaintextPending) onRotate(key);
                  }}
                  disabled={operationActive}
                  aria-busy={operationActive}
                  aria-disabled={plaintextPending || undefined}
                  aria-describedby={`${actionGuidanceId} ${keyGuidanceId}`}
                >
                  Rotate
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    if (!plaintextPending) onRevoke(key);
                  }}
                  disabled={operationActive}
                  aria-busy={operationActive}
                  aria-disabled={plaintextPending || undefined}
                  aria-describedby={`${actionGuidanceId} ${keyGuidanceId}`}
                >
                  Revoke
                </button>
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

interface ApiKeyConfirmationsProps {
  confirmCreateClose: boolean;
  pendingRevoke: ApiKeyRow | null;
  pendingRotate: ApiKeyRow | null;
  busy: boolean;
  onDiscardCreate: () => void;
  onCancelDiscardCreate: () => void;
  onConfirmRevoke: () => void;
  onCancelRevoke: () => void;
  onConfirmRotate: () => void;
  onCancelRotate: () => void;
}

function ApiKeyConfirmations({
  confirmCreateClose,
  pendingRevoke,
  pendingRotate,
  busy,
  onDiscardCreate,
  onCancelDiscardCreate,
  onConfirmRevoke,
  onCancelRevoke,
  onConfirmRotate,
  onCancelRotate,
}: ApiKeyConfirmationsProps): ReactElement {
  return (
    <>
      <ConfirmModal
        open={confirmCreateClose}
        title="Discard API-key draft?"
        description="The unsaved label and scope selection will be cleared. No API key has been created yet."
        confirmLabel="Discard draft"
        cancelLabel="Keep editing"
        danger
        onConfirm={onDiscardCreate}
        onClose={onCancelDiscardCreate}
      />
      <ConfirmModal
        open={pendingRevoke !== null}
        title="Revoke API key?"
        description={
          pendingRevoke
            ? `Revoke "${pendingRevoke.label}"? Any integration using this key stops working immediately. This cannot be undone.`
            : ""
        }
        confirmLabel="Revoke key"
        danger
        busy={busy}
        onConfirm={onConfirmRevoke}
        onClose={onCancelRevoke}
      />
      <ConfirmModal
        open={pendingRotate !== null}
        title="Rotate API key?"
        description={
          pendingRotate
            ? `Rotate "${pendingRotate.label}"? The current secret stops working immediately and a new one (same scopes) is shown once. Update the integration right after.`
            : ""
        }
        confirmLabel="Rotate key"
        danger
        busy={busy}
        onConfirm={onConfirmRotate}
        onClose={onCancelRotate}
      />
    </>
  );
}

export function ApiKeysSection(): ReactElement | null {
  const canAdmin = useCanAdmin();
  const actionGuidanceId = useId();
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const loadSeqRef = useRef(0);
  const loadingRef = useRef(false);

  // Create form.
  const [showCreate, setShowCreate] = useState<boolean>(false);
  const [label, setLabel] = useState<string>("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [creating, setCreating] = useState<boolean>(false);
  const [confirmCreateClose, setConfirmCreateClose] = useState(false);

  // One-time plaintext banner (create or rotate).
  const [plaintext, setPlaintext] = useState<string | null>(null);

  // Destructive confirms.
  const [pendingRevoke, setPendingRevoke] = useState<ApiKeyRow | null>(null);
  const [pendingRotate, setPendingRotate] = useState<ApiKeyRow | null>(null);
  const [confirmBusy, setConfirmBusy] = useState<boolean>(false);
  const operation = useSingleFlightOperation({
    ownerId: "workspace-api-keys",
    label: "Workspace API-key operation",
    detail: "Wait for the API-key request to finish before leaving Moosewave.",
  });
  const createDirty = showCreate && (label.trim() !== "" || scopes.length > 0);
  const discardCreateDraft = useCallback((): void => {
    setShowCreate(false);
    setLabel("");
    setScopes([]);
    setFormErr(null);
    setConfirmCreateClose(false);
  }, []);
  useDiscardOnlyDraftLifecycle({
    ownerId: "workspace-api-key-create",
    label: "Workspace API-key draft",
    dirty: createDirty,
    operationRef: operation.promiseRef,
    discard: discardCreateDraft,
    detail:
      "This API-key label and scope selection has not been submitted. It is kept only in this open form.",
  });
  const plaintextLifecycle = useShownOnceSecretLifecycle(
    "workspace-api-key",
    "Workspace API key",
    plaintext !== null,
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadSeqRef.current += 1;
    };
  }, []);

  async function load(): Promise<void> {
    if (loadingRef.current) return;
    loadingRef.current = true;
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setErr(null);
    try {
      const res = await api.listApiKeys();
      if (!mountedRef.current || seq !== loadSeqRef.current) return;
      if (res.error) {
        setErr(res.error.message);
        return;
      }
      setKeys(unwrapKeys(res.data));
    } catch (error) {
      if (!mountedRef.current || seq !== loadSeqRef.current) return;
      setErr(
        error instanceof Error && error.message
          ? error.message
          : "The API-key request failed unexpectedly.",
      );
    } finally {
      loadingRef.current = false;
      if (mountedRef.current && seq === loadSeqRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (canAdmin) void load();
  }, [canAdmin]);

  // Key-management routes all require the admin scope — non-admins
  // would only collect 403s, so render nothing (InactiveKeysCard
  // pattern).
  if (!canAdmin) return null;

  async function create(): Promise<void> {
    const draftErr = validateKeyDraft(label, scopes);
    if (draftErr) {
      setFormErr(draftErr);
      return;
    }
    setFormErr(null);
    const request = operation.run(async () => {
      const res = await api.createApiKey({ label: label.trim(), scopes });
      if (mountedRef.current && !res.error && res.data?.plaintext) {
        plaintextLifecycle.activate();
        setPlaintext(res.data.plaintext);
      }
      return res;
    });
    if (!request) return;
    setCreating(true);
    let res: Awaited<ReturnType<typeof api.createApiKey>>;
    try {
      res = await request;
      if (!mountedRef.current) return;
    } catch (error) {
      if (!mountedRef.current) return;
      setFormErr(
        lifecycleOperationError(error, "The API key couldn't be created."),
      );
      return;
    } finally {
      if (mountedRef.current) setCreating(false);
    }
    if (res.error) {
      setFormErr(res.error.message);
      return;
    }
    if (!res.data?.plaintext) {
      discardCreateDraft();
      toast.error(
        "The key may have been created, but its one-time secret was missing. Revoke the newest key before retrying.",
      );
      void load();
      return;
    }
    toast.success("API key created");
    setShowCreate(false);
    setLabel("");
    setScopes([]);
    void load();
  }

  async function confirmRevoke(): Promise<void> {
    if (!pendingRevoke) return;
    const target = pendingRevoke;
    const request = operation.run(() => api.deleteApiKey(target.id));
    if (!request) return;
    setConfirmBusy(true);
    let res: Awaited<ReturnType<typeof api.deleteApiKey>>;
    try {
      res = await request;
      if (!mountedRef.current) return;
    } catch (error) {
      if (!mountedRef.current) return;
      toast.error(
        `Couldn't revoke key: ${lifecycleOperationError(error, "The revoke request failed.")}`,
      );
      return;
    } finally {
      if (mountedRef.current) setConfirmBusy(false);
    }
    if (res.error) {
      toast.error(`Couldn't revoke key: ${res.error.message}`);
      return;
    }
    toast.success("Key revoked");
    setPendingRevoke((current) => (current?.id === target.id ? null : current));
    void load();
  }

  async function confirmRotate(): Promise<void> {
    if (!pendingRotate) return;
    const target = pendingRotate;
    const request = operation.run(async () => {
      const res = await api.rotateApiKey(target.id);
      if (mountedRef.current && !res.error && res.data?.plaintext) {
        plaintextLifecycle.activate();
        setPlaintext(res.data.plaintext);
      }
      return res;
    });
    if (!request) return;
    setConfirmBusy(true);
    let res: Awaited<ReturnType<typeof api.rotateApiKey>>;
    try {
      res = await request;
      if (!mountedRef.current) return;
    } catch (error) {
      if (!mountedRef.current) return;
      toast.error(
        `Couldn't rotate key: ${lifecycleOperationError(error, "The rotation request failed.")}`,
      );
      return;
    } finally {
      if (mountedRef.current) setConfirmBusy(false);
    }
    if (res.error) {
      toast.error(`Couldn't rotate key: ${res.error.message}`);
      return;
    }
    if (!res.data?.plaintext) {
      toast.error(
        "Rotation completed without a one-time secret. Revoke this key and create a replacement before using it.",
      );
      setPendingRotate((current) =>
        current?.id === target.id ? null : current,
      );
      void load();
      return;
    }
    toast.success("Key rotated — copy the new secret now");
    setPendingRotate((current) => (current?.id === target.id ? null : current));
    void load();
  }

  return (
    <div className="settings-section" data-testid="settings-api-keys-section">
      <SettingsSectionHeader
        title="API keys"
        description="Workspace bearer tokens (pw_…) for integrations and agents. Scopes are fixed at creation — the API has no scope-edit route; rotate to re-mint the same scopes with a new secret, or create a new key and revoke the old one."
        meta={
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => {
              if (plaintext !== null) return;
              if (showCreate) {
                if (createDirty) setConfirmCreateClose(true);
                else discardCreateDraft();
                return;
              }
              setShowCreate(true);
              setFormErr(null);
            }}
            disabled={operation.active}
            aria-busy={operation.active}
            aria-disabled={plaintext !== null || undefined}
            aria-describedby={actionGuidanceId}
          >
            {showCreate ? "Cancel" : "+ Create key"}
          </button>
        }
      />
      <div className="settings-section-body">
        <div
          id={actionGuidanceId}
          className="muted"
          role="status"
          aria-live="polite"
          style={{ fontSize: 11, marginBottom: 8, overflowWrap: "anywhere" }}
        >
          {operation.active
            ? "An API-key operation is in progress. Other key actions resume when it finishes."
            : plaintext !== null
              ? "Save or explicitly discard the one-time secret below before starting another key operation."
              : "New and rotated secrets are shown once. Store them before leaving this section."}
        </div>
        {plaintext ? (
          <ApiKeyPlaintextBanner
            plaintext={plaintext}
            onResolve={() => {
              plaintextLifecycle.resolve();
              setPlaintext(null);
            }}
          />
        ) : null}

        {showCreate ? (
          <ApiKeyCreateForm
            label={label}
            scopes={scopes}
            error={formErr}
            busy={creating || operation.active}
            secretPending={plaintext !== null}
            onLabelChange={setLabel}
            onScopesChange={setScopes}
            onCreate={() => void create()}
          />
        ) : null}

        <ApiKeyList
          keys={keys}
          loading={loading}
          error={err}
          operationActive={operation.active}
          plaintextPending={plaintext !== null}
          actionGuidanceId={actionGuidanceId}
          onReload={() => void load()}
          onRotate={setPendingRotate}
          onRevoke={setPendingRevoke}
        />
      </div>

      <ApiKeyConfirmations
        confirmCreateClose={confirmCreateClose}
        pendingRevoke={pendingRevoke}
        pendingRotate={pendingRotate}
        busy={confirmBusy}
        onDiscardCreate={discardCreateDraft}
        onCancelDiscardCreate={() => setConfirmCreateClose(false)}
        onConfirmRevoke={() => void confirmRevoke()}
        onCancelRevoke={() => {
          if (!confirmBusy && !operation.active) setPendingRevoke(null);
        }}
        onConfirmRotate={() => void confirmRotate()}
        onCancelRotate={() => {
          if (!confirmBusy && !operation.active) setPendingRotate(null);
        }}
      />
    </div>
  );
}

function ApiKeyPlaintextBanner({
  plaintext,
  onResolve,
}: {
  plaintext: string;
  onResolve: () => void;
}): ReactElement {
  const copy = (): void => {
    writeClipboardText(plaintext, {
      contentClass: "secret",
      label: "Workspace API key",
      clearIfUnchangedAfterMs: 60_000,
    })
      .then((result) => {
        if (result.ok) {
          toast.success({
            message: "API key copied",
            detail: clipboardSuccessDetail(result),
          });
        } else toast.error(result.message);
      })
      .catch(() => toast.error("The API key couldn't be copied."));
  };
  return (
    <div
      className="notice"
      style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}
      data-testid="api-key-plaintext-banner"
    >
      <span style={{ fontSize: 12 }}>
        New secret — copy it now. It is shown exactly once and cannot be
        recovered. Save this key before creating or rotating another — minting a
        second secret now would overwrite this one before you&apos;ve stored it.
      </span>
      <code className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
        {plaintext}
      </code>
      <div className="row" style={{ gap: 6 }}>
        <button type="button" className="btn btn-sm btn-primary" onClick={copy}>
          Copy
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={onResolve}
        >
          I&apos;ve saved it
        </button>
      </div>
    </div>
  );
}

function ApiKeyCreateForm({
  label,
  scopes,
  error,
  busy,
  secretPending,
  onLabelChange,
  onScopesChange,
  onCreate,
}: {
  label: string;
  scopes: string[];
  error: string | null;
  busy: boolean;
  secretPending: boolean;
  onLabelChange: (value: string) => void;
  onScopesChange: (value: string[]) => void;
  onCreate: () => void;
}): ReactElement {
  const createGuidanceId = useId();
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 12,
        background: "var(--pw-bg-elev)",
        borderRadius: 6,
        marginBottom: 12,
      }}
    >
      <div className="field">
        <label className="field-label" htmlFor="apikey-label">
          Label
        </label>
        <input
          id="apikey-label"
          type="text"
          className="input"
          placeholder="e.g. Zapier integration"
          value={label}
          onChange={(event) => onLabelChange(event.target.value)}
          disabled={busy}
        />
      </div>
      {API_KEY_SCOPE_GROUPS.map((group) => (
        <div key={group}>
          <div
            className="muted"
            style={{
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: 0.4,
              marginBottom: 6,
            }}
          >
            {group} scopes
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              gap: 6,
            }}
          >
            {API_KEY_SCOPES.filter((scope) => scope.group === group).map(
              (scope) => {
                const selected = scopes.includes(scope.id);
                return (
                  <label
                    key={scope.id}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      fontSize: 12,
                      padding: "6px 8px",
                      borderRadius: 4,
                      border: `1px solid ${
                        selected
                          ? scope.privileged
                            ? "var(--pw-danger)"
                            : "var(--pw-accent)"
                          : "var(--pw-border)"
                      }`,
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      aria-label={`${scope.id}: ${scope.description}`}
                      checked={selected}
                      disabled={busy}
                      onChange={() =>
                        onScopesChange(toggleScope(scopes, scope.id))
                      }
                      style={{ marginTop: 2 }}
                    />
                    <span>
                      <span className="mono" style={{ fontSize: 12 }}>
                        {scope.id}
                      </span>
                      <br />
                      <span className="muted" style={{ fontSize: 11 }}>
                        {scope.description}
                      </span>
                      {scope.privileged ? (
                        <>
                          <br />
                          <span
                            className="field-error"
                            style={{ fontSize: 10 }}
                          >
                            Privileged wildcard: grants every scope, including
                            key management.
                          </span>
                        </>
                      ) : null}
                    </span>
                  </label>
                );
              },
            )}
          </div>
        </div>
      ))}
      {error ? (
        <div className="field-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            if (!secretPending) onCreate();
          }}
          disabled={busy}
          aria-busy={busy}
          aria-disabled={secretPending || undefined}
          aria-describedby={createGuidanceId}
        >
          {busy ? "Creating…" : "Create key"}
        </button>
        <span id={createGuidanceId} className="muted" style={{ fontSize: 11 }}>
          {secretPending
            ? "Save or discard the one-time secret above before creating another key."
            : "Scopes can’t be changed later — pick the minimum the integration needs."}
        </span>
      </div>
    </div>
  );
}
