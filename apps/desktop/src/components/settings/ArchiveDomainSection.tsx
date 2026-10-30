/**
 * ArchiveDomainSection — gap feature `archive-archive-domain-ui` (P2).
 *
 * Surfaces the per-tenant archive_domain + CNAME verification + SSL
 * provisioning panel inside Settings. The backend hooks were wired
 * by the parallel gap feature `archive-custom-domain-honor` — the
 * verification table exists, the resolver middleware is mounted, but
 * the only way to actually use them was raw curl. This component
 * closes that loop:
 *
 *   1. Read the configured `archive_domain` + verification row via
 *      `getArchiveCustomDomain` (zero-value envelope when neither is
 *      set so the empty form renders without a 404 special-case).
 *   2. Let the operator type a domain into the input + save it via
 *      `putArchiveTenantSettings({archive_domain})`. The PUT validates
 *      shape + reserved-suffix server-side (`archive.ValidateArchiveDomain`).
 *   3. Render the CNAME instruction — copy-paste hostname + target —
 *      and a "Verify" button that triggers a re-check.
 *   4. Poll every 10s while status is "issuing" (SSL provisioning is
 *      typically <90s) so the operator sees the cert flip to "issued"
 *      without manually refreshing. Polling stops once status ∈
 *      {issued, failed, never started}.
 *   5. Show the resolved public-archive URL (vanity host when verified,
 *      hosted fallback otherwise) so the operator can sanity-check
 *      where their archive lives at a glance.
 *
 * Parity points (2026 SOTA):
 *   - beehiiv "Custom domain" panel  → CNAME + verify-button + SSL
 *   - Substack "Custom domain" pane  → identical lifecycle
 *   - Ghost "Settings → Domain"      → manual CNAME step
 *   - Buttondown "Custom domain"     → free, automatic Let's Encrypt
 *
 * Visibility: admin-only (matches the backend `ScopeAdmin` gate on
 * the verify / delete routes). Viewers see an explanatory line +
 * read-only display of the current state.
 */

import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  lifecycleOperationError,
  useExistingSettingLifecycle,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import {
  api,
  type ArchiveCustomDomainStatus,
  type ArchiveTenantSettings,
} from "../../lib/api-client";
import { useCanAdmin } from "../../lib/store";
import { writeClipboardText } from "../../lib/clipboard";
import { toast } from "../Toast";
import { ConfirmModal } from "../ConfirmModal";
import { InlineHelp } from "../InlineHelp";
import { SettingsSectionHeader } from "./SettingsNav";
import {
  EMPTY_ARCHIVE_CUSTOM_DOMAIN,
  parseArchiveCustomDomainStatus,
} from "./archive-domain-contract";

const ARCHIVE_DOMAIN_OPERATION = {
  ownerId: "archive-domain",
  label: "Archive-domain request",
} as const;

/* ---------- helpers ------------------------------------------------- */

/** Tone-mapped to the existing `.badge` modifiers. */
function statusBadgeClass(s: ArchiveCustomDomainStatus["status"]): string {
  switch (s) {
    case "verified":
      return "badge success";
    case "failed":
      return "badge warning";
    default:
      return "badge";
  }
}

function sslBadgeClass(s: ArchiveCustomDomainStatus["ssl_status"]): string {
  switch (s) {
    case "issued":
      return "badge success";
    case "failed":
      return "badge warning";
    case "issuing":
      return "badge accent";
    default:
      return "badge";
  }
}

function fmtTimeAgo(iso?: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86_400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86_400)}d ago`;
}

/** Compute the public-archive URL the operator's audience will see.
 *  Mirrors the resolver order in `Archive.tsx`: verified vanity host
 *  wins, else the hosted fallback. */
function resolvedPublicUrl(
  st: ArchiveCustomDomainStatus,
  settings: ArchiveTenantSettings | null,
): string {
  if (st.domain && st.status === "verified") {
    return `https://${st.domain}`;
  }
  const slug = (settings?.tenant_archive_slug ?? "").trim() || "your-tenant";
  return `https://archive.moosewave.com/${encodeURIComponent(slug)}`;
}

