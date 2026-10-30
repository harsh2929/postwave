/**
 * ChannelConsentsPanel — SUB-042 unified per-channel consent for one
 * profile, shown in the subscriber slideover Profile tab.
 *
 * A profile carries up to five per-channel consent rows (email / sms /
 * push / whatsapp / rcs) consolidated onto one identity, each with its own
 * status, consent timestamp/source, and a *shared* frequency cap. This
 * panel renders all five channels as a table — channel name, current
 * status (granted / revoked / pending / unknown), consent timestamp, and
 * the shared frequency-cap expiry — with a per-row toggle to grant/revoke
 * for write-scoped operators. The frequency cap is read-only here.
 *
 * SUB-133 — cross-channel frequency cap: a single cap spans email + SMS +
 * push (+ WhatsApp / RCS). When `frequency_cap_until` is set, the summary
 * line surfaces the expiry plus channel-specific indicators showing which
 * reachability channels the shared cap currently holds.
 *
 * Backed by:
 *   GET   /api/v1/subscribers/{id}/channel-consents
 *   PATCH /api/v1/subscribers/{id}/channel-consents/{channel}
 * (apps/api/internal/subscribers/*).
 *
 * Graceful degradation: a 404 (routes not deployed) hides the whole
 * section via onUnavailable, matching the slideover convention. Channels
 * with no recorded row are still shown — as "Unknown" with no timestamp —
 * so the operator sees all five reachability channels on one row.
 */

import {
  type Dispatch,
  type ReactElement,
  type SetStateAction,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  type ChannelConsent,
  type ChannelConsentChannel,
  type ChannelConsentStatus,
  api,
} from "../../lib/api-client";
import { redact } from "../../lib/auth";
import { fmtDateTime } from "../../lib/format-date";
import { InlineHelp } from "../InlineHelp";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";
import {
  CONSENT_EVIDENCE_CHANNELS,
  CONSENT_LEGAL_BASES,
  CONSENT_PROVENANCE_SOURCES,
  consentEvidenceError,
  consentEvidencePayload,
  emptyConsentEvidenceDraft,
  type ConsentEvidenceDraft,
} from "./consent-evidence";

interface Props {
  /** Subscriber UUID (the channel-consent endpoints key rows by it). */
  subscriberId: string;
  /** Exact strong parent-profile revision echoed in If-Match on PATCH. */
  subscriberVersion?: string;
  /** Whether the session may mutate (write:subscribers scope). */
  canMutate: boolean;
  /** Chains the fresh parent revision returned after a successful decision. */
  onSubscriberVersionChange?: (version: string) => void;
  /** Fired when the channel-consent routes are not deployed (404). */
  onUnavailable?: () => void;
}

/** All five reachability channels, in a stable display order. */
const CHANNELS: ChannelConsentChannel[] = [
  "email",
  "sms",
  "push",
  "whatsapp",
  "rcs",
];

const CHANNEL_LABEL: Record<ChannelConsentChannel, string> = {
  email: "Email",
  sms: "SMS",
  push: "Push",
  whatsapp: "WhatsApp",
  rcs: "RCS",
};

const STATUS_LABEL: Record<ChannelConsentStatus, string> = {
  opted_in: "Granted",
  opted_out: "Revoked",
  pending: "Pending",
  unknown: "Unknown",
};

/** Map a status to a .badge tone class (empty = neutral default). */
function statusBadgeClass(status: ChannelConsentStatus): string {
  switch (status) {
    case "opted_in":
      return "badge success";
    case "opted_out":
      return "badge danger";
    case "pending":
      return "badge warning";
    default:
      return "badge";
  }
}

