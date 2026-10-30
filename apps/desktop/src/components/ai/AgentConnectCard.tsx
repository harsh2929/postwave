/**
 * Canonical MCP client configuration projection. The selected client name may
 * persist; rendered configuration and shown-once credentials never do.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { useSingleFlightOperation } from "../../hooks/useSettingsDraftLifecycle";
import { useTabsInteraction } from "../../hooks/useTabsInteraction";
import { getApiUrl } from "../../lib/api-client";
import {
  clipboardSuccessDetail,
  writeClipboardText,
} from "../../lib/clipboard";
import { saveFile } from "../../lib/file-transfer";
import {
  MCP_CLIENTS,
  renderSnippet,
  type MCPClientSnippet,
} from "../../lib/mcp-install-snippets";
import { ConfirmModal } from "../ConfirmModal";
import { Notice } from "../Notice";
import { toast } from "../Toast";

interface Props {
  /** Memory-only plaintext from the canonical shown-once key owner. */
  apiKey: string;
  defaultClient?: string;
  /** False for release-held routes that may inspect templates but not transfer them. */
  transfersEnabled?: boolean;
}

const PREF_LS_KEY = "postwave.mcp.client.v1";
const LEGACY_PREF_LS_KEY = "postwave.ai.agent-client.v1";

function initialClientPreference(defaultClient?: string): string {
  const fallback = MCP_CLIENTS.some((client) => client.client === "Claude Code")
    ? "Claude Code"
    : (MCP_CLIENTS[0]?.client ?? "Claude Code");
  let candidate = defaultClient;
  if (!candidate && typeof localStorage === "undefined") return fallback;
  try {
    candidate ??=
      localStorage.getItem(PREF_LS_KEY) ??
      localStorage.getItem(LEGACY_PREF_LS_KEY) ??
      fallback;
  } catch {
    return fallback;
  }
  return MCP_CLIENTS.some((client) => client.client === candidate)
    ? candidate
    : fallback;
}

function configFilenameFor(client: string): string {
  const names: Record<string, string> = {
    "Claude Desktop": "claude_desktop_config.json",
    Cursor: "mcp.json",
    Continue: "continue-mcp.json",
    Zed: "zed-mcp.json",
    Windsurf: "mcp_config.json",
    "VS Code (1.99+)": ".vscode-mcp.json",
    "ChatGPT (Custom Connector)": "chatgpt-postwave-connector.json",
    "Generic HTTP / SSE": "run-postwave-mcp.sh",
    "Claude Code": "install-postwave-mcp.sh",
  };
  return names[client] ?? "mcp.json";
}

function suggestedMimeFor(language: "bash" | "json"): string {
  return language === "json" ? "application/json" : "text/x-shellscript";
}

function agentTransferReason(
  active: boolean,
  kind: "copy" | "save" | null,
  rendered: string,
  placeholder: boolean,
): string {
  if (active) {
    return kind === "save"
      ? "A configuration save is already in progress."
      : "A clipboard write is already in progress.";
  }
  if (!rendered) return "This client template could not be rendered.";
  return placeholder
    ? "This configuration contains a placeholder and cannot authenticate until an API key is inserted."
    : "This configuration contains the memory-only shown-once API key.";
}

/** A copy receipt tracks projection identity without retaining secret text. */
function useConfigurationCopyReceipt(rendered: string): {
  copied: boolean;
  projectionId: symbol;
  acknowledge: (projectionId: symbol) => void;
} {
  const [copiedProjectionId, setCopiedProjectionId] = useState<symbol | null>(
    null,
  );
  const projectionId = useMemo(
    () => Symbol("MCP configuration projection"),
    [rendered],
  );
  useEffect(() => {
    if (!copiedProjectionId) return;
    const id = globalThis.setTimeout(() => setCopiedProjectionId(null), 1_500);
    return () => globalThis.clearTimeout(id);
  }, [copiedProjectionId]);
  return {
    copied: copiedProjectionId === projectionId,
    projectionId,
    acknowledge: setCopiedProjectionId,
  };
}

