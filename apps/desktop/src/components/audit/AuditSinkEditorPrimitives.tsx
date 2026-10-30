import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  type AuditSink,
  type AuditSinkOutputFormat,
  type AuditSinkSigningKey,
  type AuditSinkWebhookFormat,
  api,
  getApiUrl,
} from "../../lib/api-client";
import { writeClipboardText } from "../../lib/clipboard";
import { ConfirmModal } from "../ConfirmModal";
import { ExternalLink } from "../ExternalLink";
import { InlineHelp } from "../InlineHelp";
import { SecureDraftInput } from "../SecureDraftInput";
import { toast } from "../Toast";

import { formatAuditSinkRelative } from "./AuditSinkTables";

export interface AuditSinkFieldSpec {
  key: string;
  label: string;
  store: "config" | "credentials";
  type: "text" | "password";
  placeholder?: string;
  helpText?: string;
  tooltipText?: string;
  helpUrl?: string;
  required?: boolean;
}

export interface AuditSinkKindSpec {
  value: AuditSink["kind"];
  label: string;
  description: string;
  fields: AuditSinkFieldSpec[];
}

export function OutputFormatSelector({
  value,
  onChange,
  idPrefix,
  disabled = false,
}: {
  value: AuditSinkOutputFormat;
  onChange: (value: AuditSinkOutputFormat) => void;
  idPrefix: string;
  disabled?: boolean;
}): ReactElement {
  return (
    <div
      role="radiogroup"
      aria-label="Sink output format"
      style={{ display: "flex", gap: 16 }}
    >
      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input
          type="radio"
          id={`${idPrefix}-fmt-native`}
          name={`${idPrefix}-output-format`}
          value="postwave_native"
          checked={value === "postwave_native"}
          disabled={disabled}
          onChange={() => onChange("postwave_native")}
        />
        <span>Moosewave native</span>
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input
          type="radio"
          id={`${idPrefix}-fmt-ocsf`}
          name={`${idPrefix}-output-format`}
          value="ocsf_1_8"
          checked={value === "ocsf_1_8"}
          disabled={disabled}
          onChange={() => onChange("ocsf_1_8")}
        />
        <span>OCSF 1.8</span>
      </label>
    </div>
  );
}

export function WebhookFormatSelector({
  value,
  onChange,
  idPrefix,
  disabled = false,
}: {
  value: AuditSinkWebhookFormat;
  onChange: (value: AuditSinkWebhookFormat) => void;
  idPrefix: string;
  disabled?: boolean;
}): ReactElement {
  return (
    <div
      role="radiogroup"
      aria-label="Webhook signature format"
      style={{ display: "flex", gap: 16 }}
    >
      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input
          type="radio"
          id={`${idPrefix}-wh-postwave`}
          name={`${idPrefix}-webhook-format`}
          value="postwave_v1"
          checked={value === "postwave_v1"}
          disabled={disabled}
          onChange={() => onChange("postwave_v1")}
        />
        <span>Moosewave v1 (legacy)</span>
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input
          type="radio"
          id={`${idPrefix}-wh-std`}
          name={`${idPrefix}-webhook-format`}
          value="standard_webhooks"
          checked={value === "standard_webhooks"}
          disabled={disabled}
          onChange={() => onChange("standard_webhooks")}
        />
        <span>Standard Webhooks (RFC 9499)</span>
      </label>
    </div>
  );
}