export function ChannelConsentsPanel({
  subscriberId,
  subscriberVersion,
  canMutate,
  onSubscriberVersionChange,
  onUnavailable,
}: Props): ReactElement | null {
  // Keyed by channel so a sparse server response still renders all five
  // rows (channels with no row default to "unknown" / no timestamp).
  const [rows, setRows] = useState<Record<string, ChannelConsent>>({});
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<ChannelConsentChannel | null>(null);
  const [pendingChange, setPendingChange] = useState<{
    channel: ChannelConsentChannel;
    nextStatus: ChannelConsentStatus;
  } | null>(null);
  const [evidence, setEvidence] = useState(emptyConsentEvidenceDraft);
  const [activeVersion, setActiveVersion] = useState(
    subscriberVersion?.trim() ?? "",
  );
  const operationRef = useRef<ChannelConsentChannel | null>(null);
  const permissionReasonId = useId();
  const mutationReasonId = useId();
  const unsupportedReasonId = useId();

  useEffect(() => {
    setActiveVersion(subscriberVersion?.trim() ?? "");
  }, [subscriberId, subscriberVersion]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrMsg(null);
    setRows({});
    void (async () => {
      const res = await api.listSubscriberChannelConsents(subscriberId);
      if (cancelled) return;
      setLoading(false);
      if (res.error) {
        if (res.error.kind === "http" && res.error.status === 404) {
          onUnavailable?.();
          return;
        }
        setErrMsg(redact(res.error.message));
        return;
      }
      const map: Record<string, ChannelConsent> = {};
      for (const r of res.data.items ?? []) map[r.channel] = r;
      setRows(map);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriberId]);

  /**
   * Toggle a channel between granted (opted_in) and revoked (opted_out).
   * The PATCH re-stamps consent_timestamp server-side; we reconcile with
   * the returned row so the displayed timestamp matches the ledger.
   */
  const commitChannelChange = async (): Promise<void> => {
    if (!canMutate || operationRef.current || !pendingChange) return;
    const { channel, nextStatus } = pendingChange;
    if (channel !== "email") {
      toast.error(
        `${CHANNEL_LABEL[channel]} consent is read-only until its canonical delivery store is connected.`,
      );
      return;
    }
    if (!activeVersion || activeVersion === "*") {
      toast.error(
        "Reload this subscriber before changing consent so the latest revision can be verified.",
      );
      return;
    }
    const validation = consentEvidenceError(evidence, {
      requireEvidence: nextStatus === "opted_in",
      requireScope: true,
    });
    const payload = consentEvidencePayload(evidence);
    if (validation || !payload) {
      toast.error(validation ?? "Complete the consent evidence.");
      return;
    }
    operationRef.current = channel;
    setRowBusy(channel);
    try {
      const res = await api.setSubscriberChannelConsent(
        subscriberId,
        channel,
        {
          status: nextStatus,
          consent_source: payload.source,
          consent_timestamp: payload.occurred_at,
          evidence_channel: payload.channel,
          legal_basis: payload.legal_basis,
          evidence: payload.evidence,
          jurisdiction: payload.jurisdiction,
          reason: payload.reason,
          policy_version: payload.policy_version,
        },
        { version: activeVersion, maxAttempts: 1, requireOnline: true },
      );
      if (res.error) {
        const stale =
          res.error.status === 412 || res.error.code === "precondition_failed";
        if (stale) setActiveVersion("");
        toast.error({
          message: "Couldn't update consent",
          detail: stale
            ? "This subscriber changed elsewhere. Reload it before reviewing consent again."
            : redact(res.error.message),
        });
        return;
      }
      setRows((prev) => ({ ...prev, [channel]: res.data }));
      const freshVersion = res.data.subscriber_version?.trim() ?? "";
      setActiveVersion(freshVersion);
      onSubscriberVersionChange?.(freshVersion);
      setPendingChange(null);
      toast.success({
        message:
          nextStatus === "opted_in"
            ? `${CHANNEL_LABEL[channel]} consent granted`
            : `${CHANNEL_LABEL[channel]} consent revoked`,
      });
    } catch {
      toast.error("Couldn't update consent. Try again.");
    } finally {
      operationRef.current = null;
      setRowBusy(null);
    }
  };

  const requestChannelChange = (
    channel: ChannelConsentChannel,
    nextStatus: ChannelConsentStatus,
  ): void => {
    if (
      !canMutate ||
      operationRef.current ||
      channel !== "email" ||
      !activeVersion
    )
      return;
    setEvidence(emptyConsentEvidenceDraft());
    setPendingChange({ channel, nextStatus });
  };

  if (loading) {
    return (
      <section style={{ marginTop: 12 }}>
        <div className="label">Channel consent</div>
        <div className="skel" style={{ height: 64 }} />
      </section>
    );
  }

  // SUB-133 — cross-channel frequency cap. The cap is shared across
  // channels by design; surface the first non-null expiry for the summary
  // operator sees which reachability channels the single cap holds. (Once
  // per-channel caps land, this list naturally narrows to the capped subset
  // rather than every channel.)
  const cappedChannels = CHANNELS.filter((c) => rows[c]?.frequency_cap_until);
  const sharedCap =
    cappedChannels.map((c) => rows[c]?.frequency_cap_until).find(Boolean) ??
    null;

  return (
    <section style={{ marginTop: 12 }}>
      <div
        className="label"
        style={{ display: "flex", alignItems: "center", gap: 4 }}
      >
        Channel consent
        <InlineHelp text="Email decisions are enforced across the exact address, suppression gate, campaign eligibility, audit ledger, and delivery-engine sync. Other channels remain read-only until their canonical delivery stores are connected; the frequency cap is shared across all channels." />
      </div>

      <p className="muted" style={{ fontSize: 11, margin: "4px 0 8px" }}>
        Email grants and revocations take effect across sending immediately.
        SMS, push, WhatsApp, and RCS are visible but read-only until their
        canonical consent stores are connected.
      </p>

      {errMsg ? (
        <div className="muted" style={{ fontSize: 12 }}>
          Couldn&apos;t load channel consent: {errMsg}
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto minmax(7rem, auto) auto auto",
            gap: "6px 10px",
            alignItems: "center",
            fontSize: 12,
          }}
        >
          {/* Header row */}
          <span className="muted" style={{ fontSize: 11 }}>
            Channel
          </span>
          <span className="muted" style={{ fontSize: 11 }}>
            Status
          </span>
          <span className="muted" style={{ fontSize: 11 }}>
            Consent at
          </span>
          <span className="muted" style={{ fontSize: 11 }}>
            Source
          </span>
          <span className="visually-hidden">Action</span>

          {CHANNELS.map((channel) => {
            const row = rows[channel];
            const status: ChannelConsentStatus = row?.status ?? "unknown";
            const granted = status === "opted_in";
            return (
              <Row
                key={channel}
                channel={channel}
                status={status}
                consentAt={row?.consent_timestamp ?? null}
                source={row?.consent_source ?? null}
                canMutate={canMutate}
                supported={channel === "email"}
                versionReady={activeVersion.length > 0}
                busy={rowBusy === channel}
                operationActive={rowBusy !== null}
                permissionReasonId={permissionReasonId}
                mutationReasonId={mutationReasonId}
                unsupportedReasonId={unsupportedReasonId}
                onToggle={() =>
                  requestChannelChange(
                    channel,
                    granted ? "opted_out" : "opted_in",
                  )
                }
              />
            );
          })}
        </div>
      )}

      {!canMutate && !errMsg ? (
        <p
          id={permissionReasonId}
          className="muted"
          role="status"
          style={{ fontSize: 11, margin: "8px 0 0" }}
        >
          Viewer access can inspect channel consent but cannot grant or revoke
          it.
        </p>
      ) : null}
      {canMutate && !activeVersion && !errMsg ? (
        <p
          id={mutationReasonId}
          className="muted"
          role="status"
          style={{ fontSize: 11, margin: "8px 0 0" }}
        >
          Reload this subscriber to obtain the latest revision before changing
          email consent.
        </p>
      ) : null}
      {!errMsg ? (
        <p
          id={unsupportedReasonId}
          className="muted"
          style={{ fontSize: 11, margin: "8px 0 0" }}
        >
          SMS, Push, WhatsApp, and RCS consent are read-only until each
          channel&apos;s canonical delivery store is connected.
        </p>
      ) : null}

      {/* Shared frequency cap — read-only across all channels. */}
      <div
        className="muted"
        style={{
          marginTop: 8,
          fontSize: 11,
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
        }}
      >
        <span>Shared frequency cap</span>
        {sharedCap ? (
          <>
            <span
              className="badge warning"
              style={{ fontSize: 10 }}
              title="Sends across the affected channels are held until this passes."
            >
              Held until {fmtDateTime(sharedCap)}
            </span>
            {/* SUB-133 — which channels the single cross-channel cap holds. */}
            <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
              {cappedChannels.map((c) => (
                <span
                  key={c}
                  className="badge"
                  style={{ fontSize: 10 }}
                  title={`${CHANNEL_LABEL[c]} is held by the shared frequency cap.`}
                >
                  {CHANNEL_LABEL[c]}
                </span>
              ))}
            </span>
          </>
        ) : (
          <span>None active</span>
        )}
      </div>
      <ChannelConsentEvidenceModal
        pending={pendingChange}
        draft={evidence}
        busy={rowBusy !== null}
        onDraftChange={setEvidence}
        onClose={() => setPendingChange(null)}
        onConfirm={() => void commitChannelChange()}
      />
    </section>
  );
}

