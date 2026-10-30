/** Hosted preference-center theme editor with a non-interactive live preview. */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { useRemoteResource } from "../../hooks/useRemoteResource";
import {
  useExistingSettingLifecycle,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import {
  type PreferenceCenterCustomization as Theme,
  api,
  defaultPreferenceCustomization,
} from "../../lib/api-client";
import {
  hasVerifiedRemoteData,
  remoteFailureFromError,
} from "../../lib/remote-resource";
import { RemoteDataNotice } from "../RemoteDataNotice";
import { toast } from "../Toast";

interface ThemeValidation {
  logoError: string | null;
  colorError: string | null;
  contrastError: string | null;
  contrastRatio: number | null;
  valid: boolean;
}

async function loadPreferenceTheme() {
  const result = await api.privacyPortal.getPreferenceCustomization();
  if (result.error) return { error: result.error };
  return { data: normalizeTheme(result.data) };
}

function normalizeTheme(value: Theme | null | undefined): Theme {
  const defaults = defaultPreferenceCustomization();
  if (!value) return defaults;
  return {
    logo_url: typeof value.logo_url === "string" ? value.logo_url : "",
    primary_color:
      typeof value.primary_color === "string"
        ? value.primary_color
        : defaults.primary_color,
    footer_text: typeof value.footer_text === "string" ? value.footer_text : "",
    show_postwave_badge: value.show_postwave_badge !== false,
  };
}

export function PreferenceCenterCustomization(): ReactElement {
  const controller = usePreferenceThemeController();
  const titleId = useId();
  const actionStatusId = useId();
  const unavailable = controller.operationActive || !controller.loaded;
  const saveUnavailable =
    unavailable || !controller.dirty || !controller.validation.valid;

  return (
    <section
      className="card preference-theme-card"
      aria-labelledby={titleId}
      aria-busy={controller.operationActive || undefined}
    >
      <header className="preference-theme-toolbar">
        <div>
          <h3 id={titleId}>Preference center · theme</h3>
          <p>Overrides applied to the hosted subscribe and unsubscribe page.</p>
        </div>
        <div className="preference-theme-actions">
          <button
            type="button"
            className="btn pw-discoverable-unavailable"
            onClick={() => {
              if (!unavailable) controller.reset();
            }}
            aria-disabled={unavailable || undefined}
            aria-describedby={actionStatusId}
          >
            Use defaults
          </button>
          <button
            type="button"
            className="btn pw-discoverable-unavailable"
            onClick={() => {
              if (!controller.operationActive && controller.dirty) {
                controller.discard();
              }
            }}
            aria-disabled={
              controller.operationActive || !controller.dirty || undefined
            }
            aria-describedby={actionStatusId}
          >
            Discard changes
          </button>
          <button
            type="button"
            className="btn btn-primary pw-discoverable-unavailable"
            onClick={() => {
              if (!saveUnavailable) void controller.save();
            }}
            aria-disabled={saveUnavailable || undefined}
            aria-busy={controller.operationKind === "save" ? "true" : undefined}
            aria-describedby={actionStatusId}
          >
            {controller.operationKind === "save" ? "Saving…" : "Save"}
          </button>
        </div>
      </header>

      <p id={actionStatusId} className="pw-action-status" role="status">
        {themeActionStatus(controller)}
      </p>

      <RemoteDataNotice
        resource={controller.resource}
        label="saved preference-center theme"
        onRetry={() => void controller.retryLoad()}
      />

      {controller.resource.transport === "loading" && !controller.loaded ? (
        <p className="pw-action-status" role="status" aria-live="polite">
          Verifying the saved theme. The fallback defaults are preview-only and
          cannot be saved until verification completes.
        </p>
      ) : null}

      <div className="preference-theme-layout">
        <ThemeEditorForm
          theme={controller.theme}
          validation={controller.validation}
          disabled={unavailable}
          onChange={controller.setTheme}
        />
        <PreviewPane
          theme={controller.theme}
          validation={controller.validation}
          verified={controller.loaded}
        />
      </div>
    </section>
  );
}

function usePreferenceThemeController() {
  const initialTheme = normalizeTheme(defaultPreferenceCustomization());
  const resource = useRemoteResource<Theme>(loadPreferenceTheme, {
    identity: "preference-center-theme",
  });
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const baselineRef = useRef<Theme>(initialTheme);
  const [baseline, setBaseline] = useState<Theme>(initialTheme);
  const [operationKind, setOperationKind] = useState<"load" | "save" | null>(
    null,
  );
  const activeRef = useRef(true);
  const appliedVerifiedAtRef = useRef<number | null>(null);
  const operation = useSingleFlightOperation({
    ownerId: "preference-center-theme",
    label: "Preference-center theme request",
  });
  const loaded = hasVerifiedRemoteData(resource);
  const dirty = loaded && !sameTheme(theme, baseline);
  const validation = validateTheme(theme);
  const operationActive = operation.active || operationKind !== null;

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (
      !resource.data ||
      resource.lastVerifiedAt === null ||
      appliedVerifiedAtRef.current === resource.lastVerifiedAt
    ) {
      return;
    }
    const acknowledged = normalizeTheme(resource.data);
    appliedVerifiedAtRef.current = resource.lastVerifiedAt;
    baselineRef.current = acknowledged;
    setBaseline(acknowledged);
    setTheme(acknowledged);
  }, [resource.data, resource.lastVerifiedAt]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!loaded) return false;
    const currentValidation = validateTheme(theme);
    if (!currentValidation.valid) {
      toast.error({
        message: "Review the theme before saving.",
        detail:
          currentValidation.logoError ??
          currentValidation.colorError ??
          currentValidation.contrastError ??
          "A theme field is invalid.",
      });
      return false;
    }
    if (!dirty) return true;
    const pending = operation.promiseRef.current;
    if (pending) return (await pending) === true;

    setOperationKind("save");
    const request = operation.run(async (): Promise<boolean> => {
      try {
        const result =
          await api.privacyPortal.savePreferenceCustomization(theme);
        if (!activeRef.current) return false;
        if (result.error) {
          reportThemeSaveFailure(result.error);
          return false;
        }
        const acknowledged = normalizeTheme(result.data ?? theme);
        baselineRef.current = acknowledged;
        setBaseline(acknowledged);
        setTheme(acknowledged);
        toast.success({
          message: "Saved preference-center theme.",
          detail:
            "The hosted preference center will use this acknowledged theme.",
        });
        return true;
      } catch (error) {
        if (activeRef.current) reportThemeSaveFailure(error);
        return false;
      } finally {
        if (activeRef.current) setOperationKind(null);
      }
    });
    return request ? await request : false;
  }, [dirty, loaded, operation, theme]);

  const reset = useCallback((): void => {
    setTheme(normalizeTheme(defaultPreferenceCustomization()));
  }, []);

  const discard = useCallback((): void => {
    setTheme(baselineRef.current);
  }, []);

  const retryLoad = useCallback(async (): Promise<void> => {
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    setOperationKind("load");
    const request = operation.run(async (): Promise<void> => {
      try {
        await resource.reload();
      } finally {
        if (activeRef.current) setOperationKind(null);
      }
    });
    if (request) await request;
  }, [operation, resource]);

  useExistingSettingLifecycle({
    ownerId: "preference-center-theme",
    label: "Preference-center theme",
    dirty,
    operationRef: operation.promiseRef,
    save,
    discard,
    detail: "Preference-center theme changes have not been saved.",
  });

  return {
    resource,
    theme,
    setTheme,
    loaded,
    dirty,
    validation,
    operationKind,
    operationActive,
    save,
    reset,
    discard,
    retryLoad,
  };
}

