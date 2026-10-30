import { type ReactElement, useEffect, useId, useState } from "react";

import type { AgencyBranding } from "../../lib/api-client";
import { contrastPairFor, safePublicHttpsLogoUrl } from "./agency-maturity";

interface Props {
  branding: AgencyBranding;
}

/**
 * A static configuration projection, not a public-page claim. External logo bytes are never requested merely
 * because an operator typed or loaded a URL: each exact URL needs an explicit
 * no-referrer preview action, and consent resets on every URL change.
 */
export function BrandingPreviewCard({ branding }: Props): ReactElement {
  const titleId = useId();
  const logoStatusId = useId();
  const enabled = branding.whitelabel_enabled;
  const brand = branding.brand_name?.trim() || "Your brand";
  const requestedLogo = branding.logo_url?.trim() ?? "";
  const safeLogo = requestedLogo ? safePublicHttpsLogoUrl(requestedLogo) : null;
  const primary = contrastPairFor(branding.primary_color);
  const support = branding.support_email?.trim();
  const domain = branding.custom_domain?.trim();
  const [consentedLogo, setConsentedLogo] = useState<string | null>(null);
  const [logoFailed, setLogoFailed] = useState(false);

  useEffect(() => {
    setConsentedLogo(null);
    setLogoFailed(false);
  }, [requestedLogo]);

  const mayRenderLogo = !!safeLogo && consentedLogo === safeLogo && !logoFailed;

  return (
    <aside className="agency-brand-preview" aria-labelledby={titleId}>
      <header className="agency-brand-preview__header">
        <div>
          <h2 id={titleId}>Audit portal identity preview</h2>
          <p>
            {enabled
              ? "The saved enable preference is on. The audit-portal projection remains release-held; this preview is not publication."
              : "The saved enable preference is off. The audit-portal projection remains release-held; this preview is not publication."}
          </p>
        </div>
        <span className={enabled ? "status-pill success" : "status-pill"}>
          {enabled ? "Preference on" : "Preference off"}
        </span>
      </header>

      <div
        className="agency-brand-preview__surface"
        aria-label="Static audit portal branding preview"
      >
        <div className="agency-brand-preview__identity">
          {mayRenderLogo ? (
            <img
              src={safeLogo}
              alt={`${brand} logo preview`}
              referrerPolicy="no-referrer"
              decoding="async"
              onError={() => setLogoFailed(true)}
            />
          ) : (
            <span
              className="agency-brand-preview__logo-placeholder"
              aria-hidden
            />
          )}
          <strong>{brand}</strong>
        </div>

        <p className="agency-brand-preview__copy">Compliance evidence portal</p>
        <div className="agency-brand-preview__mock-input">
          Evidence access remains release-held
        </div>
        <div
          className="agency-brand-preview__cta"
          style={{
            backgroundColor: primary.background,
            color: primary.foreground,
          }}
        >
          Review evidence
        </div>

        {support ? (
          <footer className="agency-brand-preview__footer">
            Questions? {support}
          </footer>
        ) : null}
      </div>

      <dl className="agency-brand-preview__facts">
        <div>
          <dt>CTA contrast</dt>
          <dd>
            {primary.ratio.toFixed(2)}:1 with {primary.foregroundName} text ·
            {primary.ratio >= 4.5 ? " passes" : " fails"} WCAG AA for normal
            text
          </dd>
        </div>
        <div>
          <dt>Custom hostname</dt>
          <dd>
            {domain
              ? `${domain} · preserved legacy value, not a published route`
              : "Unavailable · no public resolver is connected"}
          </dd>
        </div>
      </dl>

      {requestedLogo ? (
        <div className="agency-brand-preview__external-logo">
          <p id={logoStatusId} role="status">
            {!safeLogo
              ? "External logo not loaded because the URL is not an eligible public HTTPS address."
              : logoFailed
                ? "The external logo could not be rendered. No referrer was sent."
                : mayRenderLogo
                  ? "External logo loaded for this exact URL without sending a referrer."
                  : "External logo not loaded. Previewing it makes a request to the logo host."}
          </p>
          {safeLogo && !mayRenderLogo ? (
            <button
              type="button"
              className="btn btn-sm"
              aria-describedby={logoStatusId}
              onClick={() => {
                setLogoFailed(false);
                setConsentedLogo(safeLogo);
              }}
            >
              {logoFailed
                ? "Retry external logo preview"
                : "Load external logo preview"}
            </button>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