function useArchiveDomainPolling(
  server: ArchiveCustomDomainStatus | null,
  refresh: () => Promise<void>,
): boolean {
  const [polling, setPolling] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!server) return;
    if (server.ssl_status !== "issuing") {
      if (pollTimer.current) {
        clearTimeout(pollTimer.current);
        pollTimer.current = null;
      }
      setPolling(false);
      return;
    }
    setPolling(true);
    pollTimer.current = setTimeout(() => void refresh(), 10_000);
    return () => {
      if (pollTimer.current) {
        clearTimeout(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [refresh, server]);

  useEffect(
    () => () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    },
    [],
  );
  return polling;
}

/* ---------- main component ----------------------------------------- */

export function ArchiveDomainSection(): ReactElement {
  const canAdmin = useCanAdmin();
  const [server, setServer] = useState<ArchiveCustomDomainStatus | null>(null);
  const [domainBaseline, setDomainBaseline] = useState("");
  const [settings, setSettings] = useState<ArchiveTenantSettings | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [savingDomain, setSavingDomain] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [pendingRemove, setPendingRemove] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef(true);
  const operation = useSingleFlightOperation(ARCHIVE_DOMAIN_OPERATION);

  // Latest server value, readable from inside `refresh` without re-creating
  // the callback. The `server` state captured at the callback's creation
  // render is permanently null inside a `useCallback([], …)` closure, which
  // broke the clean-draft sync during SSL polling.
  const serverRef = useRef<ArchiveCustomDomainStatus | null>(null);
  const domainBaselineRef = useRef("");

  const refresh = useCallback(async () => {
    let statusRes;
    let settingsRes;
    try {
      [statusRes, settingsRes] = await Promise.all([
        api.getArchiveCustomDomain(),
        api.getArchiveTenantSettings(),
      ]);
    } catch (refreshError) {
      if (activeRef.current) {
        setError(
          lifecycleOperationError(
            refreshError,
            "Archive domain settings couldn't be loaded.",
          ),
        );
      }
      return;
    }
    if (!activeRef.current) return;
    if (statusRes.error) {
      // 404 / empty workspace returns an envelope, not an error; a
      // real error here is worth surfacing inline so the operator
      // doesn't see a permanently-empty form.
      setError(statusRes.error.message);
    } else {
      const parsedStatus = parseArchiveCustomDomainStatus(statusRes.data);
      if (!parsedStatus) {
        setError("Archive domain response was malformed.");
        serverRef.current = EMPTY_ARCHIVE_CUSTOM_DOMAIN;
        domainBaselineRef.current = "";
        setServer(EMPTY_ARCHIVE_CUSTOM_DOMAIN);
        setDomainBaseline("");
        setDraft((prev) =>
          prev === (serverRef.current?.domain ?? "") ? "" : prev,
        );
        return;
      }
      // Sync the input draft to whatever the server has, unless the
      // user is mid-edit. We detect that by comparing the previous
      // server value against the current draft — if they match, the
      // input wasn't dirty and we can safely overwrite. Read the
      // previous value through the ref so polling refreshes compare
      // against the live server row, not the creation-render snapshot.
      const prevServerDomain = serverRef.current?.domain ?? "";
      serverRef.current = parsedStatus;
      domainBaselineRef.current = parsedStatus.domain;
      setServer(parsedStatus);
      setDomainBaseline(parsedStatus.domain);
      setDraft((prev) =>
        prev === prevServerDomain ? parsedStatus.domain : prev,
      );
    }
    if (settingsRes.data) {
      setSettings(settingsRes.data);
    }
  }, []);

  useEffect(() => {
    activeRef.current = true;
    void refresh();
    return () => {
      activeRef.current = false;
    };
  }, [refresh]);

  const polling = useArchiveDomainPolling(server, refresh);

  const onSaveDomain = async (): Promise<boolean> => {
    if (!canAdmin) return false;
    const pending = operation.promiseRef.current;
    if (pending) {
      return (await pending) === true;
    }
    const next = draft.trim();
    setSavingDomain(true);
    setError(null);
    const request = operation.run(async (): Promise<boolean> => {
      try {
        const res = await api.putArchiveTenantSettings({
          archive_domain: next,
        });
        if (!activeRef.current) return false;
        if (res.error || !res.data) {
          const message =
            res.error?.message ?? "The server returned no archive settings.";
          setError(message);
          toast.error(`Couldn't save domain: ${message}`);
          return false;
        }
        setSettings(res.data);
        domainBaselineRef.current = next;
        setDomainBaseline(next);
        toast.success(next ? "Domain saved" : "Domain cleared");
        await refresh();
        return true;
      } catch (saveError) {
        if (!activeRef.current) return false;
        const message = lifecycleOperationError(
          saveError,
          "The archive domain couldn't be saved.",
        );
        setError(message);
        toast.error(`Couldn't save domain: ${message}`);
        return false;
      } finally {
        if (activeRef.current) setSavingDomain(false);
      }
    });
    return request ? await request : false;
  };

  const onVerify = async (): Promise<void> => {
    if (!canAdmin) return;
    if (!server?.domain) {
      toast.error("Save a domain first, then click Verify.");
      return;
    }
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    setVerifying(true);
    setError(null);
    const request = operation.run(async (): Promise<void> => {
      try {
        const res = await api.verifyArchiveCustomDomain();
        if (!activeRef.current) return;
        if (res.error) {
          setError(res.error.message);
          toast.error(res.error.message);
          await refresh();
          return;
        }
        const parsedStatus = parseArchiveCustomDomainStatus(res.data);
        if (!parsedStatus) {
          setError("Archive domain verification response was malformed.");
          toast.error("Verification returned an invalid response.");
          return;
        }
        serverRef.current = parsedStatus;
        setServer(parsedStatus);
        if (parsedStatus.status === "verified") {
          toast.success("Domain verified! SSL is being provisioned.");
        } else {
          toast.error({
            message: "Verification failed",
            detail:
              parsedStatus.last_error ||
              "Check the CNAME record and try again.",
          });
        }
      } catch (verifyError) {
        if (!activeRef.current) return;
        const message = lifecycleOperationError(
          verifyError,
          "Archive domain verification couldn't be completed.",
        );
        setError(message);
        toast.error(message);
      } finally {
        if (activeRef.current) setVerifying(false);
      }
    });
    if (request) await request;
  };

  const onRemove = async (): Promise<void> => {
    if (!canAdmin) return;
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    setRemoveBusy(true);
    setError(null);
    const request = operation.run(async (): Promise<void> => {
      try {
        const res = await api.deleteArchiveCustomDomain();
        if (!activeRef.current) return;
        if (res.error) {
          setError(res.error.message);
          toast.error(res.error.message);
          return;
        }
        toast.success("Verification cleared");
        await refresh();
      } catch (removeError) {
        if (!activeRef.current) return;
        const message = lifecycleOperationError(
          removeError,
          "Archive domain verification couldn't be removed.",
        );
        setError(message);
        toast.error(message);
      } finally {
        if (activeRef.current) setRemoveBusy(false);
      }
    });
    if (request) await request;
  };

  const copy = async (text: string, label: string): Promise<void> => {
    const result = await writeClipboardText(text, {
      contentClass: "public",
      label,
    });
    if (result.ok) toast.success(`${label} copied`);
    else toast.error(result.message);
  };

  const dirty = server !== null && draft.trim() !== domainBaseline.trim();
  const discardDomain = useCallback((): void => {
    setDraft(domainBaselineRef.current);
    setError(null);
  }, []);
  useExistingSettingLifecycle({
    ownerId: "archive-domain",
    label: "Archive custom domain",
    dirty,
    operationRef: operation.promiseRef,
    save: onSaveDomain,
    discard: discardDomain,
    detail: "The archive custom-domain change has not been saved.",
    operationDetail:
      "Wait for the archive-domain request to finish before leaving Moosewave.",
  });

  if (!server) {
    return <ArchiveDomainShell error={error} onRetry={() => void refresh()} />;
  }

  return (
    <ArchiveDomainShell server={server}>
      <ArchiveDomainEditor
        server={server}
        settings={settings}
        draft={draft}
        canAdmin={canAdmin}
        operationActive={operation.active}
        dirty={dirty}
        savingDomain={savingDomain}
        verifying={verifying}
        polling={polling}
        pendingRemove={pendingRemove}
        removeBusy={removeBusy}
        error={error}
        onDraftChange={setDraft}
        onSaveDomain={onSaveDomain}
        onVerify={onVerify}
        onCopy={copy}
        onRequestRemove={() => setPendingRemove(true)}
        onCancelRemove={() => {
          if (!operation.active) setPendingRemove(false);
        }}
        onConfirmRemove={async () => {
          await onRemove();
          setPendingRemove(false);
        }}
      />
    </ArchiveDomainShell>
  );
}