function ThemeEditorForm({
  theme,
  validation,
  disabled,
  onChange,
}: {
  theme: Theme;
  validation: ThemeValidation;
  disabled: boolean;
  onChange: (next: Theme | ((current: Theme) => Theme)) => void;
}): ReactElement {
  const logoId = useId();
  const logoHelpId = useId();
  const logoErrorId = useId();
  const colorTextId = useId();
  const colorHelpId = useId();
  const colorErrorId = useId();
  const footerId = useId();
  const footerCountId = useId();
  const validPickerColor = validHexColor(theme.primary_color)
    ? theme.primary_color
    : defaultPreferenceCustomization().primary_color;

  return (
    <form
      className="preference-theme-form"
      onSubmit={(event) => event.preventDefault()}
    >
      <label className="preference-theme-field" htmlFor={logoId}>
        <span>Logo URL</span>
        <input
          id={logoId}
          className="input"
          type="url"
          placeholder="https://yourdomain.com/logo.png"
          value={theme.logo_url ?? ""}
          onChange={(event) =>
            onChange((current) => ({
              ...current,
              logo_url: event.target.value,
            }))
          }
          disabled={disabled}
          autoComplete="url"
          spellCheck={false}
          aria-invalid={validation.logoError ? "true" : undefined}
          aria-describedby={`${logoHelpId}${validation.logoError ? ` ${logoErrorId}` : ""}`}
        />
        <small id={logoHelpId} className="field-hint">
          Use a public HTTPS image URL without embedded credentials. Preview
          requests omit the Moosewave referrer and obvious local/private hosts
          are rejected.
        </small>
        {validation.logoError ? (
          <small id={logoErrorId} className="field-error" role="alert">
            {validation.logoError}
          </small>
        ) : null}
      </label>

      <fieldset className="preference-theme-color-field">
        <legend>Primary color</legend>
        <div className="preference-theme-color-inputs">
          <input
            type="color"
            value={validPickerColor}
            onChange={(event) =>
              onChange((current) => ({
                ...current,
                primary_color: event.target.value,
              }))
            }
            disabled={disabled}
            aria-label="Choose primary color"
            aria-describedby={colorHelpId}
          />
          <label htmlFor={colorTextId}>
            <span className="sr-only">Primary color hex value</span>
            <input
              id={colorTextId}
              className="input"
              type="text"
              value={theme.primary_color ?? ""}
              maxLength={7}
              onChange={(event) =>
                onChange((current) => ({
                  ...current,
                  primary_color: event.target.value,
                }))
              }
              disabled={disabled}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={
                validation.colorError || validation.contrastError
                  ? "true"
                  : undefined
              }
              aria-describedby={`${colorHelpId}${validation.colorError || validation.contrastError ? ` ${colorErrorId}` : ""}`}
            />
          </label>
        </div>
        <small id={colorHelpId} className="field-hint">
          Six-digit hex color. White button text must reach a 4.5:1 contrast
          ratio; current ratio: {validation.contrastRatio?.toFixed(2) ?? "—"}:1.
        </small>
        {validation.colorError || validation.contrastError ? (
          <small id={colorErrorId} className="field-error" role="alert">
            {validation.colorError ?? validation.contrastError}
          </small>
        ) : null}
      </fieldset>

      <label className="preference-theme-field" htmlFor={footerId}>
        <span>Footer text</span>
        <textarea
          id={footerId}
          className="input"
          rows={3}
          maxLength={500}
          value={theme.footer_text ?? ""}
          onChange={(event) =>
            onChange((current) => ({
              ...current,
              footer_text: event.target.value,
            }))
          }
          disabled={disabled}
          aria-describedby={footerCountId}
        />
        <small id={footerCountId} className="field-hint">
          {(theme.footer_text ?? "").length.toLocaleString()} of 500 characters
        </small>
      </label>

      <label className="preference-theme-badge-toggle">
        <input
          type="checkbox"
          checked={theme.show_postwave_badge !== false}
          onChange={(event) =>
            onChange((current) => ({
              ...current,
              show_postwave_badge: event.target.checked,
            }))
          }
          disabled={disabled}
        />
        <span>Show “Powered by Moosewave” badge</span>
      </label>
    </form>
  );
}

