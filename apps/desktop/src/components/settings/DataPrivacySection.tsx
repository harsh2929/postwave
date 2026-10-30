/**
 * DataPrivacySection — Settings "Data Privacy" card
 * (SUB-072 — AI gateway / privacy firewall for prompts).
 *
 * Moosewave tokenizes PII before a subscriber field is ever placed in a
 * model prompt, then detokenizes the model's response. This card is the
 * per-tenant control plane an operator uses to mark which subscriber
 * fields are PII-sensitive (and therefore masked from AI models).
 *
 * Reads GET /api/v1/settings/pii-config and renders one row per known
 * field:
 *   - built-in identifier fields (email, phone) are ALWAYS masked and
 *     their toggle is locked on — they cannot be exposed to a model.
 *   - custom fields default to NOT masked; an admin flips the per-field
 *     "Mask from AI models" toggle, which PATCHes the config.
 *
 * Honest-UI notes:
 *   - the surface 503s with code "pii_gateway_unconfigured" on a
 *     deployment where the gateway isn't wired — we hide the whole card
 *     in that case (it's not an error to surface to the operator).
 *   - every load/save failure renders the error inline; nothing is
 *     fabricated while a fetch is down.
 *   - tokenized-prompt auditing is logs-only by backend design, so there
 *     is no client-facing toggle for it — we say so explicitly.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useState,
} from "react";

import {
  type PIIConfigResponse,
  type PIIFieldSensitivity,
  piiConfigApi,
} from "../../lib/api-client";
import { useCanAdmin } from "../../lib/store";
import { InlineHelp } from "../InlineHelp";
import { toast } from "../Toast";
import { SettingsSectionHeader } from "./SettingsNav";

export function DataPrivacySection(): ReactElement | null {
  const canAdmin = useCanAdmin();
  const [config, setConfig] = useState<PIIConfigResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  // Latched true when the gateway isn't wired on this deployment (503).
  // The whole card hides rather than nagging — matching the slideover
  // convention for not-yet-deployed surfaces.
  const [unavailable, setUnavailable] = useState<boolean>(false);
  // field_name currently being PATCHed (locks just that row's toggle).
  const [savingField, setSavingField] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    const res = await piiConfigApi.get();
    setLoading(false);
    if (res.error) {
      if (
        res.error.kind === "http" &&
        (res.error.status === 503 || res.error.status === 404)
      ) {
        setUnavailable(true);
        return;
      }
      setErr(res.error.message);
      setConfig(null);
      return;
    }
    setConfig(res.data ?? null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleField = useCallback(
    async (field: PIIFieldSensitivity, next: boolean): Promise<void> => {
      if (!canAdmin || field.built_in) return;
      setSavingField(field.field_name);
      const res = await piiConfigApi.update({
        fields: [{ field_name: field.field_name, sensitive: next }],
      });
      setSavingField(null);
      if (res.error) {
        toast.error({
          message: "Couldn't update field privacy",
          detail: res.error.message,
        });
        return;
      }
      setConfig(res.data ?? null);
      toast.success({
        message: next
          ? `"${field.field_name}" is now masked from AI models`
          : `"${field.field_name}" is no longer masked from AI models`,
      });
    },
    [canAdmin],
  );

  // Hide entirely when the gateway isn't deployed on this backend.
  if (unavailable) return null;

  const fields = config?.fields ?? [];
  const maskedCount = fields.filter((f) => f.sensitive).length;

  return (
    <div className="settings-section">
      <SettingsSectionHeader
        title="Data Privacy"
        description="Moosewave tokenizes PII before any subscriber field is placed in an AI prompt, then detokenizes the model's response. Choose which fields are masked from AI models."
        meta={
          !loading && !err && config ? (
            <span className="tabular muted" style={{ fontSize: 12 }}>
              {maskedCount} of {fields.length} masked
            </span>
          ) : undefined
        }
      />
      <div className="settings-section-body">
        {err ? (
          <div className="notice">
            <span>Couldn&apos;t load data-privacy config: {err}</span>
            <span className="spacer" />
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void load()}
              disabled={loading}
            >
              Retry
            </button>
          </div>
        ) : loading ? (
          <>
            <div className="skel-row" />
            <div className="skel-row" />
          </>
        ) : fields.length === 0 ? (
          <div className="muted" style={{ fontSize: 12 }}>
            No subscriber fields are configured yet. Built-in identifiers
            (email, phone) are always masked from AI models.
          </div>
        ) : (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto auto",
                gap: "8px 12px",
                alignItems: "center",
                fontSize: 13,
              }}
            >
              {/* Header row */}
              <span className="muted" style={{ fontSize: 11 }}>
                Field
              </span>
              <span
                className="muted"
                style={{
                  fontSize: 11,
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                Mask from AI models
                <InlineHelp text="When on, this field's value is tokenized before being sent to any AI model and detokenized in the response — the model never sees the raw value." />
              </span>
              <span />

              {fields.map((field) => {
                const locked = field.built_in || !canAdmin;
                const busy = savingField === field.field_name;
                return (
                  <FieldRow
                    key={field.field_name}
                    field={field}
                    locked={locked}
                    busy={busy}
                    onToggle={(next) => void toggleField(field, next)}
                  />
                );
              })}
            </div>

            {!canAdmin ? (
              <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
                Only workspace owners and admins can change which fields are
                masked from AI models.
              </div>
            ) : null}

            {/* Tokenized-prompt auditing is logs-only by backend design —
                no client-facing toggle. Surface that honestly. */}
            <div className="muted" style={{ fontSize: 11, marginTop: 10 }}>
              Tokenized-prompt auditing is recorded to server logs only; there
              is no client-facing audit toggle.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** One field row in the PII-sensitivity grid. Built-in identifier fields
 *  render a locked-on toggle plus a "Built-in" badge so the operator sees
 *  they're always masked and can't be exposed. */
function FieldRow({
  field,
  locked,
  busy,
  onToggle,
}: {
  field: PIIFieldSensitivity;
  locked: boolean;
  busy: boolean;
  onToggle: (next: boolean) => void;
}): ReactElement {
  // Built-ins are always masked regardless of the persisted flag.
  const checked = field.built_in ? true : field.sensitive;
  return (
    <>
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontWeight: 500 }}>{field.field_name}</span>
        {field.built_in ? (
          <span
            className="badge"
            style={{ fontSize: 10 }}
            title="Identifier field — always masked from AI models"
          >
            Built-in
          </span>
        ) : null}
      </span>
      <label
        className="radio-row"
        style={{ gap: 8, justifySelf: "end" }}
        title={
          field.built_in
            ? "Identifier fields are always masked from AI models"
            : checked
              ? "Click to expose this field to AI models"
              : "Click to mask this field from AI models"
        }
      >
        <input
          type="checkbox"
          aria-label={`${field.field_name}: ${checked ? "masked from" : "visible to"} AI models`}
          checked={checked}
          disabled={locked || busy}
          onChange={(e) => onToggle(e.target.checked)}
        />
      </label>
      <span className="muted tabular" style={{ fontSize: 11 }}>
        {busy ? "Saving…" : checked ? "Masked" : "Visible"}
      </span>
    </>
  );
}
