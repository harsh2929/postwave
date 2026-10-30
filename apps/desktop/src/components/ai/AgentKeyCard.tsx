/**
 * AgentKeyCard — list existing API keys + mint a new "Agent" key.
 *
 * The mint flow picks a sensible default scope set for an MCP-connected
 * agent (read everything, write campaigns/subscribers, no admin). The
 * plaintext key is only returned on creation — we surface it in a
 * one-time modal/banner with copy + download so the user doesn't lose it.
 *
 * Selecting an existing key (or freshly minted one) sets it as the
 * canonical MCP Setup parent becomes the sole plaintext owner and passes the
 * value to AgentConnectCard for the in-memory snippet projection.
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
import { ConfirmModal } from "../ConfirmModal";
import {
  lifecycleOperationError,
  useDiscardOnlyDraftLifecycle,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import { toast } from "../Toast";

interface Props {
  /** The parent is the sole aggregate plaintext + lifecycle owner. */
  activePlaintext: string | null;
  onMintedPlaintext: (plaintext: string) => void;
  onPlaintextResolved: () => void;
}

const SCOPES_AGENT_DEFAULT = [
  "read:subscribers",
  "write:subscribers",
  "read:campaigns",
  "write:campaigns",
  "send:transactional",
  "read:reports",
];

const ALL_SCOPES = [
  "read:subscribers",
  "write:subscribers",
  "read:campaigns",
  "write:campaigns",
  "send:transactional",
  "read:reports",
  "admin",
];

const DEFAULT_AGENT_LABEL = "Moosewave Agent";

function unwrapKeys(payload: ApiKeysListResponse | undefined): ApiKeyRow[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload as ApiKeyRow[];
  return payload.items ?? payload.keys ?? payload.data ?? [];
}