/** One channel row in the consent grid. Split out to keep the toggle
 *  handler and per-row busy state readable. */
function Row({
  channel,
  status,
  consentAt,
  source,
  canMutate,
  supported,
  versionReady,
  busy,
  operationActive,
  permissionReasonId,
  mutationReasonId,
  unsupportedReasonId,
  onToggle,
}: {
  channel: ChannelConsentChannel;
  status: ChannelConsentStatus;
  consentAt: string | null;
  source: string | null;
  canMutate: boolean;
  supported: boolean;
  versionReady: boolean;
  busy: boolean;
  operationActive: boolean;
  permissionReasonId: string;
  mutationReasonId: string;
  unsupportedReasonId: string;
  onToggle: () => void;
}): ReactElement {
  const granted = status === "opted_in";
  const describedBy = [
    !canMutate ? permissionReasonId : null,
    !supported ? unsupportedReasonId : null,
    canMutate && supported && !versionReady ? mutationReasonId : null,
  ]
    .filter((value): value is string => value !== null)
    .join(" ");
  return (
    <>
      <span>{CHANNEL_LABEL[channel]}</span>
      <span className={statusBadgeClass(status)} style={{ fontSize: 10 }}>
        {STATUS_LABEL[status]}
      </span>
      <span className="tabular muted" style={{ fontSize: 11 }}>
        {consentAt ? fmtDateTime(consentAt) : "Not recorded"}
      </span>
      <span className="muted" style={{ fontSize: 11 }}>
        {source?.trim() || "Not recorded"}
      </span>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          if (canMutate && supported && versionReady && !operationActive)
            onToggle();
        }}
        disabled={!canMutate || !supported || !versionReady || operationActive}
        aria-describedby={describedBy || undefined}
        aria-label={
          supported
            ? `${granted ? "Revoke" : "Grant"} ${CHANNEL_LABEL[channel]} consent`
            : `${CHANNEL_LABEL[channel]} consent is read-only`
        }
      >
        {busy
          ? "Saving…"
          : !supported
            ? "Read-only"
            : granted
              ? "Revoke"
              : "Grant"}
      </button>
    </>
  );
}

