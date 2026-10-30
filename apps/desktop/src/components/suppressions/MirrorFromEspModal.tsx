/**
 * MirrorFromEspModal — admin "Sync from provider" action (GAP-LS-026).
 *
 * Restored after the mirror backend shipped for real: hits
 * POST /api/v1/suppressions/mirror/{provider} via
 * `suppressionsApi.mirror` for a provider with a wired mirror client.
 *
 * The wrapper folds the server's 503 `not_configured` reply into the
 * DATA channel (`{not_configured: true, not_configured_reason}`) —
 * an unconfigured provider is a REAL, expected state for most
 * workspaces, so we render it as an informational notice with the
 * server's reason, never as an error toast.
 */

import { type ReactElement, useState } from "react";

import {
  type SuppressionMirrorProvider,
  suppressionsApi,
} from "../../lib/api-client";
import { providerSupportsMirror } from "../deliverability/provider-config-helpers";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";
import { summarizeMirrorResult } from "./mirror-summary";

// Only providers with real mirror clients belong in this user-facing picker.
const PROVIDERS: Array<{
  value: SuppressionMirrorProvider;
  label: string;
  hint: string;
}> = [
  {
    value: "mailchimp",
    label: "Mailchimp",
    hint: "Pulls unsubscribed + cleaned members from the connected audience.",
  },
  {
    value: "sendgrid",
    label: "SendGrid",
    hint: "Pulls bounces, blocks, spam reports, and unsubscribes.",
  },
];

interface Props {
  open: boolean;
  onClose: () => void;
  /** Refetch the list after a mirror run that imported rows. */
  onAfterMirror: () => void;
}

export function MirrorFromEspModal({
  open,
  onClose,
  onAfterMirror,
}: Props): ReactElement {
  // Default to a provider that actually has a wired mirror client.
  const [provider, setProvider] =
    useState<SuppressionMirrorProvider>("mailchimp");
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  /** Informational not-configured state — NOT an error. */
  const [notConfigured, setNotConfigured] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    setBusy(true);
    setSummary(null);
    setNotConfigured(null);
    const res = await suppressionsApi.mirror(provider);
    setBusy(false);
    if (res.error) {
      // Genuine failures only — the 503 not-configured reply arrives
      // on the data channel, not here.
      toast.error({ message: "Mirror failed", detail: res.error.message });
      return;
    }
    const r = res.data;
    if (r.not_configured) {
      // For ESPs whose mirror reads config.api_key (Mailchimp / SendGrid),
      // point at the exact field that sets it. Other providers source the
      // credential elsewhere (server env), so keep the generic pointer.
      const fallback = providerSupportsMirror(provider)
        ? `The ${provider} mirror has no API key. Open Deliverability → Provider config, pick ${provider}, and set the "ESP API key (mirror credential)" field to enable it.`
        : `The ${provider} mirror is not configured on this server. Add the provider credentials in deliverability settings to enable it.`;
      setNotConfigured(r.not_configured_reason || fallback);
      return;
    }
    setSummary(summarizeMirrorResult(r));
    toast.success({
      message: `Mirror complete — ${r.imported.toLocaleString()} imported`,
      detail:
        r.errors > 0
          ? `${r.errors.toLocaleString()} row${r.errors === 1 ? "" : "s"} failed.`
          : undefined,
    });
    if (r.imported > 0) onAfterMirror();
  };

  const selected = PROVIDERS.find((p) => p.value === provider);

  return (
    <Modal
      open={open}
      onClose={() => (busy ? undefined : onClose())}
      title="Mirror suppressions from provider"
      description="Re-import bounces, complaints, and unsubscribes from your sending ESP. Idempotent — running it twice won't double-import."
    >
      <div className="field">
        <label className="field-label" htmlFor="mirror-provider">
          Source provider
        </label>
        <select
          id="mirror-provider"
          className="input"
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value as SuppressionMirrorProvider);
            // Provider-specific output is stale once the picker moves.
            setSummary(null);
            setNotConfigured(null);
          }}
          disabled={busy}
        >
          {PROVIDERS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        {selected ? (
          <div className="field-help" style={{ marginTop: 6 }}>
            {selected.hint}
          </div>
        ) : null}
      </div>

      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        The mirror walks the provider&apos;s recent suppression pages and
        upserts each row into the deliverability store. Existing rows are
        deduped on (tenant, source, source_event_id).
      </div>

      {notConfigured ? (
        <div className="notice" style={{ marginTop: 12 }}>
          <span>
            <strong>
              {selected?.label ?? provider} isn&apos;t configured.
            </strong>{" "}
            {notConfigured}
          </span>
        </div>
      ) : null}
      {summary ? (
        <div className="notice" style={{ marginTop: 12 }}>
          <span>{summary}</span>
        </div>
      ) : null}

      <ModalFooter>
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          {summary ? "Close" : "Cancel"}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void run()}
          disabled={busy}
        >
          {busy ? "Running…" : `Sync from ${selected?.label ?? provider}`}
        </button>
      </ModalFooter>
    </Modal>
  );
}