export function AgentKeyCard({
  activePlaintext,
  onMintedPlaintext,
  onPlaintextResolved,
}: Props): ReactElement {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);

  const [showMint, setShowMint] = useState(false);
  const [label, setLabel] = useState(DEFAULT_AGENT_LABEL);
  const [scopes, setScopes] = useState<string[]>([...SCOPES_AGENT_DEFAULT]);
  const [mintBusy, setMintBusy] = useState(false);
  const [confirmMintClose, setConfirmMintClose] = useState(false);
  // Pending revoke target. Replaces a native window.confirm() so the
  // destructive prompt matches the rest of the admin surface.
  const [pendingRevoke, setPendingRevoke] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [copyBusy, setCopyBusy] = useState(false);
  const mountedRef = useRef(true);
  const loadRequestRef = useRef(0);
  const loadFlightRef = useRef(false);
  const copyRef = useRef(false);
  const onMintedPlaintextRef = useRef(onMintedPlaintext);
  onMintedPlaintextRef.current = onMintedPlaintext;
  const guidanceId = useId();
  const adminScopeHelpId = useId();
  const operation = useSingleFlightOperation({
    ownerId: "agent-api-key",
    label: "Agent API-key operation",
    detail: "Wait for the agent API-key request to finish before leaving.",
  });
  const defaultScopeKey = [...SCOPES_AGENT_DEFAULT].sort().join("\u001f");
  const draftDirty =
    showMint &&
    (label !== DEFAULT_AGENT_LABEL ||
      [...scopes].sort().join("\u001f") !== defaultScopeKey);
  const discardMintDraft = useCallback((): void => {
    setShowMint(false);
    setLabel(DEFAULT_AGENT_LABEL);
    setScopes([...SCOPES_AGENT_DEFAULT]);
    setConfirmMintClose(false);
  }, []);
  useDiscardOnlyDraftLifecycle({
    ownerId: "agent-api-key-create",
    label: "Agent API-key draft",
    dirty: draftDirty,
    operationRef: operation.promiseRef,
    discard: discardMintDraft,
    detail: "This agent-key label and scope selection has not been submitted.",
  });

  async function reload(): Promise<void> {
    if (loadFlightRef.current) return;
    loadFlightRef.current = true;
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    let r: Awaited<ReturnType<typeof api.listApiKeys>>;
    try {
      r = await api.listApiKeys();
    } catch (error) {
      loadFlightRef.current = false;
      if (!mountedRef.current || requestId !== loadRequestRef.current) return;
      setLoading(false);
      setListError(
        lifecycleOperationError(
          error,
          "The agent-key list couldn't be loaded.",
        ),
      );
      return;
    }
    loadFlightRef.current = false;
    if (!mountedRef.current || requestId !== loadRequestRef.current) return;
    setLoading(false);
    if (r.error) {
      setListError(r.error.message);
      return;
    }
    setListError(null);
    setKeys(unwrapKeys(r.data));
  }

  useEffect(() => {
    mountedRef.current = true;
    void reload();
    return () => {
      mountedRef.current = false;
      loadRequestRef.current += 1;
    };
  }, []);

  function toggleScope(s: string): void {
    setScopes((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );
  }

  async function mint(): Promise<void> {
    if (!label.trim() || scopes.length === 0 || activePlaintext) return;
    const submittedLabel = label.trim();
    const submittedScopes = [...scopes];
    setOperationError(null);
    const request = operation.run(async () => {
      const response = await api.createApiKey({
        label: submittedLabel,
        scopes: submittedScopes,
      });
      if (!response.error && response.data?.plaintext) {
        // MCP Setup synchronously activates the sole aggregate plaintext guard
        // before this retained request owner releases.
        onMintedPlaintextRef.current(response.data.plaintext);
      }
      return response;
    });
    if (!request) return;
    setMintBusy(true);
    let r: Awaited<ReturnType<typeof api.createApiKey>>;
    try {
      r = await request;
    } catch (error) {
      if (mountedRef.current) {
        setOperationError(
          lifecycleOperationError(error, "The agent key couldn't be minted."),
        );
      }
      return;
    } finally {
      if (mountedRef.current) setMintBusy(false);
    }
    if (!mountedRef.current) return;
    if (r.error) {
      setOperationError(r.error.message);
      return;
    }
    if (!r.data?.plaintext) {
      setOperationError(
        "The key may have been minted, but its one-time secret was missing. Revoke the newest key before retrying.",
      );
      discardMintDraft();
      void reload();
      return;
    }
    discardMintDraft();
    void reload();
  }

  function revoke(id: string, label: string): void {
    // Stage for ConfirmModal — confirmRevoke() runs the API call.
    setPendingRevoke({ id, label });
  }

  async function confirmRevoke(): Promise<void> {
    if (!pendingRevoke) return;
    const target = pendingRevoke;
    const request = operation.run(() => api.deleteApiKey(target.id));
    if (!request) return;
    setRevokeBusy(true);
    // GAP-2#12 — revoke is a security-critical "kill this agent's access
    // now" action. Ignoring the result closed the modal as if it succeeded
    // while the key stayed live. Check the result: on failure keep the modal
    // open and toast so the operator knows the credential is STILL valid.
    let res: Awaited<ReturnType<typeof api.deleteApiKey>>;
    try {
      res = await request;
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          `Couldn't revoke key: ${lifecycleOperationError(error, "The revoke request failed.")}`,
        );
      }
      return;
    } finally {
      if (mountedRef.current) setRevokeBusy(false);
    }
    if (!mountedRef.current) return;
    if (res.error) {
      toast.error(`Couldn't revoke key: ${res.error.message}`);
      return;
    }
    toast.success(`Revoked "${target.label}" — that key stops working now`);
    setPendingRevoke((current) => (current?.id === target.id ? null : current));
    void reload();
  }

  async function copyKey(): Promise<void> {
    if (!activePlaintext || copyRef.current) return;
    copyRef.current = true;
    setCopyBusy(true);
    let result: Awaited<ReturnType<typeof writeClipboardText>>;
    try {
      result = await writeClipboardText(activePlaintext, {
        contentClass: "secret",
        label: "Agent API key",
        clearIfUnchangedAfterMs: 60_000,
      });
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          lifecycleOperationError(
            error,
            "The agent API key couldn't be copied.",
          ),
        );
      }
      return;
    } finally {
      copyRef.current = false;
      if (mountedRef.current) setCopyBusy(false);
    }
    if (!mountedRef.current) return;
    if (result.ok) {
      toast.success({
        message: "Agent API key copied",
        detail: clipboardSuccessDetail(result),
      });
    } else toast.error(result.message);
  }

  const actionGuidance = activePlaintext
    ? "Store or explicitly discard the shown one-time key before minting or revoking another key."
    : operation.active
      ? "An agent-key request is in progress. Keep this setup open until it finishes."
      : "Minting creates a new credential. Revoking stops that exact key immediately.";

  return (
    <AgentKeyView
      keys={keys}
      loading={loading}
      listError={listError}
      operationError={operationError}
      showMint={showMint}
      label={label}
      scopes={scopes}
      mintBusy={mintBusy}
      operationBusy={operation.active}
      activePlaintext={activePlaintext}
      copyBusy={copyBusy}
      guidanceId={guidanceId}
      adminScopeHelpId={adminScopeHelpId}
      actionGuidance={actionGuidance}
      confirmMintClose={confirmMintClose}
      pendingRevoke={pendingRevoke}
      revokeBusy={revokeBusy}
      onToggleMint={() => {
        if (operation.active || activePlaintext !== null) return;
        if (showMint) {
          if (draftDirty) setConfirmMintClose(true);
          else discardMintDraft();
          return;
        }
        setShowMint(true);
      }}
      onRetry={() => void reload()}
      onLabelChange={setLabel}
      onToggleScope={toggleScope}
      onMint={() => void mint()}
      onCopy={() => void copyKey()}
      onPlaintextResolved={onPlaintextResolved}
      onRevoke={revoke}
      onDiscardMint={discardMintDraft}
      onKeepMint={() => setConfirmMintClose(false)}
      onConfirmRevoke={confirmRevoke}
      onCloseRevoke={() => {
        if (!operation.active) setPendingRevoke(null);
      }}
    />
  );
}

