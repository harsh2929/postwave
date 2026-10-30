/**
 * FormSpamSettings — editor for the per-form anti-spam knobs.
 *
 * ENFORCEMENT REALITY (D08-forms-assets-archive#6): of the controls
 * below, only the honeypot actually runs on the public submit path,
 * and it runs UNCONDITIONALLY server-side — the endpoint drops any
 * submission that fills the hidden `website` field regardless of the
 * stored `honeypotEnabled` flag (forms/handlers.go PublicSubmit). The
 * `captchaProvider` / `captchaSiteKey` / `rateLimitPerMin` keys are
 * persisted but NO server or renderer reads them: hCaptcha / Turnstile
 * tokens are never verified, captcha only runs when a deployment-wide
 * reCAPTCHA secret is set (always against Google, ignoring this
 * setting), and no per-form rate limit exists (only a global per-IP
 * limiter). The copy below is deliberately explicit so operators don't
 * rely on layered protection that isn't wired. Until per-form
 * enforcement lands these are planning inputs, not active defences.
 *
 * This component is dumb — it bubbles a draft `settings` patch up to
 * the slideover's settings save handler.
 */

import { type ReactElement } from "react";

export interface SpamSettings {
  honeypotEnabled: boolean;
  captchaProvider: "" | "recaptcha" | "hcaptcha" | "turnstile";
  captchaSiteKey: string;
  rateLimitPerMin: number | "";
}

interface Props {
  value: SpamSettings;
  onChange: (next: SpamSettings) => void;
  disabled?: boolean;
}

export function FormSpamSettings({
  value,
  onChange,
  disabled,
}: Props): ReactElement {
  const set = (patch: Partial<SpamSettings>): void => {
    onChange({ ...value, ...patch });
  };
  return (
    <div>
      <div className="label">Spam protection</div>
      {/* D08-forms-assets-archive#6: don't imply layered defences that
          aren't wired. Only the honeypot runs at submit today. */}
      <div
        className="notice"
        style={{ fontSize: 11, marginBottom: 8, lineHeight: 1.5 }}
      >
        <strong>Only the honeypot runs on every submission today.</strong>{" "}
        The captcha and rate-limit options below are saved with the form
        but <strong>not yet enforced</strong> at submit — hCaptcha /
        Turnstile tokens aren&apos;t verified and per-form rate limits
        aren&apos;t applied. Don&apos;t rely on them for bot protection
        yet.
      </div>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 0",
        }}
      >
        <input
          type="checkbox"
          checked={value.honeypotEnabled}
          onChange={(e) => set({ honeypotEnabled: e.target.checked })}
          disabled={disabled}
        />
        <span style={{ fontSize: 12 }}>
          Honeypot field{" "}
          <span className="muted" style={{ fontSize: 11 }}>
            (hidden &ldquo;website&rdquo; input — bots fill it, real users
            don&apos;t)
          </span>
        </span>
      </label>
      {/* D08-forms-assets-archive#6: the honeypot check is unconditional
          server-side, so unchecking this does NOT disable it. */}
      <div className="field-help" style={{ marginTop: 0 }}>
        Always active on the public form — the server drops honeypot hits
        regardless of this toggle.
      </div>

      <div className="field" style={{ marginTop: 8 }}>
        <label className="field-label" htmlFor="form-captcha-provider">
          Captcha
        </label>
        <select
          id="form-captcha-provider"
          className="input"
          value={value.captchaProvider}
          onChange={(e) =>
            set({
              captchaProvider: e.target.value as SpamSettings["captchaProvider"],
            })
          }
          disabled={disabled}
        >
          <option value="">None</option>
          <option value="recaptcha">reCAPTCHA v2</option>
          <option value="hcaptcha">hCaptcha</option>
          <option value="turnstile">Cloudflare Turnstile</option>
        </select>
      </div>

      {value.captchaProvider ? (
        <div className="field">
          <label className="field-label" htmlFor="form-captcha-key">
            {value.captchaProvider === "recaptcha"
              ? "reCAPTCHA site key"
              : value.captchaProvider === "hcaptcha"
                ? "hCaptcha site key"
                : "Turnstile site key"}
          </label>
          <input
            id="form-captcha-key"
            type="text"
            className="input mono"
            style={{ fontSize: 12 }}
            placeholder="6Lc..."
            value={value.captchaSiteKey}
            onChange={(e) => set({ captchaSiteKey: e.target.value })}
            disabled={disabled}
          />
          <div className="field-help">
            {/* D08-forms-assets-archive#6: hCaptcha / Turnstile tokens
                are never verified; only a deployment-wide reCAPTCHA runs. */}
            Not enforced yet — hCaptcha and Turnstile tokens aren&apos;t
            verified at submit. Only a deployment-wide reCAPTCHA (when the
            server has a secret configured) currently runs.
          </div>
        </div>
      ) : null}

      <div className="field">
        <label className="field-label" htmlFor="form-rate-limit">
          Rate limit (submissions / minute / IP)
        </label>
        <input
          id="form-rate-limit"
          type="number"
          min={0}
          max={1000}
          className="input tabular"
          style={{ width: 120 }}
          placeholder="0 = off"
          value={value.rateLimitPerMin === "" ? "" : String(value.rateLimitPerMin)}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") {
              set({ rateLimitPerMin: "" });
              return;
            }
            const n = Number.parseInt(raw, 10);
            if (Number.isFinite(n) && n >= 0) {
              set({ rateLimitPerMin: n });
            }
          }}
          disabled={disabled}
        />
        <div className="field-help">
          {/* D08-forms-assets-archive#6: no per-form rate limit exists on
              the public endpoint — only a global per-IP limiter. */}
          Not enforced per-form yet — the public endpoint applies only a
          global per-IP limit. This value is saved for when per-form
          limits ship.
        </div>
      </div>
    </div>
  );
}

