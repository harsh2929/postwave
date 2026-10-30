/**
 * AuditPortalSessionModal — embeddable-customer-portal feature
 * (audit-2026 API P1).
 *
 * Modal that mints a short-lived JWT for the embeddable customer
 * audit portal and presents the resulting URL with one-click copy,
 * a QR code for in-person handoff, and a live "expires in N minutes"
 * countdown. WorkOS Admin Portal pattern.
 *
 * The mint requires admin scope server-side; the open-button on the
 * Audit page is also gated on auditScopes.isAdmin so we never even
 * surface the affordance to non-admins.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";

import QRCode from "qrcode";
import {
  PostwaveAuditPortal,
  portalSessionOrigin,
} from "@postwave/audit-portal-react";

import { useShownOnceSecretLifecycle } from "../../hooks/useShownOnceSecretLifecycle";
import {
  lifecycleOperationError,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import { api } from "../../lib/api-client";
import {
  clipboardSuccessDetail,
  writeClipboardText,
} from "../../lib/clipboard";
import { ConfirmModal } from "../ConfirmModal";
import { Modal } from "../Modal";
import { toast } from "../Toast";

/** The trusted audit-portal origin for a first-party embed is the origin of
 *  the API-issued portal_url. Extracted safely so a malformed URL disables the
 *  embed (portalSessionOrigin then validates the url against this pin). */
function trustedPortalOrigin(portalUrl: string): string {
  try {
    return new URL(portalUrl).origin;
  } catch {
    return "";
  }
}

interface Props {
  open: boolean;
  onClose: () => void;
}

interface PortalSession {
  sessionId: string;
  portalUrl: string;
  expiresAt: string;
}