function PreviewPane({
  theme,
  validation,
  verified,
}: {
  theme: Theme;
  validation: ThemeValidation;
  verified: boolean;
}): ReactElement {
  const [logoFailed, setLogoFailed] = useState(false);
  const safeLogo = safeHttpsLogoUrl(theme.logo_url);
  const primary = validHexColor(theme.primary_color)
    ? theme.primary_color
    : defaultPreferenceCustomization().primary_color;

  useEffect(() => {
    setLogoFailed(false);
  }, [safeLogo]);

  return (
    <section
      className="preference-theme-preview"
      aria-label="Hosted preference-center live preview"
    >
      <header>
        <strong>Live preview</strong>
        <span className="pw-action-status">
          {verified
            ? "Previewing the current draft."
            : "Previewing fallback defaults; the saved theme is not verified."}
        </span>
      </header>
      <div className="preference-theme-preview-canvas">
        <div className="preference-theme-preview-logo">
          {safeLogo && !logoFailed ? (
            <img
              src={safeLogo}
              alt="Organization logo preview"
              referrerPolicy="no-referrer"
              loading="lazy"
              decoding="async"
              onError={() => setLogoFailed(true)}
            />
          ) : (
            <span className="muted">
              {theme.logo_url
                ? "Logo preview unavailable until a valid image loads."
                : "No logo configured."}
            </span>
          )}
        </div>

        <div className="preference-theme-preview-body">
          <strong>Email preferences</strong>
          <p>Choose which emails you’d like to receive from us.</p>
          <span className="preference-theme-preview-choice">
            <span aria-hidden="true">☑</span> Product updates &amp; releases
          </span>
          <span className="preference-theme-preview-choice">
            <span aria-hidden="true">☑</span> Weekly digest
          </span>
          <span
            className="preference-theme-preview-button"
            style={{ backgroundColor: primary }}
          >
            Save preferences
          </span>
          {validation.contrastError ? (
            <span className="field-error" role="status">
              Button contrast does not meet the save requirement.
            </span>
          ) : null}
        </div>

        <footer>
          <span>{theme.footer_text || "Empty footer"}</span>
          {theme.show_postwave_badge !== false ? (
            <span>Powered by Moosewave</span>
          ) : null}
        </footer>
      </div>
    </section>
  );
}