function ChannelConsentEvidenceModal({
  pending,
  draft,
  busy,
  onDraftChange,
  onClose,
  onConfirm,
}: {
  pending: {
    channel: ChannelConsentChannel;
    nextStatus: ChannelConsentStatus;
  } | null;
  draft: ConsentEvidenceDraft;
  busy: boolean;
  onDraftChange: Dispatch<SetStateAction<ConsentEvidenceDraft>>;
  onClose: () => void;
  onConfirm: () => void;
}): ReactElement {
  const granting = pending?.nextStatus === "opted_in";
  const validation = consentEvidenceError(draft, {
    requireEvidence: granting,
    requireScope: true,
  });
  const update = <K extends keyof ConsentEvidenceDraft>(
    key: K,
    value: ConsentEvidenceDraft[K],
  ): void => onDraftChange((current) => ({ ...current, [key]: value }));
  const prefix = "channel-consent-evidence";
  return (
    <Modal
      open={pending != null}
      onClose={() => (busy ? undefined : onClose())}
      title={`${granting ? "Grant" : "Revoke"} ${pending ? CHANNEL_LABEL[pending.channel] : "channel"} consent`}
      description="This mutation appends an immutable consent event. Moosewave will not infer permission from the admin action itself."
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: 10,
        }}
      >
        <ChannelEvidenceSelect
          id={`${prefix}-source`}
          label="Evidence source"
          value={draft.source}
          options={CONSENT_PROVENANCE_SOURCES}
          disabled={busy}
          onChange={(value) => update("source", value)}
        />
        <ChannelEvidenceSelect
          id={`${prefix}-channel`}
          label="Capture channel"
          value={draft.channel}
          options={CONSENT_EVIDENCE_CHANNELS}
          disabled={busy}
          onChange={(value) => update("channel", value)}
        />
        <ChannelEvidenceSelect
          id={`${prefix}-basis`}
          label="Legal basis"
          value={draft.legalBasis}
          options={CONSENT_LEGAL_BASES}
          disabled={busy}
          onChange={(value) => update("legalBasis", value)}
        />
        <label className="field" htmlFor={`${prefix}-at`}>
          <span className="field-label">Decision captured at</span>
          <input
            id={`${prefix}-at`}
            type="datetime-local"
            className="input"
            value={draft.occurredAt}
            disabled={busy}
            onChange={(event) => update("occurredAt", event.target.value)}
          />
        </label>
        <label className="field" htmlFor={`${prefix}-jurisdiction`}>
          <span className="field-label">Jurisdiction</span>
          <input
            id={`${prefix}-jurisdiction`}
            className="input"
            value={draft.jurisdiction}
            placeholder="US-CA, GB, EU"
            maxLength={32}
            disabled={busy}
            onChange={(event) => update("jurisdiction", event.target.value)}
          />
        </label>
        <label className="field" htmlFor={`${prefix}-policy`}>
          <span className="field-label">Policy version</span>
          <input
            id={`${prefix}-policy`}
            className="input"
            value={draft.policyVersion}
            placeholder="privacy-2026-07"
            maxLength={100}
            disabled={busy}
            onChange={(event) => update("policyVersion", event.target.value)}
          />
        </label>
      </div>
      <label className="field" htmlFor={`${prefix}-evidence`}>
        <span className="field-label">
          Durable evidence reference{granting ? "" : " (optional)"}
        </span>
        <textarea
          id={`${prefix}-evidence`}
          className="input"
          rows={2}
          value={draft.evidence}
          maxLength={2048}
          disabled={busy}
          placeholder="Receipt id, signed-form id, or approved evidence URL"
          onChange={(event) => update("evidence", event.target.value)}
        />
      </label>
      <label className="field" htmlFor={`${prefix}-reason`}>
        <span className="field-label">Operator reason</span>
        <textarea
          id={`${prefix}-reason`}
          className="input"
          rows={2}
          value={draft.reason}
          maxLength={500}
          disabled={busy}
          onChange={(event) => update("reason", event.target.value)}
        />
      </label>
      <label style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <input
          type="checkbox"
          checked={draft.scopeAcknowledged}
          disabled={busy}
          onChange={(event) =>
            update("scopeAcknowledged", event.target.checked)
          }
        />
        <span style={{ fontSize: 12 }}>
          I reviewed this subscriber, channel, evidence, and resulting consent
          state.
        </span>
      </label>
      {validation ? (
        <div className="field-error" role="status">
          {validation}
        </div>
      ) : null}
      <ModalFooter>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || validation != null}
          onClick={onConfirm}
        >
          {busy ? "Saving…" : granting ? "Record grant" : "Record revocation"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

function ChannelEvidenceSelect({
  id,
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  disabled: boolean;
  onChange: (value: string) => void;
}): ReactElement {
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <select
        id={id}
        className="input"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Select…</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
