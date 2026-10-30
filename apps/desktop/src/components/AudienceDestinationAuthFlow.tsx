/**
 * AudienceDestinationAuthFlow — SUB-113 per-platform credential entry +
 * readiness probe.
 *
 * Each ad platform (Meta / Google Ads / TikTok / LinkedIn / Snap) needs
 * a different set of account ids plus a credential reference in the
 * destination config block.
 * This component renders the right fields for the selected provider,
 * lets the operator enter them, and runs the backend readiness probe
 * (POST /api/v1/audience-destinations/{provider}/readiness) which reports
 * the EXACT missing keys — so the UI guides setup instead of failing a
 * sync later.
 *
 * Config is owned by the parent (controlled): this component reads
 * `config` and emits `onChange`. Readiness state is local.
 *
 * Backend: apps/api/internal/audience_destinations/*_adapter.go.
 */

import { useEffect, useRef, useState, type ReactElement } from "react";

import { FormField } from "./FormField";
import { ExternalLink } from "./ExternalLink";
import {
  audienceDestinationsApi,
  type AudiencePlatform,
  type PlatformReadiness,
} from "../lib/api-client";

/** The config keys each provider's adapter requires, in display order.
 *  Mirrors the *Required maps in the Go adapters. Public config stores
 *  references to secrets; raw provider tokens are rejected by the API. */
interface FieldDef {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  control?: "text" | "select" | "checkbox";
  options?: Array<{ value: string; label: string }>;
}

const GOOGLE_ADS_DEFAULT_CONFIG: Record<string, unknown> = {
  customer_match_transport: "data_manager",
  customer_match_terms_accepted: false,
  ad_user_data_consent: "granted",
  ad_personalization_consent: "granted",
};

const PROVIDER_FIELDS: Record<AudiencePlatform, FieldDef[]> = {
  meta: [
    {
      key: "credential_ref",
      label: "Credential reference",
      placeholder: "vault://ads/meta",
    },
    { key: "audience_id", label: "Custom Audience ID", placeholder: "23847…" },
  ],
  google_ads: [
    {
      key: "credential_ref",
      label: "Credential reference",
      placeholder: "vault://ads/google",
    },
    { key: "customer_id", label: "Customer ID", placeholder: "123-456-7890" },
    { key: "user_list_id", label: "User list ID" },
    {
      key: "ad_user_data_consent",
      label: "Ad user data consent",
      control: "select",
      options: [
        { value: "granted", label: "Granted" },
        { value: "denied", label: "Denied" },
      ],
    },
    {
      key: "ad_personalization_consent",
      label: "Ad personalization consent",
      control: "select",
      options: [
        { value: "granted", label: "Granted" },
        { value: "denied", label: "Denied" },
      ],
    },
    {
      key: "customer_match_terms_accepted",
      label: "Customer Match terms",
      control: "checkbox",
    },
  ],
  tiktok: [
    {
      key: "credential_ref",
      label: "Credential reference",
      placeholder: "vault://ads/tiktok",
    },
    { key: "advertiser_id", label: "Advertiser ID" },
    { key: "audience_id", label: "Audience ID (updates)" },
    { key: "custom_audience_name", label: "Custom audience name (create)" },
  ],
  linkedin: [
    {
      key: "credential_ref",
      label: "Credential reference",
      placeholder: "vault://ads/linkedin",
    },
    { key: "account_id", label: "Ad account ID" },
    { key: "segment_id", label: "DMP segment ID" },
  ],
  snap: [
    {
      key: "credential_ref",
      label: "Credential reference",
      placeholder: "vault://ads/snap",
    },
    { key: "ad_account_id", label: "Ad account ID" },
    { key: "segment_id", label: "Segment ID" },
  ],
};

function cfgString(cfg: Record<string, unknown>, key: string): string {
  const v = cfg[key];
  return typeof v === "string" ? v : "";
}

function cfgBool(cfg: Record<string, unknown>, key: string): boolean {
  const v = cfg[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "string")
    return ["true", "yes", "1", "accepted"].includes(v.trim().toLowerCase());
  return false;
}