export function SigningKeyPanel({
  sink,
  onOperationChange,
}: {
  sink: AuditSink;
  onOperationChange: (active: boolean) => void;
}): ReactElement {
  const [keys, setKeys] = useState<AuditSinkSigningKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [rotateBusy, setRotateBusy] = useState(false);
  const [rotateConfirmOpen, setRotateConfirmOpen] = useState(false);
  const loadRef = useRef(false);
  const rotateRef = useRef(false);
  const jwksUrl = `${getApiUrl().replace(/\/+$/, "")}/api/v1/audit-sinks/${encodeURIComponent(sink.id)}/.well-known/jwks.json`;

  const load = async (): Promise<void> => {
    if (loadRef.current) return;
    loadRef.current = true;
    setLoading(true);
    try {
      const res = await api.auditSinkSigningKeysList(sink.id);
      if (res.error) {
        toast.error(res.error.message);
        return;
      }
      setKeys(res.data.keys);
    } catch {
      toast.error("Signing keys couldn't be loaded. Try again.");
    } finally {
      loadRef.current = false;
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // `load` is deliberately single-flight and the keyed parent remounts for a
    // different sink. Re-running for render-local function identity is noise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sink.id]);

  const rotate = async (): Promise<void> => {
    if (rotateRef.current || loading) return;
    rotateRef.current = true;
    setRotateBusy(true);
    setRotateConfirmOpen(false);
    onOperationChange(true);
    try {
      const res = await api.auditSinkRotateKey(sink.id);
      if (res.error) {
        toast.error(res.error.message);
        return;
      }
      toast.success(
        `Signing key rotated — new kid ${res.data.kid.slice(0, 8)}…`,
      );
      await load();
    } catch {
      toast.error("The signing key couldn't be rotated. Try again.");
    } finally {
      rotateRef.current = false;
      setRotateBusy(false);
      onOperationChange(false);
    }
  };

  const copyJWKS = async (): Promise<void> => {
    const result = await writeClipboardText(jwksUrl, {
      contentClass: "public",
      label: "JWKS URL",
    });
    if (result.ok) toast.success("JWKS URL copied");
    else toast.error(result.message);
  };

  return (
    <FormField label="Signing keys (Standard Webhooks)">
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <button
          type="button"
          onClick={() => setRotateConfirmOpen(true)}
          disabled={loading || rotateBusy}
        >
          {rotateBusy ? "Rotating…" : "Rotate signing key"}
        </button>
        <button type="button" onClick={() => void copyJWKS()}>
          Copy JWKS URL
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        Receivers verify signatures against{" "}
        <code style={{ fontSize: 11 }}>{jwksUrl}</code>. Revoked keys stay
        visible in the JWKS for a 30-minute grace window so in-flight
        verifications still find them.
      </p>
      {loading ? (
        <p className="muted" style={{ fontSize: 12 }}>
          Loading keys…
        </p>
      ) : keys.length > 0 ? (
        <table style={{ width: "100%", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--pw-fg-muted)" }}>
              <th>Kid</th>
              <th>Alg</th>
              <th>Status</th>
              <th>Rotated</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id}>
                <td>
                  <code style={{ fontSize: 11 }}>{key.kid}</code>
                </td>
                <td>{key.alg}</td>
                <td>
                  <span
                    style={{
                      color:
                        key.status === "active"
                          ? "var(--pw-success)"
                          : "var(--pw-fg-muted)",
                    }}
                  >
                    {key.status}
                  </span>
                </td>
                <td>{formatAuditSinkRelative(key.rotated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted" style={{ fontSize: 12 }}>
          No keys yet — one is minted automatically on first delivery, or rotate
          now to bootstrap.
        </p>
      )}
      <ConfirmModal
        open={rotateConfirmOpen}
        title="Rotate this signing key?"
        description="A new key becomes active immediately. Receivers must use the JWKS endpoint; the old key remains available for a 30-minute verification grace window."
        confirmLabel="Rotate key"
        busy={rotateBusy}
        onClose={() => setRotateConfirmOpen(false)}
        onConfirm={rotate}
      >
        <p style={{ margin: 0, fontSize: 13 }}>
          Sink <strong>{sink.name}</strong>
        </p>
      </ConfirmModal>
    </FormField>
  );
}

export function KindFieldSet({
  spec,
  config,
  credentials,
  errors,
  setConfig,
  setCredentials,
  credentialsOnly = false,
  disabled = false,
}: {
  spec: AuditSinkKindSpec;
  config: Record<string, string>;
  credentials: Record<string, string>;
  errors: Record<string, string>;
  setConfig: (next: Record<string, string>) => void;
  setCredentials: (next: Record<string, string>) => void;
  credentialsOnly?: boolean;
  disabled?: boolean;
}): ReactElement {
  return (
    <>
      {spec.fields
        .filter((field) =>
          credentialsOnly ? field.store === "credentials" : true,
        )
        .map((field) => {
          const value =
            (field.store === "config" ? config : credentials)[field.key] ?? "";
          const onChange = (next: string): void => {
            if (field.store === "config") {
              setConfig({ ...config, [field.key]: next });
            } else {
              setCredentials({ ...credentials, [field.key]: next });
            }
          };
          return (
            <FormField
              key={field.key}
              label={field.label}
              helpText={field.helpText}
              helpUrl={field.helpUrl}
              tooltipText={field.tooltipText}
              required={field.required}
              error={errors[field.key]}
            >
              {field.type === "password" ? (
                <SecureDraftInput
                  value={value}
                  onChange={onChange}
                  placeholder={field.placeholder}
                  accessibleName={field.label}
                  disabled={disabled}
                />
              ) : (
                <input
                  type="text"
                  value={value}
                  placeholder={field.placeholder}
                  autoComplete="off"
                  aria-label={field.label}
                  disabled={disabled}
                  onChange={(event) => onChange(event.target.value)}
                />
              )}
            </FormField>
          );
        })}
    </>
  );
}

export function FormField({
  label,
  helpText,
  helpUrl,
  tooltipText,
  required,
  error,
  children,
}: {
  label: string;
  helpText?: string;
  helpUrl?: string;
  tooltipText?: string;
  required?: boolean;
  error?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        className="label"
        style={{ display: "flex", alignItems: "center", gap: 6 }}
      >
        <span>
          {label}
          {required ? (
            <span style={{ color: "var(--pw-danger)", marginLeft: 2 }}>*</span>
          ) : null}
        </span>
        {tooltipText ? <InlineHelp text={tooltipText} /> : null}
        {helpUrl ? (
          <ExternalLink
            href={helpUrl}
            className="muted"
            style={{ fontSize: 11 }}
          >
            (where do I find this?)
          </ExternalLink>
        ) : null}
      </div>
      {children}
      {error ? (
        <p
          className="field-error"
          role="alert"
          style={{ fontSize: 12, margin: "4px 0 0" }}
        >
          {error}
        </p>
      ) : helpText ? (
        <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
          {helpText}
        </p>
      ) : null}
    </div>
  );
}