function formatRemaining(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

export function AuditPortalSessionModal({
  open,
  onClose,
}: Props): ReactElement {
  const [session, setSession] = useState<PortalSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ttlMinutes, setTtlMinutes] = useState(30);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [confirmReplaceOpen, setConfirmReplaceOpen] = useState(false);
  const [, setNowTick] = useState(0);
  const tickRef = useRef<number | null>(null);
  const liveSessionRef = useRef<PortalSession | null>(null);
  const operationOptions = useMemo(
    () => ({
      ownerId: "audit-portal-session",
      label: "Audit portal session operation",
      detail: "Wait for the audit portal session request to finish.",
    }),
    [],
  );
  const operation = useSingleFlightOperation(operationOptions);
  const runOperation = operation.run;
  const sessionActive =
    session !== null && new Date(session.expiresAt).getTime() > Date.now();
  const sessionLifecycle = useShownOnceSecretLifecycle(
    "audit-portal-session",
    "Audit portal session",
    open && sessionActive,
  );
  const activateSession = sessionLifecycle.activate;
  const resolveSession = sessionLifecycle.resolve;

  useEffect(() => {
    liveSessionRef.current = session;
  }, [session]);

  // Parent route/permission changes can unmount the modal without invoking its
  // guarded close callback. Revoke the ephemeral server session best-effort so
  // a hidden customer URL is not left active until TTL expiry.
  useEffect(() => {
    return () => {
      const current = liveSessionRef.current;
      liveSessionRef.current = null;
      if (current && new Date(current.expiresAt).getTime() > Date.now()) {
        const request = runOperation(() =>
          api.revokeAuditPortalSession(current.sessionId),
        );
        // The retained operation owns the promise and process guard through
        // settlement after React has unmounted. Cleanup is best-effort, so a
        // transport rejection is contained rather than becoming unhandled.
        void request?.catch(() => undefined);
      }
    };
  }, [runOperation]);

  // Drives the countdown re-render. We avoid `setInterval` directly
  // in the render path so the modal can be closed mid-tick without
  // leaking the timer.
  useEffect(() => {
    if (!session) return;
    tickRef.current = window.setInterval(() => {
      setNowTick((n) => n + 1);
    }, 1000);
    return () => {
      if (tickRef.current != null) window.clearInterval(tickRef.current);
      tickRef.current = null;
    };
  }, [session]);

  // Lazy-render the QR once the portal URL is known. We use the canvas
  // form so the modal can offer a download-PNG affordance later
  // without re-rendering.
  useEffect(() => {
    if (!session) {
      setQrDataUrl(null);
      return;
    }
    void QRCode.toDataURL(session.portalUrl, {
      errorCorrectionLevel: "M",
      margin: 1,
      scale: 4,
    })
      .then((url) => setQrDataUrl(url))
      .catch(() => setQrDataUrl(null));
  }, [session]);

  const mint = useCallback(async () => {
    const request = runOperation(async () => {
      const response = await api.createAuditPortalSession({
        ttl_seconds: ttlMinutes * 60,
      });
      if (!response.error && response.data) {
        const nextSession = {
          sessionId: response.data.session_id,
          portalUrl: response.data.portal_url,
          expiresAt: response.data.expires_at,
        };
        // Cleanup must see the returned session even if the route unmounts
        // before React can commit the state update/effect below.
        liveSessionRef.current = nextSession;
        activateSession();
        setSession(nextSession);
      }
      return response;
    });
    if (!request) return;
    setLoading(true);
    setError(null);
    let res: Awaited<ReturnType<typeof api.createAuditPortalSession>>;
    try {
      res = await request;
    } catch (caught) {
      setError(
        lifecycleOperationError(caught, "Failed to create portal session."),
      );
      return;
    } finally {
      setLoading(false);
    }
    if (res.error || !res.data) {
      setError(res.error?.message ?? "Failed to create portal session.");
      return;
    }
  }, [activateSession, runOperation, ttlMinutes]);

  // Auto-mint on open so the operator sees a usable URL immediately.
  useEffect(() => {
    if (!open) return;
    if (session) return;
    void mint();
  }, [open, session, mint]);

  // Reset state when the modal closes so a fresh open always mints a
  // new token (otherwise the operator could be misled by a stale URL).
  useEffect(() => {
    if (open) return;
    setSession(null);
    setError(null);
    setQrDataUrl(null);
    setConfirmCloseOpen(false);
  }, [open]);

  const copyLink = useCallback(async () => {
    if (!session) return;
    const result = await writeClipboardText(session.portalUrl, {
      contentClass: "secret",
      label: "Audit portal session URL",
      clearIfUnchangedAfterMs: 60_000,
    });
    if (result.ok) {
      toast.success({
        message: "Portal URL copied",
        detail: [
          "Paste into your customer-facing UI to share the audit log.",
          clipboardSuccessDetail(result),
        ]
          .filter(Boolean)
          .join(" "),
      });
    } else {
      toast.error({
        message: "Copy failed",
        detail: result.message,
      });
    }
  }, [session]);

  const revoke = useCallback(async () => {
    if (!session) return;
    const target = session;
    const request = runOperation(() =>
      api.revokeAuditPortalSession(target.sessionId),
    );
    if (!request) return;
    setLoading(true);
    let res: Awaited<ReturnType<typeof api.revokeAuditPortalSession>>;
    try {
      res = await request;
    } catch (caught) {
      toast.error({
        message: "Revoke failed",
        detail: lifecycleOperationError(caught, "Unable to revoke session."),
      });
      return;
    } finally {
      setLoading(false);
    }
    if (res.error) {
      toast.error({
        message: "Revoke failed",
        detail: res.error?.message ?? "Unable to revoke session.",
      });
      return;
    }
    toast.success({
      message: "Portal session revoked",
      detail: "The link will no longer load.",
    });
    setConfirmCloseOpen(false);
    setConfirmReplaceOpen(false);
    resolveSession();
    liveSessionRef.current = null;
    setSession(null);
    onClose();
  }, [onClose, resolveSession, runOperation, session]);

  const mintNew = useCallback(async () => {
    if (!session || loading) return;
    const target = session;
    const request = runOperation(() =>
      api.revokeAuditPortalSession(target.sessionId),
    );
    if (!request) return;
    setLoading(true);
    let res: Awaited<ReturnType<typeof api.revokeAuditPortalSession>>;
    try {
      res = await request;
    } catch (caught) {
      toast.error({
        message: "Could not replace session",
        detail: lifecycleOperationError(
          caught,
          "The existing link was kept active. Revoke it before minting another.",
        ),
      });
      return;
    } finally {
      setLoading(false);
    }
    if (res.error) {
      toast.error({
        message: "Could not replace session",
        detail:
          "The existing link was kept active. Revoke it before minting another.",
      });
      return;
    }
    setConfirmReplaceOpen(false);
    resolveSession();
    liveSessionRef.current = null;
    setSession(null);
    setQrDataUrl(null);
  }, [loading, resolveSession, runOperation, session]);

  const guardedClose = useCallback(() => {
    if (loading || operation.active) {
      toast.info({
        id: "audit-portal-session-busy",
        message: "Session operation still running",
        detail: "Wait for it to finish before closing this dialog.",
      });
      return;
    }
    if (sessionActive) {
      setConfirmCloseOpen(true);
      return;
    }
    onClose();
  }, [loading, onClose, operation.active, sessionActive]);

  return (
    <>
      <Modal
        open={open}
        onClose={guardedClose}
        closeOnBackdrop={!loading && !operation.active}
        closeOnEscape={!loading && !operation.active}
        title="Create portal session"
        description="Mint a short-lived link your customer can use to view the audit log. Read-only and revocable."
        size="lg"
      >
        <div style={{ display: "grid", gap: 16, padding: "8px 0" }}>
          <AuditPortalSessionControls
            ttlMinutes={ttlMinutes}
            sessionActive={session !== null}
            busy={loading || operation.active}
            onTtlChange={setTtlMinutes}
            onMint={() => void mint()}
            onReplace={() => setConfirmReplaceOpen(true)}
          />

          {error ? (
            <div
              style={{
                padding: 8,
                background:
                  "color-mix(in srgb, var(--pw-danger) 14%, var(--pw-bg-elev))",
                color: "var(--pw-danger)",
                borderRadius: 6,
                fontSize: 13,
              }}
            >
              {error}
            </div>
          ) : null}

          {session ? (
            <AuditPortalSessionResult
              session={session}
              qrDataUrl={qrDataUrl}
              busy={loading || operation.active}
              onCopy={() => void copyLink()}
              onRevoke={() => void revoke()}
            />
          ) : null}
        </div>
      </Modal>
      <AuditPortalSessionConfirms
        closeOpen={confirmCloseOpen}
        replaceOpen={confirmReplaceOpen}
        busy={loading || operation.active}
        onRevoke={() => void revoke()}
        onReplace={() => void mintNew()}
        onKeepSession={() => setConfirmCloseOpen(false)}
        onKeepCurrent={() => setConfirmReplaceOpen(false)}
      />
    </>
  );
}

