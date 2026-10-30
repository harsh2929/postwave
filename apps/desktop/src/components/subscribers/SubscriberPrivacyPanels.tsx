import {
  Fragment,
  type ReactElement,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";

import {
  type IdentifierTransformPreviewResult,
  type SubscriberDetail,
  type SubscriberTrackingPrefs,
  identifierTransformsApi,
} from "../../lib/api-client";
import { fmtDate, fmtDateTime } from "../../lib/format-date";
import { FieldError, FormField } from "../FormField";
import { InlineHelp } from "../InlineHelp";

/**
 * Read-only per-purpose consent vector. The timestamps are maintained from
 * the consent-event ledger, so an absent value must remain visibly ungranted.
 */
export function PurposeConsentSection({
  detail,
}: {
  detail: SubscriberDetail;
}): ReactElement {
  const purposes: Array<{
    label: string;
    at: string | null | undefined;
  }> = [
    { label: "Email marketing", at: detail.consent_email_marketing_at },
    { label: "SMS marketing", at: detail.consent_sms_marketing_at },
    { label: "Profiling", at: detail.consent_profiling_at },
    { label: "Targeted ads", at: detail.consent_targeted_ads_at },
    { label: "AI processing", at: detail.consent_ai_processing_at },
  ];

  return (
    <div style={{ marginTop: 12 }}>
      <div
        className="label"
        style={{ display: "flex", alignItems: "center", gap: 4 }}
      >
        Consent
        <InlineHelp text="Per-purpose consent vector. Each timestamp is when the last 'granted' consent event was recorded for that purpose, maintained from the consent-event ledger. Read-only here." />
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto",
          gap: "4px 10px",
          alignItems: "center",
          fontSize: 12,
        }}
      >
        {purposes.map((purpose) => {
          const timestamp = (purpose.at ?? "").toString().trim();
          return (
            <Fragment key={purpose.label}>
              <span className="muted">{purpose.label}</span>
              {timestamp ? (
                <span
                  className="badge success tabular"
                  style={{ fontSize: 10 }}
                  title={`Granted ${fmtDateTime(timestamp)}`}
                >
                  {fmtDate(timestamp)}
                </span>
              ) : (
                <span className="badge" style={{ fontSize: 10 }}>
                  Not granted
                </span>
              )}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Per-subscriber open/click tracking eligibility. The switches represent
 * explicit subscriber evidence, while the status row always reports the
 * effective send-time decision (including Global Privacy Control).
 */
export function TrackingPrefsPanel({
  prefs,
  saving,
  err,
  canMutate,
  onToggle,
  onRetry,
}: {
  prefs: SubscriberTrackingPrefs | null;
  saving: string | null;
  err: string | null;
  canMutate: boolean;
  onToggle: (dimension: "open" | "click", nextOptOut: boolean) => Promise<void>;
  onRetry?: () => void;
}): ReactElement {
  const openToggleId = useId();
  const clickToggleId = useId();

  if (!prefs) {
    return (
      <div style={{ marginTop: 12 }}>
        <div className="label">Tracking preferences</div>
        <div className="muted" style={{ fontSize: 12 }}>
          Loading…
        </div>
      </div>
    );
  }

  const openOptedOut = Boolean(prefs.open_opt_out_at);
  const clickOptedOut = Boolean(prefs.click_opt_out_at);
  const effectiveOpenOptedOut = prefs.effective_open_opt_out;
  const effectiveClickOptedOut = prefs.effective_click_opt_out;
  const gpc = prefs.gpc;
  const effectiveHelp = (
    channel: "Open" | "Click",
    explicitOptOut: boolean,
    effectiveOptOut: boolean,
  ): string => {
    if (gpc && explicitOptOut) {
      return `${channel} tracking is suppressed by both explicit subscriber evidence and Global Privacy Control. GPC must be cleared at its source before effective tracking can resume.`;
    }
    if (gpc && effectiveOptOut) {
      return `${channel} tracking is suppressed by Global Privacy Control. This switch can record an additional explicit opt-out but cannot override GPC.`;
    }
    if (explicitOptOut || effectiveOptOut) {
      return `${channel} tracking is suppressed for this subscriber.`;
    }
    return `${channel} tracking is currently active for this subscriber.`;
  };

  return (
    <div style={{ marginTop: 12 }}>
      <div
        className="label"
        style={{ display: "flex", alignItems: "center", gap: 4 }}
      >
        Tracking preferences
        <InlineHelp text="Per-subscriber eligibility for open pixel + click rewriting. Send-time injection respects these flags on every commercial send." />
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          marginBottom: 6,
        }}
      >
        <FormField
          label="Open tracking opt-out"
          htmlFor={openToggleId}
          help={effectiveHelp("Open", openOptedOut, effectiveOpenOptedOut)}
          error={null}
        >
          <ToggleRow
            id={openToggleId}
            checked={openOptedOut}
            disabled={!canMutate || saving !== null || (gpc && openOptedOut)}
            onChange={(value) => void onToggle("open", value)}
            label={
              saving === "open"
                ? "Saving…"
                : openOptedOut
                  ? "Opted out"
                  : "Granted"
            }
          />
        </FormField>

        <FormField
          label={
            <span
              style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              Click tracking opt-out
              {gpc ? (
                <InlineHelp text="This subscriber's browser sent Sec-GPC: 1. Some toggles are locked respecting their signal." />
              ) : null}
            </span>
          }
          help={effectiveHelp("Click", clickOptedOut, effectiveClickOptedOut)}
          htmlFor={clickToggleId}
        >
          <ToggleRow
            id={clickToggleId}
            checked={clickOptedOut}
            disabled={!canMutate || saving !== null || (gpc && clickOptedOut)}
            onChange={(value) => void onToggle("click", value)}
            label={
              saving === "click"
                ? "Saving…"
                : clickOptedOut
                  ? "Opted out"
                  : "Granted"
            }
          />
        </FormField>
      </div>

      <div
        aria-label="Effective tracking decision"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
          marginBottom: 7,
          fontSize: 11,
        }}
      >
        <span className="muted">Effective send-time decision</span>
        <span
          className={`badge ${effectiveOpenOptedOut ? "warning" : "success"}`}
          style={{ fontSize: 10 }}
        >
          Opens {effectiveOpenOptedOut ? "suppressed" : "active"}
        </span>
        <span
          className={`badge ${effectiveClickOptedOut ? "warning" : "success"}`}
          style={{ fontSize: 10 }}
        >
          Clicks {effectiveClickOptedOut ? "suppressed" : "active"}
        </span>
        {gpc ? (
          <span className="badge success" style={{ fontSize: 10 }}>
            GPC opt-out honored
          </span>
        ) : null}
      </div>

      <div
        className="muted"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 11,
          flexWrap: "wrap",
        }}
      >
        <span>
          Policy{" "}
          <code style={{ fontSize: 10 }}>{prefs.policy_version || "v1"}</code>
        </span>
        <span>·</span>
        <span>
          Source{" "}
          <code style={{ fontSize: 10 }}>{prefs.source || "default"}</code>
        </span>
        {gpc ? (
          <>
            <span>·</span>
            <span className="badge" style={{ fontSize: 10 }}>
              GPC
            </span>
          </>
        ) : null}
        <span>·</span>
        <span>Updated {fmtDateTime(prefs.updated_at)}</span>
      </div>

      {err ? (
        <div style={{ marginTop: 4, display: "grid", gap: 6 }}>
          <FieldError>{err}</FieldError>
          {onRetry ? (
            <button
              type="button"
              className="btn btn-sm"
              style={{ justifySelf: "start" }}
              onClick={onRetry}
              disabled={saving !== null}
            >
              Reload tracking preferences
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Read-only preview of the workspace's current ingest transforms for this
 * subscriber's email and phone identifiers. Unsupported/unauthorized routes
 * fail quiet so older deployments do not leave a broken control behind.
 */
export function IdentifierNormalizationDisclosure({
  email,
  fields,
}: {
  email: string | undefined;
  fields: Record<string, unknown>;
}): ReactElement | null {
  const [resolvedPreview, setResolvedPreview] = useState<{
    inputKey: string;
    value: IdentifierTransformPreviewResult;
  } | null>(null);
  const [hiddenInputKey, setHiddenInputKey] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const trimmedEmail = (email ?? "").trim();
  const fieldsKey = useMemo(() => JSON.stringify(fields), [fields]);
  const inputKey = useMemo(
    () => JSON.stringify([trimmedEmail, fieldsKey]),
    [fieldsKey, trimmedEmail],
  );

  useEffect(() => {
    let cancelled = false;
    if (!trimmedEmail && Object.keys(fields).length === 0) {
      setResolvedPreview(null);
      setHiddenInputKey(null);
      return;
    }

    void (async () => {
      const result = await identifierTransformsApi.preview({
        email: trimmedEmail,
        custom_fields: fields,
      });
      if (cancelled) return;
      if (result.error) {
        setResolvedPreview(null);
        setHiddenInputKey(inputKey);
        return;
      }
      setHiddenInputKey(null);
      setResolvedPreview({ inputKey, value: result.data });
    })();

    return () => {
      cancelled = true;
    };
    // inputKey captures the trimmed email and field contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputKey]);

  // Key resolved state to the exact subscriber inputs. Effects run after
  // render, so clearing state only inside the effect would briefly expose the
  // previous subscriber's normalized identifiers when the slideover changes.
  const preview =
    resolvedPreview?.inputKey === inputKey ? resolvedPreview.value : null;
  if (hiddenInputKey === inputKey || !preview) return null;

  const config = preview.config;
  const anyTransformOn =
    config.email_normalize_dots ||
    config.email_normalize_plus ||
    config.phone_e164_format;
  const changedPhones = preview.phones.filter((phone) => phone.changed);
  const anythingChanged = preview.email_changed || changedPhones.length > 0;

  if (!anyTransformOn) return null;

  const beforeAfter = (input: string, output: string): ReactElement => (
    <span
      style={{ fontFamily: "var(--pw-font-mono)", fontSize: 11 }}
      title={`${input} → ${output}`}
    >
      <span className="muted" style={{ textDecoration: "line-through" }}>
        {input}
      </span>
      <span aria-hidden style={{ margin: "0 6px" }}>
        →
      </span>
      <span style={{ color: "var(--pw-success)" }}>{output}</span>
    </span>
  );

  return (
    <section>
      <button
        type="button"
        className="link-btn"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={`${open ? "Hide" : "Show"} identifier normalization details; explains workspace ingest rules`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12,
        }}
      >
        <span aria-hidden>{open ? "▾" : "▸"}</span>
        Identifier normalization
        {anythingChanged ? (
          <span className="badge accent" style={{ fontSize: 10 }}>
            normalized
          </span>
        ) : (
          <span className="muted" style={{ fontSize: 11 }}>
            (no change)
          </span>
        )}
      </button>
      {open ? (
        <div
          style={{
            marginTop: 8,
            display: "grid",
            gap: 6,
            padding: "8px 10px",
            background: "var(--pw-bg-elev-2)",
            borderRadius: 4,
          }}
        >
          <div className="muted" style={{ fontSize: 11 }}>
            Ingest rules:{" "}
            {[
              config.email_normalize_dots && "strip email dots",
              config.email_normalize_plus && "strip +alias",
              config.phone_e164_format &&
                `phone → E.164${
                  config.phone_default_region
                    ? ` (${config.phone_default_region})`
                    : ""
                }`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
          {preview.email_changed ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(48px, auto) 1fr",
                gap: 8,
                alignItems: "baseline",
              }}
            >
              <span className="muted" style={{ fontSize: 11 }}>
                Email
              </span>
              {beforeAfter(preview.email_input, preview.email_output)}
            </div>
          ) : null}
          {changedPhones.map((phone) => (
            <div
              key={phone.key}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(48px, auto) 1fr",
                gap: 8,
                alignItems: "baseline",
              }}
            >
              <span className="muted" style={{ fontSize: 11 }}>
                {phone.key}
              </span>
              {beforeAfter(phone.input, phone.output)}
            </div>
          ))}
          {!anythingChanged ? (
            <div className="muted" style={{ fontSize: 11 }}>
              This subscriber&apos;s stored identifiers already match the
              normalized form — no transform was applied at ingest.
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ToggleRow({
  id,
  checked,
  disabled,
  onChange,
  label,
}: {
  id: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label: string;
}): ReactElement {
  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
        fontSize: 12,
      }}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}
