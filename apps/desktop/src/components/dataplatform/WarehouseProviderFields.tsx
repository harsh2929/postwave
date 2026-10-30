import { type ReactElement } from "react";

import { FormField } from "../FormField";
import { Icon } from "../Icon";
import { Notice } from "../Notice";
import type { WarehouseProviderSpec } from "../../lib/api-client";

interface ParsedConfig {
  value: Record<string, unknown> | null;
  valid: boolean;
}

function parseConfig(text: string): ParsedConfig {
  if (!text.trim()) return { value: {}, valid: true };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { value: parsed as Record<string, unknown>, valid: true };
    }
  } catch {
    // The parent validation treatment owns the parse error copy.
  }
  return { value: null, valid: false };
}

function fieldValue(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return "";
}

export function WarehouseProviderFields({
  spec,
  configText,
  error,
  loading,
  loadError,
  onChange,
  onRetry,
}: {
  spec: WarehouseProviderSpec | undefined;
  configText: string;
  error?: string;
  loading: boolean;
  loadError: string | null;
  onChange: (text: string) => void;
  onRetry: () => void;
}): ReactElement {
  const parsed = parseConfig(configText);
  const config = parsed.value ?? {};
  const fields = [
    ...(spec?.required_settings ?? []),
    ...(spec?.optional_settings ?? []),
  ].filter((field) => field.key !== "credentials_ref");

  const patchField = (key: string, value: string): void => {
    if (!parsed.valid) return;
    const next = { ...config };
    if (value === "") delete next[key];
    else next[key] = value;
    onChange(JSON.stringify(next, null, 2));
  };

  return (
    <div className="dp-provider-config">
      {loading ? (
        <p className="muted" role="status" aria-busy="true">
          Verifying provider field contract…
        </p>
      ) : loadError ? (
        <Notice
          className="dp-notice"
          tone="danger"
          announcement="assertive"
          action={
            <button type="button" className="btn btn-sm" onClick={onRetry}>
              Retry fields
            </button>
          }
        >
          <span>
            Typed provider fields couldn&apos;t be verified. Advanced JSON
            remains available, and server validation is still required.
          </span>
        </Notice>
      ) : spec ? (
        <div className="dp-provider-contract" role="note">
          <Icon
            name={
              spec.runtime_status === "available"
                ? "shield-check"
                : "alert-triangle"
            }
            size={17}
          />
          <div>
            <strong>{spec.name} runtime contract</strong>
            <span>
              {spec.runtime_status} · {spec.auth_mode.replaceAll("_", " ")} ·{" "}
              {spec.managed ? "managed" : "operator managed"}
            </span>
          </div>
          <span
            className={`dp-status-pill${
              spec.runtime_status === "available"
                ? ""
                : " dp-status-pill-warning"
            }`}
          >
            {spec.runtime_status}
          </span>
        </div>
      ) : null}

      {spec && fields.length > 0 ? (
        <div className="dp-provider-field-grid">
          {fields.map((field) => (
            <FormField
              key={field.key}
              label={field.label}
              required={field.required}
              help={field.help}
            >
              <input
                type={field.secret ? "password" : "text"}
                autoComplete="off"
                value={fieldValue(config, field.key)}
                disabled={!parsed.valid}
                onChange={(event) => patchField(field.key, event.target.value)}
                placeholder={field.key}
              />
            </FormField>
          ))}
        </div>
      ) : null}

      {!parsed.valid ? (
        <div className="dp-provider-json-warning" role="status">
          Fix the advanced JSON before using typed provider fields.
        </div>
      ) : null}

      <details className="dp-advanced-config" open={!spec || !parsed.valid}>
        <summary>
          <span>
            <strong>Advanced provider JSON</strong>
            <small>
              Full-fidelity fallback for settings not represented above
            </small>
          </span>
          <Icon name="chevron-down" size={14} />
        </summary>
        <FormField
          label="Provider config (JSON)"
          error={error}
          help="Configuration metadata only. Raw credentials, tokens, passwords, private keys, and endpoint overrides are rejected server-side."
        >
          <textarea
            className="mono dp-code-editor"
            rows={7}
            spellCheck={false}
            value={configText}
            onChange={(event) => onChange(event.target.value)}
            placeholder='{"account": "xy12345", "database": "ANALYTICS"}'
          />
        </FormField>
      </details>
    </div>
  );
}