interface ArchiveDomainEditorProps {
  server: ArchiveCustomDomainStatus;
  settings: ArchiveTenantSettings | null;
  draft: string;
  canAdmin: boolean;
  operationActive: boolean;
  dirty: boolean;
  savingDomain: boolean;
  verifying: boolean;
  polling: boolean;
  pendingRemove: boolean;
  removeBusy: boolean;
  error: string | null;
  onDraftChange: (value: string) => void;
  onSaveDomain: () => Promise<boolean>;
  onVerify: () => Promise<void>;
  onCopy: (text: string, label: string) => Promise<void>;
  onRequestRemove: () => void;
  onCancelRemove: () => void;
  onConfirmRemove: () => Promise<void>;
}

function ArchiveDomainEditor({
  server,
  settings,
  draft,
  canAdmin,
  operationActive,
  dirty,
  savingDomain,
  verifying,
  polling,
  pendingRemove,
  removeBusy,
  error,
  onDraftChange,
  onSaveDomain,
  onVerify,
  onCopy,
  onRequestRemove,
  onCancelRemove,
  onConfirmRemove,
}: ArchiveDomainEditorProps): ReactElement {
  const actionAvailabilityId = useId();
  const hasDomain = server.domain.trim() !== "";
  const isVerified = server.status === "verified";
  const isPending = server.status === "pending";
  const isFailed = server.status === "failed";
  const actionAvailability = !canAdmin
    ? "Admin access is required to change or verify the archive domain."
    : operationActive
      ? "An archive-domain request is in progress. Other domain actions remain unavailable until it finishes."
      : !dirty
        ? "Change the custom domain to enable Save domain."
        : null;
  return (
    <>
      <div className="field" style={{ marginBottom: 12 }}>
        <label
          className="field-label"
          htmlFor="archive-domain-input"
          style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
        >
          Custom domain
          <InlineHelp text="Lowercase hostname, no path or scheme. Use a sub-domain (e.g. news.example.com) — apex domains require ALIAS / ANAME on supporting providers (Cloudflare, Netlify, Route 53)." />
        </label>
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <input
            id="archive-domain-input"
            className="input mono"
            value={draft}
            placeholder="news.example.com"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            disabled={!canAdmin || operationActive}
            maxLength={253}
            onChange={(event) =>
              onDraftChange(event.target.value.toLowerCase())
            }
            style={{ flex: 1, minWidth: 240 }}
          />
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void onSaveDomain()}
            disabled={!canAdmin || operationActive || !dirty}
            aria-describedby={
              !canAdmin || operationActive || !dirty
                ? actionAvailabilityId
                : undefined
            }
          >
            {savingDomain ? "Saving…" : "Save domain"}
          </button>
        </div>
        <div className="field-hint">
          Leave blank to use the hosted{" "}
          <span className="mono">
            archive.moosewave.com/
            {(settings?.tenant_archive_slug ?? "your-tenant") || "your-tenant"}
          </span>{" "}
          URL.
        </div>
        {actionAvailability ? (
          <div
            id={actionAvailabilityId}
            className="field-hint"
            role="status"
            aria-live="polite"
          >
            {actionAvailability}
          </div>
        ) : null}
      </div>

      {hasDomain ? (
        <>
          <ArchiveDnsInstructions server={server} onCopy={onCopy} />
          <div
            className="settings-row"
            style={{ alignItems: "flex-start", marginBottom: 8 }}
          >
            <div>
              <div
                className="row"
                style={{ gap: 8, alignItems: "center", marginBottom: 4 }}
              >
                <span style={{ fontSize: 13 }}>CNAME status</span>
                <span className={statusBadgeClass(server.status)}>
                  {server.status}
                </span>
                {isVerified && server.verified_at ? (
                  <span className="muted" style={{ fontSize: 11 }}>
                    Verified {fmtTimeAgo(server.verified_at)}
                  </span>
                ) : null}
              </div>
              {isFailed && server.last_error ? (
                <div
                  className="muted"
                  style={{
                    fontSize: 12,
                    color: "var(--pw-danger)",
                    maxWidth: 520,
                  }}
                >
                  {server.last_error}
                </div>
              ) : isPending ? (
                <div className="muted" style={{ fontSize: 12 }}>
                  Waiting for DNS propagation — click Verify after creating the
                  CNAME above.
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => void onVerify()}
              disabled={!canAdmin || operationActive}
              aria-describedby={
                !canAdmin || operationActive ? actionAvailabilityId : undefined
              }
            >
              {verifying ? "Checking…" : isVerified ? "Re-check" : "Verify"}
            </button>
          </div>

          <div
            className="settings-row"
            style={{ alignItems: "flex-start", marginBottom: 8 }}
          >
            <div>
              <div
                className="row"
                style={{ gap: 8, alignItems: "center", marginBottom: 4 }}
              >
                <span style={{ fontSize: 13 }}>SSL certificate</span>
                <span className={sslBadgeClass(server.ssl_status)}>
                  {server.ssl_status}
                </span>
                {polling ? (
                  <span className="muted" style={{ fontSize: 11 }}>
                    polling…
                  </span>
                ) : null}
              </div>
              <div className="muted" style={{ fontSize: 12, maxWidth: 520 }}>
                {server.ssl_status === "issued"
                  ? "Let's Encrypt cert is live — HTTPS works."
                  : server.ssl_status === "issuing"
                    ? "Provisioning certificate via Let's Encrypt — usually < 90 seconds after verification."
                    : server.ssl_status === "failed"
                      ? server.ssl_last_error ||
                        "Cert issuance failed. Check that your DNS still points to the CNAME target."
                      : isVerified
                        ? "Cert will be issued automatically once the edge picks up this domain."
                        : "SSL provisioning starts after CNAME verification succeeds."}
              </div>
            </div>
          </div>

          <div className="settings-row" style={{ alignItems: "flex-start" }}>
            <div>
              <div style={{ fontSize: 13 }}>Public archive URL</div>
              <div className="muted" style={{ fontSize: 12 }}>
                {isVerified
                  ? "Your audience visits this URL to read published issues."
                  : "Falls back to the hosted URL until verification completes."}
              </div>
            </div>
            <code
              className="mono"
              style={{
                padding: "4px 8px",
                borderRadius: 4,
                background: "var(--pw-bg-elev)",
                fontSize: 12,
              }}
            >
              {resolvedPublicUrl(server, settings)}
            </code>
          </div>

          {canAdmin ? (
            <div
              className="settings-row"
              style={{
                alignItems: "flex-start",
                marginTop: 12,
                paddingTop: 12,
                borderTop: "1px solid var(--pw-border-soft, var(--pw-border))",
              }}
            >
              <div>
                <div style={{ fontSize: 13 }}>Remove verification</div>
                <div className="muted" style={{ fontSize: 12, maxWidth: 480 }}>
                  Clears the verification row so the domain is no longer routed
                  to your tenant. The CNAME on your DNS is untouched — pull it
                  there if you also want the host to stop resolving.
                </div>
              </div>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={onRequestRemove}
                disabled={operationActive}
              >
                {removeBusy ? "Removing…" : "Remove verification"}
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          No custom domain configured yet. Add one above to start verification.
        </div>
      )}

      {error ? (
        <div
          className="field-error"
          role="alert"
          style={{ marginTop: 8, fontSize: 12 }}
        >
          {error}
        </div>
      ) : null}

      <ConfirmModal
        open={pendingRemove}
        title="Remove custom-domain verification?"
        description="Your archive at this vanity host will stop resolving immediately. You can re-verify any time the CNAME is still in place."
        confirmLabel="Remove verification"
        danger
        busy={removeBusy}
        onClose={onCancelRemove}
        onConfirm={onConfirmRemove}
      />
    </>
  );
}

function ArchiveDomainShell({
  children,
  error,
  onRetry,
  server = null,
}: {
  children?: ReactNode;
  error?: string | null;
  onRetry?: () => void;
  server?: ArchiveCustomDomainStatus | null;
}): ReactElement {
  return (
    <section className="settings-section" data-tour="archive-domain-section">
      <SettingsSectionHeader
        title="Archive domain"
        description={
          server
            ? "Publish your archive at a vanity host like news.example.com. Free TLS via Let's Encrypt."
            : "Loading custom-domain verification state…"
        }
        meta={
          server?.last_checked_at ? (
            <span className="muted" style={{ fontSize: 12 }}>
              Last checked {fmtTimeAgo(server.last_checked_at)}
            </span>
          ) : undefined
        }
      />
      {server ? (
        children
      ) : error ? (
        <div className="notice" role="alert">
          <span>Couldn&apos;t load archive-domain settings: {error}</span>
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : (
        <div className="muted" role="status" style={{ fontSize: 12 }}>
          Loading…
        </div>
      )}
    </section>
  );
}

function ArchiveDnsInstructions({
  server,
  onCopy,
}: {
  server: ArchiveCustomDomainStatus;
  onCopy: (text: string, label: string) => Promise<void>;
}): ReactElement {
  return (
    <div
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        padding: 12,
        marginBottom: 12,
        background: "var(--pw-bg-elev-2, var(--pw-bg-elev))",
      }}
    >
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          marginBottom: 6,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        DNS configuration
        <InlineHelp text="Create a CNAME record at your DNS provider (Cloudflare, Route 53, Namecheap, etc.) pointing your sub-domain at the target below. Most providers propagate within 60 seconds; some take up to 24 hours." />
      </div>
      <div
        className="muted"
        style={{ fontSize: 12, marginBottom: 8, lineHeight: 1.5 }}
      >
        At your DNS provider, create a <span className="mono">CNAME</span>{" "}
        record:
      </div>
      <DnsValueRow
        label="Host"
        value={server.domain}
        onCopy={() => onCopy(server.domain, "Host")}
        withSpacing
      />
      <DnsValueRow
        label="Value (CNAME target)"
        value={server.cname_target}
        onCopy={() => onCopy(server.cname_target, "Target")}
      />
      {server.verification_token ? (
        <details style={{ marginTop: 10, fontSize: 12 }}>
          <summary
            className="muted"
            style={{ cursor: "pointer", userSelect: "none" }}
          >
            Can&apos;t use CNAME? Use a TXT record instead
          </summary>
          <div style={{ marginTop: 6, lineHeight: 1.5 }}>
            Add a <span className="mono">TXT</span> record at{" "}
            <code className="mono">_postwave-verify.{server.domain}</code> with
            value{" "}
            <code className="mono">
              postwave-verify={server.verification_token}
            </code>
            .
          </div>
        </details>
      ) : null}
    </div>
  );
}

function DnsValueRow({
  label,
  value,
  onCopy,
  withSpacing = false,
}: {
  label: string;
  value: string;
  onCopy: () => Promise<void>;
  withSpacing?: boolean;
}): ReactElement {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        gap: 8,
        alignItems: "center",
        fontSize: 12,
        marginBottom: withSpacing ? 4 : undefined,
      }}
    >
      <span className="muted">{label}</span>
      <code
        className="mono"
        style={{
          padding: "2px 6px",
          borderRadius: 4,
          background: "var(--pw-bg-elev)",
        }}
      >
        {value}
      </code>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        onClick={() => void onCopy()}
      >
        Copy
      </button>
    </div>
  );
}
