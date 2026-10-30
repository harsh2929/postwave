/**
 * IdentifierTransformsSection — Settings "Identifier transforms" card
 * (SUB-018 — identifier normalization transforms at ingest).
 *
 * Reads GET /api/v1/settings/identifier-transforms to render the
 * per-tenant normalization policy applied to every subscriber identifier
 * at ingest (in Create/Update, before the row is upserted):
 *
 *   - email_normalize_dots  — strip dots from the email local-part
 *     (Gmail-style "j.o.h.n@gmail.com" → "john@gmail.com").
 *   - email_normalize_plus  — drop the "+tag" sub-address
 *     ("john+promo@gmail.com" → "john@gmail.com").
 *   - phone_e164_format     — coerce phone identifiers (in merge/custom
 *     fields) to E.164, using phone_default_region as the default region
 *     for national-format numbers that lack a "+countrycode".
 *
 * Email is always lowercased regardless of these toggles; the toggles add
 * the *optional* canonicalization on top. Every transform defaults OFF, so
 * an unconfigured workspace keeps the historic lowercase-only behaviour.
 *
 * Admins get the editor (PATCH is admin-scoped on the API); non-admins see
 * the resolved policy read-only with an explanatory note.
 *
 * A live preview panel POSTs a sample identifier to
 * /api/v1/subscribers/preview-transforms with the *draft* config as
 * `overrides`, so the operator sees exactly what the unsaved toggles would
 * do before committing — the same dry-run the import wizard uses.
 *
 * Honest-UI: load/save/preview failures surface the error inline; nothing
 * is fabricated while a fetch is down. The section hides itself when the
 * endpoint 404s on a deployment that predates SUB-018.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  lifecycleOperationError,
  useExistingSettingLifecycle,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import {
  IDENTIFIER_TRANSFORM_PHONE_REGIONS,
  type IdentifierTransformConfig,
  type IdentifierTransformPreviewResult,
  identifierTransformsApi,
} from "../../lib/api-client";
import { useCanAdmin } from "../../lib/store";
import { toast } from "../Toast";
import {
  parseIdentifierTransformConfig,
  parseIdentifierTransformPreview,
} from "./identifier-transform-contract";
import { SettingsSectionHeader } from "./SettingsNav";

const DEFAULT_PREVIEW_EMAIL = "J.o.h.n+promo@Gmail.com";
const DEFAULT_PREVIEW_PHONE = "(202) 555-0147";

export function IdentifierTransformsSection(): ReactElement | null {
  const canAdmin = useCanAdmin();
  const [config, setConfig] = useState<IdentifierTransformConfig | null>(null);
  const [draft, setDraft] = useState<IdentifierTransformConfig | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [hidden, setHidden] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);

  // Preview sample. The operator can edit both so they can sanity-check the
  // policy against their own identifier shapes, not just the canned sample.
  const [previewEmail, setPreviewEmail] = useState<string>(
    DEFAULT_PREVIEW_EMAIL,
  );
  const [previewPhone, setPreviewPhone] = useState<string>(
    DEFAULT_PREVIEW_PHONE,
  );
  const [preview, setPreview] =
    useState<IdentifierTransformPreviewResult | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const activeRef = useRef(true);
  const operation = useSingleFlightOperation({
    ownerId: "identifier-transforms",
    label: "Identifier-transform request",
  });

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      const res = await identifierTransformsApi.get();
      if (!activeRef.current) return;
      if (res.error) {
        if (/not[_ ]?found|404/i.test(res.error.code ?? res.error.message)) {
          setHidden(true);
          return;
        }
        setErr(res.error.message);
        return;
      }
      const parsed = parseIdentifierTransformConfig(res.data);
      if (!parsed) {
        setErr("Identifier transform response was malformed.");
        return;
      }
      setConfig(parsed);
      setDraft(parsed);
    } catch (loadError) {
      if (activeRef.current) {
        setErr(
          lifecycleOperationError(
            loadError,
            "Identifier transforms couldn't be loaded.",
          ),
        );
      }
    } finally {
      if (activeRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    activeRef.current = true;
    void load();
    return () => {
      activeRef.current = false;
    };
  }, [load]);

  // Live preview: re-runs whenever the draft config or the sample inputs
  // change. Sends the draft as `overrides` so the preview reflects unsaved
  // toggles (the same dry-run endpoint the import wizard uses).
  useEffect(() => {
    if (!draft) return;
    let cancelled = false;
    // D14-settings-misc#12: debounce ~250ms so typing a sample email/phone
    // doesn't fire one preview POST per keystroke against the admin endpoint.
    // The cleanup clears the pending timer AND flags the in-flight run stale
    // so a slow response from an earlier keystroke can't overwrite a newer
    // preview once its own request lands.
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await identifierTransformsApi.preview({
            email: previewEmail,
            custom_fields: previewPhone ? { phone: previewPhone } : {},
            overrides: draft,
          });
          if (cancelled || !activeRef.current) return;
          if (res.error) {
            setPreviewErr(res.error.message);
            setPreview(null);
            return;
          }
          const parsed = parseIdentifierTransformPreview(res.data);
          if (!parsed) {
            setPreviewErr("Preview response was malformed.");
            setPreview(null);
            return;
          }
          setPreviewErr(null);
          setPreview(parsed);
        } catch (previewError) {
          if (!cancelled && activeRef.current) {
            setPreviewErr(
              lifecycleOperationError(
                previewError,
                "The identifier preview couldn't be generated.",
              ),
            );
            setPreview(null);
          }
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [draft, previewEmail, previewPhone]);

  const dirty =
    config != null &&
    draft != null &&
    (config.email_normalize_dots !== draft.email_normalize_dots ||
      config.email_normalize_plus !== draft.email_normalize_plus ||
      config.phone_e164_format !== draft.phone_e164_format ||
      config.phone_default_region !== draft.phone_default_region);

  const setDraftField = useCallback(
    <K extends keyof IdentifierTransformConfig>(
      key: K,
      value: IdentifierTransformConfig[K],
    ): void => {
      setDraft((d) => (d ? { ...d, [key]: value } : d));
    },
    [],
  );

  const save = useCallback(async (): Promise<boolean> => {
    if (!canAdmin || !draft) return false;
    const pending = operation.promiseRef.current;
    if (pending) {
      return (await pending) === true;
    }
    setSaving(true);
    const request = operation.run(async (): Promise<boolean> => {
      try {
        const res = await identifierTransformsApi.update({
          email_normalize_dots: draft.email_normalize_dots,
          email_normalize_plus: draft.email_normalize_plus,
          phone_e164_format: draft.phone_e164_format,
          phone_default_region: draft.phone_default_region,
        });
        if (!activeRef.current) return false;
        if (res.error) {
          toast.error(
            `Couldn't save identifier transforms: ${res.error.message}`,
          );
          return false;
        }
        const parsed = parseIdentifierTransformConfig(res.data);
        if (!parsed) {
          toast.error("Save returned an invalid identifier transform response.");
          return false;
        }
        setConfig(parsed);
        setDraft(parsed);
        toast.success("Identifier transforms saved.");
        return true;
      } catch (saveError) {
        if (activeRef.current) {
          toast.error(
            `Couldn't save identifier transforms: ${lifecycleOperationError(saveError, "The identifier-transform request failed.")}`,
          );
        }
        return false;
      } finally {
        if (activeRef.current) setSaving(false);
      }
    });
    return request ? await request : false;
  }, [canAdmin, draft, operation]);

  const reset = useCallback((): void => {
    setDraft(config);
  }, [config]);

  useExistingSettingLifecycle({
    ownerId: "identifier-transforms",
    label: "Identifier transforms",
    dirty,
    operationRef: operation.promiseRef,
    save,
    discard: reset,
    detail: "Identifier-transform changes have not been saved.",
  });

  if (hidden) return null;

  return (
    <div className="settings-section">
      <SettingsSectionHeader
        title="Identifier transforms"
        description="Normalize subscriber identifiers at ingest so duplicates collapse to one canonical row. Email is always lowercased; these rules add optional canonicalization on top. Applied to every Create/Update before the subscriber is stored."
        meta={
          dirty ? (
            <span className="badge accent" style={{ fontSize: 11 }}>
              Unsaved
            </span>
          ) : undefined
        }
      />
      <div className="settings-section-body">
        {err ? (
          <div className="notice">
            <span>Couldn&apos;t load identifier transforms: {err}</span>
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
        ) : loading || !draft ? (
          <>
            <div className="skel-row" />
            <div className="skel-row" />
          </>
        ) : (
          <>
            <IdentifierTransformControls
              draft={draft}
              disabled={!canAdmin || operation.active}
              onChange={setDraftField}
            />

            {/* Live preview — dry-runs the *draft* config against a sample so
                the operator sees the effect before saving. */}
            <PreviewPanel
              email={previewEmail}
              phone={previewPhone}
              onEmailChange={setPreviewEmail}
              onPhoneChange={setPreviewPhone}
              result={preview}
              error={previewErr}
            />

            {canAdmin ? (
              <div className="settings-row">
                <div className="muted" style={{ fontSize: 12 }}>
                  Changes apply to new ingests only — existing rows are not
                  rewritten.
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={reset}
                    disabled={operation.active || !dirty}
                  >
                    Reset
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={() => void save()}
                    disabled={operation.active || !dirty}
                  >
                    {saving ? "Saving…" : "Save transforms"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="muted" style={{ fontSize: 12 }}>
                Only workspace owners and admins can change these transforms.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function IdentifierTransformControls({
  draft,
  disabled,
  onChange,
}: {
  draft: IdentifierTransformConfig;
  disabled: boolean;
  onChange: <K extends keyof IdentifierTransformConfig>(
    key: K,
    value: IdentifierTransformConfig[K],
  ) => void;
}): ReactElement {
  return (
    <>
      <TransformToggleRow
        title="Strip dots in email local-part"
        description={
          <>
            Treats <span className="mono">j.o.h.n@gmail.com</span> and{" "}
            <span className="mono">john@gmail.com</span> as the same address
            (Gmail-style). The domain is never touched.
          </>
        }
        checked={draft.email_normalize_dots}
        disabled={disabled}
        onChange={(checked) => onChange("email_normalize_dots", checked)}
      />
      <TransformToggleRow
        title="Strip plus-alias sub-addressing"
        description={
          <>
            Drops the <span className="mono">+tag</span> from{" "}
            <span className="mono">john+promo@gmail.com</span> →{" "}
            <span className="mono">john@gmail.com</span>.
          </>
        }
        checked={draft.email_normalize_plus}
        disabled={disabled}
        onChange={(checked) => onChange("email_normalize_plus", checked)}
      />
      <TransformToggleRow
        title="Format phone numbers as E.164"
        description={
          <>
            Coerces phone identifiers in custom fields to E.164 (
            <span className="mono">+12025550147</span>). National-format numbers
            use the default region below to resolve the country code.
          </>
        }
        checked={draft.phone_e164_format}
        disabled={disabled}
        onChange={(checked) => onChange("phone_e164_format", checked)}
      />
      <div className="settings-row" style={{ alignItems: "flex-start" }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 13 }}>
            Phone default region
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            Used for national-format numbers without a{" "}
            <span className="mono">+countrycode</span>. Already-international
            numbers are unaffected.
          </div>
        </div>
        <select
          className="input"
          style={{ maxWidth: 280 }}
          value={draft.phone_default_region}
          disabled={disabled || !draft.phone_e164_format}
          onChange={(event) =>
            onChange("phone_default_region", event.target.value)
          }
          aria-label="Phone default region"
        >
          {IDENTIFIER_TRANSFORM_PHONE_REGIONS.map((region) => (
            <option key={region.value || "none"} value={region.value}>
              {region.label}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}

function TransformToggleRow({
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  description: ReactElement;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}): ReactElement {
  return (
    <div className="settings-row" style={{ alignItems: "flex-start" }}>
      <div>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{title}</div>
        <div className="muted" style={{ fontSize: 12 }}>
          {description}
        </div>
      </div>
      <label className="radio-row" style={{ gap: 8 }}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        {checked ? "On" : "Off"}
      </label>
    </div>
  );
}

/**
 * PreviewPanel — editable sample identifiers + the before→after the draft
 * transforms produce. Purely a dry-run reflection of the server's
 * preview endpoint; nothing here writes.
 */
function PreviewPanel({
  email,
  phone,
  onEmailChange,
  onPhoneChange,
  result,
  error,
}: {
  email: string;
  phone: string;
  onEmailChange: (v: string) => void;
  onPhoneChange: (v: string) => void;
  result: IdentifierTransformPreviewResult | null;
  error: string | null;
}): ReactElement {
  return (
    <div
      style={{
        marginTop: 4,
        padding: 12,
        borderRadius: 6,
        background: "var(--pw-bg-elev-2)",
        display: "grid",
        gap: 10,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 12 }}>Preview</div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)",
          gap: 12,
        }}
      >
        <label style={{ display: "grid", gap: 4 }}>
          <span className="muted" style={{ fontSize: 11 }}>
            Sample email
          </span>
          <input
            className="input mono"
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
            placeholder="J.o.h.n+promo@Gmail.com"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="muted" style={{ fontSize: 11 }}>
            Sample phone
          </span>
          <input
            className="input mono"
            value={phone}
            onChange={(e) => onPhoneChange(e.target.value)}
            placeholder="(202) 555-0147"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      </div>
      {error ? (
        <div className="muted" style={{ fontSize: 12, color: "var(--pw-danger)" }}>
          Preview failed: {error}
        </div>
      ) : result ? (
        <div style={{ display: "grid", gap: 6 }}>
          <PreviewRow
            label="Email"
            input={result.email_input}
            output={result.email_output}
            changed={result.email_changed}
          />
          {result.phones.map((p) => (
            <PreviewRow
              key={p.key}
              label={p.key}
              input={p.input}
              output={p.output}
              changed={p.changed}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** One before→after preview line. Unchanged identifiers render a muted
 * "no change" so the absence of a transform is explicit. */
function PreviewRow({
  label,
  input,
  output,
  changed,
}: {
  label: string;
  input: string;
  output: string;
  changed: boolean;
}): ReactElement {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(56px, auto) 1fr",
        gap: 8,
        alignItems: "baseline",
      }}
    >
      <span className="muted" style={{ fontSize: 11 }}>
        {label}
      </span>
      {changed ? (
        <span className="mono" style={{ fontSize: 11 }}>
          <span className="muted" style={{ textDecoration: "line-through" }}>
            {input || "—"}
          </span>
          <span aria-hidden style={{ margin: "0 6px" }}>
            →
          </span>
          <span style={{ color: "var(--pw-success)" }}>{output}</span>
        </span>
      ) : (
        <span className="mono muted" style={{ fontSize: 11 }}>
          {output || "—"} <span style={{ fontStyle: "italic" }}>(no change)</span>
        </span>
      )}
    </div>
  );
}