function shallowEqualConfig(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

export function audienceDestinationConfigWithProviderDefaults(
  provider: AudiencePlatform,
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (provider !== "google_ads") return { ...config };
  return { ...GOOGLE_ADS_DEFAULT_CONFIG, ...config };
}

export function AudienceDestinationAuthFlow({
  provider,
  config,
  onChange,
  runOperation,
}: {
  provider: AudiencePlatform;
  config: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /**
   * The destination modal owns both this child check and its save request.
   * Keeping the runner controlled avoids a second lifecycle owner for the
   * same aggregate destination draft.
   */
  runOperation?: <T>(operation: () => Promise<T>) => Promise<T> | null;
}): ReactElement {
  const mountedRef = useRef(true);
  const [readiness, setReadiness] = useState<PlatformReadiness | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkErr, setCheckErr] = useState<string | null>(null);

  const fields = PROVIDER_FIELDS[provider] ?? [];
  const effectiveConfig = audienceDestinationConfigWithProviderDefaults(
    provider,
    config,
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!shallowEqualConfig(config, effectiveConfig)) {
      onChange(effectiveConfig);
      setReadiness(null);
    }
  }, [config, effectiveConfig, onChange]);

  const setField = (key: string, value: string | boolean): void => {
    onChange({ ...effectiveConfig, [key]: value });
    // Editing invalidates a prior readiness result.
    setReadiness(null);
  };

  const check = async (): Promise<void> => {
    setChecking(true);
    setCheckErr(null);
    const request = (): ReturnType<typeof audienceDestinationsApi.readiness> =>
      audienceDestinationsApi.readiness(provider, effectiveConfig);
    const pending = runOperation ? runOperation(request) : request();
    if (!pending) {
      setChecking(false);
      return;
    }
    try {
      const res = await pending;
      if (!mountedRef.current) return;
      if (res.error) {
        setCheckErr(
          res.error.status === 503
            ? "This platform's adapter isn't configured on the server yet."
            : res.error.message,
        );
        setReadiness(null);
        return;
      }
      setReadiness(res.data ?? null);
    } catch (error) {
      if (!mountedRef.current) return;
      setCheckErr(
        error instanceof Error && error.message.trim()
          ? error.message
          : "The connection check couldn't be completed.",
      );
      setReadiness(null);
    } finally {
      if (mountedRef.current) setChecking(false);
    }
  };

  return (
    <div>
      <p className="muted" style={{ fontSize: 12, margin: "0 0 8px" }}>
        Connect your {provider} account by entering the provider ids and the
        stored credential reference. Moosewave stores tokens outside destination
        config and ships hashed emails only.
      </p>

      {fields.map((f) => (
        <FormField key={f.key} label={f.label}>
          {f.control === "select" ? (
            <select
              value={cfgString(effectiveConfig, f.key)}
              onChange={(e) => setField(f.key, e.target.value)}
            >
              {(f.options ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : f.control === "checkbox" ? (
            <label
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <input
                type="checkbox"
                checked={cfgBool(effectiveConfig, f.key)}
                onChange={(e) => setField(f.key, e.target.checked)}
                style={{ width: "auto", height: "auto" }}
              />
              Accepted
            </label>
          ) : (
            <input
              type={f.secret ? "password" : "text"}
              className={f.secret ? "mono" : undefined}
              autoComplete={f.secret ? "new-password" : "off"}
              value={cfgString(effectiveConfig, f.key)}
              placeholder={f.placeholder}
              onChange={(e) => setField(f.key, e.target.value)}
            />
          )}
        </FormField>
      ))}

      <div
        style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4 }}
      >
        <button
          type="button"
          className="btn btn-sm"
          disabled={checking}
          onClick={() => void check()}
        >
          {checking ? "Checking…" : "Check connection"}
        </button>
        {readiness ? (
          <span
            className={`badge${readiness.ready ? " success" : " danger"}`}
            title={readiness.detail}
          >
            {readiness.ready ? "Connected" : "Missing credentials"}
          </span>
        ) : null}
      </div>

      {checkErr ? (
        <div className="notice" role="alert" style={{ marginTop: 8 }}>
          <span>{checkErr}</span>
        </div>
      ) : null}

      {readiness && !readiness.ready ? (
        <div
          style={{
            border:
              "1px solid color-mix(in srgb, var(--pw-danger) 35%, transparent)",
            borderRadius: 6,
            padding: "8px 10px",
            fontSize: 12,
            marginTop: 8,
          }}
          role="status"
        >
          <div style={{ marginBottom: 4 }}>{readiness.detail}</div>
          {(readiness.missing ?? []).length > 0 ? (
            <div className="mono muted" style={{ fontSize: 11 }}>
              Missing: {(readiness.missing ?? []).join(", ")}
            </div>
          ) : null}
          {(readiness.docs ?? []).map((d) => (
            <div key={d} style={{ marginTop: 4 }}>
              <ExternalLink href={d}>Platform setup docs</ExternalLink>
            </div>
          ))}
        </div>
      ) : null}

      {readiness && readiness.ready ? (
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          {readiness.detail}
        </p>
      ) : null}
    </div>
  );
}