export function AgentConnectCard({
  apiKey,
  defaultClient,
  transfersEnabled = true,
}: Props): ReactElement {
  const [activeClient, setActiveClient] = useState(() =>
    initialClientPreference(defaultClient),
  );
  const [operationKind, setOperationKind] = useState<"copy" | "save" | null>(
    null,
  );
  const [confirmCredentialSave, setConfirmCredentialSave] = useState(false);
  const mountedRef = useRef(true);
  const headingId = useId();
  const operationHelpId = useId();
  const operation = useSingleFlightOperation({
    ownerId: "mcp-client-configuration",
    label: "MCP client configuration transfer",
    detail:
      "Wait for the credential-aware clipboard or file transfer to finish before leaving Moosewave.",
  });
  const runOperation = operation.run;

  const active: MCPClientSnippet | undefined = useMemo(
    () =>
      MCP_CLIENTS.find((client) => client.client === activeClient) ??
      MCP_CLIENTS[0],
    [activeClient],
  );
  const selectedClient = active?.client ?? activeClient;
  const tabs = useTabsInteraction({
    value: selectedClient,
    items: MCP_CLIENTS.map((client) => ({ value: client.client })),
    onChange: setActiveClient,
  });
  const placeholderActive = apiKey.length === 0;
  const rendered = useMemo(
    () => (active ? renderSnippet(active.template, apiKey, getApiUrl()) : ""),
    [active, apiKey],
  );
  const displayedSnippet = useMemo(() => {
    if (transfersEnabled) return rendered;
    if (selectedClient === "ChatGPT (Custom Connector)") {
      return [
        "Hosted connector configuration unavailable.",
        "No production deployment or tenant-safe hosted authentication boundary is qualified for mcp.moosewave.com.",
      ].join("\n");
    }
    return [
      "FORMAT REFERENCE — NOT A RUNNABLE CONFIGURATION",
      "Client: " + selectedClient,
      "Runtime shape: local @postwave/mcp-server proxy",
      "Credential: excluded",
      "API origin: requires independent review",
      selectedClient === "Generic HTTP / SSE"
        ? "Hosted transport: unavailable pending deployment and tenant-isolation qualification"
        : "Provisioning: release-held pending transport-independent governance",
    ].join("\n");
  }, [rendered, selectedClient, transfersEnabled]);
  const copyReceipt = useConfigurationCopyReceipt(rendered);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(PREF_LS_KEY, activeClient);
      localStorage.removeItem(LEGACY_PREF_LS_KEY);
    } catch {
      // Client preference is optional and never contains configuration data.
    }
  }, [activeClient]);

  useEffect(() => {
    setConfirmCredentialSave(false);
  }, [apiKey, selectedClient]);

  const copy = useCallback((): void => {
    if (!rendered) return;
    const snapshot = rendered;
    const projectionId = copyReceipt.projectionId;
    const containsCredential = !placeholderActive;
    const request = runOperation(async () => {
      setOperationKind("copy");
      return writeClipboardText(snapshot, {
        contentClass: containsCredential ? "secret" : "personal",
        label: "Agent connection configuration",
        clearIfUnchangedAfterMs: containsCredential ? 60_000 : undefined,
      });
    });
    if (!request) return;
    void request
      .then((result) => {
        if (!mountedRef.current) return;
        if (!result.ok) {
          toast.error(result.message);
          return;
        }
        copyReceipt.acknowledge(projectionId);
        const detail = clipboardSuccessDetail(result);
        toast.success(
          detail
            ? { message: "Configuration copied", detail }
            : "Configuration copied",
        );
      })
      .catch(() => {
        if (mountedRef.current) {
          toast.error(
            "The configuration could not be copied. Focus Moosewave and retry.",
          );
        }
      })
      .finally(() => {
        if (mountedRef.current) setOperationKind(null);
      });
  }, [copyReceipt, placeholderActive, rendered, runOperation]);

  const saveConfiguration = useCallback(async (): Promise<boolean> => {
    if (!active || !rendered) return false;
    const snapshot = rendered;
    const client = active.client;
    const language = active.language;
    const containsCredential = !placeholderActive;
    const request = runOperation(async () => {
      setOperationKind("save");
      return saveFile({
        data: snapshot,
        suggestedName: configFilenameFor(client),
        label: client + " agent configuration",
        privacy: containsCredential ? "confidential" : "personal",
        mimeType: suggestedMimeFor(language),
      });
    });
    if (!request) return false;
    try {
      const saved = await request;
      if (!mountedRef.current) return false;
      if (!saved.ok) {
        toast.error(
          "The configuration could not be saved. Choose a valid destination and retry.",
        );
        return false;
      }
      if (saved.status !== "cancelled") {
        toast.success(
          containsCredential
            ? "Credential configuration saved"
            : "Placeholder configuration saved",
        );
      }
      return true;
    } catch {
      if (mountedRef.current) {
        toast.error(
          "The configuration could not be saved. Choose a destination and retry.",
        );
      }
      return false;
    } finally {
      if (mountedRef.current) setOperationKind(null);
    }
  }, [active, placeholderActive, rendered, runOperation]);

  if (!active) {
    return (
      <Notice tone="danger" title="No MCP client templates are available">
        The installed desktop build does not contain a client configuration
        catalogue.
      </Notice>
    );
  }

  const actionReason = agentTransferReason(
    operation.active,
    operationKind,
    rendered,
    placeholderActive,
  );
  const effectiveActionReason = transfersEnabled
    ? actionReason
    : "Copy and save are unavailable while production MCP provisioning is release-held.";

  return (
    <section className="card mcp-agent-connect" aria-labelledby={headingId}>
      <div>
        <h3 id={headingId} className="section-title">
          {transfersEnabled
            ? "Connect an MCP client"
            : "Review MCP client formats"}
        </h3>
        <p className="muted small">
          {transfersEnabled
            ? "Select the exact client format. Only the client-name preference is stored; configuration text and credentials remain memory-only unless you explicitly copy or save them."
            : "Select a client to inspect its transport shape. This release-held view emits no runnable configuration, credential, clipboard write, or file transfer."}
        </p>
      </div>

      <div
        ref={tabs.listRef}
        {...tabs.listProps}
        aria-label="MCP client configuration"
        className="mcp-client-tabs"
      >
        {MCP_CLIENTS.map((client) => (
          <button
            key={client.client}
            type="button"
            {...tabs.getTabProps(client.client)}
            className={
              "mcp-client-tab " +
              (client.client === selectedClient ? "active" : "")
            }
          >
            {client.client}
          </button>
        ))}
      </div>

      {MCP_CLIENTS.filter((client) => client.client !== selectedClient).map(
        (client) => (
          <div key={client.client} {...tabs.getPanelProps(client.client)} />
        ),
      )}
      <section {...tabs.getPanelProps(selectedClient)}>
        <p className="muted small">
          {transfersEnabled
            ? active.hint
            : "Format reference only. Installation paths and launch commands are intentionally withheld."}
        </p>
        <div className="mcp-snippet-state">
          <span
            className={
              "badge " +
              (!transfersEnabled || placeholderActive ? "warning" : "success")
            }
          >
            {!transfersEnabled
              ? "Credential excluded · non-runnable"
              : placeholderActive
                ? "Placeholder · cannot authenticate"
                : "Shown-once credential included"}
          </span>
          <span className="muted small">
            {transfersEnabled
              ? active.language === "json"
                ? "JSON configuration"
                : "Shell command"
              : "Non-runnable structural outline"}
          </span>
        </div>

        <pre
          className="mcp-agent-snippet"
          aria-label={
            selectedClient +
            (!transfersEnabled
              ? " release-held non-runnable format reference"
              : placeholderActive
                ? " configuration with API-key placeholder"
                : " configuration containing the shown-once API key")
          }
        >
          <code>{displayedSnippet}</code>
        </pre>

        {!transfersEnabled &&
        (selectedClient === "ChatGPT (Custom Connector)" ||
          selectedClient === "Generic HTTP / SSE") ? (
          <Notice
            tone="danger"
            title="Hosted transport is not a runnable production option"
            announcement="off"
          >
            The published hostname, deployment ownership, OAuth model, and
            multi-tenant credential isolation have not been qualified. No bearer
            credential should be sent to that origin.
          </Notice>
        ) : null}

        <Notice
          tone={!transfersEnabled || placeholderActive ? "warning" : "danger"}
          title={
            !transfersEnabled
              ? "Reference only—not a client configuration"
              : placeholderActive
                ? "Insert a key before connecting"
                : "This projection contains a plaintext credential"
          }
          announcement="off"
        >
          {!transfersEnabled
            ? "No key or executable configuration is emitted from this page. Do not infer tool authorization or approval coverage from this structural outline."
            : placeholderActive
              ? "Mint an MCP API key above, or replace the API-key placeholder in a protected editor before use."
              : "Copying may leave the value in clipboard history. Saving writes it to disk. Restrict file access, then explicitly resolve the shown-once key above."}
        </Notice>

        {transfersEnabled ? (
          <div className="mcp-config-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                if (transfersEnabled) copy();
              }}
              aria-disabled={
                !transfersEnabled || operation.active || !rendered || undefined
              }
              aria-describedby={operationHelpId}
            >
              {!transfersEnabled
                ? "Copy unavailable"
                : operationKind === "copy"
                  ? "Copying…"
                  : copyReceipt.copied
                    ? "Copied"
                    : "Copy configuration"}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                if (!transfersEnabled || operation.active || !rendered) return;
                if (placeholderActive) void saveConfiguration();
                else setConfirmCredentialSave(true);
              }}
              aria-disabled={
                !transfersEnabled || operation.active || !rendered || undefined
              }
              aria-describedby={operationHelpId}
            >
              {!transfersEnabled
                ? "Save unavailable"
                : operationKind === "save"
                  ? "Saving…"
                  : placeholderActive
                    ? "Save placeholder config…"
                    : "Save credential config…"}
            </button>
          </div>
        ) : null}
        {transfersEnabled ? (
          <p id={operationHelpId} className="muted small" aria-live="polite">
            {effectiveActionReason}
          </p>
        ) : (
          <p className="muted small" role="status">
            No transfer actions are mounted in this release-held view.
          </p>
        )}
      </section>

      <ConfirmModal
        open={confirmCredentialSave}
        title="Save a plaintext credential configuration?"
        description={
          "The " +
          selectedClient +
          " file will contain the shown-once API key in plaintext."
        }
        confirmLabel="Save credential file…"
        busy={operation.active}
        onConfirm={async () => {
          const finished = await saveConfiguration();
          if (finished && mountedRef.current) {
            setConfirmCredentialSave(false);
          }
        }}
        onClose={() => {
          if (!operation.active) setConfirmCredentialSave(false);
        }}
      >
        <p>
          Save only to a protected location, restrict file permissions, and
          resolve the shown-once key after the client connects.
        </p>
      </ConfirmModal>
    </section>
  );
}