/**
 * Read SpamSettings out of an arbitrary `settings` jsonb map. Tolerant
 * of missing / mis-typed values — every field falls back to a safe
 * default.
 */
export function parseSpamSettings(
  settings: Record<string, unknown> | undefined,
): SpamSettings {
  const s = settings ?? {};
  const provider = String(s["captchaProvider"] ?? "").toLowerCase();
  const allowed = ["recaptcha", "hcaptcha", "turnstile"];
  const rate = s["rateLimitPerMin"];
  return {
    honeypotEnabled:
      s["honeypotEnabled"] === undefined
        ? true // ← server-side default is on, so reflect that
        : !!s["honeypotEnabled"],
    captchaProvider: (allowed.includes(provider)
      ? provider
      : "") as SpamSettings["captchaProvider"],
    captchaSiteKey: String(s["captchaSiteKey"] ?? ""),
    rateLimitPerMin:
      typeof rate === "number" && Number.isFinite(rate) && rate >= 0
        ? rate
        : "",
  };
}

/**
 * Fold SpamSettings back into an existing settings map. Strips empty /
 * default values so we don't bloat the persisted jsonb.
 */
export function applySpamSettings(
  base: Record<string, unknown>,
  spam: SpamSettings,
): Record<string, unknown> {
  const next = { ...base };
  next["honeypotEnabled"] = spam.honeypotEnabled;
  if (spam.captchaProvider) {
    next["captchaProvider"] = spam.captchaProvider;
    if (spam.captchaSiteKey) {
      next["captchaSiteKey"] = spam.captchaSiteKey;
    } else {
      delete next["captchaSiteKey"];
    }
  } else {
    delete next["captchaProvider"];
    delete next["captchaSiteKey"];
  }
  if (typeof spam.rateLimitPerMin === "number" && spam.rateLimitPerMin > 0) {
    next["rateLimitPerMin"] = spam.rateLimitPerMin;
  } else {
    delete next["rateLimitPerMin"];
  }
  return next;
}
