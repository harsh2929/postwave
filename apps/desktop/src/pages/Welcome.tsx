/**
 * Welcome — API-key first-run setup. Three steps: API URL → API key →
 * test connection. The escape hatch from SignIn for power users and
 * automation accounts that have a pre-minted API key and don't need
 * the full email/password / SSO flow.
 *
 * v2: shares the AuthShell with the rest of the auth surface so it
 * doesn't feel like a different app. Stepper rendered above the form;
 * Back/Continue actions sit in the form's own footer slot.
 */

import { type ReactElement, useCallback, useState } from "react";

import { AuthShell } from "../components/AuthShell";
import { FieldError, FormField, useFormErrors } from "../components/FormField";
import {
  lifecycleOperationError,
  useDiscardOnlyDraftLifecycle,
  useSingleFlightOperation,
} from "../hooks/useSettingsDraftLifecycle";
import { setApiConfig, validateApiConnection } from "../lib/api-client";
import { AUTH_ASSETS } from "../lib/authAssets";
import { DEFAULT_API_URL } from "../lib/config";

interface Props {
  onDone: () => void;
}

type Step = 0 | 1 | 2;

export function Welcome({ onDone }: Props): ReactElement {
  const [step, setStep] = useState<Step>(0);
  const [url, setUrl] = useState<string>(DEFAULT_API_URL);
  const [key, setKey] = useState<string>("");
  const [testing, setTesting] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [result, setResult] = useState<"ok" | "fail" | null>(null);
  const errors = useFormErrors();
  const dirty =
    step > 0 || url !== DEFAULT_API_URL || key !== "" || result !== null;
  const operation = useSingleFlightOperation({
    ownerId: "welcome-api-credential",
    label: "API connection operation",
    detail: "Wait for the API connection or keychain request to finish.",
  });
  const discardDraft = useCallback((): void => {
    setStep(0);
    setUrl(DEFAULT_API_URL);
    setKey("");
    setResult(null);
    errors.clear();
  }, [errors]);
  useDiscardOnlyDraftLifecycle({
    ownerId: "welcome-api-credential",
    label: "API connection draft",
    dirty,
    operationRef: operation.promiseRef,
    discard: discardDraft,
    detail:
      "The API connection setup is not saved. Return to setup or explicitly discard the credential draft.",
    blocking: true,
  });

  function next(): void {
    if (step < 2) setStep((step + 1) as Step);
  }
  function back(): void {
    if (step > 0) setStep((step - 1) as Step);
  }

  const onTest = async (): Promise<void> => {
    const testedUrl = url;
    const testedKey = key;
    const request = operation.run(() =>
      validateApiConnection(testedUrl, testedKey),
    );
    if (!request) return;
    setTesting(true);
    setResult(null);
    errors.clear();
    try {
      const res = await request;
      if (res.data) {
        setResult("ok");
        return;
      }
      setResult("fail");
      errors.set("_form", res.error.message);
    } catch (error) {
      setResult("fail");
      errors.set(
        "_form",
        lifecycleOperationError(
          error,
          "Moosewave could not complete the connection test. Check the URL and try again.",
        ),
      );
    } finally {
      setTesting(false);
    }
  };

  const onFinish = async (): Promise<void> => {
    if (result !== "ok") {
      errors.set(
        "_form",
        "Test the connection successfully before opening Moosewave.",
      );
      return;
    }
    const request = operation.run(() =>
      setApiConfig(url.trim() || null, key.trim() || null),
    );
    if (!request) return;
    setSaving(true);
    try {
      await request;
      setKey("");
      onDone();
    } catch (error) {
      errors.set(
        "_form",
        lifecycleOperationError(
          error,
          "Could not save the API credential securely.",
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  const stepLabel = ["API URL", "API key", "Test connection"][step];

  return (
    <AuthShell
      tone="sand"
      illustration={AUTH_ASSETS.signin}
      asideEyebrow="Power user setup"
      asideHeadline="Bring your own API key."
      asideSub="Skip the email/password flow if you already have a Moosewave API key — paste it here and the desktop will read your workspace directly."
      heading="Connect to your Moosewave API"
      headingSub={`Step ${step + 1} of 3 · ${stepLabel}`}
    >
      {/* Step dots */}
      <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: 3,
              borderRadius: 2,
              background:
                i <= step ? "var(--pw-accent)" : "var(--pw-bg-elev-2)",
              transition: "background 200ms ease",
            }}
          />
        ))}
      </div>

      {step === 0 ? (
        <>
          <p className="auth-heading-sub">
            Enter the URL of your Moosewave gateway. Packaged builds should use
            HTTPS; local development can use{" "}
            <span className="mono">http://localhost:8080</span>.
          </p>
          <FormField label="API URL" htmlFor="pw-api-url" required>
            <input
              id="pw-api-url"
              className="input mono"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                // [D02-http-auth#12] A prior "Connection OK" belongs to the
                // URL/key pair that was tested — editing either invalidates
                // it so "Open Moosewave" can't persist an untested config.
                setResult(null);
              }}
              placeholder={DEFAULT_API_URL}
              disabled={operation.active}
            />
          </FormField>
          <button
            type="button"
            className="btn btn-primary auth-submit-v2"
            onClick={next}
            disabled={operation.active}
            style={{ marginTop: 12 }}
          >
            Continue
          </button>
        </>
      ) : null}

      {step === 1 ? (
        <>
          <p className="auth-heading-sub">
            Paste a Moosewave API key. You can skip and add it later from
            Settings — read-only views still work without one.
          </p>
          <FormField
            label="API key"
            htmlFor="pw-api-key"
            help="Stored in the device keychain. The native broker injects it only for the configured API origin."
          >
            <input
              id="pw-api-key"
              className="input mono"
              type="password"
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                // [D02-http-auth#12] Editing the key invalidates a prior
                // pass so the finish button re-requires a fresh test.
                setResult(null);
              }}
              placeholder="pw_…"
              disabled={operation.active}
            />
          </FormField>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              type="button"
              className="btn"
              style={{ flex: 1 }}
              onClick={back}
              disabled={saving || operation.active}
            >
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary"
              style={{ flex: 1 }}
              onClick={next}
              disabled={operation.active}
            >
              Continue
            </button>
          </div>
        </>
      ) : null}

      {step === 2 ? (
        <>
          <p className="auth-heading-sub">
            We&apos;ll call <span className="mono">/api/health</span> and
            validate the API key if you provided one.
          </p>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 12px",
              border: "1px solid var(--pw-border)",
              borderRadius: "var(--pw-radius-md)",
              background: "var(--pw-bg-elev)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                aria-hidden="true"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background:
                    result === "ok"
                      ? "var(--pw-success)"
                      : result === "fail"
                        ? "var(--pw-danger)"
                        : "var(--pw-fg-subtle)",
                }}
              />
              <span className="muted" style={{ fontSize: 13 }}>
                {testing
                  ? "Testing…"
                  : result === "ok"
                    ? "Connection OK"
                    : result === "fail"
                      ? "Connection failed"
                      : "Not tested yet"}
              </span>
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => void onTest()}
              disabled={testing || saving || operation.active}
            >
              {testing ? "Testing…" : "Test"}
            </button>
          </div>

          {errors.get("_form") ? (
            <FieldError>{errors.get("_form")}</FieldError>
          ) : null}

          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              type="button"
              className="btn"
              style={{ flex: 1 }}
              onClick={back}
              disabled={testing || saving || operation.active}
            >
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary"
              style={{ flex: 1 }}
              onClick={() => void onFinish()}
              disabled={
                result !== "ok" || testing || saving || operation.active
              }
            >
              {saving ? "Saving securely…" : "Open Moosewave"}
            </button>
          </div>
        </>
      ) : null}
    </AuthShell>
  );
}