function AuditPortalSessionControls({
  ttlMinutes,
  sessionActive,
  busy,
  onTtlChange,
  onMint,
  onReplace,
}: {
  ttlMinutes: number;
  sessionActive: boolean;
  busy: boolean;
  onTtlChange: (value: number) => void;
  onMint: () => void;
  onReplace: () => void;
}): ReactElement {
  return (
    <div className="row" style={{ gap: 8, alignItems: "center" }}>
      <label
        htmlFor="audit-portal-ttl"
        className="muted"
        style={{ fontSize: 12 }}
      >
        Session lifetime:
      </label>
      <select
        id="audit-portal-ttl"
        value={ttlMinutes}
        disabled={sessionActive || busy}
        onChange={(event) => onTtlChange(Number(event.target.value))}
      >
        <option value={5}>5 minutes</option>
        <option value={15}>15 minutes</option>
        <option value={30}>30 minutes (default)</option>
        <option value={60}>1 hour</option>
        <option value={240}>4 hours</option>
      </select>
      <button
        type="button"
        className={sessionActive ? "btn btn-secondary" : "btn"}
        onClick={sessionActive ? onReplace : onMint}
        disabled={busy}
      >
        {busy
          ? sessionActive
            ? "Replacing…"
            : "Minting…"
          : sessionActive
            ? "Mint new"
            : "Mint session"}
      </button>
    </div>
  );
}