function AgentKeyView({
  keys,
  loading,
  listError,
  operationError,
  showMint,
  label,
  scopes,
  mintBusy,
  operationBusy,
  activePlaintext,
  copyBusy,
  guidanceId,
  adminScopeHelpId,
  actionGuidance,
  confirmMintClose,
  pendingRevoke,
  revokeBusy,
  onToggleMint,
  onRetry,
  onLabelChange,
  onToggleScope,
  onMint,
  onCopy,
  onPlaintextResolved,
  onRevoke,
  onDiscardMint,
  onKeepMint,
  onConfirmRevoke,
  onCloseRevoke,
}: {
  keys: ApiKeyRow[];
  loading: boolean;
  listError: string | null;
  operationError: string | null;
  showMint: boolean;
  label: string;
  scopes: string[];
  mintBusy: boolean;
  operationBusy: boolean;
  activePlaintext: string | null;
  copyBusy: boolean;
  guidanceId: string;
  adminScopeHelpId: string;
  actionGuidance: string;
  confirmMintClose: boolean;
  pendingRevoke: { id: string; label: string } | null;
  revokeBusy: boolean;
  onToggleMint: () => void;
  onRetry: () => void;
  onLabelChange: (value: string) => void;
  onToggleScope: (scope: string) => void;
  onMint: () => void;
  onCopy: () => void;
  onPlaintextResolved: () => void;
  onRevoke: (id: string, label: string) => void;
  onDiscardMint: () => void;
  onKeepMint: () => void;
  onConfirmRevoke: () => Promise<void>;
  onCloseRevoke: () => void;
}): ReactElement {
  return (
    <div
      className="card"
      style={{ display: "flex", flexDirection: "column", gap: 12 }}
    >
      <div className="ai-card-header">
        <div style={{ flex: 1 }}>
          <div className="section-title" style={{ marginBottom: 4 }}>
            Agent keys
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            Mint a key for your MCP-connected agent. Plaintext is shown once.
          </div>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={onToggleMint}
          disabled={operationBusy}
          aria-disabled={activePlaintext !== null ? true : undefined}
          aria-describedby={guidanceId}
        >
          {showMint ? "Cancel" : "+ Mint key"}
        </button>
      </div>

      <p
        id={guidanceId}
        className="muted"
        role="status"
        aria-live="polite"
        style={{ fontSize: 11, margin: 0 }}
      >
        {actionGuidance}
      </p>

      {listError ? (
        <div
          role="alert"
          style={{
            fontSize: 12,
            color: "var(--pw-danger)",
          }}
        >
          <span>Couldn&apos;t load agent keys: {listError}</span>{" "}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onRetry}
            disabled={loading}
          >
            Retry list
          </button>
        </div>
      ) : null}

      {operationError ? (
        <div role="alert" style={{ fontSize: 12, color: "var(--pw-danger)" }}>
          {operationError}
        </div>
      ) : null}

      {showMint ? (
        <AgentKeyMintForm
          label={label}
          scopes={scopes}
          busy={mintBusy || operationBusy}
          blocked={activePlaintext !== null}
          guidanceId={guidanceId}
          adminScopeHelpId={adminScopeHelpId}
          onLabelChange={onLabelChange}
          onToggleScope={onToggleScope}
          onMint={onMint}
        />
      ) : null}

      {activePlaintext ? (
        <div
          role="region"
          aria-label="New agent API key"
          style={{
            padding: 12,
            borderRadius: 6,
            background: "color-mix(in srgb, var(--pw-accent) 8%, transparent)",
            border:
              "1px solid color-mix(in srgb, var(--pw-accent) 28%, transparent)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 11, color: "var(--pw-fg-muted)" }}>
            New key — copy it now. It will never be shown again.
          </div>
          <div
            style={{
              fontFamily:
                "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              fontSize: 12,
              wordBreak: "break-all",
              color: "var(--pw-fg)",
              background: "var(--pw-bg-elev)",
              padding: 8,
              borderRadius: 3,
            }}
          >
            {activePlaintext}
          </div>
          <div className="ai-card-actions">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={onCopy}
              disabled={copyBusy}
            >
              {copyBusy ? "Copying…" : "Copy"}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={onPlaintextResolved}
              disabled={copyBusy}
            >
              I've saved it
            </button>
          </div>
        </div>
      ) : null}

      {loading ? (
        <div className="muted" style={{ fontSize: 12 }}>
          Loading keys…
        </div>
      ) : keys.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>
          No keys yet. Mint one above to enable agent access.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {keys.map((k) => (
            <KeyRow
              key={k.id}
              row={k}
              busy={operationBusy}
              blocked={activePlaintext !== null}
              guidanceId={guidanceId}
              onRevoke={() => onRevoke(k.id, k.label)}
            />
          ))}
        </div>
      )}
      {/* Revoke-key confirm. Replaces the legacy native confirm() so the
          destructive prompt matches the rest of the admin surface. */}
      <ConfirmModal
        open={confirmMintClose}
        title="Discard agent-key draft?"
        description="The unsaved label and scope selection will be cleared. No key has been minted yet."
        confirmLabel="Discard draft"
        cancelLabel="Keep editing"
        danger
        onConfirm={onDiscardMint}
        onClose={onKeepMint}
      />
      <ConfirmModal
        open={pendingRevoke !== null}
        title="Revoke API key?"
        description={
          pendingRevoke
            ? `Revoke "${pendingRevoke.label}"? Any agent using this key will stop working immediately.`
            : ""
        }
        confirmLabel="Revoke key"
        danger
        busy={revokeBusy}
        onConfirm={onConfirmRevoke}
        onClose={onCloseRevoke}
      />
    </div>
  );
}

