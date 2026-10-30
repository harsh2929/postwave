// SPDX-License-Identifier: AGPL-3.0-only

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from "react";

import { useOnline } from "../../lib/online-manager";
import {
  createReplyMailbox,
  deleteReplyMailbox,
  listReplyMailboxes,
  setReplyMailboxEnabled,
  tenantMailboxSecretPrefix,
  type ReplyMailbox,
} from "../../lib/reply-mailboxes";
import {
  useCanAdmin,
  useMe,
  useRoleStatus,
} from "../../lib/store";
import { ConfirmModal } from "../ConfirmModal";
import { FormField } from "../FormField";
import { Notice } from "../Notice";

type Confirmation = {
  kind: "enable" | "disable" | "delete";
  mailbox: ReplyMailbox;
};

export function ReplyMailboxCard(): ReactElement {
  const me = useMe();
  const roleStatus = useRoleStatus();
  const canAdmin = useCanAdmin();
  const online = useOnline();
  const onlineNow = online === "online";
  const identity = me
    ? `${me.user}\u001f${me.tenant}\u001f${me.effectiveRole}`
    : null;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const mountedRef = useRef(true);
  const requestRef = useRef(0);
  const readControllerRef = useRef<AbortController | null>(null);
  const operationRef = useRef<AbortController | null>(null);
  const [rows, setRows] = useState<ReplyMailbox[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [label, setLabel] = useState("");
  const [host, setHost] = useState("");
  const [folder, setFolder] = useState("INBOX");
  const [usernameRef, setUsernameRef] = useState("");
  const [passwordRef, setPasswordRef] = useState("");
  const instanceId = useId();
  const labelId = `${instanceId}-label`;
  const hostId = `${instanceId}-host`;
  const folderId = `${instanceId}-folder`;
  const usernameRefId = `${instanceId}-username-reference`;
  const passwordRefId = `${instanceId}-password-reference`;
  const prefix = useMemo(() => {
    if (!me) return null;
    try {
      return tenantMailboxSecretPrefix(me.tenant);
    } catch {
      return null;
    }
  }, [me]);

  const load = useCallback(async (): Promise<void> => {
    if (!identity || roleStatus !== "resolved" || !onlineNow) return;
    const request = ++requestRef.current;
    const expectedIdentity = identity;
    readControllerRef.current?.abort();
    const controller = new AbortController();
    readControllerRef.current = controller;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await listReplyMailboxes(controller.signal);
      if (
        !mountedRef.current ||
        request !== requestRef.current ||
        identityRef.current !== expectedIdentity
      ) {
        return;
      }
      setRows(next);
      setLoaded(true);
    } catch {
      if (
        mountedRef.current &&
        request === requestRef.current &&
        identityRef.current === expectedIdentity
      ) {
        setLoadError("Reply mailboxes could not be verified.");
      }
    } finally {
      if (mountedRef.current && request === requestRef.current) setLoading(false);
    }
  }, [identity, onlineNow, roleStatus]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      readControllerRef.current?.abort();
      operationRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    requestRef.current += 1;
    readControllerRef.current?.abort();
    operationRef.current?.abort();
    setRows([]);
    setLoaded(false);
    setLoadError(null);
    setOperationError(null);
    setReceipt(null);
    setConfirmation(null);
    setLabel("");
    setHost("");
    setFolder("INBOX");
    setUsernameRef("");
    setPasswordRef("");
  }, [identity, roleStatus]);

  useEffect(() => {
    if (identity && roleStatus === "resolved" && onlineNow) void load();
  }, [identity, load, onlineNow, roleStatus]);

  function beginOperation(): { controller: AbortController; identity: string } {
    if (!canAdmin) throw new Error("Admin access is required.");
    if (!onlineNow) throw new Error("Reconnect before changing reply mailboxes.");
    if (!identity) throw new Error("Workspace identity is unresolved.");
    operationRef.current?.abort();
    const controller = new AbortController();
    operationRef.current = controller;
    setBusy(true);
    setOperationError(null);
    setReceipt(null);
    return { controller, identity };
  }

  function assertIdentity(expected: string): void {
    if (!mountedRef.current || identityRef.current !== expected) {
      throw new Error("Workspace identity or authority changed. Nothing was confirmed in this view.");
    }
  }

  async function reconcile(
    controller: AbortController,
    expectedIdentity: string,
    assertion: (next: ReplyMailbox[]) => boolean,
  ): Promise<void> {
    const next = await listReplyMailboxes(controller.signal);
    assertIdentity(expectedIdentity);
    if (!assertion(next)) {
      throw new Error("A fresh mailbox read did not confirm the operation.");
    }
    setRows(next);
    setLoaded(true);
  }

  async function create(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    try {
      const operation = beginOperation();
      if (!me) throw new Error("Workspace identity is unresolved.");
      const created = await createReplyMailbox(
        {
          label,
          host,
          folder,
          usernameSecretRef: usernameRef,
          passwordSecretRef: passwordRef,
        },
        me.tenant,
        operation.controller.signal,
      );
      assertIdentity(operation.identity);
      if (created.enabled) {
        throw new Error("The server did not confirm disabled-first registration.");
      }
      await reconcile(
        operation.controller,
        operation.identity,
        (next) => next.some((row) => row.id === created.id && !row.enabled),
      );
      setLabel("");
      setHost("");
      setFolder("INBOX");
      setUsernameRef("");
      setPasswordRef("");
      setReceipt(`${created.label} registered disabled. Review it before enabling polling.`);
    } catch (error) {
      if (mountedRef.current) {
        setOperationError(
          error instanceof Error ? error.message : "Mailbox registration could not be confirmed.",
        );
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  async function confirmAction(): Promise<void> {
    if (!confirmation) return;
    const { kind, mailbox } = confirmation;
    try {
      const operation = beginOperation();
      if (kind === "delete") {
        await deleteReplyMailbox(mailbox.id, operation.controller.signal);
        assertIdentity(operation.identity);
        await reconcile(
          operation.controller,
          operation.identity,
          (next) => !next.some((row) => row.id === mailbox.id),
        );
        setReceipt(`${mailbox.label} and its poll cursor were deleted.`);
      } else {
        const enabled = kind === "enable";
        const changed = await setReplyMailboxEnabled(
          mailbox.id,
          enabled,
          operation.controller.signal,
        );
        assertIdentity(operation.identity);
        if (changed.id !== mailbox.id || changed.enabled !== enabled) {
          throw new Error("The action receipt did not match the reviewed mailbox.");
        }
        await reconcile(
          operation.controller,
          operation.identity,
          (next) => next.some((row) => row.id === mailbox.id && row.enabled === enabled),
        );
        setReceipt(
          enabled
            ? `${mailbox.label} is enabled. This is registry state, not live mailbox certification.`
            : `${mailbox.label} is disabled; its poll cursor is retained.`,
        );
      }
      setConfirmation(null);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "The mailbox action could not be confirmed.";
      if (mountedRef.current) setOperationError(message);
      throw new Error(message);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  const confirmedMailbox = confirmation?.mailbox;
  const confirmationTitle = confirmation
    ? confirmation.kind === "delete"
      ? `Delete ${confirmedMailbox?.label}?`
      : `${confirmation.kind === "enable" ? "Enable" : "Disable"} ${confirmedMailbox?.label}?`
    : "Review mailbox action";
  const confirmationDescription = confirmation
    ? confirmation.kind === "delete"
      ? "This deletes the registration and poll cursor. A later replacement starts at the mailbox's then-current high-water mark, so replies received while it was absent may be skipped. Disable instead if you may resume later; deployment secret values are not deleted."
      : confirmation.kind === "enable"
        ? "Polling will begin from the stored cursor. This does not certify a successful connection."
        : "Polling stops, but the cursor is retained for a later resume."
    : undefined;

  return (
    <section className="card" style={{ padding: 18 }} aria-labelledby={`${instanceId}-title`}>
      <header style={{ display: "flex", alignItems: "start", justifyContent: "space-between", gap: 12 }}>
        <div>
          <h3 id={`${instanceId}-title`} style={{ margin: 0 }}>Reply mailbox capture</h3>
          <p className="muted" style={{ margin: "6px 0 0" }}>
            IMAP registry and poller evidence—not live mailbox certification.
          </p>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => void load()} disabled={!onlineNow || loading || roleStatus !== "resolved"}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
        {!onlineNow ? (
          <Notice tone="warning" title="Reconnect to verify mailbox state">
            Changes are online-only and never queued. Last-loaded rows remain visible but may be stale.
          </Notice>
        ) : null}
        {roleStatus === "loading" ? (
          <p role="status" className="muted">Resolving mailbox access…</p>
        ) : roleStatus === "unavailable" || !identity ? (
          <Notice tone="danger" title="Workspace identity unavailable">
            Mailbox state was not requested and is not being shown as empty.
          </Notice>
        ) : loading && !loaded ? (
          <p role="status" className="muted">Loading reply mailboxes…</p>
        ) : loadError && !loaded ? (
          <Notice
            tone="danger"
            title="Reply mailboxes could not be verified"
            action={
              <button type="button" className="btn btn-sm" onClick={() => void load()} disabled={!onlineNow || loading}>
                Retry
              </button>
            }
          >
            A failed request is not being presented as an empty registry.
          </Notice>
        ) : loaded && rows.length === 0 ? (
          <Notice tone="neutral" announcement="off">
            No reply mailboxes are registered in this workspace.
          </Notice>
        ) : !loaded && !onlineNow ? (
          <p role="status" className="muted">Mailbox state has not been loaded on this connection.</p>
        ) : null}

        {rows.length > 0 ? (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 10 }} aria-label="Registered reply mailboxes">
            {rows.map((mailbox) => (
              <MailboxRow
                key={mailbox.id}
                mailbox={mailbox}
                canAdmin={canAdmin}
                busy={busy}
                online={onlineNow}
                onConfirm={setConfirmation}
              />
            ))}
          </ul>
        ) : null}

        {loadError && loaded ? (
          <Notice tone="warning">The latest refresh failed. Last verified rows remain visible.</Notice>
        ) : null}
        {operationError ? <Notice tone="danger" announcement="assertive">{operationError}</Notice> : null}
        {receipt ? <Notice tone="success" announcement="polite">{receipt}</Notice> : null}

        {canAdmin && prefix ? (
          <form onSubmit={(event) => void create(event)} style={{ borderTop: "1px solid var(--pw-border)", paddingTop: 16, display: "grid", gap: 12 }}>
            <div>
              <strong>Register a disabled mailbox</strong>
              <p className="muted" style={{ margin: "4px 0 0" }}>
                References only—never usernames or passwords. Transport is fixed to implicit TLS on port 993.
              </p>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
              <FormField label="Label" htmlFor={labelId} required>
                <input id={labelId} value={label} onChange={(event) => setLabel(event.target.value)} maxLength={200} disabled={busy} />
              </FormField>
              <FormField label="IMAP host" htmlFor={hostId} required help="Public DNS name; do not include a scheme or port.">
                <input id={hostId} value={host} onChange={(event) => setHost(event.target.value)} placeholder="imap.example.com" maxLength={253} autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={busy} />
              </FormField>
              <FormField label="Folder" htmlFor={folderId} required>
                <input id={folderId} value={folder} onChange={(event) => setFolder(event.target.value)} maxLength={255} disabled={busy} />
              </FormField>
            </div>
            <FormField label="Username secret reference" htmlFor={usernameRefId} required>
              <input id={usernameRefId} value={usernameRef} onChange={(event) => setUsernameRef(event.target.value)} placeholder={`${prefix}SUPPORT_USERNAME`} maxLength={192} autoComplete="off" autoCapitalize="off" spellCheck={false} disabled={busy} />
            </FormField>
            <FormField label="Password secret reference" htmlFor={passwordRefId} required help={`Required prefix: ${prefix}`}>
              <input id={passwordRefId} value={passwordRef} onChange={(event) => setPasswordRef(event.target.value)} placeholder={`${prefix}SUPPORT_PASSWORD`} maxLength={192} autoComplete="off" autoCapitalize="off" spellCheck={false} disabled={busy} />
            </FormField>
            <div>
              <button type="submit" className="btn btn-primary" disabled={!onlineNow || busy}>
                {busy ? "Working…" : "Register disabled mailbox"}
              </button>
            </div>
          </form>
        ) : roleStatus === "resolved" && !canAdmin ? (
          <Notice tone="neutral" announcement="off">
            Reply mailbox configuration is read-only for your effective role. An admin outside viewer preview can manage it.
          </Notice>
        ) : null}
      </div>

      <ConfirmModal
        open={confirmation !== null}
        title={confirmationTitle}
        description={confirmationDescription}
        confirmLabel={
          confirmation?.kind === "delete"
            ? "Delete mailbox"
            : confirmation?.kind === "enable"
              ? "Enable polling"
              : "Disable polling"
        }
        danger={confirmation?.kind !== "enable"}
        typeToConfirm={confirmation?.kind === "delete" ? confirmedMailbox?.label : undefined}
        busy={busy}
        onClose={() => {
          if (!busy) setConfirmation(null);
        }}
        onConfirm={confirmAction}
      />
    </section>
  );
}

function MailboxRow({
  mailbox,
  canAdmin,
  busy,
  online,
  onConfirm,
}: {
  mailbox: ReplyMailbox;
  canAdmin: boolean;
  busy: boolean;
  online: boolean;
  onConfirm: (confirmation: Confirmation) => void;
}): ReactElement {
  const quarantined = Boolean(mailbox.securityQuarantinedAt);
  const failing = Boolean(mailbox.lastError?.trim());
  const status = quarantined
    ? "Security quarantined"
    : failing
      ? "Poll failing"
      : mailbox.enabled
        ? mailbox.lastPolledAt
          ? "Polling"
          : "Awaiting first poll"
        : "Disabled";
  return (
    <li className="card" style={{ padding: 14 }}>
      <div style={{ display: "flex", alignItems: "start", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <strong>{mailbox.label}</strong>
          <p className="muted" style={{ margin: "4px 0 0", overflowWrap: "anywhere" }}>
            {mailbox.host}:{mailbox.port} · {mailbox.folder} · {mailbox.useTLS ? "implicit TLS" : "unsafe legacy transport"}
          </p>
        </div>
        <span className={`badge ${quarantined || failing ? "warning" : mailbox.enabled ? "success" : ""}`}>{status}</span>
      </div>
      <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8, margin: "12px 0 0", fontSize: 12 }}>
        <div>
          <dt>Username reference</dt>
          <dd style={{ margin: "3px 0 0", overflowWrap: "anywhere", fontFamily: "var(--pw-font-mono)" }}>{mailbox.usernameSecretRef}</dd>
        </div>
        <div>
          <dt>Last poll</dt>
          <dd style={{ margin: "3px 0 0" }}>{mailbox.lastPolledAt ? <time dateTime={mailbox.lastPolledAt}>{new Date(mailbox.lastPolledAt).toLocaleString()}</time> : "No completed poll recorded"}</dd>
        </div>
      </dl>
      {mailbox.lastError ? (
        <Notice tone="danger" announcement="off" style={{ marginTop: 10 }}>
          Last poll error: <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{mailbox.lastError}</span>
        </Notice>
      ) : null}
      {quarantined ? (
        <Notice tone="warning" announcement="off" style={{ marginTop: 10 }}>
          This legacy registration cannot be enabled. Delete it and register a safe replacement.
        </Notice>
      ) : null}
      {canAdmin ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!online || busy || quarantined}
            aria-label={`${mailbox.enabled ? "Disable" : "Enable"} polling for ${mailbox.label}`}
            onClick={() => onConfirm({ kind: mailbox.enabled ? "disable" : "enable", mailbox })}
          >
            {mailbox.enabled ? "Disable" : "Enable"}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            disabled={!online || busy}
            aria-label={`Delete ${mailbox.label}`}
            onClick={() => onConfirm({ kind: "delete", mailbox })}
          >
            Delete
          </button>
        </div>
      ) : null}
    </li>
  );
}
