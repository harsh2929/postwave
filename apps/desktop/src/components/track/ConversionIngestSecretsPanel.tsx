// SPDX-License-Identifier: AGPL-3.0-only

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { useShownOnceSecretLifecycle } from "../../hooks/useShownOnceSecretLifecycle";
import {
  useDiscardOnlyDraftLifecycle,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import { conversionsApi } from "../../lib/api-client";
import { clipboardAnnouncement, writeClipboardText } from "../../lib/clipboard";
import { isRemotePermissionError } from "../../lib/remote-resource";
import { useCanAdmin } from "../../lib/store";
import { ConfirmModal } from "../ConfirmModal";
import { Modal, ModalFooter } from "../Modal";
import { SectionHeader } from "../SectionHeader";
import { toast } from "../Toast";
import {
  CONVERSION_INGEST_V2_CONTRACT,
  conversionIngestSecretLabelError,
  issuedConversionIngestSecretSummary,
  parseConversionIngestSecretRegister,
  parseIssuedConversionIngestSecret,
  type VerifiedConversionIngestSecret,
  type VerifiedIssuedConversionIngestSecret,
} from "./conversion-ingest-secret-contract";
import {
  isUncertainMutationFailure,
  safeTrackFailure,
  safeAbsoluteTime,
} from "./track-maturity";

function projectionLabel(item: VerifiedConversionIngestSecret): string {
  switch (item.identityProjectionStatus) {
    case "ready":
      return "email HMAC ready";
    case "failed":
      return "email HMAC failed";
    default:
      return "email HMAC pending";
  }
}

function projectionGuidance(item: VerifiedConversionIngestSecret): string {
  if (item.identityProjectionStatus === "ready") {
    return "Email-HMAC identities may use this exact key. Click-ID and external-ID-only events are also accepted.";
  }
  if (item.identityProjectionStatus === "pending") {
    return "Do not move email-HMAC traffic yet: those requests receive 503 until this key is ready. Refresh and keep the previous ready key live. Click-ID and external-ID-only events are unaffected.";
  }
  if (item.identityProjectionErrorCode === "secret_unavailable") {
    return "This key cannot prepare email identities. Keep the previous ready key live, revoke this failed key, then issue a replacement. Click-ID and external-ID-only events are unaffected.";
  }
  return "Email identity projection failed. Keep the previous ready key live, refresh, and contact support if the failure remains. Do not move email-HMAC traffic. Click-ID and external-ID-only events are unaffected.";
}

function SecretCopyButton({ value }: { value: string }): ReactElement {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const operation = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const statusId = useId();
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const copy = (): void => {
    if (operation.current) return;
    setBusy(true);
    const pending = (async () => {
      const result = await writeClipboardText(value, {
        contentClass: "secret",
        label: "conversion signing secret",
        clearIfUnchangedAfterMs: 60_000,
      });
      const message = result.ok
        ? clipboardAnnouncement(result, "conversion signing secret")
        : result.message;
      if (!mounted.current) return;
      setStatus(message);
      if (result.ok) toast.success("Conversion signing secret copied");
      else toast.error(message);
    })().finally(() => {
      if (operation.current === pending) operation.current = null;
      if (mounted.current) setBusy(false);
    });
    operation.current = pending;
  };
  return (
    <span style={{ display: "grid", justifyItems: "end", gap: 4 }}>
      <button
        type="button"
        className="btn btn-sm"
        aria-disabled={busy || undefined}
        aria-describedby={status ? statusId : undefined}
        onClick={copy}
      >
        {busy ? "Copying…" : "Copy signing secret"}
      </button>
      {status ? (
        <span id={statusId} className="muted" role="status">
          {status}
        </span>
      ) : null}
    </span>
  );
}

export function ConversionIngestSecretsPanel(): ReactElement {
  const canAdmin = useCanAdmin();
  const canAdminRef = useRef(canAdmin);
  canAdminRef.current = canAdmin;
  const mounted = useRef(true);
  const [items, setItems] = useState<VerifiedConversionIngestSecret[] | null>(
    null,
  );
  const itemsRef = useRef<VerifiedConversionIngestSecret[] | null>(null);
  const cursorsRef = useRef(new Set<string>());
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [operationError, setOperationError] = useState<string | null>(null);
  const [issueUncertain, setIssueUncertain] = useState(false);
  const [revealed, setRevealed] =
    useState<VerifiedIssuedConversionIngestSecret | null>(null);
  const [stored, setStored] = useState(false);
  const [abandonOpen, setAbandonOpen] = useState(false);
  const [revoking, setRevoking] =
    useState<VerifiedConversionIngestSecret | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const operation = useSingleFlightOperation({
    ownerId: "conversion-ingest-secrets",
    label: "Conversion signed-ingest credential operation",
    detail: "Wait for the signed-ingest credential request to finish.",
  });
  const { activate: protectSecret, resolve: releaseSecret } =
    useShownOnceSecretLifecycle(
      "conversion-ingest-secret",
      "Conversion signed-ingest secret",
      revealed !== null,
    );

  const clearDraft = useCallback(() => {
    setLabel("");
    setOperationError(null);
    setIssueUncertain(false);
  }, []);
  useDiscardOnlyDraftLifecycle({
    ownerId: "conversion-ingest-secret-issue",
    label: "Conversion signing-key issue draft",
    dirty: label.trim() !== "",
    operationRef: operation.promiseRef,
    discard: clearDraft,
    detail: "This signing-key label has not been submitted.",
  });

  const clearPrivilegedState = useCallback(() => {
    clearDraft();
    releaseSecret();
    setRevealed(null);
    setStored(false);
    setAbandonOpen(false);
    setRevoking(null);
    setRevokeError(null);
    itemsRef.current = null;
    cursorsRef.current.clear();
    setItems(null);
    setNextCursor(null);
  }, [clearDraft, releaseSecret]);

  const reload = useCallback(
    async (cursor?: string): Promise<void> => {
      const append = cursor !== undefined;
      if (!canAdminRef.current) {
        itemsRef.current = null;
        setItems(null);
        setNextCursor(null);
        setLoadError(null);
        return;
      }
      if (append) setLoadingMore(true);
      else {
        setLoading(true);
        setNextCursor(null);
        cursorsRef.current.clear();
      }
      let response: Awaited<
        ReturnType<typeof conversionsApi.listIngestSecrets>
      >;
      try {
        response = await conversionsApi.listIngestSecrets(cursor);
      } catch {
        if (!mounted.current || !canAdminRef.current) return;
        if (append) setLoadingMore(false);
        else setLoading(false);
        setLoadError("The signed-ingest key register couldn't be loaded.");
        return;
      }
      if (!mounted.current || !canAdminRef.current) return;
      if (append) setLoadingMore(false);
      else setLoading(false);
      if (response.error) {
        const message = safeTrackFailure(
          response.error,
          "The signed-ingest key register couldn't be loaded.",
        );
        if (isRemotePermissionError(response.error)) {
          itemsRef.current = null;
          setItems(null);
          setNextCursor(null);
          clearPrivilegedState();
        }
        setLoadError(message);
        return;
      }
      const page = parseConversionIngestSecretRegister(response.data);
      if (!page) {
        itemsRef.current = null;
        setItems(null);
        setNextCursor(null);
        setLoadError(
          "The signed-ingest key register response could not be verified.",
        );
        return;
      }
      const merged = append
        ? [...(itemsRef.current ?? []), ...page.items]
        : page.items;
      if (new Set(merged.map((item) => item.keyId)).size !== merged.length) {
        itemsRef.current = null;
        setItems(null);
        setNextCursor(null);
        setLoadError(
          "The signed-ingest key register repeated a key across pages and could not be verified.",
        );
        return;
      }
      if (
        page.nextCursor &&
        (page.nextCursor === cursor || cursorsRef.current.has(page.nextCursor))
      ) {
        itemsRef.current = null;
        setItems(null);
        setNextCursor(null);
        setLoadError(
          "The signed-ingest key register repeated a cursor across pages and could not be verified.",
        );
        return;
      }
      if (page.nextCursor) cursorsRef.current.add(page.nextCursor);
      itemsRef.current = merged;
      setItems(merged);
      setNextCursor(page.nextCursor ?? null);
      setLoadError(null);
    },
    [clearPrivilegedState],
  );

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  useEffect(() => {
    if (canAdmin) return;
    itemsRef.current = null;
    setItems(null);
    setNextCursor(null);
    setLoadError(null);
    clearPrivilegedState();
  }, [canAdmin, clearPrivilegedState]);

  const issue = async (): Promise<void> => {
    if (
      !canAdminRef.current ||
      operation.active ||
      revealed ||
      issueUncertain
    ) {
      return;
    }
    const normalized = label.trim();
    const validation = conversionIngestSecretLabelError(normalized);
    if (validation) {
      setOperationError(validation);
      return;
    }
    setOperationError(null);
    const request = operation.run(() =>
      conversionsApi.issueIngestSecret(normalized),
    );
    if (!request) return;
    let response: Awaited<ReturnType<typeof conversionsApi.issueIngestSecret>>;
    try {
      response = await request;
    } catch {
      if (!mounted.current) return;
      setIssueUncertain(true);
      setOperationError(
        "The issue outcome is unknown. Reconcile the key register before issuing again.",
      );
      await reload();
      return;
    }
    if (!mounted.current || !canAdminRef.current) return;
    if (response.error) {
      if (isRemotePermissionError(response.error)) {
        setItems(null);
        clearPrivilegedState();
        setLoadError(
          safeTrackFailure(
            response.error,
            "Admin access is required to manage signed-ingest keys.",
          ),
        );
        return;
      }
      if (isUncertainMutationFailure(response.error)) {
        setIssueUncertain(true);
        setOperationError(
          "The issue outcome is unknown. Reconcile the key register before issuing again.",
        );
        await reload();
        return;
      }
      setOperationError(
        safeTrackFailure(
          response.error,
          "The conversion signing key couldn't be issued.",
        ),
      );
      return;
    }
    const verified = parseIssuedConversionIngestSecret(response.data);
    if (!verified) {
      setIssueUncertain(true);
      setOperationError(
        "The key may have been issued, but its one-time secret response could not be verified. Reconcile the key register before issuing again.",
      );
      await reload();
      return;
    }
    protectSecret();
    setRevealed(verified);
    setStored(false);
    const nextItems = [
      issuedConversionIngestSecretSummary(verified),
      ...(itemsRef.current ?? []).filter(
        (item) => item.keyId !== verified.keyId,
      ),
    ];
    itemsRef.current = nextItems;
    setItems(nextItems);
    clearDraft();
    toast.success(
      verified.identityProjectionStatus === "ready"
        ? "Conversion server signing key issued and email HMAC ready"
        : verified.identityProjectionStatus === "failed"
          ? "Conversion server signing key issued; email HMAC projection failed"
          : "Conversion server signing key issued; email HMAC projection is pending",
    );
    void reload();
  };

  const revoke = async (): Promise<void> => {
    if (!revoking || !canAdminRef.current || operation.active) return;
    const target = revoking;
    setRevokeError(null);
    const request = operation.run(() =>
      conversionsApi.revokeIngestSecret(target.keyId),
    );
    if (!request) return;
    let response: Awaited<ReturnType<typeof conversionsApi.revokeIngestSecret>>;
    try {
      response = await request;
    } catch {
      if (!mounted.current) return;
      const message =
        "The revocation request could not be confirmed. Refresh the register before retrying.";
      setRevokeError(message);
      toast.error(message);
      await reload();
      return;
    }
    if (!mounted.current || !canAdminRef.current) return;
    if (response.error) {
      const message = safeTrackFailure(
        response.error,
        "The conversion signing key couldn't be revoked.",
      );
      setRevokeError(message);
      toast.error(message);
      return;
    }
    if (response.data.revoked !== true) {
      const message =
        "The server did not confirm revocation. Refresh the register before retrying.";
      setRevokeError(message);
      toast.error(message);
      await reload();
      return;
    }
    const revokedAt = new Date().toISOString();
    const nextItems = (itemsRef.current ?? []).map((item) =>
      item.keyId === target.keyId ? { ...item, revokedAt } : item,
    );
    itemsRef.current = nextItems;
    setItems(nextItems);
    setRevoking(null);
    toast.success("Conversion server signing key revoked");
    void reload();
  };

  const clearReveal = (): void => {
    releaseSecret();
    setRevealed(null);
    setStored(false);
    setAbandonOpen(false);
  };
  const activeCount =
    items?.filter((item) => item.revokedAt === null).length ?? 0;

  return (
    <>
      <section style={{ marginTop: 24 }}>
        <SectionHeader
          title="Trusted server conversion ingest"
          description="Private HMAC credentials for authoritative server feeds. These are separate from the publishable browser tracking keys above."
          actions={
            canAdmin ? (
              <button
                type="button"
                className="btn btn-sm"
                aria-disabled={loading || operation.active || undefined}
                onClick={() => {
                  if (!loading && !operation.active) void reload();
                }}
              >
                {loading ? "Refreshing…" : "Refresh server keys"}
              </button>
            ) : undefined
          }
        />

        <div className="notice" role="note">
          <strong>Rotate overlap-first.</strong> Issue a new key, wait until it
          says email HMAC ready, move the sender, verify accepted traffic, then
          revoke the old key. Keep both live during handover. Revoke a leaked
          key immediately, even if it is the last live key.
        </div>

        <details style={{ marginTop: 12 }}>
          <summary>Exact signed-ingest v2 contract</summary>
          <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
            <span className="muted">
              POST <code>/api/public/conversions/ingest</code>. Sign the exact
              raw JSON bytes; every length below is a UTF-8 byte length.
            </span>
            {CONVERSION_INGEST_V2_CONTRACT.map((line) => (
              <code
                key={line}
                className="mono"
                style={{ overflowWrap: "anywhere" }}
              >
                {line}
              </code>
            ))}
            <span className="muted">
              Derive the pseudonym inside the sender and send only{" "}
              <code>identity.email_hmac_sha256</code>. Never send{" "}
              <code>identity.email</code>, plaintext email, or unsalted{" "}
              <code>email_sha256</code> to this API.
            </span>
          </div>
        </details>

        {!canAdmin ? (
          <div className="notice" role="note" style={{ marginTop: 12 }}>
            Signed-ingest key management is admin-only. Ask a workspace owner or
            admin to issue, rotate, list, or revoke these private credentials.
          </div>
        ) : (
          <>
            <form
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "end",
                gap: 8,
                marginTop: 16,
              }}
              onSubmit={(event) => {
                event.preventDefault();
                void issue();
              }}
            >
              <label style={{ display: "grid", gap: 4, flex: "1 1 260px" }}>
                <span>New server key label</span>
                <input
                  className="input"
                  value={label}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={
                    operation.active || revealed !== null || issueUncertain
                  }
                  placeholder="Production checkout service"
                  onChange={(event) => {
                    setLabel(event.target.value);
                    setOperationError(null);
                  }}
                />
              </label>
              <button
                type="submit"
                className="btn btn-primary"
                aria-disabled={
                  operation.active ||
                  revealed !== null ||
                  issueUncertain ||
                  !label.trim() ||
                  undefined
                }
              >
                {operation.active ? "Working…" : "Issue server key"}
              </button>
            </form>
            {operationError ? (
              <p className="field-error" role="alert">
                {operationError}
              </p>
            ) : null}
            {issueUncertain ? (
              <div
                className="notice warning"
                role="alert"
                style={{ marginTop: 8 }}
              >
                <strong>The issue outcome is unknown.</strong>
                <p className="muted" style={{ marginTop: 4 }}>
                  Refresh and inspect the key register. If a new key ID
                  appeared, revoke it, then issue a replacement. Its one-time
                  secret cannot be recovered. Never retry this issuance
                  blindly.
                </p>
                <div
                  style={{ display: "flex", flexWrap: "wrap", gap: 8 }}
                >
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-disabled={loading || operation.active || undefined}
                    onClick={() => {
                      if (!loading && !operation.active) void reload();
                    }}
                  >
                    {loading ? "Refreshing…" : "Refresh key register"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setIssueUncertain(false);
                      setOperationError(null);
                    }}
                  >
                    Register reconciled — allow replacement
                  </button>
                </div>
              </div>
            ) : null}
          </>
        )}

        {loadError ? (
          <div className="notice danger" role="alert" style={{ marginTop: 12 }}>
            {loadError}
          </div>
        ) : null}
        {canAdmin && loading && items === null ? (
          <p className="muted" role="status">
            Loading signed-ingest key register…
          </p>
        ) : null}
        {canAdmin && !loading && !loadError && items?.length === 0 ? (
          <div className="empty-state">
            <strong>No server signing keys</strong>
            <p className="muted">
              Issue the first private HMAC credential. This is not a browser
              tracking key.
            </p>
          </div>
        ) : null}

        {canAdmin && items && items.length > 0 ? (
          <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
            {items.map((item) => {
              const active = item.revokedAt === null;
              return (
                <div
                  key={item.keyId}
                  className="card"
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    padding: 12,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <strong>{item.label}</strong>{" "}
                    <span className={"badge" + (active ? " success" : "")}>
                      {active ? "active" : "revoked"}
                    </span>
                    <span
                      className={
                        "badge" +
                        (item.identityProjectionStatus === "ready"
                          ? " success"
                          : item.identityProjectionStatus === "failed"
                            ? " danger"
                            : " warning")
                      }
                    >
                      {projectionLabel(item)}
                    </span>
                    <div
                      className="mono muted"
                      style={{ overflowWrap: "anywhere", marginTop: 4 }}
                    >
                      {item.keyId}
                    </div>
                    <div className="muted" style={{ marginTop: 4 }}>
                      Issued {safeAbsoluteTime(item.createdAt)}
                      {item.revokedAt
                        ? " · revoked " + safeAbsoluteTime(item.revokedAt)
                        : ""}
                    </div>
                    <div className="muted" style={{ marginTop: 4 }}>
                      {projectionGuidance(item)} Projection updated{" "}
                      {safeAbsoluteTime(item.identityProjectionUpdatedAt)}.
                    </div>
                  </div>
                  {active ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost danger"
                      aria-disabled={
                        operation.active || revealed !== null || undefined
                      }
                      onClick={() => {
                        if (!operation.active && !revealed) {
                          setRevokeError(null);
                          setRevoking(item);
                        }
                      }}
                    >
                      Revoke
                    </button>
                  ) : null}
                </div>
              );
            })}
            {nextCursor ? (
              <button
                type="button"
                className="btn btn-sm"
                aria-disabled={loadingMore || operation.active || undefined}
                onClick={() => {
                  if (!loadingMore && !operation.active) {
                    void reload(nextCursor);
                  }
                }}
              >
                {loadingMore ? "Loading more…" : "Load more server keys"}
              </button>
            ) : null}
          </div>
        ) : null}
      </section>

      <Modal
        open={revealed !== null}
        onClose={() => setAbandonOpen(true)}
        title="Server signing key issued"
        description="Store this credential now. This is its only display."
        closeOnBackdrop={false}
        closeOnEscape={false}
      >
        <div className="notice" role="alert">
          Put the secret and key ID in an approved secret manager. Clipboard
          history, extensions, and screen capture may retain copied credentials.
        </div>
        {revealed ? (
          <div
            className={
              "notice" +
              (revealed.identityProjectionStatus === "failed" ? " danger" : "")
            }
            role={
              revealed.identityProjectionStatus === "failed"
                ? "alert"
                : "status"
            }
            style={{ marginTop: 12 }}
          >
            <strong>{projectionLabel(revealed)}.</strong>{" "}
            {projectionGuidance(revealed)} Updated{" "}
            {safeAbsoluteTime(revealed.identityProjectionUpdatedAt)}.
          </div>
        ) : null}
        <dl style={{ display: "grid", gap: 12, marginTop: 12 }}>
          <div>
            <dt className="muted">Key ID (not secret)</dt>
            <dd className="mono" style={{ overflowWrap: "anywhere" }}>
              {revealed?.keyId}
            </dd>
          </div>
          <div>
            <dt className="muted">Signing secret</dt>
            <dd className="copy-row">
              <code
                className="mono copy-text"
                style={{ overflowWrap: "anywhere" }}
                data-testid="conversion-ingest-secret-plaintext"
              >
                {revealed?.secret}
              </code>
              {revealed ? <SecretCopyButton value={revealed.secret} /> : null}
            </dd>
          </div>
        </dl>
        <label style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <input
            type="checkbox"
            checked={stored}
            onChange={(event) => setStored(event.target.checked)}
          />
          <span>
            I stored this exact secret and its key ID in an approved secret
            manager.
          </span>
        </label>
        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={() => setAbandonOpen(true)}
          >
            Abandon secret
          </button>
          <button
            type="button"
            className="btn btn-primary"
            aria-disabled={!stored || undefined}
            onClick={() => {
              if (stored) clearReveal();
            }}
          >
            Acknowledge and clear
          </button>
        </ModalFooter>
      </Modal>

      <ConfirmModal
        open={abandonOpen}
        title="Abandon the one-time signing secret?"
        description="The secret will be cleared from this window and cannot be displayed again. The key remains active until explicitly revoked."
        confirmLabel="Abandon secret"
        typeToConfirm="ABANDON"
        danger
        onClose={() => setAbandonOpen(false)}
        onConfirm={clearReveal}
      />
      <ConfirmModal
        open={revoking !== null}
        title="Revoke this server signing key?"
        description={
          (nextCursor === null && activeCount <= 1
            ? "This is the last live signed-ingest key. "
            : "") +
          "Every conversion signed with this key will be rejected immediately. During planned rotation, move and verify traffic on a new live key first."
        }
        confirmLabel="Revoke server key"
        danger
        busy={operation.active}
        onClose={() => {
          if (!operation.active) {
            setRevoking(null);
            setRevokeError(null);
          }
        }}
        onConfirm={revoke}
      >
        {revokeError ? (
          <p className="field-error" role="alert">
            {revokeError}
          </p>
        ) : null}
      </ConfirmModal>
    </>
  );
}