function AgentKeyMintForm({
  label,
  scopes,
  busy,
  blocked,
  guidanceId,
  adminScopeHelpId,
  onLabelChange,
  onToggleScope,
  onMint,
}: {
  label: string;
  scopes: string[];
  busy: boolean;
  blocked: boolean;
  guidanceId: string;
  adminScopeHelpId: string;
  onLabelChange: (value: string) => void;
  onToggleScope: (scope: string) => void;
  onMint: () => void;
}): ReactElement {
  const mintStatusId = `${guidanceId}-mint-status`;
  const mintStatus = busy
    ? "Minting this exact label and scope set."
    : blocked
      ? "Resolve the currently shown one-time key before minting another."
      : !label.trim()
        ? "Add a label for this agent key."
        : scopes.length === 0
          ? "Select at least one scope."
          : `${scopes.length} scope${scopes.length === 1 ? "" : "s"} selected. Ready to mint.`;
  return (
    <div
      style={{
        background: "var(--pw-bg-elev-2)",
        padding: 12,
        borderRadius: 4,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <Field label="Label">
        <input
          type="text"
          value={label}
          onChange={(event) => onLabelChange(event.target.value)}
          placeholder="e.g. Claude Desktop · Lou's MBP"
          style={inputStyle}
          disabled={busy}
          aria-describedby={guidanceId}
        />
      </Field>
      <fieldset style={{ margin: 0, padding: 0, border: 0 }}>
        <legend
          style={{
            fontSize: 11,
            color: "var(--pw-fg-muted)",
            textTransform: "uppercase",
            letterSpacing: 0.4,
            marginBottom: 6,
          }}
        >
          Scopes
        </legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {ALL_SCOPES.map((scope) => {
            const selected = scopes.includes(scope);
            const isAdmin = scope === "admin";
            return (
              <button
                key={scope}
                type="button"
                onClick={() => onToggleScope(scope)}
                className="chip"
                aria-pressed={selected}
                aria-describedby={isAdmin ? adminScopeHelpId : undefined}
                disabled={busy}
                style={{
                  borderColor: selected
                    ? isAdmin
                      ? "var(--pw-danger)"
                      : "var(--pw-accent)"
                    : "var(--pw-border)",
                  background: selected
                    ? isAdmin
                      ? "color-mix(in srgb, var(--pw-danger) 12%, transparent)"
                      : "color-mix(in srgb, var(--pw-accent) 12%, transparent)"
                    : "transparent",
                  color: selected ? "var(--pw-fg)" : "var(--pw-fg-muted)",
                  fontWeight: selected ? 600 : 400,
                }}
              >
                {scope}
              </button>
            );
          })}
        </div>
        <p
          id={adminScopeHelpId}
          className="muted"
          style={{ fontSize: 11, margin: "6px 0 0" }}
        >
          Admin is privileged. Enable it only when this agent must manage API
          keys, webhooks, or domains.
        </p>
      </fieldset>
      <p
        id={mintStatusId}
        className="muted"
        role="status"
        aria-live="polite"
        style={{ fontSize: 11, margin: 0 }}
      >
        {mintStatus}
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onMint}
          disabled={busy}
          aria-disabled={
            blocked || !label.trim() || scopes.length === 0 ? true : undefined
          }
          aria-describedby={`${guidanceId} ${mintStatusId}`}
        >
          {busy ? "Minting…" : "Mint key"}
        </button>
      </div>
    </div>
  );
}

function KeyRow({
  row,
  busy,
  blocked,
  guidanceId,
  onRevoke,
}: {
  row: ApiKeyRow;
  busy: boolean;
  blocked: boolean;
  guidanceId: string;
  onRevoke: () => void;
}): ReactElement {
  const revoked = !!row.revokedAt;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto auto",
        gap: 8,
        alignItems: "center",
        padding: "8px 10px",
        background: "var(--pw-bg-elev-2)",
        borderRadius: 4,
        opacity: revoked ? 0.5 : 1,
      }}
    >
      <div>
        <div
          style={{
            fontSize: 12,
            color: "var(--pw-fg)",
            overflowWrap: "anywhere",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {row.label}
          {revoked ? (
            <span
              style={{
                fontSize: 9,
                background:
                  "color-mix(in srgb, var(--pw-fg-muted) 30%, transparent)",
                padding: "1px 6px",
                borderRadius: 999,
                color: "var(--pw-fg-muted)",
              }}
            >
              revoked
            </span>
          ) : null}
        </div>
        <div
          className="muted tabular"
          style={{
            fontSize: 10,
            fontFamily:
              "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          }}
        >
          {row.prefix}… · {(row.scopes ?? []).length} scope
          {(row.scopes ?? []).length === 1 ? "" : "s"}
        </div>
      </div>
      <div
        className="muted tabular"
        style={{ fontSize: 10, textAlign: "right" }}
      >
        {row.lastUsedAt
          ? new Date(row.lastUsedAt).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })
          : "unused"}
      </div>
      {revoked ? (
        <span />
      ) : (
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => {
            if (!blocked) onRevoke();
          }}
          disabled={busy}
          aria-disabled={blocked ? true : undefined}
          aria-describedby={guidanceId}
        >
          Revoke
        </button>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): ReactElement {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span
        style={{
          fontSize: 11,
          color: "var(--pw-fg-muted)",
          textTransform: "uppercase",
          letterSpacing: 0.4,
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--pw-bg-elev)",
  color: "var(--pw-fg)",
  border: "1px solid var(--pw-border)",
  borderRadius: 4,
  padding: "6px 10px",
  fontSize: 13,
  fontFamily: "inherit",
  width: "100%",
};