function themeActionStatus(controller: {
  loaded: boolean;
  dirty: boolean;
  validation: ThemeValidation;
  operationKind: "load" | "save" | null;
}): string {
  if (controller.operationKind === "load") {
    return "Retrying the saved theme. Editing and save actions are temporarily unavailable.";
  }
  if (controller.operationKind === "save") {
    return "Saving this exact draft and waiting for the server acknowledgement.";
  }
  if (!controller.loaded) {
    return "The saved theme must be verified before defaults can be edited or saved.";
  }
  const error =
    controller.validation.logoError ??
    controller.validation.colorError ??
    controller.validation.contrastError;
  if (error) return `Save unavailable: ${error}`;
  if (!controller.dirty) return "No unsaved theme changes.";
  return "Theme changes are ready to save or discard.";
}

function sameTheme(left: Theme, right: Theme): boolean {
  return (
    (left.logo_url ?? "") === (right.logo_url ?? "") &&
    (left.primary_color ?? "") === (right.primary_color ?? "") &&
    (left.footer_text ?? "") === (right.footer_text ?? "") &&
    left.show_postwave_badge === right.show_postwave_badge
  );
}

function validHexColor(value: string | null | undefined): value is string {
  return /^#[0-9a-f]{6}$/iu.test(value?.trim() ?? "");
}

function safeHttpsLogoUrl(value: string | null | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      isObviousPrivateHost(parsed.hostname)
    ) {
      return null;
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function validateTheme(theme: Theme): ThemeValidation {
  const logo = theme.logo_url?.trim() ?? "";
  const logoError =
    logo && !safeHttpsLogoUrl(logo)
      ? "Logo URL must be a public HTTPS URL without embedded credentials."
      : null;
  const colorError = validHexColor(theme.primary_color)
    ? null
    : "Primary color must be a six-digit hex value such as #2563EB.";
  const contrastRatio = colorError
    ? null
    : contrastRatioWithWhite(theme.primary_color);
  const contrastError =
    contrastRatio !== null && contrastRatio < 4.5
      ? `White button text has ${contrastRatio.toFixed(2)}:1 contrast; choose a darker color that reaches at least 4.5:1.`
      : null;
  return {
    logoError,
    colorError,
    contrastError,
    contrastRatio,
    valid: !logoError && !colorError && !contrastError,
  };
}

function contrastRatioWithWhite(hex: string): number {
  const red = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const green = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const blue = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const linear = (channel: number): number =>
    channel <= 0.04045
      ? channel / 12.92
      : Math.pow((channel + 0.055) / 1.055, 2.4);
  const luminance =
    0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
  return 1.05 / (luminance + 0.05);
}

function isObviousPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    return true;
  }
  if (host.includes(":")) {
    return (
      host === "::" ||
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe8") ||
      host.startsWith("fe9") ||
      host.startsWith("fea") ||
      host.startsWith("feb")
    );
  }
  const octets = host.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return !host.includes(".");
  }
  const [first = -1, second = -1] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function reportThemeSaveFailure(error: unknown): void {
  const normalized =
    error && typeof error === "object"
      ? (error as Parameters<typeof remoteFailureFromError>[0])
      : { kind: "network" as const };
  const failure = remoteFailureFromError(normalized);
  const diagnostics = [failure.code, failure.requestId]
    .filter(Boolean)
    .join(" · ");
  toast.error({
    message: "The preference-center theme couldn't be saved.",
    detail: `${failure.message}${diagnostics ? ` Reference: ${diagnostics}.` : ""} The draft remains available for retry.`,
  });
}