function AuditPortalSessionResult({
  session,
  qrDataUrl,
  busy,
  onCopy,
  onRevoke,
}: {
  session: PortalSession;
  qrDataUrl: string | null;
  busy: boolean;
  onCopy: () => void;
  onRevoke: () => void;
}): ReactElement {
  return (
    <div
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 8,
        padding: 12,
        display: "grid",
        gap: 12,
      }}
      data-testid="audit-portal-session-result"
    >
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <input
          type="text"
          readOnly
          value={session.portalUrl}
          onFocus={(event) => event.currentTarget.select()}
          style={{
            flex: 1,
            fontFamily: "monospace",
            padding: "6px 8px",
            fontSize: 13,
          }}
          data-testid="audit-portal-session-url"
        />
        <button type="button" className="btn" onClick={onCopy}>
          Copy link
        </button>
      </div>
      <div className="row" style={{ gap: 16, alignItems: "flex-start" }}>
        {qrDataUrl ? (
          <img
            src={qrDataUrl}
            alt="QR code for portal URL"
            width={140}
            height={140}
            style={{ borderRadius: 4 }}
          />
        ) : null}
        <div style={{ fontSize: 12, color: "var(--pw-fg-muted)" }}>
          <div>
            <strong>Session id:</strong> {session.sessionId}
          </div>
          <div>
            <strong>Expires in:</strong>{" "}
            <span data-testid="audit-portal-expires-in">
              {formatRemaining(session.expiresAt)}
            </span>
          </div>
          <div style={{ marginTop: 8 }}>
            The link is read-only and is bound to your tenant. It is embedded
            live below via <code>@postwave/audit-portal-react</code> — the same
            sandboxed <code>&lt;PostwaveAuditPortal /&gt;</code> component a
            customer-facing app uses.
          </div>
        </div>
      </div>
      <PostwaveAuditPortal
        sessionUrl={session.portalUrl}
        portalOrigin={portalSessionOrigin(
          session.portalUrl,
          trustedPortalOrigin(session.portalUrl),
        )}
        parentOrigin={
          typeof window !== "undefined" ? window.location.origin : ""
        }
        theme="dark"
        height={520}
        title="Embedded audit portal preview"
      />
      <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
        <button
          type="button"
          className="btn btn-danger"
          onClick={onRevoke}
          disabled={busy}
        >
          {busy ? "Revoking…" : "Revoke session"}
        </button>
      </div>
    </div>
  );
}

function AuditPortalSessionConfirms({
  closeOpen,
  replaceOpen,
  busy,
  onRevoke,
  onReplace,
  onKeepSession,
  onKeepCurrent,
}: {
  closeOpen: boolean;
  replaceOpen: boolean;
  busy: boolean;
  onRevoke: () => void;
  onReplace: () => void;
  onKeepSession: () => void;
  onKeepCurrent: () => void;
}): ReactElement {
  return (
    <>
      <ConfirmModal
        open={closeOpen}
        title="Revoke session and close?"
        description="This audit-portal link is still active. Revoke it before closing so an untracked session is not left behind."
        confirmLabel="Revoke and close"
        cancelLabel="Keep session open"
        danger
        busy={busy}
        onConfirm={onRevoke}
        onClose={() => (busy ? undefined : onKeepSession())}
      />
      <ConfirmModal
        open={replaceOpen}
        title="Revoke and replace this session?"
        description="The current customer link stops working immediately. A fresh one-time link will be minted only after revocation succeeds."
        confirmLabel="Revoke and mint new"
        cancelLabel="Keep current session"
        danger
        busy={busy}
        onConfirm={onReplace}
        onClose={() => (busy ? undefined : onKeepCurrent())}
      />
    </>
  );
}
